import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CARD_THEMES,
  CardBannerRenderer,
  DEFAULT_CARD_THEME,
  cardTheme,
  renderTelegramCard,
} from '@synq/channels';
import {
  ARC_CARD_TYPES,
  CARD_EXECUTION_MODES,
  InteractiveCardSchema,
  cardDecimal,
  cardIdOf,
  isArcCard,
  type InteractiveCard,
} from '@synq/schemas';
import {
  ARC_EDGE_CASES,
  ARC_SAMPLES,
  EDGE_CASES,
  SAMPLE_CARDS,
} from './card-samples.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function expectPng(png: Buffer) {
  expect(png.subarray(0, 8).equals(PNG)).toBe(true);
  expect(png.readUInt32BE(16)).toBe(1000);
  expect(png.readUInt32BE(20)).toBe(1400);
  expect(png.length).toBeGreaterThan(10_000);
  expect(png.length).toBeLessThan(1_000_000);
}
const edit = (name: string, patch: Record<string, unknown>) =>
  InteractiveCardSchema.parse({ ...ARC_SAMPLES[name], ...patch });
const ALL: [string, InteractiveCard][] = [
  ...Object.entries(SAMPLE_CARDS),
  ...EDGE_CASES,
  ...Object.entries(ARC_SAMPLES),
  ...ARC_EDGE_CASES,
];

describe('Arc-era card schemas', () => {
  it('covers every new type with a sample and two edge cases', () => {
    for (const type of ARC_CARD_TYPES) {
      expect(
        Object.values(ARC_SAMPLES).filter((c) => c.type === type),
      ).toHaveLength(1);
      expect(ARC_EDGE_CASES.filter(([, c]) => c.type === type)).toHaveLength(2);
    }
  });

  it('round-trips through JSON unchanged, and the original six still parse', () => {
    for (const [, card] of ALL)
      expect(
        InteractiveCardSchema.parse(JSON.parse(JSON.stringify(card))),
      ).toEqual(card);
  });

  it('refuses approval material, unsafe links and unlabelled modes', () => {
    const bad = (patch: Record<string, unknown>) =>
      InteractiveCardSchema.safeParse({ ...ARC_SAMPLES.deal, ...patch })
        .success;
    expect(bad({})).toBe(true);
    expect(bad({ signature: `0x${'ab'.repeat(65)}` })).toBe(false);
    expect(
      bad({
        actions: [
          {
            kind: 'VIEW',
            label: 'x',
            url: 'javascript:alert(1)',
            style: 'PRIMARY',
          },
        ],
      }),
    ).toBe(false);
    expect(bad({ executionMode: 'LIVE_MAINNET' })).toBe(false);
    expect(bad({ termsHash: '0x1234' })).toBe(false);
    expect(bad({ total: { amount: '1.5e3', symbol: 'USDC' } })).toBe(false);
    expect(bad({ total: { amount: '-1', symbol: 'USDC' } })).toBe(false);
    expect(CARD_EXECUTION_MODES).toEqual(
      expect.arrayContaining([
        'LIVE_ARC_TESTNET',
        'PROVIDER_SANDBOX',
        'LOCAL_FIXTURE',
      ]),
    );
  });

  it('formats base units exactly and derives stable ids', () => {
    expect(cardDecimal(1_250_000_000n, 6)).toBe('1250');
    expect(cardDecimal(30_000n, 6)).toBe('0.03');
    expect(cardDecimal(10n ** 40n + 1n, 18)).toBe(
      '10000000000000000000000.000000000000000001',
    );
    expect(cardIdOf('deal', 'd1', 2)).toMatch(/^card_[0-9a-f]{24}$/);
    expect(cardIdOf('deal', 'd1', 2)).toBe(cardIdOf('deal', 'd1', 2));
    expect(cardIdOf('deal', 'd1', 3)).not.toBe(cardIdOf('deal', 'd1', 2));
  });
});

describe('card themes', () => {
  it('registers the ASCII theme as default and the holo theme beside it', () => {
    expect(Object.keys(CARD_THEMES).sort()).toEqual(['ascii', 'holo']);
    expect(DEFAULT_CARD_THEME).toBe('ascii');
    expect(cardTheme('holo').id).toBe('holo');
    expect(cardTheme('no-such-theme').id).toBe('ascii');
    expect(new CardBannerRenderer().theme.id).toBe(cardTheme().id);
    const card = ARC_SAMPLES.deal!;
    expect(CardBannerRenderer.key(card, 'ascii')).not.toBe(
      CardBannerRenderer.key(card, 'holo'),
    );
  });

  for (const id of Object.keys(CARD_THEMES)) {
    const renderer = new CardBannerRenderer({ theme: id });
    it.each(ALL)(`${id}: renders %s as a 1000x1400 PNG`, async (_, card) => {
      expectPng(await renderer.render(card));
    });
  }
});

describe('card content (theme-independent)', () => {
  const r = new CardBannerRenderer();
  const content = (c: InteractiveCard) => r.content(c);

  it('always names the network and mode, and every theme draws them with the figures', () => {
    for (const [, card] of ALL) {
      const c = content(card);
      expect(c.network).toBeTruthy();
      expect(c.mode?.label).toBeTruthy();
      for (const id of Object.keys(CARD_THEMES)) {
        const tree = JSON.stringify(
          new CardBannerRenderer({ theme: id }).tree(card),
        );
        expect(tree).toContain(c.mode!.label);
        expect(tree).toContain(c.network!);
        if (c.headline)
          expect(tree).toContain(c.headline.value.replace(/^≈\s*/, ''));
      }
    }
    expect(content(ARC_SAMPLES.deal!).network).toBe('Arc Testnet');
    expect(content(ARC_SAMPLES.deal!).mode?.label).toBe('ARC TESTNET');
    expect(content(ARC_SAMPLES.flight!).network).toBe('Off-chain');
    expect(content(ARC_SAMPLES.flight!).mode?.label).toBe('SANDBOX');
    const fixture = ARC_EDGE_CASES.find(([n]) =>
      n.startsWith('deal: draft'),
    )![1];
    expect(content(fixture).mode?.label).toBe('LOCAL FIXTURE');
  });

  it('keeps exact amounts, padded to cents for fiat and stablecoins', () => {
    expect(content(ARC_SAMPLES.deal!).headline).toEqual({
      label: 'TOTAL',
      value: '1,250.00',
      unit: 'USDC',
    });
    const flight = content(ARC_SAMPLES.flight!);
    expect(flight.headline?.value).toBe('254.30');
    expect(flight.rows.map((x) => x.value)).toEqual([
      '254.30 USD',
      '198.75 USD',
      '301.00 USD',
    ]);
    const huge = ARC_EDGE_CASES.find(([n]) =>
      n.startsWith('deal: settled'),
    )![1];
    expect(content(huge).headline?.value).toMatch(/^≈ /);
    const over = ARC_EDGE_CASES.find(([n]) =>
      n.startsWith('invoice: overpaid'),
    )![1];
    expect(content(over).rows[2]).toMatchObject({
      title: 'Overpaid',
      value: '0.376544 USDC',
    });
  });

  it('shortens hashes and addresses in the image; the caption carries them whole', () => {
    const deal = ARC_SAMPLES.deal!;
    if (deal.type !== 'DEAL_PROPOSAL') throw new Error('fixture');
    const tree = JSON.stringify(r.tree(deal));
    expect(tree).not.toContain(deal.termsHash);
    expect(tree).not.toContain(deal.client.address);
    const text = renderTelegramCard(deal).text;
    expect(text).toContain(deal.termsHash);
    expect(text).toContain(deal.client.address);
  });

  it('grades by state: pending common, active rare, settled holo, risk holds warn', () => {
    const grade = (c: InteractiveCard) => content(c).grade;
    expect(grade(ARC_SAMPLES.deal!)).toBe('COMMON');
    expect(grade(edit('deal', { status: 'FUNDED' }))).toBe('RARE');
    expect(grade(edit('deal', { status: 'SETTLED' }))).toBe('HOLO_RARE');
    expect(grade(ARC_SAMPLES.escrow!)).toBe('RARE');
    expect(grade(edit('escrow', { state: 'RELEASED' }))).toBe('HOLO_RARE');
    expect(grade(edit('escrow', { state: 'DISPUTED' }))).toBe('COMMON');
    expect(grade(ARC_SAMPLES.invoice!)).toBe('RARE');
    expect(grade(edit('invoice', { status: 'ISSUED' }))).toBe('COMMON');
    expect(grade(edit('invoice', { status: 'PAID' }))).toBe('HOLO_RARE');
    expect(grade(ARC_SAMPLES.risk!)).toBe('WARNING');
    expect(grade(edit('risk', { state: 'RESOLVED' }))).toBe('COMMON');
    expect(grade(ARC_SAMPLES.agent!)).toBe('COMMON');
    expect(
      grade(edit('agent', { decision: { outcome: 'ALLOW', reasons: [] } })),
    ).toBe('RARE');
    expect(grade(ARC_SAMPLES.contractor!)).toBe('HOLO_RARE');
    expect(grade(edit('contractor', { status: 'PROPOSED' }))).toBe('COMMON');
    expect(grade(ARC_SAMPLES.flight!)).toBe('RARE');
    expect(grade(edit('flight', { preferredOptionId: null }))).toBe('COMMON');
  });

  it('reports the Kernel decision from structured data only', () => {
    const c = content(ARC_SAMPLES.agent!);
    expect(c.rows.at(-1)).toMatchObject({
      title: 'Decision (Kernel)',
      value: 'NEEDS APPROVAL',
    });
    const deny = content(
      edit('agent', { decision: { outcome: 'DENY', reasons: [] } }),
    );
    expect(deny.rows.at(-1)).toMatchObject({ value: 'DENY', tone: 'bad' });
    expect(renderTelegramCard(ARC_SAMPLES.agent!).text).toMatch(
      /Decision \(Kernel\): NEEDS APPROVAL/,
    );
  });
});

describe('text fallback', () => {
  it.each(Object.entries(ARC_SAMPLES))(
    '%s: caption has exact amounts, network, chain id, mode and freshness',
    (_, card) => {
      const text = renderTelegramCard(card).text;
      if (card.type === 'FLIGHT_COMPARISON') {
        expect(text).toContain('Network: Off-chain');
        expect(text).toContain('254.3 USD');
      } else expect(text).toContain('Network: Arc Testnet (chain 5042002)');
      if (isArcCard(card))
        expect(text).toContain(`Mode: [${card.executionMode}]`);
      expect(text).toMatch(/Observed \d{4}-\d{2}-\d{2}T/);
      expect(text.length).toBeLessThanOrEqual(4000);
      expect(renderTelegramCard(card).buttons?.map((b) => b.url)).toEqual(
        card.actions.map((a) => a.url),
      );
    },
  );
});

describe('per-type content code has no theme in it', () => {
  it('names no colour, font, glyph or art', () => {
    const dir = join('packages/channels/src/cards/content');
    for (const file of readdirSync(dir)) {
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
      expect(src, file).not.toMatch(
        /fontFamily|fontSize|\bInter\b|JetBrains|Departure|Noto/,
      );
      expect(src, file).not.toMatch(/<svg|<path|ART_DATA/);
      if (file !== 'text.ts')
        // Only text.ts spells typographic symbols; everything else uses its constants.
        expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''), file).not.toMatch(
          /[←-⇿─-➿•…·]/,
        );
    }
  });
});
