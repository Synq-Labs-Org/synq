import { z } from 'zod';
import {
  CapabilityFactSchema,
  CapabilityGraphViewSchema,
  IdSchema,
  ProfileNameSchema,
  type CapabilityAction,
  type CapabilityAvailability,
  type CapabilityGraphView,
  type CapabilityNode,
  type CapabilityVerdict,
  type NetworkProfile,
  type ProfileName,
} from '@synq/schemas';
import type { PluginRegistry } from '@synq/plugin-sdk';
import rawFacts from '../../../sources/capability_facts.json' with { type: 'json' };
import { errorCode } from './meta.js';

export const CapabilityFactsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  verifiedAt: z.iso.datetime(),
  flags: z.strictObject({ mainnetBroadcast: z.string().min(1) }),
  providers: z
    .array(
      z.strictObject({
        providerId: IdSchema,
        pluginId: IdSchema.nullable(),
        kind: z.enum(['PLUGIN', 'MODEL_PROVIDER']),
        credentialEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
        sourceRefs: z.array(z.string().max(200)),
        facts: z.array(CapabilityFactSchema).min(1),
      }),
    )
    .refine(
      (v) => new Set(v.map((p) => p.providerId)).size === v.length,
      'duplicate provider',
    ),
});
export type CapabilityFactsFile = z.output<typeof CapabilityFactsFileSchema>;
export const capabilityFacts: CapabilityFactsFile =
  CapabilityFactsFileSchema.parse(rawFacts);

export type ModelProviderState = {
  installed: boolean;
  credentialsPresent: boolean;
  healthy?: boolean;
  reason?: string;
};
export function credentialPresence(
  facts: CapabilityFactsFile,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, boolean> {
  return Object.fromEntries(
    facts.providers
      .filter((p) => p.kind === 'MODEL_PROVIDER')
      .map((p) => [
        p.providerId,
        p.credentialEnv.some((name) => (env[name] ?? '').trim().length > 0),
      ]),
  );
}
export function mainnetBroadcastAllowed(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true';
}

const PREFERENCE: readonly CapabilityAvailability[] = [
  'AVAILABLE',
  'REQUIRES_HUMAN',
  'READ_ONLY',
  'UNHEALTHY',
  'UNAVAILABLE_IN_NETWORK_PROFILE',
  'NOT_INSTALLED',
];

export class CapabilityGraph {
  private constructor(private readonly view: CapabilityGraphView) {}

  static build(input: {
    network: NetworkProfile;
    now: number;
    facts?: CapabilityFactsFile;
    plugins?: PluginRegistry;
    modelProviders?: Readonly<Record<string, ModelProviderState>>;
    mainnetBroadcastAllowed: boolean;
  }): CapabilityGraph {
    const facts = input.facts ?? capabilityFacts;
    const installed = new Set(
      (input.plugins?.manifests() ?? []).map((m) => m.id as string),
    );
    const nodes: CapabilityNode[] = facts.providers.map((p) => {
      if (p.kind === 'MODEL_PROVIDER') {
        const state = input.modelProviders?.[p.providerId] ?? {
          installed: false,
          credentialsPresent: false,
        };
        const status = !state.installed
          ? 'NOT_INSTALLED'
          : !state.credentialsPresent
            ? 'BLOCKED_NO_CREDENTIALS'
            : state.healthy === false
              ? 'UNHEALTHY'
              : 'READY';
        return {
          providerId: p.providerId,
          pluginId: null,
          kind: p.kind,
          installed: state.installed,
          status,
          statusReason:
            status === 'BLOCKED_NO_CREDENTIALS'
              ? `none of ${p.credentialEnv.join(', ')} is set`
              : (state.reason ?? null),
          facts: p.facts,
          sourceRefs: p.sourceRefs,
          health: null,
        };
      }
      const pluginId = p.pluginId;
      const isInstalled = pluginId !== null && installed.has(pluginId);
      let health: CapabilityNode['health'] = null;
      let status: CapabilityNode['status'] = isInstalled
        ? 'READY'
        : 'NOT_INSTALLED';
      let statusReason: string | null = isInstalled
        ? null
        : 'plugin is not registered in this runtime';
      if (isInstalled && input.plugins) {
        const recorded = input.plugins.healthStatus(pluginId, input.network);
        try {
          input.plugins.get(pluginId, input.network, input.now);
          health = recorded
            ? { available: true, checkedAt: recorded.checkedAt, reason: null }
            : null;
        } catch (error) {
          const code = errorCode(error);
          if (code === 'PLUGIN_UNAVAILABLE') {
            status = 'UNAVAILABLE_IN_PROFILE';
            statusReason = `${pluginId} is not deployed for ${input.network.profile}`;
          } else {
            status = 'UNHEALTHY';
            statusReason = recorded?.reason ?? code;
            health = recorded
              ? {
                  available: false,
                  checkedAt: recorded.checkedAt,
                  reason: (recorded.reason ?? code).slice(0, 200),
                }
              : null;
          }
        }
      }
      return {
        providerId: p.providerId,
        pluginId,
        kind: p.kind,
        installed: isInstalled,
        status,
        statusReason,
        facts: p.facts,
        sourceRefs: p.sourceRefs,
        health,
      };
    });
    return new CapabilityGraph(
      CapabilityGraphViewSchema.parse({
        network: input.network.profile,
        builtAt: input.now,
        nodes,
        flags: { mainnetBroadcastAllowed: input.mainnetBroadcastAllowed },
      }),
    );
  }

  static fromView(view: CapabilityGraphView): CapabilityGraph {
    return new CapabilityGraph(CapabilityGraphViewSchema.parse(view));
  }

  node(providerId: string): CapabilityNode | null {
    return this.view.nodes.find((n) => n.providerId === providerId) ?? null;
  }

  toJSON(): CapabilityGraphView {
    return structuredClone(this.view);
  }

  canPerform(
    action: CapabilityAction,
    network: ProfileName = this.view.network,
    providerId?: string,
  ): CapabilityVerdict {
    const profile = ProfileNameSchema.parse(network);
    if (providerId !== undefined)
      return this.verdict(providerId, action, profile);
    const offering = this.view.nodes.filter((n) =>
      n.facts.some((f) => f.action === action),
    );
    if (offering.length === 0)
      return {
        providerId: 'NONE',
        action,
        network: profile,
        availability: 'NOT_INSTALLED',
        reason: 'no provider declares this capability',
      };
    return offering
      .map((n) => this.verdict(n.providerId, action, profile))
      .sort(
        (a, b) =>
          PREFERENCE.indexOf(a.availability) -
          PREFERENCE.indexOf(b.availability),
      )[0]!;
  }

  private verdict(
    providerId: string,
    action: CapabilityAction,
    network: ProfileName,
  ): CapabilityVerdict {
    const result = (availability: CapabilityAvailability, reason: string) => ({
      providerId,
      action,
      network,
      availability,
      reason,
    });
    const node = this.view.nodes.find((n) => n.providerId === providerId);
    if (!node) return result('NOT_INSTALLED', 'unknown provider');
    const facts = node.facts.filter((f) => f.action === action);
    if (facts.length === 0)
      return result('NOT_INSTALLED', 'provider does not offer this action');
    const fact = facts.find((f) => f.networks.includes(network));
    if (!fact)
      return result(
        'UNAVAILABLE_IN_NETWORK_PROFILE',
        `${node.providerId} ${action} is not offered on ${network}`,
      );
    if (!node.installed)
      return result('NOT_INSTALLED', node.statusReason ?? 'not installed');
    if (node.status === 'BLOCKED_NO_CREDENTIALS')
      return result(
        'UNHEALTHY',
        `BLOCKED_NO_CREDENTIALS: ${node.statusReason}`,
      );
    if (node.status === 'UNAVAILABLE_IN_PROFILE')
      return result(
        'UNAVAILABLE_IN_NETWORK_PROFILE',
        node.statusReason ?? 'plugin not deployed for this profile',
      );
    if (node.status === 'UNHEALTHY')
      return result('UNHEALTHY', node.statusReason ?? 'health check failed');
    if (
      fact.mutating &&
      fact.disabledBy !== null &&
      !this.view.flags.mainnetBroadcastAllowed
    )
      return result('READ_ONLY', `${fact.disabledBy}=false in this run`);
    if (fact.requiresHuman)
      return result('REQUIRES_HUMAN', 'needs member approval quorum');
    return result('AVAILABLE', fact.note.slice(0, 200));
  }
}
