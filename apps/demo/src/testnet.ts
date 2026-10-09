import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import {
  GrantApprovalChallengeSchema,
  IdentityChallengeSchema,
  MandateSchema,
  PendingIntentViewSchema,
  PrincipalViewSchema,
  QuorumViewSchema,
  VerifiedApprovalSchema,
  type ExecutionGrant,
  type GrantDraft,
  type Mandate,
  type VerifiedApproval,
} from '@synq/schemas';
import {
  Kernel,
  onchainMandateId,
  toMandateConfig,
  type AuthorizationDecision,
  type FreshnessProbe,
} from '@synq/kernel';
import {
  ChainHeadObserver,
  EnvioPostgresSource,
  ProjectionReader,
  ProjectionReconciliationSignals,
  Projector,
  RpcDirectVerifier,
  syncToTarget,
} from '@synq/read-model';
import { PostgresProjectionStore } from '@synq/read-model/storage';
import {
  ReadModelFreshnessProbe,
  RpcKernelDirectVerifier,
  RpcNonceStatusReader,
} from '@synq/read-model/kernel';
import { monadTestnetProfile } from '@synq/chain-registry';
import {
  ReorgReconciler,
  loadJournalKey,
  loadKernelAuditKey,
  packSafeSignatures,
} from '@synq/execution-worker';
import { registryAbi } from '@synq/execution-worker/abi';
import { formatDecimal } from '@synq/domain';
import {
  PostgresIdentityStore,
  StoreApprovalLedger,
  StoreDelegationEvaluator,
  StoreMembershipDirectory,
} from '@synq/identity';
import { grantPreview } from '@synq/identity/grant';
import {
  approveGrantWithMera,
  enrollMeraPrincipal,
  signMeraIdentityChallenge,
  signMeraSafeTransaction,
  type MeraCredential,
} from '@synq/identity/mera-browser';
import { PluginRegistry } from '@synq/plugin-sdk';
import { createV1Api } from '@synq/api/v1';
import { mandateReader } from '@synq/api/v1-server';
import { readModelRoutes } from '@synq/api/read-model-routes';
import { registryDeploymentSettings } from '../../../scripts/envio-env.js';
import { EnvioProcess } from '../../../scripts/envio-process.js';
import {
  SOFTWARE_PRF_TIER,
  SoftwareAuthenticatorStore,
} from './software-authenticator.js';
import { ApiCallError, SynqApiClient } from './testnet-api.js';
import {
  EXPLORER_TX,
  TestnetChainError,
  connectTestnet,
  loadTestnetSigner,
  type OwnerSigner,
} from './testnet-chain.js';
import { erc20TransferPlugin } from './transfer-plugin.js';
import { transferVertical, type DraftOutcome } from './vertical.js';

const PROFILE = monadTestnetProfile;
const CHAIN_ID = PROFILE.network.chainId;
const RP = {
  rpId: 'localhost',
  rpName: 'Synq testnet e2e',
  origin: 'http://localhost',
};
const LABELS = ['alice', 'bob', 'carol'] as const;
const MANDATE_ID = 'testnet_transfer';
const PLUGIN_ID = 'ausd-transfer';
const WORKER_ID = 'testnet-execution-worker';
const MAX_MON_SPEND = 1_500_000_000_000_000_000n;
const UNITS = {
  funding: 25_000_000n,
  transfer: 1_500_000n,
  perActionCap: 5_000_000n,
  cumulativeBudget: 20_000_000n,
  probe: 1_000_000n,
};

export type TestnetE2EOptions = {
  databaseUrl?: string;
  evidenceDirectory?: string;
  workDirectory?: string;
  authenticatorStore?: string;
};

function databaseUrl(options: TestnetE2EOptions): string {
  return (
    options.databaseUrl ??
    process.env.SYNQ_E2E_TESTNET_DATABASE_URL ??
    'postgresql://postgres:synq_local@127.0.0.1:55432/synq_e2e_testnet'
  );
}

async function ensureDatabase(url: string): Promise<void> {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*e2e[a-z0-9_]*$/.test(name))
    throw new Error('E2E_DATABASE_NAME_MUST_CONTAIN_E2E');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

function testnetMandate(input: {
  chainGroupId: Hex;
  account: Address;
  executor: Address;
  recipient: Address;
  asset: Mandate['inputAsset'];
  members: { memberId: string; signer: Address }[];
  now: number;
}): Mandate {
  return MandateSchema.parse({
    schemaVersion: 2,
    mandateId: MANDATE_ID,
    groupId: input.chainGroupId,
    version: 1,
    status: 'ACTIVE',
    network: PROFILE.network,
    account: input.account,
    chainGroupId: input.chainGroupId,
    operators: [input.executor],
    bindings: [
      {
        pluginId: PLUGIN_ID,
        action: 'TRANSFER',
        target: input.asset.address,
        selector: '0xa9059cbb',
      },
    ],
    recipients: [{ address: input.recipient, purpose: 'COUNTERPARTY' }],
    inputAsset: input.asset,
    outputAssets: [],
    perActionCap: String(UNITS.perActionCap),
    cumulativeBudget: String(UNITS.cumulativeBudget),
    maxNativeValue: '0',
    cumulativeNativeBudget: '0',
    maxSlippageBps: 0,
    maxReferenceDeviationBps: 0,
    maxLeverageBps: 0,
    maxAllocationBps: 10_000,
    tierPolicy: {
      tokenSpend: { autoMax: '0', reviewMax: '0' },
      nativeSpend: { autoMax: '0', reviewMax: '0' },
      actionFloors: [],
      newOutputAsset: 'CONSENSUS',
      leverage: 'BLOCKED',
      withdrawal: 'UNANIMOUS',
    },
    approvalPolicy: {
      quorum: 2,
      reviewApprovals: 1,
      accountThreshold: 2,
      eligibleKinds: ['MERA_HUMAN'],
    },
    delegationScope: null,
    members: input.members.map((m) => ({ ...m, active: true })),
    validAfter: input.now - 60,
    validUntil: input.now + 7 * 86_400,
    quoteTtlSeconds: 300,
    evidenceTtlSeconds: 300,
    simulationTtlSeconds: 300,
    maxGrantTtlSeconds: 300,
    minIntervalSeconds: 0,
    maxExecutions: 10,
  });
}

function errorCode(error: unknown): string {
  if (error instanceof ApiCallError)
    return error.rejectionCode ?? error.message;
  return (error as { code?: string }).code ?? String(error);
}

export async function runTestnetE2E(options: TestnetE2EOptions = {}) {
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-${randomBytes(3).toString('hex')}`;
  const evidenceDirectory = resolve(
    options.evidenceDirectory ?? 'reports/evidence/testnet-e2e',
  );
  const workDirectory = resolve(
    options.workDirectory ?? join('artifacts/testnet-e2e', runId),
  );
  mkdirSync(evidenceDirectory, { recursive: true });
  mkdirSync(workDirectory, { recursive: true });
  const logFile = join(evidenceDirectory, `${runId}.log`);
  const log = (message: string) => {
    const line = `${new Date().toISOString()} ${message}`;
    appendFileSync(logFile, line + '\n');
    console.log(line);
  };
  process.env.SYNQ_NETWORK = PROFILE.network.profile;
  process.env.SYNQ_KERNEL_AUDIT_KEY_FILE ??= join(
    homedir(),
    '.synq/e2e/kernel-audit.key',
  );
  process.env.SYNQ_JOURNAL_KEY_FILE ??= join(
    homedir(),
    '.synq/e2e/journal.key',
  );
  const closers: (() => Promise<unknown>)[] = [];
  const evidence: Record<string, unknown> = {
    schemaVersion: 1,
    runId,
    startedAt: new Date().toISOString(),
    profile: PROFILE.network.profile,
    chainId: CHAIN_ID,
    identityEvidenceTier: SOFTWARE_PRF_TIER,
  };
  try {
    const chain = await connectTestnet(loadTestnetSigner());
    const { client, deployer, deployment, ausd } = chain;
    evidence.transactions = chain.transactions;
    const monBefore = await client.getBalance({ address: deployer.address });
    const ausdBefore = await chain.balanceOf(deployer.address);
    log(
      `deployer ${deployer.address} MON=${formatDecimal(monBefore, 18)} AUSD=${formatDecimal(ausdBefore, ausd.decimals)}`,
    );
    if (monBefore < MAX_MON_SPEND / 3n)
      throw new TestnetChainError('INSUFFICIENT_FUNDS', 'MON');
    if (ausdBefore < UNITS.funding)
      throw new TestnetChainError('INSUFFICIENT_FUNDS', 'AUSD');

    const dbUrl = databaseUrl(options);
    await ensureDatabase(dbUrl);
    const pool = new pg.Pool({ connectionString: dbUrl, max: 8 });
    closers.push(() => pool.end());
    const store = new PostgresIdentityStore(pool);
    await store.migrate();

    const auditKey = loadKernelAuditKey([workDirectory, evidenceDirectory]);
    const journalDirectory = join(workDirectory, 'journal');
    const journalKey = loadJournalKey(journalDirectory);
    if (auditKey.source !== 'FILE' || journalKey.source !== 'FILE')
      throw new TestnetChainError('KEY_FILE_REQUIRED', 'integrity keys');

    const adminToken = randomBytes(32).toString('hex');
    const late: { kernel: Kernel | null } = { kernel: null };
    const head = new ChainHeadObserver(client, CHAIN_ID, { ttlMs: 0 });

    const authenticators = new SoftwareAuthenticatorStore(
      options.authenticatorStore,
    );
    const webAuthn = (label: string) => ({
      webAuthnClient: authenticators.client(label),
    });

    // Phase A: identity-only API for enrollment.
    const startApi = async (
      readModel?: Parameters<typeof readModelRoutes>[1] & {
        mandates: ReturnType<typeof mandateReader>;
      },
    ) => {
      const app = createV1Api({
        intents: {
          authorize: (request) => {
            if (!late.kernel) throw new Error('KERNEL_NOT_READY');
            return late.kernel.authorize(request);
          },
        },
        store,
        config: {
          profile: PROFILE.network.profile,
          rpId: RP.rpId,
          origin: RP.origin,
        },
        adminToken,
        executionModules: { [CHAIN_ID]: deployment.module },
        rateLimit: { capacity: 10_000, refillPerSecond: 1_000 },
        ...(readModel ? { mandates: readModel.mandates } : {}),
      });
      if (readModel) await app.register(readModelRoutes, readModel);
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') throw new Error('API_PORT');
      return {
        app,
        api: new SynqApiClient(`http://127.0.0.1:${address.port}`, adminToken),
      };
    };
    let phase = await startApi();
    let api = phase.api;
    closers.push(() => phase.app.close());

    const principals: { label: string; record: MeraCredential }[] = [];
    for (const label of LABELS) {
      let record = authenticators.record(label);
      if (!record) {
        const enrolled = await enrollMeraPrincipal(
          {
            rpId: RP.rpId,
            rpName: RP.rpName,
            user: { name: label, displayName: label },
            requestChallenge: async ({ signer, credential }) =>
              IdentityChallengeSchema.parse(
                await api.post('/v1/principals/enrollment-challenges', {
                  kind: 'MERA_HUMAN',
                  signer,
                  credential: {
                    credentialId: credential.credentialId,
                    ...(credential.transports
                      ? { transports: [...credential.transports] }
                      : {}),
                  },
                  rpId: RP.rpId,
                  origin: RP.origin,
                }),
              ),
          },
          webAuthn(label),
        );
        await api.post('/v1/principals', {
          challengeId: enrolled.challenge.challengeId,
          signature: enrolled.signature,
        });
        record = enrolled.record;
        authenticators.saveRecord(label, record);
        log(`enrolled new Mera principal ${label} ${record.principalId}`);
      } else {
        try {
          await api.get(
            `/v1/principals/${encodeURIComponent(record.principalId)}`,
          );
          log(`reusing enrolled Mera principal ${label} ${record.principalId}`);
        } catch (error) {
          if (!(error instanceof ApiCallError) || error.status !== 404)
            throw error;
          const challenge = IdentityChallengeSchema.parse(
            await api.post('/v1/principals/enrollment-challenges', {
              kind: 'MERA_HUMAN',
              signer: record.signer,
              credential: { credentialId: record.credential.credentialId },
              rpId: RP.rpId,
              origin: RP.origin,
            }),
          );
          await api.post('/v1/principals', {
            challengeId: challenge.challengeId,
            signature: await signMeraIdentityChallenge(
              record,
              challenge,
              webAuthn(label),
            ),
          });
          log(`re-enrolled stored Mera passkey ${label} ${record.principalId}`);
        }
      }
      PrincipalViewSchema.parse(
        await api.get(
          `/v1/principals/${encodeURIComponent(record.principalId)}`,
        ),
      );
      principals.push({ label, record });
    }
    principals.sort((a, b) => (a.record.signer < b.record.signer ? -1 : 1));
    const owners: OwnerSigner[] = principals.map((p) => ({
      address: p.record.signer,
      label: p.label,
      signSafeTransaction: (tx) =>
        signMeraSafeTransaction(p.record, tx, webAuthn(p.label)),
    }));
    const recipient = authenticators.recipient();
    evidence.principals = principals.map((p, i) => ({
      label: p.label,
      memberId: `member_${i}`,
      principalId: p.record.principalId,
      signer: p.record.signer,
      kind: 'MERA_HUMAN',
      derivation: p.record.derivation,
    }));
    evidence.recipient = recipient;

    // Group creation on testnet; the group's creation block is the indexer start.
    const salt = keccak256(stringToHex(`synq.testnet.e2e.${runId}`));
    const group = await chain.createGroup(
      owners.map((o) => o.address),
      salt,
    );
    log(
      `group ${group.chainGroupId} Safe ${group.account} created at block ${group.blockNumber}`,
    );
    evidence.group = {
      chainGroupId: group.chainGroupId,
      safe: group.account,
      salt,
      threshold: 2,
      owners: owners.map((o) => o.address),
      creationBlock: String(group.blockNumber),
    };

    const settings = registryDeploymentSettings(PROFILE.network.profile, {
      startBlock: Number(group.blockNumber),
    });
    const envioSchema = `envio_e2e_${runId.slice(-6)}`;
    const rmSchema = `rm_e2e_${runId.slice(-6)}`;
    const url = new URL(dbUrl);
    const envio = new EnvioProcess({
      env: settings.env,
      schema: envioSchema,
      database: {
        host: url.hostname,
        port: Number(url.port),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        name: url.pathname.slice(1),
      },
      logFile: join(workDirectory, 'envio.log'),
    });
    await envio.start();
    closers.push(() => envio.stop());
    log(
      `Envio started (schema ${envioSchema}) from block ${settings.projection.startBlock}`,
    );

    // Identity binding: group + memberships proven by each principal.
    await api.post(
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
    for (const [i, p] of principals.entries()) {
      const challenge = IdentityChallengeSchema.parse(
        await api.post(
          `/v1/groups/${group.chainGroupId}/membership-challenges`,
          {
            memberId: `member_${i}`,
            principalId: p.record.principalId,
          },
        ),
      );
      await api.post(`/v1/groups/${group.chainGroupId}/memberships`, {
        challengeId: challenge.challengeId,
        signature: await signMeraIdentityChallenge(
          p.record,
          challenge,
          webAuthn(p.label),
        ),
      });
    }
    evidence.identityGroup = await api.get(`/v1/groups/${group.chainGroupId}`);
    log('identity group bound; three memberships joined with passkey proofs');

    // Safe governance signed by two Mera owners; deployer only pays gas.
    const latest = await client.getBlock();
    const mandate = testnetMandate({
      chainGroupId: group.chainGroupId,
      account: group.account,
      executor: deployer.address,
      recipient,
      asset: ausd,
      members: owners.map((o, i) => ({
        memberId: `member_${i}`,
        signer: o.address.toLowerCase() as Address,
      })),
      now: Number(latest.timestamp),
    });
    const onchainId = onchainMandateId(mandate);
    const gov = chain.governance(group.account, owners);
    await gov.setExecutor(deployer.address, true);
    await gov.configureMandate(onchainId, toMandateConfig(mandate));
    await chain.fund(group.account, UNITS.funding);
    log('executor set, mandate configured, Safe funded');

    // Read model: Envio -> projection; Kernel reads freshness/balances from it.
    const projectionStore = new PostgresProjectionStore(
      { pool },
      CHAIN_ID,
      rmSchema,
    );
    await projectionStore.migrate();
    await projectionStore.resetProjection();
    const projector = new Projector(projectionStore, settings.projection);
    const source = new EnvioPostgresSource({ pool }, CHAIN_ID, envioSchema);
    const reader = new ProjectionReader(projectionStore, settings.projection);
    const signals = new ProjectionReconciliationSignals(projector);
    let reorg: ReorgReconciler | null = null;
    const catchUp = async (block?: bigint) => {
      const target = Number(
        block ?? (await client.getBlockNumber({ cacheTime: 0 })),
      );
      const indexed = await envio.waitFor(pool, CHAIN_ID, target, 900_000);
      await syncToTarget(source, projector);
      if (reorg) await reorg.sync();
      return indexed;
    };
    const t0 = Date.now();
    await catchUp();
    log(`Envio caught up to head in ${Math.round((Date.now() - t0) / 1000)}s`);
    const initial = await reader.groupSnapshot(group.chainGroupId);
    if (!initial) throw new Error('GROUP_NOT_INDEXED');

    const clock = {
      t: Number(latest.timestamp),
      now() {
        return this.t;
      },
    };
    const sync = async () => {
      const block = await client.getBlock({ blockTag: 'latest' });
      clock.t = Math.max(clock.t, Number(block.timestamp));
      return clock.t;
    };
    const probe: FreshnessProbe = {
      async observe(query) {
        await catchUp();
        return new ReadModelFreshnessProbe(reader, head).observe(query);
      },
    };
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
    const kernel = new Kernel({
      network: PROFILE.network,
      executionModule: deployment.module,
      clock,
      approvalLedger: new StoreApprovalLedger(store),
      membershipDirectory: new StoreMembershipDirectory(store),
      delegations: new StoreDelegationEvaluator(store),
      freshness: {
        probe,
        verifier: new RpcKernelDirectVerifier(client, settings.projection),
        maxLagBlocks: settings.maxLagBlocks,
      },
      nonceStatus: new RpcNonceStatusReader(client, settings.projection),
      auditKey: auditKey.bytes,
      plugins: [plugin.manifest],
      mandates: [mandate],
      balances: [
        {
          account: group.account,
          asset: ausd,
          balance:
            initial.group.treasury.find(
              (t) => t.asset === ausd.address.toLowerCase(),
            )?.balance ?? '0',
        },
      ],
      balanceBlock: String(initial.indexedThroughBlock),
    });
    late.kernel = kernel;

    // Phase B: API with Kernel-backed intents and the read-model routes.
    await phase.app.close();
    phase = await startApi({
      snapshots: reader,
      head: new ChainHeadObserver(client, CHAIN_ID, { ttlMs: 1000 }),
      maxLagBlocks: settings.maxLagBlocks,
      mandates: mandateReader(reader),
    });
    api = phase.api;

    const memberOf = (signer: string) =>
      `member_${owners.findIndex((o) => o.address.toLowerCase() === signer)}`;
    const approveViaApi = async (
      draft: GrantDraft,
      indexes: readonly number[],
    ): Promise<VerifiedApproval[]> => {
      const view = PendingIntentViewSchema.parse(
        await api.get(`/v1/intents/${draft.grant.intentHash}`),
      );
      if (view.draft.digest !== draft.digest)
        throw new Error('API_DRAFT_DIVERGES');
      for (const i of indexes) {
        const p = principals[i]!;
        const signed = await approveGrantWithMera(
          {
            record: p.record,
            memberId: memberOf(p.record.signer),
            draft: view.draft,
            asset: view.asset,
            confirmedPreview: grantPreview(view.draft, view.asset),
            requestChallenge: async (request) =>
              GrantApprovalChallengeSchema.parse(
                await api.post('/v1/approvals/challenges', request),
              ),
          },
          webAuthn(p.label),
        );
        VerifiedApprovalSchema.parse(
          await api.post('/v1/approvals', {
            challengeId: signed.challenge.challengeId,
            grantSignature: signed.grantSignature,
            attestationSignature: signed.attestationSignature,
          }),
        );
      }
      const quorum = QuorumViewSchema.parse(
        await api.get(`/v1/approvals/${draft.digest}/verified`, true),
      );
      if (!quorum.satisfied) throw new Error('QUORUM_NOT_SATISFIED');
      return quorum.counted;
    };
    const requestDraft = async (request: {
      intent: unknown;
      risk: unknown;
      simulation: unknown;
    }): Promise<DraftOutcome> => {
      try {
        const body = await api.post<{
          status: string;
          code: string | null;
          intentId: string | null;
          pending: { draft: GrantDraft } | null;
        }>('/v1/intents', request, true);
        if (body.status === 'PENDING_APPROVAL' && body.pending)
          return {
            status: 'PENDING_APPROVAL',
            code: body.code ?? 'MISSING_QUORUM',
            draft: body.pending.draft,
          };
        throw new Error(`UNEXPECTED_INTENT_STATUS:${body.status}`);
      } catch (error) {
        if (error instanceof ApiCallError && error.rejectionCode)
          return { status: 'REJECTED', code: error.rejectionCode };
        throw error;
      }
    };
    const current = { mandate };
    const vertical = transferVertical({
      client,
      network: PROFILE.network,
      kernel,
      plugins,
      pluginId: PLUGIN_ID,
      calldatas,
      mandate: () => current.mandate,
      module: deployment.module,
      token: ausd.address,
      account: group.account,
      recipient,
      executor: deployer,
      workerId: WORKER_ID,
      localAssets: [],
      sync,
      now: () => clock.t,
      intentPrefix: `testnet_${runId.slice(-6)}`,
      evidenceSource: 'monad-testnet-rpc-transfer',
      gasLimitPercent: 125n,
      approve: approveViaApi,
      requestDraft,
      confirmations: PROFILE.confirmationDepth,
      journalKey,
    });
    const grantOf = (
      d: AuthorizationDecision | DraftOutcome,
    ): ExecutionGrant => {
      if (d.status !== 'AUTHORIZED')
        throw new Error(
          `EXPECTED_GRANT:${d.status}:${'code' in d ? d.code : ''}`,
        );
      return d.grant;
    };

    // Positive path: 1.5 AUSD transfer through API -> Kernel -> 2 Mera approvals -> worker.
    const safeBefore = await chain.balanceOf(group.account);
    const recipientBefore = await chain.balanceOf(recipient);
    const main = await vertical.authorize(UNITS.transfer, '1');
    const grant = grantOf(main.decision);
    log(
      `grant ${grant.grantId} authorized with ${grant.approvals.length} Mera approvals`,
    );
    const executed = await vertical.execute(
      grant,
      main.intent,
      main.data,
      journalDirectory,
    );
    reorg = new ReorgReconciler(executed.broadcaster, signals, CHAIN_ID);
    chain.transactions.push({
      step: 'ExecutionModule.execute (worker, 1.5 AUSD)',
      hash: executed.transactionHash,
      blockNumber: String(executed.receipt.blockNumber),
      gasUsed: String(executed.receipt.gasUsed),
      gasLimit: String(executed.gasLimit),
      effectiveGasPrice: String(executed.receipt.effectiveGasPrice),
      explorer: `${EXPLORER_TX}${executed.transactionHash}`,
    });
    log(
      `executed ${executed.transactionHash} in block ${executed.receipt.blockNumber}`,
    );

    await catchUp(executed.receipt.blockNumber);
    const state = await api.get<{
      snapshot: {
        indexedThroughBlock: number;
        group: {
          treasury: { asset: string; balance: string }[];
          mandates: { mandateId: string; spentToken: string }[];
          grantsExecuted: unknown[];
        };
      };
      freshness: unknown;
    }>(`/v1/groups/${group.chainGroupId}/state`);
    const indexedBlock = BigInt(state.snapshot.indexedThroughBlock);
    const chainSafeBalance = await chain.balanceOf(group.account, indexedBlock);
    const mandateState = await client.readContract({
      address: deployment.registry,
      abi: registryAbi,
      functionName: 'mandateState',
      args: [group.account, onchainId],
      blockNumber: indexedBlock,
    });
    const apiBalance =
      state.snapshot.group.treasury.find(
        (t) => t.asset === ausd.address.toLowerCase(),
      )?.balance ?? null;
    const apiSpent =
      state.snapshot.group.mandates.find((m) => m.mandateId === onchainId)
        ?.spentToken ?? null;
    const direct = await new RpcDirectVerifier(
      client,
      settings.projection,
      reader,
    ).verifyIndexed(group.chainGroupId);
    const positive = {
      transferAmount: formatDecimal(UNITS.transfer, ausd.decimals),
      grantId: grant.grantId,
      intentHash: grant.intentHash,
      draftDigest: grant.draft.digest,
      onchainDigest: main.onchainDigest,
      approvals: grant.approvals.map((a) => ({
        signer: a.signer,
        memberId: a.memberId,
        principalKind: a.principalKind,
      })),
      transactionHash: executed.transactionHash,
      explorer: `${EXPLORER_TX}${executed.transactionHash}`,
      observation: executed.observation,
      journalState: executed.journal.state,
      kernelGrantState: kernel.grantState(grant.grantId).state,
      lifecycle: kernel.lifecycle(grant.intentId).map((t) => t.to),
      balances: {
        safeBefore: String(safeBefore),
        safeAfter: String(await chain.balanceOf(group.account)),
        recipientBefore: String(recipientBefore),
        recipientAfter: String(await chain.balanceOf(recipient)),
      },
      readModel: {
        indexedThroughBlock: state.snapshot.indexedThroughBlock,
        apiTreasuryBalance: apiBalance,
        chainBalanceAtIndexedBlock: String(chainSafeBalance),
        balanceMatches: apiBalance === String(chainSafeBalance),
        apiSpentToken: apiSpent,
        chainSpentTokenAtIndexedBlock: String(mandateState.spentToken),
        spendMatches: apiSpent === String(mandateState.spentToken),
        grantsExecutedIndexed: state.snapshot.group.grantsExecuted.length,
        freshness: state.freshness,
        directVerifier: {
          consistent: direct.consistent,
          checkedAtBlock: direct.checkedAtBlock,
          targets: direct.observations.map((o) => ({
            kind: o.target.kind,
            matches: o.matches,
          })),
        },
      },
    };
    evidence.positive = positive;
    if (
      !positive.readModel.balanceMatches ||
      !positive.readModel.spendMatches ||
      !direct.consistent ||
      executed.observation.event?.tokenAmount !== String(UNITS.transfer)
    )
      throw new Error('READ_MODEL_OR_RECONCILIATION_MISMATCH');
    log(
      `read model == chain at block ${indexedBlock}: balance ${apiBalance}, spent ${apiSpent}`,
    );

    // Negative E2E-007 and quorum checks.
    const quorumProbe = await vertical.authorize(UNITS.probe, '2');
    const probeGrant = grantOf(quorumProbe.decision);
    const firstApproval = probeGrant.approvals[0]!;
    const oneOfThree = await vertical.onchainRevert(
      probeGrant,
      quorumProbe.data,
      firstApproval.signature,
    );
    const fullQuorumWhileActive = await vertical.onchainRevert(
      probeGrant,
      quorumProbe.data,
      packSafeSignatures(probeGrant.approvals, probeGrant.draft),
    );
    log(
      `1-of-3 simulation: ${oneOfThree}; 2-of-3 simulation: ${fullQuorumWhileActive ?? 'would succeed'}`,
    );

    const pauseReceipt = await gov.pause();
    await catchUp(pauseReceipt.blockNumber);
    const whilePaused = await vertical.authorize(UNITS.probe, '3');
    const pausedRevert = await vertical.onchainRevert(
      probeGrant,
      quorumProbe.data,
    );
    const unpauseReceipt = await gov.unpause();
    await catchUp(unpauseReceipt.blockNumber);
    log(
      `pause: kernel=${'code' in whilePaused.decision ? whilePaused.decision.code : whilePaused.decision.status} onchain=${pausedRevert}`,
    );

    const beforeSupersede = await vertical.authorize(UNITS.probe, '4');
    const supersededGrant = grantOf(beforeSupersede.decision);
    const v2 = MandateSchema.parse({
      ...mandate,
      version: 2,
      perActionCap: String(UNITS.perActionCap - 1_000_000n),
    });
    const supersedeReceipt = await gov.supersedeMandate(
      onchainId,
      2n,
      toMandateConfig(v2),
      true,
    );
    kernel.supersedeMandate(v2, { securitySensitive: true });
    current.mandate = v2;
    await catchUp(supersedeReceipt.blockNumber);
    await sync();
    let supersededKernel = 'ACCEPTED';
    try {
      kernel.verify(supersededGrant, beforeSupersede.intent);
    } catch (error) {
      supersededKernel = errorCode(error);
    }
    const supersededOnchain = await vertical.onchainRevert(
      supersededGrant,
      beforeSupersede.data,
    );
    const oldVersionDraft = await vertical.authorize(UNITS.probe, '7', 1);
    log(`supersede: kernel=${supersededKernel} onchain=${supersededOnchain}`);

    const beforeRevoke = await vertical.authorize(UNITS.probe, '5', 2);
    const revokedGrant = grantOf(beforeRevoke.decision);
    const revokeReceipt = await gov.revokeMandate(onchainId);
    kernel.revokeMandate(v2.groupId, v2.mandateId);
    await catchUp(revokeReceipt.blockNumber);
    await sync();
    let revokedKernel = 'ACCEPTED';
    try {
      kernel.verify(revokedGrant, beforeRevoke.intent);
    } catch (error) {
      revokedKernel = errorCode(error);
    }
    const revokedOnchain = await vertical.onchainRevert(
      revokedGrant,
      beforeRevoke.data,
    );
    const afterRevoke = await vertical.authorize(UNITS.probe, '6', 2);
    log(`revoke: kernel=${revokedKernel} onchain=${revokedOnchain}`);

    const codeOf = (d: AuthorizationDecision | DraftOutcome) =>
      d.status === 'AUTHORIZED' ? 'AUTHORIZED' : d.code;
    const negative = {
      quorum: {
        oneOfThreeSignatureSimulation: oneOfThree,
        twoOfThreeSimulationWhileActive: fullQuorumWhileActive,
      },
      pause: {
        kernelViaApi: codeOf(whilePaused.decision),
        onchainSimulation: pausedRevert,
        pauseTx: pauseReceipt.transactionHash,
        unpauseTx: unpauseReceipt.transactionHash,
      },
      supersede: {
        kernelVerifyOldGrant: supersededKernel,
        onchainSimulationOldGrant: supersededOnchain,
        newDraftAtOldVersion: codeOf(oldVersionDraft.decision),
        supersedeTx: supersedeReceipt.transactionHash,
      },
      revoke: {
        kernelVerifyGrant: revokedKernel,
        onchainSimulation: revokedOnchain,
        newIntentAfterRevoke: codeOf(afterRevoke.decision),
        revokeTx: revokeReceipt.transactionHash,
      },
    };
    evidence.negative = negative;
    const blocked =
      oneOfThree !== null &&
      fullQuorumWhileActive === null &&
      negative.pause.kernelViaApi !== 'AUTHORIZED' &&
      pausedRevert !== null &&
      supersededKernel !== 'ACCEPTED' &&
      supersededOnchain !== null &&
      negative.supersede.newDraftAtOldVersion !== 'AUTHORIZED' &&
      revokedKernel !== 'ACCEPTED' &&
      revokedOnchain !== null &&
      negative.revoke.newIntentAfterRevoke !== 'AUTHORIZED';
    if (!blocked) throw new Error('NEGATIVE_SCENARIO_NOT_BLOCKED');

    await catchUp();
    const finalState = await api.get(`/v1/groups/${group.chainGroupId}/state`);
    const monAfter = await client.getBalance({ address: deployer.address });
    evidence.finalReadModel = finalState;
    evidence.world = await api.get('/v1/world');
    evidence.indexer = {
      envioSchema,
      projectionSchema: rmSchema,
      startBlock: settings.projection.startBlock,
      progressBlock: await envio.progress(pool, CHAIN_ID),
      dataSource:
        'Envio RPC sync against the registry RPC (no HyperSync token)',
    };
    evidence.kernel = {
      auditRecords: kernel.auditLog().length,
      accounting: kernel.accounting(mandate.groupId, mandate.mandateId),
      submissionRecordedBeforeBroadcast: true,
      nonceStatusReader: 'RpcNonceStatusReader',
      auditKey: 'file outside repository (SYNQ_KERNEL_AUDIT_KEY_FILE)',
      journalKey: 'file outside repository (SYNQ_JOURNAL_KEY_FILE)',
    };
    evidence.deployer = {
      address: deployer.address,
      monBefore: String(monBefore),
      monAfter: String(monAfter),
      monSpent: String(monBefore - monAfter),
      ausdBefore: String(ausdBefore),
      ausdAfter: String(await chain.balanceOf(deployer.address)),
    };
    evidence.deployment = deployment;
    evidence.asset = ausd;
    evidence.completedAt = new Date().toISOString();
    evidence.result = 'PASS';
    if (monBefore - monAfter > MAX_MON_SPEND)
      throw new TestnetChainError('BUDGET_EXCEEDED');
    log(`PASS; MON spent ${formatDecimal(monBefore - monAfter, 18)}`);
    return evidence;
  } catch (error) {
    evidence.result = 'FAIL';
    evidence.error = { code: errorCode(error), message: String(error) };
    log(`FAIL ${errorCode(error)}: ${String(error)}`);
    throw error;
  } finally {
    writeFileSync(
      join(evidenceDirectory, `${runId}.json`),
      JSON.stringify(
        evidence,
        (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
        2,
      ) + '\n',
    );
    for (const c of closers.splice(0).reverse())
      await c().catch(() => undefined);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const evidence = await runTestnetE2E();
  console.log(
    JSON.stringify(
      {
        runId: evidence.runId,
        result: evidence.result,
        transactions: evidence.transactions,
      },
      null,
      2,
    ),
  );
}
