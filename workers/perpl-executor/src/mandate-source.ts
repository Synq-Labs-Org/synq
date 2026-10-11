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
