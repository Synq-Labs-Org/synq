/**
 * Group trip booking proof: a real Duffel test-mode order and cancellation,
 * kept truthfully distinct from an independently handled Arc testnet
 * authorization.
 *
 *   set -a; . ~/.synq/p11.env; set +a
 *   node --import tsx scripts/duffel-booking-proof.ts
 *
 * Path A (Arc testnet, LIVE reads + signatures, nothing moved on chain):
 *   live Arc USDC balance of the group treasury → Synq treasury reservation;
 *   EIP-712 approvals by two of the three Arc testnet member wallets (keys
 *   read by path) → Kernel grant bound to the Duffel offer, amount and
 *   reservation.
 * Path B (Duffel PROVIDER_SANDBOX): two travelers held as ProfileVault refs
 *   (passports sealed, never decrypted) → Temporal BookingWorkflow
 *   (revalidate → reserve → quorum → book once → reconcile) → Duffel test
 *   order → idempotency lookup → cancellation → refund receivable. Duffel is
 *   paid from its own test balance; Arc money never reaches Duffel.
 * Also: a Duffel hold order whose lapse guard is exercised and which is then
 *   cancelled unpaid; and a Stays re-verification.
 *
 * The Arc deposit goes to a dedicated trip pool (~/.synq/trip-pool.key, mode 600).
 * Writes bounty-evidence/duffel/duffel-booking-<ts>.json (integration
 * worktree when present).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  stringToHex,
  toHex,
  type Hex,
} from 'viem';
import { CHAINS, contract } from '@synq/chain-registry/arc';
import { MEMO_ABI, extractMemoPayments } from '@synq/invoices';
import {
  EconomicGrantAuthority,
  MemoryEconomicGrantLedger,
  economicApprovalTypedData,
} from '@synq/kernel';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  searchOffers,
  selectOffers,
  toDecimal,
  type FulfillmentReceipt,
} from '@synq/offer-exchange';
import {
  DuffelBookingExecutor,
  DuffelClient,
  DuffelFlightsProvider,
  DuffelHoldExecutor,
  duffelBookingPorts,
  holdPaymentDecision,
  travelCapabilities,
  type HttpFetch,
} from '@synq/plugin-duffel';
import {
  EnvVaultKeyProvider,
  MemoryProfileStore,
  ProfileDecryptor,
  ProfileDirectory,
} from '@synq/profile-vault';
import { MemoryReservationStore } from '@synq/settlement';
import { token } from '@synq/chain-registry/arc';
import { balanceOf, connectChain } from '@synq/execution-worker/arc';
import type { Asset } from '@synq/schemas';
import { createBookingActivities } from '../workers/workflow/src/activities/booking.js';
import { BOOKING_TRAVELER_FIELDS } from '../workers/workflow/src/commerce/runtime.js';
import { bundleSynqWorkflows } from '../workers/workflow/src/worker.js';
import type { BookingWorkflowState } from '../workers/workflow/src/workflows/booking.js';

const duffelToken = process.env.DUFFEL_TEST_TOKEN ?? '';
const now = () => Math.floor(Date.now() / 1000);
const GROUP = 'grp_lisbon_trip';
const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const day = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const steps: { step: string; label: string; at: string; detail: unknown }[] =
  [];
const record = (step: string, label: string, detail: unknown) => {
  steps.push({ step, label, at: new Date().toISOString(), detail });
  console.log(`[${step}] ${label}`);
};
const realFetch: HttpFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
  return { status: res.status, headers: res.headers, text: () => res.text() };
};
const keyAt = (f: string) => {
  const k = readFileSync(join(process.env.HOME!, '.synq', f), 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};

// Synthetic test-mode travelers; passports stay sealed in the vault.
const TRAVELERS = [
  {
    givenName: 'Ada',
    familyName: 'Synqtest',
    bornOn: '1990-01-01',
    email: 'ada.synqtest@example.com',
    phone: '+442080160509',
    title: 'ms' as const,
    gender: 'f' as const,
    passportNumber: 'SYNQ00001',
    passportCountry: 'GB',
    passportExpiry: '2032-01-01',
  },
  {
    givenName: 'Ben',
    familyName: 'Synqtest',
    bornOn: '1988-05-05',
    email: 'ben.synqtest@example.com',
    phone: '+442080160510',
    title: 'mr' as const,
    gender: 'm' as const,
    passportNumber: 'SYNQ00002',
    passportCountry: 'GB',
    passportExpiry: '2031-01-01',
  },
];

const parseJson = (text: string): Record<string, unknown> => {
  try {
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

async function duffelJson(method: string, path: string, body?: unknown) {
  const res = await fetch(`https://api.duffel.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${duffelToken}`,
      'Duffel-Version': 'v2',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify({ data: body }) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  return {
    status: res.status,
    requestId: res.headers.get('x-request-id'),
    json: parseJson(text),
    text,
  };
}

async function main() {
  if (!duffelToken.startsWith('duffel_test_'))
    throw new Error('DUFFEL_TEST_TOKEN (duffel_test_) required');
  Runtime.install({ logger: new DefaultLogger('ERROR') });

  // ---- Path A: Arc testnet authorization (live reads and member signatures) ----
  const arc = await connectChain('arc-testnet');
  const usdcRef = token('arc-testnet', 'USDC');
  const ARC_USDC = {
    canonicalAssetId: `eip155:${usdcRef.chainId}/erc20:${usdcRef.address}`,
    chainId: usdcRef.chainId,
    address: usdcRef.address,
    symbol: 'USDC',
    decimals: usdcRef.decimals,
  } as unknown as Asset;
  const members = new Map([
    ['owner', privateKeyToAccount(keyAt('testnet.key'))],
    ['client', privateKeyToAccount(keyAt('arc-client.key'))],
    ['contractor', privateKeyToAccount(keyAt('arc-contractor.key'))],
  ]);
  const treasury = members.get('owner')!.address;
  const confirmed = (await balanceOf(arc, usdcRef, treasury)).baseUnits;
  const block = await arc.client.getBlockNumber();
  const reservations = new MemoryReservationStore();
  await reservations.setConfirmedBalance({
    groupId: GROUP,
    assetId: ARC_USDC.canonicalAssetId,
    confirmed,
    asOf: now(),
  });
  record('arc-treasury', 'LIVE_ARC_TESTNET (read)', {
    chainId: usdcRef.chainId,
    treasury,
    usdc: toDecimal({
      amount: String(confirmed),
      currency: 'USDC',
      decimals: 6,
    }),
    block: String(block),
  });

  // The Duffel test order is paid from Duffel's test-mode balance. Synq books it
  // against a SIMULATED provider-balance ledger, never against Arc funds.
  const SANDBOX_BALANCE = {
    canonicalAssetId: 'sandbox:duffel-test-balance/usd',
    chainId: 0,
    address: `0x${'0'.repeat(40)}`,
    symbol: 'USDC',
    decimals: 6,
  } as unknown as Asset;
  await reservations.setConfirmedBalance({
    groupId: GROUP,
    assetId: SANDBOX_BALANCE.canonicalAssetId,
    confirmed: 1_000_000_000_000n,
    asOf: now(),
  });

  const directory = {
    ledger: { isConsumed: async () => true },
    directory: {
      membershipEpoch: async (g: string) => (g === GROUP ? 1 : null),
      activeMember: async (g: string, memberId: string) => {
        const a = members.get(memberId);
        return g === GROUP && a
          ? {
              groupId: g,
              memberId,
              principalId: `arc-${memberId}`,
              principalKind: 'LOCAL_FIXTURE' as const,
              role: 'APPROVER' as const,
              signer: a.address.toLowerCase() as `0x${string}`,
              membershipEpoch: 1,
              ownerOfAccount: true,
            }
          : null;
      },
    },
  };
  const authority = new EconomicGrantAuthority({
    key: new Uint8Array(randomBytes(32)),
    reservations,
    ledger: new MemoryEconomicGrantLedger(),
    approvals: directory,
  });
  const cap = usd(200_000);
  await authority.install({
    approverKinds: ['LOCAL_FIXTURE'],
    mandateId: 'group-trip',
    groupId: GROUP,
    version: 1,
    status: 'ACTIVE',
    domains: ['FLIGHT'],
    providers: ['duffel-flights'],
    hosts: ['api.duffel.com'],
    perActionCap: cap,
    cumulativeBudget: cap,
    autoApproveMax: usd(100),
    quorum: 2,
    members: [...members.keys()],
    maxQuoteAgeSeconds: 600,
    grantTtlSeconds: 900,
    environment: 'SANDBOX',
    validUntil: now() + 86_400,
  });
  let seq = 0;
  const signedApproval = async (memberId: string, requestHash: string) => {
    const a = members.get(memberId)!;
    seq++;
    return {
      schemaVersion: 1,
      approvalId: `arc-apr-${seq}`,
      challengeId: `arc-chl-${seq}`,
      groupId: GROUP,
      memberId,
      principalId: `arc-${memberId}`,
      principalKind: 'LOCAL_FIXTURE',
      signer: a.address.toLowerCase(),
      draftDigest: requestHash,
      signature: await a.signTypedData(
        economicApprovalTypedData({
          groupId: GROUP,
          mandateId: 'group-trip',
          requestHash: requestHash as `0x${string}`,
        }),
      ),
      membershipEpoch: 1,
      verifiedAt: now(),
    };
  };
  const approvalLog: {
    memberId: string;
    signer: string;
    requestHash: string;
  }[] = [];

  // ---- Path B: Duffel test mode ----
  const client = new DuffelClient(duffelToken, realFetch, {
    evidence: 'PROVIDER_SANDBOX',
  });
  const flights = new DuffelFlightsProvider(client, now, { maxOffers: 500 });
  const executor = new DuffelBookingExecutor(client);
  const holds = new DuffelHoldExecutor(client, executor);
  const graph = new ProviderCapabilityGraph(
    travelCapabilities({ DUFFEL_TEST_TOKEN: duffelToken }),
  );

  const stays = await duffelJson('POST', '/stays/search', {
    rooms: 1,
    guests: [{ type: 'adult' }, { type: 'adult' }],
    check_in_date: day(60),
    check_out_date: day(62),
    location: {
      radius: 5,
      geographic_coordinates: { latitude: 38.7223, longitude: -9.1393 },
    },
  });
  record(
    'stays-reverify',
    stays.status === 403 ? 'BLOCKED_EXTERNAL' : 'PROVIDER_SANDBOX',
    {
      status: stays.status,
      requestId: stays.requestId,
      body: stays.text.slice(0, 160),
    },
  );

  const keys = new EnvVaultKeyProvider({
    SYNQ_PROFILE_VAULT_KEY: randomBytes(32).toString('base64'),
  });
  const profiles = new MemoryProfileStore();
  const vault = new ProfileDirectory(profiles, keys, now);
  const refs: string[] = [];
  for (const t of TRAVELERS)
    refs.push(
      (await vault.put({ groupId: GROUP, kind: 'TRAVELER', data: t })).ref,
    );
  const decryptor = new ProfileDecryptor(
    profiles,
    keys,
    now,
    'duffel-execution-worker',
  );

  const intent = EconomicIntentSchema.parse({
    id: `trip-${now()}`,
    groupId: GROUP,
    domain: 'FLIGHT',
    objective: 'Group trip: two travelers, same flight',
    subject: {
      kind: 'FLIGHT',
      segments: [{ origin: 'LHR', destination: 'JFK', departureDate: day(70) }],
      adults: 2,
      cabin: 'economy',
      checkedBags: 0,
    },
    hardConstraints: [],
    preferences: [],
    budget: { max: cap },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    maxPriceDriftBps: 0,
    validUntil: now() + 3_600,
  });
  const search = await searchOffers({
    intent,
    providers: [flights],
    graph,
    now,
    timeoutMs: 90_000,
  });
  const zz = search.offers.filter(
    (o) =>
      o.subject.kind === 'FLIGHT' &&
      o.subject.segments.every((s) => s.carrier === 'ZZ'),
  );
  const sel = selectOffers({
    intent,
    search: { ...search, offers: zz },
    now: now(),
  });
  record('search', 'PROVIDER_SANDBOX', {
    offers: search.offers.length,
    duffelAirways: zz.length,
    comparable: sel.ranked.map((r) => ({
      offer: r.offer.providerRef,
      landed: `${toDecimal(r.landed)} ${r.landed.currency}`,
      explanation: r.explanation,
    })),
    rejected: sel.rejected.slice(0, 5),
  });
  if (!sel.ranked.length) throw new Error('no comparable Duffel Airways offer');

  const receipts: FulfillmentReceipt[] = [];
  const activities = createBookingActivities({
    now,
    graph,
    providers: { 'duffel-flights': flights },
    ports: duffelBookingPorts(executor, flights),
    reservations,
    settlement: {
      treasury: async (g) => ({
        account: treasury,
        core: {
          asset: SANDBOX_BALANCE,
          free: BigInt(
            (await reservations.free(g, SANDBOX_BALANCE.canonicalAssetId)).free,
          ),
        },
        edge: { asset: SANDBOX_BALANCE, free: 0n },
      }),
      rails: [
        {
          railId: 'duffel-balance',
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
      ],
      policy: {
        allowedRails: ['PROVIDER_BALANCE'],
        allowedSourceAssets: [SANDBOX_BALANCE.canonicalAssetId],
        fxBufferBps: 100,
        conversion: {
          maxSlippageBps: 50,
          maxDepegBps: 100,
          maxReferenceAgeSeconds: 600,
          perConversionCap: 0n,
          autoApproveMax: 0n,
          verifiedVenues: [],
        },
        quoteTtlSeconds: 600,
      },
      reference: async () => null,
      reservationTtlSeconds: 3_600,
    },
    authority,
    approvals: {
      verify: async ({ tokens, requestHash, groupId }) =>
        Promise.all(
          tokens.flatMap((t) => {
            const [kind, member, hash] = t.split(':');
            if (
              kind !== 'arc-signed' ||
              !member ||
              hash !== requestHash ||
              groupId !== GROUP
            )
              return [];
            approvalLog.push({
              memberId: member,
              signer: members.get(member)!.address,
              requestHash,
            });
            return [signedApproval(member, requestHash)];
          }),
        ),
    },
    travelers: {
      resolve: async ({ groupId, refs: r, purpose }) =>
        Promise.all(
          r.map((ref) =>
            decryptor.resolve({
              groupId,
              ref,
              kind: 'TRAVELER',
              purpose,
              fields: BOOKING_TRAVELER_FIELDS,
            }),
          ),
        ),
    },
    receipts: { write: async (r) => void receipts.push(r) },
  });

  const env = await TestWorkflowEnvironment.createLocal({
    server: {
      executable: { type: 'existing-path', path: '/opt/homebrew/bin/temporal' },
      extraArgs: ['--log-level', 'error'],
    },
  });
  const taskQueue = `duffel-proof-${process.pid}`;
  const workflowId = `group-trip-${now()}`;
  let state: BookingWorkflowState;
  let pendingAfterOne: string | null = null;
  try {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle: await bundleSynqWorkflows(),
      activities,
      shutdownGraceTime: '1s',
    });
    const running = worker.run();
    const handle = await env.client.workflow.start('BookingWorkflow', {
      taskQueue,
      workflowId,
      args: [
        {
          bookingId: `trip-${now()}`,
          groupId: GROUP,
          mandateId: 'group-trip',
          intent,
          candidates: sel.ranked
            .slice(0, 3)
            .map((r) => ({ offer: r.offer, landed: r.landed })),
          approvedMax: cap,
          travelerRefs: refs,
          approvalTimeoutSeconds: 180,
          reconcileIntervalSeconds: 5,
          cancelWindowSeconds: 180,
          activityTimeoutSeconds: 120,
        },
      ],
    });
    const query = () => handle.query<BookingWorkflowState>('bookingState');
    const until = async (s: string) => {
      for (let i = 0; i < 900; i++) {
        const q = await query();
        if (q.state === s) return;
        if (q.state === 'FAILED')
          throw new Error(`workflow FAILED: ${q.notes.join(' | ')}`);
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(
        `timeout waiting for ${s}: ${JSON.stringify(await query()).slice(0, 300)}`,
      );
    };
    await until('RESERVED');
    let hash: string | null = null;
    for (let i = 0; i < 300 && !hash; i++) {
      hash = (await query()).requestHash;
      if (!hash) await new Promise((r) => setTimeout(r, 200));
    }
    await handle.signal('bookingApproval', {
      token: `arc-signed:owner:${hash}`,
    });
    await new Promise((r) => setTimeout(r, 3_000));
    pendingAfterOne = (await query()).state;
    await handle.signal('bookingApproval', {
      token: `arc-signed:client:${hash}`,
    });
    await until('RECONCILED');
    await handle.signal('bookingCancel');
    state = (await handle.result()) as BookingWorkflowState;
    worker.shutdown();
    await running;
  } finally {
    await env.teardown();
  }
  record(
    'workflow',
    'PROVIDER_SANDBOX (approvals: Arc testnet member wallet EIP-712 signatures)',
    {
      workflowId,
      finalState: state.state,
      afterOneApproval: pendingAfterOne,
      transitions: state.history.map((h) => `${h.from}->${h.to}`),
      orderId: state.providerRef,
      bookingReference: state.reference,
      grantId: state.grantId,
      reservationId: state.reservationId,
      idempotencyKey: state.idempotencyKey,
      refund: state.refund,
      approvals: approvalLog,
    },
  );

  // Idempotent lookup: the same key finds the same order; a retry would not create another.
  const lookup = await executor.findFlightOrder(state.idempotencyKey);
  const cancellations = await duffelJson(
    'GET',
    `/air/order_cancellations?order_id=${encodeURIComponent(state.providerRef ?? '')}`,
  );
  const cxl =
    ((cancellations.json.data as Record<string, unknown>[] | undefined) ??
      [])[0] ?? {};
  const order = await executor.getOrder(state.providerRef!);
  record('reconcile', 'PROVIDER_SANDBOX', {
    lookupByIdempotencyKey: lookup
      ? {
          orderId:
            lookup.status !== 'FAILED' && lookup.status !== 'UNKNOWN'
              ? lookup.providerRef
              : null,
          status: lookup.status,
        }
      : null,
    sameOrder:
      !!lookup &&
      'providerRef' in lookup &&
      lookup.providerRef === state.providerRef,
    orderStatusNow: order.status,
    cancellationId: cxl.id ?? null,
    cancellationConfirmedAt: cxl.confirmed_at ?? null,
    refundAmount: cxl.refund_amount ?? null,
    refundCurrency: cxl.refund_currency ?? null,
    refundTo: cxl.refund_to ?? null,
  });

  // Hold order: never paid after its deadline; cancelled unpaid.
  const holdSearch = await searchOffers({
    intent: { ...intent, id: `${intent.id}-hold` },
    providers: [flights],
    graph,
    now,
    timeoutMs: 90_000,
  });
  const holdOffer = holdSearch.offers.find(
    (o) =>
      o.subject.kind === 'FLIGHT' &&
      o.subject.segments.every((s) => s.carrier === 'ZZ'),
  );
  let hold: Record<string, unknown> = { status: 'NO_HOLDABLE_OFFER' };
  if (holdOffer) {
    const passengerIds = await flights.passengerIds(holdOffer.providerRef);
    const travelers = await Promise.all(
      refs.map((ref) =>
        decryptor.resolve({
          groupId: GROUP,
          ref,
          kind: 'TRAVELER',
          purpose: `hold:${intent.id}`,
          fields: BOOKING_TRAVELER_FIELDS,
        }),
      ),
    );
    const h = await holds.holdFlight({
      offerId: holdOffer.providerRef,
      passengerIds,
      passengers: travelers,
      idempotencyKey: `${intent.id}:hold`,
    });
    if (h.status === 'HELD') {
      const lapsed = holdPaymentDecision({
        hold: h,
        current: h.total,
        approved: h.total,
        now: (h.paymentRequiredBy ?? now()) + 1,
      });
      const changed = holdPaymentDecision({
        hold: h,
        current: h.total,
        approved: { ...h.total, amount: String(BigInt(h.total.amount) - 1n) },
        now: now(),
      });
      const cxlHold = await duffelJson('POST', '/air/order_cancellations', {
        order_id: h.orderId,
      });
      const cid = (cxlHold.json.data as Record<string, unknown> | undefined)
        ?.id as string | undefined;
      const confirm = cid
        ? await duffelJson(
            'POST',
            `/air/order_cancellations/${cid}/actions/confirm`,
          )
        : null;
      const after = await holds.status(h.orderId);
      hold = {
        orderId: h.orderId,
        reference: h.reference,
        total: `${toDecimal(h.total)} ${h.total.currency}`,
        paymentRequiredBy: h.paymentRequiredBy
          ? new Date(h.paymentRequiredBy * 1000).toISOString()
          : null,
        priceGuaranteeExpiresAt: h.priceGuaranteeExpiresAt
          ? new Date(h.priceGuaranteeExpiresAt * 1000).toISOString()
          : null,
        decisionAfterDeadline: lapsed,
        decisionOnChangedFare: changed.action,
        paid: false,
        cancellation: {
          status: cxlHold.status,
          id: cid ?? null,
          confirmStatus: confirm?.status ?? null,
          refundAmount:
            (confirm?.json.data as Record<string, unknown> | undefined)
              ?.refund_amount ?? null,
          body: cid ? null : cxlHold.text.slice(0, 200),
        },
        cancelledAfter: after.cancelled,
        awaitingPaymentAfter: after.awaitingPayment,
      };
    } else hold = { status: h.status, detail: 'code' in h ? h.code : h.detail };
  }
  record('hold', 'PROVIDER_SANDBOX', hold);

  // ---- Path A, executed independently: the group's Arc testnet trip deposit ----
  // Owner and client sign; the owner moves 0.002 USDC into the group's own trip
  // pool with the trip reference. Duffel never receives this money.
  const tripKey = keccak256(toHex(`trip:${GROUP}:${intent.id}`));
  // A dedicated trip pool: one custody account per fund (never the gift pool).
  const tripPoolPath = join(process.env.HOME!, '.synq', 'trip-pool.key');
  if (!existsSync(tripPoolPath))
    writeFileSync(tripPoolPath, generatePrivateKey() + '\n', { mode: 0o600 });
  const poolKey = readFileSync(tripPoolPath, 'utf8').trim();
  const pool = privateKeyToAccount(
    (poolKey.startsWith('0x') ? poolKey : `0x${poolKey}`) as Hex,
  ).address;
  const DEPOSIT = 2_000n; // 0.002 USDC (6 decimals)
  await reservations.reserve(
    {
      reservationId: 'arc-trip-deposit',
      groupId: GROUP,
      assetId: ARC_USDC.canonicalAssetId,
      amount: String(DEPOSIT),
      intentId: `${intent.id}:arc`,
      purpose: 'FLIGHT',
      settlementPlanHash: tripKey,
      expiresAt: now() + 1_800,
    },
    now(),
  );
  const depositRequestHash = keccak256(
    toHex(
      JSON.stringify({
        kind: 'SynqTripDeposit/1',
        chainId: usdcRef.chainId,
        token: usdcRef.address,
        amount: String(DEPOSIT),
        pool,
        tripKey,
      }),
    ),
  );
  const depositApprovals = [];
  for (const m of ['owner', 'client']) {
    const a = await signedApproval(m, depositRequestHash);
    depositApprovals.push({
      memberId: m,
      signer: a.signer,
      signature: a.signature,
    });
  }
  const memo = contract('arc-testnet', 'MEMO').address;
  const wallet = createWalletClient({
    account: members.get('owner')!,
    chain: {
      id: usdcRef.chainId,
      name: 'Arc Testnet',
      nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
      rpcUrls: { default: { http: [CHAINS['arc-testnet'].rpcUrls[0]!] } },
    },
    transport: http(CHAINS['arc-testnet'].rpcUrls[0]),
  });
  const depositTx = await wallet.sendTransaction({
    to: memo,
    data: encodeFunctionData({
      abi: MEMO_ABI,
      functionName: 'memo',
      args: [
        usdcRef.address,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [pool, DEPOSIT],
        }),
        tripKey,
        stringToHex(`synq-trip:${intent.id}`),
      ],
    }),
  });
  const depositReceipt = await arc.client.waitForTransactionReceipt({
    hash: depositTx,
  });
  const matched = extractMemoPayments({
    chainId: usdcRef.chainId,
    txHash: depositTx,
    logs: depositReceipt.logs,
    token: usdcRef.address,
    memoContract: memo,
  }).payments;
  const depositOk =
    depositReceipt.status === 'success' &&
    matched.length === 1 &&
    matched[0]!.amount === DEPOSIT &&
    matched[0]!.recipient.toLowerCase() === pool.toLowerCase();
  if (depositOk) await reservations.capture('arc-trip-deposit', DEPOSIT, now());
  record('arc-trip-deposit', 'LIVE_ARC_TESTNET', {
    tx: depositTx,
    explorer: `${CHAINS['arc-testnet'].explorer}/tx/${depositTx}`,
    block: String(depositReceipt.blockNumber),
    amount: '0.002 USDC',
    to: pool,
    memoId: tripKey,
    matchedTransfer: matched[0]
      ? { logIndex: matched[0].logIndex, amount: String(matched[0].amount) }
      : null,
    approvals: depositApprovals.map((a) => ({
      memberId: a.memberId,
      signer: a.signer,
    })),
    reservation: await reservations.get('arc-trip-deposit'),
    note: 'custody move into the group trip pool; it does not pay Duffel and is reconciled separately',
  });

  const reservation = state.reservationId
    ? await reservations.get(state.reservationId)
    : null;
  const free = await reservations.free(GROUP, SANDBOX_BALANCE.canonicalAssetId);
  const report = {
    generatedAt: new Date().toISOString(),
    script: 'scripts/duffel-booking-proof.ts',
    label: 'PROVIDER_SANDBOX',
    environment:
      'Duffel test mode (api.duffel.com, duffel_test_ token); Temporal local test server; Kernel EconomicGrantAuthority; Arc testnet reads and one Arc testnet deposit',
    sandboxIds: {
      duffelOrder: state.providerRef,
      bookingReference: state.reference,
      cancellation: cxl.id ?? null,
      holdOrder: hold.orderId ?? null,
      holdCancellation:
        (hold.cancellation as { id?: string } | undefined)?.id ?? null,
    },
    arcTestnet: {
      tripDepositTx: depositTx,
      explorer: `${CHAINS['arc-testnet'].explorer}/tx/${depositTx}`,
      reconciled: depositOk,
    },
    distinctions: {
      arcTreasuryReservation: {
        label:
          'Synq internal reservation against a LIVE_ARC_TESTNET balance read; captured only by the matched Arc deposit',
        reservationId: 'arc-trip-deposit',
        state: (await reservations.get('arc-trip-deposit'))?.state ?? null,
        amount: String(DEPOSIT),
        asset: ARC_USDC.canonicalAssetId,
        onChainTx: depositTx,
      },
      providerBalanceReservation: {
        label:
          'SIMULATED provider-balance ledger (Duffel test balance); not Arc',
        reservationId: state.reservationId,
        state: reservation?.state ?? null,
        amount: reservation?.amount ?? null,
        asset: SANDBOX_BALANCE.canonicalAssetId,
      },
      arcAuthorization: {
        label:
          'EIP-712 signatures by Arc testnet member wallets: 2 of 3 for the Duffel booking grant, owner+client for the Arc trip deposit',
        depositRequestHash,
        grantId: state.grantId,
        approvals: approvalLog,
      },
      providerSandboxBooking: {
        label: 'PROVIDER_SANDBOX',
        orderId: state.providerRef,
        paidFrom: 'Duffel test-mode balance (not Arc)',
      },
      realMerchantPayment:
        'none: Duffel Airways (ZZ) test orders are not real tickets and Arc USDC never reached Duffel',
      bookingConfirmation: state.reference,
      refundReceivable: {
        label:
          'PROMISED in Synq books (pendingRefunds on the provider-balance ledger), from the Duffel cancellation',
        pendingRefunds: free.pendingRefunds,
        providerRefund: cxl.refund_amount ?? null,
        refundTo: cxl.refund_to ?? null,
      },
      refundSettled:
        'no: the refund went to the Duffel test balance; nothing arrived on Arc, so nothing is credited',
    },
    receipt: receipts[0] ?? null,
    grantConsumed: state.grantId
      ? await authority.isConsumed(state.grantId)
      : false,
    profileDecrypts: decryptor.audit.map((a) => ({
      outcome: a.outcome,
      purpose: a.purpose,
      fields: a.fields,
      worker: a.worker,
    })),
    steps,
  };
  const text = JSON.stringify(
    report,
    (_, v) => (typeof v === 'bigint' ? String(v) : v),
    2,
  );
  for (const leak of [
    duffelToken,
    'Synqtest',
    'example.com',
    'SYNQ00001',
    'SYNQ00002',
    '1990-01-01',
  ])
    if (text.includes(leak))
      throw new Error('secret or traveler PII leaked into evidence');
  for (const f of ['testnet.key', 'arc-client.key', 'arc-contractor.key'])
    if (text.includes(keyAt(f).slice(2))) throw new Error('key in evidence');
  const integration = join(process.cwd(), '..', 'synq-v13', 'bounty-evidence');
  const dir = existsSync(integration)
    ? join(integration, 'duffel')
    : join(process.cwd(), 'bounty-evidence', 'duffel');
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `duffel-booking-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(file, text + '\n');
  console.log(
    `${state.state} order=${state.providerRef} cancellation=${String(cxl.id)} hold=${String(hold.orderId)} -> ${file}`,
  );
}

await main();
