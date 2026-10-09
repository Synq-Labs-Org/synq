import type {
  ActionKind,
  Mandate,
  NetworkProfile,
  RecipientPurpose,
  Tier,
} from '@synq/schemas';
import {
  artifactHash,
  canonicalJson,
  type CanonicalIntent,
} from './canonical.js';
import type { Failure } from './errors.js';

export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
export const NATIVE_TRANSFER_SELECTOR = '0x00000000';
export const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as const;
const BLOCKING_CODES: ReadonlySet<Failure> = new Set<Failure>([
  'LEVERAGE_BLOCKED',
  'ACTION_BLOCKED',
  'WITHDRAWAL_BLOCKED',
  'NEW_ASSET_BLOCKED',
]);
const TIER_RANK: Record<Tier, number> = {
  AUTO: 0,
  REVIEW: 1,
  CONSENSUS: 2,
  BLOCKED: 3,
};

export type PolicyFacts = {
  action: ActionKind;
  pluginId: string;
  operator: string;
  account: string;
  chainId: number;
  target: string;
  selector: string;
  recipient: string;
  recipientPurpose: RecipientPurpose | null;
  inputToken: string;
  tokenAmount: string;
  nativeValue: string;
  outputToken: string | null;
  newOutputAsset: boolean;
  withdrawal: boolean;
  leverageBps: number;
  maxSlippageBps: number;
  mandateVersion: number;
};
export type TierContribution = { rule: string; tier: Tier };
export type PolicyResult = {
  schemaVersion: 1;
  intentId: string;
  intentHash: string;
  groupId: string;
  mandateId: string;
  mandateVersion: number;
  mandateHash: string;
  evaluatedAt: number;
  facts: PolicyFacts;
  matchedRules: string[];
  contributions: TierContribution[];
  tier: Tier;
  requiredApprovals: number;
  rejection: { rule: string; code: Failure } | null;
};

class PolicyStop {
  constructor(
    readonly rule: string,
    readonly code: Failure,
  ) {}
}

function band(
  amount: bigint,
  limits: { autoMax: string; reviewMax: string },
): Tier {
  if (amount <= BigInt(limits.autoMax)) return 'AUTO';
  return amount <= BigInt(limits.reviewMax) ? 'REVIEW' : 'CONSENSUS';
}

export function requiredApprovalsFor(
  tier: Tier,
  mandate: Mandate,
  withdrawal: boolean,
): number {
  if (tier === 'AUTO' || tier === 'BLOCKED') return 0;
  if (tier === 'REVIEW') return mandate.approvalPolicy.reviewApprovals;
  if (withdrawal && mandate.tierPolicy.withdrawal === 'UNANIMOUS')
    return mandate.members.filter((m) => m.active).length;
  return mandate.approvalPolicy.quorum;
}

export class PolicyEngine {
  evaluate(input: {
    canonical: CanonicalIntent;
    mandate: Mandate;
    network: NetworkProfile;
    now: number;
  }): PolicyResult {
    const { canonical, mandate, network, now } = input;
    const intent = canonical.intent;
    const recipient = mandate.recipients.find(
      (r) => r.address === intent.recipient,
    );
    const outputKnown =
      intent.outputToken === undefined ||
      mandate.outputAssets.some((a) => a.address === intent.outputToken);
    const facts: PolicyFacts = {
      action: intent.action,
      pluginId: intent.pluginId,
      operator: intent.operator,
      account: intent.account,
      chainId: intent.chainId,
      target: intent.target,
      selector: intent.selector,
      recipient: intent.recipient,
      recipientPurpose: recipient?.purpose ?? null,
      inputToken: intent.inputToken,
      tokenAmount: intent.maxInputAmount,
      nativeValue: intent.nativeValue,
      outputToken: intent.outputToken ?? null,
      newOutputAsset: !outputKnown,
      withdrawal: recipient?.purpose === 'MEMBER_WITHDRAWAL',
      leverageBps: intent.leverageBps,
      maxSlippageBps: intent.maxSlippageBps,
      mandateVersion: intent.mandateVersion,
    };
    const matchedRules: string[] = [];
    const contributions: TierContribution[] = [];
    const check = (rule: string, ok: boolean, code: Failure) => {
      if (!ok) throw new PolicyStop(rule, code);
      matchedRules.push(rule);
    };
    const tokenAmount = BigInt(intent.maxInputAmount);
    const nativeValue = BigInt(intent.nativeValue);
    let rejection: PolicyResult['rejection'] = null;
    try {
      check(
        'mandate.group',
        intent.groupId === mandate.groupId,
        'GROUP_MISMATCH',
      );
      check(
        'mandate.version',
        intent.mandateId === mandate.mandateId &&
          intent.mandateVersion === mandate.version,
        'MANDATE_VERSION',
      );
      check('mandate.active', mandate.status === 'ACTIVE', 'MANDATE_REVOKED');
      check(
        'network.profile',
        intent.chainId === network.chainId &&
          canonicalJson(mandate.network) === canonicalJson(network),
        'NETWORK_MISMATCH',
      );
      check('account', intent.account === mandate.account, 'ACCOUNT_MISMATCH');
      check(
        'operator.allowlist',
        mandate.operators.includes(intent.operator),
        'OPERATOR_FORBIDDEN',
      );
      const byPlugin = mandate.bindings.filter(
        (b) => b.pluginId === intent.pluginId,
      );
      check('binding.plugin', byPlugin.length > 0, 'PLUGIN_FORBIDDEN');
      const byAction = byPlugin.filter((b) => b.action === intent.action);
      check('binding.action', byAction.length > 0, 'ACTION_FORBIDDEN');
      const byTarget = byAction.filter((b) => b.target === intent.target);
      check('binding.target', byTarget.length > 0, 'TARGET_FORBIDDEN');
      check(
        'binding.tuple',
        byTarget.some((b) => b.selector === intent.selector),
        'SELECTOR_FORBIDDEN',
      );
      check(
        'recipient.allowlist',
        recipient !== undefined,
        'RECIPIENT_FORBIDDEN',
      );
      check(
        'asset.input',
        tokenAmount === 0n
          ? intent.inputToken === ZERO_ADDRESS
          : intent.inputToken === mandate.inputAsset.address,
        'ASSET_FORBIDDEN',
      );
      if (intent.selector === ERC20_TRANSFER_SELECTOR)
        check(
          'shape.erc20-transfer',
          intent.target === intent.inputToken &&
            tokenAmount > 0n &&
            nativeValue === 0n &&
            intent.outputToken === undefined &&
            BigInt(intent.minOutputAmount) <= tokenAmount,
          'ACTION_SHAPE_INVALID',
        );
      else if (intent.selector === NATIVE_TRANSFER_SELECTOR)
        check(
          'shape.native-transfer',
          intent.target === intent.recipient &&
            tokenAmount === 0n &&
            nativeValue > 0n &&
            intent.outputToken === undefined &&
            BigInt(intent.minOutputAmount) <= nativeValue,
          'ACTION_SHAPE_INVALID',
        );
      check(
        'cap.token',
        tokenAmount <= BigInt(mandate.perActionCap),
        'AMOUNT_CAP',
      );
      check(
        'cap.native',
        nativeValue <= BigInt(mandate.maxNativeValue),
        'NATIVE_VALUE_CAP',
      );
      check(
        'slippage',
        intent.maxSlippageBps <= mandate.maxSlippageBps,
        'SLIPPAGE_CAP',
      );
      if (intent.leverageBps > 0) {
        check(
          'leverage.policy',
          mandate.tierPolicy.leverage !== 'BLOCKED',
          'LEVERAGE_BLOCKED',
        );
        check(
          'leverage.cap',
          intent.leverageBps <= mandate.maxLeverageBps,
          'LEVERAGE_CAP',
        );
      }
      check(
        'time.window',
        now >= mandate.validAfter &&
          now >= intent.validAfter &&
          now < mandate.validUntil &&
          now < intent.validUntil &&
          intent.validAfter >= mandate.validAfter &&
          intent.validUntil <= mandate.validUntil,
        'TIME_WINDOW',
      );
      const policy = mandate.tierPolicy;
      contributions.push({
        rule: 'tier.spend.token',
        tier: band(tokenAmount, policy.tokenSpend),
      });
      contributions.push({
        rule: 'tier.spend.native',
        tier: band(nativeValue, policy.nativeSpend),
      });
      if (facts.newOutputAsset)
        contributions.push({
          rule: 'tier.newOutputAsset',
          tier: policy.newOutputAsset,
        });
      if (intent.leverageBps > 0)
        contributions.push({ rule: 'tier.leverage', tier: 'CONSENSUS' });
      const floor = policy.actionFloors.find((f) => f.action === intent.action);
      if (floor)
        contributions.push({ rule: 'tier.actionFloor', tier: floor.tier });
      if (facts.withdrawal)
        contributions.push({
          rule: 'tier.withdrawal',
          tier: policy.withdrawal === 'BLOCKED' ? 'BLOCKED' : 'CONSENSUS',
        });
      const blocked = contributions.find((c) => c.tier === 'BLOCKED');
      if (blocked)
        throw new PolicyStop(
          blocked.rule,
          blocked.rule === 'tier.newOutputAsset'
            ? 'NEW_ASSET_BLOCKED'
            : blocked.rule === 'tier.withdrawal'
              ? 'WITHDRAWAL_BLOCKED'
              : 'ACTION_BLOCKED',
        );
      for (const c of contributions) matchedRules.push(`${c.rule}:${c.tier}`);
    } catch (error) {
      if (!(error instanceof PolicyStop)) throw error;
      rejection = { rule: error.rule, code: error.code };
    }
    const tier: Tier =
      rejection && BLOCKING_CODES.has(rejection.code)
        ? 'BLOCKED'
        : maxTier(contributions);
    return {
      schemaVersion: 1,
      intentId: canonical.intentId,
      intentHash: canonical.intentHash,
      groupId: mandate.groupId,
      mandateId: mandate.mandateId,
      mandateVersion: mandate.version,
      mandateHash: artifactHash(mandate),
      evaluatedAt: now,
      facts,
      matchedRules,
      contributions,
      tier,
      requiredApprovals: rejection
        ? 0
        : requiredApprovalsFor(tier, mandate, facts.withdrawal),
      rejection,
    };
  }
}

function maxTier(contributions: readonly TierContribution[]): Tier {
  return contributions.reduce<Tier>(
    (best, c) => (TIER_RANK[c.tier] > TIER_RANK[best] ? c.tier : best),
    'AUTO',
  );
}
