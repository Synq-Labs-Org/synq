import {
  chainRegistry,
  contractEntries,
  profileConfiguration,
  type ContractEntry,
} from '@synq/chain-registry';
import type { ProfileName } from '@synq/domain';
import { KuruError } from './errors.js';

export type Address = `0x${string}`;
export const NATIVE_TOKEN: Address = `0x${'0'.repeat(40)}`;
export type KuruToken = {
  symbol: 'USDC' | 'WMON' | 'AUSD' | 'MON';
  address: Address;
  decimals: number;
  native: boolean;
  registryKey: string;
};
export type KuruMarket = {
  pair: string;
  address: Address;
  base: KuruToken;
  quote: KuruToken;
  registryKey: string;
};
export type KuruDeployment = {
  profile: ProfileName;
  chainId: number;
  flowEntrypoint: Address | null;
  flowExecutors: readonly Address[];
  router: Address | null;
  marginAccount: Address | null;
  tokens: Readonly<Record<string, KuruToken>>;
  markets: readonly KuruMarket[];
};

const lower = (a: string) => a.toLowerCase() as Address;
function keyOf(entry: ContractEntry): string {
  const found = Object.entries(chainRegistry.contracts).find(
    ([, c]) => c === entry,
  );
  return found ? found[0] : '';
}
function single(chainId: number, kind: ContractEntry['kind']): Address | null {
  const entries = contractEntries(chainId, kind);
  if (entries.length > 1) throw new KuruError('UNSUPPORTED_NETWORK', kind);
  return entries[0] ? lower(entries[0].address) : null;
}
function token(
  key: string,
  symbol: KuruToken['symbol'],
  chainId: number,
): KuruToken {
  const entry = chainRegistry.assets[key];
  if (!entry || entry.chainId !== chainId || entry.symbol !== symbol)
    throw new KuruError('TOKEN_NOT_ALLOWED', key);
  return {
    symbol,
    address: lower(entry.address),
    decimals: entry.decimals,
    native: false,
    registryKey: key,
  };
}

const TOKEN_KEYS: Record<
  ProfileName,
  readonly [string, KuruToken['symbol']][]
> = {
  'proof/monad-mainnet': [
    ['mainnetUSDC', 'USDC'],
    ['mainnetWMON', 'WMON'],
    ['mainnetAUSD', 'AUSD'],
  ],
  'sandbox/monad-testnet': [['testnetKuruUSDC', 'USDC']],
  'local/anvil': [],
};

/** Kuru addresses for a profile, taken only from sources/chain_registry.json. */
export function kuruDeployment(profile: ProfileName): KuruDeployment {
  const config = profileConfiguration(profile);
  const chainId = config.network.chainId;
  const tokens: Record<string, KuruToken> = {};
  for (const [key, symbol] of TOKEN_KEYS[profile])
    tokens[symbol] = token(key, symbol, chainId);
  const native = config.nativeAsset;
  if (native)
    tokens.MON = {
      symbol: 'MON',
      address: NATIVE_TOKEN,
      decimals: native.decimals,
      native: true,
      registryKey: Object.keys(chainRegistry.nativeAssets).find(
        (k) => chainRegistry.nativeAssets[k]?.chainId === chainId,
      )!,
    };
  const markets = contractEntries(chainId, 'KURU_MARKET').map((entry) => {
    const [base, quote] = entry.pair!.split('-') as [string, string];
    const b = tokens[base];
    const q = tokens[quote];
    if (!b || !q) throw new KuruError('MARKET_MISMATCH', entry.pair);
    return {
      pair: entry.pair!,
      address: lower(entry.address),
      base: b,
      quote: q,
      registryKey: keyOf(entry),
    };
  });
  return {
    profile,
    chainId,
    flowEntrypoint: single(chainId, 'KURU_FLOW_ENTRYPOINT'),
    flowExecutors: contractEntries(chainId, 'KURU_FLOW_EXECUTOR').map((e) =>
      lower(e.address),
    ),
    router: single(chainId, 'KURU_ROUTER'),
    marginAccount: single(chainId, 'KURU_MARGIN_ACCOUNT'),
    tokens,
    markets,
  };
}

export function findToken(
  deployment: KuruDeployment,
  address: string,
): KuruToken | null {
  const a = address.toLowerCase();
  return Object.values(deployment.tokens).find((t) => t.address === a) ?? null;
}
