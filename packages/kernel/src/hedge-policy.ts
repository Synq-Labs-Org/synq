import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  AddressSchema,
  AmountSchema,
  AssetSchema,
  BpsSchema,
  ChainIdSchema,
  GroupIdSchema,
  HashSchema,
  IdSchema,
  MandateIdSchema,
  MemberIdSchema,
  TimestampSchema,
  type Mandate,
  type Tier,
  HedgeIntentSchema,
  HedgeActionKindSchema,
  HedgeSideSchema,
  RISK_REDUCING_KINDS,
  type HedgeIntent,
  type HedgeActionKind,
  type HedgeSide,
} from '@synq/schemas';
import { artifactHash, type Hash } from './canonical.js';
import { requiredApprovalsFor } from './policy.js';

// Hedge actions Synq can ever authorize on a perp venue. There is no
// withdraw, transfer or collateral-decrease kind: no hedge decision can
// produce one.
// Perpl OrderType values each kind/side may compile to.
const PERPL_ORDER_TYPE: Record<HedgeActionKind, Record<HedgeSide, number>> = {
  OPEN: { SHORT: 2, LONG: 1 },
  INCREASE: { SHORT: 2, LONG: 1 },
  REDUCE: { SHORT: 4, LONG: 3 },
  CLOSE: { SHORT: 4, LONG: 3 },
  CANCEL: { SHORT: 5, LONG: 5 },
};
export function perplOrderTypeFor(
  kind: HedgeActionKind,
  side: HedgeSide,
): number {
  return PERPL_ORDER_TYPE[kind][side];
}

const amountLe = (a: string, b: string) => BigInt(a) <= BigInt(b);
const BaseAssetSchema = z.string().regex(/^[A-Z0-9]{2,12}$/);

export const HedgeMandateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    hedgeMandateId: IdSchema,
    version: z.number().int().positive(),
    status: z.enum(['ACTIVE', 'CLOSE_ONLY', 'REVOKED']),
    groupId: GroupIdSchema,
    parentMandateId: MandateIdSchema,
    parentMandateVersion: z.number().int().positive(),
    chainId: ChainIdSchema,
    venue: z.literal('perpl'),
    exchange: AddressSchema,
    perplAccountId: AmountSchema,
    collateralAsset: AssetSchema,
    hedgedAsset: BaseAssetSchema,
    allowedMarkets: z
      .array(
        z.strictObject({
          marketId: z.number().int().positive(),
          base: BaseAssetSchema,
        }),
      )
      .min(1),
    targetHedgeRatioBps: BpsSchema,
    maxHedgeRatioBps: BpsSchema,
    maxLeverageHundredths: z.number().int().min(100).max(10_000),
    maxNotional: AmountSchema,
    maxCollateral: AmountSchema,
    minLiquidationBufferBps: BpsSchema,
    minAdjustNotional: AmountSchema,
    maxSlippageBps: BpsSchema,
    maxMarketDataAgeMs: z.number().int().positive().max(600_000),
    grantTtlSeconds: z.number().int().positive().max(3_600),
    approval: z.strictObject({
      autoMaxNotional: AmountSchema,
      reviewMaxNotional: AmountSchema,
    }),
    validAfter: TimestampSchema,
    validUntil: TimestampSchema,
  })
  .superRefine((v, ctx) => {
    const issue = (path: string[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    if (v.validUntil <= v.validAfter) issue(['validUntil'], 'window');
    if (v.targetHedgeRatioBps > v.maxHedgeRatioBps)
      issue(['targetHedgeRatioBps'], 'target exceeds maximum');
    if (!amountLe(v.approval.autoMaxNotional, v.approval.reviewMaxNotional))
      issue(['approval'], 'auto band exceeds review band');
    if (v.collateralAsset.chainId !== v.chainId)
      issue(['collateralAsset'], 'collateral on another chain');
    if (!v.allowedMarkets.every((m) => m.base === v.hedgedAsset))
      issue(['allowedMarkets'], 'market does not hedge the mandated asset');
  });
export type HedgeMandate = z.output<typeof HedgeMandateSchema>;

export type HedgeRejectionCode =
  | 'INVALID_HEDGE'
  | 'GROUP_MISMATCH'
  | 'MANDATE_REVOKED'
  | 'MANDATE_VERSION'
  | 'NETWORK_MISMATCH'
  | 'HEDGING_NOT_ENABLED'
  | 'ACCOUNT_MISMATCH'
  | 'MARKET_FORBIDDEN'
  | 'MARKET_CLOSED'
  | 'STALE_MARKET'
  | 'EXPIRED'
  | 'CLOSE_ONLY'
  | 'HEDGE_DIRECTION'
  | 'LEVERAGE_CAP'
  | 'NOTIONAL_CAP'
  | 'HEDGE_EXCEEDS_MANDATE'
  | 'LIQUIDATION_BUFFER'
  | 'WRONG_COLLATERAL'
  | 'COLLATERAL_CAP'
  | 'COLLATERAL_EXCEEDS_FREE_TREASURY'
  | 'RISK_PACKET_MISMATCH'
  | 'ECONOMIC_MISMATCH'
  | 'PARENT_BUDGET';

export const HedgeMarketEvidenceSchema = z.strictObject({
  marketId: z.number().int().positive(),
  base: z.string(),
  chainId: ChainIdSchema,
  exchange: AddressSchema,
  priceDecimals: z.number().int().min(0).max(18),
  sizeDecimals: z.number().int().min(0).max(18),
  maintenanceMarginBps: z.number().int().min(0).max(9999),
  maxLeverageHundredths: z.number().int().min(0).max(10_000),
  executionMode: z.enum(['REAL_TESTNET', 'SIMULATION']),
  source: z.string().min(1).max(200),
  mark: AmountSchema,
  bid: AmountSchema,
  ask: AmountSchema,
  at: z.number().int().nonnegative(),
});
export type HedgeMarketEvidence = Omit<
  z.input<typeof HedgeMarketEvidenceSchema>,
  'chainId'
> & { chainId: number };
export type HedgeEvidenceMode = 'REAL_TESTNET' | 'SIMULATION';
const RiskEvidenceSchema = z
  .object({
    asOf: z.number().int().nonnegative(),
    valueDecimals: z.number().int().min(0).max(18),
    blocked: z.boolean(),
    perpFreeCollateral: AmountSchema,
    assets: z.array(
      z
        .object({
          asset: z.string(),
          spotValue: AmountSchema,
          perpNotional: z.string().regex(/^-?[0-9]+$/),
          price: AmountSchema,
          priceDecimals: z.number().int(),
          priceAt: z.number().int(),
        })
        .passthrough(),
    ),
    positions: z.array(
      z
        .object({
          marketId: z.number().int(),
          side: z.enum(['SHORT', 'LONG']),
          size: AmountSchema,
          collateral: AmountSchema,
          liquidationDistanceBps: z.number().int(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type HedgeFacts = {
  now: number;
  nowMs: number;
  marketOpen: boolean;
  expectedCollateral: { chainId: number; address: string; decimals: number };
  freeCoreTreasury: string;
  perpFreeCollateral: string;
  currentHedgeNotional: string;
  spotExposure: string;
  riskPacketHash: string;
  risk?: unknown;
  market?: HedgeMarketEvidence;
  parentSpent?: string;
  pendingNotional?: string;
  reservedTreasury?: string;
  reservedPerpCollateral?: string;
  pendingHedgeNotional?: string;
};

export type HedgeDecision = Readonly<{
  schemaVersion: 1;
  intentHash: Hash;
  intentId: string;
  status: 'AUTHORIZED' | 'PENDING_APPROVAL' | 'REJECTED';
  mode: 'NORMAL' | 'CLOSE_ONLY';
  riskReducing: boolean;
  tier: Tier;
  requiredApprovals: number;
  matchedRules: string[];
  rejection: { rule: string; code: HedgeRejectionCode } | null;
  treasuryReservation: string;
  evidenceMode: HedgeEvidenceMode;
  evidenceExpiresAt: number;
  evaluatedAt: number;
}>;

class Stop {
  constructor(
    readonly rule: string,
    readonly code: HedgeRejectionCode,
  ) {}
}

export function hedgeIntentHash(intent: HedgeIntent): Hash {
  return artifactHash(HedgeIntentSchema.parse(intent));
}

export class HedgePolicy {
  evaluate(input: {
    intent: unknown;
    hedgeMandate: unknown;
    mandate: Mandate;
    facts: HedgeFacts;
  }): HedgeDecision {
    const { mandate, facts } = input;
    const parsedIntent = HedgeIntentSchema.safeParse(input.intent);
    const parsedMandate = HedgeMandateSchema.safeParse(input.hedgeMandate);
    if (!parsedIntent.success || !parsedMandate.success)
      return {
        schemaVersion: 1,
        intentHash: artifactHash(input.intent ?? null),
        intentId: '',
        status: 'REJECTED',
        mode: 'NORMAL',
        riskReducing: false,
        tier: 'BLOCKED',
        requiredApprovals: 0,
        matchedRules: [],
        rejection: { rule: 'schema', code: 'INVALID_HEDGE' },
        treasuryReservation: '0',
        evidenceMode: 'SIMULATION',
        evidenceExpiresAt: 0,
        evaluatedAt: facts.now,
      };
    const intent = parsedIntent.data;
    const hm = parsedMandate.data;
    const intentHash = artifactHash(intent);
    const reducing = RISK_REDUCING_KINDS.has(intent.kind);
    const matchedRules: string[] = [];
    let mode: HedgeDecision['mode'] = 'NORMAL';
    let tier: Tier = 'AUTO';
    let reservation = 0n;
    let evidenceMode: HedgeEvidenceMode = 'SIMULATION';
    let evidenceExpiresAt = 0;
    const check = (rule: string, ok: boolean, code: HedgeRejectionCode) => {
      if (!ok) throw new Stop(rule, code);
      matchedRules.push(rule);
    };
    // Conditions under which only risk-reducing actions remain allowed.
    const closeOnly = (rule: string, ok: boolean, code: HedgeRejectionCode) => {
      if (ok) return matchedRules.push(rule);
      mode = 'CLOSE_ONLY';
      if (!reducing) throw new Stop(rule, code);
      matchedRules.push(`${rule}:close-only`);
    };
    let rejection: HedgeDecision['rejection'] = null;
    try {
      check(
        'hedge-mandate.governance',
        mandate.hedgePolicyHash === undefined ||
          mandate.hedgePolicyHash === artifactHash(hm),
        'MANDATE_VERSION',
      );
      check(
        'group',
        intent.groupId === hm.groupId && hm.groupId === mandate.groupId,
        'GROUP_MISMATCH',
      );
      check(
        'hedge-mandate.version',
        intent.hedgeMandateId === hm.hedgeMandateId &&
          intent.hedgeMandateVersion === hm.version &&
          hm.parentMandateId === mandate.mandateId &&
          hm.parentMandateVersion === mandate.version,
        'MANDATE_VERSION',
      );
      check('hedge-mandate.active', hm.status !== 'REVOKED', 'MANDATE_REVOKED');
      check(
        'network',
        intent.chainId === hm.chainId && hm.chainId === mandate.network.chainId,
        'NETWORK_MISMATCH',
      );
      check(
        'venue.binding',
        mandate.bindings.some(
          (b) =>
            b.pluginId === 'perpl' &&
            b.action === 'PERP_HEDGE' &&
            b.target === hm.exchange,
        ) &&
          mandate.inputAsset.chainId === hm.chainId &&
          mandate.inputAsset.address === hm.collateralAsset.address &&
          mandate.inputAsset.decimals === hm.collateralAsset.decimals,
        'NETWORK_MISMATCH',
      );
      check(
        'account',
        intent.perplAccountId === hm.perplAccountId,
        'ACCOUNT_MISMATCH',
      );
      check(
        'market.allowlist',
        hm.allowedMarkets.some(
          (m) => m.marketId === intent.marketId && m.base === intent.base,
        ),
        'MARKET_FORBIDDEN',
      );
      check(
        'collateral.identity',
        hm.collateralAsset.chainId === facts.expectedCollateral.chainId &&
          hm.collateralAsset.address ===
            facts.expectedCollateral.address.toLowerCase() &&
          hm.collateralAsset.decimals === facts.expectedCollateral.decimals,
        'WRONG_COLLATERAL',
      );
      check(
        'intent.expiry',
        facts.now < intent.expiresAt &&
          intent.createdAt <= facts.now &&
          intent.expiresAt - intent.createdAt <= hm.grantTtlSeconds,
        'EXPIRED',
      );
      closeOnly(
        'parent.active',
        mandate.status === 'ACTIVE',
        'MANDATE_REVOKED',
      );
      closeOnly('hedge-mandate.mode', hm.status === 'ACTIVE', 'CLOSE_ONLY');
      closeOnly(
        'window',
        facts.now >= hm.validAfter &&
          facts.now < hm.validUntil &&
          facts.now >= mandate.validAfter &&
          facts.now < mandate.validUntil,
        'EXPIRED',
      );
      closeOnly('market.open', facts.marketOpen, 'MARKET_CLOSED');
      closeOnly(
        'market.fresh',
        intent.marketDataAt <= facts.nowMs &&
          facts.nowMs - intent.marketDataAt <=
            Math.min(hm.maxMarketDataAgeMs, mandate.quoteTtlSeconds * 1000),
        'STALE_MARKET',
      );
      const evidence = RiskEvidenceSchema.safeParse(facts.risk);
      const parsedMarket = HedgeMarketEvidenceSchema.safeParse(facts.market);
      const market = parsedMarket.success ? parsedMarket.data : undefined;
      check(
        'risk.evidence',
        evidence.success && market !== undefined,
        'RISK_PACKET_MISMATCH',
      );
      if (!evidence.success || !market)
        throw new Stop('risk.evidence', 'RISK_PACKET_MISMATCH');
      const risk = evidence.data;
      evidenceMode = market.executionMode;
      evidenceExpiresAt = Math.floor(
        Math.min(
          market.at +
            Math.min(hm.maxMarketDataAgeMs, mandate.quoteTtlSeconds * 1000),
          risk.asOf +
            Math.min(hm.maxMarketDataAgeMs, mandate.evidenceTtlSeconds * 1000),
        ) / 1000,
      );
      check(
        'risk.units',
        risk.valueDecimals === hm.collateralAsset.decimals,
        'ECONOMIC_MISMATCH',
      );
      check(
        'risk.binding',
        artifactHash(facts.risk) === intent.riskPacketHash &&
          intent.riskPacketHash === facts.riskPacketHash,
        'RISK_PACKET_MISMATCH',
      );
      check(
        'market.identity',
        market.marketId === intent.marketId &&
          market.base === intent.base &&
          market.chainId === hm.chainId &&
          market.exchange.toLowerCase() === hm.exchange &&
          Number.isSafeInteger(market.sizeDecimals) &&
          market.sizeDecimals >= 0 &&
          market.sizeDecimals <= 18 &&
          Number.isSafeInteger(market.priceDecimals) &&
          market.priceDecimals >= 0 &&
          market.priceDecimals <= 18 &&
          market.maintenanceMarginBps >= 0 &&
          market.maintenanceMarginBps < 10000,
        'ECONOMIC_MISMATCH',
      );
      const asset = risk.assets.find((a) => a.asset === intent.base);
      check('risk.asset', asset !== undefined, 'RISK_PACKET_MISMATCH');
      const position = risk.positions.find(
        (p) => p.marketId === intent.marketId && p.side === intent.side,
      );
      const spotValue = BigInt(asset?.spotValue ?? '0');
      const currentShort =
        BigInt(asset?.perpNotional ?? '0') < 0n
          ? -BigInt(asset!.perpNotional)
          : 0n;
      check(
        'risk.exposure',
        facts.spotExposure === spotValue.toString() &&
          facts.currentHedgeNotional === currentShort.toString() &&
          facts.perpFreeCollateral === risk.perpFreeCollateral,
        'RISK_PACKET_MISMATCH',
      );
      const mark = BigInt(market.mark);
      check(
        'market.time-binding',
        market.at === intent.marketDataAt &&
          market.at <= facts.nowMs &&
          risk.asOf <= facts.nowMs,
        'STALE_MARKET',
      );
      closeOnly(
        'risk.fresh',
        !risk.blocked &&
          facts.nowMs - risk.asOf <=
            Math.min(hm.maxMarketDataAgeMs, mandate.evidenceTtlSeconds * 1000),
        'STALE_MARKET',
      );
      if (reducing) {
        const slip = BigInt(
          Math.min(hm.maxSlippageBps, mandate.maxSlippageBps),
        );
        const limit = BigInt(intent.limitPrice);
        check(
          'reduction.price',
          mark > 0n &&
            limit >= (mark * (10000n - slip) + 9999n) / 10000n &&
            limit <= (mark * (10000n + slip)) / 10000n,
          'ECONOMIC_MISMATCH',
        );
      }
      const unit = 10n ** BigInt(market.sizeDecimals + market.priceDecimals);
      const valueUnit = 10n ** BigInt(risk.valueDecimals);
      const size = BigInt(intent.size);
      const derivedNotional = (size * mark * valueUnit) / unit;
      if (intent.kind !== 'CANCEL') {
        check(
          'economics.notional',
          mark > 0n && BigInt(intent.notional) === derivedNotional,
          'ECONOMIC_MISMATCH',
        );
        if (reducing)
          check(
            'reduction.position',
            position !== undefined && size <= BigInt(position.size),
            'ECONOMIC_MISMATCH',
          );
      }
      if (!reducing) {
        check(
          'risk.healthy',
          !risk.blocked &&
            risk.asOf <= facts.nowMs &&
            facts.nowMs - risk.asOf <=
              Math.min(
                hm.maxMarketDataAgeMs,
                mandate.evidenceTtlSeconds * 1000,
              ) &&
            market.at === intent.marketDataAt &&
            market.at <= facts.nowMs &&
            facts.nowMs - market.at <=
              Math.min(hm.maxMarketDataAgeMs, mandate.quoteTtlSeconds * 1000) &&
            asset?.price === market.mark &&
            asset.priceDecimals === market.priceDecimals &&
            facts.nowMs - asset.priceAt <= hm.maxMarketDataAgeMs,
          'STALE_MARKET',
        );
        const slip = BigInt(
          Math.min(hm.maxSlippageBps, mandate.maxSlippageBps),
        );
        check(
          'economics.price',
          BigInt(intent.limitPrice) >=
            (BigInt(market.bid) * (10000n - slip)) / 10000n &&
            BigInt(intent.limitPrice) <= (mark * (10000n + slip)) / 10000n,
          'ECONOMIC_MISMATCH',
        );
        const collateralForBuffer = BigInt(intent.collateral);
        const liquidation =
          ((size * valueUnit * mark + collateralForBuffer * unit) * 10000n) /
          (size * valueUnit * (10000n + BigInt(market.maintenanceMarginBps)));
        const derivedBuffer =
          liquidation > mark
            ? Number(((liquidation - mark) * 10000n) / mark)
            : 0;
        check(
          'economics.liquidation',
          intent.postTradeLiquidationBufferBps === derivedBuffer &&
            derivedBuffer >= hm.minLiquidationBufferBps &&
            risk.positions.every(
              (p) => p.liquidationDistanceBps >= hm.minLiquidationBufferBps,
            ),
          'LIQUIDATION_BUFFER',
        );
        const ratio =
          spotValue > 0n
            ? Number(((currentShort + derivedNotional) * 10000n) / spotValue)
            : 0;
        check(
          'economics.ratio',
          intent.postTradeHedgeRatioBps === ratio,
          'HEDGE_EXCEEDS_MANDATE',
        );
        check(
          'parent.budget',
          derivedNotional <= BigInt(mandate.perActionCap) &&
            BigInt(facts.parentSpent ?? '0') +
              BigInt(facts.pendingNotional ?? '0') +
              derivedNotional <=
              BigInt(mandate.cumulativeBudget),
          'PARENT_BUDGET',
        );
        check(
          'parent.leverage-enabled',
          mandate.tierPolicy.leverage !== 'BLOCKED' &&
            mandate.maxLeverageBps > 0 &&
            mandate.bindings.some(
              (b) => b.pluginId === 'perpl' && b.action === 'PERP_HEDGE',
            ),
          'HEDGING_NOT_ENABLED',
        );
        check(
          'risk-packet',
          intent.riskPacketHash === facts.riskPacketHash,
          'RISK_PACKET_MISMATCH',
        );
        check('direction', intent.side === 'SHORT', 'HEDGE_DIRECTION');
        check(
          'leverage.cap',
          intent.leverageHundredths <= hm.maxLeverageHundredths &&
            intent.leverageHundredths <= market.maxLeverageHundredths &&
            intent.leverageHundredths * 100 <= mandate.maxLeverageBps,
          'LEVERAGE_CAP',
        );
        const notional = BigInt(intent.notional);
        const current =
          BigInt(facts.currentHedgeNotional) +
          BigInt(facts.pendingHedgeNotional ?? '0');
        const spot = BigInt(facts.spotExposure);
        check(
          'notional.cap',
          current + notional <= BigInt(hm.maxNotional),
          'NOTIONAL_CAP',
        );
        check(
          'hedge-ratio.cap',
          spot > 0n &&
            (current + notional) * 10_000n <=
              spot * BigInt(hm.maxHedgeRatioBps) &&
            intent.postTradeHedgeRatioBps <= hm.maxHedgeRatioBps,
          'HEDGE_EXCEEDS_MANDATE',
        );
        check(
          'liquidation.buffer',
          intent.postTradeLiquidationBufferBps !== null &&
            intent.postTradeLiquidationBufferBps >= hm.minLiquidationBufferBps,
          'LIQUIDATION_BUFFER',
        );
        const collateral = BigInt(intent.collateral);
        const minimum =
          (notional * 100n + BigInt(intent.leverageHundredths) - 1n) /
          BigInt(intent.leverageHundredths);
        check(
          'collateral.covers-leverage',
          collateral >= minimum,
          'LEVERAGE_CAP',
        );
        check(
          'collateral.cap',
          collateral <= BigInt(hm.maxCollateral),
          'COLLATERAL_CAP',
        );
        const fromPerp =
          BigInt(facts.perpFreeCollateral) -
          BigInt(facts.reservedPerpCollateral ?? '0');
        check(
          'collateral.pending',
          fromPerp >= 0n,
          'COLLATERAL_EXCEEDS_FREE_TREASURY',
        );
        reservation = collateral > fromPerp ? collateral - fromPerp : 0n;
        check(
          'collateral.free-treasury',
          reservation <=
            BigInt(facts.freeCoreTreasury) -
              BigInt(facts.reservedTreasury ?? '0'),
          'COLLATERAL_EXCEEDS_FREE_TREASURY',
        );
        tier =
          notional <= BigInt(hm.approval.autoMaxNotional)
            ? 'AUTO'
            : notional <= BigInt(hm.approval.reviewMaxNotional)
              ? 'REVIEW'
              : 'CONSENSUS';
        if (rank(mandate.tierPolicy.leverage) > rank(tier))
          tier = mandate.tierPolicy.leverage;
        const spendTier: Tier =
          BigInt(intent.collateral) <=
          BigInt(mandate.tierPolicy.tokenSpend.autoMax)
            ? 'AUTO'
            : BigInt(intent.collateral) <=
                BigInt(mandate.tierPolicy.tokenSpend.reviewMax)
              ? 'REVIEW'
              : 'CONSENSUS';
        if (rank(spendTier) > rank(tier)) tier = spendTier;
        const floor = mandate.tierPolicy.actionFloors.find(
          (f) => f.action === 'PERP_HEDGE',
        );
        if (floor && rank(floor.tier) > rank(tier)) tier = floor.tier;
        check('tier', tier !== 'BLOCKED', 'HEDGING_NOT_ENABLED');
        matchedRules.push(`tier:${tier}`);
      } else matchedRules.push('tier:AUTO(risk-reducing)');
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      rejection = { rule: error.rule, code: error.code };
    }
    const requiredApprovals = rejection
      ? 0
      : requiredApprovalsFor(tier, mandate, false);
    return Object.freeze({
      schemaVersion: 1,
      intentHash,
      intentId: intent.intentId,
      status: rejection
        ? 'REJECTED'
        : requiredApprovals > 0
          ? 'PENDING_APPROVAL'
          : 'AUTHORIZED',
      mode,
      riskReducing: reducing,
      tier: rejection ? 'BLOCKED' : tier,
      requiredApprovals,
      matchedRules,
      rejection,
      treasuryReservation: rejection ? '0' : reservation.toString(),
      evidenceMode,
      evidenceExpiresAt,
      evaluatedAt: facts.now,
    });
  }
}

const RANK: Record<Tier, number> = {
  AUTO: 0,
  REVIEW: 1,
  CONSENSUS: 2,
  BLOCKED: 3,
};
const rank = (t: Tier) => RANK[t];

export const HedgeGrantSchema = z.strictObject({
  executionMode: z.enum(['REAL_TESTNET', 'SIMULATION']),
  schemaVersion: z.literal(1),
  grantId: HashSchema,
  intentId: IdSchema,
  intentHash: HashSchema,
  groupId: GroupIdSchema,
  hedgeMandateId: IdSchema,
  hedgeMandateVersion: z.number().int().positive(),
  chainId: ChainIdSchema,
  exchange: AddressSchema,
  perplAccountId: AmountSchema,
  marketId: z.number().int().positive(),
  kind: HedgeActionKindSchema,
  side: HedgeSideSchema,
  orderType: z.number().int().min(1).max(5),
  maxSize: AmountSchema,
  limitPrice: AmountSchema,
  maxLeverageHundredths: z.number().int().min(0).max(10_000),
  orderId: AmountSchema.optional(),
  reduceOnly: z.boolean(),
  mode: z.enum(['NORMAL', 'CLOSE_ONLY']),
  approvals: z.array(MemberIdSchema),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  mac: z.string().regex(/^[0-9a-f]{64}$/),
});
export type HedgeGrant = z.output<typeof HedgeGrantSchema>;

export type HedgeOrderView = {
  t: number;
  mkt: number;
  acc: number;
  s: number;
  p?: number;
  lv: number;
  oid?: number;
};

export type HedgeGrantFailure =
  | 'GRANT_INVALID'
  | 'GRANT_MAC'
  | 'GRANT_EXPIRED'
  | 'GRANT_CONSUMED'
  | 'GRANT_BINDING'
  | 'APPROVALS_MISSING'
  | 'DECISION_NOT_AUTHORIZABLE';

export class HedgeGrantError extends Error {
  constructor(
    readonly code: HedgeGrantFailure,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'HedgeGrantError';
  }
}

// One-time grants keyed with the Kernel's grant key (>= 32 bytes) shared with
// the bounded executor. The executor refuses any order the grant does not
// cover.
export class HedgeGrantCodec {
  constructor(private readonly key: Uint8Array) {
    if (key.length < 32)
      throw new HedgeGrantError('GRANT_INVALID', 'grant key');
  }

  private mac(grantId: string): string {
    return createHmac('sha256', this.key).update(grantId).digest('hex');
  }

  sign(input: {
    decision: HedgeDecision;
    intent: HedgeIntent;
    hedgeMandate: HedgeMandate;
    mandate: Mandate;
    approvers: readonly string[];
    executionMode?: 'REAL_TESTNET' | 'SIMULATION';
    now: number;
  }): HedgeGrant {
    const { decision, intent, hedgeMandate: hm, mandate, now } = input;
    if (
      decision.status === 'REJECTED' ||
      decision.intentHash !== hedgeIntentHash(intent)
    )
      throw new HedgeGrantError('DECISION_NOT_AUTHORIZABLE');
    const executionMode = input.executionMode ?? 'SIMULATION';
    if (
      executionMode === 'REAL_TESTNET' &&
      decision.evidenceMode !== 'REAL_TESTNET'
    )
      throw new HedgeGrantError(
        'DECISION_NOT_AUTHORIZABLE',
        'simulation evidence cannot authorize a live order',
      );
    const approvers = new Set(input.approvers);
    if (approvers.size < decision.requiredApprovals)
      throw new HedgeGrantError('APPROVALS_MISSING');
    const expiresAt = decision.riskReducing
      ? Math.min(
          intent.expiresAt,
          now + hm.grantTtlSeconds,
          now + mandate.maxGrantTtlSeconds,
        )
      : Math.min(
          intent.expiresAt,
          now + hm.grantTtlSeconds,
          hm.validUntil,
          mandate.validUntil,
          now + mandate.maxGrantTtlSeconds,
          decision.evidenceExpiresAt,
          Math.floor(intent.marketDataAt / 1000) +
            Math.min(
              Math.floor(hm.maxMarketDataAgeMs / 1000),
              mandate.quoteTtlSeconds,
            ),
        );
    if (expiresAt <= now) throw new HedgeGrantError('GRANT_EXPIRED');
    const body = {
      executionMode,
      schemaVersion: 1 as const,
      intentId: intent.intentId,
      intentHash: decision.intentHash,
      groupId: intent.groupId,
      hedgeMandateId: hm.hedgeMandateId,
      hedgeMandateVersion: hm.version,
      chainId: intent.chainId,
      exchange: hm.exchange,
      perplAccountId: intent.perplAccountId,
      marketId: intent.marketId,
      kind: intent.kind,
      side: intent.side,
      orderType: perplOrderTypeFor(intent.kind, intent.side),
      maxSize: intent.size,
      limitPrice: intent.limitPrice,
      maxLeverageHundredths: intent.leverageHundredths,
      ...(intent.orderId !== undefined ? { orderId: intent.orderId } : {}),
      reduceOnly: decision.riskReducing,
      mode: decision.mode,
      approvals: [...approvers].sort(),
      issuedAt: now,
      expiresAt,
    };
    const grantId = artifactHash(body);
    return HedgeGrantSchema.parse({ ...body, grantId, mac: this.mac(grantId) });
  }

  // Verifies an order against its grant and consumes the grant. Throws on any
  // mismatch; never mutates on failure.
  verifyOrder(
    raw: unknown,
    order: HedgeOrderView,
    now: number,
    recovery = false,
  ): HedgeGrant {
    const parsed = HedgeGrantSchema.safeParse(raw);
    if (!parsed.success) throw new HedgeGrantError('GRANT_INVALID');
    const grant = parsed.data;
    const { grantId, mac, ...body } = grant;
    if (artifactHash(body) !== grantId)
      throw new HedgeGrantError('GRANT_INVALID', 'grant id');
    const expected = Buffer.from(this.mac(grantId), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(mac, 'hex')))
      throw new HedgeGrantError('GRANT_MAC');
    if (!recovery && (now >= grant.expiresAt || now < grant.issuedAt))
      throw new HedgeGrantError('GRANT_EXPIRED');
    const bind = (ok: boolean, what: string) => {
      if (!ok) throw new HedgeGrantError('GRANT_BINDING', what);
    };
    bind(order.t === grant.orderType, 'order type');
    bind(order.mkt === grant.marketId, 'market');
    bind(BigInt(order.acc) === BigInt(grant.perplAccountId), 'account');
    if (grant.kind === 'CANCEL') {
      bind(
        order.oid !== undefined &&
          BigInt(order.oid) === BigInt(grant.orderId ?? -1),
        'order id',
      );
    } else {
      bind(order.s > 0 && BigInt(order.s) <= BigInt(grant.maxSize), 'size');
      const limit = BigInt(grant.limitPrice);
      const price = BigInt(order.p ?? 0);
      // Opening a short must not sell below the limit; closing a short must
      // not buy above it (and symmetrically for longs).
      const sells = (grant.side === 'SHORT') !== grant.reduceOnly;
      bind(price > 0n && (sells ? price >= limit : price <= limit), 'price');
      if (!grant.reduceOnly)
        bind(order.lv === grant.maxLeverageHundredths, 'leverage');
    }
    return grant;
  }
}

// Local fixtures are never accepted by a live executor. Production issuance
// and consumption live in the persisted authority in execution infrastructure.
export class HedgeGrantAuthority extends HedgeGrantCodec {
  readonly executionMode = 'SIMULATION' as const;
  private readonly consumed = new Set<string>();
  private readonly issued = new Map<string, HedgeGrant>();
  issue(input: {
    decision: HedgeDecision;
    intent: HedgeIntent;
    hedgeMandate: HedgeMandate;
    mandate: Mandate;
    now: number;
  }): HedgeGrant {
    if (input.decision.requiredApprovals > 0)
      throw new HedgeGrantError(
        'APPROVALS_MISSING',
        'verified approvals come only from the durable authority',
      );
    const prior = this.issued.get(input.intent.intentId);
    if (prior) {
      if (prior.intentHash !== hedgeIntentHash(input.intent))
        throw new HedgeGrantError('GRANT_BINDING', 'intent changed');
      return prior;
    }
    const grant = this.sign({ ...input, approvers: [] });
    this.issued.set(grant.intentId, grant);
    return grant;
  }
  authorizeOrder(raw: unknown, order: HedgeOrderView, now: number): HedgeGrant {
    const grant = this.verifyOrder(raw, order, now);
    if (this.consumed.has(grant.grantId))
      throw new HedgeGrantError('GRANT_CONSUMED');
    this.consumed.add(grant.grantId);
    return grant;
  }
  isConsumed(id: string): boolean {
    return this.consumed.has(id);
  }
}

export {
  HEDGE_ACTION_KINDS,
  HedgeActionKindSchema,
  RISK_REDUCING_KINDS,
  HedgeSideSchema,
  HedgeTriggerSchema,
  HedgeIntentSchema,
  type HedgeIntent,
  type HedgeActionKind,
  type HedgeSide,
} from '@synq/schemas';
