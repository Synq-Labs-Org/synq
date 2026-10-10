import { parseAbi, type PublicClient } from 'viem';
import {
  RiskAttestationObservationSchema,
  STABLE_RISK_STATUSES,
  type RiskAttestationObservation,
  type RiskAttestationQuery,
  type RiskAttestationReader,
} from '@synq/kernel';

export const riskAttestationRegistryAbi = parseAbi([
  'struct Attestation { uint64 timestamp; uint64 stalenessSec; uint32 deviationBps; uint8 status; uint256 referencePrice; bytes32 sourceConfigHash; bytes32 workflowId; uint64 recordedAt; uint64 recordedBlock; }',
  'function latest(bytes32 assetId) view returns (Attestation)',
  'function forwarder() view returns (address)',
  'function onReport(bytes metadata, bytes report)',
  'event AttestationRecorded(bytes32 indexed assetId, uint8 indexed status, uint64 timestamp, uint256 referencePrice, uint32 deviationBps, uint64 stalenessSec, bytes32 sourceConfigHash, bytes32 workflowId)',
]);

type Reader = Pick<
  PublicClient,
  'getBlockNumber' | 'readContract' | 'getChainId'
>;

/**
 * Kernel RiskAttestationReader backed by RiskAttestationRegistry. Reads at `head - confirmationDepth + 1` so an
 * attestation is only trusted once it is confirmation-deep, and binds the chain id of the RPC to the query.
 */
export class RpcRiskAttestationReader implements RiskAttestationReader {
  constructor(
    private readonly client: Reader,
    private readonly options: { confirmationDepth: number },
  ) {
    if (
      !Number.isSafeInteger(options.confirmationDepth) ||
      options.confirmationDepth < 1
    )
      throw new Error('INVALID_CONFIRMATION_DEPTH');
  }

  async latest(
    query: RiskAttestationQuery,
  ): Promise<RiskAttestationObservation | null> {
    const chainId = await this.client.getChainId();
    if (chainId !== query.chainId) throw new Error('RPC_CHAIN_MISMATCH');
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    const depth = BigInt(this.options.confirmationDepth - 1);
    if (head < depth) return null;
    const blockNumber = head - depth;
    const a = await this.client.readContract({
      address: query.registry,
      abi: riskAttestationRegistryAbi,
      functionName: 'latest',
      args: [query.assetId],
      blockNumber,
    });
    if (a.timestamp === 0n) return null;
    const status = STABLE_RISK_STATUSES[a.status];
    if (status === undefined) throw new Error('INVALID_STATUS');
    return RiskAttestationObservationSchema.parse({
      chainId,
      registry: query.registry,
      assetId: query.assetId,
      status,
      timestamp: Number(a.timestamp),
      referencePrice: a.referencePrice.toString(),
      deviationBps: a.deviationBps,
      stalenessSec: Number(a.stalenessSec),
      sourceConfigHash: a.sourceConfigHash,
      blockNumber: blockNumber.toString(),
    });
  }
}
