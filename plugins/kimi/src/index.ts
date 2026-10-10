import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import {
  FIXTURE_KEY_HEADER,
  RecordReplayTransport,
  ReasonerError,
  httpStatusOf,
  renderUntrusted,
  toChatPrompt,
  toReasonerError,
  wrapUntrusted,
  type ChatPromptMessage,
  type CriticReasoner,
  type FixtureFile,
  type ProviderAvailability,
  type ReasonerRequest,
  type ReasonerResult,
  type ResearchReasoner,
  type ResearchRequest,
  type ResearchResult,
  type TransportMode,
} from '@synq/agent-runtime';
import { canonicalArtifactHash, type UntrustedEvidence } from '@synq/schemas';

export const KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
export const KIMI_MODEL = 'kimi-k3';
export const KIMI_SEARCH_MICRO_USD = 2_000;
export const KIMI_FETCH_MICRO_USD = 2_000;

export const KimiSearchResponseSchema = z.object({
  search_results: z.array(
    z.object({
      title: z.string().max(2_000),
      url: z.string().max(2_048),
      site_name: z.string().max(500),
      snippet: z.string().max(10_000),
      date: z.string().max(100),
      text: z.string().max(200_000),
      authority: z.string().max(100),
      icon: z.string().max(2_048),
      mime: z.string().max(200),
    }),
  ),
});
export const KimiFetchResponseSchema = z.object({
  url: z.string().max(2_048),
  title: z.string().max(2_000),
  markdown: z.string().max(500_000),
});

export type KimiOptions = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  mode: TransportMode;
  fixtures?: FixtureFile;
  recordTo?: string;
  liveFetch?: typeof globalThis.fetch;
  now?: () => number;
};

export function kimiOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  replay: { fixtures?: FixtureFile; recordTo?: string } = {},
): KimiOptions {
  const apiKey = (env.KIMI_API_KEY ?? env.MOONSHOT_API_KEY ?? '').trim();
  const baseURL = env.KIMI_BASE_URL?.trim() || KIMI_BASE_URL;
  if (!apiKey)
    return {
      baseURL,
      mode: 'REPLAY',
      ...(replay.fixtures ? { fixtures: replay.fixtures } : {}),
    };
  return {
    apiKey,
    baseURL,
    mode: replay.recordTo ? 'RECORD' : 'LIVE',
    ...(replay.recordTo ? { recordTo: replay.recordTo } : {}),
  };
}

type GenerateContent = {
  type: string;
  text?: string;
  toolName?: string;
  input?: string;
};

export class KimiReasoner implements ResearchReasoner, CriticReasoner {
  readonly provider = 'kimi' as const;
  readonly model: string;
  readonly transport: RecordReplayTransport;
  private readonly schemaModel;
  private readonly objectModel;
  private readonly hasKey: boolean;
  private readonly baseURL: string;
  private readonly apiKey: string | undefined;
  private readonly now: () => number;

  constructor(options: KimiOptions) {
    this.model = options.model ?? KIMI_MODEL;
    this.hasKey = Boolean(options.apiKey);
    this.apiKey = options.apiKey;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    if (options.mode !== 'REPLAY' && !this.hasKey)
      throw new ReasonerError(
        'PROVIDER_UNAVAILABLE',
        'Kimi live mode needs KIMI_API_KEY or MOONSHOT_API_KEY',
      );
    this.baseURL = (options.baseURL ?? KIMI_BASE_URL).replace(/\/+$/, '');
    this.transport = new RecordReplayTransport(options.mode, {
      provider: 'kimi',
      ...(options.fixtures ? { fixtures: options.fixtures } : {}),
      ...(options.recordTo ? { recordTo: options.recordTo } : {}),
      ...(options.liveFetch ? { liveFetch: options.liveFetch } : {}),
    });
    const base = {
      name: 'kimi',
      baseURL: this.baseURL,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      fetch: this.transport.fetch,
      includeUsage: true,
    };
    this.schemaModel = createOpenAICompatible({
      ...base,
      supportsStructuredOutputs: true,
    }).chatModel(this.model);
    this.objectModel = createOpenAICompatible({
      ...base,
      supportsStructuredOutputs: false,
    }).chatModel(this.model);
  }

  availability(): ProviderAvailability {
    return {
      providerId: 'KIMI',
      installed: true,
      credentialsPresent: this.hasKey,
      mode: this.transport.mode,
    };
  }

  private async tool(
    path: '/tools/search' | '/tools/fetch',
    body: Record<string, unknown>,
    fixtureKey: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [FIXTURE_KEY_HEADER]: fixtureKey,
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.transport.fetch(`${this.baseURL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json };
  }

  async research(request: ResearchRequest): Promise<ResearchResult> {
    const evidence: UntrustedEvidence[] = [];
    const denied: string[] = [];
    let paidToolCalls = 0;
    let paidToolMicroUsd = 0;
    let externalCalls = 0;
    const urls: string[] = [];
    for (const [qi, query] of request.queries.entries()) {
      const label = `kimi.search#${qi}`;
      if (
        !request.budget.chargeToolCall(label) ||
        !request.budget.tryCharge(KIMI_SEARCH_MICRO_USD, label)
      ) {
        denied.push(label);
        continue;
      }
      paidToolCalls++;
      paidToolMicroUsd += KIMI_SEARCH_MICRO_USD;
      externalCalls++;
      const { status, json } = await this.tool(
        '/tools/search',
        {
          text_query: query.slice(0, 500),
          limit: Math.min(20, Math.max(1, request.maxResultsPerQuery)),
          timeout_seconds: 30,
          include_content: false,
        },
        request.fixtureKey,
        request.signal,
      );
      if (status !== 200)
        throw new ReasonerError('PROVIDER_HTTP_ERROR', `search HTTP ${status}`);
      const parsed = KimiSearchResponseSchema.safeParse(json);
      if (!parsed.success)
        throw new ReasonerError('RESPONSE_INVALID', 'search response shape');
      parsed.data.search_results.forEach((r, ri) => {
        urls.push(r.url);
        evidence.push(
          wrapUntrusted({
            evidenceId: `${request.agentId}.search.${qi}.${ri}`,
            kind: 'WEB_SEARCH_RESULT',
            origin: r.url || r.site_name || 'kimi-search',
            retrievedAt: this.now(),
            content: `${r.title}\n${r.snippet}`,
          }),
        );
      });
    }
    for (const [fi, url] of urls.slice(0, request.maxFetches).entries()) {
      if (!/^https?:\/\/[^/\s]+/i.test(url)) continue;
      const label = `kimi.fetch#${fi}`;
      if (
        !request.budget.chargeToolCall(label) ||
        !request.budget.tryCharge(KIMI_FETCH_MICRO_USD, label)
      ) {
        denied.push(label);
        continue;
      }
      paidToolCalls++;
      paidToolMicroUsd += KIMI_FETCH_MICRO_USD;
      externalCalls++;
      const { status, json } = await this.tool(
        '/tools/fetch',
        { url },
        request.fixtureKey,
        request.signal,
      );
      if (status !== 200) continue;
      const parsed = KimiFetchResponseSchema.safeParse(json);
      if (!parsed.success) continue;
      evidence.push(
        wrapUntrusted({
          evidenceId: `${request.agentId}.fetch.${fi}`,
          kind: 'WEB_PAGE',
          origin: parsed.data.url,
          retrievedAt: this.now(),
          content: `${parsed.data.title}\n${parsed.data.markdown}`,
        }),
      );
    }
    const messages = [
      ...request.messages,
      {
        role: 'user' as const,
        content: `RETRIEVED EVIDENCE (cite ids):\n${renderUntrusted(evidence)}`,
      },
    ];
    const result = await this.chat({ ...request, messages });
    return {
      ...result,
      evidence,
      paidToolCalls,
      paidToolMicroUsd,
      externalCalls,
      deniedByBudget: denied,
    };
  }

  critique(request: ReasonerRequest): Promise<ReasonerResult> {
    return this.chat(request);
  }

  private async chat(request: ReasonerRequest): Promise<ReasonerResult> {
    const prompt = toChatPrompt(request.messages);
    const common = {
      maxOutputTokens: request.maxOutputTokens,
      headers: { [FIXTURE_KEY_HEADER]: request.fixtureKey },
      ...(request.signal ? { abortSignal: request.signal } : {}),
    };
    let structuredMode: ReasonerResult['structuredMode'] =
      request.responseSchema ? 'JSON_SCHEMA' : 'TEXT';
    let response;
    try {
      response = await this.schemaModel.doGenerate({
        ...common,
        prompt,
        ...(request.responseSchema
          ? {
              responseFormat: {
                type: 'json' as const,
                name: request.responseSchema.name,
                schema: request.responseSchema.schema,
              },
            }
          : {}),
      });
    } catch (error) {
      if (!request.responseSchema || httpStatusOf(error) !== 400)
        throw toReasonerError(error);
      structuredMode = 'JSON_OBJECT';
      const hint: ChatPromptMessage = {
        role: 'system',
        content: `Respond with one JSON object that validates against this JSON Schema named ${request.responseSchema.name}: ${JSON.stringify(request.responseSchema.schema)}`,
      };
      try {
        response = await this.objectModel.doGenerate({
          ...common,
          prompt: [hint, ...prompt],
          responseFormat: { type: 'json' as const },
        });
      } catch (fallback) {
        throw toReasonerError(fallback);
      }
    }
    const content = response.content as GenerateContent[];
    const exchange = this.transport.exchanges.at(-1);
    return {
      text: content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text!)
        .join(''),
      toolCalls: content
        .filter((c) => c.type === 'tool-call')
        .map((c) => ({ name: c.toolName ?? '', arguments: c.input ?? '' })),
      inputTokens: response.usage.inputTokens.total ?? 0,
      outputTokens: response.usage.outputTokens.total ?? 0,
      provider: 'kimi',
      model: this.model,
      mode: this.transport.mode === 'REPLAY' ? 'REPLAY' : 'LIVE',
      fixtureLabel: this.transport.label,
      requestHash: canonicalArtifactHash(exchange?.requestBody ?? null),
      responseHash: canonicalArtifactHash(exchange?.responseBody ?? null),
      structuredMode,
    };
  }
}
