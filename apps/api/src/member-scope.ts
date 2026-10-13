import { createHash, timingSafeEqual } from 'node:crypto';
import type { createSendMemberAccess } from './send-access.js';

export type MemberAccess = Pick<
  ReturnType<typeof createSendMemberAccess>,
  'session'
>;
export type MemberCaller = {
  kind: 'MEMBER';
  groupId: string;
  memberId: string;
  principalId: string;
  signer: string;
  scope: 'SEND_READ_PREVIEW' | 'MEMBER_CONTRIBUTE';
};
export type Caller = { kind: 'ADMIN' } | MemberCaller;

const digest = (v: string) => createHash('sha256').update(v).digest();

/**
 * Operator admin token, or a short-lived member session minted from an EIP-712
 * signature by the member's active signer and bound to exactly one group.
 * Member sessions never satisfy admin-only routes, which compare the admin token.
 */
export async function callerFor(
  header: string | undefined,
  groupId: string,
  deps: { adminToken: string | null; memberAccess?: MemberAccess },
): Promise<Caller | null> {
  if (
    deps.adminToken &&
    timingSafeEqual(digest(header ?? ''), digest(`Bearer ${deps.adminToken}`))
  )
    return { kind: 'ADMIN' };
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !deps.memberAccess) return null;
  const s = await deps.memberAccess.session(token, groupId);
  return s ? { kind: 'MEMBER', ...s } : null;
}

/** Members may only move funds from their own signer into their own group. */
export const mayFund = (
  caller: Caller | null,
  sender: string,
): caller is Caller =>
  !!caller &&
  (caller.kind === 'ADMIN' ||
    (caller.scope === 'MEMBER_CONTRIBUTE' &&
      caller.signer.toLowerCase() === sender.toLowerCase()));

export const mayPropose = (caller: Caller | null): caller is Caller =>
  !!caller && (caller.kind === 'ADMIN' || caller.scope === 'MEMBER_CONTRIBUTE');

/**
 * Member scopes admitted to the group world projection. The projection holds
 * group-level state only (member ids, signer addresses, mandates, approvals,
 * kernel and workflow status), no profile PII or credentials; any future scope
 * must be added here explicitly to read it.
 */
export const WORLD_READ_SCOPES: ReadonlySet<MemberCaller['scope']> = new Set([
  'SEND_READ_PREVIEW',
  'MEMBER_CONTRIBUTE',
]);

export const mayReadWorld = (caller: Caller | null): caller is Caller =>
  !!caller && (caller.kind === 'ADMIN' || WORLD_READ_SCOPES.has(caller.scope));
