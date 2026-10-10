import { encodeFunctionData, keccak256 } from 'viem';
import {
  AddressSchema,
  BoundActionIntentSchema,
  IdSchema,
  MandateSchema,
  ProfileNameSchema,
  ZERO_HASH,
  canonicalArtifactHash,
  canonicalBigInt,
  type Asset,
  type BoundActionIntent,
  type CapabilityAction,
  type Mandate,
  type MandateRecipient,
  type WorldModelSnapshot,
} from '@synq/schemas';
import { officialAssets } from '@synq/chain-registry';
import { CapabilityGraph } from '@synq/world-model';
import type { ActionDraft, IntentItem, MandateDraft } from './model-output.js';

export const VALIDATION_CODES = [
  'WRONG_NETWORK',
  'FABRICATED_ADDRESS',
  'RECIPIENT_NOT_IN_MANDATE',
  'UNSUPPORTED_TOKEN',
  'INVALID_AMOUNT',
  'DECIMALS_MISMATCH',
  'AMOUNT_MISMATCH',
  'AMOUNT_EXCEEDS_MANDATE',
  'UNSUPPORTED_PLUGIN',
  'CAPABILITY_UNAVAILABLE',
  'IMPOSSIBLE_DEADLINE',
  'UNKNOWN_PRINCIPAL',
  'INVALID_MANDATE',
  'PREPARE_REQUIRED',
  'UNAVAILABLE_IN_PHASE',
  'DUPLICATE_PROPOSAL',
  'INVALID_PROPOSAL',
] as const;
export type ValidationCode = (typeof VALIDATION_CODES)[number];
export type ValidationIssue = {
  code: ValidationCode;
  path: string;
  message: string;
};
export type NormalizedAction = {
  kind: 'ACTION';
  intent: BoundActionIntent;
  draft: ActionDraft;
  mandate: Mandate;
};
export type NormalizedMandate = {
  kind: 'MANDATE';
  change: 'NEW' | 'SUPERSEDE';
  mandate: Mandate;
  base: Mandate;
  draft: MandateDraft;
};
export type Normalized = NormalizedAction | NormalizedMandate;
export type ValidationResult =
  | { ok: true; value: Normalized }
  | { ok: false; issues: ValidationIssue[] };

const ACTION_CAPABILITY: Record<ActionDraft['action'], CapabilityAction> = {
  TRANSFER: 'TRANSFER',
  SPOT_TRADE: 'TRADE',
  PERP_HEDGE: 'TRADE',
  CROSS_CHAIN_FUND: 'FUND',
  CARD_PAYMENT: 'TRANSFER',
  X402_PAYMENT: 'TRANSFER',
};
export const COMMERCE_ACTIONS: readonly ActionDraft['action'][] = [
  'CARD_PAYMENT',
  'X402_PAYMENT',
];
const ERC20_TRANSFER = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;
export const MIN_DEADLINE_SECONDS = 60;
export const MAX_DEADLINE_SECONDS = 3600;

export class SemanticValidator {
  private readonly graph: CapabilityGraph;
  constructor(
    private readonly world: WorldModelSnapshot,
    private readonly now: number,
    private readonly speakers: ReadonlySet<string>,
  ) {
    this.graph = CapabilityGraph.fromView(world.capabilities.value);
  }

  validate(item: IntentItem): ValidationResult {
    if (
      (item.kind === 'ACTION' || item.kind === 'MANDATE') &&
      COMMERCE_ACTIONS.includes(item.action)
    )
      return {
        ok: false,
        issues: [
          {
            code: 'UNAVAILABLE_IN_PHASE',
            path: 'action',
            message: `${item.action} rails arrive with the commerce phase`,
          },
        ],
      };
    if (item.kind === 'ACTION') return this.action(item);
    if (item.kind === 'MANDATE') return this.mandate(item);
    return {
      ok: false,
      issues: [
        {
          code: 'INVALID_PROPOSAL',
          path: 'kind',
          message: `${item.kind} carries no proposal`,
        },
      ],
    };
  }

  private mandates(): Mandate[] {
    return this.world.mandates.value.map((m) => MandateSchema.parse(m.terms));
  }
  private knownAddresses(): Set<string> {
    const known = new Set<string>();
    const group = this.world.group.value;
    if (group) {
      known.add(group.account);
      group.owners.forEach((o) => known.add(o));
    }
    this.world.members.value.forEach((m) => known.add(m.signer));
    for (const m of this.mandates()) {
      m.recipients.forEach((r) => known.add(r.address));
      m.operators.forEach((o) => known.add(o));
      known.add(m.account);
    }
    return known;
  }
  private registryAsset(address: string): Asset | null {
    const chainId = this.world.network.value.chainId;
    const local =
      this.world.network.value.profile === 'local/anvil'
        ? this.mandates().flatMap((m) => [m.inputAsset, ...m.outputAssets])
        : [];
    return (
      [...Object.values(officialAssets), ...local].find(
        (a) => a.chainId === chainId && a.address === address,
      ) ?? null
    );
  }
  private address(
    raw: string,
    path: string,
    issues: ValidationIssue[],
  ): `0x${string}` | null {
    const parsed = AddressSchema.safeParse(raw);
    if (!parsed.success) {
      issues.push({
        code: 'FABRICATED_ADDRESS',
        path,
        message: 'not a valid checksummed address',
      });
      return null;
    }
    return parsed.data;
  }
  private network(raw: string, issues: ValidationIssue[]): boolean {
    const parsed = ProfileNameSchema.safeParse(raw);
    if (!parsed.success || parsed.data !== this.world.network.value.profile) {
      issues.push({
        code: 'WRONG_NETWORK',
        path: 'network',
        message: `${raw} is not the configured profile ${this.world.network.value.profile}`,
      });
      return false;
    }
    return true;
  }
  private amount(
    raw: ActionDraft['amount'],
    asset: Asset,
    path: string,
    issues: ValidationIssue[],
  ): bigint | null {
    const base = canonicalBigInt(raw.baseUnits);
    if (base === null || base === 0n) {
      issues.push({
        code: 'INVALID_AMOUNT',
        path: `${path}.baseUnits`,
        message: 'amount must be a positive integer number of base units',
      });
      return null;
    }
    if (raw.decimals !== asset.decimals) {
      issues.push({
        code: 'DECIMALS_MISMATCH',
        path: `${path}.decimals`,
        message: `${asset.symbol} has ${asset.decimals} decimals, not ${raw.decimals}`,
      });
      return null;
    }
    const display = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(raw.display);
    const fraction = display?.[2] ?? '';
    if (!display || fraction.length > asset.decimals) {
      issues.push({
        code: 'INVALID_AMOUNT',
        path: `${path}.display`,
        message:
          'display amount is not a non-negative decimal within precision',
      });
      return null;
    }
    const scaled = BigInt(display[1]! + fraction.padEnd(asset.decimals, '0'));
    if (scaled !== base) {
      issues.push({
        code: 'AMOUNT_MISMATCH',
        path,
        message: 'display and base units disagree',
      });
      return null;
    }
    return base;
  }
  private principals(raw: readonly string[], issues: ValidationIssue[]) {
    const active = new Set(this.world.members.value.map((m) => m.memberId));
    for (const id of raw)
      if (!active.has(id))
        issues.push({
          code: 'UNKNOWN_PRINCIPAL',
          path: 'requestedBy',
          message: `${id.slice(0, 64)} is not an active member`,
        });
      else if (!this.speakers.has(id))
        issues.push({
          code: 'UNKNOWN_PRINCIPAL',
          path: 'requestedBy',
          message: `${id.slice(0, 64)} did not speak in this conversation`,
        });
  }
  private capability(
    providerId: string,
    action: ActionDraft['action'],
    issues: ValidationIssue[],
  ) {
    const node = this.graph.node(providerId);
    if (!node || node.kind !== 'PLUGIN' || node.pluginId === null) {
      issues.push({
        code: 'UNSUPPORTED_PLUGIN',
        path: 'providerId',
        message: `${providerId.slice(0, 64)} is not a known plugin provider`,
      });
      return null;
    }
    const verdict = this.graph.canPerform(
      ACTION_CAPABILITY[action],
      this.world.network.value.profile,
      providerId,
    );
    if (
      verdict.availability !== 'AVAILABLE' &&
      verdict.availability !== 'REQUIRES_HUMAN'
    ) {
      issues.push({
        code:
          verdict.availability === 'NOT_INSTALLED'
            ? 'UNSUPPORTED_PLUGIN'
            : 'CAPABILITY_UNAVAILABLE',
        path: 'providerId',
        message: `${verdict.availability}: ${verdict.reason}`,
      });
      return null;
    }
    return node;
  }

  private action(draft: ActionDraft): ValidationResult {
    const issues: ValidationIssue[] = [];
    this.principals([draft.requestedBy], issues);
    this.network(draft.network, issues);
    const node = this.capability(draft.providerId, draft.action, issues);
    const mandate = this.mandates().find(
      (m) => m.mandateId === draft.mandateId,
    );
    if (
      !mandate ||
      mandate.status !== 'ACTIVE' ||
      mandate.version !== draft.mandateVersion ||
      this.now < mandate.validAfter ||
      this.now >= mandate.validUntil
    )
      issues.push({
        code: 'INVALID_MANDATE',
        path: 'mandateId',
        message:
          'mandate missing, revoked, outside its window or wrong version',
      });
    const token = this.address(draft.token, 'token', issues);
    const recipient = this.address(draft.recipient, 'recipient', issues);
    const asset = token ? this.registryAsset(token) : null;
    if (token && !asset)
      issues.push({
        code: 'UNSUPPORTED_TOKEN',
        path: 'token',
        message: 'token is not a registry asset on this chain',
      });
    if (asset && mandate && asset.address !== mandate.inputAsset.address)
      issues.push({
        code: 'UNSUPPORTED_TOKEN',
        path: 'token',
        message: 'token is not the mandate input asset',
      });
    if (recipient) {
      if (!this.knownAddresses().has(recipient))
        issues.push({
          code: 'FABRICATED_ADDRESS',
          path: 'recipient',
          message: 'recipient is unknown to the registry, group and mandates',
        });
      else if (
        mandate &&
        !mandate.recipients.some((r) => r.address === recipient)
      )
        issues.push({
          code: 'RECIPIENT_NOT_IN_MANDATE',
          path: 'recipient',
          message: 'recipient is not on the mandate allowlist',
        });
    }
    const amount = asset
      ? this.amount(draft.amount, asset, 'amount', issues)
      : null;
    if (amount !== null && mandate && amount > BigInt(mandate.perActionCap))
      issues.push({
        code: 'AMOUNT_EXCEEDS_MANDATE',
        path: 'amount',
        message: 'amount exceeds the mandate per-action cap',
      });
    const ttl = mandate
      ? Math.min(MAX_DEADLINE_SECONDS, mandate.validUntil - this.now)
      : MAX_DEADLINE_SECONDS;
    if (
      !Number.isSafeInteger(draft.deadlineSeconds) ||
      draft.deadlineSeconds < MIN_DEADLINE_SECONDS ||
      draft.deadlineSeconds > ttl
    )
      issues.push({
        code: 'IMPOSSIBLE_DEADLINE',
        path: 'deadlineSeconds',
        message: `deadline must be within ${MIN_DEADLINE_SECONDS}..${ttl} seconds`,
      });
    if (draft.action !== 'TRANSFER')
      issues.push({
        code: 'PREPARE_REQUIRED',
        path: 'action',
        message: `${draft.action} calldata must come from the plugin prepare step`,
      });
    const binding =
      mandate && node
        ? mandate.bindings.find(
            (b) => b.pluginId === node.pluginId && b.action === draft.action,
          )
        : undefined;
    if (mandate && node && !binding)
      issues.push({
        code: 'UNSUPPORTED_PLUGIN',
        path: 'providerId',
        message: 'the mandate has no binding for this plugin and action',
      });
    if (issues.length || !mandate || !binding || !recipient || amount === null)
      return { ok: false, issues };
    const calldata = encodeFunctionData({
      abi: ERC20_TRANSFER,
      functionName: 'transfer',
      args: [recipient, amount],
    });
    if (calldata.slice(0, 10) !== binding.selector)
      return {
        ok: false,
        issues: [
          {
            code: 'UNSUPPORTED_PLUGIN',
            path: 'providerId',
            message: 'binding selector is not an ERC20 transfer',
          },
        ],
      };
    const nonce = BigInt(
      canonicalArtifactHash({ draft, at: this.now }).slice(0, 18),
    ).toString();
    const parsed = BoundActionIntentSchema.safeParse({
      schemaVersion: 1,
      intentId: `intent_brain_${nonce}`,
      groupId: mandate.groupId,
      mandateId: mandate.mandateId,
      mandateVersion: mandate.version,
      action: 'TRANSFER',
      chainId: mandate.network.chainId,
      account: mandate.account,
      operator: mandate.operators[0],
      recipient,
      pluginId: binding.pluginId,
      target: binding.target,
      selector: binding.selector,
      calldataHash: keccak256(calldata),
      inputToken: mandate.inputAsset.address,
      maxInputAmount: amount.toString(),
      minOutputAmount: '0',
      nativeValue: '0',
      maxSlippageBps: 0,
      leverageBps: 0,
      validAfter: this.now,
      validUntil: this.now + draft.deadlineSeconds,
      nonce,
      evidenceHash: ZERO_HASH,
      riskPacketHash: ZERO_HASH,
    });
    if (!parsed.success)
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          code: 'INVALID_PROPOSAL',
          path: i.path.join('.'),
          message: i.message,
        })),
      };
    return {
      ok: true,
      value: { kind: 'ACTION', intent: parsed.data, draft, mandate },
    };
  }

  private mandate(draft: MandateDraft): ValidationResult {
    const issues: ValidationIssue[] = [];
    this.principals(draft.requestedBy, issues);
    this.network(draft.network, issues);
    const node = this.capability(draft.providerId, draft.action, issues);
    const base = this.mandates().find(
      (m) => m.mandateId === draft.baseMandateId,
    );
    if (!base || base.status !== 'ACTIVE')
      issues.push({
        code: 'INVALID_MANDATE',
        path: 'baseMandateId',
        message: 'base mandate missing or revoked',
      });
    const newId =
      draft.change === 'NEW' ? IdSchema.safeParse(draft.newMandateId) : null;
    if (
      draft.change === 'NEW' &&
      (!newId?.success ||
        this.mandates().some((m) => m.mandateId === newId.data))
    )
      issues.push({
        code: 'INVALID_MANDATE',
        path: 'newMandateId',
        message: 'a new mandate needs a fresh id',
      });
    if (draft.change === 'SUPERSEDE' && draft.newMandateId !== null)
      issues.push({
        code: 'INVALID_MANDATE',
        path: 'newMandateId',
        message: 'a supersession keeps the mandate id',
      });
    const token = this.address(draft.inputToken, 'inputToken', issues);
    const asset = token ? this.registryAsset(token) : null;
    if (token && !asset)
      issues.push({
        code: 'UNSUPPORTED_TOKEN',
        path: 'inputToken',
        message: 'input token is not a registry asset on this chain',
      });
    let output: Asset | null = null;
    if (draft.outputToken !== null) {
      const out = this.address(draft.outputToken, 'outputToken', issues);
      output = out ? this.registryAsset(out) : null;
      if (out && !output)
        issues.push({
          code: 'UNSUPPORTED_TOKEN',
          path: 'outputToken',
          message: 'output token is not a registry asset on this chain',
        });
    }
    const perAction = asset
      ? this.amount(draft.perActionCap, asset, 'perActionCap', issues)
      : null;
    const cumulative = asset
      ? this.amount(draft.cumulativeBudget, asset, 'cumulativeBudget', issues)
      : null;
    if (perAction !== null && cumulative !== null && perAction > cumulative)
      issues.push({
        code: 'INVALID_AMOUNT',
        path: 'perActionCap',
        message: 'per-action cap exceeds the cumulative budget',
      });
    const known = this.knownAddresses();
    const members = new Set(this.world.members.value.map((m) => m.signer));
    const recipients: MandateRecipient[] = [];
    for (const [i, raw] of draft.recipients.entries()) {
      const address = this.address(raw, `recipients.${i}`, issues);
      if (!address) continue;
      if (!known.has(address)) {
        issues.push({
          code: 'FABRICATED_ADDRESS',
          path: `recipients.${i}`,
          message: 'recipient is unknown to the registry, group and mandates',
        });
        continue;
      }
      const existing = base?.recipients.find((r) => r.address === address);
      recipients.push(
        existing ?? {
          address,
          purpose: members.has(address)
            ? 'MEMBER_WITHDRAWAL'
            : address === base?.account
              ? 'SELF'
              : 'COUNTERPARTY',
        },
      );
    }
    if (
      !Number.isSafeInteger(draft.durationDays) ||
      draft.durationDays < 1 ||
      draft.durationDays > 366
    )
      issues.push({
        code: 'IMPOSSIBLE_DEADLINE',
        path: 'durationDays',
        message: 'duration must be 1..366 days',
      });
    if (
      draft.cadenceSeconds !== null &&
      (!Number.isSafeInteger(draft.cadenceSeconds) ||
        draft.cadenceSeconds < 0 ||
        draft.cadenceSeconds > draft.durationDays * 86_400)
    )
      issues.push({
        code: 'IMPOSSIBLE_DEADLINE',
        path: 'cadenceSeconds',
        message: 'cadence must fit inside the mandate duration',
      });
    if (
      !Number.isSafeInteger(draft.maxSlippageBps) ||
      draft.maxSlippageBps < 0 ||
      draft.maxSlippageBps > 10_000
    )
      issues.push({
        code: 'INVALID_AMOUNT',
        path: 'maxSlippageBps',
        message: 'slippage must be 0..10000 bps',
      });
    const binding =
      base && node
        ? base.bindings.find(
            (b) => b.pluginId === node.pluginId && b.action === draft.action,
          )
        : undefined;
    if (base && node && !binding)
      issues.push({
        code: 'PREPARE_REQUIRED',
        path: 'providerId',
        message:
          'no registry-verified call binding exists for this venue and action',
      });
    if (asset && base && asset.address !== base.inputAsset.address)
      issues.push({
        code: 'UNSUPPORTED_TOKEN',
        path: 'inputToken',
        message: 'a mandate cannot change its input asset',
      });
    if (
      issues.length ||
      !base ||
      !binding ||
      perAction === null ||
      cumulative === null ||
      recipients.length === 0
    ) {
      if (!issues.length)
        issues.push({
          code: 'INVALID_PROPOSAL',
          path: 'recipients',
          message: 'a mandate needs at least one recipient',
        });
      return { ok: false, issues };
    }
    const parsed = MandateSchema.safeParse({
      ...base,
      mandateId: draft.change === 'NEW' ? newId!.data : base.mandateId,
      version: draft.change === 'NEW' ? 1 : base.version + 1,
      status: 'ACTIVE',
      bindings: [binding],
      recipients,
      outputAssets: output ? [output] : [],
      perActionCap: perAction.toString(),
      cumulativeBudget: cumulative.toString(),
      maxSlippageBps: draft.maxSlippageBps,
      minIntervalSeconds: draft.cadenceSeconds ?? base.minIntervalSeconds,
      validAfter: draft.change === 'NEW' ? this.now : base.validAfter,
      validUntil: this.now + draft.durationDays * 86_400,
    });
    if (!parsed.success)
      return {
        ok: false,
        issues: parsed.error.issues.map((i) => ({
          code: 'INVALID_PROPOSAL',
          path: i.path.join('.'),
          message: i.message,
        })),
      };
    return {
      ok: true,
      value: {
        kind: 'MANDATE',
        change: draft.change,
        mandate: parsed.data,
        base,
        draft,
      },
    };
  }
}
