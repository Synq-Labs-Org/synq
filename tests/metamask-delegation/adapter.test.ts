import { officialAsset, profileConfiguration } from '@synq/chain-registry';
import {
  MetaMaskDelegationAdapter,
  MemoryAttemptLedger,
  assertContributionCall,
  claimAttempt,
  type RecurringContributionPolicy,
} from '@synq/metamask-delegation';
import {
  decodeFunctionData,
  recoverTypedDataAddress,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  keccak256,
  toHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

const chainId = profileConfiguration('sandbox/monad-testnet').network.chainId;
const memberAccount = privateKeyToAccount(
  keccak256(toHex('synq-test-member')) as Hex,
);
const member = memberAccount.address;
const executor = getAddress(`0x${'e'.repeat(40)}`);
const safe = getAddress(`0x${'5'.repeat(40)}`);
const rogue = getAddress('0x3333333333333333333333333333333333333333');
const adapter = new MetaMaskDelegationAdapter(chainId);
const now = 1_790_000_000;
const policy = (
  o: Partial<RecurringContributionPolicy> = {},
): RecurringContributionPolicy => ({
  chainId,
  token: adapter.token,
  delegator: member,
  delegate: executor,
  safe,
  perPeriodAmount: 20_000_000n,
  periodSeconds: 7 * 86_400,
  startDate: now,
  cumulativeCap: 200_000_000n,
  maxExecutions: 12,
  validAfter: now - 60,
  validUntil: now + 90 * 86_400,
  salt: keccak256(toHex('salt-1')),
  ...o,
});
const signed = async (p = policy()) => {
  const d = adapter.buildDelegation(p);
  return {
    ...d,
    signature: await memberAccount.signTypedData(
      adapter.delegationTypedData(d),
    ),
  };
};
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};
const fresh = { nowSeconds: now + 10, spentThisPeriod: 0n, spentTotal: 0n };

describe('MetaMaskDelegationAdapter', () => {
  it('uses the kit deployment for Monad testnet and the registry AUSD', () => {
    expect(adapter.delegationManager).toBe(
      getAddress(adapter.environment.DelegationManager),
    );
    expect(adapter.token).toBe(
      getAddress(officialAsset('testnetAUSD').address),
    );
    expect(code(() => new MetaMaskDelegationAdapter(143))).toBe(
      'NETWORK_FORBIDDEN',
    );
  });

  it('builds a period-capped, Safe-bound, time-boxed, call-limited, redeemer-bound delegation', () => {
    const d = adapter.buildDelegation(policy());
    const env = adapter.environment.caveatEnforcers;
    const enforcers = d.caveats.map((c) => getAddress(c.enforcer));
    for (const name of [
      'ERC20PeriodTransferEnforcer',
      'AllowedCalldataEnforcer',
      'ERC20TransferAmountEnforcer',
      'ValueLteEnforcer',
      'TimestampEnforcer',
      'LimitedCallsEnforcer',
      'RedeemerEnforcer',
    ])
      expect(enforcers).toContain(getAddress(env[name]!));
    expect(d.delegate).toBe(executor);
    expect(d.delegator).toBe(member);
  });

  it('accepts only the exact signed delegation for the approved policy', async () => {
    const s = await signed();
    expect(adapter.verifyDelegation(s, policy())).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      await recoverTypedDataAddress({
        ...adapter.delegationTypedData(s),
        signature: s.signature,
      }),
    ).toBe(member);
    const other = await signed(policy({ safe: rogue }));
    expect(code(() => adapter.verifyDelegation(other, policy()))).toBe(
      'DELEGATION_MISMATCH',
    );
    expect(
      code(() =>
        adapter.verifyDelegation(
          { ...s, caveats: s.caveats.slice(1) },
          policy(),
        ),
      ),
    ).toBe('DELEGATION_MISMATCH');
    expect(
      code(() => adapter.verifyDelegation({ ...s, delegate: rogue }, policy())),
    ).toBe('DELEGATION_MISMATCH');
    expect(
      code(() => adapter.verifyDelegation({ ...s, signature: '0x' }, policy())),
    ).toBe('DELEGATION_MISMATCH');
  });

  it('plans only bounded transfers to the Safe inside the window', async () => {
    const s = await signed();
    const call = adapter.planContribution(s, policy(), {
      ...fresh,
      amount: 20_000_000n,
    });
    expect(call.to).toBe(adapter.delegationManager);
    expect(
      code(() =>
        adapter.planContribution(s, policy(), {
          ...fresh,
          amount: 20_000_001n,
        }),
      ),
    ).toBe('OVER_PERIOD_CAP');
    expect(
      code(() =>
        adapter.planContribution(s, policy(), {
          ...fresh,
          amount: 1n,
          spentThisPeriod: 20_000_000n,
        }),
      ),
    ).toBe('OVER_PERIOD_CAP');
    expect(
      code(() =>
        adapter.planContribution(s, policy(), {
          ...fresh,
          amount: 1n,
          spentTotal: 200_000_000n,
        }),
      ),
    ).toBe('OVER_CUMULATIVE_CAP');
    expect(
      code(() =>
        adapter.planContribution(s, policy(), {
          ...fresh,
          amount: 1n,
          nowSeconds: now + 91 * 86_400,
        }),
      ),
    ).toBe('OUTSIDE_WINDOW');
    const bad = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [rogue, 1n],
    });
    expect(
      code(() =>
        assertContributionCall(adapter.token, safe, {
          target: adapter.token,
          callData: bad,
        }),
      ),
    ).toBe('WRONG_DESTINATION');
    expect(
      code(() =>
        assertContributionCall(adapter.token, safe, {
          target: rogue,
          callData: bad,
        }),
      ),
    ).toBe('TOKEN_INVALID');
  });

  it('applies the group limits the Kernel supplies', () => {
    const limits = {
      safe,
      maxPerPeriod: 20_000_000n,
      maxCumulative: 200_000_000n,
      latestValidUntil: now + 100 * 86_400,
    };
    expect(code(() => adapter.buildDelegation(policy(), limits))).toBe(
      'NO_ERROR',
    );
    expect(
      code(() =>
        adapter.buildDelegation(
          policy({ perPeriodAmount: 21_000_000n }),
          limits,
        ),
      ),
    ).toBe('GROUP_POLICY_VIOLATION');
    expect(
      code(() => adapter.buildDelegation(policy(), { ...limits, safe: rogue })),
    ).toBe('GROUP_POLICY_VIOLATION');
    expect(
      code(() =>
        adapter.buildDelegation(
          policy({ validUntil: now + 200 * 86_400 }),
          limits,
        ),
      ),
    ).toBe('GROUP_POLICY_VIOLATION');
    expect(code(() => adapter.buildDelegation(policy({ token: rogue })))).toBe(
      'TOKEN_INVALID',
    );
    expect(
      code(() => adapter.buildDelegation(policy({ delegate: member }))),
    ).toBe('POLICY_INVALID');
    expect(
      code(() => adapter.buildDelegation(policy({ cumulativeCap: 1n }))),
    ).toBe('POLICY_INVALID');
  });

  it('revocation is a disableDelegation call from the delegator', async () => {
    const s = await signed();
    const r = adapter.revocation(s);
    expect(r.from).toBe(member);
    expect(r.to).toBe(adapter.delegationManager);
    expect(r.data.slice(0, 10)).not.toBe('0x');
    expect(() => decodeFunctionData({ abi: erc20Abi, data: r.data })).toThrow();
  });

  it('claims one attempt per delegation period', async () => {
    const ledger = new MemoryAttemptLedger();
    const h = keccak256(toHex('d'));
    await claimAttempt(ledger, h, 0);
    await expect(claimAttempt(ledger, h, 0)).rejects.toMatchObject({
      code: 'DUPLICATE_ATTEMPT',
    });
    await claimAttempt(ledger, h, 1);
    expect(adapter.periodIndex(policy(), now + 8 * 86_400)).toBe(1);
  });
});
