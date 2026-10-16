import { createHmac, timingSafeEqual } from 'node:crypto';
import type { StructuredReasoner } from '@synq/agent-runtime';
import { decimalOf } from './draft.js';
import {
  contextFromEnrolled,
  contextFromGuestQuery,
  type AuthorizedContext,
} from './context.js';
import { DealRoomError, type Party, type Role } from './schema.js';
import type { DealRoomService } from './service.js';

/**
 * Bridges a chat invocation (`/deal` in an enrolled chat, or "@Synq draft a
 * deal" as a guest) to a Deal Room draft. Structural types only: the channel
 * gateway calls this through its `deal` port and never sees the service.
 *
 * Participants come from verified identity links resolved by stable platform
 * id or principal id, never from names or addresses in the chat. The invoker
 * is the client unless the request starts with "as freelancer"; the
 * counterparty must be the single other person whose messages Synq read.
 */

export type ChatDealRequest = Readonly<{
  origin: 'ENROLLED_CONTEXT' | 'GUEST_INVOCATION';
  channel: string;
  externalGroupId: string;
  groupId: string | null;
  invoker: { externalUserId: string; principalId: string | null };
  request: string;
  invocation: { messageId: string; text: string; sentAt: number } | null;
  context: readonly {
    messageId: string;
    principalId: string;
    text: string;
    textSha256: string;
    sentAt: number;
  }[];
  reference: {
    messageId: string;
    externalUserId: string | null;
    timestamp: number | null;
    text: string;
    textSha256: string;
  } | null;
  runId: string;
}>;

export type ChatDealReply =
  | { status: 'DRAFTED'; dealId: string; summary: string; url: string }
  | { status: 'REFUSED'; reason: string };

/** Resolves a chat participant to a verified party (wallet-linked), or null. */
export type PartyResolver = (input: {
  channel: string;
  externalUserId: string | null;
  principalId: string | null;
  role: Role;
}) => Promise<Party | null>;

/** HMAC navigation token for a deal page link. It grants viewing, never signing. */
export function dealLinkToken(key: Uint8Array, dealId: string): string {
  return createHmac('sha256', key)
    .update(`synq-deal-link:${dealId}`)
    .digest('base64url')
    .slice(0, 32);
}
export function verifyDealLink(key: Uint8Array, dealId: string, token: string) {
  const want = Buffer.from(dealLinkToken(key, dealId));
  const got = Buffer.from(String(token));
  return want.length === got.length && timingSafeEqual(want, got);
}

export function dealDraftPort(deps: {
  service: DealRoomService;
  workspaceId: string;
  resolveParty: PartyResolver;
  arbiter: Party;
  webBaseUrl: string;
  linkKey: Uint8Array;
  reasoner: StructuredReasoner | null;
}) {
  return async (input: ChatDealRequest): Promise<ChatDealReply> => {
    const refuse = (reason: string): ChatDealReply => ({
      status: 'REFUSED',
      reason,
    });
    const asFreelancer = /^\s*as\s+(the\s+)?freelancer\b/i.test(input.request);
    const invokerRole: Role = asFreelancer ? 'FREELANCER' : 'CLIENT';
    const otherRole: Role = asFreelancer ? 'CLIENT' : 'FREELANCER';
    let context: AuthorizedContext;
    let other: { externalUserId: string | null; principalId: string | null };
    if (input.origin === 'GUEST_INVOCATION') {
      if (!input.reference)
        return refuse('reply to the message with the terms, so I can read it');
      context = contextFromGuestQuery({
        envelope: {
          channel: input.channel,
          externalGroupId: input.externalGroupId,
          messageId: input.invocation?.messageId ?? null,
          externalUserId: input.invoker.externalUserId,
          body: input.invocation?.text ?? input.request,
          timestamp: input.invocation?.sentAt ?? 0,
        },
        reference: input.reference,
      });
      other = {
        externalUserId: input.reference.externalUserId,
        principalId: null,
      };
      if (
        !other.externalUserId ||
        other.externalUserId === input.invoker.externalUserId
      )
        return refuse('reply to a message from the other party');
    } else {
      context = contextFromEnrolled({
        channel: input.channel,
        externalGroupId: input.externalGroupId,
        stored: input.context,
        invocation:
          input.invocation && input.invoker.principalId
            ? { ...input.invocation, principalId: input.invoker.principalId }
            : null,
      });
      const others = [
        ...new Set(
          input.context
            .map((m) => m.principalId)
            .filter((p) => p !== input.invoker.principalId),
        ),
      ];
      if (others.length !== 1)
        return refuse(
          others.length
            ? 'more than two people spoke in the messages I may read; a deal needs exactly one counterparty'
            : 'I may not read any message from a counterparty here (memory off, or they have not opted in)',
        );
      other = { externalUserId: null, principalId: others[0]! };
    }
    const [mine, theirs] = await Promise.all([
      deps.resolveParty({
        channel: input.channel,
        ...input.invoker,
        role: invokerRole,
      }),
      deps.resolveParty({ channel: input.channel, ...other, role: otherRole }),
    ]);
    if (!mine || !theirs)
      return refuse(
        `${!mine ? 'you have' : 'the other party has'} not linked a wallet with Synq (DM the bot to link)`,
      );
    const client = invokerRole === 'CLIENT' ? mine : theirs;
    const freelancer = invokerRole === 'CLIENT' ? theirs : mine;
    try {
      const view = await deps.service.draft({
        workspaceId: deps.workspaceId,
        context,
        request: input.request,
        parties: { client, freelancer, arbiter: deps.arbiter },
        reasoner: deps.reasoner,
        fixtureKey: input.runId,
      });
      const t = view.current.terms;
      const d = (u: bigint) =>
        `${decimalOf(u, t.asset.decimals)} ${t.asset.symbol}`;
      const summary = [
        `${t.title}: ${d(t.total)} in escrow on Arc, ${t.client.displayName} pays ${t.freelancer.displayName}; arbiter ${t.arbiter.displayName}.`,
        ...t.milestones.map(
          (m) =>
            `${m.index + 1}. ${m.title}: ${d(m.amount)}, due ${new Date(m.deadline * 1000).toISOString().slice(0, 10)}`,
        ),
        ...(view.current.ambiguities.length
          ? [`Check: ${view.current.ambiguities.slice(0, 3).join(' ')}`]
          : []),
      ].join('\n');
      const id = view.deal.dealId;
      return {
        status: 'DRAFTED',
        dealId: id,
        summary,
        url: `${deps.webBaseUrl.replace(/\/$/, '')}/deal/${id}?t=${dealLinkToken(deps.linkKey, id)}`,
      };
    } catch (e) {
      if (e instanceof DealRoomError) return refuse(e.message);
      throw e;
    }
  };
}
