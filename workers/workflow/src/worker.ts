import { fileURLToPath } from 'node:url';
import {
  NativeConnection,
  Worker,
  bundleWorkflowCode,
  type BundleOptions,
  type WorkerOptions,
  type WorkflowBundleWithSourceMap,
} from '@temporalio/worker';
import type { WorkflowConfig, WorkflowFamily } from './config.js';
import type { SynqActivities } from './activities/types.js';

export const WORKFLOWS_PATH = fileURLToPath(
  new URL('./workflows/index.ts', import.meta.url),
);

type WebpackCompiler = {
  webpack: {
    NormalModuleReplacementPlugin: new (
      pattern: RegExp,
      replace: (resource: { request: string }) => void,
    ) => { apply(compiler: WebpackCompiler): void };
  };
};

/**
 * Workspace packages import Node built-ins with the `node:` scheme (for example `@synq/domain`'s id
 * generator). The sandbox never calls them; the scheme is stripped so Temporal's ignore list applies,
 * and any runtime use inside a workflow throws.
 */
export const WORKFLOW_BUNDLER_OPTIONS: Pick<
  BundleOptions,
  'ignoreModules' | 'webpackConfigHook'
> = {
  ignoreModules: ['crypto'],
  webpackConfigHook: (config) => ({
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      {
        apply(compiler: WebpackCompiler) {
          new compiler.webpack.NormalModuleReplacementPlugin(
            /^node:/,
            (resource) => {
              resource.request = resource.request.replace(/^node:/, '');
            },
          ).apply(compiler);
        },
      },
    ],
  }),
};

export async function bundleSynqWorkflows(
  workflowsPath: string = WORKFLOWS_PATH,
): Promise<WorkflowBundleWithSourceMap> {
  return bundleWorkflowCode({
    workflowsPath,
    ...WORKFLOW_BUNDLER_OPTIONS,
    logger: {
      log: () => undefined,
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => console.warn(message),
      error: (message) => console.error(message),
    },
  });
}

export type SynqWorkerOptions = {
  connection: NativeConnection;
  config: WorkflowConfig;
  activities: Partial<SynqActivities>;
  bundle: WorkflowBundleWithSourceMap;
  families?: readonly WorkflowFamily[];
  overrides?: Partial<WorkerOptions>;
};

/** One worker per workflow-family task queue, sharing the bundle and the Activity implementations. */
export async function createSynqWorkers(
  options: SynqWorkerOptions,
): Promise<Worker[]> {
  const families =
    options.families ??
    (['economic', 'approval', 'strategy', 'operations'] as const);
  const { config } = options;
  const deployment = config.deployment.buildId
    ? {
        workerDeploymentOptions: {
          version: {
            deploymentName: config.deployment.name,
            buildId: config.deployment.buildId,
          },
          useWorkerVersioning: true as const,
          defaultVersioningBehavior: 'PINNED' as const,
        },
      }
    : {};
  return Promise.all(
    families.map((family) =>
      Worker.create({
        connection: options.connection,
        namespace: config.namespace,
        taskQueue: config.taskQueues[family],
        workflowBundle: options.bundle,
        activities: options.activities,
        ...deployment,
        ...options.overrides,
      }),
    ),
  );
}

export async function runSynqWorkers(
  workers: readonly Worker[],
): Promise<void> {
  await Promise.all(workers.map((w) => w.run()));
}
