import {
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { safeAbi } from '@synq/execution-worker/abi';
import type {
  MandateProposal,
  MandateProposalService,
} from '@synq/api/mandate-proposals';

/**
 * Submits owner-approved mandate governance transactions. The operator only
 * relays: Safe.execTransaction enforces the owner signatures and threshold.
 */
export async function executeReadyMandates(input: {
  service: MandateProposalService;
  client: PublicClient;
  wallet: WalletClient;
  operator: Address;
  confirmations?: number;
  onExecuted?: (
    proposal: MandateProposal,
    transactionHash: Hex,
  ) => Promise<void>;
}) {
  const executed: { proposalId: string; transactionHash: Hex }[] = [];
  for (const p of await input.service.list()) {
    if (p.state !== 'READY') continue;
    const safe = p.safeTx.safe as Address;
    const nonce = await input.client.readContract({
      address: safe,
      abi: safeAbi,
      functionName: 'nonce',
    });
    if (nonce.toString() !== p.safeTx.nonce) {
      await input.service.settle(p.proposalId, {
        state: 'STALE',
        reason: 'Safe nonce moved; propose again',
      });
      continue;
    }
    const signatures = await input.service.signatures(p.proposalId);
    if (!signatures) continue;
    const args = [
      p.safeTx.to as Address,
      0n,
      p.safeTx.data as Hex,
      0,
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      signatures,
    ] as const;
    try {
      await input.client.simulateContract({
        account: input.operator,
        address: safe,
        abi: safeAbi,
        functionName: 'execTransaction',
        args,
      });
    } catch {
      await input.service.settle(p.proposalId, {
        state: 'REJECTED',
        reason: 'Safe or registry rejected the governance transaction',
      });
      continue;
    }
    const account = input.wallet.account;
    if (
      !account ||
      account.address.toLowerCase() !== input.operator.toLowerCase()
    )
      throw new Error('GOVERNANCE_RELAYER_ACCOUNT_MISMATCH');
    const hash = await input.wallet.writeContract({
      account,
      chain: input.wallet.chain ?? null,
      address: safe,
      abi: safeAbi,
      functionName: 'execTransaction',
      args,
    });
    const receipt = await input.client.waitForTransactionReceipt({
      hash,
      ...(input.confirmations ? { confirmations: input.confirmations } : {}),
    });
    const ok =
      receipt.status === 'success' &&
      parseEventLogs({ abi: safeAbi, logs: receipt.logs }).some(
        (e) => e.eventName === 'ExecutionSuccess',
      );
    if (!ok) {
      await input.service.settle(p.proposalId, {
        state: 'REJECTED',
        reason: `governance transaction ${hash} failed`,
      });
      continue;
    }
    await input.service.settle(p.proposalId, {
      state: 'EXECUTED',
      transactionHash: hash,
    });
    await input.onExecuted?.(p, hash);
    executed.push({ proposalId: p.proposalId, transactionHash: hash });
  }
  return executed;
}
