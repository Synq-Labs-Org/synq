export type SpanRecord = {
  name: string;
  runId: string;
  agentId: string | null;
  role: string | null;
  startedAt: number;
  durationMs: number;
  status: 'OK' | 'ERROR';
  attributes: Record<string, string | number | boolean>;
};

const SENSITIVE_KEY =
  /(secret|password|api[_-]?key|authorization|signature|private|mnemonic|seed|bearer|credential)/i;
const SENSITIVE_VALUE =
  /^0x[0-9a-fA-F]{130}$|\bBearer\s+\S+|\bsk-[A-Za-z0-9]{8,}/;

export function redactAttributes(
  attributes: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SENSITIVE_KEY.test(key)) continue;
    if (typeof value === 'number' || typeof value === 'boolean')
      out[key] = value;
    else if (typeof value === 'string')
      out[key] = SENSITIVE_VALUE.test(value)
        ? '[REDACTED]'
        : value.slice(0, 200);
  }
  return out;
}

export class SpanRecorder {
  readonly spans: SpanRecord[] = [];
  constructor(
    readonly runId: string,
    private readonly clock: () => number = Date.now,
    private readonly sink?: (span: SpanRecord) => void,
  ) {}
  async span<T>(
    name: string,
    context: { agentId?: string | null; role?: string | null },
    attributes: Record<string, unknown>,
    fn: (set: (extra: Record<string, unknown>) => void) => Promise<T>,
  ): Promise<T> {
    const startedAt = this.clock();
    const extra: Record<string, unknown> = {};
    let status: SpanRecord['status'] = 'OK';
    try {
      return await fn((more) => Object.assign(extra, more));
    } catch (error) {
      status = 'ERROR';
      extra.error =
        error && typeof error === 'object' && 'kind' in error
          ? String((error as { kind: unknown }).kind)
          : error instanceof Error
            ? error.name
            : 'ERROR';
      throw error;
    } finally {
      const record: SpanRecord = {
        name,
        runId: this.runId,
        agentId: context.agentId ?? null,
        role: context.role ?? null,
        startedAt,
        durationMs: Math.max(0, this.clock() - startedAt),
        status,
        attributes: redactAttributes({ ...attributes, ...extra }),
      };
      this.spans.push(record);
      this.sink?.(record);
    }
  }
}
