import type { Pool } from 'pg';
import { MandateSchema, type Mandate } from '@synq/schemas';
import {
  HedgeGrantError,
  HedgeMandateSchema,
  artifactHash,
  type HedgeMandate,
} from '@synq/kernel';
import type { HedgeMandateSource } from './service.js';

export interface GovernedParentMandateReader {
  current(groupId: string): Promise<Mandate>;
}

/** Parent artifacts must come from the Kernel's registry-verified mandate path. */
export class PostgresHedgeMandateSource implements HedgeMandateSource {
  constructor(
    private readonly deps: {
      pool: Pick<Pool, 'query'>;
      parents: GovernedParentMandateReader;
    },
  ) {}
  async migrate() {
    await this.deps.pool
      .query(`CREATE TABLE IF NOT EXISTS synq_hedge_mandate_artifacts (
      policy_hash text PRIMARY KEY, group_id text NOT NULL, parent_mandate_id text NOT NULL,
      parent_version integer NOT NULL, version integer NOT NULL, data jsonb NOT NULL)`);
  }
  private binding(parent: Mandate, hedge: HedgeMandate) {
    if (
      parent.groupId !== hedge.groupId ||
      parent.mandateId !== hedge.parentMandateId ||
      parent.version !== hedge.parentMandateVersion ||
      parent.network.chainId !== hedge.chainId ||
      parent.hedgePolicyHash !== artifactHash(hedge)
    )
      throw new HedgeGrantError(
        'GRANT_BINDING',
        'hedge terms lack current parent governance',
      );
  }
  async publish(raw: unknown): Promise<HedgeMandate> {
    const hedge = HedgeMandateSchema.parse(raw);
    const parent = MandateSchema.parse(
      await this.deps.parents.current(hedge.groupId),
    );
    this.binding(parent, hedge);
    if (parent.status !== 'ACTIVE')
      throw new HedgeGrantError('GRANT_BINDING', 'parent revoked');
    await this.deps.pool.query(
      `INSERT INTO synq_hedge_mandate_artifacts
      (policy_hash,group_id,parent_mandate_id,parent_version,version,data) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(policy_hash) DO NOTHING`,
      [
        artifactHash(hedge),
        hedge.groupId,
        hedge.parentMandateId,
        hedge.parentMandateVersion,
        hedge.version,
        JSON.stringify(hedge),
      ],
    );
    return hedge;
  }
  async current(groupId: string) {
    const mandate = MandateSchema.parse(
      await this.deps.parents.current(groupId),
    );
    if (mandate.groupId !== groupId || !mandate.hedgePolicyHash)
      throw new HedgeGrantError('GRANT_BINDING', 'no governed hedge policy');
    const result = await this.deps.pool.query(
      'SELECT data FROM synq_hedge_mandate_artifacts WHERE policy_hash=$1 AND group_id=$2',
      [mandate.hedgePolicyHash, groupId],
    );
    if (!result.rows[0])
      throw new HedgeGrantError(
        'GRANT_BINDING',
        'governed hedge artifact missing',
      );
    const hedgeMandate = HedgeMandateSchema.parse(result.rows[0].data);
    this.binding(mandate, hedgeMandate);
    return { mandate, hedgeMandate };
  }
}

import { parseAbi, type PublicClient } from 'viem';
import { onchainMandateId } from '@synq/kernel';

const governedRegistryAbi = parseAbi([
  'struct MandateState { uint8 status; uint256 currentVersion; uint256 minValidVersion; uint256 spentToken; uint256 spentNative; }',
  'struct MandateTerms { bytes32 mandateHash; address token; uint256 maxTokenPerAction; uint256 maxNativePerAction; uint256 cumulativeTokenCap; uint256 cumulativeNativeCap; uint256 validAfter; uint256 validUntil; }',
  'function mandateState(address account, bytes32 mandateId) view returns (MandateState)',
  'function mandateTerms(address account, bytes32 mandateId, uint256 version) view returns (MandateTerms)',
]);

/** Revalidates the full approved parent hash against one chain block at every hedge issuance. */
export class RegistryGovernedParentMandateReader implements GovernedParentMandateReader {
  constructor(
    private readonly options: {
      kernel: { listMandates(): Mandate[] };
      client: Pick<
        PublicClient,
        'getChainId' | 'getBlockNumber' | 'readContract'
      >;
      registry: `0x${string}`;
    },
  ) {}
  async current(groupId: string) {
    const candidates = this.options.kernel
      .listMandates()
      .filter((m) => m.groupId === groupId && m.hedgePolicyHash);
    if (candidates.length !== 1)
      throw new HedgeGrantError(
        'GRANT_BINDING',
        'ambiguous or missing governed parent',
      );
    const parent = MandateSchema.parse(candidates[0]);
    const client = this.options.client;
    if ((await client.getChainId()) !== parent.network.chainId)
      throw new HedgeGrantError('GRANT_BINDING', 'governance RPC chain');
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
    const mandateId = onchainMandateId(parent);
    const state = await client.readContract({
      address: this.options.registry,
      abi: governedRegistryAbi,
      functionName: 'mandateState',
      args: [parent.account, mandateId],
      blockNumber,
    });
    const terms = await client.readContract({
      address: this.options.registry,
      abi: governedRegistryAbi,
      functionName: 'mandateTerms',
      args: [parent.account, mandateId, BigInt(parent.version)],
      blockNumber,
    });
    const expectedStatus = parent.status === 'ACTIVE' ? 1 : 2;
    if (
      state.currentVersion !== BigInt(parent.version) ||
      state.status !== expectedStatus ||
      terms.mandateHash !==
        artifactHash(
          parent.status === 'REVOKED'
            ? { ...parent, status: 'ACTIVE' }
            : parent,
        )
    )
      throw new HedgeGrantError(
        'GRANT_BINDING',
        'parent not current on registry',
      );
    return parent;
  }
}

export async function productionHedgeMandateSource(
  options: ConstructorParameters<
    typeof RegistryGovernedParentMandateReader
  >[0] & { pool: Pick<Pool, 'query'> },
) {
  const source = new PostgresHedgeMandateSource({
    pool: options.pool,
    parents: new RegistryGovernedParentMandateReader(options),
  });
  await source.migrate();
  return source;
}
