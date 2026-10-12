import { describe, expect, it } from 'vitest';
import {
  BANNER_HEIGHT,
  BANNER_WIDTH,
  CardBannerRenderer,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  groupDigits,
  renderTelegramCard,
  splitCaption,
} from '@synq/channels';
import {
  EXECUTION_MODES,
  InteractiveCardSchema,
  type InteractiveCard,
} from '@synq/schemas';
import { SAMPLE_CARDS } from './card-samples.js';

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
}
const edit = (name: string, patch: Record<string, unknown>): InteractiveCard =>
  InteractiveCardSchema.parse({ ...SAMPLE_CARDS[name], ...patch });
const option = (i: number) => ({
  optionId: `o${i}`,
  product: `Very long product name number ${i} with extra words that never fit on one line`,
  price: { amount: `${i}9999999999.123456789012345678`, symbol: 'USD' },
  delivery:
    'Delivered by courier within an unspecified but surely reasonable time',
  votes: i,
});
const hotelOption = (i: number) => ({
  optionId: `h${i}`,
  hotel: `The Grand Extraordinarily Long Hotel Name ${i}`,
  room: 'Deluxe ocean-view suite with two queen beds and a balcony',
  total: { amount: '1234567890123.99', symbol: 'USD' },
  cancellation:
    i % 2 ? 'Non-refundable' : 'Partially refundable before arrival minus fees',
  preferenceVotes: 0,
});

const EDGE_CASES: [string, InteractiveCard][] = [
  [
    'treasury: huge balance, no members, no activity',
    edit('treasury', {
      groupLabel:
        'An extremely long group label that goes on and on well past any sane width',
      balance: {
        amount: '1234567890123456789012345678901.123456789012345678',
        symbol: 'AUSD',
      },
      available: { amount: '0', symbol: 'AUSD' },
      reserved: { amount: '0', symbol: 'AUSD' },
      pending: { amount: '0', symbol: 'AUSD' },
      memberCount: null,
      activity: [],
    }),
  ],
  [
    'treasury: zero balance',
    edit('treasury', {
      balance: { amount: '0', symbol: 'AUSD' },
      available: { amount: '0', symbol: 'AUSD' },
      reserved: { amount: '0', symbol: 'AUSD' },
      pending: { amount: '0', symbol: 'AUSD' },
    }),
  ],
  [
    'proposal: mandate without amount or recipient, 0 of 12',
    edit('proposal', {
      proposalKind: 'MANDATE',
      amount: null,
      recipient: null,
      reason:
        'mandate dca_weekly v3 (change) raising the cumulative budget for the next quarter of operations',
      quorum: { counted: 0, required: 12 },
    }),
  ],
  [
    'proposal: invalidated with reason',
    edit('proposal', {
      status: 'INVALIDATED',
      statusReason: 'Quote expired before quorum',
      actions: [],
    }),
  ],
  [
    'proposal: satisfied, recipient without address',
    edit('proposal', {
      status: 'SATISFIED',
      quorum: { counted: 2, required: 2 },
      recipient: { label: 'carol', address: null },
    }),
  ],
  [
    'gift: five options, no final pick',
    edit('gift', {
      options: [1, 2, 3, 4, 5].map(option),
      finalOptionId: null,
    }),
  ],
  [
    'gift: one option, simulated',
    edit('gift', {
      options: [option(1)],
      finalOptionId: 'o1',
      executionMode: 'SIMULATION',
    }),
  ],
  [
    'hotel: five options, no preference',
    edit('hotel', {
      options: [1, 2, 3, 4, 5].map(hotelOption),
      preferredOptionId: null,
    }),
  ],
  [
    'dca: revoked, nothing scheduled, overspent ratio clamp',
    edit('dca', {
      status: 'REVOKED',
      nextExecutionAt: null,
      spent: { amount: '500', symbol: 'AUSD' },
    }),
  ],
  [
    'receipt: failed with no reference',
    edit('receipt-testnet', {
      status: 'FAILED',
      transactionHash: null,
      orderId: null,
      explorerUrl: null,
      settlementStatus: 'UNKNOWN',
      executionMode: 'SIMULATION',
      actions: [],
    }),
  ],
  [
    'receipt: submitted',
    edit('receipt-testnet', {
      status: 'SUBMITTED',
      settlementStatus: 'PENDING',
    }),
  ],
  [
    'receipt: refunded sandbox order',
    edit('receipt-sandbox', {
      status: 'REFUNDED',
      settlementStatus: 'REFUNDED',
    }),
  ],
];

describe('card banners', () => {
  it.each(Object.entries(SAMPLE_CARDS))(
    'renders the %s sample as a 1200x630 PNG',
    async (_, card) => {
      expectBanner(await renderer.render(card));
    },
  );

  it.each(EDGE_CASES)('renders edge case: %s', async (_, card) => {
    expectBanner(await renderer.render(card));
  });

  it('labels every execution mode on receipts', async () => {
    for (const mode of EXECUTION_MODES)
      expectBanner(
        await renderer.render(edit('receipt-testnet', { executionMode: mode })),
      );
  });

  it('carries no data beyond the card: addresses and hashes are shortened', () => {
    const tree = (name: string) =>
      JSON.stringify(renderer.tree(SAMPLE_CARDS[name]!));
    const proposal = SAMPLE_CARDS.proposal!;
    if (proposal.type !== 'APPROVAL_PROPOSAL') throw new Error('fixture');
    expect(tree('proposal')).not.toContain(proposal.recipient!.address!);
    expect(tree('proposal')).toContain('0x6BD6…08bD');
    expect(tree('proposal')).not.toContain(proposal.proposalId);
    const receipt = SAMPLE_CARDS['receipt-testnet']!;
    if (receipt.type !== 'EXECUTION_RECEIPT') throw new Error('fixture');
    expect(tree('receipt-testnet')).not.toContain(receipt.transactionHash!);
    expect(tree('receipt-testnet')).toContain('REAL TESTNET');
    expect(tree('receipt-sandbox')).toContain('SANDBOX');
    expect(tree('gift')).toContain('SANDBOX');
    expect(tree('hotel')).toContain('Non-refundable');
    expect(tree('treasury')).not.toContain(
      '0xA8F6000000000000000000000000000000003E0c',
    );
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
