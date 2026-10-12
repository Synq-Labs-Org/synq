/**
 * Reloadly gift card sandbox evidence (PROVIDER_SANDBOX): "buy a $10 gift
 * card" from a group chat. Router picks the Reloadly sandbox → offer →
 * reservation → Kernel grant (product, denomination, currency, country,
 * recipient ref, cap) → Temporal BookingWorkflow → order with a deterministic
 * customIdentifier → reconcile → redeem code sealed in ProfileVault → ledgered
 * receipt. Writes bounty-evidence/commerce/reloadly-sandbox-<ts>.json.
 *
 *   set -a; . ~/.synq/p11.env; set +a
 *   node --import tsx scripts/reloadly-sandbox-evidence.ts
 *
 * Env: RELOADLY_CLIENT_ID, RELOADLY_CLIENT_SECRET (sandbox), RELOADLY_ENV
 * (defaults to sandbox; anything else is refused). Optional
 * RELOADLY_GIFT_PRODUCT (default Amazon), RELOADLY_GIFT_COUNTRY (US),
 * RELOADLY_GIFT_CENTS (1000). Without credentials it records
 * BLOCKED_EXTERNAL and exits 0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  searchOffers,
  selectOffers,
} from '@synq/offer-exchange';
import {
  RELOADLY,
  RELOADLY_SANDBOX_HOST,
  ReloadlyClient,
  ReloadlyGiftCardPort,
  ReloadlyGiftCardProvider,
  giftCardSubject,
  reloadlyProviderCapability,
  settlementFabricCapabilities,
  type HttpFetch,
} from '@synq/plugin-commerce';
import {
  EnvVaultKeyProvider,
  GiftCodeVault,
  MemoryProfileStore,
  ProfileDirectory,
} from '@synq/profile-vault';
import { selectExecutionRoute } from '@synq/settlement';
import { bundleSynqWorkflows } from '../workers/workflow/src/worker.js';
import type { BookingWorkflowState } from '../workers/workflow/src/workflows/booking.js';
import { AUSD, fabricBookingWorld, usd } from './lib/fabric-booking-world.js';

const now = () => Math.floor(Date.now() / 1000);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join(process.cwd(), 'bounty-evidence', 'commerce');
const id = process.env.RELOADLY_CLIENT_ID ?? '';
const secret = process.env.RELOADLY_CLIENT_SECRET ?? '';
const environment = process.env.RELOADLY_ENV ?? 'sandbox';
const forbidden: string[] = [];

function write(report: unknown) {
  const text = JSON.stringify(
    report,
    (_, v) => (typeof v === 'bigint' ? String(v) : v),
    2,
  );
  for (const s of [id, secret, ...forbidden])
    if (s && text.includes(s))
      throw new Error('secret or gift code leaked into evidence');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `reloadly-sandbox-${stamp}.json`);
  writeFileSync(file, text + '\n');
  return file;
}

const realFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  return { status: res.status, text: () => res.text() };
};

async function main() {
  if (!id || !secret) {
    const file = write({
      generatedAt: new Date().toISOString(),
      label: 'BLOCKED_EXTERNAL',
      missing: ['RELOADLY_CLIENT_ID', 'RELOADLY_CLIENT_SECRET'].filter(
        (k) => !process.env[k],
      ),
      signup:
        'https://www.reloadly.com/registration → Developers → API settings, Test mode (sandbox) client id/secret',
      blocker: 'reports/blockers/V13-20261012T061000Z-reloadly-credentials.md',
    });
    console.log(`BLOCKED_EXTERNAL -> ${file}`);
    return;
  }
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  const client = new ReloadlyClient(
    { clientId: id, clientSecret: secret, environment },
    realFetch,
    now,
  );
  const env = {
    RELOADLY_CLIENT_ID: id,
    RELOADLY_CLIENT_SECRET: secret,
    RELOADLY_ENV: environment,
  };
  const route = selectExecutionRoute(
    {
      intentId: 'reloadly-evidence',
      product: 'GIFT_CARD',
      currency: 'USD',
      requiredChain: null,
      allowedModes: ['PROVIDER_SANDBOX'],
      categories: [
        'DIGITAL_GOODS_SANDBOX',
        'CRYPTO_COMMERCE_REAL',
        'MERCHANT_CHECKOUT',
        'HUMAN_HANDOFF',
      ],
    },
    settlementFabricCapabilities({ ...process.env, ...env }),
  );
  if (route.status !== 'SELECTED' || route.provider.providerId !== RELOADLY)
    throw new Error(`router did not select Reloadly: ${JSON.stringify(route)}`);

  const balanceBefore = await client.balance();
  const keys = new EnvVaultKeyProvider({
    SYNQ_PROFILE_VAULT_KEY: randomBytes(32).toString('base64'),
  });
  const profiles = new MemoryProfileStore();
  const { ref: recipientRef } = await new ProfileDirectory(
    profiles,
    keys,
    now,
  ).put({
    groupId: 'evidence-group',
    kind: 'RECIPIENT',
    data: {
      name: 'Evidence Recipient',
      line1: '1 Test St',
      city: 'Austin',
      postalCode: '73301',
      country: 'US',
      email: 'recipient.synqtest@example.com',
    },
  });
  const vault = new GiftCodeVault(profiles, keys, now);
  const provider = new ReloadlyGiftCardProvider(client, now);
  const world = await fabricBookingWorld({
    groupId: 'evidence-group',
    mandateId: 'gift-evidence',
    providerId: RELOADLY,
    host: RELOADLY_SANDBOX_HOST,
    capability: reloadlyProviderCapability(env),
    provider,
    port: new ReloadlyGiftCardPort(client, vault),
    rail: {
      railId: 'reloadly-sandbox-balance',
      rail: 'PROVIDER_BALANCE',
      chainId: null,
      assetId: null,
      currency: 'USD',
      auth: 'PROVIDER_API_KEY',
      kycRequired: false,
      kycSatisfied: false,
      environment: 'SANDBOX',
      status: 'READY',
    },
    perActionCapCents: 2_500,
    now,
  });
  const cents = Number(process.env.RELOADLY_GIFT_CENTS ?? 1000);
  const intent = EconomicIntentSchema.parse({
    id: `gift-ev-${now()}`,
    groupId: 'evidence-group',
    domain: 'COMMERCE',
    objective: 'buy a $10 gift card',
    subject: giftCardSubject({
      brand: process.env.RELOADLY_GIFT_PRODUCT ?? 'Amazon',
      countryCode: process.env.RELOADLY_GIFT_COUNTRY ?? 'US',
      recipientCurrency: 'USD',
      unitPriceCents: cents,
      recipientRef,
    }),
    hardConstraints: [],
    preferences: [],
    budget: { max: usd(2_500) },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    validUntil: now() + 3_600,
  });
  const graph = new ProviderCapabilityGraph([reloadlyProviderCapability(env)]);
  const search = await searchOffers({
    intent,
    providers: [provider],
    graph,
    now,
    timeoutMs: 60_000,
  });
  const sel = selectOffers({ intent, search, now: now() });
  if (!sel.ranked.length)
    throw new Error(
      `no sandbox gift card offer: ${JSON.stringify({ outcomes: search.outcomes, rejected: sel.rejected }).slice(0, 400)}`,
    );

  const temporal = await TestWorkflowEnvironment.createLocal({
    server: {
      executable: { type: 'existing-path', path: '/opt/homebrew/bin/temporal' },
      extraArgs: ['--log-level', 'error'],
    },
  });
  const taskQueue = `reloadly-evidence-${process.pid}`;
  let state: BookingWorkflowState;
  try {
    const worker = await Worker.create({
      connection: temporal.nativeConnection,
      taskQueue,
      workflowBundle: await bundleSynqWorkflows(),
      activities: world.activities,
      shutdownGraceTime: '1s',
    });
    const running = worker.run();
    const handle = await temporal.client.workflow.start('BookingWorkflow', {
      taskQueue,
      workflowId: `reloadly-evidence-${now()}`,
      args: [
        {
          bookingId: `gift-ev-${now()}`,
          groupId: 'evidence-group',
          mandateId: 'gift-evidence',
          intent,
          candidates: sel.ranked
            .slice(0, 3)
            .map((r) => ({ offer: r.offer, landed: r.landed })),
          approvedMax: usd(2_500),
          travelerRefs: [],
          approvalTimeoutSeconds: 120,
          reconcileIntervalSeconds: 5,
          activityTimeoutSeconds: 180,
        },
      ],
    });
    const query = () => handle.query<BookingWorkflowState>('bookingState');
    let hash: string | null = null;
    for (let i = 0; i < 600 && !hash; i++) {
      const s = await query();
      if (s.state === 'FAILED') break;
      hash = s.requestHash;
      if (!hash) await new Promise((r) => setTimeout(r, 200));
    }
    if (hash)
      for (const m of ['alice', 'bob'])
        await handle.signal('bookingApproval', {
          token: `fixture-verified:${m}:${hash}`,
        });
    state = (await handle.result()) as BookingWorkflowState;
    worker.shutdown();
    await running;
  } finally {
    await temporal.teardown();
  }

  const order = await world.fabric.store.findOrder(
    RELOADLY,
    state.idempotencyKey,
  );
  const receipt = order
    ? await world.fabric.store.getReceipt(`sr-${order.providerOrderId}`)
    : null;
  const providerTx =
    state.providerRef !== null
      ? await client.transaction(state.providerRef, 'USD').catch(() => null)
      : null;
  const sealed = [...profiles.records.values()].filter(
    (r) => r.kind === 'GIFT_CODE',
  );
  const report = {
    generatedAt: new Date().toISOString(),
    label:
      state.state === 'RECONCILED' ? 'PROVIDER_SANDBOX' : 'BLOCKED_EXTERNAL',
    statement: receipt?.statement ?? null,
    environment:
      'Reloadly gift card sandbox (giftcards-sandbox.reloadly.com, audience sandbox); Temporal local test server; Kernel EconomicGrantAuthority; Settlement Fabric v1.3 (memory stores)',
    approvals:
      'FIXTURE (LOCAL_FIXTURE members, EIP-712 signatures by fixture keys); not passkey-verified',
    router: {
      selected: route.provider.providerId,
      mode: route.mode,
      considered: route.considered,
    },
    offer: state.offer
      ? {
          providerRef: state.offer.providerRef,
          price: state.offer.price,
          subject: state.offer.subject.kind,
        }
      : null,
    workflow: {
      finalState: state.state,
      transitions: state.history.map((h) => `${h.from}->${h.to}`),
      grantId: state.grantId,
      reservationId: state.reservationId,
      idempotencyKey: state.idempotencyKey,
      notes: state.notes,
    },
    reloadly: {
      transactionId: state.providerRef,
      customIdentifier: ReloadlyGiftCardPort.customIdentifier(
        state.idempotencyKey,
      ),
      status: providerTx?.status ?? null,
      charged: providerTx?.amount ?? null,
      balanceBefore,
      balanceAfter: await client.balance(),
      redeemCode: sealed.length
        ? `sealed in ProfileVault (${sealed.length} GIFT_CODE record, AES-256-GCM); never posted to chat`
        : 'not stored',
    },
    fabric: {
      order,
      receipt,
      ledgers: await world.fabric.store.ledgerTotals('evidence-group'),
      reservation: state.reservationId
        ? await world.reservations.get(state.reservationId)
        : null,
      ausdFree: await world.reservations.free(
        'evidence-group',
        AUSD.canonicalAssetId,
      ),
    },
  };
  const file = write(report);
  console.log(`${state.state} transactionId=${state.providerRef} -> ${file}`);
  if (state.state !== 'RECONCILED') process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.error(
    String((e as Error).message)
      .split(secret || '\u0000')
      .join('[REDACTED]'),
  );
  process.exitCode = 1;
}
