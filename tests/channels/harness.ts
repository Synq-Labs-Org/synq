import {
  ChannelDeliveryError,
  ChannelGateway,
  MemoryChannelStore,
  type ApprovalSummary,
  type ChannelAdapter,
  type ChannelEvent,
  type ChannelPorts,
  type Envelope,
  type OutboundMessage,
  type ReceiptSummary,
} from '@synq/channels';

export const GROUP_A = `0x${'a1'.repeat(32)}`;
export const GROUP_B = `0x${'b2'.repeat(32)}`;
export const CHAT_A = '-1001';
export const CHAT_B = '-1002';

export class FakeAdapter implements ChannelAdapter {
  readonly channel = 'telegram' as const;
  sent: { chat: string; message: OutboundMessage }[] = [];
  failing = false;
  acks: string[] = [];
  admins = new Set<string>();
  async chatRole(chat: string, user: string) {
    return this.admins.has(`${chat}:${user}`) || this.admins.has(`*:${user}`)
      ? ('ADMIN' as const)
      : ('MEMBER' as const);
  }
  deepLink(payload: string) {
    return `https://t.me/synq_bot?start=${payload}`;
  }
  async send(chat: string, message: OutboundMessage) {
    if (this.failing)
      throw new ChannelDeliveryError('PROVIDER_UNAVAILABLE', 3, 'outage');
    this.sent.push({ chat, message });
    return { messageId: String(this.sent.length) };
  }
  async acknowledgeAction(id: string) {
    this.acks.push(id);
  }
  last() {
    return this.sent.at(-1)?.message;
  }
}

export function fixture(
  now = 1_800_000_000,
  options: {
    requireTelegramProof?: boolean;
    chatLinkQuorum?: number;
    requireChatAdmin?: boolean;
    pendingLinkTtlSeconds?: number;
  } = {},
) {
  const clock = { t: now };
  const store = new MemoryChannelStore();
  const adapter = new FakeAdapter();
  const members = new Map<string, Map<string, string>>([
    [
      GROUP_A,
      new Map([
        ['principal_alice', 'member_0'],
        ['principal_bob', 'member_1'],
      ]),
    ],
    [GROUP_B, new Map([['principal_carol', 'member_0']])],
  ]);
  const approvals = new Map<string, ApprovalSummary[]>();
  const receipts = new Map<string, ReceiptSummary[]>();
  const brainCalls: Parameters<NonNullable<ChannelPorts['brain']>>[0][] = [];
  const ports: ChannelPorts = {
    activeMember: async (g, p) => {
      const m = members.get(g)?.get(p);
      return m ? { memberId: m } : null;
    },
    treasury: async (g) =>
      g === GROUP_A
        ? {
            symbol: 'AUSD',
            total: '10.000000',
            free: '9.000000',
            reserved: '1.000000',
            pending: '0.000000',
            account: `0x${'5a'.repeat(20)}`,
            chainId: 10143,
            asOf: 'block 100',
          }
        : null,
    mandates: async () => [],
    approvals: async (g) => approvals.get(g) ?? [],
    receipts: async (g) => receipts.get(g) ?? [],
    sendRecipient: async (_g, q) =>
      q === 'bob' ? { recipientId: 'member:member_1', label: 'bob' } : null,
    brain: async (input) => {
      brainCalls.push(input);
      return { text: 'ok', proposals: [] };
    },
  };
  const events: { event: ChannelEvent; status: string; code: string | null }[] =
    [];
  const gateway = new ChannelGateway({
    store,
    ports,
    adapters: [adapter],
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: 'https://testnet.monadexplorer.com/tx/',
    now: () => clock.t,
    botUsernames: { telegram: 'synq_bot' },
    brainCooldownSeconds: 0,
    requireExternalProof: { telegram: options.requireTelegramProof ?? false },
    chatLinkQuorum: options.chatLinkQuorum ?? 1,
    requireChatAdmin: { telegram: options.requireChatAdmin ?? false },
    ...(options.pendingLinkTtlSeconds
      ? { pendingLinkTtlSeconds: options.pendingLinkTtlSeconds }
      : {}),
    onEvent: (event, o) =>
      events.push({ event, status: o.status, code: o.code }),
  });
  let seq = 0;
  const message = (
    body: string,
    over: Partial<Envelope> & { userId?: string | null } = {},
  ): Extract<ChannelEvent, { type: 'MESSAGE_RECEIVED' }> => {
    const { userId, ...rest } = over;
    const command = /^\/(\w+)/.exec(body);
    return {
      type: 'MESSAGE_RECEIVED',
      envelope: {
        channel: 'telegram',
        eventId: `update:${++seq}`,
        externalGroupId: CHAT_A,
        chatKind: 'GROUP',
        externalUserId: userId === undefined ? '111' : userId,
        messageId: String(seq),
        body,
        timestamp: clock.t,
        replyTo: null,
        interaction: {
          kind: command ? 'COMMAND' : 'MENTION',
          addressedToBot: true,
          command: command?.[1] ?? null,
          args: '',
          callbackData: null,
        },
        attachments: [],
        verifiedSender: {
          transport: 'FIXTURE',
          providerUserId: '111',
          displayName: '@alice',
          isBot: false,
        },
        ...rest,
      },
    };
  };
  /** Issues a link code in `chat` for `userId` and redeems it as `principalId` for `groupId`. */
  /** Group `/synq`, then the private `/start` deep link; returns the DM'd web code. */
  const issueCode = async (chat: string, userId: string, startAs = userId) => {
    await gateway.handle(message('/synq', { externalGroupId: chat, userId }));
    const deep = adapter.last()?.buttons?.[0]?.url ?? '';
    const start = deep.startsWith('https://t.me/')
      ? (new URL(deep).searchParams.get('start') ?? '')
      : '';
    const before = adapter.sent.length;
    const outcome = await gateway.handle(
      message(`/start ${start}`, {
        externalGroupId: startAs,
        chatKind: 'DIRECT',
        userId: startAs,
      }),
    );
    const dm = adapter.sent.slice(before).at(-1);
    const url = dm?.message.buttons?.[0]?.url ?? '';
    return {
      start,
      outcome,
      dm,
      code: url.includes('/channels/link?code=')
        ? (new URL(url).searchParams.get('code') ?? '')
        : '',
    };
  };
  /** Issues a private link code for `userId` and redeems it as `principalId` for `groupId`. */
  /** The `/confirm <token>` most recently DM'd to `userId`, if any. */
  const confirmTokenFor = (userId: string) => {
    const dm = [...adapter.sent]
      .reverse()
      .find((m) => m.chat === userId && m.message.text.includes('/confirm '));
    return /\/confirm ([A-Za-z0-9_-]+)/.exec(dm?.message.text ?? '')?.[1] ?? '';
  };
  const confirm = (userId: string, token = confirmTokenFor(userId)) =>
    gateway.handle(
      message(`/confirm ${token}`, {
        externalGroupId: userId,
        chatKind: 'DIRECT',
        userId,
      }),
    );
  /** Full link: private code, web redemption as `principalId`, private confirmation. */
  const link = async (
    chat: string,
    userId: string,
    groupId: string,
    principalId: string,
  ) => {
    const { code } = await issueCode(chat, userId);
    const outcome = await gateway.redeemLinkCode({
      code,
      groupId,
      principalId,
    });
    const confirmed =
      outcome.status === 'LINKED' ? await confirm(userId) : null;
    return { code, outcome, confirmed };
  };
  return {
    clock,
    store,
    adapter,
    gateway,
    ports,
    members,
    approvals,
    receipts,
    brainCalls,
    events,
    message,
    link,
    issueCode,
    confirm,
    confirmTokenFor,
  };
}
