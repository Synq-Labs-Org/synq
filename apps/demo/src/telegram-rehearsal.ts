import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeTelegram, type SentMessage } from './fake-telegram.js';
import { startTelegramDemo } from './telegram.js';

/**
 * Unattended rehearsal of `pnpm demo:telegram`: a fake Bot API (MOCKED
 * Telegram) drives the real Monad testnet stack end to end and records
 * REAL_TESTNET evidence for the chain side.
 */
export async function rehearseTelegram() {
  const telegram = new FakeTelegram();
  await telegram.start();
  process.env.TELEGRAM_BOT_TOKEN = telegram.token;
  const CHAT = -100555;
  telegram.creators.add(`${CHAT}:1001`);
  const nowS = () => Math.floor(Date.now() / 1000);
  const say = (
    from: number,
    text: string,
    chat: { id: number; type: string } = { id: CHAT, type: 'supergroup' },
  ) => {
    const command = /^\/\S+/.exec(text);
    telegram.push({
      message: {
        message_id: Math.floor(Math.random() * 1e6),
        date: nowS(),
        chat,
        from: {
          id: from,
          is_bot: false,
          first_name: `u${from}`,
          username: `u${from}`,
        },
        text,
        entities: command
          ? [{ type: 'bot_command', offset: 0, length: command[0].length }]
          : [],
      },
    });
  };
  const waitFor = async (
    what: string,
    probe: (m: SentMessage) => boolean,
    ms = 900_000,
  ) => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = telegram.sent.find(probe);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`TIMEOUT waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  const button = (m: SentMessage) =>
    m.reply_markup?.inline_keyboard[0]?.[0]?.url ??
    /https?:\/\/\S+/.exec(m.text)?.[0] ??
    '';
  const demo = await startTelegramDemo({
    telegramBaseUrl: telegram.url,
    telegramMode: 'MOCKED',
  });
  const log = (m: string) =>
    console.log(`${new Date().toISOString()} [rehearsal] ${m}`);
  try {
    telegram.push({
      my_chat_member: {
        chat: { id: CHAT, type: 'supergroup', title: 'Synq rehearsal' },
        from: { id: 1001, is_bot: false, first_name: 'alice' },
        date: nowS(),
        old_chat_member: { status: 'left' },
        new_chat_member: {
          status: 'member',
          user: { id: 4242, is_bot: true, first_name: 'Synq' },
        },
      },
    });
    for (const [user, label] of [
      [1001, 'alice'],
      [1002, 'bob'],
    ] as const) {
      const before = telegram.sent.length;
      say(user, '/synq');
      const deep = await waitFor(
        'deep link',
        (m) =>
          telegram.sent.indexOf(m) >= before &&
          m.chat_id === CHAT &&
          button(m).startsWith('https://t.me/'),
      );
      const start = new URL(button(deep)).searchParams.get('start')!;
      const mid = telegram.sent.length;
      say(user, `/start ${start}`, { id: user, type: 'private' });
      const dm = await waitFor(
        'private link',
        (m) =>
          telegram.sent.indexOf(m) >= mid &&
          m.chat_id === user &&
          button(m).includes('/channels/link'),
      );
      const linkedAt = telegram.sent.length;
      log(
        `link ${label}: ${JSON.stringify(await demo.commands.link(label, button(dm)))}`,
      );
      const ask = await waitFor(
        'private confirmation',
        (m) =>
          telegram.sent.indexOf(m) >= linkedAt &&
          m.chat_id === user &&
          m.text.includes('/confirm '),
      );
      say(user, `/confirm ${/\/confirm (\S+)/.exec(ask.text)![1]}`, {
        id: user,
        type: 'private',
      });
      await waitFor(
        'confirmed',
        (m) => m.chat_id === user && /^Confirmed as/.test(m.text),
      );
    }
    await waitFor(
      'chat active',
      (m) => m.chat_id === CHAT && /now speaks for Synq group/.test(m.text),
    );
    let before = telegram.sent.length;
    say(1001, '/balance');
    log(
      (
        await waitFor(
          'balance',
          (m) =>
            telegram.sent.indexOf(m) >= before && m.text.startsWith('Treasury'),
        )
      ).text,
    );
    before = telegram.sent.length;
    say(1001, `/send 1 ${demo.memberId('carol')}`);
    const sendMsg = await waitFor(
      'send link',
      (m) => telegram.sent.indexOf(m) >= before && button(m).includes('/send?'),
    );
    const send = await demo.commands.confirm('alice', button(sendMsg));
    log(`send ${send.sendId} ${send.state} intent ${send.intentHash}`);
    const ask = await waitFor(
      'approval count',
      (m) =>
        m.text.includes('0/2 verified passkey approvals') ||
        m.text.includes('Approval needed'),
    );
    log(ask.text);
    before = telegram.sent.length;
    say(1002, 'yes', { id: CHAT, type: 'supergroup' });
    telegram.push({
      message: {
        message_id: 9,
        date: nowS(),
        chat: { id: CHAT, type: 'supergroup' },
        from: { id: 1002, is_bot: false, first_name: 'bob' },
        text: 'yes',
        reply_to_message: {
          message_id: 1,
          from: { id: 4242, is_bot: true, first_name: 'Synq' },
        },
      },
    });
    await waitFor(
      'chat yes refused',
      (m) => telegram.sent.indexOf(m) >= before && /never approve/.test(m.text),
    );
    await demo.commands.approve('alice', send.intentHash!);
    await demo.commands.approve('bob', send.intentHash!);
    await waitFor('quorum', (m) => /Quorum reached/.test(m.text));
    const receipt = await waitFor('receipt', (m) =>
      /^Confirmed on Monad testnet/.test(m.text),
    );
    log(receipt.text);
    await waitFor('reconciled', (m) =>
      /^Reconciled on Monad testnet/.test(m.text),
    );
    const proposal = await demo.commands.proposeMandate('1.5');
    log(`mandate proposal ${proposal.proposalId}`);
    await waitFor('mandate approval count', (m) =>
      /Approval needed for mandate/.test(m.text),
    );
    await demo.commands.approveMandate('alice', proposal.proposalId);
    await demo.commands.approveMandate('bob', proposal.proposalId);
    await waitFor('mandate activated', (m) =>
      /activated by Safe owners/.test(m.text),
    );
    const file = demo.writeEvidence('PASS');
    log(`PASS evidence ${file}`);
    return file;
  } catch (error) {
    log(`FAIL ${String(error)}`);
    demo.writeEvidence(`FAIL: ${String(error).slice(0, 200)}`);
    throw error;
  } finally {
    await demo.close();
    await telegram.stop();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await rehearseTelegram();
  process.exit(0);
}
