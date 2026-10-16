import { parseUnits, hashTypedData, type Address, type Hex } from 'viem';
import {
  DEAL_TERMS_TYPES,
  dealDomain,
  canonical,
} from '@synq/dealroom/typed-data';
export type ReviewDeal = {
  dealId: string;
  version: number;
  termsHash: string;
  parentTermsHash: string | null;
  provenanceHash: string;
  chain: { chainId: number };
  acceptTypedData: Record<string, unknown>;
  terms: {
    title: string;
    scope: string;
    deliverables: string[];
    asset: { chainId: number; token: string; decimals: number };
    escrow: string;
    total: string;
    deposit: string;
    refundAfter: number;
    expiresAt: number;
    disputePeriodSeconds: number;
    refundPolicy: string;
    cancellation: string;
    parties: { role: string; principalId: string; wallet: string }[];
    milestones: {
      index: number;
      title: string;
      amount: string;
      deadline: number;
      acceptanceCondition: string;
      evidenceType: string;
      payee: string;
    }[];
  };
};

const same = (a: unknown, b: unknown) =>
  String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Recomputes what the page shows against the typed data the wallet will
 * sign. Any difference (amount, payee, token, escrow, chain, deadline,
 * party) blocks signing: the user signs only what they were shown.
 */
export function typedDataMismatches(d: ReviewDeal): string[] {
  const t = d.terms;
  const typed = d.acceptTypedData as {
    domain?: Record<string, unknown>;
    message?: Record<string, unknown>;
  };
  const dom = typed.domain ?? {};
  const msg = typed.message ?? {};
  const out: string[] = [];
  const units = (v: string) => parseUnits(v, t.asset.decimals).toString();
  const check = (what: string, ok: boolean) => {
    if (!ok) out.push(what);
  };
  check(
    'chain',
    same(dom.chainId, d.chain.chainId) &&
      same(t.asset.chainId, d.chain.chainId),
  );
  check('escrow', same(dom.verifyingContract, t.escrow));
  check('dealId', same(msg.dealId, d.dealId));
  check('version', same(msg.version, d.version));
  check('token', same(msg.token, t.asset.token));
  check('total', same(msg.total, units(t.total)));
  check('deposit', same(msg.deposit, units(t.deposit)));
  check('refundAfter', same(msg.refundAfter, t.refundAfter));
  check('expiresAt', same(msg.expiresAt, t.expiresAt));
  check('disputePeriod', same(msg.disputePeriod, t.disputePeriodSeconds));
  for (const role of ['client', 'freelancer', 'arbiter'] as const) {
    const shown = t.parties.find((p) => p.role.toLowerCase() === role);
    const signed = msg[role] as { wallet?: string } | undefined;
    check(role, !!shown && same(signed?.wallet, shown.wallet));
  }
  const ms = (msg.milestones ?? []) as Record<string, unknown>[];
  check('milestone count', ms.length === t.milestones.length);
  t.milestones.forEach((m, i) => {
    const x = ms[i] ?? {};
    check(
      `milestone ${i + 1}`,
      same(x.amount, units(m.amount)) &&
        same(x.deadline, m.deadline) &&
        same(x.payee, m.payee) &&
        x.title === m.title &&
        x.acceptanceCondition === m.acceptanceCondition &&
        x.evidenceType === m.evidenceType,
    );
  });
  try {
    const party = (role: string) => {
      const p = t.parties.find((x) => x.role === role)!;
      return { role, principalId: p.principalId, wallet: p.wallet as Address };
    };
    const expected = {
      domain: dealDomain(t.asset.chainId, t.escrow as Address),
      types: DEAL_TERMS_TYPES,
      primaryType: 'DealTerms' as const,
      message: {
        dealId: d.dealId,
        version: BigInt(d.version),
        parentTermsHash: (d.parentTermsHash ?? `0x${'00'.repeat(32)}`) as Hex,
        title: t.title,
        scope: t.scope,
        deliverables: t.deliverables,
        client: party('CLIENT'),
        freelancer: party('FREELANCER'),
        arbiter: party('ARBITER'),
        token: t.asset.token as Address,
        total: parseUnits(t.total, t.asset.decimals),
        deposit: parseUnits(t.deposit, t.asset.decimals),
        milestones: t.milestones.map((m) => ({
          index: BigInt(m.index),
          title: m.title,
          amount: parseUnits(m.amount, t.asset.decimals),
          deadline: BigInt(m.deadline),
          acceptanceCondition: m.acceptanceCondition,
          evidenceType: m.evidenceType,
          payee: m.payee as Address,
        })),
        refundAfter: BigInt(t.refundAfter),
        disputePeriod: BigInt(t.disputePeriodSeconds),
        refundPolicy: t.refundPolicy,
        cancellation: t.cancellation,
        expiresAt: BigInt(t.expiresAt),
        provenanceHash: d.provenanceHash as Hex,
      },
    };
    const actualTypes = {
      ...(d.acceptTypedData.types as Record<string, unknown>),
    };
    delete actualTypes.EIP712Domain;
    check('primary type', d.acceptTypedData.primaryType === 'DealTerms');
    check(
      'typed-data schema',
      canonical(actualTypes) === canonical(DEAL_TERMS_TYPES),
    );
    check('typed-data domain', canonical(dom) === canonical(expected.domain));
    check('all signed terms', canonical(msg) === canonical(expected.message));
    check(
      'terms digest',
      hashTypedData(expected).toLowerCase() === d.termsHash.toLowerCase(),
    );
  } catch {
    out.push('invalid typed data');
  }
  return out;
}
