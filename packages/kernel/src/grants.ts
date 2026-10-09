import { effectiveGrantTtl } from '@synq/plugin-sdk';
import {
  ExecutionGrantSchema,
  GrantDraftSchema,
  executionGrantDigest,
  type ExecutionGrant,
  type GrantDraft,
  type Mandate,
  type NetworkProfile,
  type PluginManifest,
  type RiskPacket,
  type Simulation,
  type VerifiedApproval,
} from '@synq/schemas';
import {
  artifactHash,
  canonicalJson,
  type CanonicalIntent,
} from './canonical.js';
import { parseAs, requireRule } from './errors.js';
import { onchainMandateId, onchainPluginId } from './mandates.js';
import type { PolicyResult } from './policy.js';

export function freshnessAnchor(risk: RiskPacket, simulation: Simulation) {
  return Math.max(risk.evaluatedAt, risk.quoteAt, simulation.simulatedAt);
}

export function grantWindow(input: {
  canonical: CanonicalIntent;
  mandate: Mandate;
  manifest: Pick<PluginManifest, 'maxGrantTtlSeconds'>;
  risk: RiskPacket;
  simulation: Simulation;
}): { validAfter: number; validUntil: number } {
  const { canonical, mandate, risk, simulation } = input;
  const anchor = freshnessAnchor(risk, simulation);
  const ttl = effectiveGrantTtl(input.manifest, mandate, anchor);
  return {
    validAfter: Math.max(canonical.intent.validAfter, mandate.validAfter),
    validUntil: Math.min(
      canonical.intent.validUntil,
      mandate.validUntil,
      anchor + ttl,
      risk.quoteExpiresAt,
      risk.quoteAt + mandate.quoteTtlSeconds,
      risk.evaluatedAt + mandate.evidenceTtlSeconds,
      ...risk.evidence.map((e) => e.retrievedAt + mandate.evidenceTtlSeconds),
      simulation.simulatedAt + mandate.simulationTtlSeconds,
    ),
  };
}

export class GrantIssuer {
  draft(input: {
    canonical: CanonicalIntent;
    mandate: Mandate;
    network: NetworkProfile;
    executionModule: `0x${string}`;
    manifest: Pick<PluginManifest, 'maxGrantTtlSeconds'>;
    risk: RiskPacket;
    simulation: Simulation;
    requiredApprovals: number;
  }): GrantDraft {
    const { canonical, mandate, network } = input;
    const intent = canonical.intent;
    const window = grantWindow(input);
    const domain = {
      name: 'SynqExecutionModule' as const,
      version: '1' as const,
      chainId: network.chainId,
      verifyingContract: input.executionModule,
    };
    const grant = {
      groupId: mandate.chainGroupId,
      account: intent.account,
      mandateId: onchainMandateId(mandate),
      mandateVersion: String(mandate.version),
      executor: intent.operator,
      pluginId: onchainPluginId(intent.pluginId),
      chainId: String(network.chainId),
      target: intent.target,
      selector: intent.selector,
      calldataHash: intent.calldataHash,
      token: intent.inputToken,
      maxInputAmount: intent.maxInputAmount,
      nativeValue: intent.nativeValue,
      minOutputAmount: intent.minOutputAmount,
      recipient: intent.recipient,
      validAfter: String(window.validAfter),
      validUntil: String(window.validUntil),
      nonce: intent.nonce,
      intentHash: canonical.intentHash,
    };
    return parseAs(
      GrantDraftSchema,
      {
        schemaVersion: 1,
        groupId: mandate.groupId,
        domain,
        grant,
        digest: executionGrantDigest(domain, grant),
        requiredApprovals: Math.max(1, input.requiredApprovals),
        createdAt: freshnessAnchor(input.risk, input.simulation),
      },
      'INVALID_REQUEST',
    );
  }
  issue(input: {
    canonical: CanonicalIntent;
    mandate: Mandate;
    draft: GrantDraft;
    policy: PolicyResult;
    simulation: Simulation;
    approvals: readonly VerifiedApproval[];
    tier: Exclude<PolicyResult['tier'], 'BLOCKED'>;
    requiredApprovals: number;
    now: number;
  }): ExecutionGrant {
    const { canonical, mandate, draft } = input;
    const intent = canonical.intent;
    const tokenAmount = BigInt(intent.maxInputAmount);
    return parseAs(
      ExecutionGrantSchema,
      {
        schemaVersion: 2,
        grantId: draft.digest,
        intentId: canonical.intentId,
        intentHash: canonical.intentHash,
        groupId: intent.groupId,
        mandateId: intent.mandateId,
        mandateVersion: mandate.version,
        operator: intent.operator,
        pluginId: intent.pluginId,
        chainId: intent.chainId,
        account: intent.account,
        target: intent.target,
        selector: intent.selector,
        calldataHash: intent.calldataHash,
        inputAsset: tokenAmount > 0n ? mandate.inputAsset : null,
        maxInputAmount: intent.maxInputAmount,
        outputToken: intent.outputToken ?? null,
        minOutputAmount: intent.minOutputAmount,
        nativeValue: intent.nativeValue,
        recipient: intent.recipient,
        validAfter: Number(draft.grant.validAfter),
        validUntil: Number(draft.grant.validUntil),
        nonce: intent.nonce,
        evidenceHash: intent.evidenceHash,
        riskPacketHash: intent.riskPacketHash,
        simulationHash: artifactHash(input.simulation),
        policyResultHash: artifactHash(input.policy),
        tier: input.tier,
        requiredApprovals: input.requiredApprovals,
        issuedAt: input.now,
        draft,
        approvals: input.approvals,
      },
      'INVALID_REQUEST',
    );
  }
}

export function grantDigestMatches(grant: ExecutionGrant): boolean {
  return (
    executionGrantDigest(grant.draft.domain, grant.draft.grant) ===
    grant.grantId
  );
}

export class GrantVerifier {
  verify(input: {
    presented: unknown;
    issued: { grant: ExecutionGrant; state: string } | undefined;
    canonical: CanonicalIntent;
    now: number;
  }): ExecutionGrant {
    const grant = parseAs(
      ExecutionGrantSchema,
      input.presented,
      'GRANT_MISMATCH',
    );
    requireRule(input.issued !== undefined, 'GRANT_UNKNOWN');
    requireRule(
      canonicalJson(grant) === canonicalJson(input.issued.grant) &&
        grantDigestMatches(grant) &&
        grant.intentHash === input.canonical.intentHash &&
        grant.intentId === input.canonical.intentId,
      'GRANT_MISMATCH',
    );
    requireRule(input.issued.state === 'RESERVED', 'GRANT_REPLAY');
    requireRule(
      input.now >= grant.validAfter && input.now < grant.validUntil,
      'GRANT_EXPIRED',
    );
    return structuredClone(grant);
  }
}
