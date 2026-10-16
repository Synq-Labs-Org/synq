import { describe, expect, it } from 'vitest';
import { isAddressEqual, type Address, type Hex } from 'viem';
import { moneyFromDecimal } from '@synq/domain';
import { assetFromModel, contract, token } from '@synq/chain-registry/arc';
import {
  ENTITLEMENT_MAX_AGE_MS,
  TELLER_ACTIONS,
  UsycError,
  assertUsycAllowed,
  checkUsycEntitlement,
  planUsycSubscription,
  type UsycReader,
} from '@synq/plugin-usyc';
import code from './fixtures/usyc-proxy-code.json' with { type: 'json' };

const teller = contract('arc-testnet', 'USYC_TELLER').address;
const entitlements = contract('arc-testnet', 'USYC_ENTITLEMENTS').address;
const usdc = token('arc-testnet', 'USDC');
const usyc = token('arc-testnet', 'USYC');
const retail = `0x${'1'.repeat(40)}` as Address;
const institution = `0x${'2'.repeat(40)}` as Address;
const now = Date.parse('2026-10-16T06:20:00Z');

/** Read-only chain double: what Arc testnet returned on 2026-10-16, plus an allowlisted wallet. */
function chain(opts: {
  allowlisted?: Address[];
  authority?: Address;
  tellerCode?: Hex;
  calls?: string[];
}): UsycReader {
  const calls = opts.calls ?? [];
  return {
    async getCode({ address }) {
      calls.push(`getCode:${address}`);
      if (isAddressEqual(address, teller))
        return (opts.tellerCode ?? code.teller) as Hex;
      if (isAddressEqual(address, entitlements))
        return code.entitlements as Hex;
      return undefined;
    },
    async readContract({ address, functionName, args }) {
      calls.push(`${functionName}`);
      if (isAddressEqual(address, teller)) {
        if (functionName === 'authority') return opts.authority ?? entitlements;
        if (functionName === 'asset') return usdc.address;
        if (functionName === 'share') return usyc.address;
        if (functionName === 'maxDeposit') return 24_517_556n; // = balance, not an entitlement
      }
      if (isAddressEqual(address, entitlements)) {
        const user = (args?.[0] ?? '0x') as Address;
        const ok = (opts.allowlisted ?? []).some((a) =>
          isAddressEqual(a, user),
        );
        if (functionName === 'canCall') return ok;
        if (functionName === 'isCapabilityPublic') return false;
        if (functionName === 'getUserRoles')
          return ok ? `0x${'0'.repeat(62)}01` : `0x${'0'.repeat(64)}`;
        if (functionName === 'getRolesWithCapability')
          return `0x${'0'.repeat(60)}0201`;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  };
}

describe('USYC entitlement gate (P15)', () => {
  it('P15-01 a retail (non-allowlisted) wallet is INELIGIBLE and cannot get a subscription plan', async () => {
    const e = await checkUsycEntitlement(chain({}), retail, 'deposit', now);
    expect(e).toMatchObject({
      status: 'INELIGIBLE',
      canCall: false,
      capabilityPublic: false,
      selector: TELLER_ACTIONS.deposit,
    });
    expect(e.explanation).toMatch(
      /not allowlisted .* will not attempt or simulate/,
    );
    expect(() =>
      planUsycSubscription({
        entitlement: e,
        wallet: retail,
        amount: moneyFromDecimal(usdc, '100000'),
        now,
      }),
    ).toThrow(UsycError);
    try {
      assertUsycAllowed(e, retail, 'deposit', now);
    } catch (err) {
      expect((err as UsycError).code).toBe('INELIGIBLE');
    }
    // A model cannot name USYC as a payable asset at all.
    expect(() =>
      assetFromModel({ chain: 'arc-testnet', symbol: 'USYC' }),
    ).toThrow();
    expect(usyc).toMatchObject({ decimals: 6 });
  });

  it('P15-02 the allowlist is read (after code-hash and authority binding) before any Teller action is planned', async () => {
    const calls: string[] = [];
    const e = await checkUsycEntitlement(
      chain({ allowlisted: [institution], calls }),
      institution,
      'deposit',
      now,
    );
    expect(e.status).toBe('ELIGIBLE');
    // Order: bytecode pins, Teller binding, then the Entitlements read.
    expect(calls.indexOf('authority')).toBeGreaterThan(
      calls.map((c) => c.startsWith('getCode')).lastIndexOf(true),
    );
    expect(calls.indexOf('canCall')).toBeGreaterThan(
      calls.indexOf('authority'),
    );
    const plan = planUsycSubscription({
      entitlement: e,
      wallet: institution,
      amount: moneyFromDecimal(usdc, '1'),
      now: now + 1_000,
    });
    expect(plan.deposit.to).toBe(teller);
    expect(plan.approve.to).toBe(usdc.address);
    // The entitlement is per wallet, per action and short-lived.
    expect(() =>
      planUsycSubscription({
        entitlement: e,
        wallet: retail,
        amount: moneyFromDecimal(usdc, '1'),
        now,
      }),
    ).toThrow(/entitlement is for/);
    expect(() => assertUsycAllowed(e, institution, 'redeem', now)).toThrow(
      UsycError,
    );
    expect(() =>
      planUsycSubscription({
        entitlement: e,
        wallet: institution,
        amount: moneyFromDecimal(usdc, '1'),
        now: now + ENTITLEMENT_MAX_AGE_MS + 1,
      }),
    ).toThrow(/re-read canCall/);
    expect(() =>
      planUsycSubscription({
        entitlement: e,
        wallet: institution,
        amount: moneyFromDecimal(token('arc-testnet', 'EURC'), '1'),
        now,
      }),
    ).toThrow(/Arc USDC/);
  });

  it('P15-02 a Teller answering to another authority, or with different bytecode, is refused outright', async () => {
    await expect(
      checkUsycEntitlement(
        chain({
          allowlisted: [institution],
          authority: `0x${'3'.repeat(40)}` as Address,
        }),
        institution,
        'deposit',
        now,
      ),
    ).rejects.toMatchObject({ code: 'BINDING_MISMATCH' });
    await expect(
      checkUsycEntitlement(
        chain({ allowlisted: [institution], tellerCode: '0x6080' }),
        institution,
        'deposit',
        now,
      ),
    ).rejects.toMatchObject({ code: 'CODE_HASH_MISMATCH' });
  });
});
