import { ReasonerError, type ReasonerRequest } from './ports.js';

export type ChatPromptMessage =
  | { role: 'system'; content: string }
  | { role: 'user' | 'assistant'; content: { type: 'text'; text: string }[] };
export function toChatPrompt(
  messages: ReasonerRequest['messages'],
): ChatPromptMessage[] {
  return messages.map((m) =>
    m.role === 'system'
      ? { role: 'system', content: m.content }
      : { role: m.role, content: [{ type: 'text', text: m.content }] },
  );
}
export function httpStatusOf(error: unknown): number | null {
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const status = (error as { statusCode: unknown }).statusCode;
    return typeof status === 'number' ? status : null;
  }
  return null;
}
export function toReasonerError(error: unknown): ReasonerError {
  if (error instanceof ReasonerError) return error;
  if (error instanceof Error && error.name === 'AbortError')
    return new ReasonerError('ABORTED');
  const cause =
    error && typeof error === 'object' && 'cause' in error
      ? (error as { cause: unknown }).cause
      : null;
  if (cause instanceof ReasonerError) return cause;
  const status = httpStatusOf(error);
  return new ReasonerError(
    status === null ? 'RESPONSE_INVALID' : 'PROVIDER_HTTP_ERROR',
    status === null ? 'provider response invalid' : `HTTP ${status}`,
  );
}
