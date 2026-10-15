import { describe, expect, it } from 'vitest';
import {
  ChannelGateway,
  MemoryChannelStore,
  type ChannelAdapter,
  type ChannelEvent,
  type OutboundMessage,
} from '@synq/channels';

const NOW = 1_800_000_000;

function setup(opts: { retention?: number; linked?: boolean } = {}) {
  const clock = { t: NOW };
  const edits: { target: unknown; text: string }[] = [];
  const sent: { chat: string; text: string }[] = [];
  const direct: { text: string; origin: string }[] = [];
  let n = 0;
  const adapter: ChannelAdapter = {
    channel: 'telegram',
    async send(chat: string, m: OutboundMessage) {
      sent.push({ chat, text: m.text });
      return { messageId: String(++n) };
    },
    async answerGuest() {
      return { inlineMessageId: 'inline-9' };
    },
    async edit(target, m) {
      edits.push({ target, text: m.text });
      return { modified: true };
    },
  };
  const gateway = new ChannelGateway({
    store: new MemoryChannelStore(),
    adapters: [adapter],
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: 'https://explorer.example/tx/',
    now: () => clock.t,
    guestCooldownSeconds: 0,
    ...(opts.retention
      ? { statusUpdates: { retentionSeconds: opts.retention } }
      : {}),
    ports: {
      activeMember: async () => null,
      treasury: async () => null,
      mandates: async () => [],
      approvals: async () => [],
      receipts: async () => [],
      guest: async () => ({ text: 'Draft only.', trackAs: 'deal:1' }),
      directLink: async () =>
        opts.linked ? { principalId: 'prn_1', workspaceId: 'wsp_1' } : null,
      direct: async (input) => {
        direct.push({ text: input.text, origin: input.origin });
        return { text: 'ok', trackAs: 'deal:1:dm' };
      },
    },
  });
  const envelope = (body: string, kind: 'GROUP' | 'DIRECT', id: number) => ({
    channel: 'telegram' as const,
    eventId: `update:1:${id}`,
    externalGroupId: kind === 'DIRECT' ? '42' : '-100',
    chatKind: kind,
    externalUserId: '42',
    messageId: String(id),
    body,
    timestamp: clock.t,
    replyTo: null,
    interaction: {
      kind: kind === 'DIRECT' ? ('TEXT' as const) : ('MENTION' as const),
      addressedToBot: true,
      command: null,
      args: '',
      callbackData: null,
    },
    attachments: [],
    verifiedSender: {
      transport: 'BOT_API_POLL' as const,
      providerUserId: '42',
      displayName: null,
      isBot: false,
    },
  });
  const guest = (id: number): ChannelEvent =>
    ({
      type: 'GUEST_QUERY',
      guestQueryId: `gq-${id}`,
      receiver: 'asksynqbot',
      reference: null,
      envelope: envelope('@asksynqbot invoice', 'GROUP', id),
    }) as unknown as ChannelEvent;
  const dm = (text: string, id: number): ChannelEvent => ({
    type: 'MESSAGE_RECEIVED',
    envelope: envelope(text, 'DIRECT', id),
  });
  return { clock, gateway, edits, sent, direct, guest, dm };
}

describe('gateway status updates and DM finance routing', () => {
  it('without a retention policy nothing is tracked and the footer says nothing is kept', async () => {
    const w = setup();
    const o = await w.gateway.handle(w.guest(1));
    expect(o).toMatchObject({ code: 'GUEST_ANSWERED', messageRef: 'inline-9' });
    expect(w.gateway.statusTargets('deal:1')).toEqual([]);
    expect(await w.gateway.updateStatus('deal:1', { text: 'PAID' })).toEqual({
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
  });

  it('a tracked guest answer is edited in place until its disclosed retention ends', async () => {
    const w = setup({ retention: 3 * 86_400 });
    await w.gateway.handle(w.guest(2));
    expect(w.gateway.statusTargets('deal:1')).toEqual([
      {
        channel: 'telegram',
        target: { inlineMessageId: 'inline-9' },
        expiresAt: NOW + 3 * 86_400,
      },
    ]);
    expect(await w.gateway.updateStatus('deal:1', { text: 'PAID' })).toEqual({
      updated: 1,
      unchanged: 0,
      failed: 0,
    });
    w.clock.t += 3 * 86_400;
    expect(await w.gateway.updateStatus('deal:1', { text: 'later' })).toEqual({
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
    expect(w.edits.map((e) => e.text)).toEqual(['PAID']);
  });

  it('a DM reaches the finance desk only for a linked sender, always as CHAT', async () => {
    const unlinked = setup({ retention: 86_400 });
    expect(
      await unlinked.gateway.handle(unlinked.dm('pay Sarah', 3)),
    ).toMatchObject({
      status: 'UNAUTHORIZED',
      code: 'NOT_LINKED',
    });
    expect(unlinked.direct).toEqual([]);
    const linked = setup({ retention: 86_400, linked: true });
    expect(
      await linked.gateway.handle(linked.dm('pay Sarah', 4)),
    ).toMatchObject({
      status: 'HANDLED',
      code: 'DIRECT_ANSWERED',
      messageRef: '1',
    });
    expect(linked.direct).toEqual([{ text: 'pay Sarah', origin: 'CHAT' }]);
    expect(linked.gateway.statusTargets('deal:1:dm')[0]!.target).toEqual({
      chatId: '42',
      messageId: '1',
    });
  });
});
