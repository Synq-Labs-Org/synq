import { createServer, type Server } from 'node:http';

export type SentMessage = {
  chat_id: number;
  text: string;
  reply_markup?: { inline_keyboard: { text: string; url: string }[][] };
};

/** Minimal Bot API double: getMe, getUpdates (long poll), sendMessage, answerCallbackQuery. */
export class FakeTelegram {
  readonly token = '424242:FAKEtokenFAKEtokenFAKEtoken';
  readonly sent: SentMessage[] = [];
  readonly answered: string[] = [];
  readonly getUpdatesOffsets: (number | undefined)[] = [];
  outage = false;
  private updates: { update_id: number }[] = [];
  private nextId = 1;
  private server: Server | null = null;
  url = '';

  push(update: Record<string, unknown>) {
    const u = { ...update, update_id: this.nextId++ };
    this.updates.push(u);
    return u;
  }
  replay(update: { update_id: number }) {
    this.updates.push(update);
  }

  async start() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const reply = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        const [, botPart, method] = (req.url ?? '').split('/');
        if (botPart !== `bot${this.token}`)
          return reply(401, {
            ok: false,
            error_code: 401,
            description: 'Unauthorized',
          });
        const body = raw ? JSON.parse(raw) : {};
        if (method === 'getMe')
          return reply(200, {
            ok: true,
            result: {
              id: 4242,
              is_bot: true,
              first_name: 'Synq',
              username: 'synq_test_bot',
            },
          });
        if (method === 'getUpdates') {
          this.getUpdatesOffsets.push(body.offset);
          const offset: number = body.offset ?? 0;
          this.updates = this.updates.filter((u) => u.update_id >= offset);
          const deadline =
            Date.now() + Math.min(Number(body.timeout ?? 0), 1) * 1000;
          while (Date.now() < deadline && this.updates.length === 0)
            await new Promise((r) => setTimeout(r, 25));
          return reply(200, { ok: true, result: this.updates.slice(0, 100) });
        }
        if (method === 'sendMessage') {
          if (this.outage)
            return reply(502, { ok: false, description: 'Bad Gateway' });
          this.sent.push(body);
          return reply(200, {
            ok: true,
            result: { message_id: 1000 + this.sent.length },
          });
        }
        if (method === 'answerCallbackQuery') {
          this.answered.push(body.callback_query_id);
          return reply(200, { ok: true, result: true });
        }
        return reply(404, { ok: false, description: 'Not Found' });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    const a = this.server.address();
    if (!a || typeof a === 'string') throw new Error('FAKE_TELEGRAM_PORT');
    this.url = `http://127.0.0.1:${a.port}`;
  }
  async stop() {
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }
}
