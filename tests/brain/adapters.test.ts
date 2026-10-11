import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FIXTURE_KEY_HEADER,
  FixtureFileSchema,
  RecordReplayTransport,
  ReasonerError,
  loadFixtureFile,
  type PaidToolBudget,
} from '@synq/agent-runtime';
import {
  QWEN_DEFAULT_BASE_URL,
  QwenStructuredReasoner,
  qwenOptionsFromEnv,
} from '@synq/plugin-qwen';
import {
  KIMI_BASE_URL,
  KimiReasoner,
  kimiOptionsFromEnv,
} from '@synq/plugin-kimi';
import { chatCompletion, chatFixture } from './harness.js';

const dir = mkdtempSync(join(tmpdir(), 'synq-brain-fixtures-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const schema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
};
const request = (fixtureKey: string) => ({
  role: 'INTENT' as const,
  agentId: 'run.intent.1',
  fixtureKey,
  messages: [
    { role: 'system' as const, content: 'be strict' },
    { role: 'user' as const, content: 'hello' },
  ],
  responseSchema: { name: 'Probe', schema },
  maxOutputTokens: 500,
});
const budget = (limit: number): PaidToolBudget & { spent: number } => ({
  spent: 0,
  tryCharge(micro) {
    if (this.spent + micro > limit) return false;
    this.spent += micro;
    return true;
  },
  chargeToolCall: () => true,
});

describe('Qwen adapter contract (qwen3.8-max, OpenAI-compatible)', () => {
  it('sends a JSON-schema structured request to the DashScope endpoint and labels replay honestly', async () => {
    const qwen = new QwenStructuredReasoner({
      mode: 'REPLAY',
      fixtures: chatFixture('qwen', [{ key: 'probe', content: { ok: true } }]),
    });
    const result = await qwen.complete(request('probe'));
    expect(result).toMatchObject({
      text: '{"ok":true}',
      provider: 'qwen',
      model: 'qwen3.8-max',
      mode: 'REPLAY',
      fixtureLabel: 'HAND_AUTHORED_FIXTURE',
      structuredMode: 'JSON_SCHEMA',
      inputTokens: 1_200,
      outputTokens: 300,
    });
    const [exchange] = qwen.transport.exchanges;
    expect(exchange?.path).toBe('/compatible-mode/v1/chat/completions');
    expect(exchange?.requestBody).toMatchObject({
      model: 'qwen3.8-max',
      temperature: 0,
      max_tokens: 500,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'Probe', schema, strict: true },
      },
      messages: [
        { role: 'system', content: 'be strict' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(QWEN_DEFAULT_BASE_URL).toBe(
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    );
    expect(qwen.availability()).toEqual({
      providerId: 'QWEN',
      installed: true,
      credentialsPresent: false,
      mode: 'REPLAY',
    });
  });

  it('falls back to json_object plus the schema hint when JSON-schema mode is refused', async () => {
    const qwen = new QwenStructuredReasoner({
      mode: 'REPLAY',
      fixtures: chatFixture('qwen', [
        { key: 'fallback', status: 400 },
        { key: 'fallback', content: { ok: false } },
      ]),
    });
    const result = await qwen.complete(request('fallback'));
    expect(result.structuredMode).toBe('JSON_OBJECT');
    expect(result.text).toBe('{"ok":false}');
    const second = qwen.transport.exchanges[1]?.requestBody as {
      response_format: unknown;
      messages: { content: string }[];
    };
    expect(second.response_format).toEqual({ type: 'json_object' });
    expect(second.messages[0]?.content).toContain('Probe');
  });

  it('resolves keys and base URL from the documented environment variables only', () => {
    expect(qwenOptionsFromEnv({}).mode).toBe('REPLAY');
    const live = qwenOptionsFromEnv({
      DASHSCOPE_API_KEY: 'k',
      QWEN_BASE_URL: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    });
    expect(live).toMatchObject({
      mode: 'LIVE',
      apiKey: 'k',
      baseURL: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    });
    expect(
      qwenOptionsFromEnv({ QWEN_API_KEY: 'k' }, { recordTo: 'x.json' }).mode,
    ).toBe('RECORD');
    expect(() => new QwenStructuredReasoner({ mode: 'LIVE' })).toThrow(
      ReasonerError,
    );
  });

  it('a replay miss fails closed', async () => {
    const qwen = new QwenStructuredReasoner({
      mode: 'REPLAY',
      fixtures: chatFixture('qwen', []),
    });
    await expect(qwen.complete(request('absent'))).rejects.toMatchObject({
      code: 'REPLAY_MISS',
    });
  });
});

describe('Kimi adapter contract (kimi-k3, /v1/tools/search and /v1/tools/fetch)', () => {
  const kimiFixture = (key: string) =>
    chatFixture(
      'kimi',
      [{ key, content: { ok: true } }],
      [
        {
          fixtureKey: key,
          method: 'POST',
          path: '/v1/tools/search',
          requestBodyHash: null,
          response: {
            status: 200,
            body: {
              search_results: [
                {
                  title: 'MON liquidity',
                  url: 'https://news.example/mon',
                  site_name: 'news',
                  snippet: 'Depth on MON-AUSD improved.',
                  date: '2026-10-09',
                  text: '',
                  authority: 'high',
                  icon: '',
                  mime: 'text/html',
                },
              ],
            },
          },
        },
        {
          fixtureKey: key,
          method: 'POST',
          path: '/v1/tools/fetch',
          requestBodyHash: null,
          response: {
            status: 200,
            body: {
              url: 'https://news.example/mon',
              title: 'MON liquidity',
              markdown: '# Depth\nGood.',
            },
          },
        },
      ],
    );
  it('uses the standalone tools API, wraps results as untrusted evidence and accounts paid calls', async () => {
    const kimi = new KimiReasoner({
      mode: 'REPLAY',
      fixtures: kimiFixture('research'),
      now: () => 50,
    });
    const b = budget(1_000_000);
    const result = await kimi.research({
      ...request('research'),
      role: 'RESEARCH',
      queries: ['MON liquidity'],
      maxResultsPerQuery: 3,
      maxFetches: 1,
      budget: b,
    });
    expect(result.paidToolCalls).toBe(2);
    expect(result.paidToolMicroUsd).toBe(4_000);
    expect(b.spent).toBe(4_000);
    expect(result.evidence.map((e) => [e.kind, e.untrusted])).toEqual([
      ['WEB_SEARCH_RESULT', true],
      ['WEB_PAGE', true],
    ]);
    const paths = kimi.transport.exchanges.map((e) => e.path);
    expect(paths).toEqual([
      '/v1/tools/search',
      '/v1/tools/fetch',
      '/v1/chat/completions',
    ]);
    expect(kimi.transport.exchanges[0]?.requestBody).toEqual({
      text_query: 'MON liquidity',
      limit: 3,
      timeout_seconds: 30,
      include_content: false,
    });
    expect(kimi.transport.exchanges[1]?.requestBody).toEqual({
      url: 'https://news.example/mon',
    });
    expect(kimi.transport.exchanges[2]?.requestBody).toMatchObject({
      model: 'kimi-k3',
    });
    expect(JSON.stringify(kimi.transport.exchanges[2]?.requestBody)).toContain(
      'untrusted_evidence',
    );
    expect(JSON.stringify(kimi.transport.exchanges)).not.toContain(
      '$web_search',
    );
    expect(KIMI_BASE_URL).toBe('https://api.moonshot.ai/v1');
  });

  it('refuses paid calls beyond the budget without calling the provider', async () => {
    const kimi = new KimiReasoner({
      mode: 'REPLAY',
      fixtures: kimiFixture('cheap'),
      now: () => 50,
    });
    const result = await kimi.research({
      ...request('cheap'),
      role: 'RESEARCH',
      queries: ['MON liquidity', 'AUSD peg'],
      maxResultsPerQuery: 3,
      maxFetches: 1,
      budget: budget(2_000),
    });
    expect(result.deniedByBudget).toEqual(['kimi.search#1', 'kimi.fetch#0']);
    expect(kimi.transport.exchanges.map((e) => e.path)).toEqual([
      '/v1/tools/search',
      '/v1/chat/completions',
    ]);
  });

  it('resolves MOONSHOT_API_KEY/KIMI_API_KEY and refuses live mode without one', () => {
    expect(kimiOptionsFromEnv({}).mode).toBe('REPLAY');
    expect(kimiOptionsFromEnv({ MOONSHOT_API_KEY: 'm' })).toMatchObject({
      mode: 'LIVE',
      apiKey: 'm',
    });
    expect(() => new KimiReasoner({ mode: 'LIVE' })).toThrow(ReasonerError);
  });
});

describe('record/replay transport', () => {
  it('records only with a live transport, strips credentials and the fixture header, and binds request bodies', async () => {
    const seen: Headers[] = [];
    const liveFetch: typeof fetch = async (_url, init) => {
      seen.push(new Headers(init?.headers));
      return new Response(
        JSON.stringify(chatCompletion('{"ok":true}', { model: 'qwen3.8-max' })),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    };
    const recordTo = join(dir, 'qwen.recorded.json');
    const qwen = new QwenStructuredReasoner({
      mode: 'RECORD',
      apiKey: 'sk-test-only-not-a-secret',
      recordTo,
      liveFetch,
    });
    const live = await qwen.complete(request('rec'));
    expect(live).toMatchObject({ mode: 'LIVE', fixtureLabel: 'RECORDED_LIVE' });
    expect(seen[0]?.get('authorization')).toBe(
      'Bearer sk-test-only-not-a-secret',
    );
    expect(seen[0]?.has(FIXTURE_KEY_HEADER)).toBe(false);
    qwen.transport.flush('Recorded in a unit test with a stub live fetch.');
    const text = readFileSync(recordTo, 'utf8');
    expect(text).not.toContain('sk-test-only');
    const recorded = loadFixtureFile(recordTo);
    expect(recorded.label).toBe('RECORDED_LIVE');
    expect(recorded.interactions[0]?.requestBodyHash).toMatch(/^0x/);
    const replay = new QwenStructuredReasoner({
      mode: 'REPLAY',
      fixtures: recorded,
    });
    expect((await replay.complete(request('rec'))).fixtureLabel).toBe(
      'RECORDED_LIVE',
    );
    const drift = new QwenStructuredReasoner({
      mode: 'REPLAY',
      fixtures: recorded,
    });
    await expect(
      drift.complete({ ...request('rec'), maxOutputTokens: 501 }),
    ).rejects.toMatchObject({ code: 'REPLAY_MISS' });
  });

  it('labels are enforced: hand-authored fixtures cannot claim a recording and providers cannot be swapped', () => {
    const base = {
      schemaVersion: 1,
      provider: 'qwen',
      description: 'label enforcement probe fixture',
      interactions: [],
    };
    expect(
      FixtureFileSchema.safeParse({
        ...base,
        label: 'HAND_AUTHORED_FIXTURE',
        recordedAt: '2026-10-10T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      FixtureFileSchema.safeParse({
        ...base,
        label: 'RECORDED_LIVE',
        recordedAt: null,
      }).success,
    ).toBe(false);
    expect(
      () =>
        new RecordReplayTransport('REPLAY', {
          provider: 'kimi',
          fixtures: chatFixture('qwen', []),
        }),
    ).toThrow(/provider mismatch/);
  });
});
