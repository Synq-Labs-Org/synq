import type {
  ExecutionMode,
  BrainActionProposal,
  BrainMandateProposal,
  FixtureLabel,
  ModelRole,
  ProposalDecision,
  UntrustedEvidence,
} from '@synq/schemas';

export type ReasonerMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};
export type JsonSchemaObject = { [key: string]: unknown };
export type ReasonerRequest = {
  role: ModelRole;
  agentId: string;
  fixtureKey: string;
  messages: ReasonerMessage[];
  responseSchema?: { name: string; schema: JsonSchemaObject };
  maxOutputTokens: number;
  signal?: AbortSignal;
};
export type ReasonerToolCall = { name: string; arguments: string };
export type ReasonerResult = {
  text: string;
  toolCalls: ReasonerToolCall[];
  inputTokens: number;
  outputTokens: number;
  provider: 'qwen' | 'kimi' | 'openai';
  model: string;
  mode: 'LIVE' | 'REPLAY';
  fixtureLabel: FixtureLabel | null;
  requestHash: `0x${string}`;
  responseHash: `0x${string}`;
  structuredMode: 'JSON_SCHEMA' | 'JSON_OBJECT' | 'TEXT';
};
export type ProviderAvailability = {
  providerId: 'QWEN' | 'KIMI' | 'OPENAI';
  installed: true;
  credentialsPresent: boolean;
  mode: 'LIVE' | 'REPLAY' | 'RECORD';
};
export interface ReasonerBase {
  readonly provider: 'qwen' | 'kimi' | 'openai';
  readonly model: string;
  availability(): ProviderAvailability;
}
export interface StructuredReasoner extends ReasonerBase {
  complete(request: ReasonerRequest): Promise<ReasonerResult>;
}
export interface PaidToolBudget {
  tryCharge(microUsd: number, label: string): boolean;
  chargeToolCall(label: string): boolean;
}
export type ResearchRequest = ReasonerRequest & {
  queries: string[];
  maxResultsPerQuery: number;
  maxFetches: number;
  budget: PaidToolBudget;
};
export type ResearchResult = ReasonerResult & {
  evidence: UntrustedEvidence[];
  paidToolCalls: number;
  paidToolMicroUsd: number;
  externalCalls: number;
  deniedByBudget: string[];
};
export interface ResearchReasoner extends ReasonerBase {
  research(request: ResearchRequest): Promise<ResearchResult>;
}
export interface CriticReasoner extends ReasonerBase {
  critique(request: ReasonerRequest): Promise<ReasonerResult>;
}

export interface ProposalPort {
  readonly executionMode: ExecutionMode;
  proposeAction(proposal: BrainActionProposal): Promise<ProposalDecision>;
  proposeMandate(proposal: BrainMandateProposal): Promise<ProposalDecision>;
}

export class ReasonerError extends Error {
  constructor(
    readonly code:
      | 'PROVIDER_UNAVAILABLE'
      | 'PROVIDER_HTTP_ERROR'
      | 'REPLAY_MISS'
      | 'RESPONSE_INVALID'
      | 'ABORTED',
    message: string = code,
  ) {
    super(message);
    this.name = 'ReasonerError';
  }
}
