import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  landedTotal,
  revalidateOffer,
  searchOffers,
  selectOffers,
  toDecimal,
  type EconomicOffer,
  type Money,
} from '@synq/offer-exchange';
import {
  DuffelBookingExecutor,
  DuffelClient,
  DuffelError,
  DuffelFlightsProvider,
  DuffelStaysProvider,
  travelCapabilities,
  type HttpFetch,
} from '@synq/plugin-duffel';

const token = process.env.DUFFEL_TEST_TOKEN ?? '';
const outDir = join(process.cwd(), 'bounty-evidence', 'duffel');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const now = () => Math.floor(Date.now() / 1000);
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
// Synthetic test-mode traveler; Duffel test mode creates no real reservation.
const traveler = {
  givenName: 'Ada',
  familyName: 'Synqtest',
  bornOn: '1990-01-01',
  email: 'ada.synqtest@example.com',
  phone: '+442080160509',
  title: 'ms' as const,
  gender: 'f' as const,
};

const realFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ?? AbortSignal.timeout(45_000),
  });
  return { status: res.status, headers: res.headers, text: () => res.text() };
};

type Step = {
  step: string;
  ok: boolean;
  at: string;
  detail: Record<string, unknown>;
};
const errorDetail = (e: unknown) =>
  e instanceof DuffelError
    ? {
        kind: e.kind,
        status: e.status,
        code: e.code,
        requestId: e.requestId,
        message: e.message,
      }
    : { message: e instanceof Error ? e.message : String(e) };
const money = (m: Money | null) => (m ? `${toDecimal(m)} ${m.currency}` : null);

async function run(
  label: string,
  steps: Step[],
  fn: () => Promise<Record<string, unknown>>,
) {
  try {
    const detail = await fn();
    steps.push({ step: label, ok: true, at: new Date().toISOString(), detail });
    return true;
  } catch (e) {
    steps.push({
      step: label,
      ok: false,
      at: new Date().toISOString(),
      detail: errorDetail(e),
    });
    return false;
  }
}

async function stays(
  client: DuffelClient,
  exec: DuffelBookingExecutor,
  graph: ProviderCapabilityGraph,
) {
  const steps: Step[] = [];
  const provider = new DuffelStaysProvider(client, now, { maxResults: 3 });
  const intent = EconomicIntentSchema.parse({
    id: `stay-${stamp}`.slice(0, 120),
    groupId: 'evidence-group',
    domain: 'STAY',
    objective: 'Duffel Stays test hotel booking',
    subject: {
      kind: 'STAY',
      checkIn: day(30),
      checkOut: day(32),
      rooms: 1,
      adults: 1,
      location: { latitude: -24.38, longitude: -128.32, radiusKm: 2 },
    },
    hardConstraints: [],
    preferences: [],
    budget: { max: { amount: '100000000', currency: 'USD', decimals: 2 } },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 500,
    validUntil: now() + 3_600,
  });
  let chosen: EconomicOffer | null = null;
  let quoted: EconomicOffer | null = null;
  let bookingId: string | null = null;
  await run('search', steps, async () => {
    const r = await searchOffers({
      intent,
      providers: [provider],
      graph,
      now,
      timeoutMs: 60_000,
    });
    const failed = r.outcomes.find((o) => o.status !== 'OK');
    if (failed) throw new Error(JSON.stringify(failed));
    const sel = selectOffers({ intent, search: r, now: now() });
    const preferred = sel.ranked.find((c) =>
      /successful booking/i.test(
        (c.offer.subject as { roomCategory?: string }).roomCategory ?? '',
      ),
    );
    chosen =
      (
        preferred ??
        sel.ranked.find(
          (c) =>
            !/unavailable/i.test(
              (c.offer.subject as { roomCategory?: string }).roomCategory ?? '',
            ),
        ) ??
        sel.ranked[0]
      )?.offer ?? null;
    if (!chosen) throw new Error('no stay offers returned');
    return {
      offers: r.offers.length,
      coverage: r.coverage.label,
      chosenRate: chosen.providerRef,
      property: (chosen.subject as { propertyName?: string }).propertyName,
      room: (chosen.subject as { roomCategory?: string }).roomCategory,
      price: money(chosen.price.base),
    };
  });
  if (chosen) {
    const offer: EconomicOffer = chosen;
    await run('quote (revalidate)', steps, async () => {
      const sel = {
        offer,
        landed: landedTotal(offer, intent.budget.max),
        match: {
          level: 'EXACT_MATCH' as const,
          basis: 'SELECTED',
          reasons: [],
        },
      };
      const r = await revalidateOffer({
        intent,
        candidate: sel,
        provider,
        graph,
        approvedMax: intent.budget.max,
        now,
        timeoutMs: 60_000,
      });
      if (r.status !== 'EXECUTABLE')
        throw new Error(`${r.status}: ${r.reason}`);
      quoted = r.offer;
      return {
        quoteId: r.offer.providerRef,
        landed: money(r.landed),
        revalidatedAt: r.offer.price.revalidatedAt,
      };
    });
  }
  if (quoted) {
    const q: EconomicOffer = quoted;
    await run('book', steps, async () => {
      const b = await exec.bookStay({
        quoteId: q.providerRef,
        guests: [traveler],
        idempotencyKey: `synq-evidence-stay-${stamp}`,
      });
      if (b.status !== 'CONFIRMED') throw new Error(JSON.stringify(b));
      bookingId = b.providerRef;
      return {
        bookingId: b.providerRef,
        reference: b.reference,
        charged: money(b.charged),
        providerStatus: b.providerStatus,
      };
    });
  }
  if (bookingId) {
    const id: string = bookingId;
    await run('retrieve', steps, async () => {
      const b = await exec.getStayBooking(id);
      return {
        bookingId: id,
        status: b.status,
        providerStatus: 'providerStatus' in b ? b.providerStatus : null,
      };
    });
    await run('reconcile by idempotency key', steps, async () => {
      const b = await exec.findStayBooking(`synq-evidence-stay-${stamp}`);
      return {
        found: b?.status ?? null,
        ref: b && 'providerRef' in b ? b.providerRef : null,
      };
    });
    await run('cancel', steps, async () => {
      const c = await exec.cancelStay(id);
      const after = await exec.getStayBooking(id);
      return { confirmed: c.confirmed, statusAfter: after.status };
    });
  }
  return steps;
}

async function flights(
  client: DuffelClient,
  exec: DuffelBookingExecutor,
  graph: ProviderCapabilityGraph,
) {
  const steps: Step[] = [];
  const provider = new DuffelFlightsProvider(client, now, { maxOffers: 500 });
  const intent = EconomicIntentSchema.parse({
    id: `flight-${stamp}`.slice(0, 120),
    groupId: 'evidence-group',
    domain: 'FLIGHT',
    objective: 'Duffel Airways test order',
    subject: {
      kind: 'FLIGHT',
      segments: [{ origin: 'LHR', destination: 'JFK', departureDate: day(60) }],
      adults: 1,
      cabin: 'economy',
      checkedBags: 0,
    },
    hardConstraints: [],
    preferences: [],
    budget: { max: { amount: '100000000', currency: 'USD', decimals: 2 } },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 500,
    validUntil: now() + 3_600,
  });
  let chosen: EconomicOffer | null = null;
  let fresh: EconomicOffer | null = null;
  let orderId: string | null = null;
  await run('search', steps, async () => {
    const r = await searchOffers({
      intent,
      providers: [provider],
      graph,
      now,
      timeoutMs: 90_000,
    });
    const failed = r.outcomes.find((o) => o.status !== 'OK');
    if (failed) throw new Error(JSON.stringify(failed));
    const zz = r.offers.filter(
      (o) =>
        o.subject.kind === 'FLIGHT' &&
        o.subject.segments.every((s) => s.carrier === 'ZZ'),
    );
    const sel = selectOffers({
      intent,
      search: { ...r, offers: zz },
      now: now(),
    });
    chosen = sel.ranked[0]?.offer ?? null;
    if (!chosen)
      throw new Error(
        `no compliant Duffel Airways (ZZ) offer among ${r.offers.length}: ${JSON.stringify({ zz: zz.length, rejected: sel.rejected, recommendations: sel.recommendations.map((x) => x.match) })}`,
      );
    return {
      offers: r.offers.length,
      duffelAirwaysOffers: zz.length,
      chosenOffer: chosen.providerRef,
      total: money(sel.ranked[0]!.landed),
      expiresAt: chosen.price.expiresAt,
    };
  });
  if (chosen) {
    const offer: EconomicOffer = chosen;
    await run('offer (revalidate)', steps, async () => {
      const r = await revalidateOffer({
        intent,
        candidate: {
          offer,
          landed: landedTotal(offer, intent.budget.max),
          match: { level: 'EXACT_MATCH', basis: 'SELECTED', reasons: [] },
        },
        provider,
        graph,
        approvedMax: intent.budget.max,
        now,
        timeoutMs: 60_000,
      });
      if (r.status !== 'EXECUTABLE')
        throw new Error(`${r.status}: ${r.reason}`);
      fresh = r.offer;
      return { offerId: r.offer.providerRef, landed: money(r.landed) };
    });
  }
  if (fresh) {
    const o: EconomicOffer = fresh;
    await run('order', steps, async () => {
      const p = o.price;
      const total = {
        ...p.base,
        amount: String(
          BigInt(p.base.amount) + BigInt(p.tax.amount) + BigInt(p.fees.amount),
        ),
      };
      const ids = await provider.passengerIds(o.providerRef);
      const r = await exec.bookFlight({
        offerId: o.providerRef,
        passengerIds: ids,
        passengers: ids.map(() => traveler),
        amount: total,
        amountDecimal: toDecimal(total),
        idempotencyKey: `synq-evidence-flight-${stamp}`,
      });
      if (r.status !== 'CONFIRMED') throw new Error(JSON.stringify(r));
      orderId = r.providerRef;
      return {
        orderId: r.providerRef,
        bookingReference: r.reference,
        charged: money(r.charged),
      };
    });
  }
  if (orderId) {
    const id: string = orderId;
    await run('get', steps, async () => {
      const r = await exec.getOrder(id);
      return { orderId: id, status: r.status };
    });
    await run('reconcile by idempotency key', steps, async () => {
      const r = await exec.findFlightOrder(`synq-evidence-flight-${stamp}`);
      return { found: r?.status ?? null };
    });
    await run('cancel', steps, async () => {
      const q = await exec.quoteFlightCancellation(id);
      const c = await exec.confirmFlightCancellation(q.cancellationId!);
      const after = await exec.getOrder(id);
      return {
        cancellationId: c.cancellationId,
        quotedRefund: money(q.refund),
        refundTo: c.refundTo,
        confirmed: c.confirmed,
        statusAfter: after.status,
      };
    });
  }
  return steps;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const base = {
    generatedAt: new Date().toISOString(),
    environment: 'Duffel test mode (api.duffel.com, duffel_test_ token)',
    host: 'api.duffel.com',
  };
  if (!token.startsWith('duffel_test_')) {
    const file = join(outDir, `duffel-${stamp}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          ...base,
          label: 'BLOCKED_EXTERNAL',
          reason: 'DUFFEL_TEST_TOKEN missing or not a test token',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`BLOCKED_EXTERNAL -> ${file}`);
    return;
  }
  const client = new DuffelClient(token, realFetch, {
    evidence: 'PROVIDER_SANDBOX',
  });
  const exec = new DuffelBookingExecutor(client);
  const graph = new ProviderCapabilityGraph(
    travelCapabilities({ DUFFEL_TEST_TOKEN: token }),
  );
  const stay = await stays(client, exec, graph);
  const air = await flights(client, exec, graph);
  const report = {
    ...base,
    label: 'PROVIDER_SANDBOX',
    stays: {
      complete: stay.length >= 5 && stay.every((s) => s.ok),
      steps: stay,
    },
    flights: {
      complete: air.length >= 5 && air.every((s) => s.ok),
      steps: air,
    },
    providerHealth: graph.health(now()),
  };
  const text = JSON.stringify(report, null, 2);
  if (text.includes(token)) throw new Error('token leaked into evidence');
  const file = join(outDir, `duffel-${stamp}.json`);
  writeFileSync(file, text + '\n');
  console.log(
    `stays complete=${report.stays.complete} flights complete=${report.flights.complete} -> ${file}`,
  );
  for (const s of [
    ...stay.map((x) => ['stays', x] as const),
    ...air.map((x) => ['flights', x] as const),
  ])
    console.log(
      `${s[0]} ${s[1].step}: ${s[1].ok ? 'ok' : 'FAILED'} ${JSON.stringify(s[1].detail).slice(0, 260)}`,
    );
}

await main();
