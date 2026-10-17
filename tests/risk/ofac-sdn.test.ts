import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  fetchSdnSnapshot,
  OFAC_SDN_MAX_AGE_SECONDS,
  OfacSdnScreening,
  parseSdnEvmAddresses,
  screenSafely,
  screeningFlags,
  sdnSnapshotFromText,
  type SdnSnapshot,
} from '@synq/plugin-risk';

const NOW = 2_000_000_000;
const LISTED = '0x8888888888888888888888888888888888888888';
const filler = Array.from(
  { length: 24 },
  (_, i) =>
    `"x","ENTITY ${i}",-0-,"CYBER",-0-,"Digital Currency Address - ETH 0x${(i + 1).toString(16).padStart(40, '0')}; alt. Digital Currency Address - XBT bc1qexample${i};"`,
);
const EXPORT = [
  ...filler,
  `"y","MIXER",-0-,"CYBER2",-0-,"Digital Currency Address - USDC ${LISTED}; Digital Currency Address - USDT ${LISTED.toUpperCase().replace('0X', '0x')};"`,
].join('\n');

function memoryStore(initial: SdnSnapshot | null = null) {
  let saved = initial;
  return {
    latest: async () => saved,
    save: async (s: SdnSnapshot) => {
      saved = s;
    },
    get: () => saved,
  };
}
const snap = (fetchedAt = NOW - 60) =>
  sdnSnapshotFromText(EXPORT, {
    fetchedAt,
    publishedOn: '2026-10-15',
    source: 'test',
  });
const offline = async (): Promise<SdnSnapshot> => {
  throw new Error('offline');
};

describe('G11 OFAC SDN list screening — LOCAL_FIXTURE', () => {
  it('extracts unique lower-case EVM addresses for every token label and ignores non-EVM formats', () => {
    const a = parseSdnEvmAddresses(EXPORT);
    expect(a).toHaveLength(25);
    expect(a).toContain(LISTED);
    expect(a.every((x) => x === x.toLowerCase() && x.length === 42)).toBe(true);
    expect(a.some((x) => x.includes('bc1q'))).toBe(false);
  });

  it('rejects a truncated or wrong export instead of treating it as an empty list', () => {
    expect(() =>
      sdnSnapshotFromText(filler.slice(0, 3).join('\n'), {
        fetchedAt: NOW,
        publishedOn: null,
        source: 'test',
      }),
    ).toThrow(/expected at least/);
  });

  it('reports HIT for a listed address in any case and CLEAR otherwise, labelled list-only', async () => {
    const port = new OfacSdnScreening(memoryStore(snap()), () => NOW, offline);
    await port.load();
    expect(port.status()).toMatchObject({
      status: 'AVAILABLE',
      providerId: 'OFAC_SDN_LIST_ONLY',
    });
    expect(port.status().reason).toMatch(/not full wallet screening/);
    const hit = await screenSafely(port, {
      address: getAddress(LISTED),
      chainId: 5042002,
      now: NOW,
    });
    expect(hit.verdict).toBe('HIT');
    expect(hit.reference).toMatch(
      /^OFAC_SDN_LIST_ONLY:sha256=[0-9a-f]{16}:published=2026-10-15$/,
    );
    expect(
      screeningFlags({
        result: hit,
        amount: 1n,
        highValueAt: 0n,
        counterpartyVerified: true,
      }).flags[0],
    ).toMatchObject({ code: 'SCREENING_HIT', severity: 'HARD' });
    const clear = await screenSafely(port, {
      address: '0x00000000000000000000000000000000000000Ff',
      chainId: 5042002,
      now: NOW,
    });
    expect(clear.verdict).toBe('CLEAR');
    expect(clear.reason).toMatch(/list-only/);
  });

  it('is UNAVAILABLE (fail closed) with no snapshot or a stale one', async () => {
    const none = new OfacSdnScreening(memoryStore(), () => NOW, offline);
    await none.load();
    const r = await screenSafely(none, {
      address: getAddress(LISTED),
      chainId: 5042002,
      now: NOW,
    });
    expect(r.verdict).toBe('UNAVAILABLE');
    expect(
      screeningFlags({
        result: r,
        amount: 1n,
        highValueAt: 0n,
        counterpartyVerified: true,
      }).flags[0],
    ).toMatchObject({ code: 'SCREENING_UNAVAILABLE', severity: 'HARD' });
    const stale = new OfacSdnScreening(
      memoryStore(snap(NOW - OFAC_SDN_MAX_AGE_SECONDS - 1)),
      () => NOW,
      offline,
    );
    await stale.load();
    expect(stale.status().status).toBe('UNAVAILABLE');
    expect(
      (
        await screenSafely(stale, {
          address: '0x00000000000000000000000000000000000000Ff',
          chainId: 5042002,
          now: NOW,
        })
      ).verdict,
    ).toBe('UNAVAILABLE');
  });

  it('keeps the last good snapshot through a failed refresh only while it is fresh', async () => {
    let now = NOW;
    const store = memoryStore(snap(NOW - 3600));
    const port = new OfacSdnScreening(store, () => now, offline);
    await port.load();
    expect(await port.refresh()).toMatchObject({ ok: false });
    expect(port.status().status).toBe('AVAILABLE');
    now = NOW - 3600 + OFAC_SDN_MAX_AGE_SECONDS + 1;
    expect(await port.refresh()).toMatchObject({ ok: false });
    expect(port.status().status).toBe('UNAVAILABLE');
    const healthy = new OfacSdnScreening(
      store,
      () => now,
      async (t) => snap(t),
    );
    expect(await healthy.refresh()).toMatchObject({ ok: true });
    expect(store.get()?.fetchedAt).toBe(now);
    expect(healthy.status().status).toBe('AVAILABLE');
  });

  it('downloads with the publication date from the dated object path and refuses non-200 answers', async () => {
    const ok = await fetchSdnSnapshot({
      now: NOW,
      fetch: (async () => {
        const r = new Response(EXPORT, { status: 200 });
        Object.defineProperty(r, 'url', {
          value: 'https://example.invalid/Published/abc/2026-10-15/def/SDN.CSV',
        });
        return r;
      }) as unknown as typeof fetch,
    });
    expect(ok.publishedOn).toBe('2026-10-15');
    expect(ok.addresses).toHaveLength(25);
    await expect(
      fetchSdnSnapshot({
        now: NOW,
        fetch: (async () =>
          new Response('busy', { status: 503 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
