import { Agent } from '@mastra/core/agent';
import type { ModelRole } from '@synq/schemas';
import type {
  ReasonerMessage,
  ReasonerRequest,
  ReasonerResult,
} from './ports.js';
import { AgentRuntimeError, type AgentHandle } from './subagents.js';

process.env.MASTRA_TELEMETRY_DISABLED ??= '1';

type PromptPart = { type: string; text?: string };
type PromptMessage = { role: string; content: string | PromptPart[] };
type BridgeCallOptions = { prompt: PromptMessage[]; abortSignal?: AbortSignal };
type Usage = { inputTokens: number; outputTokens: number; totalTokens: number };

function toMessages(prompt: readonly PromptMessage[]): ReasonerMessage[] {
  return prompt.flatMap((m): ReasonerMessage[] => {
    const text =
      typeof m.content === 'string'
        ? m.content
        : m.content
            .filter((p) => p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text!)
            .join('\n');
    if (m.role === 'system' || m.role === 'user' || m.role === 'assistant')
      return [{ role: m.role, content: text }];
    return [];
  });
}

export function portLanguageModel(
  modelId: string,
  invoke: (
    messages: ReasonerMessage[],
    signal: AbortSignal | undefined,
  ) => Promise<ReasonerResult>,
) {
  const run = async (options: BridgeCallOptions) => {
    const result = await invoke(
      toMessages(options.prompt),
      options.abortSignal,
    );
    const usage: Usage = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.inputTokens + result.outputTokens,
    };
    return { result, usage };
  };
  return {
    specificationVersion: 'v2' as const,
    provider: 'synq-reasoner-port',
    modelId,
    supportedUrls: {},
    async doGenerate(options: BridgeCallOptions) {
      const { result, usage } = await run(options);
      return {
        content: [{ type: 'text' as const, text: result.text }],
        finishReason: 'stop' as const,
        usage,
        warnings: [],
      };
    },
    async doStream(options: BridgeCallOptions) {
      const { result, usage } = await run(options);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't0' });
          controller.enqueue({
            type: 'text-delta',
            id: 't0',
            delta: result.text,
          });
          controller.enqueue({ type: 'text-end', id: 't0' });
          controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
          controller.close();
        },
      });
      return { stream };
    },
  };
}

export type RoleRun = {
  result: ReasonerResult;
  mastraText: string;
};

export class MastraRoleHarness {
  readonly agents = new Map<string, Agent>();

  async run(input: {
    handle: AgentHandle;
    instructions: string;
    userMessage: string;
    toolAllowlist: readonly string[];
    call: (
      request: Pick<ReasonerRequest, 'messages' | 'signal'>,
    ) => Promise<ReasonerResult>;
  }): Promise<RoleRun> {
    let captured: ReasonerResult | null = null;
    const model = portLanguageModel(
      `${input.handle.role.toLowerCase()}-port`,
      async (messages, signal) => {
        const result = await input.call({
          messages,
          signal: signal ?? input.handle.signal,
        });
        captured = result;
        return result;
      },
    );
    const agent = new Agent({
      id: input.handle.agentId,
      name: `synq-${input.handle.role.toLowerCase()}`,
      instructions: input.instructions,
      model,
      tools: {},
    });
    this.agents.set(input.handle.agentId, agent);
    const output = await agent.generate(input.userMessage, {
      abortSignal: input.handle.signal,
      maxSteps: 1,
    });
    const result = captured as ReasonerResult | null;
    if (!result)
      throw new AgentRuntimeError(
        'PROVIDER_UNAVAILABLE',
        `${input.handle.role} produced no model call`,
      );
    const forbidden = result.toolCalls.filter(
      (t) => !input.toolAllowlist.includes(t.name),
    );
    if (forbidden.length)
      throw new AgentRuntimeError(
        'FORBIDDEN_TOOL_CALL',
        `${input.handle.role} attempted ${forbidden.map((t) => t.name).join(', ')}`,
      );
    return { result, mastraText: output.text };
  }

  roles(): ModelRole[] {
    return [...this.agents.keys()].map(
      (id) => id.split('.').at(-2)!.toUpperCase() as ModelRole,
    );
  }
}
