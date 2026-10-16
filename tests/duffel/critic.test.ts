import { describe, expect, it } from 'vitest';
import {
  DuffelClient,
  DuffelBookingExecutor,
  holdPaymentDecision,
  type HttpFetch,
} from '@synq/plugin-duffel';
import { CommerceJourney } from '@synq/plugin-commerce';
import { FakeDuffel } from './fake-duffel.js';
const now = 1780000000;
const input = {
  offerId: 'off_0000ZZtest',
  passengerIds: ['pas_fixture'],
  passengers: [
    {
      givenName: 'Fixture',
      familyName: 'Traveler',
      bornOn: '1990-01-01',
      email: 'fixture@example.com',
      phone: '+442080160509',
    },
  ],
  amount: { amount: '31240', currency: 'GBP', decimals: 2 },
  amountDecimal: '312.40',
  idempotencyKey: 'critic-booking',
};
const empty = () => ({
  status: 200,
  headers: { get: () => null },
  text: async () => JSON.stringify({ data: [] }),
});
describe('commerce and travel adversarial regressions', () => {
  it('COM-01: provider errors cannot echo passports or street addresses into Temporal failures', async () => {
    const pii = 'passport P12345678 for Asha Rao, shipping 17 Cedar Street';
    const client = new DuffelClient(
      'duffel_test_fixture',
      async () => ({
        status: 422,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            errors: [{ code: 'validation_error', message: pii }],
          }),
      }),
      { evidence: 'MOCKED' },
    );
    let message = '';
    try {
      await client.request('POST', '/air/orders');
    } catch (e) {
      message = String(e);
    }
    for (const fragment of ['P12345678', 'Asha Rao', '17 Cedar Street'])
      expect(message).not.toContain(fragment);
  });
  it('COM-02: delayed order listings cannot cause a second POST after timeout', async () => {
    const fake = new FakeDuffel(() => now);
    fake.faults.set('order', { kind: 'TIMEOUT_AFTER_COMMIT' });
    const fetch: HttpFetch = (url, init) =>
      init.method === 'GET' && url.includes('/air/orders?')
        ? Promise.resolve(empty())
        : fake.fetch(url, init);
    const exec = new DuffelBookingExecutor(
      new DuffelClient('duffel_test_fixture', fetch, { evidence: 'MOCKED' }),
    );
    expect((await exec.bookFlight(input)).status).toBe('UNKNOWN');
    expect((await exec.bookFlight(input)).status).toBe('UNKNOWN');
    expect(fake.orders.size).toBe(1);
  });
  it('COM-02: two concurrent submissions can create at most one provider order', async () => {
    const fake = new FakeDuffel(() => now);
    const exec = new DuffelBookingExecutor(
      new DuffelClient('duffel_test_fixture', fake.fetch, {
        evidence: 'MOCKED',
      }),
    );
    await Promise.all([exec.bookFlight(input), exec.bookFlight(input)]);
    expect(fake.orders.size).toBe(1);
  });
  it('COM-03: non-finite hold time or a negative safety margin never authorizes payment', () => {
    const request = {
      hold: {
        paymentRequiredBy: now + 10,
        cancelled: false,
        awaitingPayment: true,
      },
      current: input.amount,
      approved: input.amount,
      now,
    };
    expect(holdPaymentDecision({ ...request, now: Number.NaN }).action).toBe(
      'EXPIRED',
    );
    expect(
      holdPaymentDecision({ ...request, safetySeconds: -100 }).action,
    ).toBe('EXPIRED');
  });
  it('COM-04: journey notes and arbitrary references cannot carry passport data into the agent view', () => {
    const j = new CommerceJourney('critic', () => now);
    j.advance('DISCOVERED', 'ship to 17 Cedar Street, passport P12345678');
    expect(JSON.stringify(j.agentView())).not.toContain('P12345678');
    expect(JSON.stringify(j.agentView())).not.toContain('17 Cedar Street');
    expect(() =>
      j.advance('MATCHED', 'matched', { passport: 'P12345678' }),
    ).toThrow();
  });
});

it('COM-07: a pending stay response is never reported as a confirmed booking', async () => {
  const client = new DuffelClient(
    'duffel_test_fixture',
    async (_url, init) =>
      init.method === 'GET'
        ? empty()
        : {
            status: 200,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                data: { id: 'bkg_fixture', status: 'pending' },
              }),
          },
    { evidence: 'MOCKED' },
  );
  const out = await new DuffelBookingExecutor(client).bookStay({
    quoteId: 'quo_fixture',
    guests: input.passengers,
    idempotencyKey: 'pending-stay',
  });
  expect(out.status).toBe('UNKNOWN');
});
