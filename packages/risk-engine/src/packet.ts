import { RiskPacketSchema, type ChainId, type RiskPacket } from '@synq/schemas';
import { artifactHash } from '@synq/kernel';
import { abs, floorDiv } from './math.js';
import { portfolioRiskHash, type PortfolioRisk } from './portfolio.js';

export function referenceDeviationBps(mark: bigint, oracle: bigint): number {
  if (oracle <= 0n) return 10_000;
  const d = floorDiv(abs(mark - oracle) * 10_000n, oracle);
  return d > 10_000n ? 10_000 : Number(d);
}

// Projects a portfolio risk evaluation onto the Kernel RiskPacket wire shape,
// with the full evaluation bound by hash as evidence.
export function toKernelRiskPacket(input: {
  risk: PortfolioRisk;
  intentHash: `0x${string}`;
  chainId: ChainId;
  quoteTtlSeconds: number;
  slippageBps: number;
  referenceDeviationBps: number;
  maxReferenceDeviationBps: number;
}): RiskPacket {
  const { risk } = input;
  const at = Math.floor(risk.asOf / 1000);
  const quoteAt = Math.floor(
    Math.min(...risk.assets.map((a) => a.priceAt), risk.asOf) / 1000,
  );
  return RiskPacketSchema.parse({
    schemaVersion: 1,
    intentHash: input.intentHash,
    evaluatedAt: at,
    quoteAt,
    quoteExpiresAt: quoteAt + input.quoteTtlSeconds,
    slippageBps: input.slippageBps,
    referenceDeviationBps: input.referenceDeviationBps,
    maxReferenceDeviationBps: input.maxReferenceDeviationBps,
    blocked:
      risk.blocked ||
      input.referenceDeviationBps > input.maxReferenceDeviationBps,
    evidence: [
      {
        source: 'synq-risk-engine:portfolio',
        retrievedAt: at,
        chainId: input.chainId,
        artifactHash: portfolioRiskHash(risk),
        untrusted: false,
      },
      ...risk.assets.map((a) => ({
        source: `price:${a.priceSource}`.slice(0, 128),
        retrievedAt: Math.floor(a.priceAt / 1000),
        chainId: input.chainId,
        artifactHash: artifactHash({
          asset: a.asset,
          price: a.price,
          decimals: a.priceDecimals,
          at: a.priceAt,
        }),
        untrusted: false,
      })),
    ],
  });
}
