import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Address } from 'viem';
import { Client, Connection } from '@temporalio/client';
import { WorldSnapshotBuilder } from '@synq/world-model';
import {
  ChainSimulation,
  StoreIdentityDirectoryReader,
} from './brain-runtime.js';
import { brainReasonersFromEnv, channelBrain } from './channel-brain.js';
import {
  VenueMarketSource,
  productionRegistryRisk,
  TemporalWorkflowStatusSource,
  CombinedRiskSource,
  PostgresPortfolioRiskSource,
} from './world-sources.js';
import { PerplRestClient } from '@synq/plugin-perpl';
import { perplNetwork } from '@synq/chain-registry';
import { productionWorldPlugins } from './world-runtime.js';
import { z } from 'zod';
import {
  AddressSchema,
  PluginManifestSchema,
  ProfileNameSchema,
  type PluginManifest,
} from '@synq/schemas';
import { chainIdForProfile, profileConfiguration } from '@synq/chain-registry';
import {
  KERNEL_AUDIT_KEY_ENV,
  loadKernelAuditKey,
} from '@synq/execution-worker/integrity';
import {
  DynamicAdapter,
  GrantApprovalGateway,
  PostgresIdentityStore,
  StoreMembershipDirectory,
  PrivyAdapter,
} from '@synq/identity/server';
import { registerChannels } from './channel-server.js';
import {
  MandateProposalService,
  PostgresMandateProposalStore,
  kernelMandateCheck,
  safeReader,
} from './mandate-proposals.js';
import { mandateRoutes } from './mandate-routes.js';
import {
  MIN_ADMIN_TOKEN_LENGTH,
  createV1Api,
  type MandateReadPort,
} from './v1/app.js';
import type { GroupSnapshot } from '@synq/read-model';
import { readModelRuntime, type ReadModelRuntime } from './server.js';
import {
  createIntentKernel,
  identityPorts,
  kernelStateFromReadModel,
  openDurableKernel,
} from './kernel-runtime.js';
import { PostgresKernelStateStore, type SqlPool } from './kernel-store.js';
import type { FastifyInstance } from 'fastify';
import {
  PostgresFundingSessionStore,
  PostgresSendStore,
  DirectMonadAusdAdapter,
  FundingRouter,
  createFundingActivities,
  type FundingSqlPool,
  type FundingActivities,
} from '@synq/funding';
import { sendRoutes, type SendRouteDeps } from './send-routes.js';
import { fundingRoutes } from './funding-routes.js';
import { registerWorldRoute } from './world-route.js';
import { PostgresSendAccessStore } from './send-access-store.js';
import { fundingReceipt, productionSendPorts } from './send-runtime.js';
import { DurableKernel } from './kernel-runtime.js';
import { indexedContributions } from '@synq/read-model';
import { registerLithicWebhook } from './lithic-webhook.js';

export async function registerProductionSend(input: {
  app: FastifyInstance;
  pool: FundingSqlPool;
  ports: (stores: {
    sends: PostgresSendStore;
    funding: PostgresFundingSessionStore;
  }) => Promise<Omit<SendRouteDeps, 'store'>> | Omit<SendRouteDeps, 'store'>;
}) {
  const sends = new PostgresSendStore(input.pool);
  const funding = new PostgresFundingSessionStore(input.pool);
  await sends.migrate();
  await new PostgresSendAccessStore(input.pool).migrate();
  await funding.migrate();
  const ports = await input.ports({ sends, funding });
  await input.app.register(sendRoutes, { ...ports, store: sends });
  return { sends, funding, ports };
}

async function registerFundingApi(
  app: FastifyInstance,
  input: {
    activities: FundingActivities;
    store: PostgresFundingSessionStore;
    ports: Omit<SendRouteDeps, 'store'>;
    readModel: ReadModelRuntime;
  },
) {
  await app.register(fundingRoutes, {
    activities: input.activities,
    sessions: input.store,
    context: input.ports.groups.context,
    now: input.ports.now,
    adminToken: input.ports.adminToken,
    ...(input.ports.memberAccess
      ? { memberAccess: input.ports.memberAccess }
      : {}),
    receipt: (s, hash) => fundingReceipt(input.readModel.client, s, hash),
  });
}

const LOCAL_PROFILE = 'local/anvil';
const KERNEL_ENV = [
  'SYNQ_RM_DATABASE_URL',
  'SYNQ_RM_REDIS_URL',
  KERNEL_AUDIT_KEY_ENV,
  'SYNQ_KERNEL_PLUGINS_FILE',
] as const;

const EnvSchema = z
  .object({
    SYNQ_DATABASE_URL: z.string().min(1),
    SYNQ_PROFILE: ProfileNameSchema.default('sandbox/monad-testnet'),
    SYNQ_RP_ID: z.string().min(1),
    SYNQ_ORIGIN: z.string().min(1),
    SYNQ_API_ADMIN_TOKEN: z.string().min(MIN_ADMIN_TOKEN_LENGTH),
    SYNQ_DEPLOYMENTS_DIR: z.string().default('contracts/deployments'),
    SYNQ_EXECUTION_MODULE: AddressSchema.optional(),
    SYNQ_SEND_MANDATE_ID: z.string().min(1).max(128).default('synq_send'),
    SYNQ_RATE_LIMIT_CAPACITY: z.coerce.number().int().min(1).default(30),
    SYNQ_RATE_LIMIT_REFILL_PER_SECOND: z.coerce.number().positive().default(1),
    SYNQ_TRUST_PROXY: z.string().optional(),
    SYNQ_API_PORT: z.coerce.number().int().min(1).max(65535).default(3200),
    /** Loopback by default; containers set 0.0.0.0 behind their published port. */
    SYNQ_API_HOST: z
      .string()
      .regex(/^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}|::|::1|localhost)$/)
      .default('127.0.0.1'),
    SYNQ_RM_DATABASE_URL: z.string().min(1).optional(),
    SYNQ_RM_REDIS_URL: z.string().min(1).optional(),
    [KERNEL_AUDIT_KEY_ENV]: z.string().min(1).optional(),
    SYNQ_KERNEL_PLUGINS_FILE: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.SYNQ_PROFILE === LOCAL_PROFILE) return;
    for (const key of KERNEL_ENV)
      if (!env[key])
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `required for ${env.SYNQ_PROFILE}`,
        });
  });
type V1Env = z.output<typeof EnvSchema>;

export function parseV1Environment(env: NodeJS.ProcessEnv): V1Env {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid API configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  return parsed.data;
}

export function pluginManifests(path: string): PluginManifest[] {
  return z
    .array(PluginManifestSchema)
    .min(1)
    .parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
}

export async function intentKernelFromEnvironment(input: {
  config: V1Env;
  env: NodeJS.ProcessEnv;
  identity: PostgresIdentityStore;
  readModel: ReadModelRuntime;
  executionModule: `0x${string}`;
  kernelStore: SqlPool;
}) {
  const { config, env } = input;
  if (!config.SYNQ_KERNEL_PLUGINS_FILE) return null;
  if (config.SYNQ_PROFILE !== LOCAL_PROFILE && !config[KERNEL_AUDIT_KEY_ENV])
    throw new Error(`Invalid API configuration: ${KERNEL_AUDIT_KEY_ENV}`);
  const auditKey = config[KERNEL_AUDIT_KEY_ENV]
    ? loadKernelAuditKey([config.SYNQ_DEPLOYMENTS_DIR], {
        ...env,
        SYNQ_NETWORK: config.SYNQ_PROFILE,
      }).bytes
    : undefined;
  const kernelConfig = {
    network: profileConfiguration(config.SYNQ_PROFILE).network,
    executionModule: input.executionModule,
    identity: identityPorts(input.identity),
    client: input.readModel.client,
    projection: input.readModel.projection,
    snapshots: async () => input.readModel.snapshots,
    head: input.readModel.head,
    maxLagBlocks: input.readModel.maxLagBlocks,
    ...(auditKey ? { auditKey } : {}),
    plugins: pluginManifests(config.SYNQ_KERNEL_PLUGINS_FILE),
    state: await kernelStateFromReadModel(input.readModel.reader),
  };
  if (!auditKey) return createIntentKernel(kernelConfig);
  const store = new PostgresKernelStateStore(
    input.kernelStore,
    `${config.SYNQ_PROFILE}:${input.executionModule.toLowerCase()}`,
  );
  await store.migrate();
  return openDurableKernel({ ...kernelConfig, auditKey }, store);
}

export function mandateReader(snapshots: {
  groupSnapshot(groupId: `0x${string}`): Promise<GroupSnapshot | null>;
}): MandateReadPort {
  return {
    async read(groupId, mandateId) {
      const snapshot = await snapshots.groupSnapshot(
        groupId.toLowerCase() as `0x${string}`,
      );
      const mandate = snapshot?.group.mandates.find(
        (m) => m.mandateId === mandateId.toLowerCase(),
      );
      return snapshot && mandate
        ? {
            groupId,
            mandateId,
            version: mandate.currentVersion,
            active: mandate.status === 'ACTIVE',
            terms: {
              status: mandate.status,
              minValidVersion: mandate.minValidVersion,
              spentToken: mandate.spentToken,
              spentNative: mandate.spentNative,
              indexedThroughBlock: String(snapshot.indexedThroughBlock),
            },
            source: 'indexed-read-model',
            currentHeadVerified: false,
          }
        : null;
    },
  };
}

export function registryFor(chainId: number, deploymentsDir: string): Address {
  return z
    .object({ chainId: z.literal(chainId), MandateRegistry: AddressSchema })
    .parse(
      JSON.parse(
        readFileSync(resolve(deploymentsDir, `${chainId}.json`), 'utf8'),
      ),
    ).MandateRegistry as Address;
}

export function executionModuleFor(
  chainId: number,
  deploymentsDir: string,
  override?: string,
): Record<number, string> {
  if (override) return { [chainId]: override };
  const manifest = z
    .object({ chainId: z.literal(chainId), ExecutionModule: AddressSchema })
    .parse(
      JSON.parse(
        readFileSync(resolve(deploymentsDir, `${chainId}.json`), 'utf8'),
      ),
    );
  return { [chainId]: manifest.ExecutionModule };
}

export async function startV1Server(env: NodeJS.ProcessEnv = process.env) {
  const config = parseV1Environment(env);
  const chainId = chainIdForProfile(config.SYNQ_PROFILE);
  const executionModules = executionModuleFor(
    chainId,
    config.SYNQ_DEPLOYMENTS_DIR,
    config.SYNQ_EXECUTION_MODULE,
  );
  const pool = new pg.Pool({
    connectionString: config.SYNQ_DATABASE_URL,
    max: 10,
  });
  const store = new PostgresIdentityStore(pool);
  await store.migrate();
  const readModel = config.SYNQ_RM_DATABASE_URL
    ? await readModelRuntime(env, config.SYNQ_PROFILE)
    : null;
  const intents = readModel
    ? await intentKernelFromEnvironment({
        config,
        env,
        identity: store,
        readModel,
        executionModule: AddressSchema.parse(executionModules[chainId]),
        kernelStore: pool,
      })
    : null;
  let temporalConnection: Connection | undefined;
  let channels: Awaited<ReturnType<typeof registerChannels>> = null;
  const app = createV1Api({
    store,
    config: {
      profile: config.SYNQ_PROFILE,
      rpId: config.SYNQ_RP_ID,
      origin: config.SYNQ_ORIGIN,
    },
    adminToken: config.SYNQ_API_ADMIN_TOKEN,
    executionModules,
    ...(intents ? { intents } : {}),
    ...(config.SYNQ_TRUST_PROXY ? { trustProxy: config.SYNQ_TRUST_PROXY } : {}),
    rateLimit: {
      capacity: config.SYNQ_RATE_LIMIT_CAPACITY,
      refillPerSecond: config.SYNQ_RATE_LIMIT_REFILL_PER_SECOND,
    },
    privy: new PrivyAdapter(env),
    dynamic: new DynamicAdapter(env),
    ...(readModel ? { mandates: mandateReader(readModel.snapshots) } : {}),
    logger: {
      level: 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["idempotency-key"]',
      ],
    },
  });
  // Card-program events: signature-verified, durably deduplicated inbox.
  await registerLithicWebhook({ app, pool, env });
  if (readModel && intents) {
    const kernel = intents instanceof DurableKernel ? intents.kernel : intents;
    const network = profileConfiguration(config.SYNQ_PROFILE).network;
    const now = () => Math.floor(Date.now() / 1000);
    const temporalStatus = new TemporalWorkflowStatusSource(
      {
        async *list() {
          temporalConnection ??= await Connection.connect({
            address: env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
          });
          const temporal = new Client({
            connection: temporalConnection,
            namespace: env.TEMPORAL_NAMESPACE ?? 'default',
          });
          for await (const execution of temporal.workflow.list())
            yield execution;
        },
        async nextEvent(workflowId) {
          if (!temporalConnection) throw new Error('TEMPORAL_UNAVAILABLE');
          return new Client({
            connection: temporalConnection,
            namespace: env.TEMPORAL_NAMESPACE ?? 'default',
          }).workflow
            .getHandle(workflowId)
            .query<{ at: number | null }>('nextScheduledEvent');
        },
      },
      now,
    );
    const worldPlugins = productionWorldPlugins({
      client: readModel.client,
      network,
      executionModule: AddressSchema.parse(executionModules[chainId]),
      sendEnabled: true,
      now,
    });
    const worldMarket =
      config.SYNQ_PROFILE === 'local/anvil'
        ? { quotes: async () => [] }
        : new VenueMarketSource(
            network,
            readModel.client,
            new PerplRestClient({
              transport: 'live',
              network: perplNetwork(config.SYNQ_PROFILE),
            }),
          );
    const worldRisk = new CombinedRiskSource(
      productionRegistryRisk(network, readModel.client, now),
      new PostgresPortfolioRiskSource(
        pool,
        now,
        config.SYNQ_PROFILE === 'local/anvil' ? 'SIMULATION' : 'REAL_TESTNET',
      ),
    );
    const world = new WorldSnapshotBuilder({
      network,
      now,
      readModel,
      kernel,
      identity: new StoreIdentityDirectoryReader(store, pool),
      plugins: worldPlugins.registry,
      mainnetBroadcastAllowed: false,
      market: worldMarket,
      risk: worldRisk,
      workflows: temporalStatus,
    });
    registerWorldRoute(app, {
      adminToken: config.SYNQ_API_ADMIN_TOKEN,
      memberAccess: () => registered.ports.memberAccess,
      groupExists: async (groupId) =>
        !!(await store.transaction((tx) => tx.getGroup(groupId))),
      build: async (groupId, intentScope) => {
        await worldPlugins.refresh();
        return world.build({ groupId, intentScope });
      },
    });
    const registered = await registerProductionSend({
      app,
      pool,
      ports: ({ sends, funding }) =>
        productionSendPorts({
          identity: store,
          identityConfig: {
            profile: config.SYNQ_PROFILE,
            rpId: config.SYNQ_RP_ID,
            origin: config.SYNQ_ORIGIN,
          },
          readModel,
          kernel,
          authorizer: intents,
          executionModule: AddressSchema.parse(executionModules[chainId]),
          adminToken: config.SYNQ_API_ADMIN_TOKEN,
          sendMandateId: config.SYNQ_SEND_MANDATE_ID,
          sends,
          funding,
        }),
    });
    const activities = createFundingActivities({
      router: new FundingRouter({ adapters: [new DirectMonadAusdAdapter()] }),
      store: registered.funding,
      destination: {
        find: async (s) =>
          s.sourceTransactionHash
            ? fundingReceipt(readModel.client, s, s.sourceTransactionHash)
            : null,
      },
      indexed: {
        indexed: async (r) => {
          const seen = await indexedContributions(
            readModel.projectionStore,
            readModel.projection,
            r.to,
            r.token,
          );
          return {
            indexedThroughBlock: seen.indexedThroughBlock,
            eventPresent: seen.contributions.some(
              (c) =>
                c.transactionHash === r.transactionHash &&
                c.logIndex === r.logIndex &&
                c.from === r.from &&
                c.amount === r.amount,
            ),
          };
        },
      },
    });
    await registerFundingApi(app, {
      activities,
      store: registered.funding,
      ports: registered.ports,
      readModel,
    });
    const approvalGateway = new GrantApprovalGateway(
      store,
      {
        profile: config.SYNQ_PROFILE,
        rpId: config.SYNQ_RP_ID,
        origin: config.SYNQ_ORIGIN,
      },
      { executionModules, localAssets: [] },
    );
    const directoryReader = new StoreIdentityDirectoryReader(store, pool);
    const mandateStore = new PostgresMandateProposalStore(pool);
    await mandateStore.migrate();
    const mandateProposals = new MandateProposalService({
      store: mandateStore,
      directory: new StoreMembershipDirectory(store),
      group: async (groupId) => {
        const g = await store.transaction((tx) => tx.getGroup(groupId));
        return g
          ? {
              account: g.account,
              owners: g.owners,
              threshold: g.threshold,
              chainId: g.chainId,
            }
          : null;
      },
      safe: safeReader(readModel.client),
      registry: registryFor(chainId, config.SYNQ_DEPLOYMENTS_DIR),
      chainId,
      kernelCheck: kernelMandateCheck(() => kernel.listMandates()),
      now,
    });
    await app.register(mandateRoutes, {
      service: mandateProposals,
      adminToken: config.SYNQ_API_ADMIN_TOKEN,
      ...(registered.ports.memberAccess
        ? { memberAccess: registered.ports.memberAccess }
        : {}),
    });
    const reasoners = brainReasonersFromEnv(env);
    const authorizer = intents;
    const brain = reasoners
      ? channelBrain({
          reasoners,
          world,
          kernel: {
            authorize: async (request) => authorizer.authorize(request),
            attestEvidence: (evidence) => kernel.attestEvidence(evidence),
            listMandates: () => kernel.listMandates(),
          },
          market: worldMarket,
          risk: worldRisk,
          network,
          simulations: new ChainSimulation(readModel.client, { now }, network),
          now,
          registerDraft: async (draft) => {
            await approvalGateway.registerKernelDraft(draft);
          },
          drafts: (groupId) => directoryReader.drafts(groupId),
          proposeMandate: async ({ groupId, memberId, mandate, change }) =>
            (
              await mandateProposals.propose({
                groupId,
                mandate,
                change,
                proposedBy: { memberId, source: 'BRAIN' },
              })
            ).proposalId,
        })
      : undefined;
    if (reasoners) app.log.info({ brain: reasoners.label }, 'channel brain');
    channels = await registerChannels({
      app,
      env,
      origin: config.SYNQ_ORIGIN,
      pool,
      send: registered.ports,
      sends: registered.sends,
      approvals: {
        drafts: (groupId) => directoryReader.drafts(groupId),
        quorum: (digest) => approvalGateway.quorum(digest),
      },
      executed: {
        executed: async (groupId) =>
          (
            (await readModel.reader.groupSnapshot(groupId as `0x${string}`))
              ?.group.grantsExecuted ?? []
          ).map((g) => ({
            intentHash: g.intentHash,
            transactionHash: g.transactionHash,
          })),
      },
      executionMode:
        config.SYNQ_PROFILE === LOCAL_PROFILE ? 'SIMULATION' : 'REAL_TESTNET',
      ...(brain ? { brain } : {}),
      mandateProposals,
      log: (message, fields) => app.log.info(fields ?? {}, message),
    });
  }
  app.addHook('onReady', async () => channels?.start());
  app.addHook('onClose', async () => {
    await channels?.stop();
    await temporalConnection?.close();
    await readModel?.close();
    await pool.end();
  });
  await app.listen({ port: config.SYNQ_API_PORT, host: config.SYNQ_API_HOST });
  return app;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startV1Server();
  const stop = () => void app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
