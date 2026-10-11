import { z } from 'zod';
import {
  artifactHash,
  economicRequestHash,
  type EconomicExecution,
  type EconomicGrant,
  type EconomicGrantAuthority,
} from '@synq/kernel';
import type { EvidenceLabel } from '@synq/offer-exchange';
import {
  ReservationError,
  type TreasuryReservationStore,
} from './reservations.js';

export const X402RequirementSchema = z.looseObject({
  scheme: z.literal('exact'),
  network: z.string().regex(/^eip155:[0-9]+$/),
  amount: z.string().regex(/^[0-9]{1,30}$/),
  asset: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  payTo: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  maxTimeoutSeconds: z.number().int().positive().max(3_600),
  extra: z.looseObject({
    name: z.string().max(64),
    version: z.string().max(16),
  }),
});
export type X402Requirement = z.output<typeof X402RequirementSchema>;
export const X402ChallengeSchema = z.looseObject({
  x402Version: z.literal(2),
  accepts: z.array(z.unknown()).min(1).max(16),
  error: z.string().max(200).optional(),
});

export type X402Asset = { chainId: number; address: string; decimals: number };
export type X402Allowance = {
  hosts: readonly string[];
  /** CAIP-2 network -> EVM chain id. */
  networks: ReadonlyMap<string, number>;
  assets: readonly X402Asset[];
  payTo: readonly string[] | null;
  maxPerRequest: bigint;
};

export type X402Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};

/** Execution-worker port: consumes the Kernel grant, then signs EIP-3009. */
export interface X402PaymentSigner {
  readonly payer: string;
  sign(input: {
    grant: EconomicGrant;
    execution: EconomicExecution;
    requirement: X402Requirement;
    now: number;
  }): Promise<{ signature: `0x${string}`; authorization: X402Authorization }>;
}

export type X402Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; redirect: 'manual' },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export type X402Receipt = {
  resource: string;
  status: 'PAID' | 'FREE' | 'REFUSED' | 'UNSETTLED';
  label: EvidenceLabel;
  amount: string | null;
  asset: string | null;
  network: string | null;
  payTo: string | null;
  grantId: string | null;
  reservationId: string | null;
  transaction: string | null;
  reason: string | null;
  body: string | null;
};

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
const unb64 = (v: string): unknown =>
  JSON.parse(Buffer.from(v, 'base64').toString('utf8'));

const MAX_HOPS = 3;
async function fetchAllowlisted(
  f: X402Fetch,
  hosts: readonly string[],
  start: string,
  headers: Record<string, string>,
) {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!hosts.includes(new URL(url).host)) throw new Error('HOST_NOT_ALLOWED');
    const res = await f(url, { method: 'GET', headers, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    url = new URL(location, url).toString();
  }
  throw new Error('TOO_MANY_REDIRECTS');
}

export function parseChallenge(
  header: string | null,
  body: string,
): X402Requirement[] {
  let raw: unknown;
  try {
    raw = header ? unb64(header) : JSON.parse(body);
  } catch {
    throw new Error('X402_CHALLENGE_UNPARSEABLE');
  }
  const c = X402ChallengeSchema.parse(raw);
  return c.accepts.flatMap((a) => {
    const r = X402RequirementSchema.safeParse(a);
    return r.success ? [r.data] : [];
  });
}

/**
 * Bounded paid-data rail (Bible §61 P11F): challenge → allowance check →
 * edge reservation → Kernel grant → worker signature → paid retry → receipt.
 */
export async function payForResource(
  deps: {
    fetch: X402Fetch;
    authority: EconomicGrantAuthority;
    reservations: TreasuryReservationStore;
    signer: X402PaymentSigner;
    allowance: X402Allowance;
    groupId: string;
    mandateId: string;
    edgeAssetId: string;
    /** Identity layer: verified approval records bound to the Kernel request hash. */
    approvals?: (requestHash: string) => Promise<readonly unknown[]>;
    /** REAL_TESTNET only against a live facilitator on a testnet; doubles say MOCKED. */
    label: 'REAL_TESTNET' | 'MOCKED';
    now: () => number;
  },
  resource: string,
): Promise<X402Receipt> {
  const url = new URL(resource);
  const base: X402Receipt = {
    resource,
    status: 'REFUSED',
    label: 'SIMULATED',
    amount: null,
    asset: null,
    network: null,
    payTo: null,
    grantId: null,
    reservationId: null,
    transaction: null,
    reason: null,
    body: null,
  };
  const refuse = (reason: string): X402Receipt => ({ ...base, reason });
  if (!deps.allowance.hosts.includes(url.host))
    return refuse('HOST_NOT_ALLOWED');
  let first;
  try {
    first = await fetchAllowlisted(deps.fetch, deps.allowance.hosts, resource, {
      Accept: 'application/json',
    });
  } catch (e) {
    return refuse((e as Error).message.slice(0, 60));
  }
  if (first.status !== 402) {
    const body = await first.text();
    return first.status < 300
      ? { ...base, status: 'FREE', body, reason: null }
      : refuse(`HTTP_${first.status}`);
  }
  const requirements = parseChallenge(
    first.headers.get('payment-required'),
    await first.text(),
  );
  const lower = (s: string) => s.toLowerCase();
  const assetOf = (r: X402Requirement) =>
    deps.allowance.assets.find(
      (a) =>
        lower(a.address) === lower(r.asset) &&
        a.chainId === deps.allowance.networks.get(r.network),
    );
  const req = requirements.find(
    (r) =>
      deps.allowance.networks.has(r.network) &&
      assetOf(r) !== undefined &&
      (deps.allowance.payTo === null ||
        deps.allowance.payTo.map(lower).includes(lower(r.payTo))),
  );
  if (!req) return refuse('NO_ALLOWED_REQUIREMENT');
  const amount = BigInt(req.amount);
  if (amount <= 0n || amount > deps.allowance.maxPerRequest)
    return refuse('OVER_ALLOWANCE');
  const now = deps.now();
  const reqHash = artifactHash({ resource, req });
  const reservationId = `x402-${reqHash.slice(2, 26)}-${now}`;
  try {
    await deps.reservations.reserve(
      {
        reservationId,
        groupId: deps.groupId,
        assetId: deps.edgeAssetId,
        amount: String(amount),
        intentId: `x402-${reqHash.slice(2, 18)}`,
        purpose: 'X402',
        settlementPlanHash: reqHash,
        expiresAt: now + req.maxTimeoutSeconds + 60,
      },
      now,
    );
  } catch (e) {
    return refuse(
      e instanceof ReservationError ? e.code : 'RESERVATION_FAILED',
    );
  }
  const asset = assetOf(req)!;
  const execution: EconomicExecution = {
    domain: 'DATA',
    providerId: 'x402',
    host: url.host,
    offerId: resource.slice(0, 160),
    subjectHash: reqHash,
    quantity: 1,
    maxAmount: {
      amount: String(amount),
      currency: 'USDC',
      decimals: asset.decimals,
    },
    reservationId,
    reservedAssetId: deps.edgeAssetId,
    reservedAmount: String(amount),
    settlementPlanHash: reqHash,
    recipientRef: lower(req.payTo),
    payAsset: {
      chainId: asset.chainId,
      address: lower(asset.address) as `0x${string}`,
      decimals: asset.decimals,
    },
  };
  const request = {
    intentId: `x402-${reqHash.slice(2, 18)}`,
    groupId: deps.groupId,
    mandateId: deps.mandateId,
    execution,
    quoteExpiresAt: now + req.maxTimeoutSeconds,
    revalidatedAt: now,
  };
  const approvals = deps.approvals
    ? await deps.approvals(economicRequestHash(request))
    : [];
  const decision = await deps.authority.authorize(request, approvals, now);
  const scoped = {
    ...base,
    amount: req.amount,
    asset: req.asset,
    network: req.network,
    payTo: req.payTo,
    reservationId,
  };
  if (decision.status !== 'AUTHORIZED') {
    await deps.reservations.release(reservationId, 'kernel refused', now);
    return {
      ...scoped,
      reason:
        decision.status === 'REJECTED'
          ? `KERNEL_${decision.code}`
          : 'APPROVAL_REQUIRED',
    };
  }
  let signed;
  try {
    await deps.reservations.beginExecution(
      reservationId,
      { groupId: deps.groupId, settlementPlanHash: reqHash },
      now,
    );
    signed = await deps.signer.sign({
      grant: decision.grant,
      execution,
      requirement: req,
      now,
    });
  } catch (e) {
    await deps.reservations.release(reservationId, 'signer refused', now);
    return {
      ...scoped,
      grantId: decision.grant.grantId,
      reason: `SIGNER_REFUSED: ${(e as Error).message.slice(0, 120)}`,
    };
  }
  await deps.reservations.hold(reservationId, 'x402 authorization signed', now);
  let paid;
  try {
    paid = await fetchAllowlisted(deps.fetch, deps.allowance.hosts, resource, {
      Accept: 'application/json',
      'PAYMENT-SIGNATURE': b64({
        x402Version: 2,
        resource: { url: resource },
        accepted: req,
        payload: signed,
      }),
    });
  } catch (e) {
    return {
      ...scoped,
      status: 'UNSETTLED',
      grantId: decision.grant.grantId,
      reason: `${(e as Error).message.slice(0, 60)}; reservation held for recourse`,
    };
  }
  const body = await paid.text();
  const header = paid.headers.get('payment-response');
  let settlement: {
    success?: boolean;
    transaction?: string;
    txHash?: string;
    errorReason?: string;
  } = {};
  try {
    settlement = header ? (unb64(header) as typeof settlement) : {};
  } catch {
    settlement = {};
  }
  const tx = settlement.transaction ?? settlement.txHash ?? null;
  if (paid.status >= 200 && paid.status < 300 && settlement.success !== false) {
    await deps.reservations.capture(reservationId, amount, deps.now());
    return {
      ...scoped,
      status: 'PAID',
      label: deps.label,
      grantId: decision.grant.grantId,
      transaction: tx,
      body,
    };
  }
  return {
    ...scoped,
    status: 'UNSETTLED',
    grantId: decision.grant.grantId,
    reason: `HTTP_${paid.status}${settlement.errorReason ? `: ${settlement.errorReason}` : ''}; reservation held for recourse until the authorization expires`,
  };
}
