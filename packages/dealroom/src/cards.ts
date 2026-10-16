import {
  InteractiveCardSchema,
  arcCardBase,
  cardDecimal,
  cardLine,
  cardRef,
  type ArcCardContext,
  type CardOf,
} from '@synq/schemas';
import type { Evidence, MilestoneStatus, PartyRole } from './schema.js';
import type { DealView } from './service.js';

/*
 * Deal Room → canonical cards. Pure: amounts are the terms' integer base
 * units rendered exactly at the asset's decimals; signatures are read only
 * for the current version and terms hash, so a signature on an older
 * version never shows as signed.
 */

type SignatureState = 'SIGNED' | 'PENDING' | 'DECLINED';

function signatureOf(view: DealView, role: PartyRole): SignatureState {
  const v = view.current;
  const mine = view.signatures
    .filter(
      (s) =>
        s.role === role &&
        s.version === v.version &&
        s.termsHash.toLowerCase() === v.termsHash.toLowerCase(),
    )
    .sort((a, b) => a.signedAt - b.signedAt)
    .at(-1);
  return !mine ? 'PENDING' : mine.decision === 'ACCEPT' ? 'SIGNED' : 'DECLINED';
}

/** The current agreement version of a deal as a DEAL_PROPOSAL card. */
export function dealProposalCard(
  view: DealView,
  ctx: ArcCardContext,
): CardOf<'DEAL_PROPOSAL'> {
  const t = view.current.terms;
  const signatures = {
    client: signatureOf(view, 'CLIENT'),
    freelancer: signatureOf(view, 'FREELANCER'),
  };
  return InteractiveCardSchema.parse({
    ...arcCardBase(
      ctx,
      view.deal.updatedAt,
      'deal',
      view.deal.dealId,
      view.current.version,
      view.deal.status,
      signatures.client,
      signatures.freelancer,
    ),
    type: 'DEAL_PROPOSAL',
    chainId: t.asset.chainId,
    dealId: cardRef(view.deal.dealId),
    version: view.current.version,
    termsHash: view.current.termsHash,
    title: cardLine(t.title, 200),
    status: view.deal.status,
    client: {
      label: cardLine(t.client.displayName, 120),
      address: t.client.wallet,
    },
    freelancer: {
      label: cardLine(t.freelancer.displayName, 120),
      address: t.freelancer.wallet,
    },
    total: {
      amount: cardDecimal(t.total, t.asset.decimals),
      symbol: t.asset.symbol,
    },
    milestoneCount: t.milestones.length,
    signatures,
    escrow: view.deal.escrow?.escrow ?? t.escrow,
    expiresAt: t.expiresAt,
  }) as CardOf<'DEAL_PROPOSAL'>;
}

const STATE: Record<MilestoneStatus, CardOf<'ESCROW_MILESTONE'>['state']> = {
  PENDING: 'PENDING',
  FUNDED: 'FUNDED',
  DELIVERED: 'DELIVERED',
  ACCEPTED: 'ACCEPTED',
  DISPUTED: 'DISPUTED',
  REFUNDING: 'REFUNDING',
  SETTLED: 'RELEASED',
  REFUNDED: 'REFUNDED',
};

function evidenceLabel(e: Evidence): string {
  if (e.type === 'GITHUB_PR' && e.repo && e.prNumber)
    return `${e.repo} PR #${e.prNumber}`;
  if (e.type === 'GITHUB_COMMIT' && e.repo && e.commitSha)
    return `${e.repo} @ ${e.commitSha.slice(0, 7)}`;
  if (e.sha256) return `File sha256 ${e.sha256.slice(0, 12)}`;
  return 'Delivery evidence';
}

/** One milestone of a deal as an ESCROW_MILESTONE card. */
export function escrowMilestoneCard(
  view: DealView,
  index: number,
  ctx: ArcCardContext,
): CardOf<'ESCROW_MILESTONE'> {
  const t = view.current.terms;
  const m = t.milestones.find((x) => x.index === index);
  if (!m)
    throw new RangeError(`deal ${view.deal.dealId} has no milestone ${index}`);
  const state = view.deal.milestones.find((x) => x.index === index);
  const status = STATE[state?.status ?? 'PENDING'];
  const delivered = view.attestations
    .filter((a) => a.milestone === index && a.kind === 'DELIVERED')
    .sort((a, b) => a.at - b.at)
    .at(-1);
  const dispute =
    view.deal.dispute && view.deal.dispute.milestone === index
      ? view.deal.dispute
      : null;
  const txs = [
    ...(view.deal.escrow?.fundingTxs ?? []).map((hash) => ({
      label: 'Escrow funded',
      hash,
    })),
    ...(dispute?.txs ?? []).map((hash) => ({ label: 'Dispute raised', hash })),
    ...(state?.txs ?? []).map((x) => ({
      label: cardLine(x.label, 60),
      hash: x.hash,
    })),
  ].slice(-4);
  const observed = Math.max(
    view.deal.updatedAt,
    delivered?.at ?? 0,
    dispute?.raisedAt ?? 0,
  );
  return InteractiveCardSchema.parse({
    ...arcCardBase(
      ctx,
      observed,
      'milestone',
      view.deal.dealId,
      index,
      status,
      txs.length,
    ),
    type: 'ESCROW_MILESTONE',
    chainId: t.asset.chainId,
    dealId: cardRef(view.deal.dealId),
    termsHash: view.current.termsHash,
    escrowDealId: view.deal.escrow?.escrowDealId ?? null,
    escrow: view.deal.escrow?.escrow ?? null,
    milestoneIndex: index,
    milestoneCount: t.milestones.length,
    title: cardLine(m.title, 200),
    amount: {
      amount: cardDecimal(m.amount, t.asset.decimals),
      symbol: t.asset.symbol,
    },
    state: status,
    deadline: m.deadline,
    evidence: delivered
      ? {
          type: delivered.evidence?.type ?? m.evidenceType,
          hash: delivered.evidenceHash,
          label: cardLine(
            delivered.evidence
              ? evidenceLabel(delivered.evidence)
              : 'Delivery evidence',
            160,
          ),
        }
      : null,
    disputeDeadline: dispute?.deadline ?? null,
    transactions: txs,
  }) as CardOf<'ESCROW_MILESTONE'>;
}
