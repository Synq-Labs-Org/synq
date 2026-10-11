import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  type Hex,
} from 'viem';
import { KuruError } from './errors.js';
import type { Address } from './deployment.js';

/**
 * KuruFlowEntrypoint swap selectors observed in the deployed bytecode and in live quote calldata (2026-10-10).
 * The entrypoint is not source-verified, so parameter meaning is inferred from live calldata: the output goes to
 * msg.sender (there is no recipient argument), `executor` is a constant routing contract, the first three
 * `reserved` words were always zero and the fourth was 0 (AUSD->WMON, USDC->WMON) or 1 (AUSD->USDC), and the
 * variant selector appends a referrer. Verification accepts only these observed values.
 */
export const FLOW_SWAP_SELECTOR = '0xce1e7030';
export const FLOW_SWAP_WITH_REFERRER_SELECTOR = '0x31343b21';
const BASE_PARAMS = [
  { type: 'address', name: 'tokenOut' },
  { type: 'uint256', name: 'minAmountOut' },
  { type: 'address', name: 'tokenIn' },
  { type: 'uint256', name: 'amountIn' },
  { type: 'uint256', name: 'executor' },
  { type: 'uint256', name: 'reserved0' },
  { type: 'uint256', name: 'reserved1' },
  { type: 'uint256', name: 'reserved2' },
  { type: 'uint256', name: 'reserved3' },
  { type: 'bytes', name: 'route' },
] as const;
const REFERRER_PARAMS = [
  ...BASE_PARAMS,
  { type: 'address', name: 'referrer' },
] as const;

export type FlowSwapCall = {
  selector: typeof FLOW_SWAP_SELECTOR | typeof FLOW_SWAP_WITH_REFERRER_SELECTOR;
  tokenOut: Address;
  minAmountOut: bigint;
  tokenIn: Address;
  amountIn: bigint;
  executor: Address;
  reserved: readonly [bigint, bigint, bigint, bigint];
  route: Hex;
  referrer: Address | null;
};

const ADDRESS_LIMIT = 1n << 160n;
function toAddress(word: bigint): Address {
  if (word >= ADDRESS_LIMIT)
    throw new KuruError('CALLDATA_UNKNOWN', 'executor word is not an address');
  return `0x${word.toString(16).padStart(40, '0')}` as Address;
}

export function decodeFlowSwap(data: Hex): FlowSwapCall {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10 || data.length % 2)
    throw new KuruError('CALLDATA_UNKNOWN', 'not hex calldata');
  const selector = data.slice(0, 10).toLowerCase();
  const body = `0x${data.slice(10)}` as Hex;
  try {
    if (selector === FLOW_SWAP_SELECTOR) {
      const v = decodeAbiParameters(BASE_PARAMS, body);
      if (encodeAbiParameters(BASE_PARAMS, v) !== body.toLowerCase())
        throw new KuruError('CALLDATA_UNKNOWN', 'non-canonical encoding');
      return {
        selector,
        tokenOut: v[0].toLowerCase() as Address,
        minAmountOut: v[1],
        tokenIn: v[2].toLowerCase() as Address,
        amountIn: v[3],
        executor: toAddress(v[4]),
        reserved: [v[5], v[6], v[7], v[8]],
        route: v[9],
        referrer: null,
      };
    }
    if (selector === FLOW_SWAP_WITH_REFERRER_SELECTOR) {
      const v = decodeAbiParameters(REFERRER_PARAMS, body);
      if (encodeAbiParameters(REFERRER_PARAMS, v) !== body.toLowerCase())
        throw new KuruError('CALLDATA_UNKNOWN', 'non-canonical encoding');
      return {
        selector,
        tokenOut: v[0].toLowerCase() as Address,
        minAmountOut: v[1],
        tokenIn: v[2].toLowerCase() as Address,
        amountIn: v[3],
        executor: toAddress(v[4]),
        reserved: [v[5], v[6], v[7], v[8]],
        route: v[9],
        referrer: v[10].toLowerCase() as Address,
      };
    }
  } catch (error) {
    if (error instanceof KuruError) throw error;
    throw new KuruError('CALLDATA_UNKNOWN', 'undecodable Flow calldata');
  }
  throw new KuruError('CALLDATA_UNKNOWN', `selector ${selector}`);
}

export function encodeFlowSwap(
  call: Omit<FlowSwapCall, 'selector' | 'referrer'>,
): Hex {
  const body = encodeAbiParameters(BASE_PARAMS, [
    getAddress(call.tokenOut),
    call.minAmountOut,
    getAddress(call.tokenIn),
    call.amountIn,
    BigInt(call.executor),
    ...call.reserved,
    call.route,
  ]);
  return `${FLOW_SWAP_SELECTOR}${body.slice(2)}` as Hex;
}
