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

const TOKENS: readonly TokenEntry[] = [
  {
    chain: 'arc-testnet',
    symbol: 'USDC',
    address: '0x3600000000000000000000000000000000000000',
    decimals: 6,
    codeHash:
      '0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d',
    permissioned: false,
  },
  {
    chain: 'arc-testnet',
    symbol: 'EURC',
    address: '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
    decimals: 6,
    codeHash:
      '0x35bca78fda57cc45ed6ac8b61e4911e0a7fe1e89c05b9f187d3a8705e94013a2',
    permissioned: false,
  },
  {
    chain: 'arc-testnet',
    symbol: 'USYC',
    address: '0xe9185F0c5F296Ed1797AaE4238D26CCaBEadb86C',
    decimals: 6,
    codeHash: null,
    permissioned: true,
  },
  {
    chain: 'arc-mainnet',
    symbol: 'USDC',
    address: '0x3600000000000000000000000000000000000000',
    decimals: 6,
    codeHash: null,
    permissioned: false,
  },
  {
    chain: 'arc-mainnet',
    symbol: 'EURC',
    address: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
    decimals: 6,
    codeHash: null,
    permissioned: false,
  },
  {
    chain: 'arc-mainnet',
    symbol: 'USYC',
    address: '0x8a5D989Bbb96929F689B0200f435f53dA42bF490',
    decimals: 6,
    codeHash: null,
    permissioned: true,
  },
  {
    chain: 'eth-sepolia',
    symbol: 'USDC',
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
    codeHash:
      '0xcd3f29e2ea9c61dadd48bfeaf8b2884b6de9dfee7bf45329452c4c33d0868ceb',
    permissioned: false,
  },
  {
    chain: 'base-sepolia',
    symbol: 'USDC',
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
    codeHash:
      '0xedc5281a85c0efecd49999a1ef668390c59b88702f2d4a07029d7f5d63059d6c',
    permissioned: false,
  },
  {
    chain: 'arb-sepolia',
    symbol: 'USDC',
    address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
    decimals: 6,
    codeHash: null,
    permissioned: false,
  },
];

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
  | 'ERC8183_AGENTIC_COMMERCE';

type ContractEntry = Readonly<{
  chain: ChainName;
  kind: ContractKind;
  address: `0x${string}`;
  codeHash: `0x${string}` | null;
  /** Proxy: the pinned hash covers the proxy, not an upgradable implementation. */
  proxy: boolean;
}>;

const CCTP_PROXY =
  '0xd2c8d48075d832fb7d07f6db5545a1bee37fdf886325c441a8dd1cef4c9dae99' as const;
const GATEWAY_PROXY =
  '0x874a21508289bf01ee9802032607ae53ba0a4f47f28143a8493921b8db102187' as const;
const cctpAndGateway = (c: ChainName, gateway: boolean): ContractEntry[] => [
  {
    chain: c,
    kind: 'CCTP_TOKEN_MESSENGER_V2',
    address: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    codeHash: CCTP_PROXY,
    proxy: true,
  },
  {
    chain: c,
    kind: 'CCTP_MESSAGE_TRANSMITTER_V2',
    address: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
    codeHash: CCTP_PROXY,
    proxy: true,
  },
  ...(gateway
    ? [
        {
          chain: c,
          kind: 'GATEWAY_WALLET',
          address: '0x0077777d7EBA4688BDeF3E311b846F25870A19B9',
          codeHash: GATEWAY_PROXY,
          proxy: true,
        } as const,
        {
          chain: c,
          kind: 'GATEWAY_MINTER',
          address: '0x0022222ABE238Cc2C7Bb1f21003F0a260052475B',
          codeHash: GATEWAY_PROXY,
          proxy: true,
        } as const,
      ]
    : []),
];

const CONTRACTS: readonly ContractEntry[] = [
  ...cctpAndGateway('arc-testnet', true),
  {
    chain: 'arc-testnet',
    kind: 'CCTP_TOKEN_MINTER_V2',
    address: '0xb43db544E2c27092c107639Ad201b3dEfAbcF192',
    codeHash:
      '0xfc330d52b7656b971ef47bbb8cd44877181fbc9ac0fe76cb4cb5bb364a992eff',
    proxy: false,
  },
  {
    chain: 'arc-testnet',
    kind: 'MEMO',
    address: '0x5294E9927c3306DcBaDb03fe70b92e01cCede505',
    codeHash:
      '0x3e5d663b3c99d70c9ff00d597ae68ce2f2e2843b2d39adae5eb78d8eb6877b95',
    proxy: false,
  },
  {
    chain: 'arc-testnet',
    kind: 'MULTICALL3',
    address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    codeHash:
      '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
    proxy: false,
  },
  {
    chain: 'arc-testnet',
    kind: 'PERMIT2',
    address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    codeHash:
      '0x53681d3cf8f702f849c1504b491049c3d0a282e4595d9b297c410dcf36f0908e',
    proxy: false,
  },
  {
    chain: 'arc-testnet',
    kind: 'ERC8004_IDENTITY_REGISTRY',
    address: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    codeHash:
      '0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41',
    proxy: true,
  },
  {
    chain: 'arc-testnet',
    kind: 'ERC8183_AGENTIC_COMMERCE',
    address: '0x0747EEf0706327138c69792bF28Cd525089e4583',
    codeHash:
      '0x6fbb70f32c57790a7bc472b3fd6adb3bc22e911239f1a86f77898e69f62d5d13',
    proxy: true,
  },
  ...cctpAndGateway('eth-sepolia', true),
  ...cctpAndGateway('base-sepolia', false),
];

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
