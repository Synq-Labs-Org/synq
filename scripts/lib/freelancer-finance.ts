/**
 * Every call the freelancer demo makes into the Synq finance team lives here:
 * the WorldSnapshot readers, the desk, the Kernel port and the Supervisor
 * questions. Keeping them in one module means a change in the team's
 * contract (intent routing, approval steps, freshness rules) is adapted in
 * one place.
 */
import type { Address, Hex, LocalAccount } from 'viem';
import { token, type ChainName } from '@synq/chain-registry/arc';
import type { Invoice } from '@synq/invoices';
import {
  type ApprovalTerms,
  type AuthorityConfig,
  type MandateState,
  type PaymentIntent,
  type PaymentMandate,
} from '@synq/kernel/arc';
import type { Ledger } from '@synq/ledger';
import type { Obligation, Vendor, VendorInvoice } from '@synq/payables';
import {
  ARC_PROVIDERS,
  buildArcWorldSnapshot,
  type ArcMembership,
  type ArcUser,
  type ArcWallet,
  type ArcWorkspace,
  type ArcWorldSnapshot,
  type Blocker,
  type CctpTransfer as WorldCctpTransfer,
  type Payable,
  type ProviderProbe,
} from '@synq/world-model';
import {
  MemoryObligationFence,
  type ApprovalNonceFence,
  type ObligationFence,
  arcPaymentKernel,
  superviseFinance,
  type FinanceBudgetLedger,
  type ChainReceipt,
  type FinanceDesk,
  type PayoutEvidence,
  type SettlementEvidence,
  type StructuredReasoner,
  type SupervisorReply,
} from '@synq/agent-runtime';

export type OwnerSigner = Pick<LocalAccount, 'address' | 'signTypedData'>;

/** Chain and provider reads the snapshot needs (real RPC/HTTP in the script). */
export type WorldChainReads = {
  arcUsdcBalance(account: Address): Promise<bigint>;
  gatewayAvailable(
    depositor: Address,
  ): Promise<{ chain: ChainName; available: bigint }[]>;
  probe(
    providerId: 'ARC_RPC' | 'CIRCLE_GATEWAY' | 'CIRCLE_CCTP',
  ): Promise<{ ok: boolean; detail: string; observedAt: number }>;
};

/** Mutable books the demo keeps while it runs; every reader reads them live. */
export type FinanceBooks = {
  workspaceId: string;
  identity: {
    user: ArcUser;
    workspace: ArcWorkspace;
    membership: ArcMembership;
    wallets: ArcWallet[];
    source: string;
  } | null;
  vendors: Vendor[];
  vendorInvoices: VendorInvoice[];
  obligations: Obligation[];
  payoutEvidence: PayoutEvidence[];
  settlements: SettlementEvidence[];
  cctpInFlight: WorldCctpTransfer[];
  mandate: PaymentMandate | null;
  mandateState: MandateState;
  minimumReserve: bigint;
  blockers: Blocker[];
};

export type FinanceWiring = {
  books: FinanceBooks;
  chain: WorldChainReads;
  ledger: Ledger;
  invoices: { list(workspaceId: string): Promise<Invoice[]> };
  receipts: (hash: `0x${string}`) => Promise<ChainReceipt | null>;
  /**
   * Per-wallet check of the books against the chain: each workspace wallet's
   * native balance change since the run began must equal its ledger cash.
   */
  reconcile: () => Promise<{
    status: 'RECONCILED' | 'UNRECONCILED';
    unreconciled: number;
    detail: string;
  }>;
  reasoner?: StructuredReasoner;
  /** Session budget shared by every Supervisor run of this demo. */
  budget: FinanceBudgetLedger;
  env: Readonly<Record<string, string | undefined>>;
  now: () => number;
};

const ARC = 'arc-testnet' as const;

async function payables(w: FinanceWiring): Promise<Payable[]> {
  const entries = await w.ledger.store.entries(w.books.workspaceId);
  const settled = new Set(
    entries
      .filter((e) => e.source.kind === 'CHAIN_TX')
      .map((e) => e.source.ref),
  );
  return w.books.vendorInvoices.map((i) => {
    const vendor = w.books.vendors.find((v) => v.vendorId === i.vendorId);
    const verified =
      vendor?.addresses.find(
        (a) => a.chainId === i.chainId && a.status === 'VERIFIED',
      )?.address ?? null;
    return {
      vendorInvoiceId: i.vendorInvoiceId,
      vendorId: i.vendorId,
      vendorName: vendor?.name ?? i.vendorId,
      number: i.number,
      amount: i.amount.toString(),
      dueOn: i.dueOn,
      payTo: i.payTo,
      verifiedPayTo: verified,
      status: settled.has(i.vendorInvoiceId) ? 'PAID' : 'OPEN',
    };
  });
}

/** WorldSnapshot from real readers: Arc RPC, Gateway API, Postgres books, Kernel state, provider probes. */
export function worldOf(w: FinanceWiring): () => Promise<ArcWorldSnapshot> {
  const b = w.books;
  return async () => {
    // Every reader is issued at `builtAt` (they start together below), so the
    // observation is stamped with that issue time: never later than the
    // snapshot's own clock, never fresher than it really is.
    const builtAt = w.now();
    const at = <T>(
      value: T,
      provenance: Parameters<typeof reading>[1],
      source: string,
    ) => reading(value, provenance, source, builtAt);
    const id = b.identity;
    const providers: ProviderProbe[] = ARC_PROVIDERS.map((p) => ({
      ...p,
      sdkInstalled: true,
      ...(p.providerId === 'ARC_RPC' ||
      p.providerId === 'CIRCLE_GATEWAY' ||
      p.providerId === 'CIRCLE_CCTP'
        ? { check: () => w.chain.probe(p.providerId as 'ARC_RPC') }
        : {}),
    }));
    return buildArcWorldSnapshot({
      now: builtAt,
      env: w.env,
      providers,
      readers: {
        ...(id
          ? {
              user: () => at(id.user, 'CONFIG', id.source),
              workspace: () => at(id.workspace, 'CONFIG', id.source),
              memberships: () => at([id.membership], 'CONFIG', id.source),
              wallets: () => at(id.wallets, 'CONFIG', id.source),
              balances: async () => {
                const rows = await Promise.all(
                  id.wallets.map(async (x) => ({
                    chain: ARC as ChainName,
                    account: x.address,
                    asset: 'USDC' as const,
                    baseUnits: String(await w.chain.arcUsdcBalance(x.address)),
                  })),
                );
                return at(rows, 'CHAIN', 'rpc:arc-testnet:usdc.balanceOf');
              },
              gatewayAvailable: async () => {
                const owner = id.wallets.find((x) => x.kind === 'OWNER_EOA')!;
                const rows = await w.chain.gatewayAvailable(owner.address);
                return at(
                  rows.map((r) => ({
                    chain: r.chain,
                    depositor: owner.address,
                    baseUnits: String(r.available),
                  })),
                  'PLUGIN',
                  'circle-gateway:/v1/balances',
                );
              },
            }
          : {}),
        cctpInFlight: () =>
          at([...b.cctpInFlight], 'PLUGIN', 'circle-cctp:transfer-state'),
        reserves: async () => {
          const bal = await w.ledger.balances(
            b.workspaceId,
            token(ARC, 'USDC').assetId,
          );
          return at(
            {
              minimumReserve: String(b.minimumReserve),
              reservations: '0',
              escrow: String(-bal.ESCROW_LIABILITY),
            },
            'POSTGRES',
            'ledger:synq_ledger_entries+config:minimumReserve',
          );
        },
        receivables: async () =>
          at(
            (await w.invoices.list(b.workspaceId)).map((i) => ({
              invoiceId: i.invoiceId,
              number: i.number,
              payer: i.payer.name,
              total: String(i.total),
              amountDue: String(
                i.total - i.credited - i.paid > 0n
                  ? i.total - i.credited - i.paid
                  : 0n,
              ),
              dueDate: i.dueDate,
              status: i.status,
            })),
            'POSTGRES',
            'invoices:synq_invoices',
          ),
        payables: async () =>
          at(
            await payables(w),
            'POSTGRES',
            'payables:vendor-invoices+synq_ledger_entries',
          ),
        mandates: () => {
          const m = b.mandate;
          const spent = b.mandateState.spends.reduce(
            (a, s) => a + s.amount,
            0n,
          );
          return at(
            m
              ? [
                  {
                    mandateId: m.mandateId,
                    version: m.version,
                    purposes: [...m.purposes],
                    perActionCap: String(m.perActionCap),
                    periodBudget: String(m.periodBudget),
                    spentInPeriod: String(spent),
                    recipients: m.recipients.length,
                    validUntil: m.validUntil,
                    revoked: b.mandateState.revoked,
                  },
                ]
              : [],
            'KERNEL',
            'kernel:mandate-state',
          );
        },
        pendingApprovals: () => at([], 'KERNEL', 'kernel:approvals'),
        reconciliation: async () => {
          const r = await w.reconcile();
          return at(
            { ...r, lastRunAt: builtAt },
            'CHAIN',
            'reconcile:arc-native-balance-deltas=ledger-wallet-cash',
          );
        },
        blockers: () => at([...b.blockers], 'CONFIG', 'reports:blockers'),
      },
    });
  };
}

function reading<T>(
  value: T,
  provenance: 'CHAIN' | 'POSTGRES' | 'PLUGIN' | 'KERNEL' | 'CONFIG',
  source: string,
  observedAt: number,
) {
  return { value, provenance, source, observedAt };
}

/**
 * The Kernel port: the owner-signed mandate, live mandate state, an
 * independent simulation of the exact transfer and a one-grant-per-obligation
 * fence. Owner approvals arrive per request (`ask(..., { ownerApproval })`),
 * never from a lookup the team could reach.
 */
export function kernelOf(input: {
  config: AuthorityConfig;
  mandate: PaymentMandate;
  mandateSignature: Hex;
  books: FinanceBooks;
  simulate: (intent: PaymentIntent) => Promise<boolean>;
  now: () => number;
  /** Durable fences (Postgres) when the caller has a database; otherwise in-memory. */
  fences?: {
    obligations: ObligationFence;
    approvals: ApprovalNonceFence | null;
  };
}) {
  return arcPaymentKernel({
    config: input.config,
    mandate: input.mandate,
    mandateSignature: input.mandateSignature,
    state: () => input.books.mandateState,
    simulate: input.simulate,
    now: input.now,
    obligations: input.fences?.obligations ?? new MemoryObligationFence(),
    ...(input.fences?.approvals ? { approvals: input.fences.approvals } : {}),
  });
}

/**
 * A desk whose snapshot is rebuilt from the real readers on every request and
 * on refresh, so a payout decision never runs on an old snapshot.
 */
export async function deskOf(
  w: FinanceWiring,
  kernel?: ReturnType<typeof kernelOf>,
): Promise<FinanceDesk> {
  const world = worldOf(w);
  const now = w.now();
  return {
    workspaceId: w.books.workspaceId,
    world,
    refreshWorld: world,
    vendors: [...w.books.vendors],
    vendorInvoices: [...w.books.vendorInvoices],
    obligations: [...w.books.obligations],
    invoices: await w.invoices.list(w.books.workspaceId),
    evidence: [...w.books.payoutEvidence],
    settlements: [...w.books.settlements],
    ledgerEntries: await w.ledger.store.entries(w.books.workspaceId),
    ...(kernel ? { kernel } : {}),
    ...(w.reasoner ? { reasoner: w.reasoner } : {}),
    receipts: w.receipts,
    budget: w.budget,
    today: new Date(now * 1000).toISOString().slice(0, 10),
    now,
    policy: { invoiceNetDays: 7, maxReallocationBaseUnits: 0n },
  };
}

/** One Supervisor turn for a chat message (optionally carrying an owner confirmation). */
export async function ask(
  w: FinanceWiring,
  message: string,
  options: {
    kernel?: ReturnType<typeof kernelOf>;
    /** Set by the channel path for chat messages. */
    origin?: 'CHAT';
    /** Owner wallet confirmation (comes from the wallet, never from chat). */
    confirm?: { ownerApproval: Hex; approval: ApprovalTerms };
  } = {},
): Promise<SupervisorReply> {
  return superviseFinance(message, await deskOf(w, options.kernel), {
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.confirm ? { confirm: options.confirm } : {}),
  });
}

/**
 * The owner's wallet confirms one PROPOSED payout: it signs the exact
 * PaymentApproval typed data (intent + Kernel-issued nonce and deadline), and
 * the same request is decided again on a freshly built snapshot.
 */
export async function confirmPayout(input: {
  wiring: FinanceWiring;
  kernel: ReturnType<typeof kernelOf>;
  owner: OwnerSigner;
  message: string;
  proposal: SupervisorReply;
}): Promise<{
  reply: SupervisorReply;
  ownerApproval: {
    intentId: string;
    signature: Hex;
    nonce: Hex;
    deadline: number;
  };
} | null> {
  const confirmation = input.proposal.payment?.kernel?.confirmation;
  if (input.proposal.payment?.status !== 'PROPOSED' || !confirmation)
    return null;
  const signature = await input.owner.signTypedData(confirmation.typedData);
  const reply = await ask(input.wiring, input.message, {
    kernel: input.kernel,
    confirm: { ownerApproval: signature, approval: confirmation.approval },
  });
  return {
    reply,
    ownerApproval: {
      intentId: confirmation.intent.intentId,
      signature,
      ...confirmation.approval,
    },
  };
}
