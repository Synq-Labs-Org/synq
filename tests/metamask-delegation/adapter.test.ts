import { officialAsset, profileConfiguration } from '@synq/chain-registry';
import {
  MetaMaskDelegationAdapter,
  MemoryAttemptLedger,
  PostgresAttemptLedger,
  assertContributionCall,
  claimAttempt,
  type DelegationChainReader,
  type GroupContributionLimits,
  type RecurringContributionPolicy,
} from '@synq/metamask-delegation';
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

const chainId = profileConfiguration('sandbox/monad-testnet').network.chainId;
const memberAccount = privateKeyToAccount(
  keccak256(toHex('synq-test-member')) as Hex,
);
const intruder = privateKeyToAccount(keccak256(toHex('synq-test-intruder')));
const member = memberAccount.address;
const executor = getAddress(`0x${'e'.repeat(40)}`);
const safe = getAddress(`0x${'5'.repeat(40)}`);
const rogue = getAddress(`0x${'3'.repeat(40)}`);
const adapter = new MetaMaskDelegationAdapter(chainId);
const now = 1_790_000_000;
const limits: GroupContributionLimits = {
  safe,
  maxPerPeriod: 20_000_000n,
  maxCumulative: 200_000_000n,
  latestValidUntil: now + 100 * 86_400,
};
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
const signed = async (p = policy(), by = memberAccount) => {
  const d = adapter.buildDelegation(p, { ...limits, safe: p.safe });
  return {
    ...d,
    signature: await by.signTypedData(adapter.delegationTypedData(d)),
  };
};

/** Fake chain: delegator code (EOA / 7702 / contract), 1271 answers and revocations. */
function chain(
  opts: { code?: Hex; accept1271?: boolean; disabled?: Hex[] } = {},
): DelegationChainReader {
  return {
    getCode: async () => opts.code ?? '0x',
    readContract: (async (args: {
      functionName: string;
      args: readonly unknown[];
    }) => {
      if (args.functionName === 'disabledDelegations')
        return (opts.disabled ?? []).includes(args.args[0] as Hex);
      if (args.functionName === 'isValidSignature')
        return opts.accept1271 ? '0x1626ba7e' : '0xffffffff';
      throw new Error(`unexpected ${args.functionName}`);
    }) as DelegationChainReader['readContract'],
  };
}
const designator = `0xef0100${'6'.repeat(40)}` as Hex;

const sync = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};
const async_ = async (p: Promise<unknown>) => {
  try {
    await p;
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
    expect(sync(() => new MetaMaskDelegationAdapter(143))).toBe(
      'NETWORK_FORBIDDEN',
    );
  });

  it('builds a period-capped, Safe-bound, time-boxed, call-limited, redeemer-bound delegation', () => {
    const d = adapter.buildDelegation(policy(), limits);
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

  it('accepts only the exact delegation, signed by the delegator (EOA or EIP-7702)', async () => {
    const s = await signed();
    for (const c of [chain(), chain({ code: designator })])
      expect(await adapter.verifyDelegation(s, policy(), limits, c)).toMatch(
        /^0x[0-9a-f]{64}$/,
      );
    expect(
      await recoverTypedDataAddress({
        ...adapter.delegationTypedData(s),
        signature: s.signature,
      }),
    ).toBe(member);
    const other = await signed(policy({ safe: rogue }));
    expect(
      await async_(adapter.verifyDelegation(other, policy(), limits, chain())),
    ).toBe('DELEGATION_MISMATCH');
    expect(
      await async_(
        adapter.verifyDelegation(
          { ...s, caveats: s.caveats.slice(1) },
          policy(),
          limits,
          chain(),
        ),
      ),
    ).toBe('DELEGATION_MISMATCH');
    expect(
      await async_(
        adapter.verifyDelegation(
          { ...s, delegate: rogue },
          policy(),
          limits,
          chain(),
        ),
      ),
    ).toBe('DELEGATION_MISMATCH');
    expect(
      await async_(
        adapter.verifyDelegation(
          { ...s, signature: '0x' },
          policy(),
          limits,
          chain(),
        ),
      ),
    ).toBe('DELEGATION_MISMATCH');
  });

  it('rejects forged signatures off-chain (L5)', async () => {
    const forged = await signed(policy(), intruder);
    expect(
      await async_(adapter.verifyDelegation(forged, policy(), limits, chain())),
    ).toBe('SIGNATURE_INVALID');
    expect(
      await async_(
        adapter.verifyDelegation(
          forged,
          policy(),
          limits,
          chain({ code: designator }),
        ),
      ),
    ).toBe('SIGNATURE_INVALID');
    const garbage = {
      ...(await signed()),
      signature: `0x${'ab'.repeat(65)}` as Hex,
    };
    expect(
      await async_(
        adapter.verifyDelegation(garbage, policy(), limits, chain()),
      ),
    ).toBe('SIGNATURE_INVALID');
    const contract = chain({ code: '0x6080604052' as Hex, accept1271: false });
    expect(
      await async_(
        adapter.verifyDelegation(await signed(), policy(), limits, contract),
      ),
    ).toBe('SIGNATURE_INVALID');
    const accepts = chain({ code: '0x6080604052' as Hex, accept1271: true });
    expect(
      await async_(adapter.verifyDelegation(forged, policy(), limits, accepts)),
    ).toBe('NO_ERROR');
  });

  it('plans only bounded transfers to the Safe inside the window', async () => {
    const s = await signed();
    const call = await adapter.planContribution(
      s,
      policy(),
      { ...fresh, amount: 20_000_000n },
      limits,
      chain(),
    );
    expect(call.to).toBe(adapter.delegationManager);
    const plan = (o: Partial<typeof fresh> & { amount: bigint }) =>
      async_(
        adapter.planContribution(
          s,
          policy(),
          { ...fresh, ...o },
          limits,
          chain(),
        ),
      );
    expect(await plan({ amount: 20_000_001n })).toBe('OVER_PERIOD_CAP');
    expect(await plan({ amount: 1n, spentThisPeriod: 20_000_000n })).toBe(
      'OVER_PERIOD_CAP',
    );
    expect(await plan({ amount: 1n, spentTotal: 200_000_000n })).toBe(
      'OVER_CUMULATIVE_CAP',
    );
    expect(await plan({ amount: 1n, nowSeconds: now + 91 * 86_400 })).toBe(
      'OUTSIDE_WINDOW',
    );
    const bad = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [rogue, 1n],
    });
    expect(
      sync(() =>
        assertContributionCall(adapter.token, safe, {
          target: adapter.token,
          callData: bad,
        }),
      ),
    ).toBe('WRONG_DESTINATION');
    expect(
      sync(() =>
        assertContributionCall(adapter.token, safe, {
          target: rogue,
          callData: bad,
        }),
      ),
    ).toBe('TOKEN_INVALID');
  });

  it('never plans a delegation revoked on-chain (L6)', async () => {
    const s = await signed();
    const hash = await adapter.verifyDelegation(s, policy(), limits, chain());
    expect(
      await async_(
        adapter.planContribution(
          s,
          policy(),
          { ...fresh, amount: 1n },
          limits,
          chain({ disabled: [hash] }),
        ),
      ),
    ).toBe('DELEGATION_REVOKED');
  });

  it('requires and applies the Kernel group limits (L6)', () => {
    expect(sync(() => adapter.buildDelegation(policy(), limits))).toBe(
      'NO_ERROR',
    );
    expect(
      sync(() =>
        adapter.buildDelegation(
          policy({ perPeriodAmount: 21_000_000n }),
          limits,
        ),
      ),
    ).toBe('GROUP_POLICY_VIOLATION');
    expect(
      sync(() => adapter.buildDelegation(policy(), { ...limits, safe: rogue })),
    ).toBe('GROUP_POLICY_VIOLATION');
    expect(
      sync(() =>
        adapter.buildDelegation(
          policy({ validUntil: now + 200 * 86_400 }),
          limits,
        ),
      ),
    ).toBe('GROUP_POLICY_VIOLATION');
    expect(
      sync(() => adapter.buildDelegation(policy({ token: rogue }), limits)),
    ).toBe('TOKEN_INVALID');
    expect(
      sync(() => adapter.buildDelegation(policy({ delegate: member }), limits)),
    ).toBe('POLICY_INVALID');
    expect(
      sync(() =>
        adapter.buildDelegation(policy({ cumulativeCap: 1n }), limits),
      ),
    ).toBe('POLICY_INVALID');
    expect(
      sync(() =>
        adapter.buildDelegation(
          policy(),
          undefined as unknown as GroupContributionLimits,
        ),
      ),
    ).not.toBe('NO_ERROR');
  });

  it('revocation is a disableDelegation call from the delegator', async () => {
    const s = await signed();
    const r = adapter.revocation(s);
    expect(r.from).toBe(member);
    expect(r.to).toBe(adapter.delegationManager);
    expect(() => decodeFunctionData({ abi: erc20Abi, data: r.data })).toThrow();
    expect(hashTypedData(adapter.delegationTypedData(s))).toMatch(/^0x/);
  });

  it('claims one attempt per delegation period, durably', async () => {
    const h = keccak256(toHex('d'));
    const rows = new Set<string>();
    const pool = {
      query: async (sql: string, values?: unknown[]) => {
        if (sql.startsWith('CREATE')) return { rowCount: 0 };
        const key = String(values![0]);
        if (rows.has(key)) return { rowCount: 0 };
        rows.add(key);
        return { rowCount: 1 };
      },
    };
    for (const ledger of [
      new MemoryAttemptLedger(),
      new PostgresAttemptLedger(pool),
    ]) {
      await claimAttempt(ledger, h, 0);
      await expect(claimAttempt(ledger, h, 0)).rejects.toMatchObject({
        code: 'DUPLICATE_ATTEMPT',
      });
      await claimAttempt(ledger, h, 1);
    }
    expect(adapter.periodIndex(policy(), now + 8 * 86_400)).toBe(1);
  });
});
