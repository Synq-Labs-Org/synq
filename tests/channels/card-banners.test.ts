import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  BANNER_HEIGHT,
  BANNER_WIDTH,
  CARD_IMAGE_HEIGHT,
  CARD_IMAGE_WIDTH,
  CardBannerRenderer,
  ChannelDeliveryError,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  encodeOpaquePng,
  groupDigits,
  renderTelegramCard,
  splitCaption,
} from '@synq/channels';
import { EXECUTION_MODES, type InteractiveCard } from '@synq/schemas';
import {
  EDGE_CASES,
  SAMPLE_CARDS,
  SAMPLE_SAFE,
  editSample as edit,
} from './card-samples.js';

const renderer = new CardBannerRenderer();
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
function expectBanner(png: Buffer) {
  expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
  expect(png.readUInt32BE(16)).toBe(BANNER_WIDTH);
  expect(png.readUInt32BE(20)).toBe(BANNER_HEIGHT);
  expect(png.length).toBeGreaterThan(10_000);
  // Telegram, WhatsApp and iMessage previews: keep each card image small.
  expect(png.length).toBeLessThan(1_000_000);
}
describe('card banners', () => {
  it('is a portrait 5:7 trading card', () => {
    expect([BANNER_WIDTH, BANNER_HEIGHT]).toEqual([
      CARD_IMAGE_WIDTH,
      CARD_IMAGE_HEIGHT,
    ]);
    expect(CARD_IMAGE_WIDTH * 7).toBe(CARD_IMAGE_HEIGHT * 5);
  });

  it.each(Object.entries(SAMPLE_CARDS))(
    'renders the %s sample as a 1000x1400 PNG',
    async (_, card) => {
      expectBanner(await renderer.render(card));
    },
  );

  it.each(EDGE_CASES)('renders edge case: %s', async (_, card) => {
    expectBanner(await renderer.render(card));
  });

  it('labels every execution mode on receipts', async () => {
    const labels = new Set<string>();
    for (const mode of EXECUTION_MODES) {
      const card = edit('receipt-testnet', { executionMode: mode });
      const label = renderer.content(card).mode!.label;
      expect(JSON.stringify(renderer.tree(card))).toContain(label);
      labels.add(label);
    }
    expect([...labels].sort()).toEqual([
      'NOT EXECUTED',
      'READ ONLY',
      'REAL TESTNET',
      'SANDBOX',
      'SIMULATED',
    ]);
    expectBanner(
      await renderer.render(
        edit('receipt-testnet', { executionMode: 'CANARY_READY' }),
      ),
    );
  });

  it('carries no data beyond the card: addresses and hashes are shortened', () => {
    const tree = (name: string) =>
      JSON.stringify(renderer.tree(SAMPLE_CARDS[name]!));
    const proposal = SAMPLE_CARDS.proposal!;
    if (proposal.type !== 'APPROVAL_PROPOSAL') throw new Error('fixture');
    expect(tree('proposal')).not.toContain(proposal.recipient!.address!);
    expect(tree('proposal')).toContain('0x6bd6…08bd');
    expect(tree('proposal')).not.toContain(proposal.proposalId);
    const receipt = SAMPLE_CARDS['receipt-testnet']!;
    if (receipt.type !== 'EXECUTION_RECEIPT') throw new Error('fixture');
    expect(tree('receipt-testnet')).not.toContain(receipt.transactionHash!);
    expect(tree('receipt-testnet')).toContain('REAL TESTNET');
    expect(tree('receipt-sandbox')).toContain('SANDBOX');
    expect(tree('gift')).toContain('SANDBOX');
    expect(tree('hotel')).toContain('Non-refundable');
    expect(tree('treasury')).not.toContain(SAMPLE_SAFE);
  });

  it('always names the network and the execution mode', () => {
    for (const card of [
      ...Object.values(SAMPLE_CARDS),
      ...EDGE_CASES.map(([, c]) => c),
    ]) {
      const face = renderer.content(card);
      expect(face.network).toBe('Monad Testnet');
      expect(face.mode?.label).toMatch(
        /^(REAL TESTNET|TESTNET|SANDBOX|SIMULATED|NOT EXECUTED|READ ONLY)$/,
      );
      const tree = JSON.stringify(renderer.tree(card));
      expect(tree).toContain('Monad Testnet');
      expect(tree).toContain(face.mode!.label);
    }
    expect(
      new CardBannerRenderer({ networkLabel: null }).content(SAMPLE_CARDS.dca!)
        .mode,
    ).toBeNull();
  });

  it('grades rarity by state: pending common, approved rare, settled holo', () => {
    const rarity = (card: InteractiveCard) => renderer.content(card).grade;
    expect(rarity(SAMPLE_CARDS.proposal!)).toBe('COMMON');
    expect(
      rarity(
        edit('proposal', {
          status: 'SATISFIED',
          quorum: { counted: 2, required: 2 },
        }),
      ),
    ).toBe('RARE');
    expect(rarity(SAMPLE_CARDS['receipt-testnet']!)).toBe('HOLO_RARE');
    expect(
      rarity(
        edit('receipt-testnet', {
          status: 'SUBMITTED',
          settlementStatus: 'PENDING',
        }),
      ),
    ).toBe('COMMON');
  });

  it('keeps headline amounts exact when they fit and marks approximations', () => {
    expect(renderer.content(SAMPLE_CARDS.treasury!).headline).toEqual({
      label: 'BALANCE',
      value: '300.00',
      unit: 'AUSD',
    });
    const huge = EDGE_CASES.find(([n]) => n.startsWith('treasury: huge'))![1];
    expect(renderer.content(huge).headline?.value).toBe('≈ 1.23e30');
    const gift = EDGE_CASES.find(([n]) => n.startsWith('gift: five'))![1];
    expect(renderer.content(gift).headline).toMatchObject({ label: 'FROM' });
  });

  it('groups digits without changing the exact amount', () => {
    expect(groupDigits('1234567.000100')).toBe('1,234,567.000100');
    expect(groupDigits('0.5')).toBe('0.5');
  });

  it('caches by card id and content', async () => {
    const r = new CardBannerRenderer();
    const card = SAMPLE_CARDS.dca!;
    const a = await r.render(card);
    expect(await r.render(card)).toBe(a);
    expect(await r.render(edit('dca', { status: 'PAUSED' }))).not.toBe(a);
  });
});

type Sent = {
  method: string;
  json: Record<string, unknown> | null;
  form: FormData | null;
};
function telegram(options: {
  respond?: (method: string) => { status?: number; body: unknown };
  /** Methods whose request fails at the network layer (e.g. a timeout). */
  networkFailure?: string[];
  banners?: { render(card: InteractiveCard): Promise<Buffer> } | null;
}) {
  const sent: Sent[] = [];
  const errors: unknown[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const form = init?.body instanceof FormData ? init.body : null;
    sent.push({
      method,
      form,
      json: form
        ? null
        : (JSON.parse(String(init?.body)) as Record<string, unknown>),
    });
    if (options.networkFailure?.includes(method))
      throw new DOMException('The operation timed out.', 'TimeoutError');
    const r = options.respond?.(method) ?? {
      body: { ok: true, result: { message_id: sent.length } },
    };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  const noWait = async () => undefined;
  const adapter = new TelegramAdapter({
    api: new TelegramBotApi({
      token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',
      fetch: fetchImpl,
    }),
    bot: { id: 42, username: 'synq_bot' },
    sleep: noWait,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
    banners: options.banners === undefined ? renderer : options.banners,
    onBannerError: (e) => errors.push(e),
  });
  return { adapter, sent, errors };
}

describe('telegram card photos', () => {
  const card = SAMPLE_CARDS.proposal!;
  const message = renderTelegramCard(card);

  it('sends one photo with the card text as caption and the inline keyboard', async () => {
    const t = telegram({});
    expect(await t.adapter.send('8850110387', message)).toEqual({
      messageId: '1',
    });
    expect(t.sent.map((s) => s.method)).toEqual(['sendPhoto']);
    const form = t.sent[0]!.form!;
    expect(form.get('chat_id')).toBe('8850110387');
    expect(form.get('caption')).toBe(message.text);
    const photo = form.get('photo') as File;
    expect(photo.type).toBe('image/png');
    expect(photo.name).toBe(`${card.cardId}.png`);
    expectBanner(Buffer.from(await photo.arrayBuffer()));
    const keyboard = JSON.parse(String(form.get('reply_markup'))) as {
      inline_keyboard: {
        text: string;
        url?: string;
        callback_data?: string;
      }[][];
    };
    expect(keyboard.inline_keyboard.map((row) => row[0]!.text)).toEqual([
      ...card.actions.map((a) => a.label),
      'Refresh status',
    ]);
  });

  it('puts overflow text after the photo without buttons', async () => {
    const t = telegram({});
    const long = {
      ...message,
      text: `${message.text}\n${'Line of detail text.\n'.repeat(80)}`,
    };
    await t.adapter.send('8850110387', long);
    expect(t.sent.map((s) => s.method)).toEqual(['sendPhoto', 'sendMessage']);
    const caption = String(t.sent[0]!.form!.get('caption'));
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(t.sent[0]!.form!.get('reply_markup')).not.toBeNull();
    expect(t.sent[1]!.json!.reply_markup).toBeUndefined();
    expect(
      `${caption}\n${String(t.sent[1]!.json!.text)}`.replace(/\s+/g, ' '),
    ).toBe(long.text.replace(/\s+/g, ' ').trim());
  });

  it('falls back to text and buttons when rendering fails', async () => {
    const t = telegram({
      banners: {
        render: async () => {
          throw new Error('font missing');
        },
      },
    });
    await t.adapter.send('8850110387', message);
    expect(t.sent.map((s) => s.method)).toEqual(['sendMessage']);
    expect(t.sent[0]!.json!.reply_markup).toBeDefined();
    expect(t.errors).toHaveLength(1);
  });

  it('falls back to text and buttons when the photo upload is rejected', async () => {
    const t = telegram({
      respond: (m) =>
        m === 'sendPhoto'
          ? {
              status: 400,
              body: {
                ok: false,
                error_code: 400,
                description: 'Bad Request: IMAGE_PROCESS_FAILED',
              },
            }
          : { body: { ok: true, result: { message_id: 7 } } },
    });
    expect(await t.adapter.send('8850110387', message)).toEqual({
      messageId: '7',
    });
    expect(t.sent.map((s) => s.method)).toEqual(['sendPhoto', 'sendMessage']);
  });

  it('treats a photo upload network timeout as uncertain: no retry, no duplicate text card', async () => {
    const t = telegram({ networkFailure: ['sendPhoto'] });
    const error = await t.adapter.send('8850110387', message).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ChannelDeliveryError);
    expect((error as ChannelDeliveryError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((error as Error).message).toMatch(/^DELIVERY_UNCERTAIN/);
    expect(t.sent.map((s) => s.method)).toEqual(['sendPhoto']);
    expect(t.errors).toHaveLength(1);
  });

  it('keeps plain messages and disabled banners on sendMessage', async () => {
    const t = telegram({ banners: null });
    await t.adapter.send('8850110387', message);
    await t.adapter.send('8850110387', { text: 'hello' });
    expect(t.sent.map((s) => s.method)).toEqual(['sendMessage', 'sendMessage']);
  });

  it('splits captions at a line break', () => {
    const { caption, rest } = splitCaption(
      `${'a'.repeat(900)}\n${'b'.repeat(300)}`,
    );
    expect(caption).toBe('a'.repeat(900));
    expect(rest).toBe('b'.repeat(300));
    expect(splitCaption('short')).toEqual({ caption: 'short', rest: null });
  });
});

describe('banner amounts', () => {
  it('shows exact amounts when they fit and an explicit approximation otherwise', async () => {
    const { displayAmount } = await import('@synq/channels');
    expect(displayAmount('1849.5', 9)).toBe('1,849.5');
    expect(displayAmount('1234567890123.99', 9)).toBe('≈ 1.23T');
    expect(displayAmount('1234567890123456789012345678901.5', 30)).toBe(
      '≈ 1.23e30',
    );
    expect(displayAmount('0.123456789012345678', 10)).toBe('≈ 0.123456');
  });
});

describe('opaque PNG encoder', () => {
  it('writes an RGB PNG whose filtered rows reconstruct the pixels', () => {
    const [w, h] = [5, 4];
    const rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++)
      rgba.set([(i * 37) % 256, (i * 11) % 256, 255 - i, 255], i * 4);
    const png = encodeOpaquePng(rgba, w, h);
    expect(png.readUInt32BE(16)).toBe(w);
    expect(png.readUInt32BE(20)).toBe(h);
    expect(png[25]).toBe(2); // colour type: truecolour, no alpha
    const idatAt = png.indexOf('IDAT');
    const raw = inflateSync(
      png.subarray(idatAt + 4, idatAt + 4 + png.readUInt32BE(idatAt - 4)),
    );
    const stride = w * 3;
    const out = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      const filter = raw[y * (stride + 1)]!;
      for (let x = 0; x < stride; x++) {
        const v = raw[y * (stride + 1) + 1 + x]!;
        const a = x >= 3 ? out[y * stride + x - 3]! : 0;
        const b = y ? out[(y - 1) * stride + x]! : 0;
        const c = x >= 3 && y ? out[(y - 1) * stride + x - 3]! : 0;
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const p = [
          0,
          a,
          b,
          (a + b) >> 1,
          pa <= pb && pa <= pc ? a : pb <= pc ? b : c,
        ][filter]!;
        out[y * stride + x] = (v + p) & 255;
      }
    }
    for (let i = 0; i < w * h; i++)
      expect([...out.subarray(i * 3, i * 3 + 3)]).toEqual([
        ...rgba.subarray(i * 4, i * 4 + 3),
      ]);
    expect(() => encodeOpaquePng(rgba, w + 1, h)).toThrow();
  });
});
