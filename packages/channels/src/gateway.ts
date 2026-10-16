import { createHash, randomBytes } from 'node:crypto';
import {
  ChannelDeliveryError,
  ChannelEventSchema,
  type ChannelAdapter,
  type ChannelEvent,
  type ChannelId,
  type Envelope,
  type OutboundMessage,
} from './events.js';
import { HELP_TEXT, parseCommand, parseSendArgs } from './commands.js';
import type { ChannelStore, GroupLink, RedeemOutcome } from './store.js';
import {
  CONTEXT_DEFAULT_RETENTION_SECONDS,
  CONTEXT_PURPOSE,
  clampRetention,
  type ChatContextService,
} from './context.js';
import {
  InteractiveCardSchema,
  ReviewPathSchema,
  type CardResolution,
  type InteractiveCard,
} from '@synq/schemas';
import { CardLinkIssuer } from './cards/links.js';
import {
  parseTeamAsk,
  renderTeamReply,
  type TeamPersona,
  type TeamReplyView,
} from './team.js';
import { InteractiveCardService, approvalProposalId } from './cards/service.js';
import {
  CHAT_NEVER_APPROVES,
  REFRESH_CALLBACK,
  renderCardForChannel,
} from './cards/render.js';

export type TreasurySummary = {
  symbol: string;
  total: string;
  free: string;
  reserved: string;
  pending: string;
  account: string;
  chainId: number;
  asOf: string;
};
export type MandateSummary = {
  mandateId: string;
  version: number;
  status: string;
  symbol: string;
  perActionCap: string;
  cumulativeBudget: string;
  spent: string;
};
export type ApprovalSummary = {
  intentHash: string;
  draftDigest: string;
  label: string;
  counted: number;
  required: number;
  status: 'PENDING' | 'SATISFIED' | 'INVALIDATED';
  kind?: 'SEND' | 'ACTION' | 'MANDATE';
  /** Web path of the authenticated review page; defaults to /intents/<intentHash>. */
  reviewPath?: string;
  reason?: string | null;
  /** Id carried by card links; defaults to the mandate proposal id or the intent hash. */
  proposalId?: string;
  /** Exact amount and recipient being authorized, when the proposal has them. */
  amount?: { amount: string; symbol: string };
  recipient?: { label: string; address?: string | null };
};
export type ReceiptSummary = {
  intentHash: string;
  transactionHash: string;
  state: 'CONFIRMED' | 'RECONCILED';
  label: string;
  executionMode: string;
};
export type BrainProposalSummary = {
  kind: 'ACTION' | 'MANDATE';
  status: string;
  code: string | null;
  intentHash: string | null;
  reviewPath?: string | null;
};
export type BrainReply = { text: string; proposals: BrainProposalSummary[] };
/** A consented, unexpired chat message handed to the Brain as untrusted context. */
export type BrainContextMessage = {
  messageId: string;
  principalId: string;
  text: string;
  textSha256: string;
  sentAt: number;
};
export type DealDraftRequest = {
  origin: 'ENROLLED_CONTEXT' | 'GUEST_INVOCATION';
  channel: ChannelId;
  externalGroupId: string;
  /** Linked group (enrolled chats only). */
  groupId: string | null;
  invoker: { externalUserId: string; principalId: string | null };
  request: string;
  invocation: { messageId: string; text: string; sentAt: number } | null;
  /** Enrolled: consented, unexpired memory of current members. */
  context: readonly BrainContextMessage[];
  /** Guest: the one message the invoker replied to. */
  reference: {
    messageId: string;
    externalUserId: string | null;
    timestamp: number | null;
    text: string;
    textSha256: string;
  } | null;
  runId: string;
};
export type DealDraftReply =
  | {
      status: 'DRAFTED';
      dealId: string;
      summary: string;
      url: string;
      /** Optional DEAL_PROPOSAL card; sent as the reply's image when valid. */
      card?: InteractiveCard;
    }
  | { status: 'REFUSED'; reason: string };

export type GuestReplyInput = {
  text: string;
  reference: {
    messageId: string;
    text: string;
    textSha256: string;
  } | null;
  runId: string;
};

/**
 * What the gateway may ask of Synq. Every port is read-only or proposes
 * through the Kernel; none can approve, sign or broadcast.
 */
export interface ChannelPorts {
  workspaceMessage?(input: {
    channel: ChannelId;
    chatId: string;
    chatKind: 'DIRECT' | 'GROUP';
    userId: string;
    text: string;
    eventId: string;
    origin: 'CHAT';
  }): Promise<DirectReply | null>;
  activeMember(
    groupId: string,
    principalId: string,
  ): Promise<{ memberId: string } | null>;
  groupLabel?(groupId: string): Promise<string | null>;
  treasury(groupId: string): Promise<TreasurySummary | null>;
  mandates(groupId: string): Promise<MandateSummary[]>;
  approvals(groupId: string): Promise<ApprovalSummary[]>;
  receipts(groupId: string): Promise<ReceiptSummary[]>;
  sendRecipient?(
    groupId: string,
    query: string,
  ): Promise<{ recipientId: string; label: string } | null>;
  brain?(input: {
    groupId: string;
    memberId: string;
    principalId: string;
    text: string;
    runId: string;
    intent: 'ASK' | 'PROPOSE';
    /** Present only for chats with memory on; never contains guest data. */
    context?: readonly BrainContextMessage[];
  }): Promise<BrainReply>;
  /**
   * Draft-only reply to a guest invocation: it sees the triggering text and
   * at most one referenced message, no group data, and cannot propose.
   */
  guest?(
    input: GuestReplyInput,
  ): Promise<{ text: string; trackAs?: string | null }>;
  /**
   * Deal Room draft. `context` holds only messages Synq was permitted to read
   * for this invocation: an enrolled chat's consented memory plus the
   * invoking message, or for a guest invocation the trigger and the one
   * replied-to message. The port drafts (never signs or funds) and returns a
   * link where each party reviews and signs in their own wallet.
   */
  deal?(input: DealDraftRequest): Promise<DealDraftReply>;
  /**
   * Personal finance in a direct message. The gateway resolves the sender's
   * stable channel id to a linked principal first (identity channel link);
   * only a linked sender reaches `direct`, always with `origin: 'CHAT'`.
   */
  directLink?(
    channel: ChannelId,
    externalUserId: string,
  ): Promise<{ principalId: string; workspaceId: string } | null>;
  direct?(input: DirectRequest): Promise<DirectReply>;
  /**
   * Synq's specialist team as labelled personas of this one bot ("ask your
   * CFO and Risk Agent …"). It proposes only: a payout still needs the
   * owner's EIP-712 approval, which never comes from chat.
   */
  team?(input: TeamRequest): Promise<TeamReplyView>;
  /** Canonical treasury workspace for a group; use the same id in the DM link. */
  teamWorkspace?(groupId: string): Promise<string | null>;
  /** DM from a sender with no link yet: onboarding only (start, link code). */
  directOnboarding?(input: {
    channel: ChannelId;
    externalUserId: string;
    text: string;
    runId: string;
  }): Promise<DirectReply>;
}

export type DirectRequest = {
  channel: ChannelId;
  externalUserId: string;
  principalId: string;
  workspaceId: string;
  text: string;
  runId: string;
  /** Set by the gateway: a chat message never carries owner approval. */
  origin: 'CHAT';
};
export type TeamRequest = {
  channel: ChannelId;
  /** Canonical treasury workspace, resolved through verified links in both groups and DMs. */
  workspaceId: string;
  principalId: string;
  text: string;
  personas: TeamPersona[];
  runId: string;
  /** Set by the gateway: a chat message never carries owner approval. */
  origin: 'CHAT';
};
export type DirectReply = {
  text: string;
  buttons?: OutboundMessage['buttons'];
  /** Card image for the reply itself (Telegram sends it as the photo). */
  card?: InteractiveCard;
  /** Further cards posted after the reply, each as its own card message. */
  followUps?: InteractiveCard[];
  /** Track the posted reply under this key so `updateStatus` can edit it. */
  trackAs?: string | null;
};

/** A message Synq posted and may later edit in place (status/receipt updates). */
export type StatusTarget = Readonly<{
  channel: ChannelId;
  target: { inlineMessageId: string } | { chatId: string; messageId: string };
  expiresAt: number;
}>;

export type GatewayOutcome = {
  status:
    | 'DUPLICATE'
    | 'STALE'
    | 'IGNORED'
    | 'REFUSED'
    | 'UNAUTHORIZED'
    | 'HANDLED'
    | 'RECORDED';
  code: string | null;
  delivered: number;
  failed: number;
  /** Reference of the message Synq posted (e.g. a guest answer's inline id). */
  messageRef?: string | null;
};

export type ChannelGatewayOptions = {
  store: ChannelStore;
  ports: ChannelPorts;
  adapters: readonly ChannelAdapter[];
  webBaseUrl: string;
  /** Public sign-in entry only; it conveys no channel proof or financial authority. */
  workspaceOnboarding?: boolean;
  explorerTxUrl: string;
  now: () => number;
  botUsernames?: Partial<Record<ChannelId, string>>;
  maxEventAgeSeconds?: number;
  maxClockSkewSeconds?: number;
  linkCodeTtlSeconds?: number;
  brainCooldownSeconds?: number;
  /** Minimum seconds between guest answers for one caller (default 5). */
  guestCooldownSeconds?: number;
  /** Consented chat memory; without it every chat is ENROLLED_ON_DEMAND. */
  context?: ChatContextService;
  /** A claimed event whose processing never completed may be retried after this. */
  eventLeaseSeconds?: number;
  /** Distinct confirmed members required before a new chat speaks for a group. */
  chatLinkQuorum?: number;
  /** A pending chat link that is not activated within this window expires (default 24h). */
  pendingLinkTtlSeconds?: number;
  /** Activation needs a confirmed member who is a chat creator/administrator (default: Telegram on). */
  requireChatAdmin?: Partial<Record<ChannelId, boolean>>;
  /** Channels whose link redemption must carry a verified provider identity. */
  requireExternalProof?: Partial<Record<ChannelId, boolean>>;
  onEvent?: (event: ChannelEvent, outcome: GatewayOutcome) => void;
  /**
   * Status updates in place. When set, a guest answer or DM reply whose port
   * asks for tracking keeps ONLY that message's reference (never its text or
   * the chat's content) for `retentionSeconds`, and the guest footer says so.
   */
  statusUpdates?: { retentionSeconds: number };
  /** Render approvals, receipts and balances as interactive cards; links are group-bound when `links` is set. */
  cards?: { links?: CardLinkIssuer | null };
};

export type CardLinkOutcome =
  | CardResolution
  | {
      status:
        | 'CARDS_DISABLED'
        | 'LINK_MALFORMED'
        | 'LINK_EXPIRED'
        | 'LINK_INVALID'
        | 'NOT_A_MEMBER'
        | 'PROPOSAL_NOT_FOUND';
    };

const DEAL_REQUEST =
  /^\/?deal\b|\b(draft|make|create|write up)\b[^.\n]{0,20}\b(deal|agreement|contract)\b/i;
const APPROVAL_WORDS =
  /^(yes|yep|yeah|y|ok|okay|approve|approved|i approve|confirm|confirmed|lgtm|do it|go|\+1|👍|✅)[.! ]*$/i;
const hashCode = (code: string) =>
  createHash('sha256').update(`synq-channel-link:${code}`).digest('hex');
const hashConfirm = (token: string) =>
  createHash('sha256').update(`synq-channel-confirm:${token}`).digest('hex');
const hashStart = (nonce: string) =>
  createHash('sha256').update(`synq-channel-start:${nonce}`).digest('hex');
const START_TTL_SECONDS = 600;
const short = (v: string) =>
  v.length > 14 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v;

export class ChannelGateway {
  private readonly adapters: Map<ChannelId, ChannelAdapter>;
  private readonly lastBrain = new Map<string, number>();
  private readonly tracked = new Map<string, StatusTarget[]>();
  readonly cards: InteractiveCardService | null;
  constructor(private readonly options: ChannelGatewayOptions) {
    this.adapters = new Map(options.adapters.map((a) => [a.channel, a]));
    if (!/^https?:\/\//.test(options.webBaseUrl))
      throw new Error('CHANNEL_WEB_BASE_URL_INVALID');
    this.cards = options.cards
      ? new InteractiveCardService({
          webBaseUrl: options.webBaseUrl,
          explorerTxUrl: options.explorerTxUrl,
          now: options.now,
          links: options.cards.links ?? null,
        })
      : null;
  }

  private async label(groupId: string) {
    return (
      (await this.options.ports.groupLabel?.(groupId).catch(() => null)) ??
      `Synq group ${short(groupId)}`
    );
  }

  private review(groupId: string, a: ApprovalSummary) {
    return this.cards
      ? this.cards.reviewUrl(groupId, approvalProposalId(a), reviewPath(a))
      : this.web(reviewPath(a));
  }

  private cardMessage(channel: ChannelId, card: InteractiveCard) {
    return renderCardForChannel(channel, card);
  }

  /**
   * Public status for a card link holder (e.g. the Messages extension):
   * only the quorum count and state, which the chat already shows. The
   * group-bound nonce must be valid; no member data or amounts are returned.
   */
  async cardLinkStatus(input: {
    proposalId: string;
    groupId: string;
    nonce: string;
  }): Promise<
    | {
        status: 'OK';
        state: ApprovalSummary['status'];
        counted: number;
        required: number;
      }
    | {
        status:
          | 'CARDS_DISABLED'
          | 'LINK_MALFORMED'
          | 'LINK_EXPIRED'
          | 'LINK_INVALID'
          | 'PROPOSAL_NOT_FOUND';
      }
  > {
    const links = this.options.cards?.links;
    if (!links) return { status: 'CARDS_DISABLED' };
    const check = links.verify(input);
    if (!check.ok) return { status: check.code };
    const a = (await this.options.ports.approvals(input.groupId)).find(
      (x) => approvalProposalId(x) === input.proposalId,
    );
    return a
      ? {
          status: 'OK',
          state: a.status,
          counted: a.counted,
          required: a.required,
        }
      : { status: 'PROPOSAL_NOT_FOUND' };
  }

  /**
   * Resolves a tapped card link for an authenticated member: checks the
   * group-bound nonce, the member, and reads the canonical proposal of that
   * group. It returns what will be authorized; it approves nothing.
   */
  async resolveCardLink(input: {
    proposalId: string;
    groupId: string;
    nonce: string;
    principalId: string;
  }): Promise<CardLinkOutcome> {
    const links = this.options.cards?.links;
    if (!this.cards || !links) return { status: 'CARDS_DISABLED' };
    const check = links.verify(input);
    if (!check.ok) return { status: check.code };
    const member = await this.options.ports.activeMember(
      input.groupId,
      input.principalId,
    );
    if (!member) return { status: 'NOT_A_MEMBER' };
    const approvals = await this.options.ports.approvals(input.groupId);
    const a = approvals.find((x) => approvalProposalId(x) === input.proposalId);
    if (!a) return { status: 'PROPOSAL_NOT_FOUND' };
    const card = this.cards.approval({
      groupId: input.groupId,
      groupLabel: await this.label(input.groupId),
      approval: a,
    });
    return a.status === 'PENDING'
      ? {
          status: 'OK',
          memberId: member.memberId,
          card,
          reviewPath: reviewPath(a),
        }
      : { status: 'NOT_PENDING', memberId: member.memberId, card };
  }

  private web(path: string) {
    return `${this.options.webBaseUrl.replace(/\/$/, '')}${path}`;
  }

  async handle(raw: ChannelEvent): Promise<GatewayOutcome> {
    const event = ChannelEventSchema.parse(raw);
    const outcome = await this.dispatch(event);
    this.options.onEvent?.(event, outcome);
    return outcome;
  }

  private result(
    status: GatewayOutcome['status'],
    code: string | null = null,
    delivered = 0,
    failed = 0,
  ): GatewayOutcome {
    return { status, code, delivered, failed };
  }

  private async dispatch(event: ChannelEvent): Promise<GatewayOutcome> {
    const now = this.options.now();
    if (event.type === 'MESSAGE_DELIVERY_FAILED') {
      await this.options.store.recordDeliveryFailure({
        channel: event.channel,
        externalGroupId: event.externalGroupId,
        reason: event.reason,
        attempts: event.attempts,
        at: event.at,
      });
      return this.result('RECORDED', 'DELIVERY_FAILURE');
    }
    if (event.type === 'APPROVAL_LINK_OPENED')
      return this.result('RECORDED', 'APPROVAL_LINK_OPENED');
    const envelope = event.envelope;
    const store = this.options.store;
    if (
      !(await store.claimEvent(
        envelope.channel,
        envelope.eventId,
        now,
        this.options.eventLeaseSeconds ?? 120,
      ))
    )
      return this.result('DUPLICATE');
    let outcome: GatewayOutcome;
    try {
      outcome = await this.apply(event, envelope, now);
    } catch (error) {
      await store
        .releaseEvent(envelope.channel, envelope.eventId)
        .catch(() => undefined);
      throw error;
    }
    await store.completeEvent(envelope.channel, envelope.eventId, now);
    return outcome;
  }

  private async apply(
    event: Exclude<
      ChannelEvent,
      { type: 'MESSAGE_DELIVERY_FAILED' | 'APPROVAL_LINK_OPENED' }
    >,
    envelope: Envelope,
    now: number,
  ): Promise<GatewayOutcome> {
    const age = now - envelope.timestamp;
    if (
      age > (this.options.maxEventAgeSeconds ?? 600) ||
      age < -(this.options.maxClockSkewSeconds ?? 60)
    )
      return this.result('STALE');
    switch (event.type) {
      case 'MEMBER_LEFT':
        for (const m of event.members) {
          await this.options.store.revokeUser(
            envelope.channel,
            envelope.externalGroupId,
            m.externalUserId,
            now,
          );
          await this.options.context?.store.revokeConsent(
            envelope.channel,
            envelope.externalGroupId,
            m.externalUserId,
          );
        }
        return this.result('RECORDED', 'MEMBER_LEFT');
      case 'GUEST_QUERY':
        return this.guest(event, now);
      case 'GROUP_CREATED':
        return this.replyOutcome(envelope, 'HANDLED', 'GROUP_CREATED', {
          text: 'Synq is here. A member can type /synq to link this chat to a Synq group. Approvals always happen on the Synq web page with a passkey.',
        });
      case 'MEMBER_JOINED': {
        const humans = event.members.filter((m) => !m.isBot);
        if (!humans.length) return this.result('IGNORED', 'BOT_JOINED');
        return this.replyOutcome(envelope, 'HANDLED', 'MEMBER_JOINED', {
          text: 'Welcome. Type /synq to link your Synq account; until then Synq ignores your financial commands.',
        });
      }
      case 'ACTION_REQUESTED': {
        const refresh = REFRESH_CALLBACK.exec(
          event.envelope.interaction.callbackData ?? '',
        );
        if (refresh && this.cards)
          return this.refreshCard(envelope, event.callbackId, refresh[1]!);
        await this.adapters
          .get(envelope.channel)
          ?.acknowledgeAction?.(
            event.callbackId,
            'Approvals happen only on the Synq web page with your passkey.',
          )
          .catch(() => undefined);
        return this.result('REFUSED', 'CALLBACK_NOT_AN_APPROVAL');
      }
      case 'MESSAGE_RECEIVED':
        if (
          this.options.ports.workspaceMessage &&
          envelope.externalUserId &&
          !envelope.verifiedSender.isBot
        ) {
          const reply = await this.options.ports.workspaceMessage({
            channel: envelope.channel,
            chatId: envelope.externalGroupId,
            chatKind: envelope.chatKind,
            userId: envelope.externalUserId,
            text: envelope.forwarded ? '' : envelope.body,
            eventId: envelope.eventId,
            origin: 'CHAT',
          });
          if (reply)
            return this.replyOutcome(
              envelope,
              'HANDLED',
              'WORKSPACE_MESSAGE',
              reply,
            );
        }
        await this.capture(envelope);
        return this.message(envelope);
    }
  }

  /** Keeps a group message only under the chat's disclosed memory policy and the sender's consent. */
  private async capture(envelope: Envelope) {
    const context = this.options.context;
    if (!context || envelope.chatKind !== 'GROUP' || !envelope.externalUserId)
      return;
    if (
      !(await context.store.policy(envelope.channel, envelope.externalGroupId))
    )
      return;
    const store = this.options.store;
    const group = await store.groupLink(
      envelope.channel,
      envelope.externalGroupId,
    );
    if (group?.status !== 'ACTIVE') return;
    const user = await store.userLink(
      envelope.channel,
      envelope.externalGroupId,
      envelope.externalUserId,
    );
    // Linked in this chat is not enough: the sender must still be a member of the group.
    const member =
      user?.status === 'ACTIVE'
        ? await this.options.ports.activeMember(group.groupId, user.principalId)
        : null;
    await context.capture({
      envelope,
      groupId: group.groupId,
      principalId: member && user ? user.principalId : null,
    });
  }

  /**
   * Guest mode: one draft-only answer through the adapter's guest path. No
   * chat link, member, treasury, memory or proposal is read or written; the
   * chat id is not trusted to name an installed chat.
   */
  private async guest(
    event: Extract<ChannelEvent, { type: 'GUEST_QUERY' }>,
    now: number,
  ): Promise<GatewayOutcome> {
    const envelope = event.envelope;
    if (envelope.verifiedSender.isBot || !envelope.externalUserId)
      return this.result('IGNORED', 'NOT_A_HUMAN_SENDER');
    const adapter = this.adapters.get(envelope.channel);
    if (!adapter?.answerGuest)
      return this.result('REFUSED', 'GUEST_MODE_UNSUPPORTED');
    const key = `guest:${envelope.channel}:${envelope.externalUserId}`;
    const last = this.lastBrain.get(key);
    if (now - (last ?? -Infinity) < (this.options.guestCooldownSeconds ?? 5))
      return this.result('REFUSED', 'GUEST_RATE_LIMITED');
    // Take the caller's slot before any await: concurrent pings from one
    // caller must not all pass the check while the first is still claiming.
    this.lastBrain.set(key, now);
    if (
      !(await this.options.store.claimNotification(
        envelope.channel,
        'guest',
        `guest:${event.receiver}:${event.guestQueryId}`,
        now,
      ))
    ) {
      // A redelivered query that was already answered gives the slot back.
      if (last === undefined) this.lastBrain.delete(key);
      else this.lastBrain.set(key, last);
      return this.result('DUPLICATE', 'GUEST_ALREADY_ANSWERED');
    }
    const dealt = await this.guestDeal(event);
    const { text, trackAs } = dealt ?? (await this.guestText(event));
    let inlineMessageId: string;
    try {
      ({ inlineMessageId } = await adapter.answerGuest(event.guestQueryId, {
        text,
        buttons: [
          dealt?.url
            ? { label: 'Review and sign', url: dealt.url }
            : { label: 'Open Synq', url: this.web('/') },
        ],
      }));
    } catch (error) {
      await this.handle({
        type: 'MESSAGE_DELIVERY_FAILED',
        channel: envelope.channel,
        externalGroupId: envelope.externalGroupId,
        reason:
          error instanceof ChannelDeliveryError
            ? `GUEST ${error.code}: ${error.message}`.slice(0, 500)
            : 'GUEST UNEXPECTED_DELIVERY_ERROR',
        attempts: error instanceof ChannelDeliveryError ? error.attempts : 1,
        at: now,
      }).catch(() => undefined);
      return this.result('REFUSED', 'GUEST_ANSWER_FAILED', 0, 1);
    }
    if (trackAs)
      this.track(trackAs, envelope.channel, { inlineMessageId }, now);
    return {
      ...this.result('HANDLED', 'GUEST_ANSWERED', 1, 0),
      messageRef: inlineMessageId,
    };
  }

  private track(
    key: string,
    channel: ChannelId,
    target: StatusTarget['target'],
    now: number,
  ) {
    const retention = this.options.statusUpdates?.retentionSeconds;
    if (!retention) return;
    const live = (this.tracked.get(key) ?? []).filter((t) => t.expiresAt > now);
    live.push({ channel, target, expiresAt: now + retention });
    this.tracked.set(key, live);
  }

  /** Messages tracked under `key` that are still within the retention window. */
  statusTargets(key: string): StatusTarget[] {
    const now = this.options.now();
    return (this.tracked.get(key) ?? []).filter((t) => t.expiresAt > now);
  }

  /**
   * Edits every message tracked under `key` in place. Expired references are
   * dropped (retention), an unchanged message is not an error, and a failed
   * edit is recorded as a delivery failure, never thrown.
   */
  async updateStatus(
    key: string,
    message: OutboundMessage,
  ): Promise<{ updated: number; unchanged: number; failed: number }> {
    const out = { updated: 0, unchanged: 0, failed: 0 };
    const now = this.options.now();
    const all = this.tracked.get(key) ?? [];
    const live = all.filter((t) => t.expiresAt > now);
    if (live.length !== all.length) this.tracked.set(key, live);
    for (const t of live) {
      const adapter = this.adapters.get(t.channel);
      if (!adapter?.edit) {
        out.failed++;
        continue;
      }
      try {
        const r = await adapter.edit(t.target, message);
        if (r.modified) out.updated++;
        else out.unchanged++;
      } catch (error) {
        out.failed++;
        await this.handle({
          type: 'MESSAGE_DELIVERY_FAILED',
          channel: t.channel,
          externalGroupId: 'chatId' in t.target ? t.target.chatId : 'inline',
          reason:
            error instanceof ChannelDeliveryError
              ? `EDIT ${error.code}: ${error.message}`.slice(0, 500)
              : 'EDIT UNEXPECTED_DELIVERY_ERROR',
          attempts: error instanceof ChannelDeliveryError ? error.attempts : 1,
          at: now,
        }).catch(() => undefined);
      }
    }
    return out;
  }

  /**
   * "@Synq draft a deal" as a guest: drafted from the trigger and the one
   * replied-to message only. Returns null when this is not a deal request.
   */
  private async guestDeal(
    event: Extract<ChannelEvent, { type: 'GUEST_QUERY' }>,
  ): Promise<{ text: string; trackAs: null; url: string | null } | null> {
    const port = this.options.ports.deal;
    const asked = stripMention(event.envelope.body);
    if (!port || !DEAL_REQUEST.test(asked)) return null;
    const e = event.envelope;
    const scope = event.reference
      ? 'I read only your message and the one you replied to'
      : 'I read only your message';
    let reply: DealDraftReply;
    try {
      reply = await port({
        origin: 'GUEST_INVOCATION',
        channel: e.channel,
        externalGroupId: e.externalGroupId,
        groupId: null,
        invoker: { externalUserId: e.externalUserId!, principalId: null },
        request: asked.slice(0, 1000),
        invocation: e.messageId
          ? { messageId: e.messageId, text: e.body, sentAt: e.timestamp }
          : null,
        context: [],
        reference: event.reference
          ? {
              messageId: event.reference.messageId,
              externalUserId: event.reference.externalUserId,
              timestamp: event.reference.timestamp,
              text: event.reference.text,
              textSha256: event.reference.textSha256,
            }
          : null,
        runId: `guestdeal_${createHash('sha256').update(event.guestQueryId).digest('hex').slice(0, 16)}`,
      });
    } catch {
      reply = {
        status: 'REFUSED',
        reason: 'the Deal Room could not draft this right now',
      };
    }
    if (reply.status !== 'DRAFTED')
      return {
        text: `No deal drafted: ${reply.reason.slice(0, 500)}. ${scope}, and I keep nothing.`,
        trackAs: null,
        url: null,
      };
    return {
      text: [
        `Deal draft ${reply.dealId} (version 1)`,
        reply.summary.slice(0, 1500),
        `${scope}; every term cites one of them. I keep only this draft: those messages' ids and hashes and the quoted terms, not this chat's history.`,
        'Nothing is agreed yet: each party signs the exact version in their own wallet. Chat never signs or funds.',
      ].join('\n'),
      trackAs: null,
      url: reply.url,
    };
  }

  private async guestText(
    event: Extract<ChannelEvent, { type: 'GUEST_QUERY' }>,
  ): Promise<{ text: string; trackAs: string | null }> {
    const asked = stripMention(event.envelope.body);
    const scope = event.reference
      ? 'I can see only your message and the one you replied to'
      : 'I can see only your message';
    const limits =
      'As a guest I cannot move money, approve or create proposals here; group spending happens in a linked Synq group and is approved on the web with a passkey.';
    const keepNothing = `${scope}: not this chat's history or members, and I keep nothing. ${limits}`;
    const retention = this.options.statusUpdates?.retentionSeconds;
    const keepReference = (days: number) =>
      `${scope}: not this chat's history or members. I keep nothing from this chat except this reply's message reference, for ${days} day${days === 1 ? '' : 's'}, only to update its status here. ${limits}`;
    if (APPROVAL_WORDS.test(asked) || /^\/?(approve|confirm)\b/i.test(asked))
      return {
        text: `Chat messages never approve anything, and a guest reply least of all. ${keepNothing}`,
        trackAs: null,
      };
    const port = this.options.ports.guest;
    if (port && asked) {
      try {
        const reply = await port({
          text: asked.slice(0, 4096),
          reference: event.reference
            ? {
                messageId: event.reference.messageId,
                text: event.reference.text,
                textSha256: event.reference.textSha256,
              }
            : null,
          runId: `guest_${createHash('sha256').update(event.guestQueryId).digest('hex').slice(0, 16)}`,
        });
        const trackAs = retention && reply.trackAs ? reply.trackAs : null;
        return {
          text: `${reply.text.slice(0, 3000)}\n\n${trackAs ? keepReference(Math.max(1, Math.round(retention! / 86_400))) : keepNothing}`,
          trackAs,
        };
      } catch {
        // fall through to the static reply
      }
    }
    return { text: `Hi, I'm Synq. ${keepNothing}`, trackAs: null };
  }

  /** Read-only: answers a card's refresh button with the canonical quorum for this chat's group. */
  private async refreshCard(
    envelope: Envelope,
    callbackId: string,
    prefix: string,
  ): Promise<GatewayOutcome> {
    const adapter = this.adapters.get(envelope.channel);
    const answer = (text: string) =>
      adapter?.acknowledgeAction?.(callbackId, text).catch(() => undefined);
    if (
      !(await this.options.store.claimNotification(
        envelope.channel,
        envelope.externalGroupId,
        `callback:${callbackId}`,
        this.options.now(),
      ))
    )
      return this.result('DUPLICATE', 'CALLBACK_ALREADY_ANSWERED');
    const group = await this.options.store.groupLink(
      envelope.channel,
      envelope.externalGroupId,
    );
    if (group?.status !== 'ACTIVE') {
      await answer('This chat is not linked to a Synq group.');
      return this.result('UNAUTHORIZED', 'GROUP_NOT_LINKED');
    }
    const approvals = await this.options.ports
      .approvals(group.groupId)
      .catch(() => []);
    const a = approvals.find((x) =>
      approvalProposalId(x).toLowerCase().startsWith(`0x${prefix}`),
    );
    if (!a) {
      await answer("That proposal is not open in this chat's Synq group.");
      return this.result('REFUSED', 'CARD_NOT_IN_GROUP');
    }
    await answer(
      `${a.label}: ${a.counted}/${a.required} verified approvals (${a.status.toLowerCase()}). ${CHAT_NEVER_APPROVES}`,
    );
    return this.result('HANDLED', 'CARD_REFRESHED');
  }

  private async message(envelope: Envelope): Promise<GatewayOutcome> {
    if (envelope.verifiedSender.isBot || !envelope.externalUserId)
      return this.result('IGNORED', 'NOT_A_HUMAN_SENDER');
    const parsed = parseCommand(
      envelope.body,
      this.options.botUsernames?.[envelope.channel] ?? null,
    );
    if (!parsed) return this.result('IGNORED', 'OTHER_BOT_COMMAND');
    if (parsed.kind === 'TEXT') {
      if (!envelope.interaction.addressedToBot)
        return this.result('IGNORED', 'NOT_ADDRESSED');
      if (APPROVAL_WORDS.test(stripMention(parsed.text)))
        return this.replyOutcome(
          envelope,
          'REFUSED',
          'CHAT_TEXT_NOT_APPROVAL',
          {
            text: 'Chat messages never approve anything. Open the approval link and approve with your passkey.',
          },
        );
    }
    if (parsed.kind === 'UNKNOWN_COMMAND')
      return this.replyOutcome(envelope, 'REFUSED', 'UNKNOWN_COMMAND', {
        text: HELP_TEXT,
      });
    if (parsed.kind === 'COMMAND' && parsed.name === 'help')
      return this.replyOutcome(envelope, 'HANDLED', 'HELP', {
        text: HELP_TEXT,
      });
    if (
      this.options.workspaceOnboarding &&
      envelope.chatKind === 'DIRECT' &&
      parsed.kind === 'COMMAND' &&
      parsed.name === 'start' &&
      !parsed.args
    )
      return this.workspaceOnboarding(envelope);
    if (
      envelope.chatKind === 'DIRECT' &&
      parsed.kind === 'COMMAND' &&
      parsed.name === 'start' &&
      parsed.args
    )
      return this.start(envelope, parsed.args);
    if (
      envelope.chatKind === 'DIRECT' &&
      parsed.kind === 'COMMAND' &&
      parsed.name === 'confirm'
    )
      return this.confirm(envelope, parsed.args);
    if (
      envelope.chatKind === 'DIRECT' &&
      this.options.ports.direct &&
      this.options.ports.directLink
    )
      return this.direct(
        envelope,
        parsed.kind === 'TEXT' ? parsed.text : envelope.body,
      );
    if (envelope.chatKind !== 'GROUP')
      return this.replyOutcome(envelope, 'REFUSED', 'GROUP_CHAT_REQUIRED', {
        text: 'Use Synq from your group chat. Direct messages cannot act on a group treasury.',
      });
    if (parsed.kind === 'COMMAND' && parsed.name === 'synq')
      return this.link(envelope);
    if (parsed.kind === 'COMMAND' && parsed.name === 'unlink')
      return this.unlink(envelope);
    if (parsed.kind === 'COMMAND' && parsed.name === 'memory')
      return this.memory(envelope, parsed.args);

    const access = await this.access(envelope);
    if ('refusal' in access) return access.refusal;
    const { group, memberId, principalId } = access;
    const ask =
      parsed.kind === 'TEXT' && this.options.ports.team
        ? parseTeamAsk(stripMention(parsed.text))
        : null;
    if (ask) {
      const workspaceId = await this.options.ports.teamWorkspace?.(
        group.groupId,
      );
      if (!workspaceId)
        return this.replyOutcome(
          envelope,
          'REFUSED',
          'TEAM_WORKSPACE_UNBOUND',
          {
            text: 'This group needs a verified treasury workspace binding before using the finance team.',
          },
        );
      const reply = await this.teamReply({
        channel: envelope.channel,
        workspaceId,
        principalId,
        text: stripMention(parsed.kind === 'TEXT' ? parsed.text : ''),
        personas: ask.personas,
        runId: `team_${envelope.channel}_${createHash('sha256').update(envelope.eventId).digest('hex').slice(0, 16)}`,
        origin: 'CHAT',
      });
      const outcome = await this.replyOutcome(
        envelope,
        'HANDLED',
        'TEAM_ANSWERED',
        {
          text: reply.text,
          ...(reply.buttons ? { buttons: reply.buttons } : {}),
          ...(reply.card ? { card: reply.card } : {}),
        },
      );
      for (const card of reply.followUps ?? [])
        await this.post(
          envelope.channel,
          envelope.externalGroupId,
          this.cardMessage(envelope.channel, card),
        );
      return outcome;
    }
    if (parsed.kind === 'TEXT')
      return this.brain(
        envelope,
        group,
        memberId,
        principalId,
        parsed.text,
        'ASK',
      );
    switch (parsed.name) {
      case 'balance':
      case 'wallet':
      case 'contribute':
        return this.treasury(envelope, group, parsed.name);
      case 'mandates':
        return this.mandates(envelope, group);
      case 'status':
        return this.status(envelope, group);
      case 'send':
        return this.send(envelope, group, parsed.args);
      case 'deal':
        return this.deal(envelope, group, principalId, parsed.args);
      case 'propose':
        if (!parsed.args)
          return this.replyOutcome(
            envelope,
            'REFUSED',
            'PROPOSAL_TEXT_REQUIRED',
            {
              text: 'Usage: /propose <what the group wants to do>',
            },
          );
        return this.brain(
          envelope,
          group,
          memberId,
          principalId,
          parsed.args,
          'PROPOSE',
        );
    }
    return this.result('IGNORED', 'UNHANDLED_COMMAND');
  }

  /**
   * Direct message to Synq's personal finance desk. The sender's stable
   * platform id must resolve to a wallet-linked principal; otherwise only
   * onboarding runs. The request always carries `origin: 'CHAT'`.
   */
  private async direct(envelope: Envelope, text: string) {
    const ports = this.options.ports;
    const userId = envelope.externalUserId!;
    const runId = `dm_${createHash('sha256').update(envelope.eventId).digest('hex').slice(0, 16)}`;
    const linked = await ports.directLink!(envelope.channel, userId).catch(
      () => null,
    );
    let reply: DirectReply;
    let code: string;
    const ask = parseTeamAsk(text);
    if (linked && ask && ports.team) {
      reply = await this.teamReply({
        channel: envelope.channel,
        workspaceId: linked.workspaceId,
        principalId: linked.principalId,
        text,
        personas: ask.personas,
        runId,
        origin: 'CHAT',
      });
      code = 'TEAM_ANSWERED';
    } else if (linked) {
      reply = await ports.direct!({
        channel: envelope.channel,
        externalUserId: userId,
        principalId: linked.principalId,
        workspaceId: linked.workspaceId,
        text,
        runId,
        origin: 'CHAT',
      });
      code = 'DIRECT_ANSWERED';
    } else if (ports.directOnboarding) {
      reply = await ports.directOnboarding({
        channel: envelope.channel,
        externalUserId: userId,
        text,
        runId,
      });
      code = 'DIRECT_ONBOARDING';
    } else
      return this.replyOutcome(envelope, 'UNAUTHORIZED', 'NOT_LINKED', {
        text: 'Link your wallet to Synq first; until then I cannot act on your finances.',
      });
    const adapter = this.adapters.get(envelope.channel);
    if (!adapter) return this.result('REFUSED', 'CHANNEL_UNAVAILABLE', 0, 1);
    try {
      const sent = await adapter.send(envelope.externalGroupId, {
        text: reply.text,
        ...(reply.buttons ? { buttons: reply.buttons } : {}),
        ...(reply.card ? { card: reply.card } : {}),
        replyTo: envelope.messageId,
      });
      for (const card of reply.followUps ?? [])
        await this.post(
          envelope.channel,
          envelope.externalGroupId,
          this.cardMessage(envelope.channel, card),
        );
      if (reply.trackAs)
        this.track(
          reply.trackAs,
          envelope.channel,
          { chatId: envelope.externalGroupId, messageId: sent.messageId },
          this.options.now(),
        );
      return {
        ...this.result(linked ? 'HANDLED' : 'UNAUTHORIZED', code, 1, 0),
        messageRef: sent.messageId,
      };
    } catch (error) {
      await this.handle({
        type: 'MESSAGE_DELIVERY_FAILED',
        channel: envelope.channel,
        externalGroupId: envelope.externalGroupId,
        reason:
          error instanceof ChannelDeliveryError
            ? `${error.code}: ${error.message}`.slice(0, 500)
            : 'UNEXPECTED_DELIVERY_ERROR',
        attempts: error instanceof ChannelDeliveryError ? error.attempts : 1,
        at: this.options.now(),
      }).catch(() => undefined);
      return this.result('REFUSED', 'DIRECT_REPLY_FAILED', 0, 1);
    }
  }

  /** Runs the team port and renders one labelled message (never an approval). */
  private async teamReply(input: TeamRequest): Promise<DirectReply> {
    try {
      const view = await this.options.ports.team!(input);
      // Agent recommendation goes with the answer; a risk hold follows it.
      const cards = (view.cards ?? [])
        .map((c) => validCard(c, 'AGENT_RECOMMENDATION', 'RISK_HOLD'))
        .flatMap((c) => ('card' in c ? [c.card] : []))
        .slice(0, 2);
      const main =
        cards.find((c) => c.type === 'AGENT_RECOMMENDATION') ?? cards[0];
      return {
        text: renderTeamReply(view),
        ...(main ? { card: main } : {}),
        ...(cards.length > 1
          ? { followUps: cards.filter((c) => c !== main) }
          : {}),
        ...(view.approval
          ? {
              buttons: [
                {
                  label: view.approval.label.slice(0, 40),
                  url: this.web(view.approval.reviewPath),
                },
              ],
            }
          : {}),
      };
    } catch {
      return {
        text: 'The team could not answer right now. Nothing was proposed or paid.',
      };
    }
  }

  private async access(
    envelope: Envelope,
  ): Promise<
    | { group: GroupLink; memberId: string; principalId: string }
    | { refusal: GatewayOutcome }
  > {
    const store = this.options.store;
    const group = await store.groupLink(
      envelope.channel,
      envelope.externalGroupId,
    );
    if (!group || group.status === 'REVOKED')
      return { refusal: this.result('UNAUTHORIZED', 'GROUP_NOT_LINKED') };
    if (
      group.status === 'PENDING' &&
      group.linkedAt <= this.options.now() - this.pendingTtl()
    )
      return { refusal: this.result('UNAUTHORIZED', 'GROUP_LINK_EXPIRED') };
    if (group.status === 'PENDING')
      return {
        refusal: await this.replyOutcome(
          envelope,
          'UNAUTHORIZED',
          'GROUP_LINK_PENDING',
          {
            text: `This chat's link to a Synq group is waiting for a second member to confirm. Synq ignores financial commands until then.`,
          },
        ),
      };
    const user = await store.userLink(
      envelope.channel,
      envelope.externalGroupId,
      envelope.externalUserId!,
    );
    if (!user || user.status !== 'ACTIVE')
      return {
        refusal: await this.replyOutcome(
          envelope,
          'UNAUTHORIZED',
          'USER_NOT_LINKED',
          {
            text: 'Your chat account is not linked to a Synq member yet. Type /synq and confirm with your passkey.',
          },
        ),
      };
    const member = await this.options.ports.activeMember(
      group.groupId,
      user.principalId,
    );
    if (!member)
      return {
        refusal: await this.replyOutcome(
          envelope,
          'UNAUTHORIZED',
          'NOT_A_MEMBER',
          {
            text: 'You are not an active member of this Synq group.',
          },
        ),
      };
    return { group, memberId: member.memberId, principalId: user.principalId };
  }

  /**
   * `/memory [on <days>|off|optin|optout]`: consented future-message memory.
   * Anyone can see the status and withdraw their own consent; turning it on
   * needs an active member who is a chat admin, and is disclosed in the
   * chat; each active member opts in for their own messages and for the
   * current terms only.
   */
  private async memory(
    envelope: Envelope,
    args: string,
  ): Promise<GatewayOutcome> {
    const context = this.options.context;
    if (!context)
      return this.replyOutcome(envelope, 'REFUSED', 'MEMORY_UNAVAILABLE', {
        text: 'Synq memory is not available in this deployment. Synq keeps no chat messages here.',
      });
    const [verb = 'status', amount] = args
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const chat = envelope.externalGroupId;
    const channel = envelope.channel;
    const user = envelope.externalUserId!;
    const store = context.store;
    // Withdrawing consent never depends on still being a member.
    if (verb === 'optout') {
      const deleted = await store.revokeConsent(channel, chat, user);
      return this.replyOutcome(envelope, 'HANDLED', 'MEMORY_OPTOUT', {
        text: `Opted out: deleted ${deleted} stored message${deleted === 1 ? '' : 's'} of yours. Synq keeps nothing more from you in this chat.`,
      });
    }
    if (verb === 'status') {
      const group = await this.options.store.groupLink(channel, chat);
      if (group?.status !== 'ACTIVE')
        return this.result('UNAUTHORIZED', 'GROUP_NOT_LINKED');
      return this.memoryStatus(envelope, group.groupId);
    }
    const access = await this.access(envelope);
    if ('refusal' in access) return access.refusal;
    const { group, principalId } = access;
    const now = this.options.now();
    const adminOnly = async () =>
      (await this.isChatAdmin(channel, chat, user))
        ? null
        : this.replyOutcome(envelope, 'REFUSED', 'MEMORY_ADMIN_ONLY', {
            text: 'Only a chat admin can turn Synq memory on or off.',
          });
    switch (verb) {
      case 'on': {
        const refusal = await adminOnly();
        if (refusal) return refusal;
        if (amount !== undefined && !/^[1-9][0-9]{0,2}$/.test(amount))
          return this.replyOutcome(envelope, 'REFUSED', 'MEMORY_DAYS_INVALID', {
            text: 'Usage: /memory on <days>, for example /memory on 30 (1 to 90 days).',
          });
        const retentionSeconds = clampRetention(
          amount !== undefined
            ? Number(amount) * 86_400
            : CONTEXT_DEFAULT_RETENTION_SECONDS,
        );
        const visibility = await this.visibility(channel, chat);
        // New terms: a new version, undisclosed, earlier rows capped to the new retention.
        const policy = await store.enroll({
          channel,
          externalGroupId: chat,
          groupId: group.groupId,
          retentionSeconds,
          purpose: CONTEXT_PURPOSE,
          visibility,
          enrolledByPrincipalId: principalId,
          enrolledAt: now,
        });
        const outcome = await this.replyOutcome(
          envelope,
          'HANDLED',
          'MEMORY_ON',
          { text: memoryDisclosure(retentionSeconds, visibility) },
        );
        // Nothing is kept unless the chat was actually told.
        const disclosed =
          outcome.delivered > 0 &&
          (await store.markDisclosed(channel, chat, policy.version, now));
        return disclosed
          ? outcome
          : { ...outcome, status: 'REFUSED', code: 'MEMORY_NOT_DISCLOSED' };
      }
      case 'off': {
        const refusal = await adminOnly();
        if (refusal) return refusal;
        const deleted = await store.clearPolicy(channel, chat);
        return this.replyOutcome(envelope, 'HANDLED', 'MEMORY_OFF', {
          text: `Synq memory is off for this chat. Deleted ${deleted} stored message${deleted === 1 ? '' : 's'} and every opt-in. Commands still work.`,
        });
      }
      case 'optin': {
        const policy = await store.policy(channel, chat);
        if (
          !policy ||
          policy.disclosedAt === null ||
          policy.groupId !== group.groupId
        )
          return this.replyOutcome(envelope, 'REFUSED', 'MEMORY_NOT_ON', {
            text: 'Synq memory is off for this chat, so there is nothing to opt in to. A chat admin can type /memory on <days>.',
          });
        await store.grantConsent({
          channel,
          externalGroupId: chat,
          externalUserId: user,
          principalId,
          policyVersion: policy.version,
          consentedAt: now,
        });
        return this.replyOutcome(envelope, 'HANDLED', 'MEMORY_OPTIN', {
          text: `Opted in: Synq keeps the messages it receives from you here from now on, for ${Math.round(policy.retentionSeconds / 86_400)} days, only to draft this group's proposals. Nothing from before now, nothing you forward. /memory optout deletes them.`,
        });
      }
    }
    return this.replyOutcome(envelope, 'REFUSED', 'MEMORY_USAGE', {
      text: 'Usage: /memory, /memory optin, /memory optout; chat admins: /memory on <days>, /memory off',
    });
  }

  private async visibility(channel: ChannelId, chat: string) {
    return (
      (await this.adapters
        .get(channel)
        ?.groupVisibility?.(chat)
        .catch(() => 'ADDRESSED_ONLY' as const)) ?? 'ADDRESSED_ONLY'
    );
  }

  private async memoryStatus(
    envelope: Envelope,
    groupId: string,
  ): Promise<GatewayOutcome> {
    const store = this.options.context!.store;
    const channel = envelope.channel;
    const chat = envelope.externalGroupId;
    const user = envelope.externalUserId!;
    const now = this.options.now();
    const policy = await store.policy(channel, chat);
    const on =
      policy && policy.disclosedAt !== null && policy.groupId === groupId;
    const lines = [
      `Mode: ${on ? 'ENROLLED_CONTEXT' : 'ENROLLED_ON_DEMAND'}.`,
      visibilityLine(await this.visibility(channel, chat)),
    ];
    if (on) {
      const consent = await store.consent(channel, chat, user);
      const total = await store.countMessages(channel, chat, now);
      const mine = await store.countMessages(channel, chat, now, user);
      lines.push(
        `Memory is on: kept ${Math.round(policy.retentionSeconds / 86_400)} days, only to draft this group's proposals, only from members who opted in.`,
        `Stored now: ${total} message${total === 1 ? '' : 's'} (${mine} yours). You are ${
          !consent
            ? 'not opted in'
            : consent.policyVersion === policy.version
              ? 'opted in'
              : 'opted in to earlier terms only; /memory optin to accept the current ones'
        }.`,
      );
    } else
      lines.push(
        'Memory is off: Synq keeps no messages from this chat. A chat admin can type /memory on <days>.',
      );
    return this.replyOutcome(envelope, 'HANDLED', 'MEMORY_STATUS', {
      text: lines.join('\n'),
    });
  }

  private async workspaceOnboarding(
    envelope: Envelope,
  ): Promise<GatewayOutcome> {
    return this.replyOutcome(envelope, 'HANDLED', 'WORKSPACE_ONBOARDING', {
      text: 'Create or join an Arc testnet workspace on the secure Synq page. Connect your own wallet and sign in. This link does not bind the chat or approve money. Vault setup requires a separate signature from every proposed owner.',
      buttons: [{ label: 'Start a workspace', url: this.web('/workspaces') }],
    });
  }

  private async link(envelope: Envelope): Promise<GatewayOutcome> {
    const store = this.options.store;
    const group = await store.groupLink(
      envelope.channel,
      envelope.externalGroupId,
    );
    const user = await store.userLink(
      envelope.channel,
      envelope.externalGroupId,
      envelope.externalUserId!,
    );
    if (group?.status === 'ACTIVE' && user?.status === 'ACTIVE') {
      const member = await this.options.ports.activeMember(
        group.groupId,
        user.principalId,
      );
      if (member) {
        const label =
          (await this.options.ports.groupLabel?.(group.groupId)) ??
          short(group.groupId);
        return this.replyOutcome(envelope, 'HANDLED', 'ALREADY_LINKED', {
          text: `This chat is linked to Synq group ${label}. You are linked as ${member.memberId}.`,
        });
      }
    }
    if (this.options.workspaceOnboarding)
      return this.workspaceOnboarding(envelope);
    const adapter = this.adapters.get(envelope.channel);
    const nonce = randomBytes(24).toString('base64url');
    const url = adapter?.deepLink?.(nonce) ?? null;
    if (!url)
      return this.replyOutcome(
        envelope,
        'REFUSED',
        'PRIVATE_LINK_UNAVAILABLE',
        {
          text: 'Linking needs a private chat with Synq, which this channel does not support yet. Nothing was linked.',
        },
      );
    const now = this.options.now();
    await store.createLinkCode({
      codeHash: hashStart(nonce),
      channel: envelope.channel,
      externalGroupId: envelope.externalGroupId,
      externalUserId: envelope.externalUserId!,
      displayName: envelope.verifiedSender.displayName,
      createdAt: now,
      expiresAt: now + START_TTL_SECONDS,
    });
    const who = envelope.verifiedSender.displayName ?? 'this chat account';
    return this.replyOutcome(envelope, 'HANDLED', 'PRIVATE_LINK_ISSUED', {
      text: `${who}: tap the button to continue in a private chat with Synq. Your personal link is sent only there, and only to you.`,
      buttons: [{ label: 'Continue privately', url }],
    });
  }

  /** `/start <nonce>` in a private chat: only the member who asked in the group gets a web link. */
  private async start(
    envelope: Envelope,
    nonce: string,
  ): Promise<GatewayOutcome> {
    const store = this.options.store;
    const hash = hashStart(nonce.trim());
    const view = /^[A-Za-z0-9_-]{16,64}$/.test(nonce.trim())
      ? await store.linkCode(hash)
      : null;
    const now = this.options.now();
    if (!view || view.consumedAt !== null || view.expiresAt <= now)
      return this.replyOutcome(envelope, 'REFUSED', 'START_INVALID', {
        text: 'This link is invalid, used or expired. Send /synq in your group chat again.',
      });
    if (
      view.channel !== envelope.channel ||
      view.externalUserId !== envelope.externalUserId
    )
      return this.replyOutcome(envelope, 'REFUSED', 'START_NOT_YOURS', {
        text: 'This link was requested by another member. Send /synq in the group yourself.',
      });
    if (!(await store.consumeLinkCode(hash, now)))
      return this.replyOutcome(envelope, 'REFUSED', 'START_INVALID', {
        text: 'This link was already used. Send /synq in your group chat again.',
      });
    const code = randomBytes(24).toString('base64url');
    await store.createLinkCode({
      codeHash: hashCode(code),
      channel: view.channel,
      externalGroupId: view.externalGroupId,
      externalUserId: view.externalUserId,
      displayName: view.displayName,
      createdAt: now,
      expiresAt: now + (this.options.linkCodeTtlSeconds ?? 900),
    });
    const group = await store.groupLink(view.channel, view.externalGroupId);
    return this.replyOutcome(envelope, 'HANDLED', 'LINK_CODE_ISSUED', {
      text: `Open your personal link and confirm with your passkey to link this chat account${group?.status === 'ACTIVE' ? '' : ' and your group chat'} to your Synq group. Do not share it; it works once and expires in ${Math.round((this.options.linkCodeTtlSeconds ?? 900) / 60)} minutes.`,
      buttons: [
        {
          label: 'Link with passkey',
          url: this.web(`/channels/link?code=${code}`),
        },
      ],
    });
  }

  /** Called only after the web page authenticated the member for `groupId`. */
  async redeemLinkCode(input: {
    code: string;
    groupId: string;
    principalId: string;
    /** Provider identity the web session proved (e.g. a verified Telegram Login), if any. */
    provenExternalUserId?: string;
  }): Promise<RedeemOutcome> {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(input.code))
      return { status: 'CODE_INVALID' };
    const code = await this.options.store.linkCode(hashCode(input.code));
    if (!code) return { status: 'CODE_INVALID' };
    if (
      input.provenExternalUserId === undefined &&
      this.options.requireExternalProof?.[code.channel]
    )
      return { status: 'EXTERNAL_PROOF_REQUIRED' };
    if (
      input.provenExternalUserId !== undefined &&
      input.provenExternalUserId !== code.externalUserId
    )
      return { status: 'EXTERNAL_IDENTITY_MISMATCH' };
    const member = await this.options.ports.activeMember(
      input.groupId,
      input.principalId,
    );
    if (!member) return { status: 'CODE_INVALID' };
    const confirmToken = randomBytes(24).toString('base64url');
    const outcome = await this.options.store.redeemLinkCode({
      codeHash: hashCode(input.code),
      groupId: input.groupId,
      principalId: input.principalId,
      confirmTokenHash: hashConfirm(confirmToken),
      now: this.options.now(),
      pendingExpiresBefore: this.options.now() - this.pendingTtl(),
    });
    if (outcome.status !== 'LINKED') return outcome;
    const about = await this.describeGroup(outcome.group.groupId);
    if (outcome.user.status === 'PENDING')
      await this.post(outcome.user.channel, outcome.user.externalUserId, {
        text: `Confirm: link this chat account, in the group chat where you asked, to Synq ${member.memberId} of group ${about}? If that is you, send:\n/confirm ${confirmToken}\nIf it is not you, ignore this message; nothing is linked until you confirm here.`,
      });
    if (outcome.group.status === 'PENDING')
      await this.post(outcome.group.channel, outcome.group.externalGroupId, {
        text: `Pending: a member asked to link this chat to Synq group ${about}. It takes effect only after ${this.options.chatLinkQuorum ?? 2} members of that group each link and confirm. If this is not your group's treasury, do not confirm.`,
      });
    return outcome;
  }

  /** `/confirm <token>` in the user's private chat finishes the link it was sent for. */
  private async confirm(
    envelope: Envelope,
    token: string,
  ): Promise<GatewayOutcome> {
    const store = this.options.store;
    const now = this.options.now();
    const user = /^[A-Za-z0-9_-]{16,64}$/.test(token.trim())
      ? await store.confirmUserLink({
          channel: envelope.channel,
          externalUserId: envelope.externalUserId!,
          confirmTokenHash: hashConfirm(token.trim()),
          now,
          chatAdmin: false,
        })
      : null;
    if (
      user &&
      (await this.isChatAdmin(
        user.channel,
        user.externalGroupId,
        user.externalUserId,
      ))
    )
      await store.setChatAdmin(
        user.channel,
        user.externalGroupId,
        user.externalUserId,
        true,
      );
    if (!user)
      return this.replyOutcome(envelope, 'REFUSED', 'CONFIRM_INVALID', {
        text: 'Nothing to confirm with that code. Send /synq in your group chat to start again.',
      });
    const before = await store.groupLink(user.channel, user.externalGroupId);
    const group = await store.activateGroupLink(
      user.channel,
      user.externalGroupId,
      this.options.chatLinkQuorum ?? 2,
      now,
      {
        requireChatAdmin: this.requiresChatAdmin(user.channel),
        pendingExpiresBefore: now - this.pendingTtl(),
      },
    );
    const member = group
      ? await this.options.ports.activeMember(group.groupId, user.principalId)
      : null;
    const who = member?.memberId ?? 'a member';
    if (group) {
      const about = await this.describeGroup(group.groupId);
      await this.post(user.channel, user.externalGroupId, {
        text:
          group.status === 'ACTIVE' && before?.status === 'PENDING'
            ? `Linked: this chat now speaks for Synq group ${about}, confirmed by ${this.options.chatLinkQuorum ?? 2} members. Approvals still require each member's passkey.`
            : group.status === 'ACTIVE'
              ? `Linked: ${who} confirmed with a passkey and from their private chat.`
              : `${who} confirmed. Waiting for ${this.options.chatLinkQuorum ?? 2} members of Synq group ${about}${this.requiresChatAdmin(user.channel) ? ', including a chat admin,' : ''} to link and confirm before this chat is active.`,
      });
    }
    return this.replyOutcome(envelope, 'HANDLED', 'LINK_CONFIRMED', {
      text: `Confirmed as ${who}.`,
    });
  }

  private pendingTtl() {
    return this.options.pendingLinkTtlSeconds ?? 86_400;
  }
  private requiresChatAdmin(channel: ChannelId) {
    return this.options.requireChatAdmin?.[channel] ?? channel === 'telegram';
  }
  private async isChatAdmin(channel: ChannelId, chat: string, user: string) {
    const role = await this.adapters
      .get(channel)
      ?.chatRole?.(chat, user)
      .catch(() => 'NONE' as const);
    return role === 'OWNER' || role === 'ADMIN';
  }

  /** `/unlink` in a chat, honoured only for the chat's creator or administrators. */
  private async unlink(envelope: Envelope): Promise<GatewayOutcome> {
    if (
      !(await this.isChatAdmin(
        envelope.channel,
        envelope.externalGroupId,
        envelope.externalUserId!,
      ))
    )
      return this.replyOutcome(envelope, 'REFUSED', 'UNLINK_ADMIN_ONLY', {
        text: 'Only a chat admin can unlink this chat from its Synq group.',
      });
    const g = await this.endChat(envelope.channel, envelope.externalGroupId);
    return this.replyOutcome(envelope, 'HANDLED', 'UNLINKED', {
      text: g
        ? 'Unlinked: this chat no longer speaks for any Synq group, and every member link in it was removed. Members can /synq again.'
        : 'This chat was not linked to a Synq group.',
    });
  }

  /**
   * Unlinks a chat and ends its memory. Memory is cleared first, so a
   * failure never leaves a revoked chat with stored messages, and again
   * after, in case `/memory on` ran in between. clearPolicy is idempotent.
   */
  private async endChat(channel: ChannelId, chat: string) {
    const context = this.options.context;
    await context?.store.clearPolicy(channel, chat);
    const g = await this.options.store.revokeGroupLink(
      channel,
      chat,
      this.options.now(),
    );
    await context?.store.clearPolicy(channel, chat);
    return g;
  }

  /** Web/API unlink by an authenticated member of the group the chat is bound to. */
  async unlinkChat(input: {
    channel: ChannelId;
    externalGroupId: string;
    groupId: string;
    principalId: string;
  }): Promise<'UNLINKED' | 'NOT_LINKED' | 'NOT_A_MEMBER'> {
    const g = await this.options.store.groupLink(
      input.channel,
      input.externalGroupId,
    );
    if (!g || g.status === 'REVOKED' || g.groupId !== input.groupId)
      return 'NOT_LINKED';
    if (
      !(await this.options.ports.activeMember(input.groupId, input.principalId))
    )
      return 'NOT_A_MEMBER';
    await this.endChat(input.channel, input.externalGroupId);
    await this.post(input.channel, input.externalGroupId, {
      text: 'Unlinked by a member from the Synq web app: this chat no longer speaks for that Synq group.',
    });
    return 'UNLINKED';
  }

  private async describeGroup(groupId: string) {
    const label =
      (await this.options.ports.groupLabel?.(groupId).catch(() => null)) ??
      short(groupId);
    const t = await this.options.ports.treasury(groupId).catch(() => null);
    return t ? `${label} (treasury ${t.account} on chain ${t.chainId})` : label;
  }

  async linkCodePreview(code: string) {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return null;
    const view = await this.options.store.linkCode(hashCode(code));
    if (
      !view ||
      view.consumedAt !== null ||
      view.expiresAt <= this.options.now()
    )
      return null;
    return {
      channel: view.channel,
      displayName: view.displayName,
      expiresAt: view.expiresAt,
      groupLinked:
        (await this.options.store.groupLink(view.channel, view.externalGroupId))
          ?.status === 'ACTIVE',
      groupPending:
        (await this.options.store.groupLink(view.channel, view.externalGroupId))
          ?.status === 'PENDING',
    };
  }

  private async treasury(
    envelope: Envelope,
    group: GroupLink,
    command: 'balance' | 'wallet' | 'contribute',
  ) {
    const t = await this.options.ports
      .treasury(group.groupId)
      .catch(() => null);
    if (!t)
      return this.replyOutcome(envelope, 'REFUSED', 'TREASURY_UNAVAILABLE', {
        text: 'Treasury data is unavailable or stale right now; Synq will not guess a balance.',
      });
    if (command === 'balance' && this.cards)
      return this.replyOutcome(
        envelope,
        'HANDLED',
        'BALANCE',
        this.cardMessage(
          envelope.channel,
          this.cards.treasury({
            groupId: group.groupId,
            groupLabel: await this.label(group.groupId),
            treasury: t,
          }),
        ),
      );
    const text =
      command === 'balance'
        ? `Treasury ${t.symbol}: total ${t.total}, free ${t.free}, reserved ${t.reserved}, pending ${t.pending} (as of ${t.asOf}).`
        : command === 'wallet'
          ? `This chat is bound to the treasury account ${t.account} on chain ${t.chainId}. Holdings: ${t.total} ${t.symbol}. Not your group's treasury? A chat admin can send /unlink.`
          : `To contribute, send ${t.symbol} on chain ${t.chainId} to the treasury account ${t.account} this chat is bound to, from your linked member wallet. It is credited after confirmation and indexing. Not your group's treasury? Do not send; a chat admin can send /unlink.`;
    return this.replyOutcome(envelope, 'HANDLED', command.toUpperCase(), {
      text,
    });
  }

  private async mandates(envelope: Envelope, group: GroupLink) {
    const list = await this.options.ports
      .mandates(group.groupId)
      .catch(() => null);
    if (!list)
      return this.replyOutcome(envelope, 'REFUSED', 'MANDATES_UNAVAILABLE', {
        text: 'Mandates are unavailable right now.',
      });
    const text = list.length
      ? list
          .map(
            (m) =>
              `${m.mandateId} v${m.version} ${m.status}: per action ${m.perActionCap} ${m.symbol}, budget ${m.cumulativeBudget}, spent ${m.spent}`,
          )
          .join('\n')
      : 'No active mandates. Use /propose to ask the Brain to draft one; it must be approved before it has any authority.';
    const proposals = (
      await this.options.ports.approvals(group.groupId).catch(() => [])
    ).filter((a) => a.kind === 'MANDATE' && a.status !== 'INVALIDATED');
    const lines = [
      text,
      ...proposals.map(
        (a) =>
          `Proposed: ${a.label}: ${a.counted}/${a.required} verified owner approvals`,
      ),
    ];
    return this.replyOutcome(envelope, 'HANDLED', 'MANDATES', {
      text: lines.join('\n'),
      buttons: proposals.slice(0, 3).map((a) => ({
        label: `Review ${a.label}`.slice(0, 64),
        url: this.review(group.groupId, a),
      })),
    });
  }

  private async status(envelope: Envelope, group: GroupLink) {
    const [approvals, receipts] = await Promise.all([
      this.options.ports.approvals(group.groupId).catch(() => null),
      this.options.ports.receipts(group.groupId).catch(() => null),
    ]);
    if (!approvals || !receipts)
      return this.replyOutcome(envelope, 'REFUSED', 'STATUS_UNAVAILABLE', {
        text: 'Status is unavailable right now.',
      });
    const pending = approvals.filter((a) => a.status !== 'INVALIDATED');
    const lines = [
      pending.length ? 'Pending approvals:' : 'No pending approvals.',
      ...pending.map(
        (a) => `- ${a.label}: ${a.counted}/${a.required} verified approvals`,
      ),
      ...receipts
        .slice(0, 5)
        .map(
          (r) =>
            `- ${r.label}: ${r.state} ${this.options.explorerTxUrl}${r.transactionHash}`,
        ),
    ];
    return this.replyOutcome(envelope, 'HANDLED', 'STATUS', {
      text: lines.join('\n'),
      buttons: pending
        .filter((a) => a.status === 'PENDING')
        .slice(0, 3)
        .map((a) => ({
          label: `Review ${short(a.intentHash)}`,
          url: this.review(group.groupId, a),
        })),
    });
  }

  private async send(envelope: Envelope, group: GroupLink, args: string) {
    const parsed = parseSendArgs(args);
    if (!parsed)
      return this.replyOutcome(envelope, 'REFUSED', 'SEND_ARGS_INVALID', {
        text: 'Usage: /send <amount> <recipient>, for example /send 1.5 alice',
      });
    let recipientId = parsed.recipient;
    let label = parsed.recipient;
    if (this.options.ports.sendRecipient) {
      const found = await this.options.ports
        .sendRecipient(group.groupId, parsed.recipient)
        .catch(() => null);
      if (!found)
        return this.replyOutcome(envelope, 'REFUSED', 'RECIPIENT_UNKNOWN', {
          text: `"${parsed.recipient}" is not in the group's Send directory.`,
        });
      recipientId = found.recipientId;
      label = found.label;
    }
    const query = new URLSearchParams({
      groupId: group.groupId,
      recipientId,
      amount: parsed.amount,
    });
    return this.replyOutcome(envelope, 'HANDLED', 'SEND_LINK', {
      text: `Send ${parsed.amount} AUSD to ${label}: open the link, review the Kernel preview and confirm with your passkey. Other members then approve on the web; Synq posts the approval count and the receipt here.`,
      buttons: [
        { label: 'Review and confirm', url: this.web(`/send?${query}`) },
      ],
    });
  }

  /** Consented, unexpired memory of members still in the group; never the invoking message. */
  private async consentedContext(
    envelope: Envelope,
    group: GroupLink,
    now: number,
  ): Promise<BrainContextMessage[]> {
    const stored = this.options.context
      ? (
          await this.options.context
            .contextFor({
              channel: envelope.channel,
              externalGroupId: envelope.externalGroupId,
              groupId: group.groupId,
              now,
            })
            .catch(() => [])
        ).filter((m) => m.messageId !== envelope.messageId)
      : [];
    const stillMember = new Map<string, boolean>();
    for (const m of stored)
      if (!stillMember.has(m.principalId))
        stillMember.set(
          m.principalId,
          (await this.options.ports
            .activeMember(group.groupId, m.principalId)
            .catch(() => null)) !== null,
        );
    return stored
      .filter((m) => stillMember.get(m.principalId))
      .map((m) => ({
        messageId: m.messageId,
        principalId: m.principalId,
        text: m.text,
        textSha256: m.textSha256,
        sentAt: m.sentAt,
      }));
  }

  /**
   * `/deal`: a Deal Room draft from the messages Synq may read in this chat.
   * The reply is a deal card with a link; nothing is agreed in chat.
   */
  private async deal(
    envelope: Envelope,
    group: GroupLink,
    principalId: string,
    args: string,
  ) {
    const port = this.options.ports.deal;
    if (!port)
      return this.replyOutcome(envelope, 'REFUSED', 'DEAL_ROOM_UNAVAILABLE', {
        text: 'The Deal Room is not configured in this deployment.',
      });
    const now = this.options.now();
    // Each draft costs a model call and a stored deal: one per user per cooldown.
    const key = `deal:${envelope.channel}:${envelope.externalUserId}`;
    const last = this.lastBrain.get(key);
    if (now - (last ?? -Infinity) < (this.options.brainCooldownSeconds ?? 10))
      return this.replyOutcome(envelope, 'REFUSED', 'DEAL_RATE_LIMITED', {
        text: 'One deal draft at a time: wait a few seconds and try again.',
      });
    // Take the slot before any await (see the guest path).
    this.lastBrain.set(key, now);
    if (
      !(await this.options.store.claimNotification(
        envelope.channel,
        envelope.externalGroupId,
        `effect:deal:${envelope.eventId}`,
        now,
      ))
    ) {
      if (last === undefined) this.lastBrain.delete(key);
      else this.lastBrain.set(key, last);
      return this.result('IGNORED', 'DEAL_ALREADY_RUN_FOR_EVENT');
    }
    const context = await this.consentedContext(envelope, group, now);
    let reply: DealDraftReply;
    try {
      reply = await port({
        origin: 'ENROLLED_CONTEXT',
        channel: envelope.channel,
        externalGroupId: envelope.externalGroupId,
        groupId: group.groupId,
        invoker: { externalUserId: envelope.externalUserId!, principalId },
        request: args.slice(0, 1000),
        invocation: envelope.messageId
          ? {
              messageId: envelope.messageId,
              text: envelope.body,
              sentAt: envelope.timestamp,
            }
          : null,
        context,
        reference: null,
        runId: `deal_${createHash('sha256').update(envelope.eventId).digest('hex').slice(0, 16)}`,
      });
    } catch {
      reply = {
        status: 'REFUSED',
        reason: 'The Deal Room could not draft this right now.',
      };
    }
    return this.dealReply(envelope, reply, context.length + 1);
  }

  private dealReply(envelope: Envelope, reply: DealDraftReply, read: number) {
    if (reply.status !== 'DRAFTED')
      return this.replyOutcome(envelope, 'REFUSED', 'DEAL_NOT_DRAFTED', {
        text: `No deal drafted: ${reply.reason.slice(0, 500)}`,
      });
    return this.replyOutcome(envelope, 'HANDLED', 'DEAL_DRAFTED', {
      text: [
        `Deal draft ${reply.dealId} (version 1)`,
        reply.summary.slice(0, 1500),
        `Drafted only from the ${read} message${read === 1 ? '' : 's'} Synq was permitted to read here; every term cites its message.`,
        'Nothing is agreed yet: each party reviews and signs the exact version in their own wallet. A chat reply never signs or funds anything.',
      ].join('\n'),
      buttons: [{ label: 'Review and sign', url: reply.url }],
      ...validCard(reply.card, 'DEAL_PROPOSAL'),
    });
  }

  private async brain(
    envelope: Envelope,
    group: GroupLink,
    memberId: string,
    principalId: string,
    text: string,
    intent: 'ASK' | 'PROPOSE',
  ) {
    const brain = this.options.ports.brain;
    if (!brain)
      return this.replyOutcome(envelope, 'REFUSED', 'BRAIN_UNAVAILABLE', {
        text: 'The Synq Brain is not configured in this deployment. Commands still work: /help',
      });
    const now = this.options.now();
    const key = `${envelope.channel}:${envelope.externalUserId}`;
    if (
      now - (this.lastBrain.get(key) ?? -Infinity) <
      (this.options.brainCooldownSeconds ?? 10)
    )
      return this.result('REFUSED', 'BRAIN_RATE_LIMITED');
    this.lastBrain.set(key, now);
    if (
      !(await this.options.store.claimNotification(
        envelope.channel,
        envelope.externalGroupId,
        `effect:brain:${envelope.eventId}`,
        now,
      ))
    )
      return this.result('IGNORED', 'BRAIN_ALREADY_RUN_FOR_EVENT');
    // Only members still in the group contribute context.
    const context = await this.consentedContext(envelope, group, now);
    let reply: BrainReply;
    try {
      reply = await brain({
        groupId: group.groupId,
        memberId,
        principalId,
        text: stripMention(text),
        ...(context.length ? { context } : {}),
        runId: `chan_${envelope.channel}_${createHash('sha256').update(envelope.eventId).digest('hex').slice(0, 16)}`,
        intent,
      });
    } catch {
      return this.replyOutcome(envelope, 'REFUSED', 'BRAIN_FAILED', {
        text: 'The Brain could not answer right now. Nothing was proposed.',
      });
    }
    const lines = [reply.text.slice(0, 3000)];
    for (const p of reply.proposals)
      lines.push(
        `Kernel: ${p.kind} ${p.status}${p.code ? ` (${p.code})` : ''}`,
      );
    return this.replyOutcome(envelope, 'HANDLED', 'BRAIN', {
      text: lines.join('\n'),
      buttons: reply.proposals
        .filter(
          (p) =>
            p.reviewPath || (p.intentHash && p.status === 'PENDING_APPROVAL'),
        )
        .slice(0, 3)
        .map((p) => ({
          label: 'Review and approve',
          url: this.web(p.reviewPath ?? `/intents/${p.intentHash}`),
        })),
    });
  }

  /** Posts approval counts and receipts once per state for every linked chat. */
  async notify(): Promise<{ delivered: number; failed: number }> {
    let delivered = 0;
    let failed = 0;
    const store = this.options.store;
    const now = this.options.now();
    for (const link of await store.groupLinks()) {
      const [approvals, receipts] = await Promise.all([
        this.options.ports.approvals(link.groupId).catch(() => []),
        this.options.ports.receipts(link.groupId).catch(() => []),
      ]);
      const messages: { key: string; message: OutboundMessage }[] = [];
      if (this.cards) {
        const groupLabel = await this.label(link.groupId);
        for (const a of approvals)
          messages.push({
            key:
              a.status === 'PENDING'
                ? `approval:${a.draftDigest}:${a.counted}`
                : `approval:${a.draftDigest}:${a.status.toLowerCase()}`,
            message: this.cardMessage(
              link.channel,
              this.cards.approval({
                groupId: link.groupId,
                groupLabel,
                approval: a,
              }),
            ),
          });
        for (const r of receipts)
          messages.push({
            key: `receipt:${r.intentHash}:${r.state}`,
            message: this.cardMessage(
              link.channel,
              this.cards.receipt({
                groupId: link.groupId,
                groupLabel,
                receipt: r,
              }),
            ),
          });
      }
      for (const a of this.cards ? [] : approvals) {
        const what = a.kind === 'MANDATE' ? 'passkey owner' : 'passkey';
        messages.push(
          a.status === 'INVALIDATED'
            ? {
                key: `approval:${a.draftDigest}:invalidated`,
                message: {
                  text: `${a.label} is no longer valid${a.reason ? ` (${a.reason})` : ''}. Nothing will execute.`,
                },
              }
            : a.status === 'SATISFIED'
              ? {
                  key: `approval:${a.draftDigest}:satisfied`,
                  message: {
                    text:
                      a.kind === 'MANDATE'
                        ? `Quorum reached for ${a.label}: ${a.counted}/${a.required} verified ${what} approvals. The Safe governance transaction is submitted next.`
                        : `Quorum reached for ${a.label}: ${a.counted}/${a.required} verified ${what} approvals. The Kernel issues the grant; execution follows.`,
                  },
                }
              : {
                  key: `approval:${a.draftDigest}:${a.counted}`,
                  message: {
                    text: `Approval needed for ${a.label}: ${a.counted}/${a.required} verified ${what} approvals.`,
                    buttons: [
                      {
                        label: 'Review and approve',
                        url: this.review(link.groupId, a),
                      },
                    ],
                  },
                },
        );
      }
      for (const r of this.cards ? [] : receipts)
        messages.push({
          key: `receipt:${r.intentHash}:${r.state}`,
          message: {
            text: `${r.state === 'RECONCILED' ? 'Reconciled' : 'Confirmed'} on Monad testnet [${r.executionMode}]: ${r.label}\ntx ${r.transactionHash}`,
            buttons: [
              {
                label: 'View on explorer',
                url: `${this.options.explorerTxUrl}${r.transactionHash}`,
              },
            ],
          },
        });
      for (const { key, message } of messages) {
        if (
          !(await store.claimNotification(
            link.channel,
            link.externalGroupId,
            key,
            now,
          ))
        )
          continue;
        const ok = await this.post(link.channel, link.externalGroupId, {
          ...message,
          idempotencyKey: createHash('sha256')
            .update(`${link.externalGroupId}:${key}`)
            .digest('hex')
            .slice(0, 40),
        });
        if (ok) delivered++;
        else {
          failed++;
          await store.releaseNotification(
            link.channel,
            link.externalGroupId,
            key,
          );
        }
      }
    }
    return { delivered, failed };
  }

  private async replyOutcome(
    envelope: Envelope,
    status: GatewayOutcome['status'],
    code: string,
    message: OutboundMessage,
  ): Promise<GatewayOutcome> {
    const ok = await this.post(envelope.channel, envelope.externalGroupId, {
      ...message,
      replyTo: envelope.messageId,
    });
    return this.result(status, code, ok ? 1 : 0, ok ? 0 : 1);
  }

  /** Delivery failures become MESSAGE_DELIVERY_FAILED events, never exceptions. */
  async post(
    channel: ChannelId,
    externalGroupId: string,
    message: OutboundMessage,
  ) {
    const adapter = this.adapters.get(channel);
    try {
      if (!adapter) throw new ChannelDeliveryError('CHANNEL_UNAVAILABLE', 0);
      await adapter.send(externalGroupId, message);
      return true;
    } catch (error) {
      const failure = {
        type: 'MESSAGE_DELIVERY_FAILED' as const,
        channel,
        externalGroupId,
        reason:
          error instanceof ChannelDeliveryError
            ? `${error.code}: ${error.message}`.slice(0, 500)
            : 'UNEXPECTED_DELIVERY_ERROR',
        attempts: error instanceof ChannelDeliveryError ? error.attempts : 1,
        at: this.options.now(),
      };
      await this.handle(failure).catch(() => undefined);
      return false;
    }
  }
}

/** A port-supplied card, only when it parses as the expected canonical type. */
function validCard(
  card: unknown,
  ...types: InteractiveCard['type'][]
): { card: InteractiveCard } | Record<string, never> {
  if (card === undefined) return {};
  const parsed = InteractiveCardSchema.safeParse(card);
  return parsed.success && types.includes(parsed.data.type)
    ? { card: parsed.data }
    : {};
}

function reviewPath(a: ApprovalSummary) {
  const own = ReviewPathSchema.safeParse(a.reviewPath);
  return own.success ? own.data : `/intents/${a.intentHash}`;
}

function visibilityLine(v: 'ALL_MESSAGES' | 'ADDRESSED_ONLY') {
  return v === 'ALL_MESSAGES'
    ? 'Synq receives new messages in this chat (privacy mode off or Synq is an admin). It never sees messages from before it joined.'
    : 'Telegram privacy mode is on for Synq here: it receives only commands, @mentions and replies to it, not every message, and nothing from before it joined.';
}

function memoryDisclosure(
  retentionSeconds: number,
  visibility: 'ALL_MESSAGES' | 'ADDRESSED_ONLY',
) {
  return [
    'Synq memory is ON for this chat.',
    `Purpose: drafting this Synq group's financial proposals, nothing else. Kept for ${Math.round(retentionSeconds / 86_400)} days, then deleted.`,
    'Synq keeps messages only from linked members who type /memory optin, and only messages sent after they opt in. Everyone else is not stored.',
    visibilityLine(visibility),
    'Stored messages are context, never approvals. /memory shows what is kept; /memory optout deletes yours; a chat admin can /memory off to delete all.',
  ].join('\n');
}

function stripMention(text: string) {
  return text.replace(/@[A-Za-z0-9_]{3,64}/g, '').trim();
}
