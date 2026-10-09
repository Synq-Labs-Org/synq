import { z } from 'zod';
import { AddressSchema, HashSchema, type ExecutionGrant } from '@synq/domain';
import type { NonceStatus } from './ledger.js';

export const NonceStatusSchema = z.strictObject({
  chainId: z.number().int().positive(),
  module: AddressSchema,
  account: AddressSchema,
  nonce: z.string().regex(/^(0|[1-9][0-9]*)$/),
  intentHash: HashSchema,
  nonceUsed: z.boolean(),
  intentUsed: z.boolean(),
  blockNumber: z.number().int().nonnegative(),
  blockTimestamp: z.number().int().nonnegative(),
});
export type NonceStatusQuery = {
  chainId: number;
  module: `0x${string}`;
  account: `0x${string}`;
  nonce: string;
  intentHash: `0x${string}`;
};
export type NonceStatusReply = NonceStatus & NonceStatusQuery;
export interface NonceStatusReader {
  status(query: NonceStatusQuery): Promise<NonceStatusReply>;
}

export async function readNonceStatus(
  reader: NonceStatusReader | undefined,
  grant: ExecutionGrant,
): Promise<NonceStatus | null> {
  if (!reader) return null;
  const query: NonceStatusQuery = {
    chainId: grant.chainId,
    module: grant.draft.domain.verifyingContract,
    account: grant.account,
    nonce: grant.nonce,
    intentHash: grant.intentHash,
  };
  try {
    const reply = NonceStatusSchema.parse(await reader.status({ ...query }));
    const echoed =
      reply.chainId === query.chainId &&
      reply.module.toLowerCase() === query.module.toLowerCase() &&
      reply.account.toLowerCase() === query.account.toLowerCase() &&
      reply.nonce === query.nonce &&
      reply.intentHash.toLowerCase() === query.intentHash.toLowerCase();
    if (!echoed) return null;
    return {
      nonceUsed: reply.nonceUsed,
      intentUsed: reply.intentUsed,
      blockNumber: reply.blockNumber,
      blockTimestamp: reply.blockTimestamp,
    };
  } catch {
    return null;
  }
}
