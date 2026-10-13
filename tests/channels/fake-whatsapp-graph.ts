/**
 * In-memory WhatsApp Cloud API (Graph API) shaped after Meta's official
 * reference (checked 2026-10-13): POST /{version}/{phone-number-id}/messages
 * for text, image and interactive (button, cta_url) messages and
 * POST /{version}/{phone-number-id}/media for multipart uploads. It enforces
 * the documented limits so an adapter that drifts from them fails here.
 * Nothing in this file has been run against Meta.
 */
export const FAKE_WA_TOKEN = 'EAAG-fake-whatsapp-fixture-token-0123456789';
export const FAKE_PHONE_NUMBER_ID = '106540352242922';
export const FAKE_VERSION = 'v25.0';
export const FAKE_BASE_URL = 'https://graph.fake-meta.example';

/** The interactive object as the fake inspects it (fields optional: input is untrusted). */
export type WaInteractive = {
  type?: string;
  header?: { type?: string; image?: { id?: string; link?: string } };
  body?: { text?: unknown };
  action?: {
    name?: string;
    parameters?: { display_text?: unknown; url?: unknown };
    buttons?: { type?: string; reply?: { id?: unknown; title?: unknown } }[];
  };
};

type Sent = { to: string; type: string; body: Record<string, unknown> };
type Upload = { type: string | null; filename: string | null; bytes: number };

const err = (status: number, code: number, message: string) =>
  new Response(
    JSON.stringify({
      error: {
        message: `(#${code}) ${message}`,
        type: 'OAuthException',
        code,
        error_data: { messaging_product: 'whatsapp', details: message },
        fbtrace_id: 'AbCdEf',
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

export class FakeWhatsAppGraph {
  sent: Sent[] = [];
  uploads: Upload[] = [];
  authHeaders: string[] = [];
  failNext: { endpoint: 'messages' | 'media'; status: number; code: number }[] =
    [];
  private seq = 0;

  private invalid(body: Record<string, unknown>): string | null {
    if (body.messaging_product !== 'whatsapp') return 'messaging_product';
    if (body.recipient_type !== 'individual') return 'recipient_type';
    if (typeof body.to !== 'string' || !/^\+[0-9]{6,20}$/.test(body.to))
      return 'to';
    const ctx = body.context as { message_id?: unknown } | undefined;
    if (ctx && typeof ctx.message_id !== 'string') return 'context';
    if (body.type === 'text') {
      const t = body.text as { body?: unknown };
      return typeof t?.body === 'string' &&
        t.body.length > 0 &&
        t.body.length <= 4096
        ? null
        : 'text.body';
    }
    if (body.type === 'image') {
      const i = body.image as { id?: unknown; caption?: unknown };
      if (typeof i?.id !== 'string') return 'image.id';
      return typeof i.caption === 'string' && i.caption.length > 1024
        ? 'image.caption'
        : null;
    }
    if (body.type !== 'interactive') return 'type';
    const it = body.interactive as WaInteractive;
    const text = it?.body?.text;
    if (typeof text !== 'string' || !text.length || text.length > 1024)
      return 'interactive.body.text';
    if (it.type === 'button') {
      const buttons = it.action?.buttons;
      if (!Array.isArray(buttons) || !buttons.length || buttons.length > 3)
        return 'interactive.action.buttons';
      const titles = new Set<string>();
      for (const b of buttons) {
        if (b.type !== 'reply') return 'button.type';
        if (typeof b.reply?.id !== 'string' || b.reply.id.length > 256)
          return 'button.reply.id';
        const title = b.reply?.title;
        if (typeof title !== 'string' || title.length > 20 || titles.has(title))
          return 'button.reply.title';
        titles.add(title);
      }
      const h = it.header;
      if (h && !(h.type === 'image' && typeof h.image?.id === 'string'))
        return 'interactive.header';
      return null;
    }
    if (it.type === 'cta_url') {
      if (it.action?.name !== 'cta_url') return 'action.name';
      const p = it.action?.parameters;
      if (typeof p?.display_text !== 'string' || p.display_text.length > 20)
        return 'parameters.display_text';
      if (typeof p?.url !== 'string' || !/^https:\/\//.test(p.url))
        return 'parameters.url';
      if (it.header && it.header.type === 'image' && !it.header.image?.link)
        return 'cta_url header media must be a link';
      return null;
    }
    return 'interactive.type';
  }

  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    this.authHeaders.push(auth);
    if (auth !== `Bearer ${FAKE_WA_TOKEN}`)
      return err(401, 190, 'Invalid OAuth access token');
    const m = /^\/(v[0-9.]+)\/([0-9]+)\/(messages|media)$/.exec(url.pathname);
    if (
      !m ||
      m[1] !== FAKE_VERSION ||
      m[2] !== FAKE_PHONE_NUMBER_ID ||
      init?.method !== 'POST'
    )
      return err(400, 100, 'Unsupported post request');
    const endpoint = m[3] as 'messages' | 'media';
    const fail = this.failNext.findIndex((f) => f.endpoint === endpoint);
    if (fail >= 0) {
      const f = this.failNext.splice(fail, 1)[0]!;
      return err(f.status, f.code, 'injected');
    }
    if (endpoint === 'media') {
      const form = init.body as FormData;
      if (
        !(form instanceof FormData) ||
        form.get('messaging_product') !== 'whatsapp'
      )
        return err(400, 100, 'messaging_product');
      const file = form.get('file');
      if (!(file instanceof Blob) || file.type !== 'image/png')
        return err(400, 100, 'file');
      if (file.size > 5 * 1024 * 1024) return err(400, 131053, 'too large');
      this.uploads.push({
        type: form.get('type') as string | null,
        filename: file instanceof File ? file.name : null,
        bytes: file.size,
      });
      return ok({ id: `media-${++this.seq}` });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const bad = this.invalid(body);
    if (bad) return err(400, 100, `Invalid parameter: ${bad}`);
    this.sent.push({
      to: body.to as string,
      type:
        body.type === 'interactive'
          ? `interactive:${(body.interactive as { type: string }).type}`
          : (body.type as string),
      body,
    });
    const wamid = `wamid.FAKE${String(++this.seq).padStart(6, '0')}`;
    return ok({
      messaging_product: 'whatsapp',
      contacts: [{ input: body.to, wa_id: String(body.to).replace(/^\+/, '') }],
      messages: [{ id: wamid }],
    });
  }) as typeof fetch;
}

/** A Meta `messages` webhook for one inbound message, as documented. */
export function waWebhook(
  message: Record<string, unknown>,
  options: { phoneNumberId?: string; name?: string } = {},
) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550783881',
                phone_number_id: options.phoneNumberId ?? FAKE_PHONE_NUMBER_ID,
              },
              contacts: [
                {
                  profile: { name: options.name ?? 'Alice' },
                  wa_id: message.from,
                },
              ],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}
