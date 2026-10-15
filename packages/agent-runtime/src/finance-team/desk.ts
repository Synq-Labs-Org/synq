import { z } from 'zod';
import type { JournalEntry } from '@synq/ledger';
import type { Invoice } from '@synq/invoices';
import type { Obligation, Vendor, VendorInvoice } from '@synq/payables';
import type { ArcWorldSnapshot } from '@synq/world-model';
import type { StructuredReasoner } from '../ports.js';
import type { FinanceBudgetLedger } from './budget.js';
import type { PaymentKernelPort } from './kernel-port.js';
import type { SettlementEvidence } from './settlement-audit.js';

const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const TxHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/**
 * Evidence bundle written by the Arc AP proof (`scripts/arc-ap-proof.ts`):
 * one Kernel-granted payout with its tx hash and ledger lines, and the
 * refused fraud attempt. Public data only: addresses, hashes, decisions.
 */
export const PayoutEvidenceSchema = z.object({
  environment: z.string().min(1),
  owner: Address,
  agent: Address,
  sarahVerified: Address,
  payout: z.object({
    softFlags: z.array(z.unknown()),
    decision: z.enum(['ALLOW', 'REQUIRE_OWNER_APPROVAL', 'DENY']),
    reasons: z.array(z.string()),
    grantId: z.string().min(1),
    hash: TxHash,
    explorer: z.url(),
    amount: z.string().regex(/^\d+(\.\d+)?$/),
    apLedger: z.record(z.string(), z.string().regex(/^-?\d+(\.\d+)?$/)),
  }),
  fraud: z
    .object({
      requestedPayTo: Address,
      riskFlags: z.array(
        z.object({
          code: z.string(),
          severity: z.enum(['HARD', 'SOFT']),
          detail: z.string(),
        }),
      ),
      decision: z.enum(['ALLOW', 'REQUIRE_OWNER_APPROVAL', 'DENY']),
      auditReasons: z.array(z.string()),
      agentNonceUnchanged: z.boolean(),
    })
    .optional(),
});
export type PayoutEvidence = z.output<typeof PayoutEvidenceSchema>;

/** An independent chain read of a transaction (injected; agents never hold RPC clients). */
export type ChainReceipt = Readonly<{
  status: 'success' | 'reverted';
  blockNumber: bigint;
  from: `0x${string}`;
  /** ERC-20 USDC transfers in the transaction (registry token only). */
  transfers: readonly { from: string; to: string; baseUnits: bigint }[];
}>;

/**
 * What a Supervisor run may read. The WorldSnapshot carries provenance and
 * freshness; the books carry the documents behind it. Ports for money
 * movement (Kernel) and models are optional: without them the team still
 * answers reads and explanations, and cannot obtain grants.
 */
export type FinanceDesk = Readonly<{
  workspaceId: string;
  /** The Supervisor requests the current snapshot through this port. */
  world: () => Promise<ArcWorldSnapshot>;
  /** Re-reads sources; used once before any money movement on stale data. */
  refreshWorld?: () => Promise<ArcWorldSnapshot>;
  vendors: readonly Vendor[];
  vendorInvoices: readonly VendorInvoice[];
  obligations: readonly Obligation[];
  invoices: readonly Invoice[];
  evidence: readonly PayoutEvidence[];
  /** Reconciled invoice payment routes (e.g. CCTP burn, attestation, mint). */
  settlements?: readonly SettlementEvidence[];
  ledgerEntries?: readonly JournalEntry[];
  kernel?: PaymentKernelPort;
  reasoner?: StructuredReasoner;
  receipts?: (txHash: `0x${string}`) => Promise<ChainReceipt | null>;
  /** Per-workspace/session budget shared across Supervisor runs. */
  budget?: FinanceBudgetLedger;
  /** ISO date and unix seconds for this run. */
  today: string;
  now: number;
  policy?: Readonly<{
    invoiceNetDays?: number;
    maxReallocationBaseUnits?: bigint;
  }>;
}>;
