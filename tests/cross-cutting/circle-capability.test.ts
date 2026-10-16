import { describe, expect, it } from 'vitest';
import {
  isAddressEqual,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { moneyFromDecimal } from '@synq/domain';
import { chainProfile, contract, token } from '@synq/chain-registry/arc';
import {
  ARC_PAYMASTER_REFUSAL,
  PaymasterError,
  paymasterFor,
} from '@synq/plugin-circle-paymaster';
import {
  GAS_STATION_LIVE_STATUS,
  decideSponsorship,
  sourceGasRequirement,
} from '@synq/plugin-circle-gas';
import {
  UsycError,
  checkUsycEntitlement,
  planUsycSubscription,
  type UsycReader,
} from '@synq/plugin-usyc';
import { CctpError, planTransfer } from '@synq/plugin-circle-cctp';
import { ArcExecutionError, prepareTransfer } from '@synq/execution-worker/arc';
import {
  ARC_PROVIDERS,
  buildArcWorldSnapshot,
  type ProviderProbe,
} from '@synq/world-model';
import code from '../arc/fixtures/usyc-proxy-code.json' with { type: 'json' };

/**
 * P23-04: a missing Circle network capability blocks the live action. Each
 * case drives the real planner/executor gate with no credentials and no
 * network (LOCAL_FIXTURE); none of them returns a simulated success.
 */

const NOW = Date.parse('2026-10-16T06:20:00Z');
const wallet = `0x${'4b'.repeat(20)}` as Address;
const noRpc = new Proxy(
  {},
  {
    get: (_t, p) => () => {
      throw new Error(`unexpected RPC ${String(p)}`);
    },
  },
) as PublicClient;

const teller = contract('arc-testnet', 'USYC_TELLER').address;
const entitlements = contract('arc-testnet', 'USYC_ENTITLEMENTS').address;
const nobodyAllowlisted: UsycReader = {
  async getCode({ address }) {
    if (isAddressEqual(address, teller)) return code.teller as Hex;
    if (isAddressEqual(address, entitlements)) return code.entitlements as Hex;
    return undefined;
  },
  async readContract({ address, functionName }) {
    if (isAddressEqual(address, teller)) {
      if (functionName === 'authority') return entitlements;
      if (functionName === 'asset') return token('arc-testnet', 'USDC').address;
      if (functionName === 'share') return token('arc-testnet', 'USYC').address;
    }
    if (functionName === 'canCall') return false;
    if (functionName === 'isCapabilityPublic') return false;
    if (functionName === 'getUserRoles') return `0x${'0'.repeat(64)}`;
    if (functionName === 'getRolesWithCapability')
      return `0x${'0'.repeat(60)}0201`;
    throw new Error(`unexpected read ${functionName}`);
  },
};

describe('P23-04 missing Circle network capability blocks live action', () => {
  it('P23-04 Circle Paymaster on Arc is refused with the reason, never simulated', () => {
    for (const chain of ['arc-testnet', 'arc-mainnet'] as const)
      for (const v of ['0.7', '0.8'] as const) {
        let err: unknown;
        try {
          paymasterFor(chain, v);
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(PaymasterError);
        expect((err as PaymasterError).code).toBe('NOT_ON_ARC');
        expect((err as PaymasterError).message).toBe(ARC_PAYMASTER_REFUSAL);
      }
    // A source chain without the requested version is refused, too.
    expect(() => paymasterFor('eth-sepolia', '0.7')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CHAIN' }),
    );
    // An ETH-less source wallet gets a user-visible requirement, not a send.
    const gas = sourceGasRequirement({
      chain: 'eth-sepolia',
      wallet,
      walletKind: 'EOA',
      nativeBalance: 0n,
      estimatedGasWei: 10n ** 15n,
      action: 'send USDC to Arc via CCTP',
    });
    expect(gas).toMatchObject({ ok: false, code: 'NEEDS_NATIVE_GAS' });
    if (!gas.ok) expect(gas.userMessage).toMatch(/Nothing was sent/);
  });

  it('P23-04 Gas Station without Circle credentials (or on an unconfigured chain) sponsors nothing', async () => {
    expect(GAS_STATION_LIVE_STATUS.status).toBe('BLOCKED');
    const snapshot = await buildArcWorldSnapshot({
      readers: {},
      providers: ARC_PROVIDERS.map(
        (p): ProviderProbe => ({ ...p, sdkInstalled: true }),
      ),
      env: { CIRCLE_API_KEY: '', CIRCLE_ENTITY_SECRET: undefined },
      now: Math.floor(NOW / 1000),
      tools: [
        {
          tool: 'circle_wallet_transfer',
          providerId: 'CIRCLE_WALLETS',
          needsHuman: false,
          financial: true,
        },
      ],
    });
    const wallets = snapshot.capabilities.providers.find(
      (p) => p.value.providerId === 'CIRCLE_WALLETS',
    )!.value;
    expect(wallets).toMatchObject({
      status: 'UNAVAILABLE',
      condition: 'NEEDS_CREDENTIALS',
      missingCredentials: ['CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET'],
    });
    // Names only: the snapshot never carries credential values.
    expect(JSON.stringify(snapshot)).not.toMatch(/sk_|whsec_|TEST_API_KEY/);
    expect(snapshot.capabilities.tools[0]).toMatchObject({
      tool: 'circle_wallet_transfer',
      status: 'NEEDS_CREDENTIALS',
    });
    expect(snapshot.capabilities.missing).toEqual(
      expect.arrayContaining(['AGENT_WALLET_CREATE', 'AGENT_WALLET_TRANSFER']),
    );
    const policy = {
      chain: 'arc-mainnet' as const,
      active: true,
      dailyLimitWei: 10n ** 18n,
      grantExpiresAt: null,
      blockedAddresses: [],
    };
    const deny = decideSponsorship({
      wallet,
      walletKind: 'SCA',
      circleWallet: true,
      estimatedFeeWei: 10n ** 15n,
      policy,
      usage: { dayStartUtc: NOW - (NOW % 86_400_000), spentWei: 0n },
      now: NOW,
    });
    expect(deny).toMatchObject({
      sponsored: false,
      reason: 'UNSUPPORTED_CHAIN',
      fallback: 'USER_PAYS_GAS',
    });
    // Not a Circle wallet (no Circle Wallets credentials): never sponsored.
    expect(
      decideSponsorship({
        wallet,
        walletKind: 'SCA',
        circleWallet: false,
        estimatedFeeWei: 10n ** 15n,
        policy: { ...policy, chain: 'arc-testnet' },
        usage: { dayStartUtc: NOW - (NOW % 86_400_000), spentWei: 0n },
        now: NOW,
      }),
    ).toMatchObject({ sponsored: false, reason: 'NOT_CIRCLE_WALLET' });
  });

  it('P23-04 USYC without entitlement plans no Teller call and the executor refuses the asset', async () => {
    const e = await checkUsycEntitlement(
      nobodyAllowlisted,
      wallet,
      'deposit',
      NOW,
    );
    expect(e.status).toBe('INELIGIBLE');
    let err: unknown;
    try {
      planUsycSubscription({
        entitlement: e,
        wallet,
        amount: moneyFromDecimal(token('arc-testnet', 'USDC'), '0.01'),
        now: NOW,
      });
    } catch (x) {
      err = x;
    }
    expect(err).toBeInstanceOf(UsycError);
    expect((err as UsycError).code).toBe('INELIGIBLE');
    await expect(
      prepareTransfer(
        { profile: chainProfile('arc-testnet'), client: noRpc },
        {
          from: wallet,
          to: teller,
          amount: moneyFromDecimal(token('arc-testnet', 'USYC'), '1'),
        },
      ),
    ).rejects.toMatchObject({ code: 'MUTATION_DISABLED' });
  });

  it('P23-04 CCTP with a Circle smart-wallet signer, or to a read-only chain, is refused', () => {
    const base = {
      transferId: 'cctp-p23-04',
      source: 'eth-sepolia' as const,
      destination: 'arc-testnet' as const,
      payer: wallet,
      payerKind: 'EOA',
      recipient: wallet,
      amount: 1_000n,
      maxFee: 10n,
      fast: false,
      reference: null,
      at: 1,
    };
    expect(planTransfer(base).state).toBe('QUOTED');
    expect(() => planTransfer({ ...base, payerKind: 'CIRCLE_SCA' })).toThrow(
      CctpError,
    );
    expect(() => planTransfer({ ...base, payerKind: 'CIRCLE_SCA' })).toThrow(
      /cannot sign a CCTP burn/,
    );
    expect(() => planTransfer({ ...base, destination: 'arc-mainnet' })).toThrow(
      /read-only chain/,
    );
  });

  it('P23-04 the executor refuses any mutation on Arc mainnet before touching the RPC', async () => {
    await expect(
      prepareTransfer(
        { profile: chainProfile('arc-mainnet'), client: noRpc },
        {
          from: wallet,
          to: wallet,
          amount: moneyFromDecimal(token('arc-mainnet', 'USDC'), '0.01'),
        },
      ),
    ).rejects.toBeInstanceOf(ArcExecutionError);
    await expect(
      prepareTransfer(
        { profile: chainProfile('arc-mainnet'), client: noRpc },
        {
          from: wallet,
          to: wallet,
          amount: moneyFromDecimal(token('arc-mainnet', 'USDC'), '0.01'),
        },
      ),
    ).rejects.toMatchObject({ code: 'MUTATION_DISABLED' });
  });
});
