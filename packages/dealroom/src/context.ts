import { createHash } from 'node:crypto';
import {
  DealRoomError,
  type ContextSource,
  type DealOrigin,
  type Provenance,
} from './schema.js';

/**
 * The only chat content a deal may be drafted from: messages Synq was
 * actually permitted to read for this invocation.
 *
 * - GUEST_INVOCATION: a guest-mode @mention carries the triggering message
 *   and at most the one message it replied to. Nothing else in that chat.
 * - ENROLLED_CONTEXT: an enrolled chat's consented memory as returned by
 *   `ChatContextService.contextFor` (disclosed policy, opted-in senders,
 *   unexpired), plus the invoking message itself.
 *
 * A term can cite only a message in this set, by id, and its quote must be
 * a verbatim span of that message. A message sent before memory was
 * disclosed, by someone who never opted in, or after its retention ended was
 * never stored, so it is not here and cannot be cited.
 */

export type AuthorizedMessage = Readonly<{
  messageId: string;
  /** sha256 hex of the full text as received. */
  textSha256: string;
  text: string;
  sentAt: number | null;
  source: ContextSource;
  /** Principal id (enrolled) or platform user id (guest); never trusted for identity. */
  author: string | null;
}>;

export type AuthorizedContext = Readonly<{
  source: Exclude<ContextSource, 'INVOCATION'>;
  channel: string;
  externalGroupId: string;
  messages: readonly AuthorizedMessage[];
}>;

export const sha256Hex = (text: string) =>
  createHash('sha256').update(text).digest('hex');

/** From a guest query: the triggering message plus the one replied-to message, if any. */
export function contextFromGuestQuery(input: {
  envelope: {
    channel: string;
    externalGroupId: string;
    messageId: string | null;
    externalUserId: string | null;
    body: string;
    timestamp: number;
  };
  reference: {
    messageId: string;
    externalUserId: string | null;
    timestamp: number | null;
    text: string;
    textSha256: string;
  } | null;
}): AuthorizedContext {
  const e = input.envelope;
  const messages: AuthorizedMessage[] = [];
  if (input.reference)
    messages.push({
      messageId: input.reference.messageId,
      textSha256: input.reference.textSha256,
      text: input.reference.text,
      sentAt: input.reference.timestamp,
      source: 'GUEST_INVOCATION',
      author: input.reference.externalUserId,
    });
  if (e.messageId)
    messages.push({
      messageId: e.messageId,
      textSha256: sha256Hex(e.body),
      text: e.body,
      sentAt: e.timestamp,
      source: 'GUEST_INVOCATION',
      author: e.externalUserId,
    });
  return {
    source: 'GUEST_INVOCATION',
    channel: e.channel,
    externalGroupId: e.externalGroupId,
    messages,
  };
}

/** From an enrolled chat: consented memory plus the invoking command message. */
export function contextFromEnrolled(input: {
  channel: string;
  externalGroupId: string;
  stored: readonly {
    messageId: string;
    principalId: string;
    text: string;
    textSha256: string;
    sentAt: number;
  }[];
  invocation: {
    messageId: string;
    principalId: string;
    text: string;
    sentAt: number;
  } | null;
}): AuthorizedContext {
  const messages: AuthorizedMessage[] = input.stored.map((m) => ({
    messageId: m.messageId,
    textSha256: m.textSha256,
    text: m.text,
    sentAt: m.sentAt,
    source: 'ENROLLED_CONTEXT',
    author: m.principalId,
  }));
  const inv = input.invocation;
  if (inv && !messages.some((m) => m.messageId === inv.messageId))
    messages.push({
      messageId: inv.messageId,
      textSha256: sha256Hex(inv.text),
      text: inv.text,
      sentAt: inv.sentAt,
      source: 'INVOCATION',
      author: inv.principalId,
    });
  return {
    source: 'ENROLLED_CONTEXT',
    channel: input.channel,
    externalGroupId: input.externalGroupId,
    messages,
  };
}

/** Digest of exactly which messages (id + hash) were readable; no text. */
export function contextDigest(ctx: AuthorizedContext): string {
  return sha256Hex(
    JSON.stringify(
      [...ctx.messages]
        .map((m) => [m.messageId, m.textSha256])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    ),
  );
}

export function originOf(ctx: AuthorizedContext): DealOrigin {
  return {
    channel: ctx.channel,
    externalGroupId: ctx.externalGroupId,
    source: ctx.source,
    contextDigest: contextDigest(ctx),
    messages: Object.fromEntries(
      ctx.messages.map((m) => [m.messageId, m.textSha256]),
    ),
  };
}

export type Citation = Readonly<{
  /** Term path, e.g. `total` or `milestones.1.amount`. */
  term: string;
  messageId: string;
  quote: string;
}>;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Turns citations into ORIGINAL_MESSAGE provenance. Throws
 * CITATION_NOT_AUTHORIZED for a message outside the authorized context and
 * CITATION_MISMATCH for a quote that is not in the cited message.
 */
export function resolveCitations(
  ctx: AuthorizedContext,
  citations: readonly Citation[],
): Record<string, Provenance[]> {
  const byId = new Map(ctx.messages.map((m) => [m.messageId, m]));
  const out: Record<string, Provenance[]> = {};
  for (const c of citations) {
    const m = byId.get(c.messageId);
    if (!m)
      throw new DealRoomError(
        'CITATION_NOT_AUTHORIZED',
        `term ${c.term} cites message ${c.messageId}, which Synq was not permitted to read for this deal`,
      );
    const quote = c.quote.slice(0, 300);
    if (!quote.trim() || !norm(m.text).includes(norm(quote)))
      throw new DealRoomError(
        'CITATION_MISMATCH',
        `term ${c.term}: quote is not in message ${c.messageId}`,
      );
    (out[c.term] ??= []).push({
      kind: 'ORIGINAL_MESSAGE',
      source: m.source,
      messageId: m.messageId,
      textSha256: m.textSha256,
      quote,
    });
  }
  return out;
}

/**
 * Re-checks stored ORIGINAL_MESSAGE provenance against the deal's recorded
 * authorized context (ids + hashes): a version can never introduce a citation
 * of a message that was not readable when the deal was drafted.
 */
export function checkProvenanceAgainstOrigin(
  origin: DealOrigin,
  provenance: Readonly<Record<string, readonly Provenance[]>>,
): void {
  for (const [term, list] of Object.entries(provenance))
    for (const p of list) {
      if (p.kind !== 'ORIGINAL_MESSAGE') continue;
      const hash = origin.messages[p.messageId];
      if (!hash)
        throw new DealRoomError(
          'CITATION_NOT_AUTHORIZED',
          `term ${term} cites message ${p.messageId} outside the deal's authorized context`,
        );
      if (hash !== p.textSha256)
        throw new DealRoomError(
          'CITATION_MISMATCH',
          `term ${term}: message ${p.messageId} hash differs from what was read`,
        );
    }
}
