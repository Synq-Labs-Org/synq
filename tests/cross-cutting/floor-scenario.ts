import { expect } from 'vitest';
import { receiptKey, treasuryScope, type SplitStore } from '@synq/allocations';
import { MemoryOutboxStore } from '@synq/execution-worker/arc-outbox';
import {
  TX,
  USDC,
  devInvoice,
  fakeVaultChain,
  policy1500,
  receipt1500,
  usd,
  world,
  type World,
} from '../allocations/harness.js';

const receiptN = (n: number, amount = usd('1500')) =>
  receipt1500(amount, {
    txHash: TX(100 + n),
    receiptId: receiptKey(USDC.chainId, TX(100 + n), 3),
    invoiceId: `inv_floor_${n}`,
    invoiceNumber: `INV-F${n}`,
  });

/**
 * X-FUN-06: several receipts on one treasury are split concurrently (each
 * approves its own payable and distribution). Whatever the interleaving, the
 * operating floor is held once up to its target, each bill occurrence once,
 * each vendor invoice is paid once, and payments never dip into the holds:
 * paid + active holds <= cash received.
 */
export async function concurrentFloorScenario(
  makeStore: () => Promise<SplitStore>,
  splits = 5,
) {
  const store = await makeStore();
  const fake = fakeVaultChain({
    perPaymentCap: usd('100000'),
    windowCap: usd('100000'),
  });
  const treasuryCash = { value: 0n };
  const outbox = new MemoryOutboxStore();
  const policy = policy1500({
    // All surplus is distributed: nothing but holds keeps cash in the treasury.
    distributions: [
      {
        kind: 'PERCENT_OF_SURPLUS',
        label: 'savings',
        beneficiaryId: 'vnd_savings',
        bps: 10_000,
      },
    ],
    limits: {
      ...policy1500().limits,
      maxAutonomousPerLeg: usd('100000'),
      maxAutonomousPerWindow: usd('100000'),
      maxSplitsPerWindow: 50,
    },
  });
  const worlds: World[] = [];
  for (let n = 0; n < splits; n++)
    worlds.push(
      await world({
        store,
        policy,
        fake,
        treasuryCash,
        outbox,
        ...(worlds[0] ? { ledger: worlds[0].ledger } : {}),
        receipt: receiptN(n),
        payables: [devInvoice(usd('300'), 5, `vin_floor_${n}`)],
      }),
    );
  const results = await Promise.all(
    worlds.map(async (w) => {
      const { split } = await w.runner.trigger(w.receipt);
      return w.runner.run(split.splitId);
    }),
  );
  const holds = (await store.reservations(treasuryScope(policy))).filter(
    (r) => r.status === 'ACTIVE',
  );
  const held = (purpose: string) =>
    holds
      .filter((r) => r.purpose === purpose)
      .reduce((a, r) => a + r.amount, 0n);
  const paid = fake.paid.reduce((a, p) => a + p.amount, 0n);
  const received = usd('1500') * BigInt(splits);
  // Each bill occurrence in the horizon is held once (bills1500: 295).
  expect(held('UPCOMING_BILL')).toBe(usd('295'));
  // Payments never spend a hold, and what stays in the treasury outside the
  // other holds still covers the operating floor.
  const allHolds = holds.reduce((a, r) => a + r.amount, 0n);
  const left = received - paid;
  expect(left >= allHolds).toBe(true);
  expect(
    left - (allHolds - held('OPERATING_FLOOR')) >= policy.operatingFloor,
  ).toBe(true);
  // Each leg (and so each vendor invoice) is paid at most once.
  const refs = fake.paid.map((p) => p.ref);
  expect(new Set(refs).size).toBe(refs.length);
  return { results, held, paid, received };
}
