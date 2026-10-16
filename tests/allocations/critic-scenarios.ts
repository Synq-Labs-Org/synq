import { describe, expect, it } from 'vitest';
import {
  computeWaterfall,
  kernelPurposeOf,
  legIntentId,
  legRef,
  mandateFromPolicy,
  policyHash,
  receiptKey,
  registerPolicy,
  revocationTypedData,
  revokePolicy,
  totals,
  type PolicyRevocation,
  type SplitRecord,
  treasuryScope,
  type SplitStore,
} from '@synq/allocations';
import { MemoryNonceFence, decide } from '@synq/kernel/arc';
import { MemoryOutboxStore } from '@synq/execution-worker/arc-outbox';
import {
  DEV,
  GRANT_KEY,
  STRANGER,
  T0,
  TX,
  USDC,
  VAULT,
  countingSigner,
  devInvoice,
  fakeVaultChain,
  intruder,
  kernelConfig,
  owner,
  policy1500,
  position,
  receipt1500,
  registryOf,
  signPolicy,
  usd,
  vendors,
  world,
} from './harness.js';
import {
  vaultLegExecutor,
  walletLegExecutor,
} from '../../scripts/lib/split-executor.js';

const second = (n: number, amount = usd('1500')) =>
  receipt1500(amount, {
    txHash: TX(n),
    receiptId: receiptKey(USDC.chainId, TX(n), 3),
    invoiceId: `inv_${n}`,
    invoiceNumber: `INV-${n}`,
  });
const active = async (store: SplitStore, purpose: string) =>
  (await store.reservations(treasuryScope(policy1500())))
    .filter((r) => r.status === 'ACTIVE' && r.purpose === purpose)
    .reduce((a, r) => a + r.amount, 0n);

async function signRevocation(
  r: PolicyRevocation,
  signer: { signTypedData: typeof owner.signTypedData } = owner,
) {
  return {
    revocation: r,
    signature: await signer.signTypedData(revocationTypedData(r)),
  };
}

/** Regression tests for the independent critic's findings (C14-01..12). */
export function criticScenarios(
  name: string,
  makeStore: () => Promise<SplitStore>,
) {
  describe(`Critic regressions (${name})`, () => {
    // ---------------------------------------------------------------- C14-05
    it('C14-05 a policy whose self-declared owner is not the workspace owner is refused', async () => {
      const policy = policy1500({
        owner: intruder.address,
        distributions: [
          {
            kind: 'PERCENT_OF_SURPLUS',
            label: 'all',
            beneficiaryId: 'vnd_savings',
            bps: 10_000,
          },
        ],
      });
      const w = await world({
        store: await makeStore(),
        policy,
        signed: await signPolicy(policy, intruder),
      });
      const { split } = await w.runner
        .trigger(w.receipt)
        .catch(() => ({ split: null }));
      const done = split ? await w.runner.run(split.splitId) : null;
      expect(done?.state ?? 'REFUSED').not.toBe('COMPLETED');
      expect(w.fake.paid).toEqual([]);
      expect(w.signer.total).toBe(0);
    });

    it('C14-05 a policy naming a treasury other than the registered one is refused', async () => {
      const w = await world({
        store: await makeStore(),
        registry: registryOf({
          wsp_freelancer_p14: { treasury: DEV, owners: [owner.address] },
        }),
      });
      const { split } = await w.runner
        .trigger(w.receipt)
        .catch(() => ({ split: null }));
      const done = split ? await w.runner.run(split.splitId) : null;
      expect(done?.state ?? 'REFUSED').not.toBe('COMPLETED');
      expect(w.fake.paid).toEqual([]);
    });

    // ---------------------------------------------------------------- C14-06
    it('C14-06 a newer signed version supersedes the old one, which can no longer pay', async () => {
      const store = await makeStore();
      const v1 = policy1500();
      const v2 = policy1500({ version: 2, distributions: [] });
      const w = await world({ store, policy: v1 });
      await registerPolicy(store, w.registry, await signPolicy(v2), T0);
      const { split } = await w.runner
        .trigger(w.receipt)
        .catch(() => ({ split: null }));
      const done = split ? await w.runner.run(split.splitId) : null;
      expect(done?.state ?? 'REFUSED').not.toBe('COMPLETED');
      if (done) expect(done.note).toMatch(/superseded/);
      expect(w.fake.paid).toEqual([]);
    });

    it('C14-06 an owner-signed revocation stops a split already authorized, before signing', async () => {
      const store = await makeStore();
      const w = await world({ store });
      const { split } = await w.runner.trigger(w.receipt);
      expect(
        (await w.runner.run(split.splitId, { stopAt: 'SPLIT_AUTHORIZED' }))
          .state,
      ).toBe('SPLIT_AUTHORIZED');
      await revokePolicy(
        store,
        w.registry,
        await signRevocation({
          policyId: w.policy.policyId,
          workspaceId: w.policy.workspaceId,
          throughVersion: 1,
          reason: 'owner paused distributions',
          at: T0,
        }),
        T0,
      );
      const done = await w.runner.run(split.splitId);
      expect(done.state).toBe('NEEDS_REVIEW');
      expect(done.note).toMatch(/revoked/);
      expect(w.signer.total).toBe(0);
      expect(w.fake.paid).toEqual([]);
    });

    it('C14-06 a revocation not signed by a registered owner is refused', async () => {
      const store = await makeStore();
      const w = await world({ store });
      await expect(
        revokePolicy(
          store,
          w.registry,
          await signRevocation(
            {
              policyId: w.policy.policyId,
              workspaceId: w.policy.workspaceId,
              throughVersion: 1,
              reason: 'x',
              at: T0,
            },
            intruder,
          ),
          T0,
        ),
      ).rejects.toThrow(/not a registered owner/);
    });

    // ---------------------------------------------------------------- C14-03
    it('C14-03 a cancel that read the split before execution started cannot release or cancel anything', async () => {
      const store = await makeStore();
      const w = await world({ store });
      const { split } = await w.runner.trigger(w.receipt);
      const staged = await w.runner.run(split.splitId, {
        stopAt: 'SPLIT_AUTHORIZED',
      });
      // The cancelling runner's first read of the split is the pre-execution snapshot.
      let stale: SplitRecord | null = staged;
      const staleStore: SplitStore = Object.create(store, {
        get: {
          value: async (id: string) => {
            const s = stale;
            stale = null;
            return s ?? store.get(id);
          },
        },
      });
      let cancelError: unknown = null;
      const canceller = w.makeRunner(undefined, { store: staleStore });
      const worker = w.makeRunner(async (k) => {
        if (k.endsWith('#1'))
          await canceller.cancel(split.splitId, 'late cancel').catch((e) => {
            cancelError = e;
          });
      });
      const done = await worker.run(split.splitId);
      expect(cancelError).not.toBeNull();
      expect(done.state).toBe('COMPLETED');
      const legs = await store.legs(split.splitId);
      expect(legs.some((l) => l.state === 'CANCELLED')).toBe(false);
      expect(await active(store, 'TAX_ESTIMATE')).toBe(usd('225'));
    });

    it('C14-03 a leg cancelled under the executor is never signed and never overwritten', async () => {
      const store = await makeStore();
      const w = await world({ store });
      const { split } = await w.runner.trigger(w.receipt);
      await w.runner.run(split.splitId, { stopAt: 'EXECUTING' });
      const leg5 = `${w.receipt.receiptId}#5`;
      const worker = w.makeRunner(async (k) => {
        if (k.endsWith('#1')) {
          const l = (await store.legs(split.splitId)).find(
            (x) => x.legKey === leg5,
          )!;
          await store.updateLeg(leg5, l.state, {
            state: 'CANCELLED',
            note: 'operator cancelled this leg',
          });
        }
      });
      const done = await worker.run(split.splitId);
      expect(done.state).toBe('NEEDS_REVIEW');
      expect(w.signer.total).toBe(1);
      expect(w.fake.paid.map((p) => p.recipient)).toEqual([DEV]);
      expect(
        (await store.legs(split.splitId)).find((x) => x.legKey === leg5)!.state,
      ).toBe('CANCELLED');
    });

    // ---------------------------------------------------------------- C14-04
    it('C14-04 concurrent splits cannot together exceed the autonomous window', async () => {
      const store = await makeStore();
      const fake = fakeVaultChain();
      const treasuryCash = { value: 0n };
      const outbox = new MemoryOutboxStore();
      const policy = policy1500({
        distributions: [],
        limits: { ...policy1500().limits, maxAutonomousPerWindow: usd('400') },
      });
      const a = await world({
        store,
        policy,
        fake,
        treasuryCash,
        outbox,
        payables: [devInvoice(usd('300'), 5, 'vin_a')],
      });
      const b = await world({
        store,
        ledger: a.ledger,
        policy,
        fake,
        treasuryCash,
        outbox,
        receipt: second(2),
        payables: [devInvoice(usd('300'), 5, 'vin_b')],
      });
      const sa = (await a.runner.trigger(a.receipt)).split;
      const sb = (await b.runner.trigger(b.receipt)).split;
      await a.runner.run(sa.splitId, { stopAt: 'POLICY_VALIDATED' });
      await b.runner.run(sb.splitId, { stopAt: 'POLICY_VALIDATED' });
      const [ra, rb] = await Promise.all([
        a.runner.run(sa.splitId),
        b.runner.run(sb.splitId),
      ]);
      expect([ra.state, rb.state].sort()).toEqual([
        'COMPLETED',
        'NEEDS_REVIEW',
      ]);
      expect(fake.paid.map((p) => p.amount)).toEqual([usd('300')]);
    });

    it('C14-04 concurrent splits cannot together exceed the splits-per-window limit', async () => {
      const store = await makeStore();
      const fake = fakeVaultChain();
      const treasuryCash = { value: 0n };
      const outbox = new MemoryOutboxStore();
      const policy = policy1500({
        limits: { ...policy1500().limits, maxSplitsPerWindow: 1 },
      });
      const a = await world({
        store,
        policy,
        fake,
        treasuryCash,
        outbox,
        payables: [],
      });
      const b = await world({
        store,
        ledger: a.ledger,
        policy,
        fake,
        treasuryCash,
        outbox,
        receipt: second(2),
        payables: [],
      });
      const sa = (await a.runner.trigger(a.receipt)).split;
      const sb = (await b.runner.trigger(b.receipt)).split;
      await a.runner.run(sa.splitId, { stopAt: 'RESERVATIONS_CREATED' });
      await b.runner.run(sb.splitId, { stopAt: 'RESERVATIONS_CREATED' });
      const [ra, rb] = await Promise.all([
        a.runner.run(sa.splitId),
        b.runner.run(sb.splitId),
      ]);
      expect([ra.state, rb.state].sort()).toEqual([
        'COMPLETED',
        'NEEDS_REVIEW',
      ]);
    });

    // ---------------------------------------------------------------- C14-01
    it('C14-01 two receipts: each bill occurrence is held once and the floor only up to its target', async () => {
      const store = await makeStore();
      const w = await world({ store });
      await w.runner.run((await w.runner.trigger(w.receipt)).split.splitId);
      await w.addReceipt(second(2));
      const s2 = (await w.runner.trigger(second(2))).split;
      const done = await w.runner.run(s2.splitId);
      expect(done.state).toBe('COMPLETED');
      expect(await active(store, 'UPCOMING_BILL')).toBe(usd('295'));
      expect(await active(store, 'OPERATING_FLOOR')).toBe(usd('500'));
      expect(await active(store, 'TAX_ESTIMATE')).toBe(usd('450'));
      const plan2 = (await store.get(s2.splitId))!.plan!;
      expect(totals(plan2).bills).toBe(0n);
      expect(totals(plan2).operatingFloor).toBe(0n);
    });

    it('C14-01 a paid bill releases its hold; a held payable is released and paid once its vendor is verified', async () => {
      const store = await makeStore();
      const vs = vendors();
      const newbie = {
        ...devInvoice(usd('100'), 3, 'vin_new'),
        vendorId: 'vnd_new',
        payTo: STRANGER,
      };
      const policy = policy1500({
        allowedBeneficiaries: [
          ...policy1500().allowedBeneficiaries,
          {
            beneficiaryId: 'vnd_new',
            address: STRANGER,
            label: 'new designer',
          },
        ],
      });
      const w = await world({
        store,
        policy,
        vendorList: vs,
        payables: [newbie],
      });
      await w.runner.run((await w.runner.trigger(w.receipt)).split.splitId);
      expect(await active(store, 'PAYABLE_HELD')).toBe(usd('100'));
      // Out of band: the designer's address is verified, and the software bill is paid.
      const i = vs.findIndex((v) => v.vendorId === 'vnd_new');
      vs[i] = {
        ...vs[i]!,
        addresses: [
          { ...vs[i]!.addresses[0]!, status: 'VERIFIED', verifiedBy: 'owner' },
        ],
      };
      const softwareHold = (
        await store.reservations(treasuryScope(policy1500()))
      ).find(
        (r) =>
          r.purpose === 'UPCOMING_BILL' &&
          r.holdKey.startsWith('bill:bill_software@'),
      )!;
      w.settled.push({ holdKey: softwareHold.holdKey, status: 'CONSUMED' });
      await w.addReceipt(second(2));
      const s2 = (await w.runner.trigger(second(2))).split;
      expect((await w.runner.run(s2.splitId)).state).toBe('COMPLETED');
      expect(
        w.fake.paid
          .filter((p) => p.recipient === STRANGER)
          .map((p) => p.amount),
      ).toEqual([usd('100')]);
      expect(await active(store, 'PAYABLE_HELD')).toBe(0n);
      const bills = (
        await store.reservations(treasuryScope(policy1500()))
      ).filter((r) => r.purpose === 'UPCOMING_BILL');
      expect(
        bills.find((r) => r.reservationId === softwareHold.reservationId)!
          .status,
      ).toBe('CONSUMED');
    });

    it('C14-01 an over-committed treasury sends the split to review instead of throwing', async () => {
      const w = await world({ store: await makeStore() });
      const runner = w.makeRunner(undefined, {
        books: {
          ...w.books,
          position: async () => ({
            ...(await w.books.position()),
            escrowLiabilities: usd('2000'),
          }),
        },
      });
      const { split } = await runner.trigger(w.receipt);
      const done = await runner.run(split.splitId);
      expect(done.state).toBe('NEEDS_REVIEW');
      expect(done.note).toMatch(/OVER_COMMITTED|spoken for/);
    });

    // ---------------------------------------------------------------- C14-02
    it("C14-02 a second workspace on the same treasury cannot spend the first one's holds", async () => {
      const store = await makeStore();
      const fake = fakeVaultChain();
      const treasuryCash = { value: 0n };
      const outbox = new MemoryOutboxStore();
      const registry = registryOf({
        wsp_a: { treasury: VAULT, owners: [owner.address] },
        wsp_b: { treasury: VAULT, owners: [owner.address] },
      });
      const pa = policy1500({ workspaceId: 'wsp_a', policyId: 'rev_a' });
      const pb = policy1500({ workspaceId: 'wsp_b', policyId: 'rev_b' });
      const a = await world({
        store,
        policy: pa,
        fake,
        treasuryCash,
        outbox,
        registry,
      });
      await a.runner.run((await a.runner.trigger(a.receipt)).split.splitId);
      const b = await world({
        store,
        policy: pb,
        fake,
        treasuryCash,
        outbox,
        registry,
        receipt: second(2),
        payables: [],
      });
      const sb = (await b.runner.trigger(b.receipt)).split;
      expect((await b.runner.run(sb.splitId)).state).toBe('COMPLETED');
      const plan = (await store.get(sb.splitId))!.plan!;
      // B's free cash is its own receipt; A's money and holds never fund B's floor or distributions.
      expect(totals(plan).operatingFloor).toBe(usd('500'));
      expect(totals(plan).distributions).toBe(usd('48'));
    });

    it('C14-02 the waterfall takes the lower of chain-free cash and the workspace sub-ledger', () => {
      const p = policy1500();
      const plan = computeWaterfall({
        policy: p,
        policyHash: policyHash(p),
        receipt: receipt1500(),
        position: position(usd('4000'), {
          reservations: usd('1020'),
          workspaceCash: usd('1500'),
          workspaceReservations: 0n,
        }),
        asOf: T0,
        vendors: vendors(),
        payables: [],
        payableHistory: [],
        obligations: [],
        bills: [],
        receivables: [],
      });
      expect(plan.position.freeOutsideReceipt).toBe(0n);
      expect(totals(plan).operatingFloor).toBe(usd('500'));
    });

    // ---------------------------------------------------------------- C14-07 / C14-12
    it('C14-07 a transient RPC error before signing does not burn the grant', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      await w.runner.run(split.splitId, { stopAt: 'EXECUTING' });
      w.fake.fail.estimateGas = 1;
      const r1 = await w.runner.run(split.splitId);
      expect(r1.state).toBe('FAILED');
      const r2 = await w.makeRunner().run(split.splitId);
      expect(r2.state).toBe('COMPLETED');
      expect(w.fake.paid).toHaveLength(2);
    });

    it('C14-12 crash after grant admission and before the record: resumes without double paying', async () => {
      const store = await makeStore();
      const outbox = new MemoryOutboxStore();
      let failCreate = true;
      const flaky = Object.create(outbox, {
        create: {
          value: async (r: Parameters<typeof outbox.create>[0]) => {
            if (failCreate && r.key.endsWith('#5')) {
              failCreate = false;
              throw new Error('disk full while recording');
            }
            return outbox.create(r);
          },
        },
      });
      const w = await world({ store, outbox: flaky });
      const { split } = await w.runner.trigger(w.receipt);
      expect((await w.runner.run(split.splitId)).state).toBe('FAILED');
      expect(await outbox.get(`${w.receipt.receiptId}#5`)).toBeNull();
      expect((await w.makeRunner().run(split.splitId)).state).toBe('COMPLETED');
      expect(w.fake.paid).toHaveLength(2);
      expect(new Set(w.fake.broadcasts).size).toBe(2);
    });

    it('C14-12 crash after broadcast and before the receipt: recovery reads the receipt, never re-signs', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      await w.runner.run(split.splitId, { stopAt: 'EXECUTING' });
      w.fake.fail.wait = 1;
      expect((await w.runner.run(split.splitId)).state).toBe('FAILED');
      expect(w.fake.paid).toHaveLength(1);
      expect((await w.makeRunner().run(split.splitId)).state).toBe('COMPLETED');
      expect(w.signer.total).toBe(2);
      expect(w.fake.paid).toHaveLength(2);
    });

    it('C14-12 two runners on one split pay each leg once', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      const results = await Promise.allSettled([
        w.makeRunner().run(split.splitId),
        w.makeRunner().run(split.splitId),
      ]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      await w
        .makeRunner()
        .run(split.splitId)
        .catch(() => undefined);
      expect((await w.store.get(split.splitId))!.state).toBe('COMPLETED');
      expect(w.fake.paid).toHaveLength(2);
      expect(new Set(w.fake.broadcasts).size).toBe(2);
    });

    // ---------------------------------------------------------------- C14-08
    it('C14-08 a paid leg sent to review still counts against the window and fences its obligation', async () => {
      const store = await makeStore();
      const policy = policy1500({
        distributions: [],
        limits: { ...policy1500().limits, maxAutonomousPerWindow: usd('400') },
      });
      const w = await world({
        store,
        policy,
        payables: [
          devInvoice(usd('300'), 5, 'vin_a'),
          devInvoice(usd('300'), 6, 'vin_b'),
        ],
      });
      const { split } = await w.runner.trigger(w.receipt);
      await w.runner.run(split.splitId, { stopAt: 'SPLIT_AUTHORIZED' });
      const leg = (await store.legs(split.splitId)).find(
        (l) => l.documentRef === 'vin_a',
      )!;
      expect(leg.state).toBe('AUTHORIZED');
      await store.updateLeg(leg.legKey, 'AUTHORIZED', {
        state: 'NEEDS_REVIEW',
        txHash: TX(77),
        note: 'evidence mismatch',
      });
      const since = T0 - 86_400;
      expect(
        (await store.transfersSince(policy.policyId, since)).map(
          (l) => l.legKey,
        ),
      ).toContain(leg.legKey);
      expect(
        (await store.grantedLegs(policy.policyId)).map((l) => l.legKey),
      ).toContain(leg.legKey);
    });

    // ---------------------------------------------------------------- C14-09
    it('C14-09 a receipt read that fails once does not turn our own payment into "nonce consumed"', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      w.crash.at = `${w.receipt.receiptId}#1`;
      expect((await w.runner.run(split.splitId)).state).toBe('FAILED');
      // The recorded bytes get mined by someone rebroadcasting them; then one receipt read fails.
      const rec = (await w.outbox.get(`${w.receipt.receiptId}#1`))!;
      await w.chain.client.sendRawTransaction({
        serializedTransaction: rec.raw,
      });
      w.fake.fail.receipt = 1;
      expect((await w.makeRunner().run(split.splitId)).state).toBe('COMPLETED');
    });

    // ---------------------------------------------------------------- C14-10
    it('C14-10 wallet-mode legs carry no on-chain reference and fail closed without a transfer log', async () => {
      const fake = fakeVaultChain();
      const w = await world({ store: await makeStore(), fake });
      const exec = walletLegExecutor({
        chain: w.chain,
        store: new MemoryOutboxStore(),
        signer: countingSigner(),
        asset: USDC,
        grantKey: GRANT_KEY,
        fence: new MemoryNonceFence(),
        now: () => T0,
      });
      const p = policy1500({ treasury: countingSigner().address });
      const mandate = mandateFromPolicy(p);
      const signed = await signPolicy(p);
      const d = await decide({
        config: kernelConfig,
        mandate,
        mandateSignature: signed.mandateSignature,
        state: { revoked: false, spends: [] },
        intent: {
          intentId: legIntentId('lk#1'),
          mandateId: mandate.mandateId,
          mandateVersion: 1,
          chainId: USDC.chainId,
          token: USDC.address,
          payer: p.treasury,
          recipient: DEV,
          amount: usd('5'),
          purpose: 'CONTRACTOR_PAYOUT',
          obligationRef: 'payable:x',
          evidenceHash: TX(5),
          proposedBy: 'test',
        },
        risk: { flags: [], available: true },
        simulationOk: true,
        now: T0,
      });
      if (d.outcome !== 'ALLOW') throw new Error(d.reasons.join());
      const r = await exec.pay({
        legKey: 'lk#1',
        recipient: DEV,
        amount: usd('5'),
        ref: legRef('lk#1'),
        grant: d.grant,
        claim: async () => ({ mandateRevoked: false }),
        onRecorded: async () => undefined,
      });
      expect(r.state).toBe('CONFIRMED');
      expect(r.evidence!.ref).toBeNull();
    });

    // ---------------------------------------------------------------- C14-11
    it('C14-11 a grant for one leg cannot pay another leg with the same payee and amount', async () => {
      const w = await world({ store: await makeStore() });
      const exec = vaultLegExecutor({
        chain: w.chain,
        store: new MemoryOutboxStore(),
        signer: countingSigner(),
        asset: USDC,
        grantKey: GRANT_KEY,
        fence: new MemoryNonceFence(),
        now: () => T0,
      });
      const mandate = mandateFromPolicy(w.policy);
      const d = await decide({
        config: kernelConfig,
        mandate,
        mandateSignature: w.signed.mandateSignature,
        state: { revoked: false, spends: [] },
        intent: {
          intentId: legIntentId('rcpt#1'),
          mandateId: mandate.mandateId,
          mandateVersion: 1,
          chainId: USDC.chainId,
          token: USDC.address,
          payer: VAULT,
          recipient: DEV,
          amount: usd('100'),
          purpose: 'CONTRACTOR_PAYOUT',
          obligationRef: 'payable:m1',
          evidenceHash: TX(5),
          proposedBy: 'test',
        },
        risk: { flags: [], available: true },
        simulationOk: true,
        now: T0,
      });
      if (d.outcome !== 'ALLOW') throw new Error(d.reasons.join());
      await expect(
        exec.pay({
          legKey: 'rcpt#2',
          recipient: DEV,
          amount: usd('100'),
          ref: legRef('rcpt#2'),
          grant: d.grant,
          claim: async () => ({ mandateRevoked: false }),
          onRecorded: async () => undefined,
        }),
      ).rejects.toThrow(/GRANT_MISMATCH|another leg/);
      await expect(
        exec.pay({
          legKey: 'rcpt#1',
          recipient: DEV,
          amount: usd('100'),
          ref: TX(8),
          grant: d.grant,
          claim: async () => ({ mandateRevoked: false }),
          onRecorded: async () => undefined,
        }),
      ).rejects.toThrow(/reference differs/);
      expect(w.fake.paid).toEqual([]);
    });

    it('C14-11 distribution legs carry their own Kernel purpose; payables in another asset are held', () => {
      expect(kernelPurposeOf('DISTRIBUTION')).toBe('OWNER_DISTRIBUTION');
      expect(kernelPurposeOf('CONTRACTOR_PAYABLE')).toBe('CONTRACTOR_PAYOUT');
      expect(mandateFromPolicy(policy1500()).purposes).toContain(
        'OWNER_DISTRIBUTION',
      );
      const p = policy1500();
      const eurc = { ...devInvoice(usd('100'), 3, 'vin_eur'), token: STRANGER };
      const plan = computeWaterfall({
        policy: p,
        policyHash: policyHash(p),
        receipt: receipt1500(),
        position: position(usd('1500')),
        asOf: T0,
        vendors: vendors(),
        payables: [eurc],
        payableHistory: [eurc],
        obligations: [],
        bills: [],
        receivables: [],
      });
      const leg = plan.legs.find((l) => l.documentRef === 'vin_eur')!;
      expect(leg.kind).toBe('RESERVE');
      expect(leg.flags.map((f) => f.code)).toContain('WRONG_ASSET');
    });
  });
}
