import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  parseEventLogs,
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
  type ExecutionGrant,
  type Mandate,
} from '@synq/schemas';
import { artifactHash, onchainMandateId, toMandateConfig } from '@synq/kernel';
import {
  ChainHeadObserver,
  EnvioPostgresSource,
  ProjectionReader,
  Projector,
  buildTreasuryView,
  indexedContributions,
  registerMandateArtifacts,
  syncToTarget,
  type TreasuryAssetRef,
  type TreasuryView,
} from '@synq/read-model';
import { PostgresProjectionStore } from '@synq/read-model/storage';
import { loadJournalKey, loadKernelAuditKey } from '@synq/execution-worker';
import { tokenAbi } from '@synq/execution-worker/abi';
import { formatDecimal } from '@synq/domain';
import { PostgresIdentityStore } from '@synq/identity';
import { grantPreview } from '@synq/identity/grant';
import {
  approveGrantWithMera,
  signMeraIdentityChallenge,
  signMeraSafeTransaction,
  signMeraSendAccess,
  signMeraSendConfirmation,
  signMeraTransaction,
  SendAccessChallengeSchema,
} from '@synq/identity/mera-browser';
import { PluginRegistry } from '@synq/plugin-sdk';
import {
  DirectMonadAusdAdapter,
  FundingRouter,
  PostgresFundingSessionStore,
  PostgresSendStore,
  PENDING_FUNDING_STATES,
  createFundingActivities,
  labelEvidenceHex,
  tokenRefOf,
  type SendPreview,
  type SendRecord,
} from '@synq/funding';
import { assetForRole } from '@synq/chain-registry';
import { createV1Api } from '@synq/api/v1';
import {
  createIntentKernel,
  identityPorts,
  kernelStateFromReadModel,
} from '@synq/api/kernel-runtime';
import { readModelRoutes } from '@synq/api/read-model-routes';
import { confirmationOf, type SendProposal } from '@synq/api/send-routes';
import { registerProductionSend } from '@synq/api/v1-server';
import { productionSendPorts } from '@synq/api/send-runtime';
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
  errorCode,
} from './testnet-config.js';
import { enrollPrincipals } from './testnet-enrollment.js';

/** Hard cap on this runner's MON spend (gas + member gas top-up). */
export const MAX_SEND_RUN_MON = 300_000_000_000_000_000n;
export const SEND_UNITS = {
  memberAusd: 3_000_000n,
  memberMon: 30_000_000_000_000_000n,
  contribution: 3_000_000n,
  send: 1_000_000n,
  perActionCap: 2_000_000n,
  reviewMax: 500_000n,
  cumulativeBudget: 10_000_000n,
  overCap: '3',
};
const MANDATE_ID = 'synq_send';

export type SendRunOptions = {
  databaseUrl?: string;
  evidenceDirectory?: string;
  workDirectory?: string;
  authenticatorStore?: string;
  executionMode?: 'REAL_TESTNET' | 'SIMULATION';
};

function sendMandate(input: {
  chainGroupId: Hex;
  account: Address;
  executor: Address;
  recipients: {
    address: Address;
    purpose: 'COUNTERPARTY' | 'MEMBER_WITHDRAWAL';
  }[];
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
    recipients: input.recipients,
    inputAsset: input.asset,
    outputAssets: [],
    perActionCap: String(SEND_UNITS.perActionCap),
    cumulativeBudget: String(SEND_UNITS.cumulativeBudget),
    maxNativeValue: '0',
    cumulativeNativeBudget: '0',
    maxSlippageBps: 0,
    maxReferenceDeviationBps: 0,
    maxLeverageBps: 0,
    maxAllocationBps: 10_000,
    tierPolicy: {
      tokenSpend: { autoMax: '0', reviewMax: String(SEND_UNITS.reviewMax) },
      nativeSpend: { autoMax: '0', reviewMax: '0' },
      actionFloors: [],
      newOutputAsset: 'CONSENSUS',
      leverage: 'BLOCKED',
      withdrawal: 'CONSENSUS',
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSendE2E(options: SendRunOptions = {}) {
  const runId = `${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}Z-${randomBytes(3).toString('hex')}`;
  const executionMode = options.executionMode ?? 'REAL_TESTNET';
  const evidenceDirectory = resolve(
    options.evidenceDirectory ?? 'reports/evidence/synq-send',
  );
  const workDirectory = resolve(
    options.workDirectory ?? join('artifacts/synq-send', runId),
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
    kind: 'synq-send',
    runId,
    executionMode,
    startedAt: new Date().toISOString(),
    profile: PROFILE.network.profile,
    chainId: CHAIN_ID,
    identityEvidenceTier: SOFTWARE_PRF_TIER,
    realPasskeyEvidence: 'REAL_PASSKEY_EVIDENCE_PENDING',
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
    if (monBefore < MAX_SEND_RUN_MON)
      throw new TestnetChainError('INSUFFICIENT_FUNDS', 'MON');
    if (ausdBefore < SEND_UNITS.memberAusd)
      throw new TestnetChainError('INSUFFICIENT_FUNDS', 'AUSD');
    const spent = async () =>
      monBefore - (await client.getBalance({ address: deployer.address }));
    const budget = async (step: string) => {
      const used = await spent();
      if (used > MAX_SEND_RUN_MON)
        throw new TestnetChainError(
          'BUDGET_EXCEEDED',
          `${step}: ${formatDecimal(used, 18)} MON`,
        );
    };

    const dbUrl =
      options.databaseUrl ??
      process.env.SYNQ_P08_E2E_DATABASE_URL ??
      'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_e2e';
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
    const authenticators = new SoftwareAuthenticatorStore(
      options.authenticatorStore,
    );
    const webAuthn = (label: string) => ({
      webAuthnClient: authenticators.client(label),
    });
    const identityConfig = {
      profile: PROFILE.network.profile,
      rpId: RP.rpId,
      origin: RP.origin,
    };
    const late: {
      kernel: ReturnType<typeof createIntentKernel> | null;
    } = { kernel: null };
    type Extra = (app: ReturnType<typeof createV1Api>) => Promise<void>;
    const startApi = async (extra?: Extra) => {
      const app = createV1Api({
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
      if (extra) await extra(app);
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

    const principals = await enrollPrincipals({
      api,
      authenticators,
      webAuthn,
      log,
    });
    const byLabel = (l: string) => principals.find((p) => p.label === l)!;
    const alice = byLabel('alice');
    const bob = byLabel('bob');
    const carol = byLabel('carol');
    const owners: OwnerSigner[] = principals.map((p) => ({
      address: p.record.signer,
      label: p.label,
      signSafeTransaction: (tx) =>
        signMeraSafeTransaction(p.record, tx, webAuthn(p.label)),
    }));
    const memberId = (label: string) =>
      `member_${principals.findIndex((p) => p.label === label)}`;
    const contact = authenticators.recipient();
    evidence.principals = principals.map((p) => ({
      label: p.label,
      memberId: memberId(p.label),
      principalId: p.record.principalId,
      signer: p.record.signer,
      kind: 'MERA_HUMAN',
    }));

    const salt = keccak256(stringToHex(`synq.send.${runId}`));
    const group = await chain.createGroup(
      owners.map((o) => o.address),
      salt,
    );
    log(
      `group ${group.chainGroupId} Safe ${group.account} at block ${group.blockNumber}`,
    );
    evidence.group = {
      chainGroupId: group.chainGroupId,
      safe: group.account,
      threshold: 2,
      owners: owners.map((o) => o.address),
      creationBlock: String(group.blockNumber),
    };
    await budget('createGroup');

    const settings = registryDeploymentSettings(PROFILE.network.profile, {
      startBlock: Number(group.blockNumber),
    });
    const envioSchema = `envio_p08_${runId.slice(-6)}`;
    const rmSchema = `rm_p08_${runId.slice(-6)}`;
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
    for (const p of principals) {
      const challenge = IdentityChallengeSchema.parse(
        await api.post(
          `/v1/groups/${group.chainGroupId}/membership-challenges`,
          { memberId: memberId(p.label), principalId: p.record.principalId },
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
    log('identity group bound; memberships proven with Mera passkeys');

    const latest = await client.getBlock();
    const mandate = sendMandate({
      chainGroupId: group.chainGroupId,
      account: group.account,
      executor: deployer.address,
      recipients: [
        {
          address: carol.record.signer.toLowerCase() as Address,
          purpose: 'MEMBER_WITHDRAWAL',
        },
        { address: contact, purpose: 'COUNTERPARTY' },
      ],
      asset: ausd,
      members: principals.map((p) => ({
        memberId: memberId(p.label),
        signer: p.record.signer.toLowerCase() as Address,
      })),
      now: Number(latest.timestamp),
    });
    const onchainId = onchainMandateId(mandate);
    const gov = chain.governance(group.account, owners);
    await gov.setExecutor(deployer.address, true);
    await gov.configureMandate(onchainId, toMandateConfig(mandate));
    log('executor set and Synq Send mandate configured by 2 Mera owners');
    await budget('governance');

    // Read model.
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
    const catchUp = async (block?: bigint) => {
      const target = Number(
        block ?? (await client.getBlockNumber({ cacheTime: 0 })),
      );
      await envio.waitFor(pool, CHAIN_ID, target, 900_000);
      await syncToTarget(source, projector);
    };

    // B08.3: direct AUSD contribution from a Mera member wallet.
    const coreAsset: TreasuryAssetRef = {
      canonicalAssetId: ausd.canonicalAssetId,
      chainId: ausd.chainId,
      address: ausd.address.toLowerCase() as Address,
      symbol: ausd.symbol,
      decimals: ausd.decimals,
    };
    const funding = new PostgresFundingSessionStore(pool);
    await funding.migrate();
    const contributor = bob.record.signer as Address;
    const fundingActs = createFundingActivities({
      router: new FundingRouter({ adapters: [new DirectMonadAusdAdapter()] }),
      store: funding,
      destination: {
        find: async (s) => contributionReceipt.get(s.sessionId) ?? null,
      },
      indexed: {
        indexed: async (r) => {
          const seen = await indexedContributions(
            projectionStore,
            settings.projection,
            group.account,
            ausd.address,
          );
          return {
            indexedThroughBlock: seen.indexedThroughBlock,
            eventPresent: seen.contributions.some(
              (c) =>
                c.transactionHash === r.transactionHash &&
                c.logIndex === r.logIndex,
            ),
          };
        },
      },
    });
    const contributionReceipt = new Map<
      string,
      Awaited<ReturnType<typeof readContributionLog>>
    >();
    async function readContributionLog(hash: Hex) {
      const receipt = await client.getTransactionReceipt({ hash });
      const [log0] = parseEventLogs({
        abi: tokenAbi,
        eventName: 'Transfer',
        logs: receipt.logs.filter(
          (l) => l.address.toLowerCase() === ausd.address.toLowerCase(),
        ),
      });
      if (
        !log0 ||
        log0.args.from.toLowerCase() !== contributor.toLowerCase() ||
        log0.args.to.toLowerCase() !== group.account.toLowerCase()
      )
        throw new Error('CONTRIBUTION_LOG_MISSING');
      return {
        chainId: CHAIN_ID,
        token: ausd.address.toLowerCase() as Address,
        from: log0.args.from.toLowerCase() as Address,
        to: (log0.args.to as Address).toLowerCase() as Address,
        amount: String(log0.args.value),
        transactionHash: hash,
        logIndex: log0.logIndex,
        blockNumber: Number(receipt.blockNumber),
      };
    }

    const memberMonBefore = await client.getBalance({ address: contributor });
    if (memberMonBefore < SEND_UNITS.memberMon / 2n) {
      const wallet = createWalletClient({
        chain: monadTestnet,
        account: deployer,
        transport: http(testnetRpcUrl()),
      });
      const hash = await wallet.sendTransaction({
        to: contributor,
        value: SEND_UNITS.memberMon,
        gas: 21_000n,
      });
      const r = await client.waitForTransactionReceipt({
        hash,
        confirmations: PROFILE.confirmationDepth,
      });
      chain.transactions.push({
        step: 'MON gas top-up (deployer -> member bob)',
        hash,
        blockNumber: String(r.blockNumber),
        gasUsed: String(r.gasUsed),
        gasLimit: '21000',
        effectiveGasPrice: String(r.effectiveGasPrice),
        explorer: `${EXPLORER_TX}${hash}`,
      });
    }
    if ((await chain.balanceOf(contributor)) < SEND_UNITS.contribution)
      await chain.fund(contributor, SEND_UNITS.memberAusd);
    const lastFund = chain.transactions.at(-1);
    if (lastFund?.step.startsWith('AUSD.transfer(deployer -> Safe)'))
      lastFund.step = 'AUSD.transfer(deployer -> member bob wallet)';
    await budget('member top-up');

    const plan = await fundingActs.planRoute({
      requestId: `contrib-${runId}`,
      groupId: group.chainGroupId,
      destination: {
        chainId: CHAIN_ID,
        account: group.account,
        token: tokenRefOf(ausd),
      },
      source: {
        token: tokenRefOf(ausd),
        amount: String(SEND_UNITS.contribution),
        sender: contributor,
        refundTo: contributor,
      },
      maxSlippageBps: 0,
      now: Math.floor(Date.now() / 1000),
    });
    const session0 = await fundingActs.openFromPlan({
      groupId: group.chainGroupId,
      plan,
      now: Math.floor(Date.now() / 1000),
    });
    await fundingActs.authorize(
      session0.sessionId,
      Math.floor(Date.now() / 1000),
    );
    const contributionData = encodeFunctionData({
      abi: tokenAbi,
      functionName: 'transfer',
      args: [group.account, SEND_UNITS.contribution],
    });
    const [fees, gas, nonce] = await Promise.all([
      client.estimateFeesPerGas(),
      client.estimateGas({
        account: contributor,
        to: ausd.address,
        data: contributionData,
      }),
      client.getTransactionCount({ address: contributor, blockTag: 'pending' }),
    ]);
    const raw = await signMeraTransaction(
      bob.record,
      {
        chainId: CHAIN_ID,
        to: ausd.address,
        data: contributionData,
        value: 0n,
        nonce,
        gas: (gas * 125n) / 100n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      },
      webAuthn('bob'),
    );
    const contributionSubmittedAt = Date.now();
    const contributionHash = await client.sendRawTransaction({
      serializedTransaction: raw,
    });
    const cr = await client.waitForTransactionReceipt({
      hash: contributionHash,
      confirmations: PROFILE.confirmationDepth,
    });
    const contributionConfirmedAt = Date.now();
    if (cr.status !== 'success')
      throw new TestnetChainError('TX_REVERTED', 'member contribution');
    chain.transactions.push({
      step: 'AUSD.transfer(member bob Mera wallet -> group Safe) [contribution]',
      hash: contributionHash,
      blockNumber: String(cr.blockNumber),
      gasUsed: String(cr.gasUsed),
      gasLimit: String((gas * 125n) / 100n),
      effectiveGasPrice: String(cr.effectiveGasPrice),
      explorer: `${EXPLORER_TX}${contributionHash}`,
    });
    await fundingActs.recordSource(
      session0.sessionId,
      await readContributionLog(contributionHash),
      Math.floor(Date.now() / 1000),
    );
    contributionReceipt.set(
      session0.sessionId,
      await readContributionLog(contributionHash),
    );
    await fundingActs.observeDestination(
      session0.sessionId,
      Math.floor(Date.now() / 1000),
    );
    const beforeIndex = await fundingActs.confirmIndexed(
      session0.sessionId,
      Math.floor(Date.now() / 1000),
    );
    log(
      `member contribution ${contributionHash} block ${cr.blockNumber}; funding session ${beforeIndex.state}`,
    );
    const t0 = Date.now();
    await catchUp(cr.blockNumber);
    const contributionIndexedAt = Date.now();
    log(
      `Envio + projection caught up in ${Math.round((contributionIndexedAt - t0) / 1000)}s`,
    );
    await fundingActs.confirmIndexed(
      session0.sessionId,
      Math.floor(Date.now() / 1000),
    );
    const credited = await fundingActs.credit(
      session0.sessionId,
      Math.floor(Date.now() / 1000),
    );

    const sendStore = new PostgresSendStore(pool);
    await sendStore.migrate();
    const usdc = assetForRole(PROFILE, 'web2SettlementAsset');
    const treasuryView = async (): Promise<TreasuryView | null> => {
      const snapshot = await reader.groupSnapshot(group.chainGroupId);
      if (!snapshot) return null;
      const { contributions } = await indexedContributions(
        projectionStore,
        settings.projection,
        group.account,
        ausd.address,
      );
      const reserved = late.kernel
        ? BigInt(
            late.kernel.accounting(mandate.groupId, mandate.mandateId)
              .reservedToken,
          )
        : 0n;
      const pendingSends = await pendingSendDebits();
      const block = BigInt(snapshot.indexedThroughBlock);
      const [gasBalance, usdcBalance] = await Promise.all([
        client.getBalance({ address: group.account, blockNumber: block }),
        client.readContract({
          address: usdc.address,
          abi: tokenAbi,
          functionName: 'balanceOf',
          args: [group.account],
          blockNumber: block,
        }),
      ]);
      const sessions = await funding.list(group.chainGroupId);
      return buildTreasuryView({
        snapshot,
        coreAsset,
        contributions,
        reserved: reserved
          ? [
              {
                asset: coreAsset,
                amount: reserved,
                provenance: 'KERNEL',
                asOfBlock: null,
                label: 'Kernel outstanding grants',
              },
            ]
          : [],
        pendingDebits: pendingSends.map((r) => ({
          asset: coreAsset,
          amount: BigInt(r.preview.amount),
          provenance: 'POSTGRES' as const,
          asOfBlock: null,
          label: `Synq Send ${r.sendId} executed, awaiting index`,
        })),
        pendingFunding: sessions
          .filter((s) => PENDING_FUNDING_STATES.includes(s.state))
          .map((s) => ({
            sessionId: s.sessionId,
            state: s.state,
            route: s.route,
            asset: coreAsset,
            amount: BigInt(s.quote.minAmountOut),
          })),
        settlementBuffer: {
          asset: {
            canonicalAssetId: usdc.canonicalAssetId,
            chainId: usdc.chainId,
            address: usdc.address.toLowerCase() as Address,
            symbol: usdc.symbol,
            decimals: usdc.decimals,
          },
          amount: usdcBalance,
          provenance: 'CHAIN',
          asOfBlock: snapshot.indexedThroughBlock,
          label:
            'USDC settlement buffer (not indexed; RPC read at indexed block)',
        },
        gasBuffer: {
          asset: {
            canonicalAssetId: `eip155:${CHAIN_ID}/native`,
            chainId: CHAIN_ID,
            address: 'native',
            symbol: 'MON',
            decimals: 18,
          },
          amount: gasBalance,
          provenance: 'CHAIN',
          asOfBlock: snapshot.indexedThroughBlock,
          label: 'Safe MON gas buffer',
        },
        strategyPositions: [],
        externalCollateral: [],
      });
    };
    const pendingSendDebits = async (): Promise<SendRecord[]> =>
      sentIds.length
        ? (await Promise.all(sentIds.map((id) => sendStore.get(id)))).filter(
            (r): r is SendRecord => r?.state === 'CONFIRMED',
          )
        : [];
    const sentIds: string[] = [];

    const afterContribution = (await treasuryView())!;
    const chainSafeAtIndexed = await chain.balanceOf(
      group.account,
      BigInt(afterContribution.indexedThroughBlock),
    );
    // Replay: re-apply the indexed window containing the contribution.
    const replayEvents = (
      await projectionStore.read((s) =>
        s.journalRange(Number(cr.blockNumber) - 1, Number(cr.blockNumber)),
      )
    ).map((x) => x.event);
    const replay = await projector.applyWindow({
      fromBlockExclusive: Number(cr.blockNumber) - 1,
      toBlockInclusive: Number(cr.blockNumber),
      events: replayEvents,
    });
    const afterReplay = (await treasuryView())!;
    evidence.contribution = {
      executionMode,
      route: plan.selected,
      member: { label: 'bob', memberId: memberId('bob'), wallet: contributor },
      transactionHash: contributionHash,
      explorer: `${EXPLORER_TX}${contributionHash}`,
      blockNumber: String(cr.blockNumber),
      amount: String(SEND_UNITS.contribution),
      fundingSession: {
        sessionId: credited.sessionId,
        finalState: credited.state,
        transitions: credited.history.map((h) => h.to),
        creditId: credited.creditId,
        creditedAmount: credited.creditedAmount,
        stateBeforeIndexing: beforeIndex.state,
      },
      latencyMs: {
        submitToConfirmed: contributionConfirmedAt - contributionSubmittedAt,
        submitToIndexed: contributionIndexedAt - contributionSubmittedAt,
      },
      treasury: {
        indexedThroughBlock: afterContribution.indexedThroughBlock,
        core: afterContribution.core,
        contributions: afterContribution.contributions,
        chainSafeBalanceAtIndexedBlock: String(chainSafeAtIndexed),
        balanceMatchesChain:
          afterContribution.core.balance === String(chainSafeAtIndexed),
      },
      replay: {
        replayedEvents: replayEvents.length,
        appended: replay.appended,
        duplicates: replay.duplicates,
        balanceAfterReplay: afterReplay.core.balance,
        contributionsAfterReplay: afterReplay.contributions.count,
        noDoubleCredit:
          afterReplay.core.balance === afterContribution.core.balance &&
          afterReplay.contributions.count ===
            afterContribution.contributions.count,
      },
    };
    if (
      afterContribution.core.balance !== String(chainSafeAtIndexed) ||
      afterContribution.contributions.count !== 1 ||
      afterReplay.contributions.count !== 1 ||
      replay.appended !== 0 ||
      credited.state !== 'CREDITED'
    )
      throw new Error('CONTRIBUTION_ACCOUNTING_MISMATCH');
    log(
      `contribution credited once: free core ${afterContribution.core.free}; replay appended ${replay.appended}`,
    );

    // Kernel + plugin over the indexed read model.
    const clock = {
      t: Number(latest.timestamp),
      now() {
        return Math.floor(Date.now() / 1000);
      },
    };
    const sync = async () => {
      const block = await client.getBlock({ blockTag: 'latest' });
      clock.t = Math.max(clock.t, Number(block.timestamp));
      return clock.t;
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
    await registerMandateArtifacts(projectionStore, [
      { mandateHash: artifactHash(mandate), artifact: mandate },
    ]);
    const head = new ChainHeadObserver(client, CHAIN_ID, { ttlMs: 0 });
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
      head,
      maxLagBlocks: settings.maxLagBlocks,
      auditKey: auditKey.bytes,
      plugins: [plugin.manifest],
      state: await kernelStateFromReadModel(reader),
    });
    late.kernel = kernel;
    const verticalFor = (recipient: Address) =>
      transferVertical({
        client,
        network: PROFILE.network,
        kernel,
        plugins,
        pluginId: PLUGIN_ID,
        calldatas,
        mandate: () => mandate,
        module: deployment.module,
        token: ausd.address,
        account: group.account,
        recipient,
        executor: deployer,
        workerId: WORKER_ID,
        localAssets: [],
        sync,
        now: () => clock.t,
        intentPrefix: `send_${runId.slice(-6)}`,
        evidenceSource: 'monad-testnet-rpc-transfer',
        gasLimitPercent: 125n,
        approve: async () => {
          throw new Error('approvals go through the Send API');
        },
        confirmations: PROFILE.confirmationDepth,
        journalKey,
      });
    await phase.app.close();
    const startProductionApi = () =>
      startApi(async (app) => {
        await app.register(readModelRoutes, {
          snapshots: reader,
          head: new ChainHeadObserver(client, CHAIN_ID, { ttlMs: 1000 }),
          maxLagBlocks: settings.maxLagBlocks,
        });
        await registerProductionSend({
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
              readModel: {
                reader,
                snapshots: reader,
                head: new ChainHeadObserver(client, CHAIN_ID, { ttlMs: 0 }),
                maxLagBlocks: settings.maxLagBlocks,
                projection: settings.projection,
                client,
                projectionStore,
                close: async () => undefined,
              },
            }),
        });
      });
    phase = await startProductionApi();
    api = phase.api;

    // B08.4 Synq Send through the API.
    const gid = group.chainGroupId;
    /** Member reads/previews use a Mera-signed session, never the admin token. */
    const memberSession = async (label: string) => {
      const p = byLabel(label);
      const challenge = SendAccessChallengeSchema.parse(
        await api.post('/v1/send/access/challenges', {
          groupId: gid,
          principalId: p.record.principalId,
        }),
      );
      const session = await api.post<{ token: string; memberId: string }>(
        '/v1/send/access',
        {
          challengeId: challenge.challengeId,
          signature: await signMeraSendAccess(
            p.record,
            challenge,
            webAuthn(label),
          ),
        },
      );
      if (session.memberId !== memberId(label))
        throw new Error('MEMBER_SESSION_MISMATCH');
      return { bearer: session.token };
    };
    let member = await memberSession('alice');
    const memberAccess: Record<string, unknown> = {
      scheme: 'Mera passkey-signed SendAccess challenge -> 300 s session',
      member: memberId('alice'),
    };
    try {
      await api.get(`/v1/send/${gid}/recipients`);
      throw new Error('ANONYMOUS_DIRECTORY_READ');
    } catch (error) {
      if (!(error instanceof ApiCallError) || error.status !== 401) throw error;
      memberAccess.anonymousDirectory = error.status;
    }
    const directoryView = await api.get<{
      recipients: { recipientId: string; address: string; sendable: boolean }[];
    }>(`/v1/send/${gid}/recipients`, member);
    const to = directoryView.recipients.find(
      (r) => r.address === carol.record.signer.toLowerCase(),
    )!;
    const negative: Record<string, unknown> = {};
    const expectApiError = async (
      label: string,
      run: () => Promise<unknown>,
      code: string,
    ) => {
      try {
        await run();
        throw new Error(`${label}: expected ${code}`);
      } catch (error) {
        if (!(error instanceof ApiCallError)) throw error;
        if (String(error.body.error) !== code)
          throw new Error(
            `${label}: got ${String(error.body.error)} want ${code}`,
          );
        negative[label] = { status: error.status, error: error.body.error };
      }
    };
    await expectApiError(
      'amountExceedsMandate',
      () =>
        api.post(
          '/v1/send/previews',
          {
            groupId: gid,
            recipientId: to.recipientId,
            amount: SEND_UNITS.overCap,
          },
          member,
        ),
      'AMOUNT_EXCEEDS_MANDATE',
    );
    const notAllowlisted = directoryView.recipients.find((r) => !r.sendable);
    if (notAllowlisted)
      await expectApiError(
        'recipientNotOnMandate',
        () =>
          api.post(
            '/v1/send/previews',
            {
              groupId: gid,
              recipientId: notAllowlisted.recipientId,
              amount: '1',
            },
            member,
          ),
        'RECIPIENT_UNKNOWN',
      );
    const preview = await api.post<SendPreview>(
      '/v1/send/previews',
      {
        groupId: gid,
        recipientId: to.recipientId,
        amount: formatDecimal(SEND_UNITS.send, ausd.decimals),
      },
      member,
    );
    log(
      `preview ${preview.previewId}: ${preview.amountDecimal} AUSD -> ${preview.recipient.address} chain ${preview.chainId} expires ${preview.expiresAt} tier ${preview.policy.tier} (${preview.policy.requiredApprovals} approvals); guard ${preview.guard.status}`,
    );
    const senderLabel = 'alice';
    const senderMember = memberId(senderLabel);
    const signature = await signMeraSendConfirmation(
      alice.record,
      confirmationOf({ preview }, senderMember),
      webAuthn(senderLabel),
    );
    const confirm = {
      previewId: preview.previewId,
      digest: preview.digest,
      recipientAddress: preview.recipient.address,
      amount: preview.amount,
      chainId: preview.chainId,
      sender: { memberId: senderMember, signature },
    };
    await expectApiError(
      'recipientMismatch',
      () =>
        api.post('/v1/send', {
          ...confirm,
          recipientAddress: contact,
        }),
      'RECIPIENT_MISMATCH',
    );
    await expectApiError(
      'forgedSender',
      () =>
        api.post('/v1/send', {
          ...confirm,
          sender: { memberId: memberId('bob'), signature },
        }),
      'SENDER_SIGNATURE_INVALID',
    );
    const proposed = await api.post<SendRecord>('/v1/send', confirm);
    const duplicate = await api.post<SendRecord>('/v1/send', confirm);
    negative.duplicateConfirmReturnsSameSend =
      duplicate.sendId === proposed.sendId &&
      duplicate.state === proposed.state;
    if (proposed.state !== 'PENDING_APPROVAL' || !proposed.intentHash)
      throw new Error(
        `SEND_NOT_PENDING:${proposed.state}:${proposed.kernelCode}`,
      );
    sentIds.push(proposed.sendId);
    log(
      `send ${proposed.sendId} PENDING_APPROVAL (${proposed.kernelCode}); intent ${proposed.intentHash}`,
    );

    const approve = async (label: string) => {
      const p = byLabel(label);
      const view = PendingIntentViewSchema.parse(
        await api.get(`/v1/intents/${proposed.intentHash}`),
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
      VerifiedApprovalSchema.parse(
        await api.post('/v1/approvals', {
          challengeId: signed.challenge.challengeId,
          grantSignature: signed.grantSignature,
          attestationSignature: signed.attestationSignature,
        }),
      );
    };
    await phase.app.close();
    phase = await startProductionApi();
    api = phase.api;
    // Member sessions are process-local: a restart forces a fresh passkey proof.
    try {
      await api.get(`/v1/send/${proposed.sendId}`, member);
      throw new Error('MEMBER_SESSION_SURVIVED_RESTART');
    } catch (error) {
      if (!(error instanceof ApiCallError) || error.status !== 401) throw error;
      memberAccess.sessionAfterRestart = error.status;
    }
    member = await memberSession('alice');
    const restoredSend = await api.get<SendRecord>(
      `/v1/send/${proposed.sendId}`,
      member,
    );
    if (
      restoredSend.state !== proposed.state ||
      restoredSend.draftDigest !== proposed.draftDigest
    )
      throw new Error('PRODUCTION_SEND_RESTART_MISMATCH');
    evidence.productionApi = {
      registration: 'apps/api/src/v1-server.ts:registerProductionSend',
      ports: 'apps/api/src/send-runtime.ts:productionSendPorts',
      stores: ['PostgresSendStore', 'PostgresFundingSessionStore'],
      restartRecoveredPendingApproval: true,
      memberAccess,
    };
    await approve('alice');
    const oneOfTwo = await api.post<{
      record: SendRecord;
      grant: ExecutionGrant | null;
    }>(`/v1/send/${proposed.sendId}/authorize`, {}, true);
    negative.quorumInsufficient = {
      state: oneOfTwo.record.state,
      kernelCode: oneOfTwo.record.kernelCode,
      grant: oneOfTwo.grant,
    };
    if (oneOfTwo.grant || oneOfTwo.record.state !== 'PENDING_APPROVAL')
      throw new Error('ONE_APPROVAL_MUST_NOT_AUTHORIZE');
    log(
      `1-of-2 approvals: still ${oneOfTwo.record.state} (${oneOfTwo.record.kernelCode})`,
    );
    await approve('bob');
    const authorized = await api.post<{
      record: SendRecord;
      grant: ExecutionGrant | null;
    }>(`/v1/send/${proposed.sendId}/authorize`, {}, true);
    if (!authorized.grant) throw new Error('SEND_NOT_AUTHORIZED');
    log(`grant ${authorized.grant.grantId} authorized with 2 Mera approvals`);

    const proposal = (
      await api.get<SendRecord>(`/v1/send/${proposed.sendId}`, true)
    ).proposal as SendProposal;
    const recipient = preview.recipient.address;
    const recipientBefore = await chain.balanceOf(recipient);
    const vertical = verticalFor(recipient);
    calldatas.set(keccak256(proposal.data), proposal.data);
    const submittedAt = Date.now();
    const executed = await vertical.execute(
      authorized.grant,
      proposal.intent as never,
      proposal.data,
      journalDirectory,
    );
    const confirmedAt = Date.now();
    const recipientAfter = await chain.balanceOf(recipient);
    chain.transactions.push({
      step: 'ExecutionModule.execute (Synq Send 1 AUSD -> member carol)',
      hash: executed.transactionHash,
      blockNumber: String(executed.receipt.blockNumber),
      gasUsed: String(executed.receipt.gasUsed),
      gasLimit: String(executed.gasLimit),
      effectiveGasPrice: String(executed.receipt.effectiveGasPrice),
      explorer: `${EXPLORER_TX}${executed.transactionHash}`,
    });
    await api.post(
      `/v1/send/${proposed.sendId}/execution`,
      {
        transactionHash: executed.transactionHash,
        blockNumber: String(executed.receipt.blockNumber),
        submittedAt,
        confirmedAt,
        recipientBalanceBefore: String(recipientBefore),
        recipientBalanceAfter: String(recipientAfter),
        explorer: `${EXPLORER_TX}${executed.transactionHash}`,
      },
      true,
    );
    const pendingView = (await treasuryView())!;
    log(
      `executed ${executed.transactionHash}; free while unindexed ${pendingView.core.free}`,
    );
    let indexed: SendRecord | null = null;
    const deadline = Date.now() + 900_000;
    while (Date.now() < deadline) {
      await catchUp(executed.receipt.blockNumber);
      const r = await api.post<SendRecord>(
        `/v1/send/${proposed.sendId}/reconcile`,
        {},
        true,
      );
      if (r.state === 'INDEXED') {
        indexed = r;
        break;
      }
      await sleep(1000);
    }
    if (!indexed?.receipt) throw new Error('SEND_NOT_INDEXED');
    member = await memberSession('alice');
    const finalView = await api.get<TreasuryView>(
      `/v1/groups/${gid}/treasury`,
      member,
    );
    const safeAtIndexed = await chain.balanceOf(
      group.account,
      BigInt(finalView.indexedThroughBlock),
    );
    evidence.send = {
      executionMode,
      sendId: indexed.sendId,
      sender: {
        label: senderLabel,
        memberId: senderMember,
        signer: alice.record.signer,
      },
      recipient: {
        label: 'carol',
        memberId: memberId('carol'),
        address: recipient,
      },
      preview: {
        previewId: preview.previewId,
        digest: preview.digest,
        amount: preview.amount,
        amountDecimal: preview.amountDecimal,
        asset: preview.asset,
        chainId: preview.chainId,
        expiresAt: preview.expiresAt,
        policy: preview.policy,
        guard: preview.guard,
      },
      kernel: {
        intentHash: indexed.intentHash,
        draftDigest: indexed.draftDigest,
        tier: indexed.kernelTier,
        grantId: indexed.grantId,
        approvals: authorized.grant.approvals.map((a) => ({
          signer: a.signer,
          memberId: a.memberId,
          principalKind: a.principalKind,
        })),
      },
      transactionHash: executed.transactionHash,
      explorer: `${EXPLORER_TX}${executed.transactionHash}`,
      receipt: indexed.receipt,
      history: indexed.history,
      negative,
      treasury: {
        freeWhileExecutedButUnindexed: pendingView.core.free,
        pendingDebitsWhileUnindexed: pendingView.core.pendingDebits,
        final: finalView.core,
        finalIndexedThroughBlock: finalView.indexedThroughBlock,
        chainSafeBalanceAtIndexedBlock: String(safeAtIndexed),
        balanceMatchesChain: finalView.core.balance === String(safeAtIndexed),
        buckets: finalView.buckets,
      },
    };
    if (
      indexed.receipt.recipientDelta !== String(SEND_UNITS.send) ||
      finalView.core.balance !== String(safeAtIndexed)
    )
      throw new Error('SEND_RECEIPT_MISMATCH');
    log(
      `INDEXED: recipient delta ${indexed.receipt.recipientDelta}; submit->confirmed ${indexed.receipt.latencyMs.submitToConfirmed}ms; submit->indexed ${indexed.receipt.latencyMs.submitToIndexed}ms`,
    );

    const monAfter = await client.getBalance({ address: deployer.address });
    evidence.deployer = {
      address: deployer.address,
      monBefore: String(monBefore),
      monAfter: String(monAfter),
      monSpent: String(monBefore - monAfter),
      ausdBefore: String(ausdBefore),
      ausdAfter: String(await chain.balanceOf(deployer.address)),
    };
    evidence.indexer = {
      envioSchema,
      projectionSchema: rmSchema,
      startBlock: settings.projection.startBlock,
      progressBlock: await envio.progress(pool, CHAIN_ID),
    };
    evidence.deployment = deployment;
    evidence.completedAt = new Date().toISOString();
    evidence.result = 'PASS';
    await budget('final');
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
      JSON.stringify(labelEvidenceHex(evidence), null, 2) + '\n',
    );
    for (const c of closers.splice(0).reverse())
      await c().catch(() => undefined);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const evidence = await runSendE2E({
    ...(process.env.SYNQ_SEND_EVIDENCE_DIR
      ? { evidenceDirectory: process.env.SYNQ_SEND_EVIDENCE_DIR }
      : {}),
    ...(process.env.SYNQ_SEND_EXECUTION_MODE === 'SIMULATION'
      ? { executionMode: 'SIMULATION' as const }
      : {}),
  });
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
