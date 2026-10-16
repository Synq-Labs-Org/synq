import { describe, expect, it } from 'vitest';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import {
  MemoryCouncilStore,
  advertisedMoneyPolicy,
  approveCouncilAction,
  assertMoneyPolicyEnforced,
  councilActionDigest,
  councilActionTypedData,
  councilCustodyBinding,
  establishCouncil,
  policyHash,
  termHash,
  withdrawalActionHash,
  type CouncilAction,
  type CouncilDecision,
  type CouncilTerm,
  type GovernancePolicy,
} from '@synq/governance';
import { connectChain } from '@synq/execution-worker/arc';
import {
  executeCouncilWithdrawal,
  readCustody,
  withdrawalSafeTx,
} from '@synq/execution-worker/council-payout';
import { collectSignatures } from '@synq/execution-worker/vault';

const accountFor = (label: string) =>
  privateKeyToAccount(keccak256(toHex(`synq-m2-custody:${label}`)));
const USDC = token('arc-testnet', 'USDC');
const CHAIN = USDC.chainId;
const NOW = 1_790_000_000;
const DAY = 86_400;
const SAFE = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address;
const POLICY = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY').address;
const recipient = '0x00000000000000000000000000000000000beef1' as Address;

const policy: GovernancePolicy = {
  policyId: 'pol_custody',
  version: 1,
  workspaceId: 'wsp_custody',
  chainId: CHAIN,
  quorumBps: 5_000,
  approvalBps: 6_000,
  minYesOfEligibleBps: 3_000,
  votingPeriodSeconds: 7 * DAY,
  challengeWindowSeconds: 2 * DAY,
  maxDelegationDepth: 3,
  concentrationFlagBps: 1_000,
  councilSize: 7,
  councilThreshold: 5,
  termSeconds: 365 * DAY,
  termsHash: keccak256(toHex('terms')),
};
const seats = Array.from({ length: 7 }, (_, i) => accountFor(`seat-${i}`));
// The vault's original 2-of-3 signer keys; the attacker holds the first two.
const vaultKeys = Array.from({ length: 3 }, (_, i) => accountFor(`vault-${i}`));
const attackerKeys = vaultKeys.slice(0, 2);
const term: CouncilTerm = {
  councilId: 'cnc_custody',
  workspaceId: policy.workspaceId,
  chainId: CHAIN,
  termId: 1,
  seats: seats.map((a, i) => ({ seatId: `seat-${i}`, holder: a.address })),
  threshold: 5,
  startsAt: NOW - DAY,
  endsAt: NOW + 300 * DAY,
};
const action = (
  amount: bigint,
  label: string,
  to = recipient,
): CouncilAction => ({
  councilId: term.councilId,
  workspaceId: term.workspaceId,
  chainId: CHAIN,
  termId: 1,
  termHash: termHash(term),
  policyHash: policyHash(policy),
  kind: 'WITHDRAWAL',
  actionHash: withdrawalActionHash({
    chainId: CHAIN,
    token: USDC.address,
    payer: SAFE,
    recipient: to,
    amount,
  }),
  nonce: keccak256(toHex(`nonce:${label}`)),
  proposedAt: NOW - 60,
  expiresAt: NOW + 30 * DAY,
});
const sign = (who: PrivateKeyAccount[], a: CouncilAction) =>
  Promise.all(who.map((s) => s.signTypedData(councilActionTypedData(a))));

/** A vault as the chain reports it, plus a mempool that records broadcasts. */
function fakeVault(owners: readonly Address[], threshold: number) {
  const sent: Hex[] = [];
  const client = {
    getChainId: async () => CHAIN,
    getBlockNumber: async () => 4_242n,
    readContract: async ({ functionName }: { functionName: string }) =>
      ({
        getThreshold: BigInt(threshold),
        getOwners: owners,
        nonce: 3n,
        operator: '0x00000000000000000000000000000000000000a9',
        perPaymentCap: 10_000n,
        windowCap: 20_000n,
        paused: false,
      })[functionName],
    call: async () => ({ data: '0x' }),
    estimateGas: async () => 100_000n,
    getTransactionCount: async () => 0,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      sent.push(serializedTransaction);
      return keccak256(serializedTransaction);
    },
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  } as unknown as PublicClient;
  return { client, sent };
}

async function council() {
  const store = new MemoryCouncilStore();
  await establishCouncil({ store, term, policy });
  return store;
}
const relayer = accountFor('relayer');

function safeSigs(
  signers: PrivateKeyAccount[],
  amount: bigint,
  to = recipient,
) {
  return collectSignatures(
    CHAIN,
    SAFE,
    withdrawalSafeTx({ usdc: USDC.address, recipient: to, amount, nonce: 3n }),
    signers.map((s) => ({
      address: s.address,
      signTypedData: (td) => s.signTypedData(td),
    })),
  );
}

async function expectCode(p: Promise<unknown>, code: string) {
  const e = await p.then(
    () => null,
    (x: unknown) => x as { code?: string; message?: string },
  );
  expect(e, `expected ${code}`).not.toBeNull();
  expect(e!.code, e!.message).toBe(code);
}

describe('governance-to-custody binding (ADR-002)', () => {
  it('the live-shaped 2-of-3 vault cannot advertise or act on a 5-of-7 council money policy', async () => {
    const v = fakeVault(
      vaultKeys.map((k) => k.address),
      2,
    );
    const chain = await connectChain('arc-testnet', undefined, v.client);
    const custody = await readCustody(chain, SAFE, POLICY);
    expect(custody).toMatchObject({ threshold: 2, blockNumber: 4_242n });
    expect(() =>
      assertMoneyPolicyEnforced({ threshold: 5, of: 7 }, custody),
    ).toThrow(/cannot advertise 5-of-7.*enforces 2-of-3/);
    expect(() =>
      assertMoneyPolicyEnforced({ threshold: 2, of: 3 }, custody),
    ).not.toThrow();
    const ad = advertisedMoneyPolicy(custody, { term, policy });
    expect(ad.council).toBe('PROPOSALS_ONLY');
    expect(ad.custody).toMatch(/^2-of-3 Safe owner signatures/);
    expect(ad.operator).toMatch(/up to 10000 per payment and 20000 per window/);
    expect(ad.councilNote).toMatch(/approves proposals only/);
    expect(councilCustodyBinding(term, policy, custody).status).toBe('UNBOUND');
  });

  it('an attacker holding the 2 original vault keys gets nothing executed through Synq on the unbound vault, even with a valid 5-of-7 decision', async () => {
    const v = fakeVault(
      vaultKeys.map((k) => k.address),
      2,
    );
    const chain = await connectChain('arc-testnet', undefined, v.client);
    const store = await council();
    const a = action(5_000n, 'unbound');
    const d = await approveCouncilAction({
      store,
      term,
      policy,
      action: a,
      signatures: await sign(seats.slice(0, 5), a),
      now: NOW,
    });
    await expectCode(
      executeCouncilWithdrawal({
        chain,
        store,
        policy,
        digest: d.digest,
        safe: SAFE,
        vaultPolicy: POLICY,
        recipient,
        amount: 5_000n,
        signatures: await safeSigs(attackerKeys, 5_000n),
        relayer,
        now: NOW + 3 * DAY,
        onHash: () => undefined,
      }),
      'CUSTODY_UNBOUND',
    );
    expect(v.sent).toHaveLength(0);
    // The decision was not consumed by the refusal.
    expect(await store.executedAt(d.digest)).toBeNull();
  });

  it('on a council-bound vault the attacker keys can neither approve, forge, redirect nor sign a payout', async () => {
    const v = fakeVault(
      seats.map((s) => s.address),
      5,
    );
    const chain = await connectChain('arc-testnet', undefined, v.client);
    const store = await council();
    const custody = await readCustody(chain, SAFE, POLICY);
    expect(councilCustodyBinding(term, policy, custody).status).toBe('BOUND');
    expect(advertisedMoneyPolicy(custody, { term, policy }).council).toBe(
      'BOUND',
    );
    const run = (
      digest: Hex,
      sigs: Awaited<ReturnType<typeof safeSigs>>,
      to = recipient,
    ) =>
      executeCouncilWithdrawal({
        chain,
        store,
        policy,
        digest,
        safe: SAFE,
        vaultPolicy: POLICY,
        recipient: to,
        amount: 5_000n,
        signatures: sigs,
        relayer,
        now: NOW + 3 * DAY,
        onHash: () => undefined,
      });
    // 1. Their signatures are not council approval.
    const evil = action(5_000n, 'evil', attackerKeys[0]!.address);
    await expectCode(
      approveCouncilAction({
        store,
        term,
        policy,
        action: evil,
        signatures: await sign(attackerKeys, evil),
        now: NOW,
      }),
      'QUORUM_NOT_MET',
    );
    // 2. A forged decision record planted in the store is re-verified and refused.
    const forged: CouncilDecision = {
      digest: councilActionDigest(evil),
      action: evil,
      signatures: await sign(attackerKeys, evil),
      signers: attackerKeys.map((k) => k.address),
      approvedAt: NOW,
      challengeEndsAt: NOW + 2 * DAY,
    };
    await store.insertDecision(forged);
    await expectCode(
      run(
        forged.digest,
        await safeSigs(attackerKeys, 5_000n, attackerKeys[0]!.address),
        attackerKeys[0]!.address,
      ),
      'QUORUM_NOT_MET',
    );
    // 3. An honest decision cannot be redirected to the attacker.
    const honest = action(5_000n, 'honest');
    const d = await approveCouncilAction({
      store,
      term,
      policy,
      action: honest,
      signatures: await sign(seats.slice(0, 5), honest),
      now: NOW,
    });
    await expectCode(
      run(
        d.digest,
        await safeSigs(attackerKeys, 5_000n, attackerKeys[0]!.address),
        attackerKeys[0]!.address,
      ),
      'ACTION_MISMATCH',
    );
    // 4. Their Safe signatures on the honest payout are not owner signatures.
    await expectCode(
      run(d.digest, await safeSigs(attackerKeys, 5_000n)),
      'SIGNER_MISMATCH',
    );
    // 5. Seat holders who did not approve this decision do not count either.
    await expectCode(
      run(d.digest, await safeSigs(seats.slice(2, 7), 5_000n)),
      'QUORUM_NOT_MET',
    );
    expect(v.sent).toHaveLength(0);
    expect(await store.executedAt(d.digest)).toBeNull();
    // The approving seat holders' own signatures execute it exactly once.
    const hashes: Hex[] = [];
    const ok = await executeCouncilWithdrawal({
      chain,
      store,
      policy,
      digest: d.digest,
      safe: SAFE,
      vaultPolicy: POLICY,
      recipient,
      amount: 5_000n,
      signatures: await safeSigs(seats.slice(0, 5), 5_000n),
      relayer,
      now: NOW + 3 * DAY,
      onHash: (h) => {
        hashes.push(h);
      },
    });
    expect(hashes).toEqual([ok.txHash]);
    expect(v.sent).toHaveLength(1);
    await expectCode(
      run(d.digest, await safeSigs(seats.slice(0, 5), 5_000n)),
      'ALREADY_EXECUTED',
    );
    expect(v.sent).toHaveLength(1);
  });
});
