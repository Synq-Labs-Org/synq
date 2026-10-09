import {
  PluginError,
  PluginHealthSchema,
  PluginManifestSchema,
  parseOrThrow,
  type ActionIntent,
  type ExecutionGrant,
  type ExecutionReceipt,
  type NetworkProfile,
  type PluginHealth,
  type PluginManifest,
  type PluginManifestInput,
  type Simulation,
} from '@synq/domain';

export type PluginContext = Readonly<{ network: NetworkProfile; now: number }>;
export type PreparedAction = Readonly<{
  chainId: number;
  account: `0x${string}`;
  target: `0x${string}`;
  calldata: `0x${string}`;
  value: string;
  intentHash: `0x${string}`;
}>;
export interface BoundedExecutor {
  execute(
    grant: ExecutionGrant,
    actions: readonly PreparedAction[],
  ): Promise<ExecutionReceipt>;
}
export interface SynqPlugin {
  manifest: PluginManifestInput;
  health(context: PluginContext): Promise<PluginHealth>;
  read?(context: PluginContext, request: unknown): Promise<unknown>;
  quote?(
    context: PluginContext,
    intent: ActionIntent,
  ): Promise<{
    intentHash: `0x${string}`;
    expiresAt: number;
    artifactHash: `0x${string}`;
  }>;
  prepare?(
    context: PluginContext,
    grant: ExecutionGrant,
  ): Promise<readonly PreparedAction[]>;
  simulate?(
    context: PluginContext,
    actions: readonly PreparedAction[],
  ): Promise<Simulation>;
  execute?(
    context: PluginContext,
    grant: ExecutionGrant,
    actions: readonly PreparedAction[],
    executor: BoundedExecutor,
  ): Promise<ExecutionReceipt>;
  reconcile?(
    context: PluginContext,
    receipt: ExecutionReceipt,
  ): Promise<ExecutionReceipt>;
}
export type RegisteredPlugin = Readonly<
  Omit<SynqPlugin, 'manifest'> & { manifest: Readonly<PluginManifest> }
>;
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly health = new Map<string, PluginHealth>();
  register(plugin: SynqPlugin): Readonly<PluginManifest> {
    const manifest = deepFreeze(
      parseOrThrow(PluginManifestSchema, plugin.manifest),
    );
    if (this.plugins.has(manifest.id))
      throw new PluginError('PLUGIN_CONFLICT', manifest.id);
    if (
      manifest.riskClass === 'FINANCIAL_EXECUTION' &&
      (!plugin.prepare ||
        !plugin.simulate ||
        !plugin.execute ||
        !plugin.reconcile)
    )
      throw new PluginError('PLUGIN_MUTATOR_INCOMPLETE', manifest.id);
    this.plugins.set(manifest.id, Object.freeze({ ...plugin, manifest }));
    return manifest;
  }
  manifests(): Readonly<PluginManifest>[] {
    return [...this.plugins.values()].map((p) => p.manifest);
  }
  async refreshHealth(id: string, context: PluginContext): Promise<boolean> {
    const plugin = this.supported(id, context.network);
    let result: PluginHealth;
    try {
      result = parseOrThrow(PluginHealthSchema, await plugin.health(context));
    } catch {
      result = {
        available: false,
        checkedAt: context.now,
        reason: 'health check failed',
      };
    }
    if (result.checkedAt > context.now)
      result = {
        available: false,
        checkedAt: context.now,
        reason: 'health timestamp in the future',
      };
    this.health.set(id, result);
    return result.available;
  }
  get(id: string, network: NetworkProfile, now: number): RegisteredPlugin {
    const plugin = this.supported(id, network);
    const health = this.health.get(id);
    if (
      !health ||
      !health.available ||
      now < health.checkedAt ||
      now - health.checkedAt > plugin.manifest.health.maxStalenessSeconds
    )
      throw new PluginError('PLUGIN_UNHEALTHY', id);
    return plugin;
  }
  private supported(id: string, network: NetworkProfile): RegisteredPlugin {
    const plugin = this.plugins.get(id);
    if (
      !plugin ||
      !plugin.manifest.chains.includes(network.chainId) ||
      !plugin.manifest.environments.includes(network.profile)
    )
      throw new PluginError('PLUGIN_UNAVAILABLE', id);
    return plugin;
  }
}
