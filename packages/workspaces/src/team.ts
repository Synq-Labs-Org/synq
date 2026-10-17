import { randomUUID } from 'node:crypto';
import { redact } from '@synq/plugin-risk';
import { WorkspaceError } from './contracts.js';
import { parseWorkspacePay } from './payout-command.js';
import type { WorkspacePayouts } from './payouts.js';
import type { WorkspaceBooks } from './books.js';
import { getAddress } from 'viem';
import { token } from '@synq/chain-registry/arc';
import { Ledger, PostgresLedgerStore, migrateArcIndexer } from '@synq/ledger';
import { PostgresInvoiceStore } from '@synq/invoices';
import {
  buildArcWorldSnapshot,
  type Reader,
  type ProviderProbe,
} from '@synq/world-model';
import {
  superviseFinance,
  PostgresFinanceBudgetLedger,
  type StructuredReasoner,
  type FinanceDesk,
} from '@synq/agent-runtime';
import type { WorkspaceFinance } from './finance.js';
import { WorkspaceRevenue } from './revenue.js';

import { TeamQuestionSchema } from './team-contracts.js';
export { TeamQuestionSchema } from './team-contracts.js';
type Balance = { amount: string; blockNumber: string; observedAt: number };
export class WorkspaceTeam {
  readonly budget: PostgresFinanceBudgetLedger;
  constructor(
    readonly finance: WorkspaceFinance,
    readonly balance: (workspaceId: string) => Promise<Balance>,
    readonly providers: readonly ProviderProbe[],
    private readonly reasoner?: () => StructuredReasoner | undefined,
    readonly payouts?: WorkspacePayouts,
    readonly books?: WorkspaceBooks,
  ) {
    this.budget = new PostgresFinanceBudgetLedger(
      finance.workspaces.pool,
      undefined,
      { now: finance.workspaces.now },
    );
  }
  async migrate() {
    await this.budget.migrate();
    await migrateArcIndexer(this.finance.workspaces.pool);
  }
  async snapshot(workspaceId: string, principalId: string) {
    const workspaces = this.finance.workspaces,
      pool = workspaces.pool;
    await workspaces.membership(workspaceId, principalId);
    const w = await workspaces.get(workspaceId, principalId),
      at = workspaces.now();
    const db =
      <T>(value: T, source: string): Reader<T> =>
      () => ({
        value,
        provenance: 'POSTGRES',
        source: `workspace:${workspaceId}:${source}`,
        observedAt: at,
      });
    const invoices = (
      await new PostgresInvoiceStore(pool).list(workspaceId)
    ).map((r) => r.invoice);
    const [budget, payouts, risk, receipts, deals, cursor, holds] =
      await Promise.all([
        pool.query('SELECT data FROM synq_ws_budgets WHERE workspace_id=$1', [
          workspaceId,
        ]),
        pool.query(
          'SELECT id,data,state,created_at FROM synq_ws_payouts WHERE workspace_id=$1',
          [workspaceId],
        ),
        pool.query(
          'SELECT case_id,status FROM synq_risk_cases WHERE workspace_id=$1',
          [workspaceId],
        ),
        pool.query(
          'SELECT key,state FROM synq_ws_receipts WHERE workspace_id=$1',
          [workspaceId],
        ),
        pool
          .query(
            `SELECT d.deal_id,d.status FROM synq_dealroom_deals d
             JOIN synq_dealroom_versions v ON v.deal_id=d.deal_id AND v.version=d.current_version
             WHERE d.workspace_id=$1 AND
             (v.data#>>'{terms,client,principalId}'=$2 OR
              v.data#>>'{terms,freelancer,principalId}'=$2 OR
              v.data#>>'{terms,arbiter,principalId}'=$2)`,
            [workspaceId, principalId],
          )
          .catch(() => null),
        pool.query(
          'SELECT block_number FROM synq_arc_index_cursors WHERE stream=$1',
          [`workspace:${workspaceId}`],
        ),
        pool.query(
          "SELECT COALESCE(sum(h.amount),0) AS amount,COALESCE(sum(h.amount) FILTER(WHERE h.purpose='OPERATING_FLOOR'),0) AS floor FROM synq_alloc_reservations h LEFT JOIN synq_ws_split_admissions a ON a.leg_key=h.reservation_id WHERE h.workspace_id=$1 AND h.status='ACTIVE' AND COALESCE(a.state,'')<>'CONFIRMED'",
          [workspaceId],
        ),
      ]);
    const ledger = new Ledger(new PostgresLedgerStore(pool)),
      asset = token('arc-testnet', 'USDC');
    const liabilities = await ledger.balances(workspaceId, asset.assetId);
    const inFlight = payouts.rows
      .filter((p) => ['READY', 'HOLD', 'SIGNED'].includes(p.state))
      .reduce((sum, p) => sum + BigInt(p.data.amount), 0n);
    const spent = (
      await pool.query(
        "SELECT COALESCE(sum(amount),0) AS amount FROM synq_ws_split_admissions WHERE workspace_id=$1 AND state<>'FAILED' AND (state<>'CONFIRMED' OR executed_at>$2)",
        [workspaceId, at - 86400],
      )
    ).rows[0];
    const active = await new WorkspaceRevenue(this.finance)
      .active(workspaceId)
      .then(
        (value) => ({ value, error: false }),
        () => ({ value: null, error: true }),
      );
    const unknown = async (): Promise<never> => {
      throw new Error('WORKSPACE_PAYABLE_DOCUMENTS_NOT_CONNECTED');
    };
    const world = await buildArcWorldSnapshot({
      now: at,
      primaryChain: 'arc-testnet',
      env: {},
      providers: this.providers,
      readers: {
        user: db(
          { principalId, displayName: 'Workspace member' },
          'authenticated-principal',
        ),
        workspace: db(
          {
            workspaceId,
            name: w.workspace.displayName,
            kind:
              w.workspace.kind === 'PERSONAL' ? 'FREELANCER' : w.workspace.kind,
          },
          'identity',
        ),
        memberships: db(
          w.members.map((m) => ({
            principalId: m.principalId,
            displayName: `${m.wallet.slice(0, 6)}…${m.wallet.slice(-4)}`,
            role:
              m.role === 'ADMIN'
                ? 'ACCOUNTANT'
                : m.role === 'VIEWER'
                  ? 'MEMBER'
                  : m.role,
            verified: true,
            via: 'SIGNED_WALLET_SESSION_AND_MEMBERSHIP',
          })),
          'membership',
        ),
        wallets: db(
          w.workspace.vault
            ? [
                {
                  address: getAddress(w.workspace.vault),
                  chain: 'arc-testnet',
                  ownerPrincipalId: w.workspace.createdBy,
                  kind: 'SAFE_VAULT',
                  role: 'TREASURY',
                  verifiedBy: 'FACTORY_PROVEN_WORKSPACE',
                },
              ]
            : [],
          'vault',
        ),
        balances: async () => {
          const b = await this.balance(workspaceId);
          if (
            !cursor.rows[0] ||
            BigInt(cursor.rows[0].block_number) < BigInt(b.blockNumber)
          )
            throw new Error('WORKSPACE_INDEXER_BEHIND');
          return {
            value: [
              {
                chain: 'arc-testnet',
                account: getAddress(w.workspace.vault!),
                asset: 'USDC',
                baseUnits: b.amount,
              },
            ],
            provenance: 'CHAIN',
            source: `Arc finalized block:${b.blockNumber}`,
            observedAt: b.observedAt,
          };
        },
        reserves: budget.rows[0]
          ? db(
              {
                minimumReserve: String(
                  BigInt(budget.rows[0].data.reserve) >
                    BigInt(holds.rows[0].floor)
                    ? BigInt(budget.rows[0].data.reserve)
                    : BigInt(holds.rows[0].floor),
                ),
                reservations: String(
                  BigInt(holds.rows[0].amount) -
                    BigInt(holds.rows[0].floor) +
                    inFlight,
                ),
                escrow: String(
                  -liabilities.ESCROW_LIABILITY -
                    liabilities.REFUND_LIABILITY -
                    liabilities.UNAPPLIED_RECEIPTS,
                ),
              },
              'signed-budget-and-durable-holds',
            )
          : unknown,
        receivables: db(
          invoices
            .filter((i) => !['DRAFT', 'VOID'].includes(i.status))
            .map((i) => ({
              invoiceId: i.invoiceId,
              number: i.number,
              payer: i.payer.name,
              total: String(i.total),
              amountDue: String(i.total > i.paid ? i.total - i.paid : 0n),
              dueDate: i.dueDate,
              status: i.status,
            })),
          'invoice-store',
        ),
        payables: this.books
          ? async () => {
              const [view, vendors] = await Promise.all([
                this.books!.view(workspaceId, principalId),
                this.finance.workspaces.pool.query(
                  'SELECT id,name,address,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1',
                  [workspaceId],
                ),
              ]);
              const byId = new Map(vendors.rows.map((v) => [String(v.id), v]));
              return {
                value: view.payables
                  .filter((p) => p.status === 'OPEN' || p.status === 'PAID')
                  .map((p) => {
                    const v = byId.get(p.vendorId);
                    return {
                      vendorInvoiceId: p.id,
                      vendorId: p.vendorId,
                      vendorName: v ? String(v.name) : 'Unknown vendor',
                      number: p.number,
                      amount: p.amount,
                      dueOn: p.dueOn,
                      payTo: p.payTo,
                      verifiedPayTo:
                        v && Number(v.eligible_at) <= at
                          ? getAddress(String(v.address))
                          : null,
                      status: p.status === 'PAID' ? 'PAID' : 'OPEN',
                    } as const;
                  }),
                provenance: 'POSTGRES' as const,
                source: `workspace:${workspaceId}:quorum-approved-books`,
                observedAt: at,
              };
            }
          : unknown,
        mandates: active.error
          ? async () => {
              throw new Error('REVENUE_AUTHORITY_UNAVAILABLE');
            }
          : db(
              active.value
                ? [
                    {
                      mandateId: active.value.signed.mandate.mandateId,
                      version: active.value.signed.policy.version,
                      purposes: active.value.signed.mandate.purposes,
                      perActionCap: String(
                        active.value.signed.mandate.perActionCap,
                      ),
                      periodBudget: String(
                        active.value.signed.mandate.periodBudget,
                      ),
                      spentInPeriod: String(spent.amount),
                      recipients: active.value.signed.mandate.recipients.length,
                      validUntil: active.value.signed.mandate.validUntil,
                      revoked: false,
                    },
                  ]
                : [],
              'quorum-revenue-policy',
            ),
        pendingApprovals: db(
          payouts.rows
            .filter((p) => p.state === 'REVIEW')
            .map((p) => ({
              approvalId: p.id,
              kind: 'OVER_CAP_PAYMENT',
              subject: 'Payment request awaiting wallet quorum',
              requestedAt: Number(p.created_at),
              requiredSigner: 'CURRENT_SAFE_QUORUM',
            })),
          'payout-queue',
        ),
        workflows: db(
          payouts.rows
            .filter((p) => ['READY', 'HOLD', 'SIGNED'].includes(p.state))
            .map((p) => ({
              workflowId: p.id,
              kind: 'PAYOUT',
              status: 'WAITING',
              startedAt: Number(p.created_at),
              ref: p.id,
            })),
          'payout-workflows',
        ),
        reconciliation: db(
          {
            status: receipts.rows.some((r) => r.state === 'REVIEW')
              ? 'UNRECONCILED'
              : 'UNKNOWN',
            unreconciled: receipts.rows.filter((r) => r.state === 'REVIEW')
              .length,
            lastRunAt: null,
            detail:
              'Receipt provenance is indexed; full continuous balance reconciliation is not connected.',
          },
          'receipt-review',
        ),
        blockers: db(
          [
            ...(this.books
              ? []
              : [
                  {
                    code: 'PAYABLE_DOCUMENTS_UNAVAILABLE',
                    detail:
                      'No complete workspace AP/bill document source; available cash is not decision-grade.',
                    ref: null,
                  },
                ]),
            ...risk.rows
              .filter((r) =>
                ['HELD', 'IN_REVIEW', 'APPEALED', 'BLOCKED'].includes(r.status),
              )
              .map((r) => ({
                code: 'PERSISTENT_RISK_HOLD',
                detail: `Risk case ${r.case_id}`,
                ref: r.case_id,
              })),
          ],
          'risk-and-capabilities',
        ),
        pendingOutcomes: db(
          payouts.rows
            .filter((p) => ['SIGNED', 'NEEDS_REVIEW'].includes(p.state))
            .map((p) => ({
              ref: p.id,
              kind: 'ARC_PAYOUT',
              tool: null,
              amountBaseUnits: String(p.data.amount),
              since: Number(p.created_at),
              detail:
                'Durable payout outcome requires reconciliation before retry.',
            })),
          'pending-outcomes',
        ),
      },
    });
    return {
      world,
      invoices,
      riskCases: risk.rows.map((r) => ({ id: r.case_id, state: r.status })),
      deals: deals
        ? deals.rows.map((r) => ({ id: r.deal_id, state: r.status }))
        : null,
    };
  }
  async ask(workspaceId: string, principalId: string, raw: unknown) {
    const input = TeamQuestionSchema.parse(raw);
    const cleaned = redact(input.message).value;
    if (typeof cleaned !== 'string' || cleaned !== input.message)
      throw new WorkspaceError('PRIVATE_DATA_REFUSED', 400);
    await this.finance.workspaces.membership(workspaceId, principalId);
    await this.finance.workspaces.throttle(`team:${workspaceId}`, 20);
    const vendors = await this.finance.list(workspaceId, principalId);
    const pay = parseWorkspacePay(input.message);
    if (pay && this.payouts) {
      const matches = vendors.vendors.filter(
        (v) => v.name.toLowerCase() === pay.vendor.toLowerCase(),
      );
      if (matches.length !== 1)
        throw new WorkspaceError('VERIFIED_VENDOR_REQUIRED');
      const payout = await this.payouts.propose(workspaceId, principalId, {
        vendorId: matches[0]!.id,
        amount: pay.amount,
        purpose: pay.purpose,
        obligation: pay.obligation,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        runId: randomUUID(),
        status: 'NEEDS_CLARIFICATION',
        answer:
          'Payment request created for owner wallet review. Chat has not approved it. After the required signatures, the worker rechecks risk, simulation and budgets before Kernel admission and execution.',
        roles: ['PAYMENT'],
        citations: [],
        world: null,
        toolCalls: 1,
        proposals: 'PENDING_OWNER_SIGNATURE',
        payoutId: payout.data.id,
      };
    }
    const data = await this.snapshot(workspaceId, principalId);
    const reasoner = this.reasoner?.();
    const desk: FinanceDesk = {
      workspaceId,
      world: async () => data.world,
      refreshWorld: async () =>
        (await this.snapshot(workspaceId, principalId)).world,
      vendors: vendors.vendors.map((v) => ({
        vendorId: v.id,
        workspaceId,
        name: v.name,
        kind: 'VENDOR',
        addresses: [
          {
            chainId: assetChain(),
            address: getAddress(v.address),
            status: v.status === 'VERIFIED' ? 'VERIFIED' : 'PENDING',
            source: 'SAFE_QUORUM',
            at: v.verifiedAt,
            verifiedBy: 'CURRENT_SAFE_QUORUM',
          },
        ],
      })),
      vendorInvoices: [],
      obligations: [],
      invoices: data.invoices,
      evidence: [],
      ledgerEntries: await new PostgresLedgerStore(
        this.finance.workspaces.pool,
      ).entries(workspaceId),
      budget: this.budget,
      now: this.finance.workspaces.now(),
      today: new Date(this.finance.workspaces.now() * 1000)
        .toISOString()
        .slice(0, 10),
      ...(reasoner ? { reasoner } : {}),
    };
    const reply = await superviseFinance(input.message, desk, {
      origin: 'CHAT',
    });
    // No model/provider raw output or grant material crosses the authenticated API.
    return {
      runId: reply.runId,
      status: reply.status,
      answer: reply.answer,
      roles: reply.handledBy,
      citations: reply.citations,
      world: reply.world,
      toolCalls: reply.toolCalls,
      proposals: 'USE_EXPLICIT_PAYMENT_REQUEST_FOR_WALLET_REVIEW',
    };
  }
}
const assetChain = () => token('arc-testnet', 'USDC').chainId;
