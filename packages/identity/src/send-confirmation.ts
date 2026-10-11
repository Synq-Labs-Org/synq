import { verifyTypedData, type Address, type Hex } from 'viem';

/** What a Synq Send sender confirms with their passkey: the exact previewed transfer. */
export type SendConfirmation = {
  previewId: Hex;
  digest: Hex;
  groupId: string;
  memberId: string;
  recipient: Address;
  token: Address;
  amount: bigint;
  chainId: number;
  expiresAt: number;
};

export const SEND_CONFIRMATION_DOMAIN_NAME = 'Synq Send';

export function sendConfirmationTypedData(c: SendConfirmation) {
  return {
    domain: {
      name: SEND_CONFIRMATION_DOMAIN_NAME,
      version: '1',
      chainId: c.chainId,
    },
    types: {
      SendConfirmation: [
        { name: 'previewId', type: 'bytes32' },
        { name: 'digest', type: 'bytes32' },
        { name: 'groupId', type: 'string' },
        { name: 'memberId', type: 'string' },
        { name: 'recipient', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'chainId', type: 'uint256' },
        { name: 'expiresAt', type: 'uint256' },
      ],
    },
    primaryType: 'SendConfirmation' as const,
    message: {
      previewId: c.previewId,
      digest: c.digest,
      groupId: c.groupId,
      memberId: c.memberId,
      recipient: c.recipient,
      token: c.token,
      amount: c.amount,
      chainId: BigInt(c.chainId),
      expiresAt: BigInt(c.expiresAt),
    },
  };
}

export function verifySendConfirmation(
  signer: Address,
  confirmation: SendConfirmation,
  signature: Hex,
): Promise<boolean> {
  return verifyTypedData({
    address: signer,
    ...sendConfirmationTypedData(confirmation),
    signature,
  });
}
