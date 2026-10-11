import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  FIXTURE_KEY_HEADER,
  RecordReplayTransport,
  ReasonerError,
  type FixtureFile,
  type ProviderAvailability,
  type ReasonerRequest,
  type ReasonerResult,
  type StructuredReasoner,
  type CriticReasoner,
  type TransportMode,
  type ChatPromptMessage,
  httpStatusOf,
  toChatPrompt,
  toReasonerError,
} from '@synq/agent-runtime';
import { canonicalArtifactHash } from '@synq/schemas';

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_MODEL = 'gpt-5.6-luna';

export type OpenAIOptions = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  mode: TransportMode;
  fixtures?: FixtureFile;
  recordTo?: string;
  liveFetch?: typeof globalThis.fetch;
};

export function openAIOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  replay: { fixtures?: FixtureFile; recordTo?: string } = {},
): OpenAIOptions {
  const apiKey = (env.OPENAI_API_KEY ?? '').trim();
  const baseURL = env.OPENAI_BASE_URL?.trim() || OPENAI_DEFAULT_BASE_URL;
  const model = env.OPENAI_MODEL?.trim() || OPENAI_DEFAULT_MODEL;
  if (!apiKey)
    return {
      baseURL,
      model,
      mode: 'REPLAY',
      ...(replay.fixtures ? { fixtures: replay.fixtures } : {}),
    };
  return {
    apiKey,
    baseURL,
    model,
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

/**
 * OpenAI Chat Completions as a Brain structured reasoner (not a sponsor
 * integration). Output is untrusted text until the Brain validator accepts it.
 */
export class OpenAIStructuredReasoner
  implements StructuredReasoner, CriticReasoner
{
  readonly provider = 'openai' as const;
  readonly model: string;
  readonly transport: RecordReplayTransport;
  private readonly schemaModel;
  private readonly objectModel;
  private readonly hasKey: boolean;

  constructor(options: OpenAIOptions) {
    this.model = options.model ?? OPENAI_DEFAULT_MODEL;
    this.hasKey = Boolean(options.apiKey);
    if (options.mode !== 'REPLAY' && !this.hasKey)
      throw new ReasonerError(
        'PROVIDER_UNAVAILABLE',
        'OpenAI live mode needs OPENAI_API_KEY',
      );
    this.transport = new RecordReplayTransport(options.mode, {
      provider: 'openai',
      ...(options.fixtures ? { fixtures: options.fixtures } : {}),
      ...(options.recordTo ? { recordTo: options.recordTo } : {}),
      ...(options.liveFetch ? { liveFetch: options.liveFetch } : {}),
    });
    const base = {
      name: 'openai',
      baseURL: options.baseURL ?? OPENAI_DEFAULT_BASE_URL,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      fetch: this.transport.fetch,
      includeUsage: true,
      transformRequestBody: openAIRequestBody,
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
      providerId: 'OPENAI',
      installed: true,
      credentialsPresent: this.hasKey,
      mode: this.transport.mode,
    };
  }

  critique(request: ReasonerRequest): Promise<ReasonerResult> {
    return this.complete(request);
  }

  async complete(request: ReasonerRequest): Promise<ReasonerResult> {
    const prompt = toChatPrompt(request.messages);
    const headers = { [FIXTURE_KEY_HEADER]: request.fixtureKey };
    const common = {
      maxOutputTokens: request.maxOutputTokens,
      temperature: 0,
      headers,
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
      const schemaHint: ChatPromptMessage = {
        role: 'system',
        content: `Respond with a single JSON object that validates against this JSON Schema named ${request.responseSchema.name}: ${JSON.stringify(request.responseSchema.schema)}`,
      };
      try {
        response = await this.objectModel.doGenerate({
          ...common,
          prompt: [schemaHint, ...prompt],
          responseFormat: { type: 'json' as const },
        });
      } catch (fallback) {
        throw toReasonerError(fallback);
      }
    }
    const content = response.content as GenerateContent[];
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('');
    const exchange = this.transport.exchanges.at(-1);
    return {
      text,
      toolCalls: content
        .filter((c) => c.type === 'tool-call')
        .map((c) => ({ name: c.toolName ?? '', arguments: c.input ?? '' })),
      inputTokens: response.usage.inputTokens.total ?? 0,
      outputTokens: response.usage.outputTokens.total ?? 0,
      provider: 'openai',
      model: this.model,
      mode: this.transport.mode === 'REPLAY' ? 'REPLAY' : 'LIVE',
      fixtureLabel: this.transport.label,
      requestHash: canonicalArtifactHash(exchange?.requestBody ?? null),
      responseHash: canonicalArtifactHash(exchange?.responseBody ?? null),
      structuredMode,
    };
  }
}

/** Current OpenAI chat models take max_completion_tokens and only the default temperature. */
export function openAIRequestBody(body: Record<string, unknown>) {
  const { max_tokens: maxTokens, temperature: _t, ...rest } = body;
  return maxTokens === undefined
    ? rest
    : { ...rest, max_completion_tokens: maxTokens };
}
