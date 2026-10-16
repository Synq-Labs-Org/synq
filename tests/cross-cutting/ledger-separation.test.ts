import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Address, PublicClient } from 'viem';
import {
  AmountError,
  addMoney,
  compareMoney,
  moneyFromDecimal,
} from '@synq/domain';
import { chainProfile, token } from '@synq/chain-registry/arc';
import { Ledger, LedgerError, MemoryLedgerStore } from '@synq/ledger';
import {
  MemoryReservationStore,
  MemorySettlementFabricStore,
  SettlementFabric,
  SettlementFabricError,
  obligationLedger,
  treasuryEffectFor,
} from '@synq/settlement';
import { prepareTransfer } from '@synq/execution-worker/arc';
import type { Money } from '@synq/offer-exchange';

/**
 * P23-05: sandbox, testnet and mainnet value can never net against each
 * other. Exercised through the domain money type, the double-entry ledger,
 * the Settlement Fabric over the treasury reservation store, and the
 * executor's chain gate (LOCAL_FIXTURE).
 */

const testnetUsdc = token('arc-testnet', 'USDC');
const mainnetUsdc = token('arc-mainnet', 'USDC');
const wallet = `0x${'5e'.repeat(20)}` as Address;
const T = 1_790_000_000;
const usd = (c: number): Money => ({
  amount: String(c),
  currency: 'USD',
  decimals: 2,
});
const noRpc = new Proxy(
  {},
  {
    get: (_t, p) => () => {
      throw new Error(`unexpected RPC ${String(p)}`);
    },
  },
) as PublicClient;

describe('P23-05 sandbox and mainnet ledgers cannot net funds', () => {
  it('P23-05 the same USDC contract on testnet and mainnet is two assets that never add or compare', () => {
    // Arc USDC has the same 0x3600… address on both networks.
    expect(testnetUsdc.address).toBe(mainnetUsdc.address);
    expect(testnetUsdc.assetId).not.toBe(mainnetUsdc.assetId);
    expect(testnetUsdc.environment).toBe('ARC_TESTNET');
    expect(mainnetUsdc.environment).toBe('MAINNET_READ_ONLY');
    const a = moneyFromDecimal(testnetUsdc, '5');
    const b = moneyFromDecimal(mainnetUsdc, '5');
    expect(() => addMoney(a, b)).toThrow(AmountError);
    expect(() => compareMoney(a, b)).toThrow(/ASSET_MISMATCH|vs/);
  });

  it('P23-05 a journal entry netting testnet cash against mainnet cash is unbalanced and refused', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    const entry = (postings: { asset: string; amount: bigint }[]) => ({
      entryId: `je_${postings.map((p) => p.amount).join('_')}`,
      workspaceId: 'wsp_sep',
      occurredAt: T,
      memo: 'cross-environment',
      source: { kind: 'ADJUSTMENT' as const, ref: 'x' },
      evidence: null,
      idempotencyKey: `sep:${postings.map((p) => `${p.asset}:${p.amount}`).join('|')}`,
      postings: [
        {
          account: 'CASH_ARC_USDC' as const,
          assetId: postings[0]!.asset,
          amount: postings[0]!.amount,
        },
        {
          account: 'OWNER_EQUITY' as const,
          assetId: postings[1]!.asset,
          amount: postings[1]!.amount,
        },
      ],
      reversalOf: null,
    });
    await expect(
      ledger.post(
        entry([
          { asset: testnetUsdc.assetId, amount: 5_000_000n },
          { asset: mainnetUsdc.assetId, amount: -5_000_000n },
        ]),
      ),
    ).rejects.toThrow(LedgerError);
    await ledger.post(
      entry([
        { asset: testnetUsdc.assetId, amount: 5_000_000n },
        { asset: testnetUsdc.assetId, amount: -5_000_000n },
      ]),
    );
    expect(
      await ledger.balance('wsp_sep', 'CASH_ARC_USDC', testnetUsdc.assetId),
    ).toBe(5_000_000n);
    expect(
      await ledger.balance('wsp_sep', 'CASH_ARC_USDC', mainnetUsdc.assetId),
    ).toBe(0n);
  });

  it('P23-05 sandbox fulfilments and refund claims never change spendable testnet funds (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom('SANDBOX_ORDER', 'REFUND_CLAIM', 'CONFIRM'),
            cents: fc.integer({ min: 1, max: 50_000 }),
          }),
          { minLength: 1, maxLength: 12 },
        ),
        async (ops) => {
          const reservations = new MemoryReservationStore();
          const store = new MemorySettlementFabricStore();
          const f = new SettlementFabric(store, reservations, () => T);
          const confirmed = 1_000_000_000n;
          await reservations.setConfirmedBalance({
            groupId: 'g',
            assetId: testnetUsdc.assetId,
            confirmed,
            asOf: T,
          });
          // A mainnet balance for the same group lives in its own bucket.
          await reservations.setConfirmedBalance({
            groupId: 'g',
            assetId: mainnetUsdc.assetId,
            confirmed: 7n,
            asOf: T,
          });
          let n = 0;
          const orders: string[] = [];
          for (const op of ops) {
            n++;
            if (op.kind === 'SANDBOX_ORDER') {
              const resId = `res-${n}`;
              await reservations.reserve(
                {
                  reservationId: resId,
                  groupId: 'g',
                  assetId: testnetUsdc.assetId,
                  amount: String(op.cents * 10_000),
                  intentId: `i-${n}`,
                  purpose: 'COMMERCE',
                  settlementPlanHash: 'plan',
                  expiresAt: T + 600,
                },
                T,
              );
              const o = await f.openOrder({
                intentId: `i-${n}`,
                groupId: 'g',
                providerId: 'lithic-sandbox',
                mode: 'PROVIDER_SANDBOX',
                economicEffect: 'NONE_SANDBOX',
                idempotencyKey: `sandbox-order-${n}`,
                amount: usd(op.cents),
              });
              const r = await f.settleSandboxOrder({
                providerOrderId: o.providerOrderId,
                providerRefs: { tx: `tx-${n}` },
                category: 'CARD_NETWORK_SANDBOX',
                providerName: 'Lithic',
                reservationIds: [resId],
                charged: usd(op.cents),
              });
              expect(r.treasuryEffect).toBe('NONE');
              orders.push(o.providerOrderId);
            } else if (op.kind === 'REFUND_CLAIM' && orders.length) {
              const id = orders[n % orders.length]!;
              const o = (await store.getOrder(id))!;
              const cap = BigInt(o.amount.amount);
              const prior = (await store.listRefunds(id)).reduce(
                (s, r) => s + BigInt(r.amount.amount),
                0n,
              );
              const amt = BigInt(op.cents) <= cap ? BigInt(op.cents) : cap;
              if (prior + amt <= cap) {
                const rec = await f.recordProviderRefund({
                  providerOrderId: id,
                  refundId: `claim-${n}`,
                  amount: usd(Number(amt)),
                  providerRef: null,
                });
                expect(rec.treasuryCredit).toBe(false);
              }
            } else if (op.kind === 'CONFIRM' && orders.length) {
              await expect(
                f.confirmRefund({
                  providerOrderId: orders[0]!,
                  refundId: `confirm-${n}`,
                  amount: usd(1),
                  onchain: { chainId: 5042002, txHash: `0x${'ee'.repeat(32)}` },
                  reservationId: 'res-1',
                  coreAmount: 10_000n,
                  observedCoreAmount: 10_000n,
                }),
              ).rejects.toThrow(/SANDBOX_REFUND_NOT_TREASURY_CREDIT/);
            }
            const free = await reservations.free('g', testnetUsdc.assetId);
            // No sandbox activity is ever held, captured or credited.
            expect(free.free).toBe(String(confirmed));
            expect(free.held).toBe('0');
            expect(free.pendingRefunds).toBe('0');
            expect(
              (await reservations.free('g', mainnetUsdc.assetId)).free,
            ).toBe('7');
          }
          const totals = await store.ledgerTotals('g');
          expect(totals.REAL_OFFCHAIN_OBLIGATION).toEqual({});
          expect(totals.CONFIRMED_REFUND).toEqual({});
        },
      ),
      { numRuns: 60 },
    );
  });

  it('P23-05 order modes cannot cross: sandbox is never testnet- or merchant-settled, testnet never sandbox-fulfilled', async () => {
    const f = new SettlementFabric(
      new MemorySettlementFabricStore(),
      new MemoryReservationStore(),
      () => T,
    );
    const sandbox = await f.openOrder({
      intentId: 'i-s',
      groupId: 'g',
      providerId: 'reloadly-sandbox',
      mode: 'PROVIDER_SANDBOX',
      economicEffect: 'NONE_SANDBOX',
      idempotencyKey: 'sandbox-mode-1',
      amount: usd(500),
    });
    await f.transition(sandbox.providerOrderId, 'SUBMITTED');
    for (const next of ['TESTNET_SETTLED', 'MERCHANT_SETTLED'] as const)
      await expect(
        f.transition(sandbox.providerOrderId, next),
      ).rejects.toBeInstanceOf(SettlementFabricError);
    const testnet = await f.openOrder({
      intentId: 'i-t',
      groupId: 'g',
      providerId: 'crossmint',
      mode: 'TESTNET',
      economicEffect: 'TESTNET_TOKENS',
      idempotencyKey: 'testnet-mode-1',
      amount: usd(500),
    });
    await f.transition(testnet.providerOrderId, 'SUBMITTED');
    await expect(
      f.transition(testnet.providerOrderId, 'SANDBOX_FULFILLED'),
    ).rejects.toThrow(/only no-effect sandbox orders/);
    await expect(
      f.settleSandboxOrder({
        providerOrderId: testnet.providerOrderId,
        providerRefs: {},
        category: 'MERCHANT_CHECKOUT',
        providerName: 'Crossmint',
        reservationIds: [],
        charged: null,
      }),
    ).rejects.toThrow(/not a no-effect sandbox order/);
    // Ledger and treasury effect are decided by mode alone.
    expect(obligationLedger('PROVIDER_SANDBOX')).toBe(
      'SIMULATED_PROVIDER_OBLIGATION',
    );
    expect(obligationLedger('REAL_MONEY_APPROVAL_REQUIRED')).toBe(
      'REAL_OFFCHAIN_OBLIGATION',
    );
    expect(treasuryEffectFor('PROVIDER_SANDBOX', 'NONE_SANDBOX')).toBe('NONE');
    expect(treasuryEffectFor('PROVIDER_SANDBOX', 'REAL_MONEY')).toBe('NONE');
    expect(treasuryEffectFor('TESTNET', 'TESTNET_TOKENS')).toBe(
      'TESTNET_DEBIT',
    );
    expect(treasuryEffectFor('TESTNET', 'REAL_MONEY')).toBe('NONE');
  });

  it('P23-05 the executor never spends a mainnet asset from a testnet chain (or anything on mainnet)', async () => {
    await expect(
      prepareTransfer(
        { profile: chainProfile('arc-testnet'), client: noRpc },
        {
          from: wallet,
          to: wallet,
          amount: moneyFromDecimal(mainnetUsdc, '1'),
        },
      ),
    ).rejects.toMatchObject({ code: 'ASSET_CHAIN_MISMATCH' });
    await expect(
      prepareTransfer(
        { profile: chainProfile('arc-mainnet'), client: noRpc },
        {
          from: wallet,
          to: wallet,
          amount: moneyFromDecimal(testnetUsdc, '1'),
        },
      ),
    ).rejects.toMatchObject({ code: 'MUTATION_DISABLED' });
  });
});
