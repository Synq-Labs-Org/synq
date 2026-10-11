import type { PublicClient, Address, Hex } from 'viem';
import { encodeFunctionData, erc20Abi, keccak256, parseEventLogs } from 'viem';
import { BoundActionIntentSchema, SimulationSchema } from '@synq/domain';
import {
  artifactHash,
  economicIntentHash,
  intentHash,
  type Kernel,
} from '@synq/kernel';
import {
  assetForRole,
  profileConfiguration,
  profileForChainId,
  isMutationEnabledChain,
} from '@synq/chain-registry';
import {
  GrantApprovalGateway,
  StoreMembershipDirectory,
  type PostgresIdentityStore,
} from '@synq/identity/server';
import {
  AusdGuard,
  FundingError,
  PENDING_FUNDING_STATES,
  type PostgresFundingSessionStore,
  type PostgresSendStore,
  type DestinationReceipt,
  type FundingSession,
} from '@synq/funding';
import { buildTreasuryView, indexedContributions } from '@synq/read-model';
import type { IdentityConfig } from '@synq/identity';
import type { ReadModelRuntime } from './server.js';
import { mandateFromArtifact } from './kernel-runtime.js';
import { createSendMemberAccess } from './send-access.js';
import type { SendRouteDeps, SendProposal } from './send-routes.js';

export async function fundingReceipt(
  client: PublicClient,
  session: FundingSession,
  hash: Hex,
): Promise<DestinationReceipt> {
  if (
    session.route !== 'DIRECT_MONAD_AUSD' ||
    session.quote.source.address === 'native'
  )
    throw new FundingError(
      'ROUTE_UNAVAILABLE',
      'only verified direct contributions have a production receipt reader',
    );
  const chainId = await client.getChainId();
  const receipt = await client.getTransactionReceipt({ hash });
  const profile = profileForChainId(chainId);
  if (!profile) throw new FundingError('WRONG_CHAIN');
  const head = await client.getBlockNumber({ cacheTime: 0 });
  if (
    chainId !== session.quote.source.chainId ||
    receipt.status !== 'success' ||
    head - receipt.blockNumber + 1n < BigInt(profile.confirmationDepth)
  )
    throw new FundingError(
      'DESTINATION_MISMATCH',
      'unconfirmed or wrong-chain source',
    );
  const logs = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs.filter(
      (l) => l.address.toLowerCase() === session.quote.source.address,
    ),
  });
  const matching = logs.filter(
    (l) =>
      l.args.from.toLowerCase() === session.quote.sourceSender &&
      l.args.to.toLowerCase() === session.quote.recipient.toLowerCase() &&
      String(l.args.value) === session.quote.amountIn,
  );
  if (matching.length !== 1)
    throw new FundingError(
      'DESTINATION_MISMATCH',
      'source transfer binding absent or ambiguous',
    );
  const log = matching[0]!;
  return {
    chainId,
    token: session.quote.source.address,
    from: log.args.from.toLowerCase() as Address,
    to: log.args.to.toLowerCase() as Address,
    amount: String(log.args.value),
    transactionHash: hash.toLowerCase() as Hex,
    logIndex: log.logIndex,
    blockNumber: Number(receipt.blockNumber),
  };
}

export function productionSendPorts(input: {
  identity: PostgresIdentityStore;
  identityConfig: IdentityConfig;
  readModel: ReadModelRuntime;
  kernel: Kernel;
  authorizer: SendRouteDeps['kernel'];
  executionModule: Address;
  adminToken: string;
  sends: PostgresSendStore;
  funding: PostgresFundingSessionStore;
}): Omit<SendRouteDeps, 'store'> {
  const { readModel, kernel } = input;
  const client = readModel.client;
  const directory = new StoreMembershipDirectory(input.identity);
  const profile = profileConfiguration(input.identityConfig.profile);
  const guard = new AusdGuard(client);
  const gateway = new GrantApprovalGateway(
    input.identity,
    input.identityConfig,
    {
      executionModules: { [profile.network.chainId]: input.executionModule },
      localAssets: [],
    },
  );
  const context = async (groupId: string) => {
    const entries = (await readModel.reader.currentMandateArtifacts()).filter(
      (e) => e.groupId === groupId.toLowerCase(),
    );
    const mandates = entries
      .map(mandateFromArtifact)
      .filter(
        (m) =>
          m.status === 'ACTIVE' &&
          m.bindings.some(
            (b) => b.action === 'TRANSFER' && b.target === m.inputAsset.address,
          ),
      );
    if (mandates.length !== 1) return null;
    const mandate = mandates[0]!;
    const memberships = await input.identity.transaction((tx) =>
      tx.listMemberships(groupId),
    );
    const members = (
      await Promise.all(
        memberships.map((m) => directory.activeMember(groupId, m.memberId)),
      )
    ).filter((m) => m !== null);
    return {
      groupId,
      mandate,
      members: members.map((m) => ({
        memberId: m.memberId,
        principalId: m.principalId,
        signer: m.signer,
      })),
      contacts: [],
    };
  };
  const treasury = async (groupId: string) => {
    const snapshot = await readModel.reader.groupSnapshot(groupId as Hex);
    const c = await context(groupId);
    if (!snapshot || !c) return null;
    const asset = assetForRole(profile, 'treasuryAsset');
    const coreAsset = {
      ...asset,
      address: asset.address.toLowerCase() as Address,
    };
    const contrib = await indexedContributions(
      readModel.projectionStore,
      readModel.projection,
      c.mandate.account,
      asset.address,
    );
    const sends = await input.sends.list(groupId);
    const pending = sends.filter(
      (s) =>
        (s.state === 'SUBMITTED' || s.state === 'CONFIRMED') &&
        !snapshot.group.grantsExecuted.some(
          (g) => g.intentHash === s.intentHash,
        ),
    );
    const reserved = BigInt(
      kernel.accounting(c.mandate.groupId, c.mandate.mandateId).reservedToken,
    );
    const sessions = await input.funding.list(groupId);
    return buildTreasuryView({
      snapshot,
      coreAsset,
      contributions: contrib.contributions,
      reserved: reserved
        ? [
            {
              asset: coreAsset,
              amount: reserved,
              provenance: 'KERNEL',
              asOfBlock: null,
              label: 'Kernel reservations',
            },
          ]
        : [],
      pendingDebits: pending.map((s) => ({
        asset: coreAsset,
        amount: BigInt(s.preview.amount),
        provenance: 'POSTGRES',
        asOfBlock: null,
        label: `Send ${s.sendId}`,
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
    });
  };
  return {
    memberAccess: createSendMemberAccess({
      directory,
      context,
      now: () => Math.floor(Date.now() / 1000),
    }),
    adminToken: input.adminToken,
    recoverOnReady: true,
    now: () => Math.floor(Date.now() / 1000),
    nowMs: () => Date.now(),
    groups: { context },
    members: {
      activeSigner: async (g, m) =>
        ((await directory.activeMember(g, m))?.signer as Address | undefined) ??
        null,
    },
    treasury: { view: treasury },
    guard: {
      check: ({ mandate, recipient, amount }) =>
        guard.check({
          asset: mandate.inputAsset,
          account: mandate.account,
          recipient,
          amount,
        }),
    },
    proposer: {
      propose: async ({
        mandate,
        recipient,
        amount,
        nonce,
      }): Promise<SendProposal> => {
        if (
          !isMutationEnabledChain(profile.network.chainId) ||
          profile.network.profile === 'proof/monad-mainnet'
        )
          throw new FundingError('MAINNET_DISABLED');
        const now = Math.floor(Date.now() / 1000);
        const binding = mandate.bindings.find(
          (b) =>
            b.action === 'TRANSFER' &&
            b.target === mandate.inputAsset.address &&
            b.selector === '0xa9059cbb',
        );
        if (!binding || !mandate.operators[0])
          throw new FundingError('ROUTE_UNAVAILABLE');
        const data = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [recipient, amount],
        });
        const zero = `0x${'0'.repeat(64)}` as Hex;
        const base = BoundActionIntentSchema.parse({
          schemaVersion: 1,
          intentId: `send_${nonce}`,
          groupId: mandate.groupId,
          mandateId: mandate.mandateId,
          mandateVersion: mandate.version,
          action: 'TRANSFER',
          chainId: profile.network.chainId,
          account: mandate.account,
          operator: mandate.operators[0],
          recipient,
          pluginId: binding.pluginId,
          target: binding.target,
          selector: binding.selector,
          calldataHash: keccak256(data),
          inputToken: mandate.inputAsset.address,
          maxInputAmount: String(amount),
          minOutputAmount: '0',
          nativeValue: '0',
          validAfter: now - 10,
          validUntil: Math.min(now + 120, mandate.validUntil),
          nonce,
          evidenceHash: zero,
          riskPacketHash: zero,
        });
        const block = await client.getBlock();
        const risk = {
          schemaVersion: 1 as const,
          intentHash: economicIntentHash(base),
          evaluatedAt: now,
          quoteAt: now,
          quoteExpiresAt: now + 120,
          slippageBps: 0,
          referenceDeviationBps: 0,
          maxReferenceDeviationBps: 0,
          blocked: false,
          evidence: [
            {
              source: 'production-ausd-transfer-rpc',
              retrievedAt: now,
              chainId: profile.network.chainId,
              artifactHash: artifactHash({
                blockHash: block.hash,
                token: mandate.inputAsset.address,
              }),
              untrusted: false,
            },
          ],
        };
        const intent = BoundActionIntentSchema.parse({
          ...base,
          evidenceHash: artifactHash(risk.evidence),
          riskPacketHash: artifactHash(risk),
        });
        const call = await client.call({
          account: mandate.account,
          to: binding.target,
          data,
          blockNumber: block.number,
        });
        const simulation = SimulationSchema.parse({
          intentHash: intentHash(intent),
          calldataHash: keccak256(data),
          chainId: profile.network.chainId,
          account: mandate.account,
          target: binding.target,
          succeeded: call.data === `0x${'0'.repeat(63)}1`,
          simulatedAt: now,
          blockNumber: String(block.number),
          artifactHash: artifactHash({
            blockHash: block.hash,
            result: call.data ?? null,
          }),
        });
        kernel.attestEvidence({
          riskPacketHashes: [artifactHash(risk)],
          simulationHashes: [artifactHash(simulation)],
        });
        return {
          intent: intent as unknown as SendProposal['intent'],
          risk,
          simulation,
          data,
        };
      },
    },
    kernel: {
      authorize: (request) => input.authorizer.authorize(request),
      recover: async (proposal) =>
        'recoverAuthorization' in input.authorizer
          ? (
              input.authorizer as typeof input.authorizer & {
                recoverAuthorization(
                  request: SendProposal,
                ):
                  | ReturnType<Kernel['recoverAuthorization']>
                  | Promise<ReturnType<Kernel['recoverAuthorization']>>;
              }
            ).recoverAuthorization(proposal)
          : Promise.resolve({ status: 'UNKNOWN' as const }),
    },
    drafts: {
      register: (d) => gateway.registerKernelDraft(d),
      verifiedApprovals: async (d) => {
        const q = await gateway.quorum(d);
        return { satisfied: q.satisfied, counted: q.counted };
      },
    },
    index: {
      executed: async (g, h) => {
        const s = await readModel.reader.groupSnapshot(g as Hex);
        const e = s?.group.grantsExecuted.find(
          (e) => e.intentHash === h.toLowerCase(),
        );
        return {
          indexedThroughBlock: s?.indexedThroughBlock ?? 0,
          transactionHash: e?.transactionHash ?? null,
          tokenAmount: e?.tokenAmount ?? null,
          recipient: e?.recipient ?? null,
        };
      },
    },
  };
}
