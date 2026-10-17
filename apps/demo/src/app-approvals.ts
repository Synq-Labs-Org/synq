import { createHash } from 'node:crypto';
import { formatUnits, getAddress, type Hex } from 'viem';
import { z } from 'zod';
import {
  SafeActionViewSchema,
  safeActionApprovalTypedData,
  safeActionTypedData,
} from '@synq/kernel/arc-safe-action';
import {
  intentApprovalTypedData,
  mandateTypedData,
} from '@synq/kernel/arc-payment-data';
import {
  mandateFromPolicy,
  policyTypedData,
} from '@synq/allocations/policy-data';
import {
  WorkspaceError,
  type PostgresWorkspaceStore,
  type WorkspaceVaultSetups,
} from '@synq/workspaces';
import {
  PayoutViewSchema,
  describeFinanceEdit,
  payoutIntent,
  payoutMandate,
} from '@synq/workspaces/finance-contracts';
import { RevenuePolicyViewSchema } from '@synq/workspaces/revenue-contracts';
import type { WorkspaceFinance } from '@synq/workspaces/finance';
import type { WorkspacePayouts } from '@synq/workspaces/payouts';
import type { WorkspaceGovernance } from '@synq/workspaces/governance';
import type { WorkspaceRevenue } from '@synq/workspaces/revenue';
import {
  commercialPolicyTypedData,
  type WorkspaceOffers,
} from '@synq/workspaces/offers';

/*
 * The approvals inbox: every request across the caller's workspaces that still
 * needs their wallet's signature, with the exact EIP-712 payloads to sign. It
 * is a view over the existing /v2 signing flows; submitting forwards the
 * signatures to the same services, which verify the signer themselves.
 */

export type ApprovalSources = {
  setups?: { service: WorkspaceVaultSetups; wake(): void };
  finance?: WorkspaceFinance;
  payouts?: { service: WorkspacePayouts; wake(): void };
  governance?: { service: WorkspaceGovernance; wake(): void };
  revenue?: WorkspaceRevenue;
  offers?: WorkspaceOffers;
};

type Purpose =
  | 'VAULT_SETUP'
  | 'VAULT_ACTION'
  | 'PAYOUT'
  | 'FINANCE_CHANGE'
  | 'REVENUE_POLICY'
  | 'CIRCLE_REFUND'
  | 'COMMERCIAL_POLICY';
type Step = { label: string; typedData: Record<string, unknown> };
type Pending = {
  item: {
    requestId: string;
    workspaceId: string;
    workspaceName: string;
    purpose: Purpose;
    summary: string;
    amount: ReturnType<typeof usdc> | null;
    recipientHint: string | null;
    approvals: number;
    threshold: number;
    expiresAt: string | null;
  };
  enforcedBy: string;
  steps: Step[];
  submit: (signatures: Hex[]) => Promise<{ approvals: number; done: boolean }>;
};

const usdc = (units: bigint | string) => ({
  assetId: 'arc-testnet:USDC',
  symbol: 'USDC',
  chainId: 5042002,
  decimals: 6,
  units: String(units),
});
const show = (units: bigint | string) => formatUnits(BigInt(units), 6);
const hint = (a: string) => {
  const w = getAddress(a);
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
};
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
/** JSON-safe typed data (bigints as decimal strings), as wallets expect it. */
const plain = (data: unknown) =>
  JSON.parse(
    JSON.stringify(data, (_k, v: unknown) =>
      typeof v === 'bigint' ? String(v) : v,
    ),
  ) as Record<string, unknown>;
/** A stable id per request, so the same pending item keeps its id across reads. */
export function approvalId(
  purpose: string,
  workspaceId: string,
  source: string,
) {
  const h = createHash('sha256')
    .update(`${purpose}|${workspaceId}|${source}`)
    .digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class AppApprovals {
  constructor(
    private readonly store: PostgresWorkspaceStore,
    private readonly sources: ApprovalSources,
  ) {}

  private async optional<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (error) {
      // A workspace without that feature (or not yet active) has nothing pending.
      if (error instanceof WorkspaceError) return null;
      throw error;
    }
  }

  /** Everything waiting for this wallet, newest workspaces first. */
  async pending(principalId: string, wallet: string): Promise<Pending[]> {
    const now = this.store.now();
    const owned = (await this.store.listWithRoles(principalId)).filter(
      (w) => w.role === 'OWNER',
    );
    const out: Pending[] = [];
    for (const { workspace: w } of owned) {
      const base = { workspaceId: w.id, workspaceName: w.displayName };
      const threshold = w.threshold ?? 1;
      const { setups, finance, payouts, governance, revenue, offers } =
        this.sources;

      if (setups && w.status === 'LAUNCHING') {
        const v = await this.optional(() =>
          setups.service.view(w.id, principalId),
        );
        if (
          v &&
          v.state === 'AWAITING_SIGNATURES' &&
          v.setup.owners.some((o) => same(o, wallet)) &&
          !v.signedOwners.some((o) => same(o, wallet)) &&
          v.setup.expiresAt > now
        )
          out.push({
            item: {
              ...base,
              requestId: approvalId('VAULT_SETUP', w.id, v.setupHash),
              purpose: 'VAULT_SETUP',
              summary: `Create the workspace vault: ${v.setup.threshold} of ${v.setup.owners.length} owners must sign every payment.`,
              amount: null,
              recipientHint: null,
              approvals: v.signedOwners.length,
              threshold: v.setup.owners.length,
              expiresAt: iso(v.setup.expiresAt),
            },
            enforcedBy: 'Safe vault factory on Arc testnet',
            steps: [
              { label: 'Approve the vault setup', typedData: v.typedData },
            ],
            submit: async ([s]) => {
              const p = await setups.service.approve(w.id, principalId, s!);
              setups.wake();
              return {
                approvals: p?.signedOwners.length ?? 0,
                done: p?.state !== 'AWAITING_SIGNATURES',
              };
            },
          });
      }
      if (offers && w.kind === 'BUSINESS') {
        const list = await this.optional(() =>
          offers.policies(w.id, principalId),
        );
        for (const v of list ?? []) {
          if (v.state !== 'REVIEW') continue;
          out.push({
            item: {
              ...base,
              requestId: approvalId('COMMERCIAL_POLICY', w.id, v.policyHash),
              purpose: 'COMMERCIAL_POLICY',
              summary: `Sales policy version ${v.version}: ${v.policy.catalog.length} catalog items, discounts up to ${v.policy.maxDiscountBps / 100}%`,
              amount: null,
              recipientHint: null,
              approvals: 0,
              threshold: 1,
              expiresAt: null,
            },
            enforcedBy:
              'Synq offer validator (deterministic checks on every offer)',
            steps: [
              {
                label: 'Approve the sales policy',
                typedData: plain(
                  commercialPolicyTypedData(w.id, v.version, v.policyHash),
                ),
              },
            ],
            submit: async ([s]) => {
              const r = await offers.approvePolicy(
                w.id,
                principalId,
                v.version,
                s!,
              );
              return { approvals: 1, done: r.state === 'ACTIVE' };
            },
          });
        }
      }
      if (w.status !== 'ACTIVE') continue;

      if (finance) {
        const view = await this.optional(() => finance.list(w.id, principalId));
        for (const pend of view?.pending ?? []) {
          const c = await this.optional(() =>
            finance.change(w.id, principalId, pend.hash as Hex),
          );
          if (
            !c ||
            c.state !== 'PENDING' ||
            c.change.expiresAt <= now ||
            c.signedBy.some((o: string) => same(o, wallet))
          )
            continue;
          out.push({
            item: {
              ...base,
              requestId: approvalId('FINANCE_CHANGE', w.id, c.hash),
              purpose: 'FINANCE_CHANGE',
              summary: describeFinanceEdit(c.change.edit),
              amount: null,
              recipientHint: null,
              approvals: c.signedBy.length,
              threshold,
              expiresAt: iso(c.change.expiresAt),
            },
            enforcedBy: 'Workspace finance settings (owner quorum)',
            steps: [
              {
                label: 'Approve this finance change',
                typedData: plain(c.typedData),
              },
            ],
            submit: async ([s]) => {
              const r = await finance.approve(
                w.id,
                principalId,
                c.hash as Hex,
                s!,
              );
              return {
                approvals: r.signedBy.length,
                done: r.state === 'APPLIED',
              };
            },
          });
        }
      }

      if (payouts) {
        const list = await this.optional(() =>
          payouts.service.list(w.id, principalId),
        );
        for (const raw of list ?? []) {
          const p = PayoutViewSchema.parse(raw);
          if (
            p.state !== 'REVIEW' ||
            p.data.approval.deadline <= now ||
            p.signedBy.some((o) => same(o, wallet))
          )
            continue;
          const mandate = same(p.data.primaryOwner, wallet) && !p.mandateSigned;
          out.push({
            item: {
              ...base,
              requestId: approvalId('PAYOUT', w.id, p.data.id),
              purpose: 'PAYOUT',
              summary: `Pay ${show(p.data.amount)} USDC to ${hint(p.data.recipient)} for ${p.data.purpose}`,
              amount: usdc(p.data.amount),
              recipientHint: hint(p.data.recipient),
              approvals: p.signedBy.length,
              threshold,
              expiresAt: iso(p.data.approval.deadline),
            },
            enforcedBy:
              p.data.route === 'SAFE_QUORUM'
                ? 'Workspace Safe (full owner quorum)'
                : 'Workspace vault policy guard (allowlist and caps)',
            steps: [
              ...(mandate
                ? [
                    {
                      label: 'Approve the payment mandate',
                      typedData: plain(mandateTypedData(payoutMandate(p.data))),
                    },
                  ]
                : []),
              {
                label: 'Approve this payment',
                typedData: plain(
                  intentApprovalTypedData(
                    payoutIntent(p.data),
                    p.data.approval,
                  ),
                ),
              },
            ],
            submit: async (sigs) => {
              const r = PayoutViewSchema.parse(
                await payouts.service.approve(w.id, principalId, p.data.id, {
                  signature: sigs.at(-1)!,
                  ...(mandate ? { mandateSignature: sigs[0]! } : {}),
                }),
              );
              payouts.wake();
              return {
                approvals: r.signedBy.length,
                done: r.state !== 'REVIEW',
              };
            },
          });
        }
      }

      if (governance) {
        const list = await this.optional(() =>
          governance.service.list(w.id, principalId),
        );
        for (const raw of list ?? []) {
          const v = SafeActionViewSchema.parse(raw);
          const a = v.action;
          if (
            v.state !== 'REVIEW' ||
            a.expiresAt <= now ||
            v.signedBy.some((o) => same(o, wallet))
          )
            continue;
          const amount = 'amount' in a ? String(a.amount) : null;
          const recipient = 'recipient' in a ? String(a.recipient) : null;
          const purpose: Purpose =
            a.kind === 'REFUND_MEMBER'
              ? 'CIRCLE_REFUND'
              : a.kind === 'PAY_VENDOR'
                ? 'PAYOUT'
                : 'VAULT_ACTION';
          const summary =
            a.kind === 'PAY_VENDOR' && amount && recipient
              ? `Vault transfer of ${show(amount)} USDC to ${hint(recipient)}`
              : a.kind === 'REFUND_MEMBER' && amount && recipient
                ? `Refund ${show(amount)} USDC to ${hint(recipient)}`
                : a.kind.startsWith('TREASURY')
                  ? 'Treasury swap step'
                  : a.kind.endsWith('CAPS')
                    ? 'Change the vault payment limits'
                    : 'Change the vault vendor allowlist';
          out.push({
            item: {
              ...base,
              requestId: approvalId(purpose, w.id, a.id),
              purpose,
              summary,
              amount: amount ? usdc(amount) : null,
              recipientHint: recipient ? hint(recipient) : null,
              approvals: v.signedBy.length,
              threshold,
              expiresAt: iso(a.expiresAt),
            },
            enforcedBy: 'Workspace Safe and its policy guard',
            steps: [
              {
                label: 'Approve this vault action',
                typedData: plain(safeActionApprovalTypedData(a)),
              },
              {
                label: 'Sign the Safe transaction',
                typedData: plain(safeActionTypedData(a)),
              },
            ],
            submit: async ([approvalSignature, safeSignature]) => {
              if (!safeSignature)
                throw new WorkspaceError('SIGNATURES_REQUIRED', 400);
              const r = SafeActionViewSchema.parse(
                await governance.service.approve(w.id, principalId, a.id, {
                  approvalSignature: approvalSignature!,
                  safeSignature,
                }),
              );
              governance.wake();
              return {
                approvals: r.signedBy.length,
                done: r.state !== 'REVIEW',
              };
            },
          });
        }
      }

      if (revenue) {
        const list = await this.optional(() => revenue.list(w.id, principalId));
        for (const raw of list ?? []) {
          const v = RevenuePolicyViewSchema.parse(raw);
          if (
            v.state !== 'REVIEW' ||
            v.policy.validUntil <= now ||
            v.signedBy.some((o) => same(o, wallet))
          )
            continue;
          out.push({
            item: {
              ...base,
              requestId: approvalId('REVENUE_POLICY', w.id, v.id),
              purpose: 'REVENUE_POLICY',
              summary: `Revenue split policy, version ${v.policy.version}`,
              amount: null,
              recipientHint: null,
              approvals: v.signedBy.length,
              threshold,
              expiresAt: iso(v.policy.validUntil),
            },
            enforcedBy: 'Workspace Safe owner quorum and the split worker',
            steps: [
              {
                label: 'Approve the split policy',
                typedData: plain(policyTypedData(v.policy)),
              },
              {
                label: 'Approve the payment mandate it creates',
                typedData: plain(mandateTypedData(mandateFromPolicy(v.policy))),
              },
            ],
            submit: async ([policy, mandate]) => {
              if (!mandate)
                throw new WorkspaceError('SIGNATURES_REQUIRED', 400);
              const r = RevenuePolicyViewSchema.parse(
                await revenue.approve(w.id, principalId, v.id, {
                  policy: policy!,
                  mandate,
                }),
              );
              return {
                approvals: r.signedBy.length,
                done: r.state !== 'REVIEW',
              };
            },
          });
        }
      }
    }
    return out;
  }

  async find(principalId: string, wallet: string, requestId: string) {
    const found = (await this.pending(principalId, wallet)).find(
      (p) => p.item.requestId === requestId,
    );
    // Signed already, expired, not yours and nonexistent look the same.
    if (!found) throw new WorkspaceError('NOT_FOUND', 404);
    return found;
  }

  async sign(
    principalId: string,
    wallet: string,
    requestId: string,
    raw: unknown,
  ) {
    const body = z
      .strictObject({
        signatures: z
          .array(z.string().regex(/^0x[0-9a-fA-F]{130}$/))
          .min(1)
          .max(3),
      })
      .parse(raw);
    const p = await this.find(principalId, wallet, requestId);
    if (body.signatures.length !== p.steps.length)
      throw new WorkspaceError('SIGNATURES_REQUIRED', 400);
    const r = await p.submit(body.signatures as Hex[]);
    return {
      status: r.done ? ('READY' as const) : ('RECORDED' as const),
      approvals: r.approvals,
      threshold: p.item.threshold,
    };
  }
}
