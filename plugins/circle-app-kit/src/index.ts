import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  parseAbi,
  slice,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { contract } from '@synq/chain-registry/arc';

/**
 * Circle App Kit (Swap, Earn) on Arc testnet: what the kit asks a wallet to
 * sign, checked before anything is signed.
 *
 * The kits fetch a Circle-signed `ExecutionParams` bundle from Circle's
 * service and submit `Adapter.execute(params, tokenInputs, signature)`, after
 * an ERC-20 allowance to that Adapter. The kit itself is not trusted with the
 * key: the signing script hands it a wallet whose every request passes through
 * a `KitTxGuard`. The guard knows the plan the owner approved (amount, assets,
 * recipient, minimum output) and refuses any transaction whose target,
 * selector, spender, beneficiary, amount or minimum output differs, and any
 * typed-data or message signature (the plan uses on-chain approvals only).
 *
 * Pure: no I/O, no keys. Signing stays in scripts and the executor.
 */

export const ADAPTER_EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    outputs: [],
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          {
            name: 'instructions',
            type: 'tuple[]',
            components: [
              { name: 'target', type: 'address' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
              { name: 'tokenIn', type: 'address' },
              { name: 'amountToApprove', type: 'uint256' },
              { name: 'tokenOut', type: 'address' },
              { name: 'minTokenOut', type: 'uint256' },
            ],
          },
          {
            name: 'tokens',
            type: 'tuple[]',
            components: [
              { name: 'token', type: 'address' },
              { name: 'beneficiary', type: 'address' },
            ],
          },
          { name: 'execId', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'metadata', type: 'bytes' },
        ],
      },
      {
        name: 'tokenInputs',
        type: 'tuple[]',
        components: [
          { name: 'permitType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'permitCalldata', type: 'bytes' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const;

const ALLOWANCE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function increaseAllowance(address spender, uint256 addedValue) returns (bool)',
]);
export const SELECTORS = {
  approve: '0x095ea7b3',
  increaseAllowance: '0x39509351',
} as const;
export const EXECUTE_SELECTOR = toFunctionSelector(ADAPTER_EXECUTE_ABI[0]);

export class KitTxGuardError extends Error {
  constructor(
    readonly code:
      | 'FROM_MISMATCH'
      | 'TARGET_NOT_ALLOWED'
      | 'SELECTOR_NOT_ALLOWED'
      | 'SPENDER_MISMATCH'
      | 'APPROVAL_EXCEEDS_PLAN'
      | 'RECIPIENT_MISMATCH'
      | 'TOKEN_NOT_ALLOWED'
      | 'AMOUNT_EXCEEDS_PLAN'
      | 'MIN_OUT_BELOW_FLOOR'
      | 'VALUE_NOT_ZERO'
      | 'DEADLINE_OUT_OF_RANGE'
      | 'UNEXPECTED_STEP'
      | 'SIGNATURE_REFUSED'
      | 'MALFORMED',
    message: string = code,
  ) {
    super(message);
    this.name = 'KitTxGuardError';
  }
}

/** The Circle App Kit Adapter on Arc testnet (registry-pinned). */
export function appKitAdapter(): Address {
  return contract('arc-testnet', 'CIRCLE_APP_KIT_ADAPTER').address;
}

export type KitTx = Readonly<{
  from: Address;
  to: Address | null | undefined;
  data: Hex | undefined;
  value?: bigint;
}>;

export type DecodedExecute = Readonly<{
  instructions: readonly {
    target: Address;
    data: Hex;
    value: bigint;
    tokenIn: Address;
    amountToApprove: bigint;
    tokenOut: Address;
    minTokenOut: bigint;
  }[];
  tokens: readonly { token: Address; beneficiary: Address }[];
  execId: bigint;
  deadline: bigint;
  tokenInputs: readonly {
    permitType: number;
    token: Address;
    amount: bigint;
    permitCalldata: Hex;
  }[];
}>;

export function decodeAdapterExecute(data: Hex): DecodedExecute {
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: ADAPTER_EXECUTE_ABI, data });
  } catch {
    throw new KitTxGuardError(
      'SELECTOR_NOT_ALLOWED',
      'not an Adapter.execute call',
    );
  }
  const [params, tokenInputs] = decoded.args;
  return {
    instructions: params.instructions,
    tokens: params.tokens,
    execId: params.execId,
    deadline: params.deadline,
    tokenInputs,
  };
}

/** One step the owner's plan allows, in order. */
export type KitStep =
  | Readonly<{
      kind: 'ALLOWANCE';
      /** ERC-20 being approved (USDC for a swap/deposit, vault shares for a withdrawal). */
      token: Address;
      spender: Address;
      /** The kit may round up by a few base units; never more than this. */
      maxAmount: bigint;
      /** True when an existing allowance means the kit may skip this step. */
      optional: boolean;
    }>
  | Readonly<{
      kind: 'EXECUTE';
      adapter: Address;
      /** Every output token must be paid to this address and nobody else. */
      beneficiary: Address;
      tokenIn: Address;
      maxAmountIn: bigint;
      tokenOut: Address;
      /** Sum of `minTokenOut` for `tokenOut` must be at least this. */
      minOut: bigint;
      /**
       * Circle fee instructions (tokenIn -> no output, e.g. "SWAP_CPF") may
       * take at most this much of `tokenIn` in total; 0 means no fee allowed.
       */
      maxFeeIn: bigint;
      /** Tokens that may appear in `tokens[]` (residual refunds included). */
      allowedTokens: readonly Address[];
      nowSec: bigint;
      maxDeadlineAheadSec: bigint;
    }>;

const lower = (a: Address) => a.toLowerCase();

export function verifyAllowance(
  tx: KitTx,
  step: Extract<KitStep, { kind: 'ALLOWANCE' }>,
) {
  if (!tx.to || !isAddressEqual(tx.to, step.token))
    throw new KitTxGuardError(
      'TARGET_NOT_ALLOWED',
      `allowance must target ${step.token}, got ${tx.to}`,
    );
  if ((tx.value ?? 0n) !== 0n) throw new KitTxGuardError('VALUE_NOT_ZERO');
  const data = tx.data ?? '0x';
  const selector = data.length >= 10 ? slice(data, 0, 4) : '0x';
  if (
    selector !== SELECTORS.approve &&
    selector !== SELECTORS.increaseAllowance
  )
    throw new KitTxGuardError(
      'SELECTOR_NOT_ALLOWED',
      `allowance selector ${selector}`,
    );
  const { args } = decodeFunctionData({
    abi: selector === SELECTORS.approve ? erc20Abi : ALLOWANCE_ABI,
    data,
  }) as { args: readonly [Address, bigint] };
  const [spender, amount] = args;
  if (!isAddressEqual(spender, step.spender))
    throw new KitTxGuardError(
      'SPENDER_MISMATCH',
      `spender ${spender} is not ${step.spender}`,
    );
  if (amount > step.maxAmount)
    throw new KitTxGuardError(
      'APPROVAL_EXCEEDS_PLAN',
      `${amount} > ${step.maxAmount}`,
    );
  return { spender: getAddress(spender), amount };
}

export function verifyExecute(
  tx: KitTx,
  step: Extract<KitStep, { kind: 'EXECUTE' }>,
) {
  if (!tx.to || !isAddressEqual(tx.to, step.adapter))
    throw new KitTxGuardError(
      'TARGET_NOT_ALLOWED',
      `execute must target the pinned Adapter ${step.adapter}, got ${tx.to}`,
    );
  if ((tx.value ?? 0n) !== 0n) throw new KitTxGuardError('VALUE_NOT_ZERO');
  const d = decodeAdapterExecute(tx.data ?? '0x');
  const allowed = new Set(step.allowedTokens.map(lower));
  if (d.tokens.length === 0)
    throw new KitTxGuardError('RECIPIENT_MISMATCH', 'no output recipient');
  for (const t of d.tokens) {
    if (!isAddressEqual(t.beneficiary, step.beneficiary))
      throw new KitTxGuardError(
        'RECIPIENT_MISMATCH',
        `${t.token} would be paid to ${t.beneficiary}, not ${step.beneficiary}`,
      );
    if (!allowed.has(lower(t.token)))
      throw new KitTxGuardError('TOKEN_NOT_ALLOWED', t.token);
  }
  if (!d.tokens.some((t) => isAddressEqual(t.token, step.tokenOut)))
    throw new KitTxGuardError(
      'RECIPIENT_MISMATCH',
      `${step.tokenOut} has no beneficiary`,
    );
  let pulled = 0n;
  for (const i of d.tokenInputs) {
    if (!isAddressEqual(i.token, step.tokenIn))
      throw new KitTxGuardError('TOKEN_NOT_ALLOWED', `input ${i.token}`);
    pulled += i.amount;
  }
  if (pulled > step.maxAmountIn)
    throw new KitTxGuardError(
      'AMOUNT_EXCEEDS_PLAN',
      `pulls ${pulled} > ${step.maxAmountIn}`,
    );
  let minOut = 0n;
  let feeIn = 0n;
  let approvedTotal = 0n;
  for (const ins of d.instructions) {
    if (ins.value !== 0n) throw new KitTxGuardError('VALUE_NOT_ZERO');
    approvedTotal += ins.amountToApprove;
    if (isAddressEqual(ins.tokenOut, zeroAddress)) {
      // A fee instruction: spends tokenIn, produces nothing, promises nothing.
      if (!isAddressEqual(ins.tokenIn, step.tokenIn) || ins.minTokenOut !== 0n)
        throw new KitTxGuardError(
          'TOKEN_NOT_ALLOWED',
          `fee instruction ${ins.tokenIn} -> ${ins.tokenOut}`,
        );
      feeIn += ins.amountToApprove;
      continue;
    }
    if (!allowed.has(lower(ins.tokenIn)) || !allowed.has(lower(ins.tokenOut)))
      throw new KitTxGuardError(
        'TOKEN_NOT_ALLOWED',
        `${ins.tokenIn} -> ${ins.tokenOut}`,
      );
    if (isAddressEqual(ins.tokenOut, step.tokenOut)) minOut += ins.minTokenOut;
  }
  if (feeIn > step.maxFeeIn)
    throw new KitTxGuardError(
      'AMOUNT_EXCEEDS_PLAN',
      `fee instructions take ${feeIn} > ${step.maxFeeIn}`,
    );
  if (approvedTotal > step.maxAmountIn)
    throw new KitTxGuardError(
      'AMOUNT_EXCEEDS_PLAN',
      `instructions approve ${approvedTotal} > ${step.maxAmountIn}`,
    );
  if (minOut < step.minOut)
    throw new KitTxGuardError(
      'MIN_OUT_BELOW_FLOOR',
      `minTokenOut ${minOut} < plan floor ${step.minOut}`,
    );
  if (
    d.deadline <= step.nowSec ||
    d.deadline > step.nowSec + step.maxDeadlineAheadSec
  )
    throw new KitTxGuardError('DEADLINE_OUT_OF_RANGE', String(d.deadline));
  return {
    execId: d.execId,
    deadline: d.deadline,
    minOut,
    pulled,
    feeIn,
    instructionTargets: d.instructions.map((i) => getAddress(i.target)),
  };
}

export type GuardRecord = Readonly<{
  step: KitStep['kind'];
  to: Address;
  selector: Hex;
  detail: Record<string, string>;
}>;

/**
 * An ordered plan of allowed transactions. `check` must be called with every
 * transaction before it is signed; it throws on any deviation and on any
 * request beyond the plan. `assertComplete` proves the execute step happened.
 */
export class KitTxGuard {
  private cursor = 0;
  readonly records: GuardRecord[] = [];
  constructor(
    readonly from: Address,
    private readonly steps: readonly KitStep[],
  ) {
    if (!steps.some((s) => s.kind === 'EXECUTE'))
      throw new KitTxGuardError('MALFORMED', 'plan has no execute step');
  }

  check(tx: KitTx): GuardRecord {
    if (!isAddressEqual(tx.from, this.from))
      throw new KitTxGuardError('FROM_MISMATCH', `${tx.from}`);
    while (this.cursor < this.steps.length) {
      const step = this.steps[this.cursor]!;
      try {
        const record = this.verify(tx, step);
        this.cursor++;
        this.records.push(record);
        return record;
      } catch (error) {
        // Only an optional allowance may be skipped, and only by a tx that
        // matches the step after it.
        if (
          step.kind === 'ALLOWANCE' &&
          step.optional &&
          error instanceof KitTxGuardError &&
          error.code === 'TARGET_NOT_ALLOWED'
        ) {
          this.cursor++;
          continue;
        }
        throw error;
      }
    }
    throw new KitTxGuardError(
      'UNEXPECTED_STEP',
      `transaction to ${tx.to} is beyond the approved plan`,
    );
  }

  /** Typed data and messages are never signed for a kit plan. */
  refuseSignature(kind: string): never {
    throw new KitTxGuardError(
      'SIGNATURE_REFUSED',
      `${kind} signatures are not part of the approved plan (on-chain approvals only)`,
    );
  }

  assertComplete() {
    if (!this.records.some((r) => r.step === 'EXECUTE'))
      throw new KitTxGuardError('UNEXPECTED_STEP', 'execute never ran');
  }

  private verify(tx: KitTx, step: KitStep): GuardRecord {
    const to = getAddress(tx.to ?? zeroAddress);
    const selector =
      tx.data && tx.data.length >= 10 ? slice(tx.data, 0, 4) : '0x';
    if (step.kind === 'ALLOWANCE') {
      const r = verifyAllowance(tx, step);
      return {
        step: 'ALLOWANCE',
        to,
        selector,
        detail: { spender: r.spender, amount: String(r.amount) },
      };
    }
    const r = verifyExecute(tx, step);
    return {
      step: 'EXECUTE',
      to,
      selector,
      detail: {
        execId: String(r.execId),
        deadline: String(r.deadline),
        minOut: String(r.minOut),
        pulled: String(r.pulled),
        feeIn: String(r.feeIn),
        instructionTargets: r.instructionTargets.join(','),
      },
    };
  }
}

/** Integer base units from a kit decimal string ("0.023206"), never via floats. */
export function kitDecimalToUnits(value: string, decimals: number): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
    throw new KitTxGuardError('MALFORMED', `not a decimal amount: ${value}`);
  const [whole, frac = ''] = value.split('.') as [string, string?];
  if (frac.length > decimals)
    throw new KitTxGuardError(
      'MALFORMED',
      `${value} has more than ${decimals} decimals`,
    );
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(frac.padEnd(decimals, '0') || '0')
  );
}

export function unitsToKitDecimal(units: bigint, decimals: number): string {
  if (units < 0n) throw new KitTxGuardError('MALFORMED', 'negative amount');
  const base = 10n ** BigInt(decimals);
  const frac = (units % base)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '');
  return frac ? `${units / base}.${frac}` : String(units / base);
}
