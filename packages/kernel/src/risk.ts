import type { Mandate, RiskPacket, Simulation } from '@synq/schemas';
import { artifactHash, type CanonicalIntent } from './canonical.js';
import { requireRule } from './errors.js';

export function minimumOutput(quoted: bigint, slippageBps: number): bigint {
  const numerator = quoted * BigInt(10_000 - slippageBps);
  return (numerator + 9_999n) / 10_000n;
}

export class RiskGate {
  verify(input: {
    canonical: CanonicalIntent;
    mandate: Mandate;
    risk: RiskPacket;
    trusted: ReadonlySet<string>;
    now: number;
  }): void {
    const { canonical, mandate, risk, now } = input;
    const intent = canonical.intent;
    const riskHash = artifactHash(risk);
    requireRule(input.trusted.has(riskHash), 'EVIDENCE_MISMATCH');
    requireRule(
      risk.intentHash === canonical.economicHash &&
        riskHash === intent.riskPacketHash &&
        artifactHash(risk.evidence) === intent.evidenceHash,
      'EVIDENCE_MISMATCH',
    );
    requireRule(
      !risk.blocked &&
        risk.slippageBps <= mandate.maxSlippageBps &&
        risk.slippageBps <= intent.maxSlippageBps &&
        risk.referenceDeviationBps <= mandate.maxReferenceDeviationBps &&
        risk.maxReferenceDeviationBps === mandate.maxReferenceDeviationBps,
      'RISK_REJECTED',
    );
    requireRule(
      risk.quoteAt <= now &&
        now - risk.quoteAt <= mandate.quoteTtlSeconds &&
        risk.quoteExpiresAt > now,
      'STALE_QUOTE',
    );
    requireRule(
      risk.evaluatedAt <= now &&
        now - risk.evaluatedAt <= mandate.evidenceTtlSeconds &&
        risk.evidence.every(
          (e) =>
            !e.untrusted &&
            e.chainId === intent.chainId &&
            e.retrievedAt <= now &&
            now - e.retrievedAt <= mandate.evidenceTtlSeconds,
        ),
      'STALE_EVIDENCE',
    );
    if (intent.outputToken === undefined) return;
    requireRule(
      risk.quotedOutputAmount !== undefined &&
        risk.postTradeAllocationBps !== undefined,
      'QUOTE_REQUIRED',
    );
    const quoted = BigInt(risk.quotedOutputAmount);
    requireRule(quoted > 0n, 'RISK_REJECTED');
    const slippage = Math.min(intent.maxSlippageBps, mandate.maxSlippageBps);
    const floor = minimumOutput(quoted, slippage);
    requireRule(
      BigInt(intent.minOutputAmount) >= floor &&
        BigInt(intent.minOutputAmount) > 0n,
      'MIN_OUTPUT_TOO_LOW',
    );
    requireRule(
      risk.postTradeAllocationBps <= mandate.maxAllocationBps,
      'ALLOCATION_CAP',
    );
  }
}

export class SimulationGate {
  verify(input: {
    canonical: CanonicalIntent;
    mandate: Mandate;
    simulation: Simulation;
    trusted: ReadonlySet<string>;
    now: number;
  }): void {
    const { canonical, mandate, simulation, now } = input;
    const intent = canonical.intent;
    requireRule(
      input.trusted.has(artifactHash(simulation)),
      'EVIDENCE_MISMATCH',
    );
    requireRule(simulation.succeeded, 'SIMULATION_FAILED');
    requireRule(
      simulation.intentHash === canonical.intentHash &&
        simulation.calldataHash === intent.calldataHash &&
        simulation.chainId === intent.chainId &&
        simulation.account === intent.account &&
        simulation.target === intent.target,
      'SIMULATION_MISMATCH',
    );
    requireRule(
      simulation.simulatedAt <= now &&
        now - simulation.simulatedAt <= mandate.simulationTtlSeconds,
      'STALE_SIMULATION',
    );
  }
}
