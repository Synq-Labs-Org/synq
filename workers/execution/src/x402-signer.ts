import { randomBytes } from 'node:crypto';
import type { LocalAccount } from 'viem';
import type {
  EconomicExecution,
  EconomicGrant,
  EconomicGrantAuthority,
} from '@synq/kernel';

export type X402SignRequest = {
  grant: EconomicGrant;
  execution: EconomicExecution;
  requirement: {
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra: { name: string; version: string };
  };
  now: number;
};

/**
 * EIP-3009 transferWithAuthorization signer for x402. It signs only after the
 * Kernel grant is consumed for the exact resource, amount and payee, and only
 * on networks it was configured for.
 */
export class X402AuthorizationSigner {
  constructor(
    private readonly account: LocalAccount,
    private readonly authority: EconomicGrantAuthority,
    private readonly networks: ReadonlyMap<string, number>,
  ) {}

  get payer(): string {
    return this.account.address;
  }

  async sign(input: X402SignRequest) {
    const { requirement: r, execution: x, grant, now } = input;
    const chainId = this.networks.get(r.network);
    if (chainId === undefined) throw new Error('X402_NETWORK_NOT_ALLOWED');
    if (
      x.maxAmount.currency !== 'USDC' ||
      BigInt(r.amount) > BigInt(x.maxAmount.amount) ||
      x.recipientRef !== r.payTo.toLowerCase()
    )
      throw new Error('X402_REQUIREMENT_DIFFERS_FROM_EXECUTION');
    this.authority.consume(grant, x, now);
    const authorization = {
      from: this.account.address,
      to: r.payTo as `0x${string}`,
      value: BigInt(r.amount),
      validAfter: BigInt(Math.max(0, now - 30)),
      validBefore: BigInt(Math.min(grant.expiresAt, now + r.maxTimeoutSeconds)),
      nonce: `0x${randomBytes(32).toString('hex')}` as `0x${string}`,
    };
    const signature = await this.account.signTypedData({
      domain: {
        name: r.extra.name,
        version: r.extra.version,
        chainId,
        verifyingContract: r.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    });
    return {
      signature,
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: String(authorization.value),
        validAfter: String(authorization.validAfter),
        validBefore: String(authorization.validBefore),
        nonce: authorization.nonce,
      },
    };
  }
}
