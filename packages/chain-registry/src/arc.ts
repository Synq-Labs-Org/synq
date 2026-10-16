import { z } from 'zod';
import rawArc from '../../../sources/arc_registry.json' with { type: 'json' };
import {
  AmountError,
  assetKey,
  caip2,
  money,
  type AssetRef,
  type Caip2,
  type Money,
  type SettlementEnvironment,
} from '@synq/domain';

/**
 * Arc-first network, asset and contract registry. Values come from official
 * docs (retrieved 2026-10-16) and were checked against live RPC the same day:
 * chain ids, ERC-20 decimals, CCTP `localDomain()` and the keccak256 of the
 * deployed bytecode. Execution refuses any address whose current code hash
 * differs from the pinned one (`verifyCode`). Nothing here is inferred from
 * model output: the only way to name an asset is through these tables.
 *
 * Monad (10143) stays in the legacy registry (`./index.ts`); it is not an Arc
 * network and its deployments must never be replayed here.
 */

export const ARC_SOURCES = {
  connect: 'https://docs.arc.io/arc/references/connect-to-arc',
  contracts: 'https://docs.arc.io/arc/references/contract-addresses',
  gas: 'https://docs.arc.io/arc/references/gas-and-fees',
  retrievedAt: '2026-10-16',
} as const;

export type ChainName =
  | 'arc-testnet'
  | 'arc-mainnet'
  | 'eth-sepolia'
  | 'base-sepolia'
  | 'arb-sepolia';

export type ChainProfile = Readonly<{
  name: ChainName;
  chainId: number;
  network: Caip2;
  environment: SettlementEnvironment;
  /** False means read-only: executors refuse to sign for this chain. */
  mutationEnabled: boolean;
  rpcEnvironment: string;
  rpcUrls: readonly string[];
  explorer: string;
  faucet: string | null;
  nativeSymbol: 'USDC' | 'ETH';
  nativeDecimals: 18;
  /** Arc publishes a base-fee floor; transactions under it may never land. */
  minMaxFeePerGasWei: bigint | null;
  /** Circle CCTP V2 domain, read from MessageTransmitterV2.localDomain(). */
  cctpDomain: number | null;
  confirmations: number;
}>;

const chain = (
  p: Omit<ChainProfile, 'network' | 'nativeDecimals'>,
): ChainProfile => ({
  ...p,
  network: caip2(p.chainId),
  nativeDecimals: 18,
});

export const CHAINS: Readonly<Record<ChainName, ChainProfile>> = {
  'arc-testnet': chain({
    name: 'arc-testnet',
    chainId: 5042002,
    environment: 'ARC_TESTNET',
    mutationEnabled: true,
    rpcEnvironment: 'SYNQ_ARC_TESTNET_RPC_URL',
    rpcUrls: [
      'https://rpc.testnet.arc.io',
      'https://rpc.drpc.testnet.arc.io',
      'https://rpc.blockdaemon.testnet.arc.io',
      'https://rpc.quicknode.testnet.arc.io',
    ],
    explorer: 'https://explorer.testnet.arc.io',
    faucet: 'https://faucet.circle.com',
    nativeSymbol: 'USDC',
    minMaxFeePerGasWei: 20_000_000_000n,
    cctpDomain: 26,
    confirmations: 1,
  }),
  'arc-mainnet': chain({
    name: 'arc-mainnet',
    chainId: 5042,
    environment: 'MAINNET_READ_ONLY',
    mutationEnabled: false,
    rpcEnvironment: 'SYNQ_ARC_MAINNET_RPC_URL',
    rpcUrls: [
      'https://rpc.mainnet.arc.io',
      'https://rpc.drpc.mainnet.arc.io',
      'https://rpc.blockdaemon.mainnet.arc.io',
    ],
    explorer: 'https://explorer.arc.io',
    faucet: null,
    nativeSymbol: 'USDC',
    minMaxFeePerGasWei: null,
    cctpDomain: 26,
    confirmations: 1,
  }),
  'eth-sepolia': chain({
    name: 'eth-sepolia',
    chainId: 11155111,
    environment: 'CCTP_TESTNET_ROUTE',
    mutationEnabled: true,
    rpcEnvironment: 'SYNQ_SEPOLIA_RPC_URL',
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
    explorer: 'https://sepolia.etherscan.io',
    faucet: 'https://faucet.circle.com',
    nativeSymbol: 'ETH',
    minMaxFeePerGasWei: null,
    cctpDomain: 0,
    confirmations: 2,
  }),
  'base-sepolia': chain({
    name: 'base-sepolia',
    chainId: 84532,
    environment: 'CCTP_TESTNET_ROUTE',
    mutationEnabled: true,
    rpcEnvironment: 'SYNQ_BASE_SEPOLIA_RPC_URL',
    rpcUrls: ['https://sepolia.base.org'],
    explorer: 'https://sepolia.basescan.org',
    faucet: 'https://faucet.circle.com',
    nativeSymbol: 'ETH',
    minMaxFeePerGasWei: null,
    cctpDomain: 6,
    confirmations: 2,
  }),
  'arb-sepolia': chain({
    name: 'arb-sepolia',
    chainId: 421614,
    environment: 'CCTP_TESTNET_ROUTE',
    mutationEnabled: true,
    rpcEnvironment: 'SYNQ_ARB_SEPOLIA_RPC_URL',
    rpcUrls: ['https://sepolia-rollup.arbitrum.io/rpc'],
    explorer: 'https://sepolia.arbiscan.io',
    faucet: 'https://faucet.circle.com',
    nativeSymbol: 'ETH',
    minMaxFeePerGasWei: null,
    cctpDomain: 3,
    confirmations: 2,
  }),
};

export type TokenSymbol = 'USDC' | 'EURC' | 'USYC';

type TokenEntry = Readonly<{
  chain: ChainName;
  symbol: TokenSymbol;
  address: `0x${string}`;
  decimals: number;
  codeHash: `0x${string}` | null;
  /** USYC is allowlisted for eligible institutions only. */
  permissioned: boolean;
}>;

// Tokens and contracts: sources/arc_registry.json (the only place addresses live).

export type ContractKind =
  | 'CCTP_TOKEN_MESSENGER_V2'
  | 'CCTP_MESSAGE_TRANSMITTER_V2'
  | 'CCTP_TOKEN_MINTER_V2'
  | 'GATEWAY_WALLET'
  | 'GATEWAY_MINTER'
  | 'MEMO'
  | 'MULTICALL3'
  | 'PERMIT2'
  | 'ERC8004_IDENTITY_REGISTRY'
  | 'ERC8183_AGENTIC_COMMERCE'
  | 'SAFE_L2_SINGLETON'
  | 'SAFE_SINGLETON'
  | 'SAFE_PROXY_FACTORY'
  | 'SAFE_FALLBACK_HANDLER'
  | 'SAFE_MULTI_SEND_CALL_ONLY'
  | 'SAFE_SINGLETON_FACTORY'
  | 'SYNQ_ARC_VAULT_FACTORY'
  | 'SYNQ_ARC_VAULT_SETUP'
  | 'SYNQ_ARC_FALLBACK_HANDLER'
  | 'SYNQ_MILESTONE_ESCROW'
  | 'SYNQ_ARC_VAULT_SAFE'
  | 'SYNQ_ARC_VAULT_POLICY'
  | 'USYC_TELLER'
  | 'USYC_ENTITLEMENTS'
  | 'USYC_ORACLE'
  | 'CIRCLE_APP_KIT_ADAPTER'
  | 'CIRCLE_EARN_VAULT_USDC'
  | 'CIRCLE_EARN_VAULT_MOCK_MORPHO'
  | 'ERC4337_ENTRYPOINT_V07'
  | 'ERC4337_ENTRYPOINT_V08'
  | 'CIRCLE_PAYMASTER_V07'
  | 'CIRCLE_PAYMASTER_V08'
  | 'SIMPLE_7702_ACCOUNT';

type ContractEntry = Readonly<{
  chain: ChainName;
  kind: ContractKind;
  address: `0x${string}`;
  codeHash: `0x${string}` | null;
  /** Proxy: the pinned hash covers the proxy, not an upgradable implementation. */
  proxy: boolean;
}>;

const Hash = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/) as unknown as z.ZodType<`0x${string}`>;
const Address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/) as unknown as z.ZodType<`0x${string}`>;
const ChainNameSchema = z.enum([
  'arc-testnet',
  'arc-mainnet',
  'eth-sepolia',
  'base-sepolia',
  'arb-sepolia',
]);
const RegistrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.record(z.string(), z.string()),
  tokens: z.array(
    z.strictObject({
      chain: ChainNameSchema,
      symbol: z.enum(['USDC', 'EURC', 'USYC']),
      address: Address,
      decimals: z.number().int().min(0).max(36),
      codeHash: Hash.nullable(),
      permissioned: z.boolean(),
    }),
  ),
  contracts: z.array(
    z.strictObject({
      chain: ChainNameSchema,
      kind: z.enum([
        'CCTP_TOKEN_MESSENGER_V2',
        'CCTP_MESSAGE_TRANSMITTER_V2',
        'CCTP_TOKEN_MINTER_V2',
        'GATEWAY_WALLET',
        'GATEWAY_MINTER',
        'MEMO',
        'MULTICALL3',
        'PERMIT2',
        'ERC8004_IDENTITY_REGISTRY',
        'ERC8183_AGENTIC_COMMERCE',
        'SAFE_L2_SINGLETON',
        'SAFE_SINGLETON',
        'SAFE_PROXY_FACTORY',
        'SAFE_FALLBACK_HANDLER',
        'SAFE_MULTI_SEND_CALL_ONLY',
        'SAFE_SINGLETON_FACTORY',
        'SYNQ_ARC_VAULT_FACTORY',
        'SYNQ_ARC_VAULT_SETUP',
        'SYNQ_ARC_FALLBACK_HANDLER',
        'SYNQ_MILESTONE_ESCROW',
        'SYNQ_ARC_VAULT_SAFE',
        'SYNQ_ARC_VAULT_POLICY',
        'USYC_TELLER',
        'USYC_ENTITLEMENTS',
        'USYC_ORACLE',
        'CIRCLE_APP_KIT_ADAPTER',
        'CIRCLE_EARN_VAULT_USDC',
        'CIRCLE_EARN_VAULT_MOCK_MORPHO',
        'ERC4337_ENTRYPOINT_V07',
        'ERC4337_ENTRYPOINT_V08',
        'CIRCLE_PAYMASTER_V07',
        'CIRCLE_PAYMASTER_V08',
        'SIMPLE_7702_ACCOUNT',
      ]),
      address: Address,
      codeHash: Hash.nullable(),
      proxy: z.boolean(),
    }),
  ),
});
const REGISTRY = RegistrySchema.parse(rawArc);
for (const t of REGISTRY.tokens)
  if (
    REGISTRY.tokens.filter((x) => x.chain === t.chain && x.symbol === t.symbol)
      .length !== 1
  )
    throw new Error(`arc registry: duplicate ${t.symbol} on ${t.chain}`);
const TOKENS: readonly TokenEntry[] = REGISTRY.tokens;
const CONTRACTS: readonly ContractEntry[] = REGISTRY.contracts;

export class ArcRegistryError extends AmountError {}

export function chainProfile(name: ChainName): ChainProfile {
  const c = (CHAINS as Record<string, ChainProfile | undefined>)[name];
  if (!c) throw new ArcRegistryError('UNKNOWN_CHAIN', String(name));
  return c;
}

export function chainById(chainId: number): ChainProfile {
  const c = Object.values(CHAINS).find((x) => x.chainId === chainId);
  if (!c) throw new ArcRegistryError('UNKNOWN_CHAIN', `chain ${chainId}`);
  return c;
}

function toAsset(t: TokenEntry): AssetRef {
  const c = CHAINS[t.chain];
  const ref = {
    network: c.network,
    address: t.address,
  };
  return Object.freeze({
    assetId: assetKey(ref),
    network: c.network,
    chainId: c.chainId,
    address: t.address,
    symbol: t.symbol,
    canonical: t.symbol,
    decimals: t.decimals,
    environment: c.environment,
  });
}

export function token(chain: ChainName, symbol: TokenSymbol): AssetRef {
  const t = TOKENS.find((x) => x.chain === chain && x.symbol === symbol);
  if (!t) throw new ArcRegistryError('UNKNOWN_ASSET', `${symbol} on ${chain}`);
  return toAsset(t);
}

export function tokenEntry(asset: AssetRef): TokenEntry {
  const t = TOKENS.find(
    (x) =>
      CHAINS[x.chain].chainId === asset.chainId &&
      x.address.toLowerCase() === asset.address.toLowerCase(),
  );
  if (!t) throw new ArcRegistryError('UNKNOWN_ASSET', asset.assetId);
  return t;
}

/** Resolves an on-chain token address; anything not in the registry is refused. */
export function assetByAddress(chainId: number, address: string): AssetRef {
  chainById(chainId);
  const t = TOKENS.find(
    (x) =>
      CHAINS[x.chain].chainId === chainId &&
      x.address.toLowerCase() === address.toLowerCase(),
  );
  if (!t)
    throw new ArcRegistryError('UNKNOWN_ASSET', `${address} on ${chainId}`);
  return toAsset(t);
}

export function contract(chain: ChainName, kind: ContractKind): ContractEntry {
  const c = CONTRACTS.find((x) => x.chain === chain && x.kind === kind);
  if (!c) throw new ArcRegistryError('UNKNOWN_ASSET', `${kind} on ${chain}`);
  return c;
}

/**
 * The only shape in which a model may refer to money: a registry chain name and
 * token symbol. Raw addresses, chain ids or decimals from model output are
 * rejected outright, so an injected or hallucinated token cannot be paid.
 */
export function assetFromModel(input: unknown): AssetRef {
  if (!input || typeof input !== 'object')
    throw new ArcRegistryError(
      'UNKNOWN_ASSET',
      'asset request must be an object',
    );
  const keys = Object.keys(input);
  if (keys.some((k) => k !== 'chain' && k !== 'symbol'))
    throw new ArcRegistryError(
      'UNKNOWN_ASSET',
      'only {chain, symbol} may be named; addresses and decimals come from the registry',
    );
  const { chain: c, symbol } = input as { chain?: unknown; symbol?: unknown };
  if (typeof c !== 'string' || !(c in CHAINS))
    throw new ArcRegistryError('UNKNOWN_CHAIN', String(c));
  if (symbol !== 'USDC' && symbol !== 'EURC')
    throw new ArcRegistryError('UNKNOWN_ASSET', String(symbol));
  return token(c as ChainName, symbol);
}

// Arc USDC: one balance, two interfaces.

const NATIVE_PER_TOKEN_UNIT = 10n ** 12n; // 18 native decimals − 6 ERC-20 decimals

/**
 * Native Arc wei (18 decimals) as ERC-20 USDC units (6 decimals) of the same
 * balance. `dustWei` is the sub-micro-USDC remainder, reported rather than
 * rounded away, so a conversion never invents or loses value silently.
 */
export function arcNativeToUsdc(
  chainName: 'arc-testnet' | 'arc-mainnet',
  wei: bigint,
): { usdc: Money; dustWei: bigint } {
  if (wei < 0n) throw new ArcRegistryError('NEGATIVE_AMOUNT', String(wei));
  return {
    usdc: money(token(chainName, 'USDC'), wei / NATIVE_PER_TOKEN_UNIT),
    dustWei: wei % NATIVE_PER_TOKEN_UNIT,
  };
}

export function usdcToArcNativeWei(m: Money): bigint {
  const c = chainById(m.asset.chainId);
  if (c.nativeSymbol !== 'USDC' || m.asset.symbol !== 'USDC')
    throw new ArcRegistryError(
      'ASSET_MISMATCH',
      'only Arc USDC has a native view',
    );
  tokenEntry(m.asset);
  return m.baseUnits * NATIVE_PER_TOKEN_UNIT;
}

// Legacy migration (Monad era records).

export const LEGACY_CHAINS: Readonly<Record<number, SettlementEnvironment>> = {
  10143: 'LEGACY_MONAD_TESTNET',
  31337: 'LOCAL_SIM',
};

export type LegacyAssetRecord = {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
};

/**
 * A pre-Arc asset record as a versioned `AssetRef`. Monad and local records keep
 * their own network and are labelled legacy; they never become Arc assets.
 * Records from any other chain are rejected with a typed error.
 */
export function migrateLegacyAsset(record: LegacyAssetRecord): AssetRef {
  const environment = LEGACY_CHAINS[record.chainId];
  if (!environment)
    throw new ArcRegistryError(
      'LEGACY_UNSUPPORTED',
      `no migration for chain ${record.chainId}`,
    );
  if (
    !/^0x[0-9a-fA-F]{40}$/.test(record.address) ||
    !Number.isInteger(record.decimals) ||
    record.decimals < 0 ||
    record.decimals > 36
  )
    throw new ArcRegistryError('LEGACY_UNSUPPORTED', 'malformed legacy asset');
  const network = caip2(record.chainId);
  return Object.freeze({
    assetId: assetKey({ network, address: record.address as `0x${string}` }),
    network,
    chainId: record.chainId,
    address: record.address as `0x${string}`,
    symbol: record.symbol,
    canonical: record.symbol,
    decimals: record.decimals,
    environment,
  });
}

/** Legacy `{amount: "123", decimals}` strings become exact base units or a typed error. */
export function migrateLegacyAmount(asset: AssetRef, amount: unknown): Money {
  if (typeof amount !== 'string' || !/^(0|[1-9][0-9]*)$/.test(amount))
    throw new ArcRegistryError(
      'NOT_AN_INTEGER',
      `legacy amount ${String(amount)}`,
    );
  return money(asset, BigInt(amount));
}
