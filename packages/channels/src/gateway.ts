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
import type { CardResolution, InteractiveCard } from '@synq/schemas';
import { CardLinkIssuer } from './cards/links.js';
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

/**
 * What the gateway may ask of Synq. Every port is read-only or proposes
 * through the Kernel; none can approve, sign or broadcast.
 */
export interface ChannelPorts {
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
  }): Promise<BrainReply>;
}

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
};

export type ChannelGatewayOptions = {
  store: ChannelStore;
  ports: ChannelPorts;
  adapters: readonly ChannelAdapter[];
  webBaseUrl: string;
  explorerTxUrl: string;
  now: () => number;
  botUsernames?: Partial<Record<ChannelId, string>>;
  maxEventAgeSeconds?: number;
  maxClockSkewSeconds?: number;
  linkCodeTtlSeconds?: number;
  brainCooldownSeconds?: number;
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
        for (const m of event.members)
          await this.options.store.revokeUser(
            envelope.channel,
            envelope.externalGroupId,
            m.externalUserId,
            now,
          );
        return this.result('RECORDED', 'MEMBER_LEFT');
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
        return this.message(envelope);
    }
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
    if (envelope.chatKind !== 'GROUP')
      return this.replyOutcome(envelope, 'REFUSED', 'GROUP_CHAT_REQUIRED', {
        text: 'Use Synq from your group chat. Direct messages cannot act on a group treasury.',
      });
    if (parsed.kind === 'COMMAND' && parsed.name === 'synq')
      return this.link(envelope);
    if (parsed.kind === 'COMMAND' && parsed.name === 'unlink')
      return this.unlink(envelope);

    const access = await this.access(envelope);
    if ('refusal' in access) return access.refusal;
    const { group, memberId, principalId } = access;
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
    const g = await this.options.store.revokeGroupLink(
      envelope.channel,
      envelope.externalGroupId,
      this.options.now(),
    );
    return this.replyOutcome(envelope, 'HANDLED', 'UNLINKED', {
      text: g
        ? 'Unlinked: this chat no longer speaks for any Synq group, and every member link in it was removed. Members can /synq again.'
        : 'This chat was not linked to a Synq group.',
    });
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
    await this.options.store.revokeGroupLink(
      input.channel,
      input.externalGroupId,
      this.options.now(),
    );
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
    let reply: BrainReply;
    try {
      reply = await brain({
        groupId: group.groupId,
        memberId,
        principalId,
        text: stripMention(text),
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

function reviewPath(a: ApprovalSummary) {
  return a.reviewPath ?? `/intents/${a.intentHash}`;
}

function stripMention(text: string) {
  return text.replace(/@[A-Za-z0-9_]{3,64}/g, '').trim();
}
