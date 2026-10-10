import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  FixtureLabelSchema,
  HashSchema,
  canonicalArtifactHash,
  type FixtureLabel,
} from '@synq/schemas';
import { ReasonerError } from './ports.js';

export const FIXTURE_KEY_HEADER = 'x-synq-fixture-key';
const InteractionSchema = z.strictObject({
  fixtureKey: z.string().min(1).max(200),
  method: z.enum(['POST', 'GET']),
  path: z.string().regex(/^\/[A-Za-z0-9/_.-]*$/),
  requestBodyHash: HashSchema.nullable(),
  response: z.strictObject({
    status: z.number().int().min(100).max(599),
    body: z.json(),
  }),
});
export const FixtureFileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    label: FixtureLabelSchema,
    provider: z.enum(['qwen', 'kimi']),
    description: z.string().min(10).max(500),
    recordedAt: z.iso.datetime().nullable(),
    interactions: z.array(InteractionSchema),
  })
  .refine(
    (v) => (v.label === 'RECORDED_LIVE') === (v.recordedAt !== null),
    'only RECORDED_LIVE fixtures carry recordedAt',
  )
  .refine(
    (v) =>
      v.label !== 'RECORDED_LIVE' ||
      v.interactions.every((i) => i.requestBodyHash !== null),
    'recorded interactions bind their request body hash',
  );
export type FixtureFile = z.output<typeof FixtureFileSchema>;
export type Interaction = z.output<typeof InteractionSchema>;

export function loadFixtureFile(path: string): FixtureFile {
  return FixtureFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export type TransportMode = 'LIVE' | 'REPLAY' | 'RECORD';
export type CapturedExchange = {
  fixtureKey: string;
  path: string;
  requestBody: unknown;
  status: number;
  responseBody: unknown;
  label: FixtureLabel | null;
};

type FetchLike = typeof globalThis.fetch;
const headerValue = (init: RequestInit | undefined, name: string) => {
  const headers = new Headers(init?.headers);
  return headers.get(name);
};
const withoutHeader = (init: RequestInit | undefined, name: string) => {
  const headers = new Headers(init?.headers);
  headers.delete(name);
  return { ...init, headers };
};
const bodyJson = (init: RequestInit | undefined): unknown => {
  if (typeof init?.body !== 'string') return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
};

export class RecordReplayTransport {
  readonly exchanges: CapturedExchange[] = [];
  private readonly used = new Map<string, number>();
  private readonly recorded: Interaction[] = [];
  constructor(
    readonly mode: TransportMode,
    private readonly options: {
      fixtures?: FixtureFile;
      provider: 'qwen' | 'kimi';
      recordTo?: string;
      liveFetch?: FetchLike;
    },
  ) {
    if (mode === 'REPLAY' && !options.fixtures)
      throw new ReasonerError('REPLAY_MISS', 'replay mode needs fixtures');
    if (options.fixtures && options.fixtures.provider !== options.provider)
      throw new ReasonerError('REPLAY_MISS', 'fixture provider mismatch');
  }
  get label(): FixtureLabel | null {
    if (this.mode === 'REPLAY') return this.options.fixtures!.label;
    return this.mode === 'RECORD' ? 'RECORDED_LIVE' : null;
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const fixtureKey = headerValue(init, FIXTURE_KEY_HEADER) ?? 'unkeyed';
    const requestBody = bodyJson(init);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (this.mode === 'REPLAY') {
      const slot = `${fixtureKey}|${url.pathname}`;
      const n = this.used.get(slot) ?? 0;
      const matches = this.options.fixtures!.interactions.filter(
        (i) =>
          i.fixtureKey === fixtureKey &&
          i.path === url.pathname &&
          i.method === method,
      );
      const hit = matches[n];
      if (!hit)
        throw new ReasonerError(
          'REPLAY_MISS',
          `no fixture for ${fixtureKey} ${method} ${url.pathname} #${n}`,
        );
      if (
        hit.requestBodyHash !== null &&
        hit.requestBodyHash !== canonicalArtifactHash(requestBody)
      )
        throw new ReasonerError(
          'REPLAY_MISS',
          `recorded request body differs for ${fixtureKey}`,
        );
      this.used.set(slot, n + 1);
      this.exchanges.push({
        fixtureKey,
        path: url.pathname,
        requestBody,
        status: hit.response.status,
        responseBody: hit.response.body,
        label: this.label,
      });
      return new Response(JSON.stringify(hit.response.body), {
        status: hit.response.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    const live = this.options.liveFetch ?? globalThis.fetch;
    const response = await live(url, withoutHeader(init, FIXTURE_KEY_HEADER));
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { nonJson: text.slice(0, 2000) };
    }
    this.exchanges.push({
      fixtureKey,
      path: url.pathname,
      requestBody,
      status: response.status,
      responseBody: parsed,
      label: this.label,
    });
    if (this.mode === 'RECORD')
      this.recorded.push({
        fixtureKey,
        method: method === 'GET' ? 'GET' : 'POST',
        path: url.pathname,
        requestBodyHash: canonicalArtifactHash(requestBody),
        response: { status: response.status, body: z.json().parse(parsed) },
      });
    return new Response(text, {
      status: response.status,
      headers: response.headers,
    });
  };

  flush(description: string, now = new Date()): FixtureFile | null {
    if (this.mode !== 'RECORD' || !this.options.recordTo) return null;
    const file = FixtureFileSchema.parse({
      schemaVersion: 1,
      label: 'RECORDED_LIVE',
      provider: this.options.provider,
      description,
      recordedAt: now.toISOString(),
      interactions: this.recorded,
    });
    mkdirSync(dirname(this.options.recordTo), { recursive: true });
    writeFileSync(this.options.recordTo, JSON.stringify(file, null, 2) + '\n');
    return file;
  }
}
