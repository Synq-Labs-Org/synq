import { WorkspaceTeam } from '@synq/workspaces/team';
import { WorkspaceDeals } from '@synq/workspaces/deals';
import { WorkspaceRevenue } from '@synq/workspaces/revenue';
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
  getAddress,
  isAddress,
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
import { PostgresIdentityStore, safeTransactionHash } from '@synq/identity';
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
import { registerDealRoom } from '@synq/api/deal-routes';
import { registerInvoiceCheckout, payPathFor } from '@synq/api/invoice-routes';
import { WorkspaceInvoices } from '@synq/workspaces/invoices';
import type { WorkspaceFinance } from '@synq/workspaces/finance';
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
  configureMandateCall,
  connectTestnet,
  loadTestnetSigner,
  setExecutorCall,
  testnetRpcUrl,
  type OwnerSigner,
} from './testnet-chain.js';
import { FUND_LIMITS, FundService, PostgresFundStore } from './fund-service.js';
import { registerFundRoutes } from './fund-routes.js';
import { registerBusinessRoutes } from './business-routes.js';
import {
  registerWorkspaceRoutes,
  workspaceCapabilities,
} from './workspace-routes.js';
import { registerAppRoutes } from './app-routes.js';
import { AppApprovals } from './app-approvals.js';
import {
  PostgresWorkspaceStore,
  WorkspaceIdSchema,
  WorkspaceError,
} from '@synq/workspaces';
import {
  WorkspaceDeviceSessions,
  WorkspaceVaultSetups,
} from '@synq/workspaces';
import { CONSENT_SCOPE, WorkspaceLeads } from '@synq/workspaces/leads';
import { WorkspaceOffers } from '@synq/workspaces/offers';
import { SalesAgent } from '@synq/workspaces/sales-agent';
import { AgentEvents } from '@synq/workspaces/agent-events';
import { chainProfile } from '@synq/chain-registry/arc';
import { workspaceVaultRuntime } from '@synq/execution-worker/workspace-vault';
import type { WorkspaceDealEscrow } from '@synq/execution-worker/workspace-escrow';
import { workspaceChannelRuntime } from './workspace-channels.js';
import { WorkspaceNotifications } from './workspace-notifications.js';
import { WorkspaceIndexer } from './workspace-indexer.js';
import { WorkspaceReceipts } from '@synq/workspaces/receipts';
import { arcProviderClients } from '@synq/api/arc-indexer';
import { viemIndexerChain } from '@synq/ledger';
import { workspaceCommandPort } from './workspace-commands.js';
import {
  TelegramAdapter,
  TelegramBotApi,
  type ChannelPorts,
} from '@synq/channels';
import { CardBannerRenderer } from '@synq/channels/cards';
import {
  ArcBusiness,
  liveArcReads,
  parseVendors,
  usdcUnits,
} from './arc-business.js';
import { FundAssistant } from './fund-assistant.js';
import { todayIn } from './fund-intents.js';
import { PostgresTripStore, TripService } from './fund-trips.js';
import { duffelTripPorts } from './duffel-trips.js';
import { giftPorts } from './gifts.js';
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
    // Real passkeys enroll on the deployed site's domain; the software members
    // were enrolled under the local RP and keep signing with it.
    const identityConfig = {
      profile: PROFILE.network.profile,
      rpId: process.env.SYNQ_RP_ID || RP.rpId,
      origin: process.env.SYNQ_ORIGIN || RP.origin,
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
    let workspaceNotifications: WorkspaceNotifications | undefined;
    let workspaceFinance: WorkspaceFinance | undefined;
    let workspaceInvoices: WorkspaceInvoices | undefined;
    let workspaceDeals: WorkspaceDeals | undefined;
    let workspaceEscrow: WorkspaceDealEscrow | undefined;
    let workspaceMessage: ReturnType<typeof workspaceCommandPort> | undefined;
    /** Set once the bot connects; lead invites and staff replies need it. */
    let leadTelegram:
      | {
          username: string | null;
          send(chatId: string, text: string): Promise<void>;
        }
      | undefined;
    let leadPorts: Pick<ChannelPorts, 'leadStart' | 'leadMessage'> | undefined;
    if (process.env.SYNQ_WORKSPACES_ENABLED === '1') {
      if (!process.env.SYNQ_ORIGIN) throw new Error('SYNQ_ORIGIN_REQUIRED');
      const workspaces = new PostgresWorkspaceStore(
        pool,
        process.env.SYNQ_ORIGIN,
      );
      await workspaces.migrate();
      const vault =
        process.env.SYNQ_WORKSPACE_OPERATOR_KEY_FILE &&
        process.env.SYNQ_WORKSPACE_GRANT_KEY_FILE
          ? await workspaceVaultRuntime({
              setups: (defaults) =>
                new WorkspaceVaultSetups(workspaces, defaults),
              operatorKeyFile: process.env.SYNQ_WORKSPACE_OPERATOR_KEY_FILE,
              grantKeyFile: process.env.SYNQ_WORKSPACE_GRANT_KEY_FILE,
              // Compose forwards an unset variable as an empty string.
              rpcUrl: process.env.SYNQ_ARC_RPC_URL || undefined,
              dailyGasLimitWei: BigInt(
                process.env.SYNQ_WORKSPACE_DAILY_GAS_WEI ??
                  '1000000000000000000',
              ),
              maxCreationGasWei: BigInt(
                process.env.SYNQ_WORKSPACE_CREATION_GAS_WEI ??
                  '200000000000000000',
              ),
              screening: process.env.SYNQ_SCREENING_PROVIDER,
              // Compose forwards unset variables as empty strings.
              amaneAgentKeyFile:
                process.env.SYNQ_AMANE_AGENT_KEY_FILE || undefined,
              amaneAccountCodeHash:
                process.env.SYNQ_AMANE_ACCOUNT_CODEHASH || undefined,
            })
          : undefined;
      if (vault) closers.push(() => vault.stop());
      const workspaceChannels = await workspaceChannelRuntime(
        workspaces,
        token,
        options.telegramBaseUrl
          ? { baseUrl: options.telegramBaseUrl }
          : undefined,
      );
      const finance = vault?.finance;
      workspaceFinance = finance;
      const workspaceTeam =
        finance && vault
          ? new WorkspaceTeam(
              finance,
              vault.readIndexedBalance,
              [],
              () => fundReasoner?.structured,
              vault.payouts,
              vault.books,
            )
          : undefined;
      if (workspaceTeam) await workspaceTeam.migrate();
      workspaceMessage = workspaceCommandPort({
        links: workspaceChannels,
        finance,
        payouts: vault?.payouts,
        origin: workspaces.origin,
        mode:
          options.telegramMode === 'LIVE'
            ? 'LIVE_ARC_TESTNET'
            : 'LOCAL_FIXTURE',
        balance: vault?.readBalance,
        team: workspaceTeam,
        invoices: () => workspaceInvoices,
        books: vault?.books,
        deals: () => workspaceDeals,
        revenue: finance ? new WorkspaceRevenue(finance) : undefined,
        treasury: vault?.treasury,
      });
      if (vault) {
        workspaceNotifications = new WorkspaceNotifications(
          workspaceChannels,
          vault.payouts,
          options.telegramMode === 'LIVE'
            ? 'LIVE_ARC_TESTNET'
            : 'LOCAL_FIXTURE',
        );
        await workspaceNotifications.queue.migrate();
      }
      registerWorkspaceRoutes(
        app,
        workspaces,
        vault,
        workspaceChannels,
        finance,
        vault
          ? {
              service: vault.payouts,
              wake: vault.wake,
              screening: vault.screening,
            }
          : undefined,
        vault ? { service: vault.governance, wake: vault.wake } : undefined,
        () => workspaceInvoices,
        finance ? new WorkspaceRevenue(finance) : undefined,
        () => workspaceDeals,
        workspaceTeam,
        vault?.books,
        () =>
          (workspaceEscrow ??=
            workspaceDeals && vault
              ? vault.escrowFor(workspaceDeals)
              : undefined),
        vault?.treasury,
        vault?.contributions,
      );
      const devices = new WorkspaceDeviceSessions(workspaces);
      const agentEvents = new AgentEvents(workspaces, {
        explorerTxUrl:
          process.env.SYNQ_ARC_EXPLORER_TX_URL ??
          `${chainProfile('arc-testnet').explorer}/tx/`,
      });
      await agentEvents.migrate();
      // Revenue splits become agent runs from their stored states and tx hashes.
      setInterval(() => {
        agentEvents.projectSplits().catch(() => undefined);
      }, 60_000).unref();
      // Amane agent payments: contractor jobs paid inside an owner-signed lease.
      const amaneRuntime = vault?.amaneFor(agentEvents) ?? null;
      if (amaneRuntime) {
        await amaneRuntime.amane.migrate();
        await amaneRuntime.executor.migrate();
        const { amane, executor } = amaneRuntime;
        let running = false;
        setInterval(() => {
          if (running) return;
          running = true;
          void (async () => {
            for (const t of await amane.waitingInvoices())
              if (
                workspaceInvoices &&
                (await workspaceInvoices.settledInFull(
                  t.workspaceId,
                  t.invoiceId,
                ))
              )
                await amane.triggerInvoicePaid(t.workspaceId, t.invoiceId);
            for (const id of await amane.ready())
              await executor.execute(id).catch(() => undefined);
          })()
            .catch(() => undefined)
            .finally(() => {
              running = false;
            });
        }, 30_000).unref();
      }
      const leads = new WorkspaceLeads(workspaces, {
        webOrigin: process.env.SYNQ_WEB_BASE_URL ?? workspaces.origin,
        telegramBot: () => leadTelegram?.username ?? null,
        deliver: async (t) => {
          if (t.channel === 'telegram' && leadTelegram)
            await leadTelegram.send(t.deliveryRef, t.text);
        },
        publish: (type, workspaceId, leadId) =>
          agentEvents.publish(type, { workspaceId }, leadId),
      });
      await leads.migrate();
      const offers = new WorkspaceOffers(workspaces, {
        publish: (workspaceId, leadId) =>
          agentEvents.publish('OFFER_UPDATED', { workspaceId }, leadId),
      });
      await offers.migrate();
      const sales = new SalesAgent(
        leads,
        offers,
        () => fundReasoner?.structured,
        async (id) =>
          String(
            (
              await workspaces.pool.query(
                'SELECT display_name FROM synq_workspaces WHERE id=$1',
                [id],
              )
            ).rows[0]?.display_name ?? 'the business',
          ),
        agentEvents,
      );
      leadPorts = {
        leadStart: async (input) => {
          try {
            const r = await leads.redeem({
              token: input.token,
              channel: 'telegram',
              identity: input.externalUserId,
              deliveryRef: input.chatId,
            });
            return {
              text: `You are now talking privately with ${r.workspaceName}. ${CONSENT_SCOPE} Tell us what you need. Nothing said here moves money: agreements are signed and paid separately from your own wallet.`,
            };
          } catch (error) {
            if (error instanceof WorkspaceError)
              return {
                text: 'This invitation is invalid, already used by someone else, or expired. Ask the business for a new link.',
              };
            throw error;
          }
        },
        leadMessage: async (input) => {
          const r = await leads.fromLead({
            channel: 'telegram',
            identity: input.externalUserId,
            text: input.text.slice(0, 4000),
            dedupeKey: input.eventId,
          });
          if (!r) return null;
          if (r.message.duplicate) return { text: '' };
          const reply = await sales.respond(r.lead, r.message.messageId);
          return { text: reply?.text ?? '' };
        },
      };
      registerAppRoutes(app, {
        store: workspaces,
        devices,
        contributions: vault?.contributions,
        governance: vault?.governance,
        balances: vault
          ? { address: (a) => vault.readAddressBalance(a) }
          : undefined,
        leads,
        offers,
        events: agentEvents,
        amane: amaneRuntime?.amane,
        approvals: new AppApprovals(workspaces, {
          setups: vault
            ? { service: vault.setups, wake: vault.wake }
            : undefined,
          finance,
          payouts: vault
            ? { service: vault.payouts, wake: vault.wake }
            : undefined,
          governance: vault
            ? { service: vault.governance, wake: vault.wake }
            : undefined,
          revenue: finance ? new WorkspaceRevenue(finance) : undefined,
          offers,
        }),
        invoices: () => workspaceInvoices,
        books: vault?.books,
        capabilities: () =>
          workspaceCapabilities(
            Boolean(vault),
            Boolean(workspaceChannels),
            Boolean(finance),
            Boolean(vault),
            vault?.screening(),
          ),
      });
    }
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
          // Funds pay test-mode hotel totals here; offered only where a
          // fund's mandate lists it as a counterparty.
          contacts: [
            {
              label: 'Synq Travel (test settlement)',
              address: deployer.address.toLowerCase() as Address,
            },
          ],
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

    // Group funds started from the Messages app (any number of groups).
    const adminInject = async (method: 'POST', url: string, body: unknown) => {
      const r = await app.inject({
        method,
        url,
        headers: {
          'content-type': 'application/json',
          'idempotency-key': randomBytes(8).toString('hex'),
          authorization: `Bearer ${adminToken}`,
        },
        payload: JSON.stringify(body),
      });
      return { status: r.statusCode, body: r.body };
    };
    const fundStore = new PostgresFundStore(pool);
    await fundStore.migrate();
    const funds = new FundService(fundStore, {
      now: clock.now,
      chainId: CHAIN_ID,
      operator: deployer.address,
      asset: ausd,
      principal: async (id) => {
        const p = await store.transaction((tx) => tx.getPrincipal(id));
        return p ? { signer: p.signer, kind: p.kind, status: p.status } : null;
      },
      operatorGas: () => client.getBalance({ address: deployer.address }),
      createGroup: (owners, salt) => chain.createGroup(owners, salt),
      bindGroup: async (g) => {
        const r = await adminInject('POST', '/v1/groups', {
          groupId: g.chainGroupId,
          chainGroupId: g.chainGroupId,
          chainId: CHAIN_ID,
          account: g.account,
          owners: g.owners,
          threshold: g.threshold,
          executors: [deployer.address],
        });
        // A retried launch finds the binding from the first attempt.
        if (r.status >= 400 && r.status !== 409)
          throw new Error(`bind group -> ${r.status} ${r.body.slice(0, 200)}`);
      },
      joinChallenge: async (groupId, memberId, principalId) => {
        const r = await adminInject(
          'POST',
          `/v1/groups/${groupId}/membership-challenges`,
          { memberId, principalId },
        );
        if (r.status >= 400)
          throw new Error(
            `join challenge -> ${r.status} ${r.body.slice(0, 200)}`,
          );
        return IdentityChallengeSchema.parse(JSON.parse(r.body));
      },
      join: async (groupId, challengeId, signature) => {
        const r = await adminInject(
          'POST',
          `/v1/groups/${groupId}/memberships`,
          { challengeId, signature },
        );
        if (r.status >= 400)
          throw new Error(`join -> ${r.status} ${r.body.slice(0, 200)}`);
      },
      safeNonce: (account) => chain.safeNonce(account),
      execSafe: async (account, tx, signatures) => {
        const expected = safeTransactionHash(tx);
        const owners: OwnerSigner[] = signatures.map((s) => ({
          address: s.signer,
          label: s.signer,
          signSafeTransaction: async (t) => {
            if (safeTransactionHash(t) !== expected)
              throw new Error('setup transaction changed since owners signed');
            return s.signature;
          },
        }));
        const receipt = await chain
          .governance(account, owners)
          .exec('fund setup', tx.to, tx.data);
        return receipt.transactionHash;
      },
      setupCalls: (m) => [
        {
          ...setExecutorCall(deployment.module, deployer.address, true),
          step: 'ExecutionModule.setExecutor',
        },
        {
          ...configureMandateCall(
            deployment.registry,
            onchainMandateId(m),
            toMandateConfig(m),
          ),
          step: 'MandateRegistry.configureMandate',
        },
      ],
      mandate: (input) =>
        sendMandate({
          chainGroupId: input.chainGroupId,
          account: input.account,
          executor: deployer.address,
          recipients: [
            ...input.members.map((m) => ({
              address: m.signer.toLowerCase() as Address,
              purpose: 'MEMBER_WITHDRAWAL' as const,
            })),
            // Synq Travel settlement: group-approved hotel totals (test mode).
            {
              address: deployer.address.toLowerCase() as Address,
              purpose: 'COUNTERPARTY' as const,
            },
          ],
          asset: ausd,
          members: input.members.map((m) => ({
            memberId: m.memberId,
            signer: m.signer.toLowerCase() as Address,
          })),
          now: input.now,
          limits: {
            perActionCap: FUND_LIMITS.perActionCap,
            cumulativeBudget: FUND_LIMITS.cumulativeBudget,
            reviewMax: FUND_LIMITS.reviewMax,
            validSeconds: FUND_LIMITS.validSeconds,
            maxExecutions: FUND_LIMITS.maxExecutions,
          },
        }),
      activateMandate: async (m) => {
        await registerMandateArtifacts(projectionStore, [
          { mandateHash: artifactHash(m), artifact: m },
        ]);
        await catchUp();
        kernel.configureMandate(m);
      },
      transfer: async (account, units) =>
        (await chain.fund(account, units)).transactionHash,
      treasury: (account) => chain.balanceOf(account),
      sends: (groupId, limit) => registered.sends.forGroup(groupId, limit),
      quorum: async (digest) => {
        const q = await approvalGateway.quorum(digest);
        return {
          memberIds: q.counted.map((a) => a.memberId),
          required: q.required,
        };
      },
      explorer: (h) => `${EXPLORER}${h}`,
      log,
    });
    const fundReasoner = brainReasonersFromEnv(process.env);
    // Plain instructions work without a model; open questions need one.
    const assistantTimeZone = process.env.SYNQ_ASSISTANT_TZ ?? 'Asia/Kolkata';
    const assistant = new FundAssistant({
      complete: fundReasoner
        ? async ({ system, user, schema }) =>
            (
              await fundReasoner.structured.complete({
                role: 'INTENT',
                agentId: 'fund-assistant',
                fixtureKey: 'fund-assistant',
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content: user },
                ],
                responseSchema: schema,
                maxOutputTokens: 800,
              })
            ).text
        : null,
      today: () => todayIn(assistantTimeZone, clock.now()),
      timeZone: assistantTimeZone,
      maxPaymentAmount: Number(FUND_LIMITS.perActionCap) / 1e6,
    });
    const tripStore = new PostgresTripStore(pool);
    await tripStore.migrate();
    const duffelToken = process.env.DUFFEL_TEST_TOKEN ?? '';
    const searchApiKey = process.env.SEARCHAPI_KEY ?? '';
    const lithicKey = process.env.LITHIC_API_KEY ?? '';
    const gifts =
      searchApiKey && lithicKey && process.env.LITHIC_ENV === 'sandbox'
        ? giftPorts({ searchApiKey, lithicApiKey: lithicKey })
        : undefined;
    const trips = /^duffel_test_/.test(duffelToken)
      ? new TripService(tripStore, {
          ...(gifts ? { gifts } : {}),
          now: clock.now,
          fund: (fundId, key) => funds.view(fundId, key),
          ...duffelTripPorts(duffelToken, clock.now),
          settlement: {
            address: deployer.address,
            recipientId: `contact:${deployer.address.toLowerCase()}`,
            label: 'Synq Travel (test settlement)',
          },
          sends: (groupId) => registered.sends.forGroup(groupId, 30),
          log,
        })
      : undefined;
    log(
      `funds: assistant ${fundReasoner ? 'model + instructions' : 'instructions only (no model)'}, flights ${trips ? 'Duffel test mode' : 'off (no DUFFEL_TEST_TOKEN)'}, gifts ${gifts ? 'live search + Lithic sandbox' : 'off'}`,
    );
    registerFundRoutes(app, funds, {
      legacyWrites: process.env.SYNQ_LEGACY_MONAD_FUNDS === '1',
      assistant,
      ...(trips ? { trips } : {}),
    });
    // Arc business features for the Messages app. Deal Room and invoices turn
    // on with their link keys; the rest only reads Arc testnet.
    if (
      process.env.SYNQ_WORKSPACES_ENABLED === '1' ||
      process.env.SYNQ_ARC_BUSINESS !== '0'
    ) {
      const off = (feature: string) => (e: unknown) => {
        log(`${feature}: off (${(e as Error).message.slice(0, 160)})`);
        return null;
      };
      // Compose passes unset values as empty strings; treat them as unset.
      const arcEnv = Object.fromEntries(
        Object.entries(process.env).filter(([, v]) => v !== ''),
      );
      const dealRoom = await registerDealRoom({
        app,
        pool,
        env: arcEnv,
        authorizeView: async (req, view) => {
          if (!workspaceDeals)
            throw new WorkspaceError('WORKSPACE_DEALS_BLOCKED', 503);
          const bearer = req.headers.authorization;
          const cookies = (req.headers.cookie ?? '')
            .split(';')
            .map((v) => v.trim())
            .filter((v) => v.startsWith('__Host-synq_workspace='));
          if (bearer !== undefined && !/^Bearer [0-9a-f]{64}$/.test(bearer))
            throw new WorkspaceError('UNAUTHENTICATED', 401);
          const audience = bearer ? 'native' : 'web';
          if (!bearer && cookies.length !== 1)
            throw new WorkspaceError('UNAUTHENTICATED', 401);
          const session = await workspaceDeals.workspaces.session(
            bearer
              ? bearer.slice(7)
              : cookies[0]!.slice('__Host-synq_workspace='.length),
            audience,
          );
          if (
            req.method !== 'GET' &&
            audience === 'web' &&
            req.headers.origin !== workspaceDeals.workspaces.origin
          )
            throw new WorkspaceError('ORIGIN_MISMATCH', 403);
          await workspaceDeals.workspaces.throttle(
            `principal:${session.principalId}`,
            120,
          );
          await workspaceDeals.authorize(
            view.deal.workspaceId,
            session.principalId,
            view.deal.dealId,
          );
        },
      }).catch(off('deal room'));
      if (dealRoom && workspaceFinance)
        workspaceDeals = new WorkspaceDeals(
          workspaceFinance.workspaces,
          dealRoom.service,
          Buffer.from(arcEnv.SYNQ_DEALROOM_LINK_KEY!, 'hex'),
        );
      const checkout = await registerInvoiceCheckout({
        app,
        pool,
        env: arcEnv,
        authorizeIssue: async (invoice) => {
          if (WorkspaceIdSchema.safeParse(invoice.workspaceId).success) {
            if (!workspaceInvoices)
              throw new WorkspaceError('WORKSPACE_INVOICES_BLOCKED', 503);
            await workspaceInvoices.authorizeIssue(invoice);
          }
        },
      }).catch(off('invoices'));
      if (checkout && workspaceFinance)
        workspaceInvoices = new WorkspaceInvoices(
          workspaceFinance,
          checkout.invoices,
          (invoice) =>
            payPathFor(Buffer.from(arcEnv.SYNQ_PAY_LINK_KEY!, 'hex'), invoice),
        );
      if (workspaceInvoices && options.telegramMode === 'LIVE') {
        const indexer = new WorkspaceIndexer(
          new WorkspaceReceipts(
            workspaceInvoices.finance,
            workspaceInvoices.service,
            workspaceInvoices.service.ledger,
          ),
          arcProviderClients().map(viemIndexerChain),
        );
        await indexer.migrate();
        let busy = false,
          stopped = false;
        const tick = async () => {
          if (busy || stopped) return;
          busy = true;
          try {
            const outcomes = await indexer.tick();
            for (const outcome of outcomes)
              if (outcome.state !== 'INDEXED')
                log(
                  `Workspace indexer ${outcome.workspaceId}: ${outcome.state}`,
                );
          } catch {
            log('Workspace indexer deferred; cursor retained.');
          } finally {
            busy = false;
          }
        };
        const timer = setInterval(() => void tick(), 5000);
        timer.unref();
        closers.push(async () => {
          stopped = true;
          clearInterval(timer);
          while (busy) await new Promise((resolve) => setTimeout(resolve, 100));
        });
      }
      if (process.env.SYNQ_LEGACY_MONAD_FUNDS === '1') {
        const owner = process.env.SYNQ_ARC_OWNER;
        const floorFrom = (v: string | undefined) => {
          try {
            return v ? { operatingFloor: usdcUnits(v) } : {};
          } catch {
            log(
              'business: SYNQ_ARC_FLOOR_USDC is not a USDC amount; default floor',
            );
            return {};
          }
        };
        const business = new ArcBusiness({
          name: process.env.SYNQ_ARC_BUSINESS_NAME || 'Synq demo business',
          reads: liveArcReads(
            process.env.SYNQ_ARC_RPC_URL ||
              process.env.SYNQ_ARC_TESTNET_RPC_URL,
          ),
          vendors: parseVendors(process.env.SYNQ_ARC_VENDORS),
          ...(owner && isAddress(owner) ? { owner: getAddress(owner) } : {}),
          ...floorFrom(process.env.SYNQ_ARC_FLOOR_USDC),
          now: clock.now,
          webBaseUrl: process.env.SYNQ_WEB_BASE_URL ?? 'http://localhost:3000',
          reasoner: fundReasoner?.structured ?? null,
          env: process.env,
          offReasons: {
            ...(process.env.SYNQ_DEALROOM_LINK_KEY && !dealRoom
              ? {
                  deals:
                    'Deal Room could not start on this server (see the bot log).',
                }
              : {}),
            ...(process.env.SYNQ_PAY_LINK_KEY && !checkout
              ? {
                  invoices:
                    'Invoices could not start on this server (see the bot log).',
                }
              : {}),
          },
          ...(dealRoom
            ? {
                deals: {
                  service: dealRoom.service,
                  linkKey: Buffer.from(
                    process.env.SYNQ_DEALROOM_LINK_KEY!,
                    'hex',
                  ),
                },
              }
            : {}),
          ...(checkout
            ? {
                invoices: {
                  service: checkout.invoices,
                  payLinkKey: Buffer.from(
                    process.env.SYNQ_PAY_LINK_KEY!,
                    'hex',
                  ),
                },
              }
            : {}),
        });
        registerBusinessRoutes(app, funds, business);
        log(
          `business (Arc testnet): deals ${dealRoom ? 'on' : 'off'}, invoices ${checkout ? 'on' : 'off'}, contractors ${parseVendors(process.env.SYNQ_ARC_VENDORS).length}, council read-only`,
        );
      }
    }
    /** Operator-local view of what the bot sent (not evidence; may hold link codes). */
    const outbox: {
      chatId: string;
      text: string;
      urls: string[];
      at: string;
    }[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const method = String(input).split('/').at(-1);
      if (method === 'sendMessage' && init?.body) {
        const body = JSON.parse(String(init.body)) as {
          chat_id: number;
          text: string;
          reply_markup?: { inline_keyboard?: { url?: string }[][] };
        };
        outbox.push({
          chatId: String(body.chat_id),
          text: body.text,
          urls: [
            ...(body.reply_markup?.inline_keyboard
              ?.flat()
              .map((b) => b.url ?? '') ?? []),
            ...(body.text.match(/https?:\/\/\S+/g) ?? []),
          ].filter(Boolean),
          at: new Date().toISOString(),
        });
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
      workspaceOnboarding: process.env.SYNQ_WORKSPACES_ENABLED === '1',
      ...(workspaceMessage ? { workspaceMessage } : {}),
      ...(leadPorts ?? {}),
      env: {
        TELEGRAM_BOT_TOKEN: token,
        SYNQ_TELEGRAM_MODE: 'poll',
        SYNQ_WEB_BASE_URL:
          process.env.SYNQ_WEB_BASE_URL ?? 'http://localhost:3000',
        SYNQ_CHANNEL_NOTIFY_MS: '3000',
        // Group-bound review links (/approve?p&g&n) for cards shared into iMessage.
        ...(process.env.SYNQ_CARD_LINK_KEY
          ? { SYNQ_CARD_LINK_KEY: process.env.SYNQ_CARD_LINK_KEY }
          : {}),
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
    const leadBot = channels?.telegram;
    if (leadBot)
      leadTelegram = {
        username: leadBot.botUsername ?? null,
        send: async (chatId, text) => {
          await leadBot.send(chatId, { text });
        },
      };
    if (!channels?.telegram) throw new Error('TELEGRAM_NOT_CONFIGURED');
    evidence.bot = {
      username: channels.telegram.botUsername,
      idHash: sha(String(channels.telegram.botId)),
    };
    await app.listen({
      port: Number(process.env.SYNQ_API_PORT ?? 3200),
      // Loopback by default; the container sets 0.0.0.0 behind the reverse proxy.
      host: process.env.SYNQ_API_HOST ?? '127.0.0.1',
    });
    closers.push(() => app.close());
    const addr = app.server.address();
    const api = new SynqApiClient(
      `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 3200}`,
      adminToken,
    );
    if (workspaceNotifications) {
      const notifications = workspaceNotifications,
        adapter = new TelegramAdapter({
          api: new TelegramBotApi({
            token,
            fetch: recordingFetch,
            ...(options.telegramBaseUrl
              ? { baseUrl: options.telegramBaseUrl }
              : {}),
          }),
          maxAttempts: 1,
          banners: new CardBannerRenderer({ networkLabel: 'Arc Testnet' }),
        });
      let busy = false,
        stopped = false;
      const send = async () => {
        if (busy || stopped) return;
        busy = true;
        try {
          await notifications.pump(adapter);
        } catch {
          log('Workspace delivery deferred; durable money state unchanged.');
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => void send(), 5000);
      timer.unref();
      closers.push(async () => {
        stopped = true;
        clearInterval(timer);
        while (busy) await new Promise((resolve) => setTimeout(resolve, 100));
      });
    }
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
        if (process.env.SYNQ_LEGACY_MONAD_FUNDS === '1') {
          await funds
            .tick()
            .catch((e) => log(`funds: ${String(e).slice(0, 200)}`));
          await trips
            ?.tick(
              async (fundId) =>
                (await fundStore.get(fundId))?.group?.chainGroupId ?? null,
            )
            .catch((e) => log(`trips: ${String(e).slice(0, 200)}`));
        }
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
    const latestUrl = (match: (u: string) => boolean, chatId?: string) =>
      [...outbox]
        .reverse()
        .filter((m) => chatId === undefined || m.chatId === chatId)
        .flatMap((m) => m.urls)
        .find(match) ?? null;
    const commands = {
      pendingLinks() {
        return (
          outbox
            .filter((m) =>
              m.urls.some((u) => u.includes('/channels/link?code=')),
            )
            .map((m) => `${m.at} private chat ${m.chatId}`)
            .join('\n') || 'no private links issued yet'
        );
      },
      async link(label: string, codeOrUrl: string) {
        const resolved = /^-?[0-9]+$/.test(codeOrUrl)
          ? latestUrl((u) => u.includes('/channels/link?code='), codeOrUrl)
          : codeOrUrl;
        if (!resolved)
          throw new Error(`no link was sent to private chat ${codeOrUrl}`);
        const code = lastPart(resolved, 'code');
        return api.post(
          '/v1/channels/links/redeem',
          { code, groupId: st.chainGroupId },
          await memberSession(label),
        );
      },
      async confirm(label: string, sendArg: string) {
        const sendUrl =
          sendArg === 'last' ? latestUrl((u) => u.includes('/send?')) : sendArg;
        if (!sendUrl) throw new Error('no Send link posted yet');
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
        const latest = (await registered.sends.inState('PENDING_APPROVAL')).at(
          -1,
        );
        const intentHash =
          intent === 'last' ? latest?.intentHash : intent.split('/').at(-1);
        if (!intentHash) throw new Error('no Send is waiting for approval');
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
        const open = (await mandates.list(st.chainGroupId)).filter(
          (p) => p.state === 'PENDING' || p.state === 'READY',
        );
        const id =
          proposal === 'last'
            ? open.at(-1)?.proposalId
            : proposal.split('/').at(-1);
        if (!id) throw new Error('no mandate proposal is open');
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
    'commands: links | link <member> <private-chat-id|link> | confirm <member> <send-url|last> | approve <member> <intentHash|last> | propose-mandate <perActionCapAUSD> | approve-mandate <member> <proposalId|last> | quit';
  log(help);
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    const [cmd, a = '', b = ''] = line.trim().split(/\s+/);
    try {
      const out =
        cmd === 'links'
          ? commands.pendingLinks()
          : cmd === 'link'
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
