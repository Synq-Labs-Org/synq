import { describe, expect, it } from 'vitest';
import {
  ChannelGateway,
  MemoryChannelStore,
  type ChannelAdapter,
  type OutboundMessage,
} from '@synq/channels';

const NOW = 2_000_000_000;

function setup(
  leadMessage: (text: string) => Promise<{ text: string } | null>,
) {
  const sent: OutboundMessage[] = [];
  const starts: string[] = [];
  const adapter: ChannelAdapter = {
    channel: 'telegram',
    async send(_chat, m) {
      sent.push(m);
      return { messageId: String(sent.length) };
    },
    async answerGuest() {
      return { inlineMessageId: 'x' };
    },
    async edit() {
      return { modified: true };
    },
  };
  const gateway = new ChannelGateway({
    store: new MemoryChannelStore(),
    adapters: [adapter],
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: 'https://testnet.arcscan.app/tx/',
    now: () => NOW,
    botUsernames: { telegram: 'asksynqbot' },
    ports: {
      activeMember: async () => null,
      treasury: async () => null,
      mandates: async () => [],
      approvals: async () => [],
      receipts: async () => [],
      leadStart: async (input) => {
        starts.push(input.token);
        return { text: `bound ${input.externalUserId}` };
      },
      leadMessage: async (input) => leadMessage(input.text),
    },
  });
  let id = 0;
  const dm = (body: string) =>
    gateway.handle({
      type: 'MESSAGE_RECEIVED',
      envelope: {
        channel: 'telegram',
        eventId: `update:1:${++id}`,
        externalGroupId: '777',
        chatKind: 'DIRECT',
        externalUserId: '777',
        messageId: String(id),
        body,
        timestamp: NOW,
        replyTo: null,
        interaction: {
          kind: body.startsWith('/') ? 'COMMAND' : 'TEXT',
          addressedToBot: true,
          command: body.startsWith('/') ? body.slice(1).split(' ')[0]! : null,
          args: body.startsWith('/') ? body.split(' ').slice(1).join(' ') : '',
          callbackData: null,
        },
        attachments: [],
        verifiedSender: {
          transport: 'BOT_API_POLL',
          providerUserId: '777',
          displayName: null,
          isBot: false,
        },
      },
    } as never);
  return { dm, sent, starts };
}

describe('private lead routing in the channel gateway', () => {
  it('binds `/start lead_…` through the lead port and answers lead messages with the agent reply', async () => {
    const t = setup(async (text) => ({ text: `agent: ${text}` }));
    const token = `lead_${'a'.repeat(43)}`;
    expect((await t.dm(`/start ${token}`)).code).toBe('LEAD_START');
    expect(t.starts).toEqual([token]);
    expect(t.sent.at(-1)!.text).toBe('bound 777');
    expect((await t.dm('I need a logo')).code).toBe('LEAD_MESSAGE');
    expect(t.sent.at(-1)!.text).toBe('agent: I need a logo');
  });

  it('sends nothing for a silent reply and leaves non-leads to the other handlers', async () => {
    const silent = setup(async () => ({ text: '' }));
    const before = silent.sent.length;
    expect((await silent.dm('hello again')).code).toBe('LEAD_MESSAGE_SILENT');
    expect(silent.sent.length).toBe(before);
    const none = setup(async () => null);
    expect((await none.dm('hello')).code).not.toMatch(/^LEAD_/);
  });
});
