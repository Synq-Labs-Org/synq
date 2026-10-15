import {
  maxUint256,
  pad,
  size,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  CHAINS,
  contract,
  token,
  type ChainName,
} from '@synq/chain-registry/arc';

/**
 * Circle Gateway: a prefunded unified USDC balance, distinct from CCTP.
 *
 * Accounting rules (enforced by `GatewayAccount`):
 * - A deposit moves value out of the source chain's freely spendable USDC the
 *   moment it is submitted. Until Gateway reports it available it sits in a
 *   PENDING bucket that nothing can spend.
 * - Available Gateway value is its own bucket; it is never also counted as the
 *   underlying source-chain USDC.
 * - A spend reserves the amount when the burn intent is signed and releases
 *   the reservation only when the destination mint is reconciled. One intent
 *   (salt) settles once.
 *
 * This package plans, signs typed data shapes and talks to the read/attestation
 * API; the restricted executor submits on-chain transactions.
 */

export const GATEWAY_API_TESTNET = 'https://gateway-api-testnet.circle.com';

export class GatewayError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_CHAIN'
      | 'UNSUPPORTED_SIGNER'
      | 'INSUFFICIENT_AVAILABLE'
      | 'DUPLICATE_SPEND'
      | 'API_ERROR'
      | 'WITHDRAWAL_UNAVAILABLE'
      | 'ACCOUNTING',
    message: string = code,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

/** Signers whose EIP-712 burn intents Gateway accepts for this integration. */
export const SUPPORTED_GATEWAY_SIGNERS = ['EOA'] as const;

export function assertSigner(kind: string) {
  if (!(SUPPORTED_GATEWAY_SIGNERS as readonly string[]).includes(kind))
    throw new GatewayError(
      'UNSUPPORTED_SIGNER',
      `${kind} cannot sign Gateway burn intents here; use a supported EOA signer rather than an operator key`,
    );
}

export function gatewayChain(name: ChainName) {
  const c = CHAINS[name];
  try {
    contract(name, 'GATEWAY_WALLET');
    contract(name, 'GATEWAY_MINTER');
  } catch {
    throw new GatewayError(
      'UNSUPPORTED_CHAIN',
      `${name} has no registered Gateway contracts`,
    );
  }
  if (c.cctpDomain === null) throw new GatewayError('UNSUPPORTED_CHAIN', name);
  return c;
}

const b32 = (a: Address) => pad(a.toLowerCase() as Address);

export type BurnIntent = {
  maxBlockHeight: bigint;
  maxFee: bigint;
  spec: {
    version: number;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: Hex;
    destinationContract: Hex;
    sourceToken: Hex;
    destinationToken: Hex;
    sourceDepositor: Hex;
    destinationRecipient: Hex;
    sourceSigner: Hex;
    destinationCaller: Hex;
    value: bigint;
    salt: Hex;
    hookData: Hex;
  };
};

export function burnIntent(input: {
  source: ChainName;
  destination: ChainName;
  depositor: Address;
  signer: Address;
  recipient: Address;
  value: bigint;
  maxFee: bigint;
  salt: Hex;
}): BurnIntent {
  const src = gatewayChain(input.source);
  const dst = gatewayChain(input.destination);
  if (size(input.salt) !== 32)
    throw new GatewayError('ACCOUNTING', 'salt must be 32 bytes');
  if (input.value <= 0n)
    throw new GatewayError('ACCOUNTING', 'value must be positive');
  return {
    maxBlockHeight: maxUint256,
    maxFee: input.maxFee,
    spec: {
      version: 1,
      sourceDomain: src.cctpDomain!,
      destinationDomain: dst.cctpDomain!,
      sourceContract: b32(contract(input.source, 'GATEWAY_WALLET').address),
      destinationContract: b32(
        contract(input.destination, 'GATEWAY_MINTER').address,
      ),
      sourceToken: b32(token(input.source, 'USDC').address),
      destinationToken: b32(token(input.destination, 'USDC').address),
      sourceDepositor: b32(input.depositor),
      destinationRecipient: b32(input.recipient),
      sourceSigner: b32(input.signer),
      destinationCaller: b32(zeroAddress),
      value: input.value,
      salt: input.salt,
      hookData: '0x',
    },
  };
}

export function burnIntentTypedData(intent: BurnIntent) {
  return {
    domain: { name: 'GatewayWallet', version: '1' },
    types: {
      TransferSpec: [
        { name: 'version', type: 'uint32' },
        { name: 'sourceDomain', type: 'uint32' },
        { name: 'destinationDomain', type: 'uint32' },
        { name: 'sourceContract', type: 'bytes32' },
        { name: 'destinationContract', type: 'bytes32' },
        { name: 'sourceToken', type: 'bytes32' },
        { name: 'destinationToken', type: 'bytes32' },
        { name: 'sourceDepositor', type: 'bytes32' },
        { name: 'destinationRecipient', type: 'bytes32' },
        { name: 'sourceSigner', type: 'bytes32' },
        { name: 'destinationCaller', type: 'bytes32' },
        { name: 'value', type: 'uint256' },
        { name: 'salt', type: 'bytes32' },
        { name: 'hookData', type: 'bytes' },
      ],
      BurnIntent: [
        { name: 'maxBlockHeight', type: 'uint256' },
        { name: 'maxFee', type: 'uint256' },
        { name: 'spec', type: 'TransferSpec' },
      ],
    },
    primaryType: 'BurnIntent' as const,
    message: intent,
  };
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

export async function gatewayBalances(
  sources: { chain: ChainName; depositor: Address }[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ chain: ChainName; available: bigint }[]> {
  const res = await fetchImpl(`${GATEWAY_API_TESTNET}/v1/balances`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json({
      token: 'USDC',
      sources: sources.map((s) => ({
        domain: gatewayChain(s.chain).cctpDomain,
        depositor: s.depositor,
      })),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new GatewayError('API_ERROR', `balances ${res.status}`);
  const body = (await res.json()) as {
    balances?: { domain: number; balance: string }[];
  };
  return sources.map((s) => {
    const hit = body.balances?.find(
      (b) => b.domain === gatewayChain(s.chain).cctpDomain,
    );
    const [whole = '0', frac = ''] = (hit?.balance ?? '0').split('.');
    return {
      chain: s.chain,
      available:
        BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6)),
    };
  });
}

export async function requestTransfer(
  signed: { burnIntent: BurnIntent; signature: Hex }[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ attestation: Hex; signature: Hex }> {
  const res = await fetchImpl(`${GATEWAY_API_TESTNET}/v1/transfer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json(signed),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as {
    attestation?: Hex;
    signature?: Hex;
    message?: string;
  };
  if (!res.ok || !body.attestation || !body.signature)
    throw new GatewayError(
      'API_ERROR',
      `transfer ${res.status}: ${String(body.message ?? '').slice(0, 200)}`,
    );
  return { attestation: body.attestation, signature: body.signature };
}

/** Gateway does not give this integration an instant withdrawal path; disclose, never invent one. */
export function withdrawalRoute(): never {
  throw new GatewayError(
    'WITHDRAWAL_UNAVAILABLE',
    'Returning Gateway funds to the source wallet uses the delayed withdrawal path (initiate, wait the withdrawal delay, complete); it is not automated here. Spend to a destination wallet instead.',
  );
}

/** Per-depositor Gateway buckets; amounts are 6-decimal USDC base units. */
export class GatewayAccount {
  sourceFree: bigint;
  pending = 0n;
  available = 0n;
  reserved = 0n;
  private spent = new Set<string>();

  constructor(sourceFree: bigint) {
    this.sourceFree = sourceFree;
  }

  /** Deposit submitted: leaves source free funds immediately, not yet spendable anywhere. */
  deposit(amount: bigint) {
    if (amount <= 0n || amount > this.sourceFree)
      throw new GatewayError('ACCOUNTING', 'deposit exceeds free source funds');
    this.sourceFree -= amount;
    this.pending += amount;
  }

  /** Gateway reported `total` available: move that much from pending. */
  observeAvailable(total: bigint) {
    const newly = total - this.available - this.reserved;
    if (newly < 0n) return;
    if (newly > this.pending)
      throw new GatewayError(
        'ACCOUNTING',
        'Gateway reports more than was deposited',
      );
    this.pending -= newly;
    this.available += newly;
  }

  /** Signing a burn intent reserves value; each salt can only ever be spent once. */
  reserve(salt: Hex, value: bigint) {
    if (this.spent.has(salt)) throw new GatewayError('DUPLICATE_SPEND', salt);
    if (value > this.available)
      throw new GatewayError(
        'INSUFFICIENT_AVAILABLE',
        `${value} > ${this.available}`,
      );
    this.spent.add(salt);
    this.available -= value;
    this.reserved += value;
  }

  /** Destination mint reconciled: the reservation (value + fee) is consumed. */
  settle(value: bigint) {
    if (value > this.reserved)
      throw new GatewayError('ACCOUNTING', 'settling more than reserved');
    this.reserved -= value;
  }

  /** Spendable now: only the available bucket. Pending and source funds are separate. */
  spendable() {
    return this.available;
  }
}
