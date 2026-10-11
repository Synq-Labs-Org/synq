import { PerplError } from './errors.js';
import type { MarketSpec } from './markets.js';
import type { PerplOrder } from './schemas.js';

export const OrderType = Object.freeze({
  OpenLong: 1,
  OpenShort: 2,
  CloseLong: 3,
  CloseShort: 4,
  Cancel: 5,
  IncreasePositionCollateral: 6,
  Change: 7,
} as const);
export type OrderTypeValue = (typeof OrderType)[keyof typeof OrderType];
export const OrderFlag = Object.freeze({
  GoodTillCancel: 0,
  PostOnly: 1,
  FillOrKill: 2,
  ImmediateOrCancel: 4,
} as const);
export const OrderStatus = Object.freeze({
  Pending: 1,
  Open: 2,
  PartiallyFilled: 3,
  Filled: 4,
  Canceled: 5,
  Expired: 6,
  Failed: 7,
  Untriggered: 8,
  Triggered: 9,
  Executed: 10,
} as const);
export const OrderStatusReason = Object.freeze({
  ExceedsLastExecutionBlock: 14,
  OrderDescIdTooLow: 32,
  OrderForwardingNotAllowed: 34,
} as const);

// Synq only ever submits these order types; IncreasePositionCollateral and
// Change are not reachable from a hedge grant.
export const SUBMITTABLE_ORDER_TYPES: ReadonlySet<number> = new Set([
  OrderType.OpenLong,
  OrderType.OpenShort,
  OrderType.CloseLong,
  OrderType.CloseShort,
  OrderType.Cancel,
]);

export type OrderSpec = {
  rq: number;
  mkt: number;
  acc: number;
  oid?: number;
  t: OrderTypeValue;
  p?: number;
  s: number;
  ms?: number;
  mnp?: number;
  fl: number;
  lv: number;
  lb: number;
};

const FLAGS = new Set<number>(Object.values(OrderFlag));

export function validateOrder(
  spec: OrderSpec,
  market: MarketSpec,
  head: number,
): OrderSpec {
  const fail = (m: string) => {
    throw new PerplError('ORDER_INVALID', m);
  };
  if (!SUBMITTABLE_ORDER_TYPES.has(spec.t)) fail(`order type ${spec.t}`);
  if (spec.mkt !== market.id) fail('market mismatch');
  for (const [k, v] of Object.entries(spec))
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      fail(`${k} must be a non-negative safe integer`);
  if (spec.rq <= 0) fail('rq must be positive');
  if (spec.acc <= 0) fail('account required');
  if (!FLAGS.has(spec.fl)) fail('flags');
  if (spec.mnp !== undefined && spec.mnp > 65_535) fail('mnp out of range');
  if (
    spec.lb !== 0 &&
    (spec.lb <= head || spec.lb > head + market.orderTtlBlocks)
  )
    fail(`lb ${spec.lb} outside (${head}, ${head + market.orderTtlBlocks}]`);
  if (spec.t === OrderType.Cancel) {
    if (!spec.oid) fail('cancel needs oid');
    return spec;
  }
  if (spec.s <= 0) fail('size must be positive');
  if (spec.p === undefined) fail('price required (0 = market)');
  if (
    spec.p === 0 &&
    spec.fl !== OrderFlag.ImmediateOrCancel &&
    spec.fl !== OrderFlag.FillOrKill
  )
    fail('market orders must be IOC or FOK');
  if (spec.t === OrderType.OpenLong || spec.t === OrderType.OpenShort) {
    if (spec.lv <= 0 || spec.lv > market.maxLeverageHundredths)
      fail(
        `leverage ${spec.lv} exceeds market max ${market.maxLeverageHundredths}`,
      );
  }
  return spec;
}

// rq must be strictly increasing per account, seeded from Account.lfr.
export class RequestIdSequencer {
  private last: number;
  constructor(lfr: number) {
    if (!Number.isSafeInteger(lfr) || lfr < 0)
      throw new PerplError('INVALID_RESPONSE', 'lfr');
    this.last = lfr;
  }
  observe(lfr: number): void {
    if (lfr > this.last) this.last = lfr;
  }
  next(): number {
    this.last += 1;
    return this.last;
  }
  current(): number {
    return this.last;
  }
}

export type OrderOutcome =
  | { kind: 'PENDING' }
  | { kind: 'FAILED'; order: PerplOrder }
  | { kind: 'LIVE'; order: PerplOrder };

const NON_FAILURE: ReadonlySet<number> = new Set([2, 3, 4, 5, 8, 9, 10]);

// Client-side deduplication per the docs: the first non-failure status for an
// rq is definitive; if only failures arrive, the first failure counts. Later
// updates for a definitive order still refresh fill progress.
export class OrderTracker {
  private readonly definitive = new Map<number, PerplOrder>();
  private readonly firstFailure = new Map<number, PerplOrder>();
  private readonly latest = new Map<number, PerplOrder>();
  private readonly superseded = new Set<number>();
  private readonly seen = new Set<string>();
  ingest(order: PerplOrder): boolean {
    const key = `${order.rq}:${order.st}:${order.fs ?? 0}:${order.at?.b ?? ''}:${order.at?.tx ?? ''}:${order.at?.l ?? ''}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.superseded.has(order.rq) && order.st === OrderStatus.Failed)
      return false;
    if (NON_FAILURE.has(order.st)) {
      if (!this.definitive.has(order.rq)) this.definitive.set(order.rq, order);
      this.latest.set(order.rq, order);
      return true;
    }
    if (order.st === OrderStatus.Failed) {
      if (this.definitive.has(order.rq) || this.firstFailure.has(order.rq))
        return false;
      this.firstFailure.set(order.rq, order);
      return true;
    }
    this.latest.set(order.rq, order);
    return true;
  }
  supersede(rq: number): void {
    this.superseded.add(rq);
  }
  outcome(rq: number): OrderOutcome {
    const live = this.latest.get(rq);
    if (this.definitive.has(rq) && live) return { kind: 'LIVE', order: live };
    const failed = this.firstFailure.get(rq);
    if (failed) return { kind: 'FAILED', order: failed };
    return { kind: 'PENDING' };
  }
}

export function isForwardingDisabled(order: PerplOrder): boolean {
  return (
    order.st === OrderStatus.Failed &&
    order.sr === OrderStatusReason.OrderForwardingNotAllowed
  );
}
