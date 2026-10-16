/**
 * Leg executors for the revenue split workflow (`@synq/allocations`).
 *
 * - `vaultLegExecutor`: the default. Pays each leg from the governed vault
 *   through `SynqArcVaultPolicy.pay` with `vaultPayOnce` (signed bytes
 *   recorded before broadcast, recovered on restart, never re-signed). The
 *   contract's own per-payment and 24h caps apply to every leg.
 * - `walletLegExecutor`: fallback when the vault window is exhausted. Pays
 *   from the agent's operational wallet with `payOnce`. The treasury is then
 *   that wallet; there is no on-chain cap, only the Kernel grant.
 *
 * Both admit the leg's Kernel grant against the exact call before signing a
 * new transaction, and only then.
 */
import { erc20Abi, parseEventLogs, type Address, type Hex } from 'viem';
import { money, type AssetRef } from '@synq/domain';
import { contract } from '@synq/chain-registry/arc';
import {
  admitGrant,
  type ExecutionGrant,
  type NonceFence,
} from '@synq/kernel/arc';
import type { LegCall, LegExecutor, LegPayResult } from '@synq/allocations';
import type { ArcChain, TransferSigner } from '@synq/execution-worker/arc';
import {
  payOnce,
  type OutboxRecord,
  type OutboxStore,
} from '@synq/execution-worker/arc-outbox';
import { simulate } from '@synq/execution-worker/vault';
import {
  vaultPayData,
  vaultPayOnce,
  type VaultPayEvidence,
} from '@synq/execution-worker/vault-outbox';

type Common = {
  chain: ArcChain;
  store: OutboxStore;
  signer: TransferSigner;
  asset: AssetRef;
  grantKey: Uint8Array;
  fence: NonceFence;
  now: () => number;
  /** Test/crash seam: after the leg's record is durable, before broadcast. */
  afterRecord?: (legKey: string, r: OutboxRecord) => Promise<void> | void;
};

const admit = (
  c: Common,
  payer: Address,
  grant: ExecutionGrant,
  call: LegCall,
) =>
  admitGrant({
    grantKey: c.grantKey,
    grant,
    call: {
      chainId: c.asset.chainId,
      token: c.asset.address,
      payer,
      recipient: call.recipient,
      amount: call.amount,
    },
    now: c.now(),
    mandateRevoked: false,
    fence: c.fence,
  });

export function vaultLegExecutor(
  c: Common,
): LegExecutor & { vault: Address; policy: Address } {
  const vault = contract(c.chain.profile.name, 'SYNQ_ARC_VAULT_SAFE')
    .address as Address;
  const policy = contract(c.chain.profile.name, 'SYNQ_ARC_VAULT_POLICY')
    .address as Address;
  const result = (
    r: OutboxRecord,
    signedNow: boolean,
    ev: VaultPayEvidence | null,
  ): LegPayResult => ({
    state:
      r.state === 'CONFIRMED'
        ? 'CONFIRMED'
        : r.state === 'FAILED'
          ? 'FAILED'
          : 'NEEDS_REVIEW',
    hash: r.hash,
    signedNow,
    note: r.note,
    evidence: ev && {
      txHash: ev.hash,
      blockNumber: ev.blockNumber,
      blockHash: ev.blockHash,
      logIndex: ev.logIndex,
      from: ev.vault,
      to: ev.to,
      amount: ev.amount.baseUnits,
      ref: ev.ref,
      gasPayer: r.prepared.from,
      feeWei: ev.feeWei,
      explorer: ev.explorer,
    },
  });
  return {
    vault,
    policy,
    async simulate(call) {
      return simulate(c.chain, c.signer.address, policy, vaultPayData(call));
    },
    async recorded(legKey) {
      const r = await c.store.get(legKey);
      return r ? { hash: r.hash, state: r.state } : null;
    },
    async pay(call) {
      const r = await vaultPayOnce({
        store: c.store,
        key: call.legKey,
        chain: c.chain,
        signer: c.signer,
        asset: c.asset,
        call: { recipient: call.recipient, amount: call.amount, ref: call.ref },
        authorize: () => admit(c, vault, call.grant, call),
        now: c.now,
        afterRecord: async (rec) => {
          await call.onRecorded(rec.hash);
          await c.afterRecord?.(call.legKey, rec);
        },
      });
      return result(r.record, r.signedNow, r.evidence);
    },
  };
}

/** Fallback: plain ERC-20 transfers from the agent wallet through `payOnce`. */
export function walletLegExecutor(c: Common): LegExecutor {
  const payer = c.signer.address;
  return {
    async simulate(call) {
      try {
        await c.chain.client.simulateContract({
          account: payer,
          address: c.asset.address,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [call.recipient, call.amount],
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: (e as Error).message.slice(0, 200) };
      }
    },
    async recorded(legKey) {
      const r = await c.store.get(legKey);
      return r ? { hash: r.hash, state: r.state } : null;
    },
    async pay(call) {
      if (!(await c.store.get(call.legKey)))
        await admit(c, payer, call.grant, call);
      const r = await payOnce({
        store: c.store,
        key: call.legKey,
        chain: c.chain,
        signer: c.signer,
        transfer: {
          from: payer,
          to: call.recipient,
          amount: money(c.asset, call.amount),
        },
        now: c.now,
        afterRecord: async (rec) => {
          await call.onRecorded(rec.hash);
          await c.afterRecord?.(call.legKey, rec);
        },
      });
      const rec = r.record;
      const ev = rec.evidence;
      let logIndex = -1;
      if (ev) {
        const receipt = await c.chain.client.getTransactionReceipt({
          hash: ev.hash,
        });
        logIndex =
          parseEventLogs({
            abi: erc20Abi,
            eventName: 'Transfer',
            logs: receipt.logs,
          }).find(
            (l) =>
              l.address.toLowerCase() === c.asset.address.toLowerCase() &&
              l.args.to.toLowerCase() === call.recipient.toLowerCase(),
          )?.logIndex ?? -1;
      }
      return {
        state:
          rec.state === 'CONFIRMED'
            ? 'CONFIRMED'
            : rec.state === 'FAILED'
              ? 'FAILED'
              : 'NEEDS_REVIEW',
        hash: rec.hash,
        signedNow: r.signedNow,
        note: rec.note,
        evidence: ev && {
          txHash: ev.hash,
          blockNumber: ev.blockNumber,
          blockHash: ev.blockHash,
          logIndex,
          from: ev.from,
          to: ev.to,
          amount: ev.amount.baseUnits,
          // A plain transfer carries no on-chain reference; the leg key is
          // bound through the outbox record and the grant instead.
          ref: call.ref as Hex,
          gasPayer: payer,
          feeWei: ev.feeWei,
          explorer: ev.explorer,
        },
      };
    },
  };
}
