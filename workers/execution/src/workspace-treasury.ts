import { randomUUID } from 'node:crypto';
import {
  erc20Abi,
  getAddress,
  numberToHex,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { SwapKit } from '@circle-fin/swap-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { money } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import {
  KitTxGuard,
  appKitAdapter,
  unitsToKitDecimal,
  verifyExecute,
  type KitStep,
} from '@synq/plugin-circle-app-kit';
import {
  approveSwap,
  normalizeSwapEstimate,
  swapPlan,
  swapPolicy,
} from '@synq/plugin-arc-swap';
import { Ledger, PostgresLedgerStore } from '@synq/ledger';
import { WorkspaceError } from '@synq/workspaces';
import type { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspaceGovernance } from '@synq/workspaces/governance';
import type { WorkspaceBooks } from '@synq/workspaces/books';
import type { SafeAction } from '@synq/kernel/arc-safe-action';
import type { ArcChain } from './arc.js';

/** Hard ceiling for one treasury swap on testnet (0.05 USDC or EURC). */
export const TREASURY_SWAP_MAX = 50_000n;
const Symbol_ = z.enum(['USDC', 'EURC']);
export const TreasurySwapSchema = z
  .strictObject({
    from: Symbol_,
    to: Symbol_,
    amount: z
      .string()
      .regex(/^[1-9][0-9]{0,17}$/)
      .transform(BigInt),
    slippageBps: z.number().int().min(1).max(300).default(100),
  })
  .refine((v) => v.from !== v.to, 'pick two different assets');
type Op = {
  id: string;
  workspaceId: string;
  state: 'APPROVE' | 'EXECUTE' | 'DONE' | 'FAILED';
  data: {
    from: 'USDC' | 'EURC';
    to: 'USDC' | 'EURC';
    amountIn: string;
    slippageBps: number;
    estimatedOut: string;
    minOut: string;
    step: Record<string, unknown> | null;
  };
  approveActionId: string | null;
  executeActionId: string | null;
  evidence: Record<string, unknown> | null;
  lastError: string | null;
};
const json = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_k, x: unknown) =>
      typeof x === 'bigint' ? `${x}n` : x,
    ),
  ) as Record<string, unknown>;
const revive = <T>(v: unknown): T =>
  JSON.parse(JSON.stringify(v), (_k, x: unknown) =>
    typeof x === 'string' && /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x,
  ) as T;
const rowOf = (r: Record<string, unknown>): Op => ({
  id: String(r.id),
  workspaceId: String(r.workspace_id),
  state: r.state as Op['state'],
  data: r.data as Op['data'],
  approveActionId: (r.approve_action_id as string | null) ?? null,
  executeActionId: (r.execute_action_id as string | null) ?? null,
  evidence: (r.evidence as Record<string, unknown> | null) ?? null,
  lastError: (r.last_error as string | null) ?? null,
});

class Captured extends Error {
  constructor(readonly tx: { to: Address; data: Hex }) {
    super('CAPTURED');
  }
}

/**
 * An EIP-1193 provider that presents the workspace Safe to Circle App Kit.
 * Reads go to the Arc RPC. The kit's transaction is checked against the
 * approved plan and captured; it is never signed or broadcast here (the Safe
 * quorum signs it as a vault action). Signature requests are refused, so the
 * kit uses the pre-approved allowance path.
 */
function capturingProvider(input: {
  safe: Address;
  rpcUrl: string;
  guard: KitTxGuard;
}) {
  const chainId = numberToHex(5042002);
  let captured: { to: Address; data: Hex } | null = null;
  const forward = async (method: string, params: readonly unknown[] = []) => {
    const res = await fetch(input.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
    if (body.error)
      throw Object.assign(new Error(body.error.message), body.error);
    return body.result;
  };
  return {
    captured: () => captured,
    provider: {
      on() {},
      removeListener() {},
      async request({
        method,
        params = [],
      }: {
        method: string;
        params?: readonly unknown[];
      }): Promise<unknown> {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [input.safe];
          case 'eth_chainId':
            return chainId;
          case 'wallet_switchEthereumChain':
            return null;
          case 'eth_sendTransaction': {
            const tx = params[0] as { from: Address; to: Address; data: Hex };
            input.guard.check({
              from: getAddress(tx.from),
              to: tx.to,
              data: tx.data,
              value: 0n,
            });
            captured = { to: getAddress(tx.to), data: tx.data };
            throw Object.assign(new Captured(captured), { code: 4001 });
          }
          case 'eth_signTypedData_v4':
          case 'eth_signTypedData':
          case 'personal_sign':
          case 'eth_sign':
          case 'eth_signTransaction':
          case 'wallet_sendCalls':
            throw Object.assign(new Error('the Safe quorum signs on chain'), {
              code: 4001,
            });
          case 'wallet_getCapabilities':
            throw Object.assign(new Error('not supported'), { code: 4200 });
          default:
            return forward(method, params);
        }
      },
    },
  };
}

/**
 * Same-chain USDC/EURC swaps for a workspace vault. Every step is a Safe
 * transaction the current owner quorum signs: first an exact allowance to the
 * registry App Kit adapter, then the adapter call Circle prepared, which is
 * checked against the approved plan (beneficiary is the vault, exact input,
 * output not below the slippage floor) before it is offered for signing. USDC
 * leaves only when free cash after reserves, held funds, money owed to others
 * and bills due in the next 30 days covers it.
 */
export class WorkspaceTreasury {
  readonly governance: WorkspaceGovernance;
  constructor(
    readonly finance: WorkspaceFinance,
    readonly chain: ArcChain,
    private readonly rpcUrl: string,
    readonly books?: WorkspaceBooks,
  ) {
    this.governance = new WorkspaceGovernance(finance);
  }
  private get pool() {
    return this.finance.workspaces.pool;
  }
  private get now() {
    return this.finance.workspaces.now;
  }
  private async owner(workspaceId: string, principalId: string) {
    const m = await this.finance.workspaces.membership(
      workspaceId,
      principalId,
    );
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
  }
  async record(id: string) {
    const r = (
      await this.pool.query('SELECT * FROM synq_ws_treasury_ops WHERE id=$1', [
        id,
      ])
    ).rows[0];
    return r ? rowOf(r) : null;
  }
  async list(workspaceId: string, principalId: string) {
    await this.finance.workspaces.membership(workspaceId, principalId);
    return (
      await this.pool.query(
        'SELECT * FROM synq_ws_treasury_ops WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 50',
        [workspaceId],
      )
    ).rows.map(rowOf);
  }
  private async balance(asset: 'USDC' | 'EURC', who: Address) {
    return this.chain.client.readContract({
      address: token('arc-testnet', asset).address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [who],
    });
  }
  /** USDC the vault may convert without touching reserves, held funds or near-term obligations. */
  async freeUsdc(workspaceId: string, vault: Address) {
    const usdc = token('arc-testnet', 'USDC');
    const [bal, reserved, held, budget] = await Promise.all([
      this.balance('USDC', vault),
      this.pool.query(
        "SELECT COALESCE(sum((data->>'amount')::numeric),0) AS n FROM synq_ws_payouts WHERE workspace_id=$1 AND state IN ('READY','HOLD','SIGNED')",
        [workspaceId],
      ),
      this.pool.query(
        "SELECT COALESCE(sum(h.amount),0) AS n FROM synq_alloc_reservations h LEFT JOIN synq_ws_split_admissions x ON x.leg_key=h.reservation_id WHERE h.workspace_id=$1 AND h.status='ACTIVE' AND COALESCE(x.state,'')<>'CONFIRMED'",
        [workspaceId],
      ),
      this.pool.query(
        "SELECT data->>'reserve' AS reserve FROM synq_ws_budgets WHERE workspace_id=$1",
        [workspaceId],
      ),
    ]);
    const l = await new Ledger(new PostgresLedgerStore(this.pool)).balances(
      workspaceId,
      usdc.assetId,
    );
    const restricted =
      -l.REFUND_LIABILITY - l.ESCROW_LIABILITY - l.UNAPPLIED_RECEIPTS;
    let due = 0n;
    if (this.books) {
      const horizon = new Date((this.now() + 30 * 86400) * 1000)
        .toISOString()
        .slice(0, 10);
      const r = this.books.reader(workspaceId);
      for (const p of await r.payables())
        if (p.dueOn <= horizon) due += p.amount;
      for (const b of await r.bills())
        if (b.nextDueOn <= horizon) due += b.amount;
    }
    return (
      bal -
      BigInt(reserved.rows[0].n) -
      BigInt(held.rows[0].n) -
      restricted -
      BigInt(budget.rows[0]?.reserve ?? 0) -
      due
    );
  }
  private async quote(
    vault: Address,
    terms: z.output<typeof TreasurySwapSchema>,
  ) {
    const tin = token('arc-testnet', terms.from);
    const kit = new SwapKit();
    const cap = capturingProvider({
      safe: vault,
      rpcUrl: this.rpcUrl,
      guard: new KitTxGuard(vault, [
        // Estimates never send; a send here is refused.
        {
          kind: 'ALLOWANCE',
          token: vault,
          spender: vault,
          maxAmount: 0n,
          optional: false,
        },
        {
          kind: 'EXECUTE',
          adapter: vault,
          beneficiary: vault,
          tokenIn: vault,
          maxAmountIn: 0n,
          tokenOut: vault,
          minOut: 0n,
          maxFeeIn: 0n,
          allowedTokens: [],
          nowSec: 0n,
          maxDeadlineAheadSec: 0n,
        },
      ]),
    });
    const adapter = await createViemAdapterFromProvider({
      provider: cap.provider as never,
    });
    const params = {
      from: { adapter, chain: 'Arc_Testnet' as const },
      tokenIn: terms.from,
      tokenOut: terms.to,
      amountIn: unitsToKitDecimal(terms.amount, tin.decimals),
      config: {
        slippageBps: terms.slippageBps,
        allowanceStrategy: 'approve' as const,
      },
    };
    const observedAt = Date.now();
    const estimate = await kit.estimate(params).catch(() => {
      // Testnet liquidity can vanish; no quote means nothing is proposed.
      throw new WorkspaceError('TREASURY_NO_QUOTE', 503);
    });
    const approved = approveSwap(
      normalizeSwapEstimate(estimate, { observedAt, wallet: vault }),
      swapPolicy({
        chain: 'arc-testnet',
        pairs: [
          ['USDC', 'EURC'],
          ['EURC', 'USDC'],
        ],
        maxSlippageBps: terms.slippageBps,
        maxAmountIn: money(tin, TREASURY_SWAP_MAX),
      }),
      Date.now(),
    );
    return { kit, params, approved };
  }

  /** Step 1: an owner proposes a swap; the quorum signs the exact allowance. */
  async proposeSwap(workspaceId: string, principalId: string, raw: unknown) {
    await this.owner(workspaceId, principalId);
    const terms = TreasurySwapSchema.parse(raw);
    if (terms.amount > TREASURY_SWAP_MAX)
      throw new WorkspaceError('TREASURY_AMOUNT_ABOVE_CAP');
    const a = await this.finance.authority(workspaceId);
    if (terms.from === 'USDC') {
      if ((await this.freeUsdc(workspaceId, a.vault)) < terms.amount)
        throw new WorkspaceError('TREASURY_RESERVES_DUE');
    } else if ((await this.balance(terms.from, a.vault)) < terms.amount)
      throw new WorkspaceError('TREASURY_INSUFFICIENT_BALANCE');
    const { approved } = await this.quote(a.vault, terms);
    const id = randomUUID(),
      tin = token('arc-testnet', terms.from);
    const allowance = await this.chain.client.readContract({
      address: tin.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [a.vault, appKitAdapter()],
    });
    const state = allowance >= terms.amount ? 'EXECUTE' : 'APPROVE';
    await this.pool.query(
      'INSERT INTO synq_ws_treasury_ops(id,workspace_id,kind,data,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)',
      [
        id,
        workspaceId,
        'SWAP',
        {
          from: terms.from,
          to: terms.to,
          amountIn: String(terms.amount),
          slippageBps: terms.slippageBps,
          estimatedOut: String(approved.quote.estimatedOut.baseUnits),
          minOut: String(approved.minOut.baseUnits),
          step: null,
        },
        state,
        this.now(),
      ],
    );
    if (state === 'APPROVE') {
      const action = await this.governance.proposeTreasury(
        workspaceId,
        principalId,
        {
          kind: 'TREASURY_APPROVE',
          treasuryOpId: id,
          spender: appKitAdapter(),
          approveToken: tin.address,
          amount: String(terms.amount),
        },
      );
      await this.pool.query(
        'UPDATE synq_ws_treasury_ops SET approve_action_id=$2 WHERE id=$1',
        [id, action.action.id],
      );
    }
    return this.record(id);
  }

  /**
   * Step 2 (after the allowance confirms): a fresh quote, Circle's prepared
   * adapter call captured for the vault and checked against the plan, then
   * offered to the quorum as one vault action.
   */
  async prepareExecution(workspaceId: string, principalId: string, id: string) {
    await this.owner(workspaceId, principalId);
    const op = await this.record(id);
    if (!op || op.workspaceId !== workspaceId)
      throw new WorkspaceError('TREASURY_OP_NOT_FOUND', 404);
    if (op.state !== 'EXECUTE')
      throw new WorkspaceError('TREASURY_ALLOWANCE_PENDING');
    if (op.executeActionId) {
      const prior = await this.governance.record(op.executeActionId);
      if (
        prior &&
        (prior.state === 'READY' ||
          (prior.state === 'REVIEW' && prior.action.expiresAt > this.now()))
      )
        return op;
    }
    const a = await this.finance.authority(workspaceId);
    const terms = TreasurySwapSchema.parse({
      from: op.data.from,
      to: op.data.to,
      amount: op.data.amountIn,
      slippageBps: op.data.slippageBps,
    });
    const { kit, params, approved } = await this.quote(a.vault, terms);
    if (approved.minOut.baseUnits < (BigInt(op.data.minOut) * 99n) / 100n)
      throw new WorkspaceError('TREASURY_PRICE_MOVED');
    const steps = swapPlan({
      owner: a.vault,
      approved,
      nowSec: BigInt(this.now()),
    });
    const exec = steps.find((s) => s.kind === 'EXECUTE')!;
    const guard = new KitTxGuard(a.vault, steps);
    const cap = capturingProvider({
      safe: a.vault,
      rpcUrl: this.rpcUrl,
      guard,
    });
    const adapter = await createViemAdapterFromProvider({
      provider: cap.provider as never,
    });
    await kit
      .swap({ ...params, from: { ...params.from, adapter } })
      .catch(() => undefined);
    const tx = cap.captured();
    if (!tx) throw new WorkspaceError('TREASURY_EXECUTION_NOT_PREPARED', 503);
    verifyExecute({ from: a.vault, to: tx.to, data: tx.data }, exec);
    const action = await this.governance.proposeTreasury(
      workspaceId,
      principalId,
      {
        kind: 'TREASURY_EXECUTE',
        treasuryOpId: id,
        target: tx.to,
        data: tx.data.toLowerCase(),
        tokenIn: exec.tokenIn,
        amountIn: String(exec.maxAmountIn),
        tokenOut: exec.tokenOut,
        minOut: String(exec.minOut),
      },
    );
    await this.pool.query(
      "UPDATE synq_ws_treasury_ops SET execute_action_id=$2,data=jsonb_set(data,'{step}',$3::jsonb),updated_at=$4 WHERE id=$1",
      [id, action.action.id, JSON.stringify(json(exec)), this.now()],
    );
    return this.record(id);
  }
}

/**
 * Executor-side check before the operator relays a treasury Safe action: the
 * action must be the current step of its operation and match its stored terms;
 * an execute call is re-verified against the stored plan.
 */
export async function assertTreasuryAction(
  sql: {
    query(
      q: string,
      v?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
  },
  a: SafeAction,
) {
  if (a.kind !== 'TREASURY_APPROVE' && a.kind !== 'TREASURY_EXECUTE') return;
  const r = (
    await sql.query(
      'SELECT * FROM synq_ws_treasury_ops WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
      [a.treasuryOpId, a.workspaceId],
    )
  ).rows[0];
  if (!r) throw new WorkspaceError('TREASURY_OP_NOT_FOUND', 404);
  const op = rowOf(r);
  const tin = token('arc-testnet', op.data.from).address;
  if (a.kind === 'TREASURY_APPROVE') {
    if (
      op.state !== 'APPROVE' ||
      op.approveActionId !== a.id ||
      getAddress(a.spender) !== getAddress(appKitAdapter()) ||
      getAddress(a.approveToken) !== getAddress(tin) ||
      a.amount !== op.data.amountIn
    )
      throw new WorkspaceError('TREASURY_ACTION_MISMATCH');
    return;
  }
  if (op.state !== 'EXECUTE' || op.executeActionId !== a.id || !op.data.step)
    throw new WorkspaceError('TREASURY_ACTION_MISMATCH');
  const step = revive<Extract<KitStep, { kind: 'EXECUTE' }>>(op.data.step);
  if (
    getAddress(a.tokenIn) !== getAddress(step.tokenIn) ||
    BigInt(a.amountIn) !== step.maxAmountIn ||
    getAddress(a.tokenOut) !== getAddress(step.tokenOut) ||
    BigInt(a.minOut) !== step.minOut ||
    BigInt(a.amountIn) > BigInt(op.data.amountIn)
  )
    throw new WorkspaceError('TREASURY_ACTION_MISMATCH');
  verifyExecute(
    { from: getAddress(a.safe), to: a.target, data: a.data as Hex },
    { ...step, nowSec: step.nowSec },
  );
}
