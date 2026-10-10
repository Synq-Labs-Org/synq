import {
  monadMainnetProfile,
  monadTestnetProfile,
  officialAssets,
} from '@synq/chain-registry';
import { tokenRefOf, type FundingRequestInput } from '@synq/funding';
import type { IntentsToken } from '@synq/plugin-aurora';

export const MAINNET = monadMainnetProfile.network.chainId;
export const TESTNET = monadTestnetProfile.network.chainId;
export const SAFE = `0x${'a8'.repeat(20)}` as const;
export const MEMBER = `0x${'4d'.repeat(20)}` as const;
export const BASE_USDC = `0x${'83'.repeat(20)}` as const;
export const NOW = 1_800_000_000;

export function request(
  overrides: Partial<FundingRequestInput> & {
    sourceToken?: FundingRequestInput['source']['token'];
    amount?: string;
    destinationChainId?: number;
  } = {},
): FundingRequestInput {
  const { sourceToken, amount, destinationChainId, ...rest } = overrides;
  const destChain = destinationChainId ?? MAINNET;
  const ausd =
    destChain === MAINNET
      ? officialAssets.mainnetAUSD
      : officialAssets.testnetAUSD;
  return {
    requestId: 'req-funding-0001',
    groupId: 'group-1',
    destination: {
      chainId: destChain,
      account: SAFE,
      token: tokenRefOf(ausd),
    },
    source: {
      token: sourceToken ?? {
        chainId: 8453,
        address: BASE_USDC,
        symbol: 'USDC',
        decimals: 6,
      },
      amount: amount ?? '5000000',
      sender: MEMBER,
      refundTo: MEMBER,
    },
    maxSlippageBps: 50,
    now: NOW,
    ...rest,
  };
}

/** Shape of the live 1Click token list (captured 2026-10-10): Monad lists MON, USDC, USDT0; no AUSD. */
export function liveLikeTokens(): IntentsToken[] {
  return [
    {
      assetId: 'nep141:base-usdc.omft.near',
      decimals: 6,
      blockchain: 'base',
      symbol: 'USDC',
      contractAddress: BASE_USDC,
    },
    {
      assetId: 'nep245:v2_1.omni.hot.tg:143_usdc',
      decimals: 6,
      blockchain: 'monad',
      symbol: 'USDC',
      contractAddress: officialAssets.mainnetUSDC.address.toLowerCase(),
    },
    {
      assetId: 'nep245:v2_1.omni.hot.tg:143_mon',
      decimals: 18,
      blockchain: 'monad',
      symbol: 'MON',
    },
  ];
}

type Handler = (url: string, init: RequestInit) => unknown;
export function fakeFetch(handlers: Record<string, Handler>) {
  const calls: { url: string; body: unknown }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const key = Object.keys(handlers).find((k) => url.includes(k));
    if (!key) return new Response('{"message":"not found"}', { status: 404 });
    const out = handlers[key]!(url, init ?? {});
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** Echo-style quote responder mirroring the live dry 1Click response shape. */
export function quoteResponder(
  patch: {
    amountOut?: string;
    minAmountOut?: string;
    recipient?: string;
    destinationAsset?: string;
  } = {},
) {
  return (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    return {
      quote: {
        amountIn: body.amount,
        amountInFormatted: '5.0',
        minAmountIn: body.amount,
        amountOut: patch.amountOut ?? '4988795',
        minAmountOut: patch.minAmountOut ?? '4963851',
        timeEstimate: 37,
        refundFee: '2400',
        withdrawFee: '666',
      },
      quoteRequest: {
        ...body,
        recipient: patch.recipient ?? body.recipient,
        destinationAsset: patch.destinationAsset ?? body.destinationAsset,
        appFees: [{ recipient: 'x', fee: 20 }],
      },
      signature: 'ed25519:test',
      timestamp: '2026-10-10T15:02:50.112Z',
      correlationId: 'corr-1',
    };
  };
}
