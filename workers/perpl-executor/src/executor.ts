import {
  HedgeGrantSchema,
  artifactHash,
  type HedgeGrant,
  type HedgeGrantAuthority,
} from '@synq/kernel';
import { DurableHedgeGrantAuthority, type PersistedHedge } from './durable.js';
import type { PoolClient } from 'pg';
import {
  OrderFlag,
  OrderStatus,
  OrderStatusReason,
  OrderTracker,
  OrderType,
  PerplError,
  RequestIdSequencer,
  validateOrder,
  type MarketCatalog,
  type OrderSpec,
  type OrderTypeValue,
  type PerplOrder,
  type PerplPosition,
  PerplRestClient,
} from '@synq/plugin-perpl';

export type ExecutionMode = 'REAL_TESTNET' | 'SIMULATION';

export type HedgeExecutionReceipt = {
  executionMode: ExecutionMode;
  grantId: string;
  intentId: string;
  chainId: number;
  accountId: number;
  marketId: number;
  rq: number;
  attempts: { rq: number; status: number | null; reason: number | null }[];
  orderType: number;
  submitted: boolean;
  admission: { code: number; error?: string } | null;
  orderId: number | null;
  finalStatus: number | null;
  statusReason: number | null;
  failureReason: number | null;
  filledSize: string;
  avgFillPrice: string;
  fee: string;
  reconciliation: 'SETTLED' | 'OPEN' | 'FAILED' | 'NO_ORDER' | 'UNKNOWN';
  positionsAfter: PerplPosition[];
  positionsStatus: 'KNOWN' | 'UNKNOWN';
  head: number;
  lastExecBlock: number;
  submittedAt: number;
  reconciledAt: number;
};

const TERMINAL: ReadonlySet<number> = new Set([
  OrderStatus.Filled,
  OrderStatus.Canceled,
  OrderStatus.Expired,
  OrderStatus.Failed,
]);

const RETRY_WITH_NEW_RQ: ReadonlySet<number> = new Set([
  OrderStatusReason.ExceedsLastExecutionBlock,
  OrderStatusReason.OrderDescIdTooLow,
]);

export type ExecutorOptions = {
  rest: PerplRestClient;
  grants: HedgeGrantAuthority | DurableHedgeGrantAuthority;
  catalog: MarketCatalog;
  mode: ExecutionMode;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  postOnly?: boolean;
  // Last rq used per account, shared by the executors of one process.
  requestIds?: Map<number, number>;
};

export class PerplHedgeExecutor {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly requestIds: Map<number, number>;
  constructor(private readonly options: ExecutorOptions) {
    if (options.rest.scope !== 'trade')
      throw new PerplError(
        'SCOPE_INSUFFICIENT',
        'executor needs a trade-scoped key',
      );
    if (
      !(options.rest instanceof PerplRestClient) ||
      options.rest.executionMode !== options.mode ||
      options.rest.network.profile !== 'sandbox/monad-testnet' ||
      options.catalog.network.chainId !== options.rest.network.chainId ||
      options.catalog.network.exchange !== options.rest.network.exchange ||
      options.grants.executionMode !== options.mode ||
      (options.mode === 'REAL_TESTNET' &&
        !(options.grants instanceof DurableHedgeGrantAuthority))
    )
      throw new PerplError(
        'PROFILE_MISMATCH',
        'executor transport/authority/profile mode',
      );
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.requestIds = options.requestIds ?? new Map();
  }

  // Events are matched on (rq, account, order type) and must not predate the
  // submission: an rq refused before reaching the chain does not advance lfr
  // and may be reused, so older events for it belong to a different order.
  private async findByRq(
    rq: number,
    accountId: number,
    order: OrderSpec,
    since: number,
  ): Promise<PerplOrder[]> {
    const [open, history] = await Promise.all([
      this.options.rest.openOrders(),
      this.options.rest.orderHistory(100),
    ]);
    // History is newest first; feed events oldest first.
    return [...history.d.slice().reverse(), ...open.d].filter(
      (o) =>
        o.rq === rq &&
        o.acc === accountId &&
        // A cancel is reported under its own rq with the cancelled order's type.
        (order.t === OrderType.Cancel
          ? o.t === OrderType.Cancel || o.oid === order.oid
          : o.t === order.t) &&
        (o.at?.t === undefined || o.at.t >= since),
    );
  }

  private async submit(
    order: OrderSpec,
    accountId: number,
    marketId: number,
    windowEnd: number,
    since: number,
  ) {
    const { rest } = this.options;
    const statusOf = (r: {
      status: { code: number; error?: string };
      statuses?: { code: number; error?: string }[];
    }) => {
      const s = r.statuses?.[0] ?? r.status;
      return { code: s.code, ...(s.error ? { error: s.error } : {}) };
    };
    try {
      const admission = statusOf(await rest.submitOrders([order]));
      return { admission, submitted: admission.code === 0 };
    } catch (error) {
      if (
        !(error instanceof PerplError) ||
        !['TIMEOUT', 'NETWORK'].includes(error.code)
      )
        throw error;
      // Unknown outcome: reconcile by rq before any retry. A resend with the
      // same rq is at-most-once on the exchange.
      if ((await this.findByRq(order.rq, accountId, order, since)).length)
        return { admission: null, submitted: true };
      const t = await rest.ticker(marketId);
      if ((t.sn ?? Number.MAX_SAFE_INTEGER) >= windowEnd)
        return { admission: null, submitted: false };
      const admission = statusOf(await rest.submitOrders([order]));
      return { admission, submitted: admission.code === 0 };
    }
  }

  private async track(
    order: OrderSpec,
    accountId: number,
    since: number,
  ): Promise<PerplOrder | null> {
    const rq = order.rq;
    const tracker = new OrderTracker();
    let latest: PerplOrder | null = null;
    for (let i = 0; i < (this.options.maxPolls ?? 20); i++) {
      await this.sleep(this.options.pollIntervalMs ?? 1_500);
      for (const o of await this.findByRq(rq, accountId, order, since))
        tracker.ingest(o);
      const outcome = tracker.outcome(rq);
      if (outcome.kind === 'PENDING') continue;
      latest = outcome.order;
      if (
        outcome.kind === 'FAILED' ||
        TERMINAL.has(outcome.order.st) ||
        outcome.order.r
      )
        break;
      if (this.options.postOnly && outcome.order.st === OrderStatus.Open) break;
    }
    return latest;
  }

  async execute(rawGrant: HedgeGrant): Promise<HedgeExecutionReceipt> {
    const grant = HedgeGrantSchema.parse(rawGrant);
    const { rest, catalog, grants } = this.options;
    if (
      grant.executionMode !== this.options.mode ||
      grant.chainId !== rest.network.chainId ||
      grant.exchange !== rest.network.exchange ||
      catalog.network.chainId !== grant.chainId ||
      catalog.network.exchange !== grant.exchange
    )
      throw new PerplError('PROFILE_MISMATCH', 'grant/rest/catalog');
    if (!(grants instanceof DurableHedgeGrantAuthority)) return this.run(grant);
    return grants.store.locked(
      `hedge-account:${grants.store.accountKey(grant)}`,
      async (client) => {
        const record = await grants.store.get(client, grant.intentId);
        if (!record || artifactHash(record.grant) !== artifactHash(grant))
          throw new PerplError('ORDER_INVALID', 'untracked grant');
        if (record.state === 'TERMINAL' && record.receipt)
          return record.receipt;
        const rows = await grants.store.account(
          client,
          grants.store.accountKey(grant),
        );
        if (
          !record.order &&
          !grant.reduceOnly &&
          rows.some(
            (r) =>
              r.grant.intentId !== grant.intentId && r.state === 'PREPARED',
          )
        )
          throw new PerplError(
            'UNKNOWN_OUTCOME',
            'prior account order unresolved',
          );
        if (!record.order) await grants.revalidate(grant);
        return this.run(grant, { authority: grants, client, record, rows });
      },
    );
  }

  private async run(
    rawGrant: HedgeGrant,
    durable?: {
      authority: DurableHedgeGrantAuthority;
      client: PoolClient;
      record: PersistedHedge;
      rows: PersistedHedge[];
    },
  ): Promise<HedgeExecutionReceipt> {
    const { rest, catalog, grants } = this.options;
    const grantView = rawGrant;
    const market = catalog.byIdOrThrow(
      grantView.marketId,
      grantView.reduceOnly,
    );
    const wallet = await rest.wallet();
    const accountId = Number(grantView.perplAccountId);
    const account = wallet.as?.find((a) => a.id === accountId);
    if (!account)
      throw new PerplError('ACCOUNT_MISSING', `account ${accountId}`);
    if (account.fr) throw new PerplError('ORDER_INVALID', 'account frozen');
    const ticker = await rest.ticker(market.id);
    const head = ticker.sn ?? ticker.d[String(market.id)]?.at.b;
    if (head === undefined)
      throw new PerplError('MARKET_STALE', 'no head block');
    // lb 0 lets the gateway apply the market's full window from its own head;
    // our estimate of that window bounds same-rq resends after a timeout.
    const windowEnd = head + market.orderTtlBlocks;
    const sequencer = new RequestIdSequencer(
      Math.max(
        account.lfr,
        this.requestIds.get(accountId) ?? 0,
        ...(durable?.rows.map((r) => r.order?.rq ?? 0) ?? []),
      ),
    );
    const cancel = grantView.kind === 'CANCEL';
    const build = (rq: number): OrderSpec =>
      validateOrder(
        {
          rq,
          mkt: market.id,
          acc: accountId,
          t: grantView.orderType as OrderTypeValue,
          ...(cancel
            ? {
                oid: Number(grantView.orderId),
                s: 0,
                fl: OrderFlag.GoodTillCancel,
                lv: 0,
              }
            : {
                p: Number(grantView.limitPrice),
                s: Number(grantView.maxSize),
                fl: this.options.postOnly
                  ? OrderFlag.PostOnly
                  : OrderFlag.ImmediateOrCancel,
                lv: grantView.reduceOnly ? 0 : grantView.maxLeverageHundredths,
              }),
          lb: 0,
        },
        market,
        head,
      );
    const nextRq = () => {
      const rq = sequencer.next();
      this.requestIds.set(accountId, rq);
      return rq;
    };
    let order = durable?.record.order ?? build(nextRq());
    // Grant check and consumption happen before anything leaves the process.
    const recovery = durable?.record.order !== null && durable !== undefined;
    const grant = durable
      ? durable.authority.codec.verifyOrder(
          rawGrant,
          order,
          Math.floor(this.now() / 1000),
          recovery,
        )
      : (grants as HedgeGrantAuthority).authorizeOrder(
          rawGrant,
          order,
          Math.floor(this.now() / 1000),
        );
    const submittedAt = recovery ? durable!.record.submittedAt : this.now();
    const since = recovery ? durable!.record.since : rest.clock.now() - 5_000;
    if (durable && !recovery) {
      // Fail closed before any increasing order if the venue position read is unavailable.
      if (!grant.reduceOnly) await rest.positions();
      durable.record = {
        ...durable.record,
        state: 'PREPARED',
        order,
        head,
        windowEnd,
        since,
        submittedAt,
      };
      await durable.authority.store.save(durable.client, durable.record);
    }
    let admission: HedgeExecutionReceipt['admission'] = null;
    let submitted = false;
    let latest: PerplOrder | null = null;
    const attempts: {
      rq: number;
      status: number | null;
      reason: number | null;
    }[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (recovery) {
        latest = await this.track(order, accountId, since);
        submitted = latest !== null;
        attempts.push({
          rq: order.rq,
          status: latest?.st ?? null,
          reason: latest?.sr ?? null,
        });
        break;
      }
      ({ admission, submitted } = await this.submit(
        order,
        accountId,
        market.id,
        windowEnd,
        since,
      ));
      latest = submitted ? await this.track(order, accountId, since) : null;
      attempts.push({
        rq: order.rq,
        status: latest?.st ?? null,
        reason: latest?.sr ?? null,
      });
      // Per the venue rules a definitive "not executed" failure may be retried
      // once with a new rq, within the same grant and before it expires.
      const retryable =
        latest?.st === OrderStatus.Failed &&
        RETRY_WITH_NEW_RQ.has(latest.sr ?? -1) &&
        (latest.fs ?? 0) === 0 &&
        Math.floor(this.now() / 1000) < grant.expiresAt &&
        !durable;
      if (!retryable) break;
      order = build(nextRq());
    }
    let positionsStatus: HedgeExecutionReceipt['positionsStatus'];
    let positions: { d: PerplPosition[] };
    try {
      positions = await rest.positions();
      positionsStatus = 'KNOWN';
    } catch {
      positions = { d: [] };
      positionsStatus = 'UNKNOWN';
    }
    const reconciliation: HedgeExecutionReceipt['reconciliation'] =
      positionsStatus === 'UNKNOWN' || (recovery && !latest)
        ? 'UNKNOWN'
        : !submitted
          ? 'NO_ORDER'
          : !latest
            ? 'UNKNOWN'
            : latest.st === OrderStatus.Failed
              ? 'FAILED'
              : TERMINAL.has(latest.st) || latest.r
                ? 'SETTLED'
                : 'OPEN';
    const receipt: HedgeExecutionReceipt = {
      executionMode: this.options.mode,
      grantId: grant.grantId,
      intentId: grant.intentId,
      chainId: grant.chainId,
      accountId,
      marketId: market.id,
      rq: order.rq,
      attempts,
      orderType: order.t,
      submitted,
      admission,
      orderId: latest?.oid ?? null,
      finalStatus: latest?.st ?? null,
      statusReason: latest?.sr ?? null,
      failureReason: latest?.fr ?? null,
      filledSize: String(latest?.fs ?? 0),
      avgFillPrice: String(latest?.fp ?? 0),
      fee: latest?.f ?? '0',
      reconciliation,
      positionsStatus,
      positionsAfter: positions.d.filter((p) => p.acc === accountId),
      head,
      lastExecBlock: windowEnd,
      submittedAt,
      reconciledAt: this.now(),
    };
    if (durable) {
      durable.record.receipt = receipt;
      if (['SETTLED', 'FAILED', 'NO_ORDER'].includes(receipt.reconciliation))
        durable.record.state = 'TERMINAL';
      await durable.authority.store.save(durable.client, durable.record);
    }
    return receipt;
  }
}
