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
  type TransportMode,
  type ChatPromptMessage,
  httpStatusOf,
  toChatPrompt,
  toReasonerError,
} from '@synq/agent-runtime';
import { canonicalArtifactHash } from '@synq/schemas';

export const QWEN_DEFAULT_BASE_URL =
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export const QWEN_MODEL = 'qwen3.8-max';

export type QwenOptions = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  mode: TransportMode;
  fixtures?: FixtureFile;
  recordTo?: string;
  liveFetch?: typeof globalThis.fetch;
};

export function qwenOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  replay: { fixtures?: FixtureFile; recordTo?: string } = {},
): QwenOptions {
  const apiKey = (env.QWEN_API_KEY ?? env.DASHSCOPE_API_KEY ?? '').trim();
  const baseURL = env.QWEN_BASE_URL?.trim() || QWEN_DEFAULT_BASE_URL;
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

export class QwenStructuredReasoner implements StructuredReasoner {
  readonly provider = 'qwen' as const;
  readonly model: string;
  readonly transport: RecordReplayTransport;
  private readonly schemaModel;
  private readonly objectModel;
  private readonly hasKey: boolean;

  constructor(options: QwenOptions) {
    this.model = options.model ?? QWEN_MODEL;
    this.hasKey = Boolean(options.apiKey);
    if (options.mode !== 'REPLAY' && !this.hasKey)
      throw new ReasonerError(
        'PROVIDER_UNAVAILABLE',
        'Qwen live mode needs QWEN_API_KEY or DASHSCOPE_API_KEY',
      );
    this.transport = new RecordReplayTransport(options.mode, {
      provider: 'qwen',
      ...(options.fixtures ? { fixtures: options.fixtures } : {}),
      ...(options.recordTo ? { recordTo: options.recordTo } : {}),
      ...(options.liveFetch ? { liveFetch: options.liveFetch } : {}),
    });
    const base = {
      name: 'qwen',
      baseURL: options.baseURL ?? QWEN_DEFAULT_BASE_URL,
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
      providerId: 'QWEN',
      installed: true,
      credentialsPresent: this.hasKey,
      mode: this.transport.mode,
    };
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
      provider: 'qwen',
      model: this.model,
      mode: this.transport.mode === 'REPLAY' ? 'REPLAY' : 'LIVE',
      fixtureLabel: this.transport.label,
      requestHash: canonicalArtifactHash(exchange?.requestBody ?? null),
      responseHash: canonicalArtifactHash(exchange?.responseBody ?? null),
      structuredMode,
    };
  }
}
