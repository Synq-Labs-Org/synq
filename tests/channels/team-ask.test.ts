import { describe, expect, it } from 'vitest';
import {
  ChannelGateway,
  MemoryChannelStore,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  parseTeamAsk,
  renderTeamReply,
  type ChannelAdapter,
  type OutboundMessage,
  type TeamRequest,
} from '@synq/channels';
import { askTeam, teamReplyView } from '@synq/agent-runtime';
import { NOW, newWallet, teamDesk } from '../agent-team/harness.js';

const QUESTION =
  '@Synq, ask your CFO and Risk Agent whether we should pay this contractor';
/** Local transport only: never a real token, nothing leaves the process. */
const TOKEN = '7000000001:LOCAL_INGRESS_fake_transport_token';

function localBotApi() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let id = 100;
  const f = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    calls.push({ method, body });
    if (method === 'sendMessage')
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: ++id, date: NOW } }),
      );
    return new Response(
      JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }),
      { status: 404 },
    );
  }) as typeof fetch;
  return { fetch: f, calls };
}

describe('team personas in chat', () => {
  it('recognises asks addressed to named specialists only', () => {
    expect(parseTeamAsk(QUESTION)).toMatchObject({ personas: ['CFO', 'RISK'] });
    expect(
      parseTeamAsk('CFO, can we afford to pay Sarah this week?'),
    ).toMatchObject({ personas: ['CFO'] });
    expect(parseTeamAsk('@SynqRisk is this wallet safe?')).toMatchObject({
      personas: ['RISK'],
    });
    expect(parseTeamAsk('what is our risk exposure?')).toBeNull();
    expect(parseTeamAsk('pay Sarah')).toBeNull();
    expect(
      renderTeamReply({
        sections: [
          {
            label: 'CFO',
            text: 'pay on the due date',
            evidence: ['[fact: x]'],
          },
          {
            label: 'Decision (Kernel)',
            text: 'needs your signature',
            evidence: [],
          },
        ],
        unavailable: [
          'WALLET_SCREENING NEEDS_CREDENTIALS (risk.screenCounterparty)',
        ],
        approval: { label: 'Review', reviewPath: '/intents/x' },
      }),
    ).toMatch(
      /^CFO: pay on the due date\n {2}Evidence: \[fact: x\]\nDecision \(Kernel\): needs your signature\nUnavailable now: .*\nNothing is paid until the owner signs/,
    );
  });

  it('a Telegram DM asking the CFO and Risk Agent gets one labelled answer from the single bot (LOCAL_INGRESS)', async () => {
    const desk = await teamDesk();
    const api = localBotApi();
    const adapter = new TelegramAdapter({
      api: new TelegramBotApi({ token: TOKEN, fetch: api.fetch }),
      bot: { id: 7_000_000_001, username: 'asksynqbot' },
      limiter: new OutboundLimiter({
        perChatIntervalMs: 0,
        globalIntervalMs: 0,
      }),
      maxAttempts: 1,
      transport: 'BOT_API_POLL',
    });
    const teamCalls: TeamRequest[] = [];
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
        directLink: async () => ({
          principalId: 'usr_maya',
          workspaceId: 'wsp_studio',
        }),
        direct: async () => ({ text: 'direct desk' }),
        team: async (input) => {
          teamCalls.push(input);
          return teamReplyView(
            await askTeam(input.text, desk, {
              runId: input.runId,
              origin: input.origin,
            }),
          );
        },
      },
    });
    const say = (text: string, id: number) =>
      gateway.handle(
        adapter.normalize({
          update_id: id,
          message: {
            message_id: id,
            date: NOW,
            chat: { id: 70_011, type: 'private', first_name: 'Maya' },
            from: { id: 70_011, is_bot: false, first_name: 'Maya' },
            text,
          },
        })[0]!,
      );
    const out = await say(QUESTION, 1);
    expect(out).toMatchObject({ status: 'HANDLED', code: 'TEAM_ANSWERED' });
    expect(teamCalls[0]).toMatchObject({
      personas: ['CFO', 'RISK'],
      origin: 'CHAT',
      workspaceId: 'wsp_studio',
    });
    const sent = api.calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    const text = String(sent[0]!.body.text);
    expect(text).toMatch(/^CFO: /m);
    expect(text).toMatch(/^Risk: /m);
    expect(text).toMatch(
      /^Decision \(Kernel\): allowed only with your signature/m,
    );
    expect(text).toMatch(/\[fact: snapshot:treasury\.balances .*s old\]/);
    expect(text).toMatch(/a chat reply is never an approval/);
    // The review link is a button; chat cannot approve.
    expect(JSON.stringify(sent[0]!.body.reply_markup)).toContain(
      'https://synq.example/intents/int_vi_small',
    );
    const yes = await say('yes', 2);
    expect(yes.code).toBe('CHAT_TEXT_NOT_APPROVAL');
    // A change-of-wallet request from chat is refused by the Kernel and says so.
    const attack = await say(
      `ask your Risk Agent: should we pay Sarah 2 USDC at ${newWallet}?`,
      3,
    );
    expect(attack.code).toBe('TEAM_ANSWERED');
    const last = String(
      api.calls.filter((c) => c.method === 'sendMessage').at(-1)!.body.text,
    );
    expect(last).toMatch(/^Risk: hold\. .*DESTINATION_CHANGED/m);
    expect(last).toMatch(/^Decision \(Kernel\): DENY/m);
    expect(api.calls.map((c) => c.method)).not.toContain('getUpdates');
    expect(api.calls.map((c) => c.method)).not.toContain('setWebhook');
  });

  it('the same normalized path serves other channels (iMessage adapter)', async () => {
    const sent: OutboundMessage[] = [];
    const imessage: ChannelAdapter = {
      channel: 'imessage',
      async send(_chat, m) {
        sent.push(m);
        return { messageId: 'm1' };
      },
      async answerGuest() {
        return { inlineMessageId: 'x' };
      },
      async edit() {
        return { modified: true };
      },
    };
    const desk = await teamDesk();
    const gateway = new ChannelGateway({
      store: new MemoryChannelStore(),
      adapters: [imessage],
      webBaseUrl: 'https://synq.example',
      explorerTxUrl: 'https://testnet.arcscan.app/tx/',
      now: () => NOW,
      ports: {
        activeMember: async () => null,
        treasury: async () => null,
        mandates: async () => [],
        approvals: async () => [],
        receipts: async () => [],
        directLink: async () => ({
          principalId: 'usr_maya',
          workspaceId: 'wsp_studio',
        }),
        direct: async () => ({ text: 'direct desk' }),
        team: async (input) =>
          teamReplyView(
            await askTeam(input.text, desk, { runId: input.runId }),
          ),
      },
    });
    const out = await gateway.handle({
      type: 'MESSAGE_RECEIVED',
      envelope: {
        channel: 'imessage',
        eventId: 'imsg:1',
        externalGroupId: 'dm-maya',
        chatKind: 'DIRECT',
        externalUserId: '+15550001',
        messageId: '1',
        body: 'ask your CFO whether we should pay this contractor',
        timestamp: NOW,
        replyTo: null,
        interaction: {
          kind: 'TEXT',
          addressedToBot: true,
          command: null,
          args: '',
          callbackData: null,
        },
        attachments: [],
        verifiedSender: {
          transport: 'IMESSAGE_BRIDGE',
          providerUserId: '+15550001',
          displayName: null,
          isBot: false,
        },
      },
    } as never);
    expect(out.code).toBe('TEAM_ANSWERED');
    expect(sent[0]!.text).toMatch(/^CFO: /m);
    expect(sent[0]!.text).not.toMatch(/^Risk: /m);
    expect(sent[0]!.text).toMatch(/^Decision \(Kernel\): /m);
  });
});

import { fixture, CHAT_A, GROUP_A } from './harness.js';
it('CR-14: groups and DMs use an explicit canonical workspace binding, absent bindings fail closed', async () => {
  const f = fixture();
  await f.link(CHAT_A, '111', GROUP_A, 'principal_alice');
  const scopes: string[] = [];
  f.ports.team = async (input) => {
    scopes.push(input.workspaceId);
    return { sections: [], unavailable: [], approval: null };
  };
  expect((await f.gateway.handle(f.message(QUESTION))).code).toBe(
    'TEAM_WORKSPACE_UNBOUND',
  );
  f.ports.teamWorkspace = async () => 'canonical-workspace';
  f.ports.directLink = async () => ({
    principalId: 'principal_alice',
    workspaceId: 'canonical-workspace',
  });
  f.ports.direct = async () => ({ text: 'direct' });
  await f.gateway.handle(f.message(QUESTION));
  await f.gateway.handle(
    f.message(QUESTION, { chatKind: 'DIRECT', externalGroupId: '111' }),
  );
  expect(scopes).toEqual(['canonical-workspace', 'canonical-workspace']);
});
