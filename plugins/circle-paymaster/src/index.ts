import {
  encodePacked,
  isAddressEqual,
  maxUint256,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import {
  chainProfile,
  contract,
  token,
  type ChainName,
  type ContractKind,
} from '@synq/chain-registry/arc';

/**
 * Circle Paymaster: ERC-4337 gas paid in USDC on the chains Circle lists.
 *
 * Scope, from developers.circle.com/paymaster (retrieved 2026-10-16):
 * - v0.7 (EntryPoint v0.7, Circle smart account) on Arbitrum/Base Sepolia;
 * - v0.8 (EntryPoint v0.8, e.g. an EIP-7702 account) on Ethereum, Base and
 *   Arbitrum Sepolia among others. Only the registry chains are enabled here.
 * - Arc is not a Paymaster chain and does not need one: Arc's native gas token
 *   is USDC, so any Arc wallet already pays gas in USDC. Requests for Circle
 *   Paymaster on Arc are refused with that explanation (never "simulated").
 *
 * This module plans and checks; the UserOperation is signed and sent by a
 * script or the executor. Pure apart from the log decoding helpers.
 */

export type PaymasterVersion = '0.7' | '0.8';

export class PaymasterError extends Error {
  constructor(
    readonly code:
      | 'NOT_ON_ARC'
      | 'UNSUPPORTED_CHAIN'
      | 'WRONG_ENTRYPOINT'
      | 'WRONG_PAYMASTER'
      | 'CODE_HASH_MISMATCH'
      | 'PERMIT_TOO_LARGE'
      | 'ACCOUNTING',
    message: string = code,
  ) {
    super(message);
    this.name = 'PaymasterError';
  }
}

const PAYMASTER_KIND: Record<PaymasterVersion, ContractKind> = {
  '0.7': 'CIRCLE_PAYMASTER_V07',
  '0.8': 'CIRCLE_PAYMASTER_V08',
};
const ENTRYPOINT_KIND: Record<PaymasterVersion, ContractKind> = {
  '0.7': 'ERC4337_ENTRYPOINT_V07',
  '0.8': 'ERC4337_ENTRYPOINT_V08',
};

/** Circle's published testnet support, restricted to chains in our registry. */
export const PAYMASTER_SUPPORT: Readonly<
  Record<PaymasterVersion, readonly ChainName[]>
> = {
  '0.7': ['base-sepolia', 'arb-sepolia'],
  '0.8': ['eth-sepolia', 'base-sepolia', 'arb-sepolia'],
};

export const ARC_PAYMASTER_REFUSAL =
  'Circle Paymaster is not deployed on Arc. Arc does not need it: Arc gas is paid in native USDC straight from the wallet’s USDC balance, so send a normal Arc transaction (or use Circle Gas Station for a Circle smart-contract wallet).';

export function paymasterSupported(chain: ChainName, v: PaymasterVersion) {
  return PAYMASTER_SUPPORT[v].includes(chain);
}

/** P16-02: resolves the pinned paymaster + EntryPoint, or refuses. */
export function paymasterFor(chain: ChainName, version: PaymasterVersion) {
  const profile = chainProfile(chain);
  if (profile.nativeSymbol === 'USDC')
    throw new PaymasterError('NOT_ON_ARC', ARC_PAYMASTER_REFUSAL);
  if (!paymasterSupported(chain, version))
    throw new PaymasterError(
      'UNSUPPORTED_CHAIN',
      `Circle Paymaster v${version} is not listed for ${chain}; supported: ${PAYMASTER_SUPPORT[version].join(', ')}`,
    );
  return {
    chain,
    chainId: profile.chainId,
    version,
    paymaster: contract(chain, PAYMASTER_KIND[version]),
    entryPoint: contract(chain, ENTRYPOINT_KIND[version]),
    usdc: token(chain, 'USDC'),
  };
}

export type PaymasterRoute = ReturnType<typeof paymasterFor>;

/**
 * P16-03: the EntryPoint the account/bundler would use must be the pinned
 * one for this paymaster version, the paymaster must report the same
 * EntryPoint on chain, and both code hashes must match the registry.
 */
export function assertEntryPoint(
  route: PaymasterRoute,
  observed: {
    entryPoint: Address;
    paymasterEntryPoint: Address;
    paymasterToken: Address;
    entryPointCodeHash: Hex;
    paymasterCodeHash: Hex;
    bundlerEntryPoints?: readonly Address[];
  },
) {
  const want = route.entryPoint;
  if (!isAddressEqual(observed.entryPoint, want.address))
    throw new PaymasterError(
      'WRONG_ENTRYPOINT',
      `EntryPoint ${observed.entryPoint} is not v${route.version} ${want.address}`,
    );
  if (!isAddressEqual(observed.paymasterEntryPoint, want.address))
    throw new PaymasterError(
      'WRONG_ENTRYPOINT',
      `paymaster is bound to ${observed.paymasterEntryPoint}, not ${want.address}`,
    );
  if (want.codeHash !== observed.entryPointCodeHash)
    throw new PaymasterError('CODE_HASH_MISMATCH', 'EntryPoint bytecode');
  if (route.paymaster.codeHash !== observed.paymasterCodeHash)
    throw new PaymasterError('CODE_HASH_MISMATCH', 'paymaster bytecode');
  if (!isAddressEqual(observed.paymasterToken, route.usdc.address))
    throw new PaymasterError(
      'WRONG_PAYMASTER',
      `paymaster token ${observed.paymasterToken} is not registry USDC`,
    );
  if (
    observed.bundlerEntryPoints &&
    !observed.bundlerEntryPoints.some((e) => isAddressEqual(e, want.address))
  )
    throw new PaymasterError(
      'WRONG_ENTRYPOINT',
      'bundler does not serve this EntryPoint',
    );
  return true;
}

export const PAYMASTER_GAS = {
  verificationGasLimit: 200_000n,
  postOpGasLimit: 35_000n,
} as const;

/**
 * EIP-2612 permit for the paymaster to pull up to `value` USDC. Deadline is
 * `maxUint256` because a paymaster may not read `block.timestamp` during
 * validation; `maxPermit` caps the exposure.
 */
export function paymasterPermitTypedData(input: {
  route: PaymasterRoute;
  owner: Address;
  value: bigint;
  nonce: bigint;
  tokenName: string;
  tokenVersion: string;
  maxPermit: bigint;
}) {
  if (input.value <= 0n || input.value > input.maxPermit)
    throw new PaymasterError(
      'PERMIT_TOO_LARGE',
      `permit ${input.value} outside (0, ${input.maxPermit}]`,
    );
  return {
    domain: {
      name: input.tokenName,
      version: input.tokenVersion,
      chainId: input.route.chainId,
      verifyingContract: input.route.usdc.address,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit' as const,
    message: {
      owner: input.owner,
      spender: input.route.paymaster.address,
      value: input.value,
      nonce: input.nonce,
      deadline: maxUint256,
    },
  };
}

/** Circle's `paymasterData`: mode 0, token, permit amount, permit signature. */
export function encodePaymasterData(input: {
  route: PaymasterRoute;
  permitAmount: bigint;
  permitSignature: Hex;
}): Hex {
  return encodePacked(
    ['uint8', 'address', 'uint256', 'bytes'],
    [0, input.route.usdc.address, input.permitAmount, input.permitSignature],
  );
}

export const USER_OPERATION_EVENT_ABI = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
]);
const TRANSFER_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
/**
 * Circle documents the fields but not which are indexed; the deployed
 * TokenPaymaster indexes `token` and `sender` (checked against the live
 * receipt in scripts/paymaster-userop-proof.ts).
 */
export const USER_OPERATION_SPONSORED_ABI = parseAbi([
  'event UserOperationSponsored(address indexed token, address indexed sender, bytes32 userOpHash, uint256 nativeTokenPrice, uint256 actualTokenNeeded, uint256 feeTokenAmount)',
]);

export type UserOpAccounting = Readonly<{
  userOpHash: Hex;
  success: boolean;
  /** Native wei the EntryPoint charged the paymaster (paid by the bundler). */
  actualGasCostWei: bigint;
  /** USDC moved sender -> recipient: the payment itself. */
  transferAmount: bigint;
  /** Net USDC the paymaster kept from the sender: the gas fee, in USDC. */
  paymasterFee: bigint;
  /** USDC the paymaster pulled under the permit, before any refund. */
  paymasterPulled: bigint;
  paymasterRefunded: bigint;
  sponsored: {
    actualTokenNeeded: bigint;
    feeTokenAmount: bigint;
    nativeTokenPrice: bigint;
  } | null;
}>;

/**
 * P16-04: separates the paymaster's USDC fee from the transfer amount using
 * only receipt logs: USDC `Transfer`s sender->paymaster minus refunds, and the
 * EntryPoint's `UserOperationEvent`. If Circle's `UserOperationSponsored` is
 * present its `actualTokenNeeded` must equal the net fee.
 */
export function accountUserOp(input: {
  route: PaymasterRoute;
  logs: readonly Log[];
  sender: Address;
  recipient: Address;
  userOpHash: Hex;
}): UserOpAccounting {
  const { route, sender, recipient } = input;
  const usdc = route.usdc.address;
  const pm = route.paymaster.address;
  const ops = parseEventLogs({
    abi: USER_OPERATION_EVENT_ABI,
    logs: input.logs as Log[],
    strict: true,
  }).filter(
    (l) =>
      isAddressEqual(l.address, route.entryPoint.address) &&
      l.args.userOpHash === input.userOpHash,
  );
  if (ops.length !== 1)
    throw new PaymasterError(
      'ACCOUNTING',
      `expected one UserOperationEvent, found ${ops.length}`,
    );
  const op = ops[0]!;
  if (
    !isAddressEqual(op.args.sender, sender) ||
    !isAddressEqual(op.args.paymaster, pm)
  )
    throw new PaymasterError('ACCOUNTING', 'sender/paymaster mismatch');
  const transfers = parseEventLogs({
    abi: TRANSFER_ABI,
    logs: input.logs as Log[],
    strict: true,
  }).filter((l) => isAddressEqual(l.address, usdc));
  const sum = (from: Address, to: Address) =>
    transfers
      .filter(
        (t) =>
          isAddressEqual(t.args.from, from) && isAddressEqual(t.args.to, to),
      )
      .reduce((a, t) => a + t.args.value, 0n);
  const pulled = sum(sender, pm);
  const refunded = sum(pm, sender);
  const transferAmount = sum(sender, recipient);
  if (refunded > pulled)
    throw new PaymasterError('ACCOUNTING', 'refund exceeds prefund');
  let sponsored: UserOpAccounting['sponsored'] = null;
  try {
    const ev = parseEventLogs({
      abi: USER_OPERATION_SPONSORED_ABI,
      logs: input.logs as Log[],
      strict: true,
    }).filter((l) => isAddressEqual(l.address, pm));
    if (ev.length === 1)
      sponsored = {
        actualTokenNeeded: ev[0]!.args.actualTokenNeeded,
        feeTokenAmount: ev[0]!.args.feeTokenAmount,
        nativeTokenPrice: ev[0]!.args.nativeTokenPrice,
      };
  } catch {
    sponsored = null;
  }
  const paymasterFee = pulled - refunded;
  if (sponsored && sponsored.actualTokenNeeded !== paymasterFee)
    throw new PaymasterError(
      'ACCOUNTING',
      `event says ${sponsored.actualTokenNeeded}, transfers say ${paymasterFee}`,
    );
  return Object.freeze({
    userOpHash: input.userOpHash,
    success: op.args.success,
    actualGasCostWei: op.args.actualGasCost,
    transferAmount,
    paymasterFee,
    paymasterPulled: pulled,
    paymasterRefunded: refunded,
    sponsored,
  });
}
