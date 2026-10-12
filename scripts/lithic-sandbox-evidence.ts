/**
 * Lithic sandbox evidence (PROVIDER_SANDBOX). Group approves a ≤$25 card
 * payment → Kernel grant → router picks the Lithic sandbox → Temporal
 * BookingWorkflow issues a virtual card whose spend limit is the granted
 * amount and simulates the merchant authorization → a second, over-mandate
 * authorization is declined by the issuer → clearing, a provider-reported
 * return (never treasury credit) and a void on a separate card → cards
 * closed. Writes bounty-evidence/commerce/lithic-sandbox-<ts>.json.
 *
 *   set -a; . ~/.synq/p11.env; set +a
 *   node --import tsx scripts/lithic-sandbox-evidence.ts
 *
 * Needs LITHIC_API_KEY (sandbox) and LITHIC_ENV=sandbox. Without a key it
 * records BLOCKED_EXTERNAL and exits 0.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  searchOffers,
  selectOffers,
} from '@synq/offer-exchange';
import {
  LITHIC,
  LITHIC_SANDBOX_HOST,
  LithicSandboxCardPort,
  LithicSandboxClient,
  SimulatedCardMerchant,
  lithicIdempotencyKey,
  lithicProviderCapability,
  redactCardData,
  settlementFabricCapabilities,
  type HttpFetch,
} from '@synq/plugin-commerce';
import { selectExecutionRoute } from '@synq/settlement';
import { bundleSynqWorkflows } from '../workers/workflow/src/worker.js';
import type { BookingWorkflowState } from '../workers/workflow/src/workflows/booking.js';
import { USDC, fabricBookingWorld, usd } from './lib/fabric-booking-world.js';

const now = () => Math.floor(Date.now() / 1000);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join(process.cwd(), 'bounty-evidence', 'commerce');
const key = process.env.LITHIC_API_KEY ?? '';

function write(report: unknown, pans: readonly string[] = []) {
  const text = JSON.stringify(
    report,
    (_, v) => (typeof v === 'bigint' ? String(v) : v),
    2,
  );
  if ((key && text.includes(key)) || pans.some((p) => text.includes(p)))
    throw new Error('secret or PAN leaked into evidence');
  if (/\b\d{13,19}\b/.test(text))
    throw new Error('PAN-shaped number in evidence');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `lithic-sandbox-${stamp}.json`);
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
  if (!key) {
    const file = write({
      generatedAt: new Date().toISOString(),
      label: 'BLOCKED_EXTERNAL',
      missing: ['LITHIC_API_KEY'],
      signup:
        'https://app.lithic.com/signup (sandbox key: Dashboard > API keys)',
    });
    console.log(`BLOCKED_EXTERNAL -> ${file}`);
    return;
  }
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  const client = new LithicSandboxClient(
    { apiKey: key, environment: process.env.LITHIC_ENV },
    realFetch,
  );
  const env = { LITHIC_API_KEY: key, LITHIC_ENV: process.env.LITHIC_ENV };
  const route = selectExecutionRoute(
    {
      intentId: 'lithic-evidence',
      product: 'VIRTUAL_CARD_AUTHORIZATION',
      currency: 'USD',
      requiredChain: null,
      allowedModes: ['PROVIDER_SANDBOX'],
      categories: ['CARD_NETWORK_SANDBOX', 'HUMAN_HANDOFF'],
    },
    settlementFabricCapabilities(env),
  );
  if (route.status !== 'SELECTED' || route.provider.providerId !== LITHIC)
    throw new Error(`router did not select Lithic: ${JSON.stringify(route)}`);

  const merchant = new SimulatedCardMerchant(
    { descriptor: 'SYNQ TEST CAFE', title: 'Team lunch', priceCents: 1_840 },
    now,
  );
  const world = await fabricBookingWorld({
    groupId: 'evidence-group',
    mandateId: 'card-evidence',
    providerId: LITHIC,
    host: LITHIC_SANDBOX_HOST,
    capability: lithicProviderCapability(env),
    provider: merchant,
    port: new LithicSandboxCardPort(client),
    rail: {
      railId: 'lithic-sandbox-card',
      rail: 'SCOPED_CARD',
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
  const intent = EconomicIntentSchema.parse({
    id: `card-ev-${now()}`,
    groupId: 'evidence-group',
    domain: 'COMMERCE',
    objective: 'pay for team lunch, group approved up to $25',
    subject: {
      kind: 'PRODUCT',
      title: 'Team lunch',
      brand: 'SYNQ TEST CAFE',
      model: 'merchant-payment',
      quantity: 1,
    },
    hardConstraints: [],
    preferences: [],
    budget: { max: usd(2_500) },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    validUntil: now() + 3_600,
  });
  const graph = new ProviderCapabilityGraph([lithicProviderCapability(env)]);
  const sel = selectOffers({
    intent,
    search: await searchOffers({ intent, providers: [merchant], graph, now }),
    now: now(),
  });
  if (!sel.ranked.length) throw new Error('no candidate');

  const temporal = await TestWorkflowEnvironment.createLocal({
    server: {
      executable: { type: 'existing-path', path: '/opt/homebrew/bin/temporal' },
      extraArgs: ['--log-level', 'error'],
    },
  });
  const taskQueue = `lithic-evidence-${process.pid}`;
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
      workflowId: `lithic-evidence-${now()}`,
      args: [
        {
          bookingId: `card-ev-${now()}`,
          groupId: 'evidence-group',
          mandateId: 'card-evidence',
          intent,
          candidates: sel.ranked.map((r) => ({
            offer: r.offer,
            landed: r.landed,
          })),
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
      hash = (await query()).requestHash;
      if (!hash) await new Promise((r) => setTimeout(r, 200));
    }
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
  if (state.state !== 'RECONCILED' || !state.reference || !state.providerRef)
    throw new Error(`workflow ended ${state.state}: ${state.notes.join('; ')}`);

  const cardToken = state.reference;
  const pans: string[] = [];
  const { card, secret } = await client.getCard(cardToken);
  if (!secret) throw new Error('no PAN access in sandbox');
  // Evidence guard only: compare against the PAN without ever storing it.
  pans.push(secret.reveal(client));
  const overMandate = await client.simulateAuthorization(secret, {
    amountCents: 1_000,
    descriptor: 'SYNQ TEST CAFE',
  });
  const settle = async (token: string, want: string) => {
    let t = await client.getTransaction(token);
    for (let i = 0; i < 30 && t.status !== want; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      t = await client.getTransaction(token);
    }
    return t;
  };
  await client.simulateClearing(state.providerRef);
  const cleared = await settle(state.providerRef, 'SETTLED');
  const returnToken = await client.simulateReturn(secret, {
    amountCents: 500,
    descriptor: 'SYNQ TEST CAFE',
  });
  const order = await world.fabric.store.findOrder(
    LITHIC,
    state.idempotencyKey,
  );
  const providerRefund = await world.fabric.recordProviderRefund({
    providerOrderId: order!.providerOrderId,
    refundId: `lithic-return-${returnToken}`,
    amount: usd(500),
    providerRef: returnToken,
  });
  const closed = await client.setCardState(cardToken, 'CLOSED');

  // Void on a separate single-purpose card.
  const voidCard = await client.createCard({
    spendLimitCents: 100,
    duration: 'FOREVER',
    memo: `synq:void-demo:${state.idempotencyKey}`,
    idempotencyKey: lithicIdempotencyKey(`void-demo:${state.idempotencyKey}`),
  });
  if (voidCard.secret) pans.push(voidCard.secret.reveal(client));
  const voidAuth = await client.simulateAuthorization(voidCard.secret!, {
    amountCents: 100,
    descriptor: 'SYNQ VOID DEMO',
  });
  await client.simulateVoid(voidAuth.transactionToken!);
  const voided = await settle(voidAuth.transactionToken!, 'VOIDED');
  await client.setCardState(voidCard.card.token, 'CLOSED');

  const receipt = await world.fabric.store.getReceipt(
    `sr-${order!.providerOrderId}`,
  );
  const txs = await client.listTransactions(cardToken);
  const report = {
    generatedAt: new Date().toISOString(),
    label: 'PROVIDER_SANDBOX',
    statement: receipt?.statement,
    environment:
      'Lithic sandbox (sandbox.lithic.com/v1); Temporal local test server; Kernel EconomicGrantAuthority; Settlement Fabric v1.3 (memory stores)',
    approvals:
      'FIXTURE (LOCAL_FIXTURE members, EIP-712 signatures by fixture keys); not passkey-verified',
    merchant:
      'SIMULATED merchant quote (SYNQ TEST CAFE, $18.40); the card network events are Lithic sandbox simulations',
    router: {
      selected: route.provider.providerId,
      mode: route.mode,
      considered: route.considered,
    },
    workflow: {
      finalState: state.state,
      transitions: state.history.map((h) => `${h.from}->${h.to}`),
      grantId: state.grantId,
      reservationId: state.reservationId,
      idempotencyKey: state.idempotencyKey,
    },
    lithic: {
      cardToken,
      cardLastFour: card.lastFour,
      spendLimitCents: card.spendLimit,
      spendLimitDuration: card.spendLimitDuration,
      approvedAuthorization: {
        token: state.providerRef,
        cleared: cleared.status,
      },
      overMandateAuthorization: {
        token: overMandate.transactionToken,
        approved: overMandate.approved,
        result: overMandate.message,
      },
      returnToken,
      cardStateAfter: closed.state,
      voidDemo: {
        cardToken: voidCard.card.token,
        authorizationToken: voidAuth.transactionToken,
        status: voided.status,
      },
      transactions: txs,
    },
    fabric: {
      order,
      receipt,
      providerReportedRefund: providerRefund,
      ledgers: await world.fabric.store.ledgerTotals('evidence-group'),
      reservation: await world.reservations.get(state.reservationId!),
      usdcFree: await world.reservations.free(
        'evidence-group',
        USDC.canonicalAssetId,
      ),
    },
  };
  const file = write(report, pans);
  console.log(
    `${state.state} card=${cardToken} auth=${state.providerRef} decline=${overMandate.transactionToken}(${overMandate.message}) -> ${file}`,
  );
}

try {
  await main();
} catch (e) {
  console.error(redactCardData(String((e as Error).stack), key));
  process.exitCode = 1;
}
