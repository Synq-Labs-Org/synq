import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { monadTestnet } from 'viem/chains';
import {
  GrantApprovalChallengeSchema,
  IdentityChallengeSchema,
  MandateSchema,
  PendingIntentViewSchema,
  VerifiedApprovalSchema,
  type Mandate,
} from '@synq/schemas';
import { artifactHash, onchainMandateId, toMandateConfig } from '@synq/kernel';
import {
  ChainHeadObserver,
  EnvioPostgresSource,
  ProjectionReader,
  Projector,
  registerMandateArtifacts,
  syncToTarget,
} from '@synq/read-model';
import { PostgresProjectionStore } from '@synq/read-model/storage';
import { loadJournalKey, loadKernelAuditKey } from '@synq/execution-worker';
import { formatDecimal } from '@synq/domain';
import { PostgresIdentityStore } from '@synq/identity';
import { grantPreview } from '@synq/identity/grant';
import { StoreMembershipDirectory } from '@synq/identity/server';
import {
  approveGrantWithMera,
  signMeraIdentityChallenge,
  signMeraSafeTransaction,
  signMeraSendAccess,
  signMeraSendConfirmation,
  SendAccessChallengeSchema,
} from '@synq/identity/mera-browser';
import { PluginRegistry } from '@synq/plugin-sdk';
import type { SendPreview, SendRecord } from '@synq/funding';
import { createV1Api } from '@synq/api/v1';
import {
  createIntentKernel,
  identityPorts,
  kernelStateFromReadModel,
} from '@synq/api/kernel-runtime';
import { readModelRoutes } from '@synq/api/read-model-routes';
import { confirmationOf } from '@synq/api/send-routes';
import { registerProductionSend } from '@synq/api/v1-server';
import { productionSendPorts } from '@synq/api/send-runtime';
import { registerChannels } from '@synq/api/channel-server';
import {
  MandateProposalService,
  PostgresMandateProposalStore,
  kernelMandateCheck,
  safeReader,
} from '@synq/api/mandate-proposals';
import { mandateRoutes } from '@synq/api/mandate-routes';
import {
  ChainSimulation,
  StoreIdentityDirectoryReader,
} from '@synq/api/brain-runtime';
import { brainReasonersFromEnv, channelBrain } from '@synq/api/channel-brain';
import {
  InMemoryWorkflowStatusReader,
  WorldSnapshotBuilder,
} from '@synq/world-model';
import { GrantApprovalGateway } from '@synq/identity/server';
import { registryDeploymentSettings } from '../../../scripts/envio-env.js';
import { EnvioProcess } from '../../../scripts/envio-process.js';
import {
  SOFTWARE_PRF_TIER,
  SoftwareAuthenticatorStore,
} from './software-authenticator.js';
import { SynqApiClient } from './testnet-api.js';
import {
  connectTestnet,
  loadTestnetSigner,
  testnetRpcUrl,
  type OwnerSigner,
} from './testnet-chain.js';
import { erc20TransferPlugin } from './transfer-plugin.js';
import { transferVertical } from './vertical.js';
import {
  CHAIN_ID,
  PLUGIN_ID,
  PROFILE,
  RP,
  WORKER_ID,
  ensureDatabase,
} from './testnet-config.js';
import { enrollPrincipals } from './testnet-enrollment.js';
import { SEND_UNITS, sendMandate } from './send.js';
import { SendExecutor } from './send-executor.js';
import { executeReadyMandates } from './governance-executor.js';

export const LOCAL_DIR = resolve('.synq-local/telegram');
export const EXPLORER = 'https://testnet.monadexplorer.com/tx/';
const DB_URL =
  process.env.SYNQ_TELEGRAM_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_telegram_e2e';
const sha = (v: string) =>
  createHash('sha256').update(v).digest('hex').slice(0, 16);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Loads ~/.synq/p11.env into process.env without printing or overriding values. */
export function loadP11Env(path = join(homedir(), '.synq/p11.env')) {
  if (!existsSync(path)) return false;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || line.startsWith('#')) continue;
    const value = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    process.env[m[1]!] ??= value;
  }
  return true;
}

function ensureKey(path: string) {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  if (existsSync(path)) return;
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, `${randomBytes(32).toString('hex')}\n`);
  } finally {
    closeSync(fd);
  }
}

type DemoState = {
  schemaVersion: 1;
  runId: string;
  chainGroupId: Hex;
  account: Address;
  groupBlock: string;
  mandate: Mandate;
  envioSchema: string;
  rmSchema: string;
};

export type TelegramDemoOptions = {
  /** Fake Bot API base URL (rehearsal); live runs use api.telegram.org. */
  telegramBaseUrl?: string;
  telegramMode: 'LIVE' | 'MOCKED';
  log?: (message: string) => void;
  console?: boolean;
};

export async function startTelegramDemo(options: TelegramDemoOptions) {
  const log =
    options.log ??
    ((m: string) => console.log(`${new Date().toISOString()} ${m}`));
  if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
    throw new Error('demo:telegram refuses SYNQ_ALLOW_MAINNET_BROADCAST=true');
  process.env.SYNQ_ALLOW_MAINNET_BROADCAST = 'false';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN_MISSING');
  process.env.SYNQ_TESTNET_KEY_FILE ??= join(homedir(), '.synq/testnet.key');
  process.env.SYNQ_NETWORK = PROFILE.network.profile;
  mkdirSync(LOCAL_DIR, { recursive: true, mode: 0o700 });
  chmodSync(LOCAL_DIR, 0o700);
  const keys = join(LOCAL_DIR, 'keys');
  const data = join(LOCAL_DIR, 'data');
  mkdirSync(data, { recursive: true, mode: 0o700 });
  process.env.SYNQ_KERNEL_AUDIT_KEY_FILE ??= join(keys, 'kernel-audit.key');
  process.env.SYNQ_JOURNAL_KEY_FILE ??= join(keys, 'journal.key');
  ensureKey(process.env.SYNQ_KERNEL_AUDIT_KEY_FILE);
  ensureKey(process.env.SYNQ_JOURNAL_KEY_FILE);
  const auditKey = loadKernelAuditKey([data]);
  const journalDirectory = join(data, 'journal');
  const journalKey = loadJournalKey(journalDirectory);

  const closers: (() => Promise<unknown>)[] = [];
  const close = async () => {
    for (const c of closers.splice(0).reverse())
      await c().catch(() => undefined);
  };
  const evidence: Record<string, unknown> & {
    telegram: { messages: unknown[] };
    transactions: unknown[];
  } = {
    schemaVersion: 1,
    kind: 'synq-telegram-slice',
    startedAt: new Date().toISOString(),
    labels: {
      chain: 'REAL_TESTNET',
      telegram: options.telegramMode,
      members: `${SOFTWARE_PRF_TIER} (software WebAuthn; NOT real passkeys)`,
    },
    chainId: CHAIN_ID,
    telegram: { messages: [] },
    transactions: [],
  };
  try {
    const chain = await connectTestnet(loadTestnetSigner());
    const { client, deployer, deployment, ausd } = chain;
    const monBefore = await client.getBalance({ address: deployer.address });
    log(`operator ${deployer.address} MON=${formatDecimal(monBefore, 18)}`);
    await ensureDatabase(DB_URL);
    const pool = new pg.Pool({ connectionString: DB_URL, max: 10 });
    closers.push(() => pool.end());
    const store = new PostgresIdentityStore(pool);
    await store.migrate();
    const adminToken = randomBytes(32).toString('hex');
    const authenticators = new SoftwareAuthenticatorStore(
      join(LOCAL_DIR, 'mera-authenticators.json'),
    );
    const webAuthn = (label: string) => ({
      webAuthnClient: authenticators.client(label),
    });
    const identityConfig = {
      profile: PROFILE.network.profile,
      rpId: RP.rpId,
      origin: RP.origin,
    };
    const late: { kernel: ReturnType<typeof createIntentKernel> | null } = {
      kernel: null,
    };
    const newApi = () =>
      createV1Api({
        intents: {
          authorize: (request) => {
            if (!late.kernel) throw new Error('KERNEL_NOT_READY');
            return late.kernel.authorize(request);
          },
        },
        store,
        config: identityConfig,
        adminToken,
        executionModules: { [CHAIN_ID]: deployment.module },
        rateLimit: { capacity: 10_000, refillPerSecond: 1_000 },
      });
    const setup = newApi();
    closers.push(() => setup.close());
    // Enrollment and group bootstrap reuse the persisted state when present.
    const statePath = join(LOCAL_DIR, 'state.json');
    let state: DemoState | null = existsSync(statePath)
      ? (JSON.parse(readFileSync(statePath, 'utf8')) as DemoState)
      : null;
    const injectApi = {
      post: async <T>(path: string, body: unknown, admin = false) => {
        const r = await setup.inject({
          method: 'POST',
          url: path,
          headers: {
            'content-type': 'application/json',
            'idempotency-key': randomBytes(8).toString('hex'),
            ...(admin ? { authorization: `Bearer ${adminToken}` } : {}),
          },
          payload: JSON.stringify(body),
        });
        if (r.statusCode >= 400)
          throw new Error(`${path} -> ${r.statusCode} ${r.body.slice(0, 200)}`);
        return r.json() as T;
      },
      get: async <T>(path: string) => {
        const r = await setup.inject({ method: 'GET', url: path });
        if (r.statusCode >= 400) {
          const { ApiCallError } = await import('./testnet-api.js');
          throw new ApiCallError(r.statusCode, r.json(), path);
        }
        return r.json() as T;
      },
    };
    const principals = await enrollPrincipals({
      api: injectApi as unknown as SynqApiClient,
      authenticators,
      webAuthn,
      log,
    });
    const memberId = (label: string) =>
      `member_${principals.findIndex((p) => p.label === label)}`;
    const byLabel = (label: string) => {
      const p = principals.find((x) => x.label === label);
      if (!p) throw new Error(`unknown member ${label}`);
      return p;
    };
    const owners: OwnerSigner[] = principals.map((p) => ({
      address: p.record.signer,
      label: p.label,
      signSafeTransaction: (tx) =>
        signMeraSafeTransaction(p.record, tx, webAuthn(p.label)),
    }));
    if (!state) {
      const runId = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
      const group = await chain.createGroup(
        owners.map((o) => o.address),
        keccak256(stringToHex(`synq.telegram.${runId}`)),
      );
      log(
        `group ${group.chainGroupId} Safe ${group.account} block ${group.blockNumber}`,
      );
      await injectApi.post(
        '/v1/groups',
        {
          groupId: group.chainGroupId,
          chainGroupId: group.chainGroupId,
          chainId: CHAIN_ID,
          account: group.account,
          owners: owners.map((o) => o.address),
          threshold: 2,
          executors: [deployer.address],
        },
        true,
      );
      for (const p of principals) {
        const challenge = IdentityChallengeSchema.parse(
          await injectApi.post(
            `/v1/groups/${group.chainGroupId}/membership-challenges`,
            { memberId: memberId(p.label), principalId: p.record.principalId },
          ),
        );
        await injectApi.post(`/v1/groups/${group.chainGroupId}/memberships`, {
          challengeId: challenge.challengeId,
          signature: await signMeraIdentityChallenge(
            p.record,
            challenge,
            webAuthn(p.label),
          ),
        });
      }
      const latest = await client.getBlock();
      const carol = byLabel('carol');
      const mandate = sendMandate({
        chainGroupId: group.chainGroupId,
        account: group.account,
        executor: deployer.address,
        recipients: [
          {
            address: carol.record.signer.toLowerCase() as Address,
            purpose: 'MEMBER_WITHDRAWAL',
          },
          { address: authenticators.recipient(), purpose: 'COUNTERPARTY' },
        ],
        asset: ausd,
        members: principals.map((p) => ({
          memberId: memberId(p.label),
          signer: p.record.signer.toLowerCase() as Address,
        })),
        now: Number(latest.timestamp),
      });
      const gov = chain.governance(group.account, owners);
      await gov.setExecutor(deployer.address, true);
      await gov.configureMandate(
        onchainMandateId(mandate),
        toMandateConfig(mandate),
      );
      await chain.fund(group.account, SEND_UNITS.contribution);
      state = {
        schemaVersion: 1,
        runId,
        chainGroupId: group.chainGroupId,
        account: group.account,
        groupBlock: String(group.blockNumber),
        mandate,
        envioSchema: `envio_tg_${runId}`,
        rmSchema: `rm_tg_${runId}`,
      };
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', {
        mode: 0o600,
      });
      log(
        'group bound, executor set, mandate configured by 2 Safe owners, treasury funded',
      );
    } else log(`reusing group ${state.chainGroupId} (run ${state.runId})`);
    evidence.transactions = chain.transactions;
    const st = state;
    const mandate = MandateSchema.parse(st.mandate);
    evidence.group = {
      chainGroupIdHash: sha(st.chainGroupId),
      safe: st.account,
      runId: st.runId,
    };

    // Indexer and read model.
    const settings = registryDeploymentSettings(PROFILE.network.profile, {
      startBlock: Number(st.groupBlock),
    });
    const url = new URL(DB_URL);
    const envio = new EnvioProcess({
      env: settings.env,
      schema: st.envioSchema,
      database: {
        host: url.hostname,
        port: Number(url.port),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        name: url.pathname.slice(1),
      },
      logFile: join(LOCAL_DIR, 'envio.log'),
    });
    await envio.start();
    closers.push(() => envio.stop());
    const projectionStore = new PostgresProjectionStore(
      { pool },
      CHAIN_ID,
      st.rmSchema,
    );
    await projectionStore.migrate();
    const projector = new Projector(projectionStore, settings.projection);
    const source = new EnvioPostgresSource({ pool }, CHAIN_ID, st.envioSchema);
    const reader = new ProjectionReader(projectionStore, settings.projection);
    let catching: Promise<void> | null = null;
    const catchUp = (block?: bigint) =>
      (catching ??= (async () => {
        try {
          const target = Number(
            block ?? (await client.getBlockNumber({ cacheTime: 0 })),
          );
          await envio.waitFor(pool, CHAIN_ID, target, 900_000);
          await syncToTarget(source, projector);
        } finally {
          catching = null;
        }
      })());
    await registerMandateArtifacts(projectionStore, [
      { mandateHash: artifactHash(mandate), artifact: mandate },
    ]);
    log('waiting for the indexer to reach head');
    await catchUp();

    const calldatas = new Map<Hex, Hex>();
    const plugin = erc20TransferPlugin({
      id: PLUGIN_ID,
      chainId: CHAIN_ID,
      environment: PROFILE.network.profile,
      client,
      calldataFor: (h) => calldatas.get(h),
    });
    const plugins = new PluginRegistry();
    plugins.register(plugin);
    const clock = { now: () => Math.floor(Date.now() / 1000) };
    const kernel = createIntentKernel({
      network: PROFILE.network,
      executionModule: deployment.module,
      clock,
      identity: identityPorts(store),
      client,
      projection: settings.projection,
      snapshots: async () => {
        await catchUp();
        return reader;
      },
      head: new ChainHeadObserver(client, CHAIN_ID, { ttlMs: 0 }),
      maxLagBlocks: settings.maxLagBlocks,
      auditKey: auditKey.bytes,
      plugins: [plugin.manifest],
      state: await kernelStateFromReadModel(reader),
    });
    late.kernel = kernel;
    await plugins.refreshHealth(PLUGIN_ID, {
      network: PROFILE.network,
      now: clock.now(),
    });
    await setup.close();
    const app = newApi();
    const readModel = {
      reader,
      snapshots: reader,
      head: new ChainHeadObserver(client, CHAIN_ID, { ttlMs: 0 }),
      maxLagBlocks: settings.maxLagBlocks,
      projection: settings.projection,
      client,
      projectionStore,
      close: async () => undefined,
    };
    await app.register(readModelRoutes, {
      snapshots: reader,
      head: readModel.head,
      maxLagBlocks: settings.maxLagBlocks,
    });
    const registered = await registerProductionSend({
      app,
      pool,
      ports: ({ sends, funding }) =>
        productionSendPorts({
          identity: store,
          identityConfig,
          executionModule: deployment.module,
          adminToken,
          sends,
          funding,
          kernel,
          authorizer: kernel,
          readModel,
        }),
    });
    const mandateStore = new PostgresMandateProposalStore(pool);
    await mandateStore.migrate();
    const directory = new StoreMembershipDirectory(store);
    const mandates = new MandateProposalService({
      store: mandateStore,
      directory,
      group: async (g) => {
        const r = await store.transaction((tx) => tx.getGroup(g));
        return r
          ? {
              account: r.account,
              owners: r.owners,
              threshold: r.threshold,
              chainId: r.chainId,
            }
          : null;
      },
      safe: safeReader(client),
      registry: deployment.registry,
      chainId: CHAIN_ID,
      kernelCheck: kernelMandateCheck(() => kernel.listMandates()),
      now: clock.now,
    });
    await app.register(mandateRoutes, { service: mandates, adminToken });
    const approvalGateway = new GrantApprovalGateway(store, identityConfig, {
      executionModules: { [CHAIN_ID]: deployment.module },
      localAssets: [],
    });
    const directoryReader = new StoreIdentityDirectoryReader(store, pool);
    const recordingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const method = String(input).split('/').at(-1);
      if (method === 'sendMessage' && init?.body) {
        const body = JSON.parse(String(init.body)) as {
          chat_id: number;
          text: string;
        };
        const copy = response.clone();
        const result = (await copy.json().catch(() => null)) as {
          result?: { message_id?: number };
        } | null;
        evidence.telegram.messages.push({
          direction: 'OUT',
          chatIdHash: sha(String(body.chat_id)),
          messageId: result?.result?.message_id ?? null,
          firstLine: body.text.split('\n')[0]!.slice(0, 120),
          at: new Date().toISOString(),
        });
      }
      return response;
    };
    const reasoners = brainReasonersFromEnv(process.env);
    const world = new WorldSnapshotBuilder({
      network: PROFILE.network,
      now: clock.now,
      readModel: {
        snapshots: reader,
        head: readModel.head,
        maxLagBlocks: settings.maxLagBlocks,
      },
      kernel,
      identity: directoryReader,
      plugins,
      mainnetBroadcastAllowed: false,
      workflows: new InMemoryWorkflowStatusReader([], clock.now()),
    });
    const brain = reasoners
      ? channelBrain({
          reasoners,
          world,
          kernel,
          market: { quotes: async () => [] },
          network: PROFILE.network,
          simulations: new ChainSimulation(client, clock, PROFILE.network),
          now: clock.now,
          registerDraft: async (draft) => {
            await approvalGateway.registerKernelDraft(draft);
          },
          drafts: (g) => directoryReader.drafts(g),
          proposeMandate: async ({ groupId, memberId, mandate, change }) =>
            (
              await mandates.propose({
                groupId,
                mandate,
                change,
                proposedBy: { memberId, source: 'BRAIN' },
              })
            ).proposalId,
        })
      : undefined;
    evidence.brain = reasoners ? reasoners.label : 'NOT_CONFIGURED';
    log(`brain: ${evidence.brain}`);
    const channels = await registerChannels({
      app,
      env: {
        TELEGRAM_BOT_TOKEN: token,
        SYNQ_TELEGRAM_MODE: 'poll',
        SYNQ_WEB_BASE_URL:
          process.env.SYNQ_WEB_BASE_URL ?? 'http://localhost:3000',
        SYNQ_CHANNEL_NOTIFY_MS: '3000',
      },
      origin: RP.origin,
      pool,
      send: registered.ports,
      sends: registered.sends,
      approvals: {
        drafts: (g) => directoryReader.drafts(g),
        quorum: (d) => approvalGateway.quorum(d),
      },
      executed: {
        executed: async (g) =>
          (
            (await reader.groupSnapshot(g as Hex))?.group.grantsExecuted ?? []
          ).map((x) => ({
            intentHash: x.intentHash,
            transactionHash: x.transactionHash,
          })),
      },
      executionMode: 'REAL_TESTNET',
      mandateProposals: mandates,
      ...(brain ? { brain } : {}),
      log: (m, f) => log(`${m} ${f ? JSON.stringify(f) : ''}`),
      fetch: recordingFetch,
      ...(options.telegramBaseUrl
        ? { telegramBaseUrl: options.telegramBaseUrl }
        : {}),
    });
    if (!channels?.telegram) throw new Error('TELEGRAM_NOT_CONFIGURED');
    evidence.bot = {
      username: channels.telegram.botUsername,
      idHash: sha(String(channels.telegram.botId)),
    };
    await app.listen({
      port: Number(process.env.SYNQ_API_PORT ?? 3200),
      host: '127.0.0.1',
    });
    closers.push(() => app.close());
    const addr = app.server.address();
    const api = new SynqApiClient(
      `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 3200}`,
      adminToken,
    );
    channels.start();
    closers.push(() => channels.stop());

    const verticalFor = (recipient: Address) =>
      transferVertical({
        client,
        network: PROFILE.network,
        kernel,
        plugins,
        pluginId: PLUGIN_ID,
        calldatas,
        mandate: () =>
          kernel
            .listMandates()
            .find((m) => m.mandateId === mandate.mandateId) ?? mandate,
        module: deployment.module,
        token: ausd.address,
        account: st.account,
        recipient,
        executor: deployer,
        workerId: WORKER_ID,
        localAssets: [],
        sync: async () => clock.now(),
        now: clock.now,
        intentPrefix: `tg_${st.runId}`,
        evidenceSource: 'monad-testnet-rpc-transfer',
        gasLimitPercent: 125n,
        approve: async () => {
          throw new Error('approvals go through the Send API');
        },
        confirmations: PROFILE.confirmationDepth,
        journalKey,
      });
    const executor = new SendExecutor({
      sends: registered.sends,
      quorumSatisfied: async (d) => (await approvalGateway.quorum(d)).satisfied,
      admin: { post: (path, body) => api.post(path, body, true) },
      execute: async ({ grant, proposal, recipient }) => {
        const before = await chain.balanceOf(recipient);
        calldatas.set(keccak256(proposal.data), proposal.data);
        const submittedAt = Date.now();
        const done = await verticalFor(recipient).execute(
          grant,
          proposal.intent as never,
          proposal.data,
          journalDirectory,
        );
        evidence.transactions.push({
          step: 'ExecutionModule.execute (Telegram-originated Send)',
          hash: done.transactionHash,
          explorer: `${EXPLORER}${done.transactionHash}`,
          executionMode: 'REAL_TESTNET',
        });
        return {
          transactionHash: done.transactionHash,
          blockNumber: done.receipt.blockNumber,
          submittedAt,
          confirmedAt: Date.now(),
          recipientBalanceBefore: before,
          recipientBalanceAfter: await chain.balanceOf(recipient),
        };
      },
      catchUp,
      explorer: (h) => `${EXPLORER}${h}`,
      log,
    });
    const wallet = createWalletClient({
      account: deployer,
      chain: monadTestnet,
      transport: http(testnetRpcUrl()),
    });
    const loops = new AbortController();
    const loop = (async () => {
      while (!loops.signal.aborted) {
        await executor
          .tick()
          .catch((e) => log(`send executor: ${String(e).slice(0, 200)}`));
        await executeReadyMandates({
          service: mandates,
          client,
          wallet,
          operator: deployer.address,
          confirmations: PROFILE.confirmationDepth,
          onExecuted: async (p, hash) => {
            evidence.transactions.push({
              step: 'Safe.execTransaction (owner-approved mandate)',
              hash,
              explorer: `${EXPLORER}${hash}`,
              executionMode: 'REAL_TESTNET',
            });
            await registerMandateArtifacts(projectionStore, [
              { mandateHash: p.mandateHash as Hex, artifact: p.mandate },
            ]);
            if (p.change === 'NEW') kernel.configureMandate(p.mandate);
            else
              kernel.supersedeMandate(p.mandate, {
                securitySensitive: p.securitySensitive,
              });
          },
        }).catch((e) => log(`mandate relayer: ${String(e).slice(0, 200)}`));
        await sleep(4000);
      }
    })();
    closers.push(async () => {
      loops.abort();
      await loop;
    });

    // Operator console for software members (not real passkeys).
    const memberSession = async (label: string) => {
      const p = byLabel(label);
      const challenge = SendAccessChallengeSchema.parse(
        await api.post('/v1/send/access/challenges', {
          groupId: st.chainGroupId,
          principalId: p.record.principalId,
        }),
      );
      const s = await api.post<{ token: string }>('/v1/send/access', {
        challengeId: challenge.challengeId,
        signature: await signMeraSendAccess(
          p.record,
          challenge,
          webAuthn(label),
        ),
      });
      return { bearer: s.token };
    };
    const lastPart = (v: string, key: string) => {
      try {
        return new URL(v).searchParams.get(key) ?? v;
      } catch {
        return v.split('/').at(-1) ?? v;
      }
    };
    const commands = {
      async link(label: string, codeOrUrl: string) {
        const code = lastPart(codeOrUrl, 'code');
        return api.post(
          '/v1/channels/links/redeem',
          { code, groupId: st.chainGroupId },
          await memberSession(label),
        );
      },
      async confirm(label: string, sendUrl: string) {
        const q = new URL(sendUrl).searchParams;
        const session = await memberSession(label);
        const preview = await api.post<SendPreview>(
          '/v1/send/previews',
          {
            groupId: q.get('groupId'),
            recipientId: q.get('recipientId'),
            amount: q.get('amount'),
          },
          session,
        );
        const signature = await signMeraSendConfirmation(
          byLabel(label).record,
          confirmationOf({ preview }, memberId(label)),
          webAuthn(label),
        );
        return api.post<SendRecord>('/v1/send', {
          previewId: preview.previewId,
          digest: preview.digest,
          recipientAddress: preview.recipient.address,
          amount: preview.amount,
          chainId: preview.chainId,
          sender: { memberId: memberId(label), signature },
        });
      },
      async approve(label: string, intent: string) {
        const intentHash = intent.split('/').at(-1)!;
        const p = byLabel(label);
        const view = PendingIntentViewSchema.parse(
          await api.get(`/v1/intents/${intentHash}`),
        );
        const signed = await approveGrantWithMera(
          {
            record: p.record,
            memberId: memberId(label),
            draft: view.draft,
            asset: view.asset,
            confirmedPreview: grantPreview(view.draft, view.asset),
            requestChallenge: async (request) =>
              GrantApprovalChallengeSchema.parse(
                await api.post('/v1/approvals/challenges', request),
              ),
          },
          webAuthn(label),
        );
        return VerifiedApprovalSchema.parse(
          await api.post('/v1/approvals', {
            challengeId: signed.challenge.challengeId,
            grantSignature: signed.grantSignature,
            attestationSignature: signed.attestationSignature,
          }),
        );
      },
      async proposeMandate(perActionCapAusd: string) {
        const current =
          kernel
            .listMandates()
            .find((m) => m.mandateId === mandate.mandateId) ?? mandate;
        const cap = BigInt(
          Math.round(Number(perActionCapAusd) * 10 ** ausd.decimals),
        );
        const next = MandateSchema.parse({
          ...current,
          version: current.version + 1,
          perActionCap: String(cap),
        });
        return api.post<{ proposalId: string }>(
          '/v1/mandate-proposals',
          { groupId: st.chainGroupId, mandate: next, change: 'SUPERSEDE' },
          true,
        );
      },
      async approveMandate(label: string, proposal: string) {
        const id = proposal.split('/').at(-1)!;
        const view = await api.get<{
          safeTx: {
            safe: Address;
            chainId: number;
            to: Address;
            data: Hex;
            nonce: string;
          };
        }>(`/v1/mandate-proposals/${id}`);
        const signature = await signMeraSafeTransaction(
          byLabel(label).record,
          { ...view.safeTx, nonce: BigInt(view.safeTx.nonce) },
          webAuthn(label),
        );
        return api.post(`/v1/mandate-proposals/${id}/approvals`, {
          memberId: memberId(label),
          signature,
        });
      },
    };
    const writeEvidence = (result: string) => {
      const dir = resolve('bounty-evidence/telegram');
      mkdirSync(dir, { recursive: true });
      const file = join(
        dir,
        `${options.telegramMode === 'LIVE' ? 'live' : 'rehearsal'}-${st.runId}-${Date.now()}.json`,
      );
      writeFileSync(
        file,
        JSON.stringify(
          { ...evidence, result, finishedAt: new Date().toISOString() },
          null,
          2,
        ) + '\n',
      );
      return file;
    };
    log(
      `ready: members ${principals.map((p) => `${p.label}=${memberId(p.label)}`).join(', ')}; group ${st.chainGroupId}`,
    );
    if (options.console)
      runConsole(commands, log, async () => {
        log(`evidence ${writeEvidence('OPERATOR_STOPPED')}`);
        await close();
        process.exit(0);
      });
    return {
      commands,
      close,
      writeEvidence,
      evidence,
      state: st,
      memberId,
      kernel,
      sends: registered.sends,
      mandates,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

type Commands = Awaited<ReturnType<typeof startTelegramDemo>>['commands'];
function runConsole(
  commands: Commands,
  log: (m: string) => void,
  quit: () => Promise<void>,
) {
  const help =
    'commands: link <member> <code|url> | confirm <member> <send-url> | approve <member> <intentHash|url> | propose-mandate <perActionCapAUSD> | approve-mandate <member> <proposalId|url> | quit';
  log(help);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const [cmd, a = '', b = ''] = line.trim().split(/\s+/);
    try {
      const out =
        cmd === 'link'
          ? await commands.link(a, b)
          : cmd === 'confirm'
            ? await commands.confirm(a, b)
            : cmd === 'approve'
              ? await commands.approve(a, b)
              : cmd === 'propose-mandate'
                ? await commands.proposeMandate(a)
                : cmd === 'approve-mandate'
                  ? await commands.approveMandate(a, b)
                  : cmd === 'quit'
                    ? (rl.close(), await quit())
                    : help;
      log(typeof out === 'string' ? out : JSON.stringify(out).slice(0, 400));
    } catch (error) {
      log(`error: ${String(error).slice(0, 300)}`);
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  loadP11Env();
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error(
      'TELEGRAM_BOT_TOKEN is not set. Put it in ~/.synq/p11.env (mode 600) and rerun `pnpm demo:telegram`. Nothing was started.',
    );
    process.exit(2);
  }
  if (process.env.SYNQ_SKIP_INFRA !== '1') {
    const up = spawnSync(
      'docker',
      ['compose', '-f', 'infra/compose.yaml', 'up', '-d', '--wait'],
      { stdio: 'inherit' },
    );
    if (up.status !== 0) {
      console.error('docker compose failed; start Docker and retry');
      process.exit(3);
    }
  }
  await startTelegramDemo({ telegramMode: 'LIVE', console: true });
}
