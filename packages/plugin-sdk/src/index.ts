import {
  PluginManifestSchema,
  type ActionIntent,
  type ExecutionGrant,
  type ExecutionReceipt,
  type NetworkProfile,
  type PluginManifest,
  type Simulation,
} from '../../schemas/src/index.js';

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
  manifest: PluginManifest;
  health(
    context: PluginContext,
  ): Promise<{ available: boolean; checkedAt: number }>;
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
export class PluginRegistry {
  private readonly plugins = new Map<string, SynqPlugin>();
  register(plugin: SynqPlugin): void {
    const manifest = PluginManifestSchema.parse(plugin.manifest);
    if (this.plugins.has(manifest.id)) throw new Error('PLUGIN_CONFLICT');
    if (
      manifest.riskClass === 'FINANCIAL_EXECUTION' &&
      (!plugin.prepare ||
        !plugin.simulate ||
        !plugin.execute ||
        !plugin.reconcile)
    )
      throw new Error('PLUGIN_MUTATOR_INCOMPLETE');
    Object.freeze(manifest.capabilities);
    Object.freeze(manifest.chains);
    Object.freeze(manifest.environments);
    Object.freeze(manifest.sourceDocs);
    Object.freeze(manifest);
    this.plugins.set(manifest.id, Object.freeze({ ...plugin, manifest }));
  }
  get(id: string, network: NetworkProfile): SynqPlugin {
    const plugin = this.plugins.get(id);
    if (
      !plugin ||
      !plugin.manifest.chains.includes(network.chainId) ||
      !plugin.manifest.environments.includes(network.profile)
    )
      throw new Error('PLUGIN_UNAVAILABLE');
    return plugin;
  }
}
