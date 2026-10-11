import { describe, expect, it } from 'vitest';
import { WorldModelSnapshotSchema } from '@synq/schemas';
import { WorldSnapshotBuilder } from '@synq/world-model';
import { searchOffers } from '@synq/offer-exchange';
import { network, now } from '../kernel/fixtures.js';
import { GROUP } from '../brain/harness.js';
import {
  FakeProvider,
  capability,
  graphOf,
  intent,
  offer,
} from './fixtures.js';

describe('provider health in the world model', () => {
  it('OFFER-009 surfaces gated, failing and healthy providers truthfully', async () => {
    const graph = graphOf(
      capability('duffel-stays', { environment: 'SANDBOX' }),
      capability('hbx', {
        status: 'PARTNER_GATED',
        statusReason: 'partner credentials required',
      }),
      capability('serpapi'),
    );
    await searchOffers({
      intent: intent(),
      providers: [
        new FakeProvider('duffel-stays', [offer('a', 'duffel-stays', 1)]),
        new FakeProvider('serpapi', () => Promise.reject(new Error('503'))),
        new FakeProvider('hbx', []),
      ],
      graph,
      now: () => now,
    });
    const snapshot = await new WorldSnapshotBuilder({
      network,
      now: () => now,
      mainnetBroadcastAllowed: false,
      providers: graph,
    }).build({ groupId: GROUP });
    expect(() => WorldModelSnapshotSchema.parse(snapshot)).not.toThrow();
    const byId = Object.fromEntries(
      snapshot.providerHealth!.value.map((h) => [h.providerId, h]),
    );
    expect(byId['duffel-stays']).toMatchObject({
      status: 'READY',
      environment: 'SANDBOX',
      lastCheckedAt: now,
    });
    expect(byId.serpapi).toMatchObject({
      status: 'DEGRADED',
      lastError: '503',
    });
    expect(byId.hbx).toMatchObject({
      status: 'PARTNER_GATED',
      authState: 'BLOCKED',
    });
    expect(snapshot.sourceFreshness.map((s) => s.source)).toContain(
      'provider-capability-graph',
    );
  });
  it('omits the field when no provider graph is configured', async () => {
    const snapshot = await new WorldSnapshotBuilder({
      network,
      now: () => now,
      mainnetBroadcastAllowed: false,
    }).build({ groupId: GROUP });
    expect(snapshot.providerHealth).toBeUndefined();
  });
});
