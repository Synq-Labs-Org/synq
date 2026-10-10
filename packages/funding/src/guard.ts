import {
  BaseError,
  encodeFunctionData,
  type Address,
  type PublicClient,
} from 'viem';
import { isLocalChain } from '@synq/chain-registry';
import type { Asset } from '@synq/domain';
import { ausdAbi, requireOfficialAusd } from './ausd.js';
import { FundingError } from './errors.js';

export const AUSD_GUARD_REASONS = [
  'NOT_OFFICIAL_AUSD',
  'TRANSFER_PAUSED',
  'SOURCE_FROZEN',
  'RECIPIENT_FROZEN',
  'CONTROL_READ_FAILED',
  'TRANSFER_SIMULATION_REVERTED',
  'TRANSFER_SIMULATION_UNSUCCESSFUL',
] as const;
export type AusdGuardReason = (typeof AUSD_GUARD_REASONS)[number];

export type AusdGuardCheck = {
  name: string;
  value: boolean | null;
  error: string | null;
};
export type AusdGuardResult = {
  status: 'PASS' | 'BLOCKED';
  chainId: number;
  token: Address;
  account: Address;
  recipient: Address;
  amount: string;
  blockNumber: string | null;
  checks: AusdGuardCheck[];
  reasons: AusdGuardReason[];
};

export type AusdGuardClient = Pick<
  PublicClient,
  'getChainId' | 'readContract' | 'getBlockNumber' | 'call'
>;

const short = (e: unknown) =>
  (e instanceof BaseError ? e.shortMessage : String(e)).slice(0, 200);

/**
 * Pre-authorization AUSD control check (Bible §99 AUSDRiskGuard subset):
 * issuer pause, source/recipient freeze and a pinned-block transfer
 * simulation from the paying account. Any unreadable control fails closed.
 */
export class AusdGuard {
  constructor(
    readonly client: AusdGuardClient,
    readonly options: { localToken?: Asset } = {},
  ) {}

  private token(asset: Asset): Address {
    const local = this.options.localToken;
    if (local) {
      if (!isLocalChain(local.chainId) || asset.address !== local.address)
        throw new FundingError(
          'NOT_AUSD',
          'local guard tokens are accepted only on local/anvil',
        );
      return local.address;
    }
    return requireOfficialAusd(asset, asset.chainId).address;
  }

  async check(input: {
    asset: Asset;
    account: Address;
    recipient: Address;
    amount: bigint;
  }): Promise<AusdGuardResult> {
    const base = {
      chainId: input.asset.chainId,
      token: input.asset.address,
      account: input.account,
      recipient: input.recipient,
      amount: String(input.amount),
    };
    let token: Address;
    try {
      token = this.token(input.asset);
    } catch (error) {
      return {
        ...base,
        status: 'BLOCKED',
        blockNumber: null,
        checks: [
          { name: 'registryIdentity', value: false, error: short(error) },
        ],
        reasons: ['NOT_OFFICIAL_AUSD'],
      };
    }
    const chainId = await this.client.getChainId();
    if (chainId !== input.asset.chainId)
      return {
        ...base,
        status: 'BLOCKED',
        blockNumber: null,
        checks: [{ name: 'rpcChainId', value: false, error: String(chainId) }],
        reasons: ['NOT_OFFICIAL_AUSD'],
      };
    const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
    const checks: AusdGuardCheck[] = [];
    const reasons = new Set<AusdGuardReason>();
    const read = async (
      name: string,
      functionName: 'isTransferPaused' | 'isAccountFrozen',
      args: readonly Address[],
      reason: AusdGuardReason,
    ) => {
      try {
        const value = (await this.client.readContract({
          address: token,
          abi: ausdAbi,
          functionName,
          args,
          blockNumber,
        } as Parameters<AusdGuardClient['readContract']>[0])) as boolean;
        checks.push({ name, value, error: null });
        if (value) reasons.add(reason);
      } catch (error) {
        checks.push({ name, value: null, error: short(error) });
        reasons.add('CONTROL_READ_FAILED');
      }
    };
    await read('isTransferPaused', 'isTransferPaused', [], 'TRANSFER_PAUSED');
    await read(
      'isAccountFrozen(account)',
      'isAccountFrozen',
      [input.account],
      'SOURCE_FROZEN',
    );
    await read(
      'isAccountFrozen(recipient)',
      'isAccountFrozen',
      [input.recipient],
      'RECIPIENT_FROZEN',
    );
    try {
      const result = await this.client.call({
        account: input.account,
        to: token,
        data: encodeFunctionData({
          abi: ausdAbi,
          functionName: 'transfer',
          args: [input.recipient, input.amount],
        }),
        blockNumber,
      });
      const succeeded = result.data === `0x${'0'.repeat(63)}1`;
      checks.push({
        name: 'transferSimulation',
        value: succeeded,
        error: succeeded ? null : 'ERC20 transfer did not return true',
      });
      if (!succeeded) reasons.add('TRANSFER_SIMULATION_UNSUCCESSFUL');
    } catch (error) {
      checks.push({
        name: 'transferSimulation',
        value: false,
        error: short(error),
      });
      reasons.add('TRANSFER_SIMULATION_REVERTED');
    }
    return {
      ...base,
      token,
      status: reasons.size ? 'BLOCKED' : 'PASS',
      blockNumber: String(blockNumber),
      checks,
      reasons: [...reasons],
    };
  }

  async require(input: Parameters<AusdGuard['check']>[0]) {
    const result = await this.check(input);
    if (result.status !== 'PASS')
      throw new FundingError('AUSD_GUARD_BLOCKED', result.reasons.join(','));
    return result;
  }
}
