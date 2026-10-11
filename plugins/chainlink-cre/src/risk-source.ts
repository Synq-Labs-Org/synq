import {
  RiskAttestationGate,
  artifactHash,
  type RiskAttestationGateConfig,
} from '@synq/kernel';
import { ChainIdSchema } from '@synq/domain';

/** Shared read-only view; the same deterministic trust rules guard DCA and WorldSnapshot. */
export class RegistryRiskSource {
  private readonly gate: RiskAttestationGate;
  constructor(
    config: RiskAttestationGateConfig,
    private readonly now: () => number | Promise<number>,
    private readonly inputToken: `0x${string}`,
  ) {
    this.gate = new RiskAttestationGate(config);
    this.chainId = ChainIdSchema.parse(config.chainId);
    this.maxAgeSeconds = config.maxAttestationAgeSeconds;
  }
  private readonly chainId: ReturnType<typeof ChainIdSchema.parse>;
  private readonly maxAgeSeconds: number;
  async current(_groupId: string) {
    const now = await this.now();
    try {
      const result = await this.gate.assess(
        {
          action: 'SPOT_TRADE',
          chainId: this.chainId,
          inputToken: this.inputToken,
        },
        now,
      );
      if (!result.applies || result.observation.timestamp > now)
        throw new Error('RISK_NOT_APPLICABLE_OR_FUTURE');
      return {
        state: {
          status: result.observation.status,
          reasons: [result.effect],
          attestationRef: artifactHash(result.observation),
          referenceDeviationBps: result.observation.deviationBps,
        },
        observedAt: result.observation.timestamp,
        maxAgeSeconds: this.maxAgeSeconds,
      };
    } catch {
      return {
        state: {
          status: 'UNKNOWN' as const,
          reasons: ['REGISTRY_RISK_UNAVAILABLE'],
          attestationRef: null,
          referenceDeviationBps: null,
        },
        observedAt: now,
        maxAgeSeconds: this.maxAgeSeconds,
      };
    }
  }
}
