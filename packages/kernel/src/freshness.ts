import { z } from 'zod';
import {
  AddressSchema,
  AmountSchema,
  AssetIdentitySchema,
  HashSchema,
  type AssetIdentity,
  type TreasuryBalance,
} from '@synq/schemas';
import type { Hash } from './canonical.js';
import { KernelError, parseAs, requireRule } from './errors.js';

const BlockSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const FreshnessObservationSchema = z.strictObject({
  chainId: z.number().int().positive(),
  indexedThroughBlock: BlockSchema,
  headBlock: BlockSchema,
  accountPaused: z.boolean(),
});
export type FreshnessObservation = z.output<typeof FreshnessObservationSchema>;
export const DirectVerificationSchema = z.strictObject({
  chainId: z.number().int().positive(),
  account: AddressSchema,
  blockNumber: BlockSchema,
  paused: z.boolean(),
  mandate: z.strictObject({
    mandateId: HashSchema,
    active: z.boolean(),
    version: z.number().int().nonnegative(),
  }),
  balances: z.array(
    z.strictObject({
      account: AddressSchema,
      asset: AssetIdentitySchema,
      balance: AmountSchema,
    }),
  ),
});
export type DirectVerification = z.output<typeof DirectVerificationSchema>;
export type FreshnessQuery = {
  chainId: number;
  account: `0x${string}`;
  mandateId: Hash;
  mandateVersion: number;
  assets: readonly AssetIdentity[];
};
export interface FreshnessProbe {
  observe(query: FreshnessQuery): Promise<FreshnessObservation>;
}
export interface DirectVerifier {
  verify(query: FreshnessQuery): Promise<DirectVerification>;
}
export type FreshnessConfig = {
  probe: FreshnessProbe;
  verifier?: DirectVerifier;
  maxLagBlocks: number;
};
export type FreshnessOutcome = {
  mode: 'INDEXED' | 'DIRECT';
  lagBlocks: number;
  headBlock: number;
  indexedThroughBlock: number;
  verifiedBalances: TreasuryBalance[] | null;
};

export class FreshnessGate {
  constructor(private readonly config: FreshnessConfig) {
    requireRule(
      Number.isSafeInteger(config.maxLagBlocks) && config.maxLagBlocks >= 0,
      'INVALID_REQUEST',
    );
  }
  async check(query: FreshnessQuery): Promise<FreshnessOutcome> {
    let observation: FreshnessObservation;
    try {
      observation = parseAs(
        FreshnessObservationSchema,
        await this.config.probe.observe(query),
        'STALE_READ_MODEL',
      );
    } catch {
      throw new KernelError('STALE_READ_MODEL');
    }
    requireRule(
      observation.chainId === query.chainId &&
        observation.headBlock >= observation.indexedThroughBlock,
      'STALE_READ_MODEL',
    );
    const lagBlocks = observation.headBlock - observation.indexedThroughBlock;
    const base = {
      lagBlocks,
      headBlock: observation.headBlock,
      indexedThroughBlock: observation.indexedThroughBlock,
    };
    if (lagBlocks <= this.config.maxLagBlocks) {
      requireRule(!observation.accountPaused, 'ACCOUNT_PAUSED');
      return { mode: 'INDEXED', ...base, verifiedBalances: null };
    }
    requireRule(this.config.verifier !== undefined, 'STALE_READ_MODEL');
    let direct: DirectVerification;
    try {
      direct = parseAs(
        DirectVerificationSchema,
        await this.config.verifier.verify(query),
        'DIRECT_VERIFICATION_FAILED',
      );
    } catch {
      throw new KernelError('DIRECT_VERIFICATION_FAILED');
    }
    requireRule(
      direct.chainId === query.chainId &&
        direct.account === query.account.toLowerCase() &&
        direct.blockNumber >= observation.headBlock &&
        direct.mandate.mandateId === query.mandateId.toLowerCase() &&
        query.assets.every((asset) =>
          direct.balances.some(
            (b) =>
              b.account === direct.account &&
              b.asset.canonicalAssetId === asset.canonicalAssetId,
          ),
        ),
      'DIRECT_VERIFICATION_FAILED',
    );
    requireRule(!direct.paused, 'ACCOUNT_PAUSED');
    requireRule(direct.mandate.active, 'MANDATE_REVOKED');
    requireRule(
      direct.mandate.version === query.mandateVersion,
      'MANDATE_VERSION',
    );
    return { mode: 'DIRECT', ...base, verifiedBalances: direct.balances };
  }
}
