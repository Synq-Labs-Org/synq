import {
  ProviderCapabilitySchema,
  type CapabilityVerb,
  type Domain,
  type ProviderCapability,
  type ProviderEnvironment,
  type ProviderStatus,
} from './schemas.js';

export type ProviderHealthReport = {
  providerId: string;
  displayName: string;
  status: ProviderStatus;
  environment: ProviderEnvironment;
  verbs: CapabilityVerb[];
  authState: 'READY' | 'MISSING_CREDENTIALS' | 'EXPIRED' | 'BLOCKED';
  circuit: 'CLOSED' | 'OPEN';
  latencyMs: number | null;
  lastSuccessfulAt: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
};

type Mutable = {
  capability: ProviderCapability;
  latencyMs: number | null;
  lastSuccessfulAt: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  openUntil: number | null;
};

const AUTH: Record<ProviderStatus, ProviderHealthReport['authState']> = {
  READY: 'READY',
  DEGRADED: 'READY',
  DOWN: 'READY',
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  PARTNER_GATED: 'BLOCKED',
  BLOCKED: 'BLOCKED',
};

export function credentialStatus(
  capability: ProviderCapability,
  env: Readonly<Record<string, string | undefined>>,
): ProviderCapability {
  if (capability.status !== 'READY' || capability.credentialEnv.length === 0)
    return capability;
  const missing = capability.credentialEnv.filter(
    (k) => !(env[k] ?? '').trim(),
  );
  return missing.length
    ? {
        ...capability,
        status: 'MISSING_CREDENTIALS',
        statusReason: `missing ${missing.join(', ')}`,
      }
    : capability;
}

/**
 * Runtime capability graph (Bible §91). The planner may only use providers
 * that are READY or DEGRADED with a closed circuit; partner-gated providers stay
 * visible as unavailable instead of being omitted.
 */
export class ProviderCapabilityGraph {
  private readonly nodes = new Map<string, Mutable>();
  constructor(
    capabilities: readonly ProviderCapability[],
    private readonly options: {
      failureThreshold?: number;
      cooldownSeconds?: number;
    } = {},
  ) {
    for (const raw of capabilities) {
      const capability = ProviderCapabilitySchema.parse(raw);
      if (this.nodes.has(capability.providerId))
        throw new Error(`DUPLICATE_PROVIDER: ${capability.providerId}`);
      this.nodes.set(capability.providerId, {
        capability,
        latencyMs: null,
        lastSuccessfulAt: null,
        lastCheckedAt: null,
        lastError: null,
        consecutiveFailures: 0,
        openUntil: null,
      });
    }
  }

  capability(providerId: string): ProviderCapability | null {
    return this.nodes.get(providerId)?.capability ?? null;
  }

  private node(providerId: string): Mutable {
    const n = this.nodes.get(providerId);
    if (!n) throw new Error(`UNKNOWN_PROVIDER: ${providerId}`);
    return n;
  }

  usable(providerId: string, verb: CapabilityVerb, now: number): boolean {
    const n = this.nodes.get(providerId);
    if (!n) return false;
    const { status, verbs } = n.capability;
    if (status !== 'READY' && status !== 'DEGRADED') return false;
    if (!verbs.includes(verb)) return false;
    return n.openUntil === null || n.openUntil <= now;
  }

  providersFor(domain: Domain, verb: CapabilityVerb): ProviderCapability[] {
    return [...this.nodes.values()]
      .map((n) => n.capability)
      .filter((c) => c.domains.includes(domain) && c.verbs.includes(verb))
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }

  recordSuccess(providerId: string, latencyMs: number, now: number): void {
    const n = this.node(providerId);
    n.latencyMs = latencyMs;
    n.lastSuccessfulAt = now;
    n.lastCheckedAt = now;
    n.lastError = null;
    n.consecutiveFailures = 0;
    n.openUntil = null;
  }

  recordFailure(providerId: string, error: string, now: number): void {
    const n = this.node(providerId);
    n.lastCheckedAt = now;
    n.lastError = error.slice(0, 200);
    n.consecutiveFailures += 1;
    if (n.consecutiveFailures >= (this.options.failureThreshold ?? 3))
      n.openUntil = now + (this.options.cooldownSeconds ?? 60);
  }

  health(now: number): ProviderHealthReport[] {
    return [...this.nodes.values()]
      .map((n) => {
        const open = n.openUntil !== null && n.openUntil > now;
        const status: ProviderStatus =
          n.capability.status === 'READY' && open
            ? 'DOWN'
            : n.capability.status === 'READY' && n.consecutiveFailures > 0
              ? 'DEGRADED'
              : n.capability.status;
        return {
          providerId: n.capability.providerId,
          displayName: n.capability.displayName,
          status,
          environment: n.capability.environment,
          verbs: [...n.capability.verbs],
          authState: AUTH[n.capability.status],
          circuit: open ? ('OPEN' as const) : ('CLOSED' as const),
          latencyMs: n.latencyMs,
          lastSuccessfulAt: n.lastSuccessfulAt,
          lastCheckedAt: n.lastCheckedAt,
          lastError: n.lastError,
          consecutiveFailures: n.consecutiveFailures,
        };
      })
      .sort((a, b) => a.providerId.localeCompare(b.providerId));
  }
}
