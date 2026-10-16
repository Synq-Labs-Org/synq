import { readFileSync } from 'node:fs';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  keccak256,
  parseTransaction,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal } from '@synq/domain';
import { contract, token } from '@synq/chain-registry/arc';
import {
  MemoryNonceFence,
  mandateTypedData,
  type AuthorityConfig,
} from '@synq/kernel/arc';
import {
  Ledger,
  MemoryLedgerStore,
  walletTag,
  type JournalEntry,
} from '@synq/ledger';
import {
  vendorDirectory,
  type Vendor,
  type VendorInvoice,
} from '@synq/payables';
import {
  SplitRunner,
  isoDay,
  openPayables,
  mandateFromPolicy,
  parsePolicy,
  policyTypedData,
  receiptKey,
  type CashPosition,
  type FinalReceipt,
  type Receivable,
  type RecurringBill,
  type RevenuePolicy,
  type RunnerDeps,
  type SignedRevenuePolicy,
  type WorkspaceRegistry,
  type SplitStore,
  type TreasuryBooks,
} from '@synq/allocations';
import { connectChain } from '@synq/execution-worker/arc';
import {
  MemoryOutboxStore,
  type OutboxRecord,
  type OutboxStore,
} from '@synq/execution-worker/arc-outbox';
import { VAULT_POLICY_ABI } from '@synq/execution-worker/vault';
import { vaultLegExecutor } from '../../scripts/lib/split-executor.js';

export const USDC = token('arc-testnet', 'USDC');
export const VAULT = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE')
  .address as Address;
export const POLICY = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY')
  .address as Address;
const USDC_CODE = readFileSync(
  new URL('../arc/fixtures/arc-testnet-usdc.code', import.meta.url),
  'utf8',
).trim() as Hex;
const POLICY_CODE = readFileSync(
  new URL('./fixtures/arc-testnet-vault-policy.code', import.meta.url),
  'utf8',
).trim() as Hex;

export const usd = (x: string) => moneyFromDecimal(USDC, x).baseUnits;
export const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
export const intruder = privateKeyToAccount(`0x${'12'.repeat(32)}`);
export const operator = privateKeyToAccount(`0x${'22'.repeat(32)}`);
export const DEV = getAddress('0x00000000000000000000000000000000000de7e1');
export const SAVINGS = getAddress('0x0000000000000000000000000000000000005a7e');
export const STRANGER = getAddress(
  '0x000000000000000000000000000000000000bad1',
);
export const WS = 'wsp_freelancer_p14';
/** 2026-10-16T12:00:00Z */
export const T0 = 1_792_152_000;
export const day = (n: number) => isoDay(T0 + n * 86_400);

export const vendors = (): Vendor[] => [
  {
    vendorId: 'vnd_dev',
    workspaceId: WS,
    name: 'Dev Contractor',
    kind: 'CONTRACTOR',
    addresses: [
      {
        chainId: USDC.chainId,
        address: DEV,
        status: 'VERIFIED',
        source: 'onboarding',
        at: T0 - 86_400 * 30,
        verifiedBy: 'owner',
      },
    ],
  },
  {
    vendorId: 'vnd_savings',
    workspaceId: WS,
    name: 'Owner savings',
    kind: 'VENDOR',
    addresses: [
      {
        chainId: USDC.chainId,
        address: SAVINGS,
        status: 'VERIFIED',
        source: 'owner',
        at: T0 - 86_400 * 30,
        verifiedBy: 'owner',
      },
    ],
  },
  {
    vendorId: 'vnd_new',
    workspaceId: WS,
    name: 'New designer',
    kind: 'CONTRACTOR',
    addresses: [
      {
        chainId: USDC.chainId,
        address: STRANGER,
        status: 'PENDING',
        source: 'chat',
        at: T0,
        verifiedBy: null,
      },
    ],
  },
];

export const devInvoice = (
  amount: bigint,
  dueIn: number,
  id = 'vin_dev_1',
): VendorInvoice => ({
  vendorInvoiceId: id,
  vendorId: 'vnd_dev',
  number: `DEV-${id}`,
  payTo: DEV,
  chainId: USDC.chainId,
  token: USDC.address,
  decimals: USDC.decimals,
  amount,
  issuedOn: day(-10),
  dueOn: day(dueIn),
  reference: null,
  documentText: `Development work ${id} for the Acme project, milestone delivery and handover`,
  earlyPayDiscountBps: 0,
  earlyPayByDays: 0,
});

export const bills1500 = (): RecurringBill[] => [
  {
    billId: 'bill_software',
    label: 'Design software',
    kind: 'SUBSCRIPTION',
    amount: usd('45'),
    nextDueOn: day(12),
    cadenceDays: 30,
  },
  {
    billId: 'bill_cowork',
    label: 'Co-working desk',
    kind: 'RENT',
    amount: usd('250'),
    nextDueOn: day(20),
    cadenceDays: 30,
  },
];

export const receivables1500 = (): Receivable[] => [
  {
    invoiceId: 'inv_next',
    number: 'INV-2002',
    payer: 'Globex',
    amountDue: usd('2000'),
    dueOn: day(20),
    payerDaysLate: [0, 2],
  },
];

export function policy1500(
  overrides: Partial<RevenuePolicy> = {},
): RevenuePolicy {
  return parsePolicy({
    policyId: 'freelancer_revenue',
    version: 1,
    workspaceId: WS,
    owner: owner.address,
    chainId: USDC.chainId,
    token: USDC.address,
    decimals: 6,
    treasury: VAULT,
    validFrom: T0 - 3_600,
    validUntil: T0 + 86_400 * 365,
    taxReserveBps: 1_500,
    operatingFloor: usd('500'),
    obligationHorizonDays: 30,
    allowedBeneficiaries: [
      { beneficiaryId: 'vnd_dev', address: DEV, label: 'Dev contractor' },
      { beneficiaryId: 'vnd_savings', address: SAVINGS, label: 'Savings' },
    ],
    distributions: [
      {
        kind: 'PERCENT_OF_SURPLUS',
        label: 'savings',
        beneficiaryId: 'vnd_savings',
        bps: 1_000,
      },
    ],
    limits: {
      maxAutonomousPerLeg: usd('400'),
      maxAutonomousPerWindow: usd('1000'),
      windowSeconds: 86_400,
      maxSplitsPerWindow: 5,
    },
    maxBalanceAgeSeconds: 300,
    remainder: 'FREE_CASH',
    cancellation: 'BEFORE_EXECUTION',
    recovery: 'RECONCILE_THEN_REVIEW',
    ...overrides,
  });
}

export async function signPolicy(
  policy: RevenuePolicy,
  signer: { signTypedData: typeof owner.signTypedData } = owner,
): Promise<SignedRevenuePolicy> {
  const mandate = mandateFromPolicy(policy);
  return {
    policy,
    policySignature: await signer.signTypedData(policyTypedData(policy)),
    mandate,
    mandateSignature: await signer.signTypedData(mandateTypedData(mandate)),
  };
}

export const TX = (n: number) => `0x${n.toString(16).padStart(64, 'a')}` as Hex;

export function receipt1500(
  amount = usd('1500'),
  overrides: Partial<FinalReceipt> = {},
): FinalReceipt {
  return {
    receiptId: receiptKey(USDC.chainId, TX(1), 3),
    chainId: USDC.chainId,
    token: USDC.address,
    txHash: TX(1),
    logIndex: 3,
    blockNumber: 1_000n,
    amount,
    recipient: VAULT,
    payer: '0x00000000000000000000000000000000000C1e47',
    invoiceId: 'inv_acme',
    invoiceNumber: 'INV-2001',
    source: 'MEMO_INVOICE',
    finality: 'FINAL',
    ...overrides,
  };
}

export function position(
  cash: bigint,
  overrides: Partial<CashPosition> = {},
): CashPosition {
  return {
    treasury: VAULT,
    onChainFinalized: cash,
    observedBlock: 1_005n,
    observedAt: T0 - 10,
    source: 'test:usdc.balanceOf@finalized',
    reservations: 0n,
    committedOutgoing: 0n,
    escrowLiabilities: 0n,
    refundLiabilities: 0n,
    invested: 0n,
    ...overrides,
  };
}

/**
 * A minimal Arc stand-in for the governed vault: it decodes the signed
 * policy.pay transaction, enforces the same per-payment and window caps as
 * the contract (reverting with its custom error), and emits the token
 * Transfer and OperatorPaid logs.
 */
export function fakeVaultChain(
  opts: { perPaymentCap?: bigint; windowCap?: bigint } = {},
) {
  const perPaymentCap = opts.perPaymentCap ?? usd('1000');
  const windowCap = opts.windowCap ?? usd('5000');
  let windowSpent = 0n;
  let nonce = 3;
  const mined = new Map<
    Hex,
    { status: 'success' | 'reverted'; block: bigint; logs: unknown[] }
  >();
  const broadcasts: Hex[] = [];
  const paid: { recipient: Address; amount: bigint; ref: Hex }[] = [];
  /** Failure injection: each counter fails that many upcoming calls. */
  const fail = { estimateGas: 0, receipt: 0, wait: 0 };
  const capError = (amount: bigint, cap: bigint) => {
    const err = new Error('execution reverted') as Error & { data: Hex };
    err.data = encodeErrorResult({
      abi: VAULT_POLICY_ABI,
      errorName: 'CapExceeded',
      args: [amount, cap],
    });
    return err;
  };
  const check = (data: Hex) => {
    if (data.startsWith('0xa9059cbb')) {
      // Plain ERC-20 transfer from the operator wallet (wallet fallback).
      const t = decodeFunctionData({ abi: erc20Abi, data });
      const [recipient, amount] = t.args as [Address, bigint];
      return { recipient, amount, ref: null as Hex | null };
    }
    const d = decodeFunctionData({ abi: VAULT_POLICY_ABI, data });
    if (d.functionName !== 'pay') throw new Error('not pay');
    const [recipient, amount, ref] = d.args as [Address, bigint, Hex];
    if (amount > perPaymentCap) throw capError(amount, perPaymentCap);
    if (windowSpent + amount > windowCap)
      throw capError(windowSpent + amount, windowCap);
    return { recipient, amount, ref };
  };
  const client = {
    getChainId: async () => USDC.chainId,
    getCode: async ({ address }: { address: Address }) =>
      address.toLowerCase() === USDC.address.toLowerCase()
        ? USDC_CODE
        : POLICY_CODE,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === 'safe'
        ? VAULT
        : functionName === 'operator'
          ? operator.address
          : functionName === 'balanceOf'
            ? 10n ** 15n
            : 0n,
    call: async ({ data }: { data: Hex }) => {
      const c = check(data);
      return {
        data:
          c.ref === null
            ? encodeAbiParameters([{ type: 'bool' }], [true])
            : ('0x' as Hex),
      };
    },
    estimateGas: async () => {
      if (fail.estimateGas > 0) {
        fail.estimateGas--;
        throw new Error('rpc 503');
      }
      return 90_000n;
    },
    getTransactionCount: async () => nonce,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 21_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    }),
    getBalance: async () => 10n ** 20n,
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      const hash = keccak256(serializedTransaction);
      broadcasts.push(hash);
      if (mined.has(hash)) throw new Error('already known');
      const tx = parseTransaction(serializedTransaction);
      nonce++;
      const block = BigInt(2_000 + mined.size);
      let call: ReturnType<typeof check>;
      try {
        call = check(tx.data!);
      } catch {
        mined.set(hash, { status: 'reverted', block, logs: [] });
        return hash;
      }
      if (call.ref !== null) windowSpent += call.amount;
      paid.push({ ...call, ref: call.ref ?? ('0x' as Hex) });
      const base = {
        blockNumber: block,
        transactionHash: hash,
        blockHash: `0x${'bb'.repeat(32)}`,
        transactionIndex: 0,
        removed: false,
      };
      mined.set(hash, {
        status: 'success',
        block,
        logs: [
          {
            ...base,
            address: USDC.address,
            topics: encodeEventTopics({
              abi: erc20Abi,
              eventName: 'Transfer',
              args: {
                from: call.ref === null ? operator.address : VAULT,
                to: call.recipient,
              },
            }),
            data: encodeAbiParameters([{ type: 'uint256' }], [call.amount]),
            logIndex: 1,
          },
          ...(call.ref === null
            ? []
            : [
                {
                  ...base,
                  address: POLICY,
                  topics: encodeEventTopics({
                    abi: VAULT_POLICY_ABI,
                    eventName: 'OperatorPaid',
                    args: {
                      ref: call.ref,
                      operator: operator.address,
                      recipient: call.recipient,
                    },
                  }),
                  data: encodeAbiParameters(
                    [{ type: 'address' }, { type: 'uint256' }],
                    [USDC.address, call.amount],
                  ),
                  logIndex: 2,
                },
              ]),
        ],
      });
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (fail.receipt > 0) {
        fail.receipt--;
        throw new Error('receipt rpc timeout');
      }
      const m = mined.get(hash);
      if (!m) throw new Error('receipt not found');
      return {
        status: m.status,
        blockNumber: m.block,
        blockHash: `0x${'bb'.repeat(32)}`,
        gasUsed: 70_000n,
        effectiveGasPrice: 21_000_000_000n,
        logs: m.logs,
      };
    },
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (fail.wait > 0) {
        fail.wait--;
        throw new Error('worker died while waiting for the receipt');
      }
      return client.getTransactionReceipt({ hash });
    },
  };
  return {
    client: client as unknown as PublicClient,
    broadcasts,
    paid,
    fail,
    get windowSpent() {
      return windowSpent;
    },
  };
}

export function countingSigner() {
  const counts = new Map<number, number>();
  return {
    address: operator.address,
    async signTransaction(tx: Parameters<typeof operator.signTransaction>[0]) {
      counts.set(tx.nonce!, (counts.get(tx.nonce!) ?? 0) + 1);
      return operator.signTransaction(tx);
    },
    get total() {
      return [...counts.values()].reduce((a, x) => a + x, 0);
    },
  };
}

export const GRANT_KEY = new Uint8Array(32).fill(7);
export const kernelConfig: AuthorityConfig = {
  grantKey: GRANT_KEY,
  operator: 'allocations-test',
  grantTtlSeconds: 600,
  riskRequiredAbove: usd('100000'),
};

export type World = Awaited<ReturnType<typeof world>>;
export type FakeChain = ReturnType<typeof fakeVaultChain>;

/** The workspace's registered treasury and owners (not settable by a policy). */
export const registryOf = (
  entries: Record<string, { treasury: Address; owners: Address[] }> = {},
): WorkspaceRegistry => ({
  principals: async (workspaceId) => ({
    treasury: entries[workspaceId]?.treasury ?? VAULT,
    owners: entries[workspaceId]?.owners ?? [owner.address],
    source: 'test:configured-workspace-owner',
  }),
});

export const ledgerReceipt = (
  workspaceId: string,
  receipt: FinalReceipt,
): JournalEntry => ({
  entryId: `je_receipt_${receipt.txHash.slice(2)}_${receipt.logIndex}`,
  workspaceId,
  occurredAt: T0 - 60,
  memo: `Payment for ${receipt.invoiceNumber}`,
  source: { kind: 'CHAIN_TX', ref: receipt.invoiceId },
  evidence: {
    chainId: receipt.chainId,
    txHash: receipt.txHash,
    logIndex: receipt.logIndex,
    recipient: receipt.recipient,
  },
  idempotencyKey: receipt.receiptId,
  postings: [
    {
      account: 'CASH_ARC_USDC',
      assetId: USDC.assetId,
      amount: receipt.amount,
      counterpartyId: walletTag(receipt.recipient),
      documentRef: receipt.invoiceId,
    },
    {
      account: 'ACCOUNTS_RECEIVABLE',
      assetId: USDC.assetId,
      amount: -receipt.amount,
      counterpartyId: 'payer:Acme',
      documentRef: receipt.invoiceId,
    },
  ],
  reversalOf: null,
});

/**
 * Everything a runner needs, around the $1,500 scenario: books, ledger with
 * the receipt already settled (as `InvoiceService.settle` books it), a fake
 * vault chain and an outbox store that outlive any one runner. Worlds can
 * share a store, a chain (one treasury) and an outbox.
 */
export async function world(
  input: {
    store: SplitStore;
    ledger?: Ledger;
    policy?: RevenuePolicy;
    signed?: SignedRevenuePolicy;
    receipt?: FinalReceipt;
    /** Cash already in the treasury on chain, outside this world's receipts. */
    otherCash?: bigint;
    payables?: VendorInvoice[];
    chainCaps?: { perPaymentCap?: bigint; windowCap?: bigint };
    outbox?: OutboxStore;
    fake?: FakeChain;
    /** Shared on-chain treasury balance (for worlds on one treasury). */
    treasuryCash?: { value: bigint };
    registry?: WorkspaceRegistry;
    vendorList?: Vendor[];
    bills?: RecurringBill[];
  } = { store: undefined as unknown as SplitStore },
) {
  const policy = input.policy ?? policy1500();
  const signed = input.signed ?? (await signPolicy(policy));
  const receipt = input.receipt ?? receipt1500();
  const vs = input.vendorList ?? vendors();
  const ledger =
    input.ledger ??
    new Ledger(new MemoryLedgerStore(), {
      verifiedPayout: (cp, chainId) =>
        vendorDirectory(vs).verifiedPayout(cp, chainId),
    });
  const fake = input.fake ?? fakeVaultChain(input.chainCaps);
  const treasuryCash = input.treasuryCash ?? { value: input.otherCash ?? 0n };
  const paidBefore = fake.paid.reduce((a, p) => a + p.amount, 0n);
  const addReceipt = async (r: FinalReceipt) => {
    await ledger.post(ledgerReceipt(policy.workspaceId, r));
    treasuryCash.value += r.amount;
  };
  await addReceipt(receipt);
  const payables = input.payables ?? [devInvoice(usd('300'), 5)];
  const chain = await connectChain('arc-testnet', undefined, fake.client);
  const outbox = input.outbox ?? new MemoryOutboxStore();
  const signer = countingSigner();
  let clock = T0;
  const now = () => clock;
  const crash = {
    at: null as string | null,
    mode: 'throw' as 'throw' | 'hang',
  };
  const settled: { holdKey: string; status: 'CONSUMED' | 'RELEASED' }[] = [];
  const books: TreasuryBooks = {
    position: async () => {
      const { reservations: _r, ...p } = position(
        treasuryCash.value -
          (fake.paid.reduce((a, x) => a + x.amount, 0n) - paidBefore),
      );
      return { ...p, observedAt: clock - 5 };
    },
    vendors: async () => vs,
    payables: async () =>
      openPayables(payables, await ledger.store.entries(policy.workspaceId)),
    payableHistory: async () => payables,
    obligations: async () => [],
    bills: async () => input.bills ?? bills1500(),
    receivables: async () => receivables1500(),
    settledHolds: async () => settled,
  };
  const registry = input.registry ?? registryOf();
  // The executor's grant-nonce fence is durable in production: share it across restarts.
  const fence = new MemoryNonceFence();
  const makeRunner = (
    afterRecord?: (k: string, r: OutboxRecord) => unknown,
    over: Partial<RunnerDeps> = {},
  ) =>
    new SplitRunner({
      store: input.store,
      ledger,
      executor: vaultLegExecutor({
        chain,
        store: outbox,
        signer,
        asset: USDC,
        grantKey: GRANT_KEY,
        fence,
        now,
        afterRecord: async (k, r) => {
          if (crash.at === k) {
            crash.at = null;
            if (crash.mode === 'hang') await new Promise(() => undefined);
            throw new Error(`simulated crash after recording ${k}`);
          }
          await afterRecord?.(k, r);
        },
      }),
      receipts: { verify: async (r) => r },
      books,
      signedPolicy: signed,
      registry,
      kernel: kernelConfig,
      assetId: USDC.assetId,
      chain: 'arc-testnet',
      now,
      ...over,
    });
  return {
    policy,
    signed,
    receipt,
    ledger,
    fake,
    chain,
    outbox,
    signer,
    crash,
    books,
    settled,
    vendors: vs,
    treasuryCash,
    addReceipt,
    registry,
    store: input.store,
    runner: makeRunner(),
    makeRunner,
    tick: (s: number) => {
      clock += s;
    },
  };
}
