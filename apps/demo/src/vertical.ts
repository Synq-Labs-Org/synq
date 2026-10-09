import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  BoundActionIntentSchema,
  type Asset,
  type BoundActionIntent,
  type ExecutionGrant,
  type GrantDraft,
  type Mandate,
  type NetworkProfile,
  type RiskPacket,
  type VerifiedApproval,
} from '@synq/schemas';
import {
  artifactHash,
  economicIntentHash,
  intentHash,
  type Kernel,
} from '@synq/kernel';
import type { PluginRegistry } from '@synq/plugin-sdk';
import { isMutationEnabledChain } from '@synq/chain-registry';
import {
  ExecutionJournal,
  JournaledBroadcaster,
  chainGrant,
  observeGrantExecution,
  onchainGrantArgs,
  packSafeSignatures,
  prepareModuleCall,
  signGrantBoundTransaction,
  submitGrantTransaction,
  type IntegrityKey,
} from '@synq/execution-worker';
import { moduleAbi, registryAbi, tokenAbi } from '@synq/execution-worker/abi';

const ZERO_HASH = `0x${'0'.repeat(64)}` as const;

export class VerticalError extends Error {
  constructor(
    readonly code:
      | 'PLUGIN_UNHEALTHY'
      | 'EIP712_DIGEST_DIVERGES_FROM_MODULE'
      | 'SUBMISSION_AMBIGUOUS'
      | 'EXECUTION_REVERTED'
      | 'MAINNET_DISABLED',
    message: string = code,
  ) {
    super(message);
    this.name = 'VerticalError';
  }
}

/** Chain-facing facts one transfer vertical needs; local and testnet supply their own. */
export interface TransferVerticalContext {
  client: PublicClient;
  network: NetworkProfile;
  kernel: Kernel;
  plugins: PluginRegistry;
  pluginId: string;
  /** Calldata cache the plugin's `prepare` resolves calldata hashes from. */
  calldatas: Map<Hex, Hex>;
  mandate: () => Mandate;
  module: Address;
  token: Address;
  account: Address;
  recipient: Address;
  executor: PrivateKeyAccount;
  workerId: string;
  /** Assets the module grant encoder may accept beyond the official registry (local test tokens). */
  localAssets: readonly Asset[];
  /** Synchronises the vertical clock with chain time and returns it. */
  sync: () => Promise<number>;
  now: () => number;
  intentPrefix: string;
  evidenceSource: string;
  /** Gas limit = estimate × multiplier / 100. Monad charges the full limit, so testnet keeps it tight. */
  gasLimitPercent: bigint;
  /** Approves a pending draft with the given owner indexes and returns verified approvals. */
  approve: (
    draft: GrantDraft,
    indexes: readonly number[],
  ) => Promise<VerifiedApproval[]>;
  /** Receipt confirmations to wait for before reconciling (the profile confirmation depth). */
  confirmations?: number;
  /** Journal integrity key; non-local profiles must supply one from a file outside the journal. */
  journalKey?: IntegrityKey;
  /** Obtains the pending draft through another surface (e.g. the HTTP API) instead of the Kernel directly. */
  requestDraft?: (request: {
    intent: BoundActionIntent;
    risk: RiskPacket;
    simulation: TransferProposal['simulation'];
  }) => Promise<DraftOutcome>;
}

/** Draft request outcome from a surface other than the Kernel (e.g. `POST /v1/intents`). */
export type DraftOutcome =
  | { status: 'PENDING_APPROVAL'; code: string; draft: GrantDraft | null }
  | { status: 'REJECTED'; code: string };

export type TransferProposal = {
  intent: BoundActionIntent;
  risk: RiskPacket;
  simulation: Awaited<
    ReturnType<ReturnType<PluginRegistry['getMutator']>['simulate']>
  >;
  data: Hex;
};

export function transferVertical(ctx: TransferVerticalContext) {
  const network = ctx.network;
  if (
    network.profile === 'proof/monad-mainnet' ||
    !isMutationEnabledChain(network.chainId)
  )
    throw new VerticalError('MAINNET_DISABLED');
  const chainId = network.chainId;
  const journalChainId = chainId;

  async function propose(
    amount: bigint,
    nonce: string,
    version = ctx.mandate().version,
  ): Promise<TransferProposal> {
    const now = await ctx.sync();
    const mandate = ctx.mandate();
    const data = encodeFunctionData({
      abi: tokenAbi,
      functionName: 'transfer',
      args: [ctx.recipient, amount],
    });
    ctx.calldatas.set(keccak256(data), data);
    const input = BoundActionIntentSchema.parse({
      schemaVersion: 1,
      intentId: `${ctx.intentPrefix}_${nonce}`,
      groupId: mandate.groupId,
      mandateId: mandate.mandateId,
      mandateVersion: version,
      action: 'TRANSFER',
      chainId,
      account: ctx.account,
      operator: ctx.executor.address,
      recipient: ctx.recipient,
      pluginId: ctx.pluginId,
      target: ctx.token,
      selector: '0xa9059cbb',
      calldataHash: keccak256(data),
      inputToken: ctx.token,
      maxInputAmount: String(amount),
      minOutputAmount: '0',
      nativeValue: '0',
      validAfter: now - 10,
      validUntil: Math.min(now + 600, mandate.validUntil),
      nonce,
      evidenceHash: ZERO_HASH,
      riskPacketHash: ZERO_HASH,
    });
    const block = await ctx.client.getBlock();
    const risk: RiskPacket = {
      schemaVersion: 1,
      intentHash: economicIntentHash(input),
      evaluatedAt: now,
      quoteAt: now,
      quoteExpiresAt: now + 300,
      slippageBps: 0,
      referenceDeviationBps: 0,
      maxReferenceDeviationBps: 0,
      blocked: false,
      evidence: [
        {
          source: ctx.evidenceSource,
          retrievedAt: now,
          chainId,
          artifactHash: artifactHash({
            blockHash: block.hash,
            token: ctx.token,
          }),
          untrusted: false,
        },
      ],
    };
    const intent = BoundActionIntentSchema.parse({
      ...input,
      evidenceHash: artifactHash(risk.evidence),
      riskPacketHash: artifactHash(risk),
    });
    const context = { network: ctx.network, now };
    if (!(await ctx.plugins.refreshHealth(intent.pluginId, context)))
      throw new VerticalError('PLUGIN_UNHEALTHY');
    const simulation = await ctx.plugins
      .getMutator(intent.pluginId, ctx.network, now)
      .simulate(context, [
        {
          chainId,
          account: intent.account,
          target: intent.target,
          calldata: data,
          value: intent.nativeValue,
          intentHash: intentHash(intent),
        },
      ]);
    ctx.kernel.attestEvidence({
      riskPacketHashes: [artifactHash(risk)],
      simulationHashes: [artifactHash(simulation)],
    });
    return { intent, risk, simulation, data };
  }

  /** The module's own EIP-712 digest must equal the Kernel draft digest the owners sign. */
  async function assertModuleDigest(draft: {
    digest: Hex;
    grant: Parameters<typeof onchainGrantArgs>[0];
  }): Promise<Hex> {
    const onchainDigest = await ctx.client.readContract({
      address: ctx.module,
      abi: moduleAbi,
      functionName: 'hashGrant',
      args: [onchainGrantArgs(draft.grant)],
    });
    if (onchainDigest !== draft.digest)
      throw new VerticalError('EIP712_DIGEST_DIVERGES_FROM_MODULE');
    return onchainDigest;
  }

  async function authorize(
    amount: bigint,
    nonce: string,
    version?: number,
    approvers: readonly number[] = [0, 1],
  ) {
    const proposal = await propose(amount, nonce, version);
    const request = {
      intent: proposal.intent,
      risk: proposal.risk,
      simulation: proposal.simulation,
    };
    const pending = ctx.requestDraft
      ? await ctx.requestDraft(request)
      : await ctx.kernel.authorize({ ...request, approvals: [] });
    if (pending.status !== 'PENDING_APPROVAL' || !pending.draft)
      return { ...proposal, decision: pending, onchainDigest: null };
    const onchainDigest = await assertModuleDigest(pending.draft);
    const approvals = await ctx.approve(pending.draft, approvers);
    const decision = await ctx.kernel.authorize({ ...request, approvals });
    return { ...proposal, decision, onchainDigest };
  }

  const broadcasters = new Map<string, JournaledBroadcaster>();
  function broadcasterFor(directory: string): JournaledBroadcaster {
    const existing = broadcasters.get(directory);
    if (existing) return existing;
    const created = new JournaledBroadcaster(
      new ExecutionJournal(
        directory,
        undefined,
        undefined,
        ctx.journalKey ?? undefined,
      ),
      {
        sendRawTransaction: (serialized) =>
          ctx.client.sendRawTransaction({ serializedTransaction: serialized }),
        receipt: async (hash) => {
          try {
            const r = await ctx.client.getTransactionReceipt({ hash });
            return { status: r.status, blockNumber: r.blockNumber };
          } catch {
            return null;
          }
        },
        blockNumber: () => ctx.client.getBlockNumber({ cacheTime: 0 }),
      },
      ctx.confirmations ?? 1,
    );
    broadcasters.set(directory, created);
    return created;
  }

  async function execute(
    grant: ExecutionGrant,
    intent: BoundActionIntent,
    data: Hex,
    journalDirectory: string,
  ) {
    const now = await ctx.sync();
    const claim = ctx.kernel.claimForExecution(grant, intent, ctx.workerId);
    const call = prepareModuleCall(ctx.kernel, claim, data, ctx.localAssets);
    await ctx.client.call({
      account: ctx.executor.address,
      to: call.to,
      data: call.data,
    });
    const [fees, gas, nonce] = await Promise.all([
      ctx.client.estimateFeesPerGas(),
      ctx.client.estimateGas({
        account: ctx.executor.address,
        to: call.to,
        data: call.data,
      }),
      ctx.client.getTransactionCount({
        address: ctx.executor.address,
        blockTag: 'pending',
      }),
    ]);
    const raw = await signGrantBoundTransaction(
      grant,
      {
        type: 'eip1559',
        chainId,
        to: call.to,
        data: call.data,
        value: 0n,
        nonce,
        gas: (gas * ctx.gasLimitPercent) / 100n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      },
      ctx.executor,
      now,
      ctx.localAssets,
    );
    const transactionHash = keccak256(raw);
    const broadcaster = broadcasterFor(journalDirectory);
    const submitted = await submitGrantTransaction(
      ctx.kernel,
      claim,
      broadcaster,
      {
        schemaVersion: 1,
        grantId: grant.grantId,
        transactionHash,
        rawTransaction: raw,
        state: 'SIGNED',
        chainId: journalChainId,
        blockNumber: null,
      },
    );
    if (submitted.state === 'RECONCILIATION_REQUIRED')
      throw new VerticalError(
        'SUBMISSION_AMBIGUOUS',
        'reconcile journal before retry',
      );
    const receipt = await ctx.client.waitForTransactionReceipt({
      hash: transactionHash,
      ...(ctx.confirmations ? { confirmations: ctx.confirmations } : {}),
    });
    const journaled = await broadcaster.reconcile(grant.grantId);
    const observation = observeGrantExecution(receipt, ctx.module, chainId);
    ctx.kernel.reconcile(grant.grantId, observation);
    return {
      transactionHash,
      receipt,
      observation,
      journal: journaled,
      gasEstimate: gas,
      gasLimit: (gas * ctx.gasLimitPercent) / 100n,
      broadcaster,
    };
  }

  /**
   * Simulates `ExecutionModule.execute` with the grant's Safe-format signatures
   * (or an explicit signature blob) and returns the decoded revert, or null.
   */
  async function onchainRevert(
    grant: ExecutionGrant,
    data: Hex,
    signatures: Hex = packSafeSignatures(grant.approvals, grant.draft),
  ): Promise<string | null> {
    try {
      await ctx.client.simulateContract({
        account: ctx.executor.address,
        address: ctx.module,
        abi: [...moduleAbi, ...registryAbi],
        functionName: 'execute',
        args: [chainGrant(grant, ctx.localAssets), data, signatures],
      });
      return null;
    } catch (error) {
      if (!(error instanceof BaseError)) throw error;
      const reverted = error.walk(
        (e) => e instanceof ContractFunctionRevertedError,
      );
      return reverted instanceof ContractFunctionRevertedError
        ? (reverted.data?.errorName ?? 'UNKNOWN_REVERT')
        : 'UNKNOWN_REVERT';
    }
  }

  return { propose, authorize, execute, onchainRevert, assertModuleDigest };
}
