import { randomBytes } from 'node:crypto';
import type { LocalAccount } from 'viem';
import { isMutationEnabledChain } from '@synq/chain-registry';
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
    private readonly assets: readonly {
      chainId: number;
      address: string;
      decimals: number;
    }[],
    private readonly options: { allowMainnetBroadcast: boolean } = {
      allowMainnetBroadcast: false,
    },
  ) {}

  get payer(): string {
    return this.account.address;
  }

  async sign(input: X402SignRequest) {
    const { requirement: r, execution: x, grant, now } = input;
    const chainId = this.networks.get(r.network);
    if (chainId === undefined) throw new Error('X402_NETWORK_NOT_ALLOWED');
    if (!isMutationEnabledChain(chainId) && !this.options.allowMainnetBroadcast)
      throw new Error('MAINNET_BROADCAST_DISABLED');
    const asset = this.assets.find(
      (a) =>
        a.chainId === chainId &&
        a.address.toLowerCase() === r.asset.toLowerCase(),
    );
    if (!asset) throw new Error('X402_ASSET_NOT_ALLOWED');
    const pay = x.payAsset;
    if (
      !pay ||
      pay.chainId !== chainId ||
      pay.address !== r.asset.toLowerCase() ||
      pay.decimals !== asset.decimals ||
      x.maxAmount.decimals !== asset.decimals
    )
      throw new Error('X402_ASSET_BINDING_MISMATCH');
    if (
      x.maxAmount.currency !== 'USDC' ||
      BigInt(r.amount) > BigInt(x.maxAmount.amount) ||
      x.recipientRef !== r.payTo.toLowerCase()
    )
      throw new Error('X402_REQUIREMENT_DIFFERS_FROM_EXECUTION');
    await this.authority.consume(grant, x, now);
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
