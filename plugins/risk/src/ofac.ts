import { createHash } from 'node:crypto';
import { getAddress, isAddress, type Address } from 'viem';
import type {
  ScreeningResult,
  ScreeningStatus,
  WalletScreeningPort,
} from './screening.js';

/**
 * Sanctions-list screening against the US Treasury OFAC SDN list.
 *
 * This is NOT full wallet screening (no KYT, clustering or exposure analysis):
 * it only reports whether an address is published on the SDN list. Every
 * verdict, audit row and capability label says OFAC_SDN_LIST_ONLY. A mainnet
 * launch needs a chain-analytics provider (Chainalysis, TRM or Elliptic).
 *
 * The snapshot is persisted with its SHA-256 and the time it was fetched. A
 * missing snapshot, or one fetched more than `maxAgeSeconds` ago, makes the
 * port UNAVAILABLE, which fails closed for payouts.
 */
export const OFAC_SDN_PROVIDER_ID = 'OFAC_SDN_LIST_ONLY';
export const OFAC_SDN_SOURCE =
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.CSV';
export const OFAC_SDN_MAX_AGE_SECONDS = 7 * 24 * 3600;
/** The list carries ~90 EVM addresses; far fewer means a truncated or wrong file. */
export const OFAC_SDN_MIN_EVM_ADDRESSES = 20;

export type SdnSnapshot = Readonly<{
  sha256: string;
  /** Publication date when the publisher states one (YYYY-MM-DD), else null. */
  publishedOn: string | null;
  /** Unix seconds when this copy was downloaded. */
  fetchedAt: number;
  source: string;
  /** Lower-case, checksum-validated EVM addresses, sorted and unique. */
  addresses: readonly string[];
}>;

export interface SdnSnapshotStore {
  latest(): Promise<SdnSnapshot | null>;
  save(snapshot: SdnSnapshot): Promise<void>;
}

const ENTRY =
  /Digital Currency Address - ([A-Z0-9]+)[\s;:]+(0x[0-9a-fA-F]{40})\b/g;

/** Extracts every EVM-format digital currency address from the SDN export. */
export function parseSdnEvmAddresses(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ENTRY)) {
    const a = m[2]!;
    if (isAddress(a, { strict: false })) out.add(a.toLowerCase());
  }
  return [...out].sort();
}

export function sdnSnapshotFromText(
  text: string,
  input: { fetchedAt: number; publishedOn: string | null; source: string },
): SdnSnapshot {
  const addresses = parseSdnEvmAddresses(text);
  if (addresses.length < OFAC_SDN_MIN_EVM_ADDRESSES)
    throw new Error(
      `SDN export has ${addresses.length} EVM addresses; expected at least ${OFAC_SDN_MIN_EVM_ADDRESSES}`,
    );
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    publishedOn: input.publishedOn,
    fetchedAt: input.fetchedAt,
    source: input.source,
    addresses,
  };
}

/** Downloads the official export. Throws on any non-200 or malformed body. */
export async function fetchSdnSnapshot(input: {
  now: number;
  fetch?: typeof fetch;
  source?: string;
  timeoutMs?: number;
}): Promise<SdnSnapshot> {
  const source = input.source ?? OFAC_SDN_SOURCE;
  const res = await (input.fetch ?? fetch)(source, {
    redirect: 'follow',
    signal: AbortSignal.timeout(input.timeoutMs ?? 60_000),
  });
  if (res.status !== 200) throw new Error(`SDN download HTTP ${res.status}`);
  const text = await res.text();
  // The publisher redirects to a dated object path (…/YYYY-MM-DD/…/SDN.CSV).
  const dated = /\/(\d{4}-\d{2}-\d{2})\//.exec(res.url ?? '');
  const lastModified = res.headers.get('last-modified');
  const publishedOn =
    dated?.[1] ??
    (lastModified && !Number.isNaN(Date.parse(lastModified))
      ? new Date(lastModified).toISOString().slice(0, 10)
      : null);
  return sdnSnapshotFromText(text, {
    fetchedAt: input.now,
    publishedOn,
    source,
  });
}

export class OfacSdnScreening implements WalletScreeningPort {
  readonly providerId = OFAC_SDN_PROVIDER_ID;
  private current: SdnSnapshot | null = null;
  private set = new Set<string>();
  private lastError: string | null = null;

  constructor(
    private readonly store: SdnSnapshotStore,
    private readonly now: () => number,
    private readonly download: (now: number) => Promise<SdnSnapshot> = (now) =>
      fetchSdnSnapshot({ now }),
    readonly maxAgeSeconds = OFAC_SDN_MAX_AGE_SECONDS,
  ) {}

  /** Loads the newest persisted snapshot (no network). */
  async load(): Promise<SdnSnapshot | null> {
    const s = await this.store.latest();
    if (s && (!this.current || s.fetchedAt > this.current.fetchedAt))
      this.use(s);
    return this.current;
  }

  /**
   * Downloads a fresh copy and persists it. On failure the previous snapshot
   * stays in use only while it is younger than `maxAgeSeconds`.
   */
  async refresh(): Promise<{ ok: boolean; reason: string }> {
    try {
      const s = await this.download(this.now());
      await this.store.save(s);
      this.use(s);
      this.lastError = null;
      return { ok: true, reason: `snapshot ${s.sha256.slice(0, 16)}` };
    } catch (error) {
      this.lastError = (
        error instanceof Error ? error.message : 'download failed'
      ).slice(0, 160);
      await this.load().catch(() => null);
      return { ok: false, reason: this.lastError };
    }
  }

  snapshot(): SdnSnapshot | null {
    return this.current;
  }

  status(): ScreeningStatus {
    const s = this.current;
    if (!s)
      return {
        providerId: this.providerId,
        status: 'UNAVAILABLE',
        missingCredentials: [],
        reason: `no OFAC SDN snapshot is loaded${this.lastError ? ` (${this.lastError})` : ''}`,
      };
    const age = this.now() - s.fetchedAt;
    if (age > this.maxAgeSeconds || age < -300)
      return {
        providerId: this.providerId,
        status: 'UNAVAILABLE',
        missingCredentials: [],
        reason: `OFAC SDN snapshot fetched ${Math.floor(age / 3600)}h ago is stale`,
      };
    return {
      providerId: this.providerId,
      status: 'AVAILABLE',
      missingCredentials: [],
      reason: `OFAC SDN list only (not full wallet screening); ${s.addresses.length} EVM addresses, published ${s.publishedOn ?? 'unknown'}`,
    };
  }

  async screen(input: {
    address: Address;
    chainId: number;
    now: number;
  }): Promise<ScreeningResult> {
    const s = this.current;
    if (!s || this.status().status !== 'AVAILABLE')
      throw new Error(this.status().reason);
    const address = getAddress(input.address);
    const hit = this.set.has(address.toLowerCase());
    return {
      providerId: this.providerId,
      address,
      chainId: input.chainId,
      verdict: hit ? 'HIT' : 'CLEAR',
      reference: `${this.providerId}:sha256=${s.sha256.slice(0, 16)}:published=${s.publishedOn ?? 'unknown'}`,
      reason: hit
        ? 'address is published on the OFAC SDN list'
        : 'address is not on the OFAC SDN list (list-only check, not full wallet screening)',
      screenedAt: input.now,
    };
  }

  private use(s: SdnSnapshot) {
    this.current = s;
    this.set = new Set(s.addresses.map((a) => a.toLowerCase()));
  }
}
