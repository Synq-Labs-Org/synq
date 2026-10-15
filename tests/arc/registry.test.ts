import { describe, expect, it } from 'vitest';
import {
  AmountError,
  addMoney,
  compareMoney,
  money,
  moneyFromDecimal,
  moneyToDecimal,
  sameAsset,
  subMoneyNonNegative,
} from '@synq/domain';
import {
  ARC_SOURCES,
  CHAINS,
  arcNativeToUsdc,
  assetByAddress,
  assetFromModel,
  chainById,
  contract,
  migrateLegacyAmount,
  migrateLegacyAsset,
  token,
  usdcToArcNativeWei,
} from '@synq/chain-registry/arc';

describe('Arc registry and typed money', () => {
  it('P01-02 canonical asset identity separates chain and decimal units', () => {
    const arc = token('arc-testnet', 'USDC');
    const sepolia = token('eth-sepolia', 'USDC');
    expect(arc).toMatchObject({
      network: 'eip155:5042002',
      chainId: 5042002,
      decimals: 6,
      canonical: 'USDC',
      environment: 'ARC_TESTNET',
      assetId:
        'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
    });
    // Same economic asset, different network: never the same AssetRef.
    expect(sepolia.canonical).toBe(arc.canonical);
    expect(sameAsset(arc, sepolia)).toBe(false);
    expect(() => addMoney(money(arc, 1n), money(sepolia, 1n))).toThrow(
      AmountError,
    );
    expect(token('arc-mainnet', 'USDC').environment).toBe('MAINNET_READ_ONLY');
    expect(CHAINS['arc-mainnet'].mutationEnabled).toBe(false);
    expect(ARC_SOURCES.retrievedAt).toBe('2026-10-16');
  });

  it('P02-02 native 18-decimal and ERC-20 6-decimal views round-trip without double counting', () => {
    const wei = 23_417_127_123_456_789_012n;
    const { usdc, dustWei } = arcNativeToUsdc('arc-testnet', wei);
    expect(usdc.baseUnits).toBe(23_417_127n);
    expect(dustWei).toBe(123_456_789_012n);
    expect(usdcToArcNativeWei(usdc) + dustWei).toBe(wei);
    // One USDC is 10^6 token units and 10^18 native wei: the doc's 6-decimal
    // native example would send 10^-12 USDC.
    const one = moneyFromDecimal(token('arc-testnet', 'USDC'), '1');
    expect(one.baseUnits).toBe(1_000_000n);
    expect(usdcToArcNativeWei(one)).toBe(10n ** 18n);
    expect(() =>
      usdcToArcNativeWei(money(token('eth-sepolia', 'USDC'), 1n)),
    ).toThrow(AmountError);
    expect(() =>
      usdcToArcNativeWei(money(token('arc-testnet', 'EURC'), 1n)),
    ).toThrow(AmountError);
  });

  it('exact decimal arithmetic rejects floats, extra precision and negatives', () => {
    const usdc = token('arc-testnet', 'USDC');
    expect(moneyToDecimal(moneyFromDecimal(usdc, '1500.25'))).toBe('1500.25');
    expect(moneyFromDecimal(usdc, '0.000001').baseUnits).toBe(1n);
    for (const bad of ['1.0000001', '-1', '1e6', '0x10', ' 1', '01'])
      expect(() => moneyFromDecimal(usdc, bad)).toThrow(AmountError);
    expect(() => moneyFromDecimal(usdc, 1.5 as unknown as string)).toThrow(
      AmountError,
    );
    expect(() => money(usdc, 1 as unknown as bigint)).toThrow(AmountError);
    const due = moneyFromDecimal(usdc, '100');
    expect(() =>
      subMoneyNonNegative(due, moneyFromDecimal(usdc, '100.000001')),
    ).toThrow(AmountError);
    expect(compareMoney(due, moneyFromDecimal(usdc, '99.999999'))).toBe(1);
    // 0.1 + 0.2 is exact here.
    expect(
      moneyToDecimal(
        addMoney(moneyFromDecimal(usdc, '0.1'), moneyFromDecimal(usdc, '0.2')),
      ),
    ).toBe('0.3');
  });

  it('P01-04 a model cannot invent a chain or asset', () => {
    expect(
      assetFromModel({ chain: 'arc-testnet', symbol: 'USDC' }).address,
    ).toBe('0x3600000000000000000000000000000000000000');
    const injected = [
      {
        chain: 'arc-testnet',
        symbol: 'USDC',
        address: '0x000000000000000000000000000000000000dEaD',
      },
      { chain: 'arc-testnet', symbol: 'USDC', decimals: 18 },
      { chain: 'solana', symbol: 'USDC' },
      { chain: 'arc-testnet', symbol: 'SCAM' },
      { chain: 'arc-testnet', symbol: 'USYC' },
      'USDC on Arc',
      null,
    ];
    for (const req of injected)
      expect(() => assetFromModel(req)).toThrow(AmountError);
    expect(() =>
      assetByAddress(5042002, '0x000000000000000000000000000000000000dEaD'),
    ).toThrow(AmountError);
    expect(() => chainById(1)).toThrow(AmountError);
    expect(
      assetByAddress(84532, '0x036cbd53842c5426634e7929541ec2318f3dcf7e')
        .symbol,
    ).toBe('USDC');
  });

  it('P01-01 legacy records migrate as legacy or are rejected with a typed error', () => {
    const ausd = migrateLegacyAsset({
      chainId: 10143,
      address: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
      symbol: 'AUSD',
      decimals: 6,
    });
    expect(ausd).toMatchObject({
      network: 'eip155:10143',
      environment: 'LEGACY_MONAD_TESTNET',
      decimals: 6,
    });
    expect(migrateLegacyAmount(ausd, '3000000').baseUnits).toBe(3_000_000n);
    expect(() => migrateLegacyAmount(ausd, '3.5')).toThrow(AmountError);
    expect(() => migrateLegacyAmount(ausd, 3_000_000)).toThrow(AmountError);
    expect(() =>
      migrateLegacyAsset({
        chainId: 1,
        address: '0x' + '1'.repeat(40),
        symbol: 'USDC',
        decimals: 6,
      }),
    ).toThrow(AmountError);
    expect(() =>
      migrateLegacyAsset({
        chainId: 10143,
        address: 'nope',
        symbol: 'AUSD',
        decimals: 6,
      }),
    ).toThrow(AmountError);
    // A legacy Monad asset is never an Arc asset.
    expect(sameAsset(ausd, token('arc-testnet', 'USDC'))).toBe(false);
  });

  it('pins official Arc contract addresses with code hashes and proxy flags', () => {
    const tm = contract('arc-testnet', 'CCTP_TOKEN_MESSENGER_V2');
    expect(tm.address).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
    expect(tm.proxy).toBe(true);
    expect(tm.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(contract('arc-testnet', 'GATEWAY_WALLET').address).toBe(
      '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
    );
    expect(CHAINS['arc-testnet'].cctpDomain).toBe(26);
    expect(CHAINS['eth-sepolia'].cctpDomain).toBe(0);
  });
});
