import {
  createDelegation,
  createExecution,
  ExecutionMode,
  getSmartAccountsEnvironment,
  ROOT_AUTHORITY,
  ScopeType,
  contracts,
  type Caveat,
  type Delegation,
  type SmartAccountsEnvironment,
} from '@metamask/smart-accounts-kit';
import {
  SIGNABLE_DELEGATION_TYPED_DATA,
  createCaveatBuilder,
  hashDelegation,
  toDelegationStruct,
} from '@metamask/smart-accounts-kit/utils';
import {
  assetForRole,
  isMutationEnabledChain,
  profileForChainId,
} from '@synq/chain-registry';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hashTypedData,
  isAddress,
  parseAbi,
  recoverAddress,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

export type DelegationErrorCode =
  | 'POLICY_INVALID'
  | 'NETWORK_FORBIDDEN'
  | 'TOKEN_INVALID'
  | 'DELEGATION_MISMATCH'
  | 'OVER_PERIOD_CAP'
  | 'OVER_CUMULATIVE_CAP'
  | 'OUTSIDE_WINDOW'
  | 'WRONG_DESTINATION'
  | 'DUPLICATE_ATTEMPT'
  | 'GROUP_POLICY_VIOLATION'
  | 'SIGNATURE_INVALID'
  | 'DELEGATION_REVOKED';

export class DelegationPolicyError extends Error {
  constructor(
    readonly code: DelegationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DelegationPolicyError';
  }
}
const fail = (code: DelegationErrorCode, message: string): never => {
  throw new DelegationPolicyError(code, message);
};

/** "Up to N AUSD every period until a date", from one member account to one group Safe. */
export type RecurringContributionPolicy = {
  chainId: number;
  token: Address;
  delegator: Address;
  delegate: Address;
  safe: Address;
  perPeriodAmount: bigint;
  periodSeconds: number;
  startDate: number;
  cumulativeCap: bigint;
  maxExecutions: number;
  validAfter: number;
  validUntil: number;
  salt: Hex;
};

/** Group-level ceiling the Kernel applies before Synq schedules any redemption. */
export type GroupContributionLimits = {
  safe: Address;
  maxPerPeriod: bigint;
  maxCumulative: bigint;
  latestValidUntil: number;
};

const ERC1271_MAGIC = '0x1626ba7e';
const ERC1271_ABI = parseAbi([
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
]);
const DISABLED_ABI = parseAbi([
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
]);

/** Minimal chain reads the adapter needs (a viem PublicClient satisfies it). */
export type DelegationChainReader = Pick<
  PublicClient,
  'getCode' | 'readContract'
>;

export type RedemptionCall = {
  to: Address;
  data: Hex;
  value: 0n;
  delegationHash: Hex;
};

const TRANSFER_SELECTOR = '0xa9059cbb';

export class MetaMaskDelegationAdapter {
  readonly environment: SmartAccountsEnvironment;
  readonly token: Address;

  constructor(readonly chainId: number) {
    const profile = profileForChainId(chainId);
    if (!profile || isMutationEnabledChain(chainId) === false)
      fail(
        'NETWORK_FORBIDDEN',
        `chain ${chainId} is not a Synq testnet profile`,
      );
    if (profile!.network.profile === 'proof/monad-mainnet')
      fail('NETWORK_FORBIDDEN', 'delegated contributions are testnet-only');
    this.environment = getSmartAccountsEnvironment(chainId);
    this.token = getAddress(assetForRole(profile!, 'treasuryAsset').address);
  }

  get delegationManager(): Address {
    return getAddress(this.environment.DelegationManager);
  }

  validatePolicy(
    p: RecurringContributionPolicy,
    limits: GroupContributionLimits,
  ) {
    if (p.chainId !== this.chainId)
      fail('NETWORK_FORBIDDEN', 'policy is for another chain');
    if (getAddress(p.token) !== this.token)
      fail('TOKEN_INVALID', `token ${p.token} is not the treasury AUSD`);
    for (const [k, v] of [
      ['delegator', p.delegator],
      ['delegate', p.delegate],
      ['safe', p.safe],
    ] as const)
      if (!isAddress(v) || getAddress(v) === zeroAddress)
        fail('POLICY_INVALID', `${k} is not a valid address`);
    if (getAddress(p.delegate) === getAddress(p.delegator))
      fail('POLICY_INVALID', 'delegate must differ from delegator');
    if (getAddress(p.safe) === getAddress(p.delegate))
      fail('POLICY_INVALID', 'the executor cannot be the destination');
    if (p.perPeriodAmount <= 0n)
      fail('POLICY_INVALID', 'per-period amount must be positive');
    if (p.cumulativeCap < p.perPeriodAmount)
      fail('POLICY_INVALID', 'cumulative cap below one period');
    if (!Number.isSafeInteger(p.periodSeconds) || p.periodSeconds < 60)
      fail('POLICY_INVALID', 'period too short');
    if (
      !Number.isSafeInteger(p.maxExecutions) ||
      p.maxExecutions < 1 ||
      p.maxExecutions > 1000
    )
      fail('POLICY_INVALID', 'max executions out of range');
    if (
      !(p.validAfter < p.validUntil) ||
      p.startDate < p.validAfter - p.periodSeconds ||
      p.startDate >= p.validUntil
    )
      fail('POLICY_INVALID', 'invalid validity window');
    if (!/^0x[0-9a-fA-F]{64}$/.test(p.salt))
      fail('POLICY_INVALID', 'salt must be bytes32');
    {
      if (getAddress(limits.safe) !== getAddress(p.safe))
        fail('GROUP_POLICY_VIOLATION', 'destination is not the group Safe');
      if (p.perPeriodAmount > limits.maxPerPeriod)
        fail('GROUP_POLICY_VIOLATION', 'per-period amount above group limit');
      if (p.cumulativeCap > limits.maxCumulative)
        fail('GROUP_POLICY_VIOLATION', 'cumulative cap above group limit');
      if (p.validUntil > limits.latestValidUntil)
        fail('GROUP_POLICY_VIOLATION', 'validity beyond group limit');
    }
  }

  /** Caveats beyond the erc20PeriodTransfer scope (which pins token, transfer selector and period cap). */
  private extraCaveats(p: RecurringContributionPolicy): Caveat[] {
    return createCaveatBuilder(this.environment)
      .addCaveat('allowedCalldata', {
        startIndex: 4,
        value: encodeAbiParameters([{ type: 'address' }], [getAddress(p.safe)]),
      })
      .addCaveat('erc20TransferAmount', {
        tokenAddress: this.token,
        maxAmount: p.cumulativeCap,
      })
      .addCaveat('valueLte', { maxValue: 0n })
      .addCaveat('timestamp', {
        afterThreshold: p.validAfter,
        beforeThreshold: p.validUntil,
      })
      .addCaveat('limitedCalls', { limit: p.maxExecutions })
      .addCaveat('redeemer', { redeemers: [getAddress(p.delegate)] })
      .build();
  }

  /** Unsigned delegation; the member signs it in MetaMask (never Synq or an LLM). */
  buildDelegation(
    p: RecurringContributionPolicy,
    limits: GroupContributionLimits,
  ): Delegation {
    this.validatePolicy(p, limits);
    return createDelegation({
      environment: this.environment,
      from: getAddress(p.delegator),
      to: getAddress(p.delegate),
      salt: p.salt,
      scope: {
        type: ScopeType.Erc20PeriodTransfer,
        tokenAddress: this.token,
        periodAmount: p.perPeriodAmount,
        periodDuration: p.periodSeconds,
        startDate: p.startDate,
      },
      caveats: this.extraCaveats(p),
    });
  }

  /** EIP-712 payload the member's wallet signs (e.g. MetaMask or `mm wallet sign-typed-data`). */
  delegationTypedData(delegation: Delegation) {
    if (delegation.caveats.length === 0)
      fail('POLICY_INVALID', 'refusing an unrestricted delegation');
    return {
      domain: {
        name: 'DelegationManager',
        version: '1',
        chainId: this.chainId,
        verifyingContract: this.delegationManager,
      },
      types: SIGNABLE_DELEGATION_TYPED_DATA,
      primaryType: 'Delegation' as const,
      message: toDelegationStruct({ ...delegation, signature: '0x' }),
    };
  }

  /** A signed delegation is accepted only if it is exactly the canonical one for the policy. */
  async verifyDelegation(
    signed: Delegation,
    p: RecurringContributionPolicy,
    limits: GroupContributionLimits,
    chain: DelegationChainReader,
  ): Promise<Hex> {
    const expected = this.buildDelegation(p, limits);
    const norm = (c: Caveat) =>
      `${getAddress(c.enforcer)}:${c.terms.toLowerCase()}`;
    if (
      getAddress(signed.delegator) !== getAddress(expected.delegator) ||
      getAddress(signed.delegate) !== getAddress(expected.delegate) ||
      signed.authority.toLowerCase() !== ROOT_AUTHORITY.toLowerCase() ||
      signed.salt.toLowerCase() !== expected.salt.toLowerCase() ||
      signed.caveats.length !== expected.caveats.length ||
      signed.caveats.some(
        (c, i) =>
          norm(c) !== norm(expected.caveats[i]!) ||
          c.args !== expected.caveats[i]!.args,
      )
    )
      fail(
        'DELEGATION_MISMATCH',
        'signed delegation differs from the approved policy',
      );
    if (
      !/^0x[0-9a-fA-F]+$/.test(signed.signature) ||
      signed.signature.length < 132
    )
      fail('DELEGATION_MISMATCH', 'delegation is unsigned');
    await this.assertSignedByDelegator(signed, chain);
    return hashDelegation(signed);
  }

  /**
   * EOAs and EIP-7702 stateless DeleGators (code = 0xef0100 || impl) sign with the
   * EOA key, so ECDSA recovery must yield the delegator. Any other contract
   * account must accept the delegation hash through ERC-1271.
   */
  private async assertSignedByDelegator(
    signed: Delegation,
    chain: DelegationChainReader,
  ) {
    const typed = this.delegationTypedData(signed);
    const digest = hashTypedData(typed);
    const delegator = getAddress(signed.delegator);
    const code = (
      (await chain.getCode({ address: delegator })) ?? '0x'
    ).toLowerCase();
    if (code === '0x' || code.startsWith('0xef0100')) {
      let recovered: Address | null = null;
      try {
        recovered = await recoverAddress({
          hash: digest,
          signature: signed.signature,
        });
      } catch {
        recovered = null;
      }
      if (recovered !== delegator)
        fail(
          'SIGNATURE_INVALID',
          'delegation was not signed by the delegator key',
        );
      return;
    }
    let magic: Hex | null = null;
    try {
      magic = await chain.readContract({
        address: delegator,
        abi: ERC1271_ABI,
        functionName: 'isValidSignature',
        args: [digest, signed.signature],
      });
    } catch {
      magic = null;
    }
    if (magic?.toLowerCase() !== ERC1271_MAGIC)
      fail(
        'SIGNATURE_INVALID',
        'delegator account rejected the signature (ERC-1271)',
      );
  }

  /** On-chain revocation state; a disabled delegation is never planned. */
  async isDisabled(signed: Delegation, chain: DelegationChainReader) {
    return chain.readContract({
      address: this.delegationManager,
      abi: DISABLED_ABI,
      functionName: 'disabledDelegations',
      args: [hashDelegation(signed)],
    });
  }

  /** Raw redeemDelegations call for one execution; used directly only by enforcement tests. */
  encodeRedemption(
    signed: Delegation,
    execution: { target: Address; callData: Hex },
  ): RedemptionCall {
    return {
      to: this.delegationManager,
      data: contracts.DelegationManager.encode.redeemDelegations({
        delegations: [[signed]],
        modes: [ExecutionMode.SingleDefault],
        executions: [
          [
            createExecution({
              target: execution.target,
              value: 0n,
              callData: execution.callData,
            }),
          ],
        ],
      }),
      value: 0n,
      delegationHash: hashDelegation(signed),
    };
  }

  /** Off-chain pre-checks the Synq executor runs before asking the chain to enforce the same terms. */
  async planContribution(
    signed: Delegation,
    p: RecurringContributionPolicy,
    input: {
      amount: bigint;
      nowSeconds: number;
      spentThisPeriod: bigint;
      spentTotal: bigint;
    },
    limits: GroupContributionLimits,
    chain: DelegationChainReader,
  ): Promise<RedemptionCall> {
    await this.verifyDelegation(signed, p, limits, chain);
    if (await this.isDisabled(signed, chain))
      fail('DELEGATION_REVOKED', 'delegation was revoked on-chain');
    if (
      input.nowSeconds < p.validAfter ||
      input.nowSeconds >= p.validUntil ||
      input.nowSeconds < p.startDate
    )
      fail(
        'OUTSIDE_WINDOW',
        'contribution attempted outside the delegation window',
      );
    if (
      input.amount <= 0n ||
      input.spentThisPeriod + input.amount > p.perPeriodAmount
    )
      fail(
        'OVER_PERIOD_CAP',
        'amount exceeds the remaining allowance for this period',
      );
    if (input.spentTotal + input.amount > p.cumulativeCap)
      fail('OVER_CUMULATIVE_CAP', 'amount exceeds the cumulative cap');
    const callData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [getAddress(p.safe), input.amount],
    });
    assertContributionCall(this.token, getAddress(p.safe), {
      target: this.token,
      callData,
    });
    return this.encodeRedemption(signed, { target: this.token, callData });
  }

  /** disableDelegation must be sent by the delegator account itself. */
  revocation(signed: Delegation): { to: Address; data: Hex; from: Address } {
    return {
      to: this.delegationManager,
      data: contracts.DelegationManager.encode.disableDelegation({
        delegation: signed,
      }),
      from: getAddress(signed.delegator),
    };
  }

  periodIndex(p: RecurringContributionPolicy, nowSeconds: number): number {
    return Math.floor((nowSeconds - p.startDate) / p.periodSeconds);
  }
}

export function assertContributionCall(
  token: Address,
  safe: Address,
  execution: { target: Address; callData: Hex },
) {
  if (getAddress(execution.target) !== token)
    fail('TOKEN_INVALID', 'execution targets another contract');
  if (!execution.callData.toLowerCase().startsWith(TRANSFER_SELECTOR))
    fail('POLICY_INVALID', 'execution is not an ERC-20 transfer');
  const { args } = decodeFunctionData({
    abi: erc20Abi,
    data: execution.callData,
  });
  if (getAddress(args[0] as Address) !== safe)
    fail('WRONG_DESTINATION', 'transfer recipient is not the group Safe');
}

/** One redemption per (delegation, period, attempt); Temporal retries reuse the same key. */
export interface AttemptLedger {
  claim(key: string): Promise<boolean>;
}
export class MemoryAttemptLedger implements AttemptLedger {
  private readonly keys = new Set<string>();
  async claim(key: string) {
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    return true;
  }
}
/** Durable ledger: one row per attempt key, inserted once. */
export class PostgresAttemptLedger implements AttemptLedger {
  constructor(
    private readonly pool: {
      query(
        sql: string,
        values?: unknown[],
      ): Promise<{ rowCount: number | null }>;
    },
  ) {}
  async migrate() {
    await this.pool.query(
      'CREATE TABLE IF NOT EXISTS synq_delegation_attempts (attempt_key text PRIMARY KEY, claimed_at timestamptz NOT NULL DEFAULT now())',
    );
  }
  async claim(key: string) {
    const r = await this.pool.query(
      'INSERT INTO synq_delegation_attempts(attempt_key) VALUES ($1) ON CONFLICT DO NOTHING',
      [key],
    );
    return r.rowCount === 1;
  }
}

export async function claimAttempt(
  ledger: AttemptLedger,
  delegationHash: Hex,
  period: number,
) {
  const key = `${delegationHash.toLowerCase()}:${period}`;
  if (!(await ledger.claim(key)))
    fail('DUPLICATE_ATTEMPT', `period ${period} already attempted`);
  return key;
}
