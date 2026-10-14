import { verifyTypedData, type Address, type Hex } from 'viem';

/**
 * What a person signs with their passkey to join a forming group fund: the
 * fund, their principal and the display name the group will see. The server
 * accepts it only for the principal's enrolled signer and within a short window.
 */
export type FundJoin = {
  fundId: string;
  principalId: string;
  name: string;
  issuedAt: number;
};

export const FUND_JOIN_DOMAIN_NAME = 'Synq Fund';

export function fundJoinTypedData(join: FundJoin) {
  return {
    domain: { name: FUND_JOIN_DOMAIN_NAME, version: '1' },
    types: {
      FundJoin: [
        { name: 'fundId', type: 'string' },
        { name: 'principalId', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'issuedAt', type: 'uint256' },
      ],
    },
    primaryType: 'FundJoin' as const,
    message: {
      fundId: join.fundId,
      principalId: join.principalId,
      name: join.name,
      issuedAt: BigInt(join.issuedAt),
    },
  };
}

export async function verifyFundJoin(
  join: FundJoin,
  signer: Address,
  signature: Hex,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: signer,
      signature,
      ...fundJoinTypedData(join),
    });
  } catch {
    return false;
  }
}
