import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeterminismViolationError } from '@temporalio/workflow';
import { Worker, bundleWorkflowCode } from '@temporalio/worker';
import {
  WORKFLOW_BUNDLER_OPTIONS,
  WORKFLOWS_PATH,
} from '../../workers/workflow/src/worker.js';
import { quietRuntime } from './harness/temporal.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(resolve('tests/workflow/fixtures', name), 'utf8'));

type WebpackCompiler = {
  webpack: {
    NormalModuleReplacementPlugin: new (
      pattern: RegExp,
      replace: (resource: { request: string }) => void,
    ) => { apply(compiler: WebpackCompiler): void };
  };
};

/** Bundles the real workflows, optionally swapping the version gate module for a test variant. */
async function bundle(versionsModule?: string) {
  const base = WORKFLOW_BUNDLER_OPTIONS.webpackConfigHook!;
  return bundleWorkflowCode({
    workflowsPath: WORKFLOWS_PATH,
    ignoreModules: WORKFLOW_BUNDLER_OPTIONS.ignoreModules!,
    logger: {
      log() {},
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    webpackConfigHook: (config) => {
      const hooked = base(config);
      if (!versionsModule) return hooked;
      return {
        ...hooked,
        plugins: [
          ...(hooked.plugins ?? []),
          {
            apply(compiler: WebpackCompiler) {
              new compiler.webpack.NormalModuleReplacementPlugin(
                /[\\/]versions\.js$/,
                (r) => {
                  r.request = resolve(
                    'tests/workflow/fixtures/versions',
                    versionsModule,
                  );
                },
              ).apply(compiler);
            },
          },
        ],
      };
    },
  });
}

describe('workflow versioning: replay of recorded histories against current code', () => {
  it('a history recorded before the settlement-recheck patch replays on current code', async () => {
    quietRuntime();
    await Worker.runReplayHistory(
      { workflowBundle: await bundle() },
      fixture('action-execution.v1.history.json'),
      'fixture.action-execution.v1',
    );
  });

  it('a history recorded with the patch replays on current code', async () => {
    await Worker.runReplayHistory(
      { workflowBundle: await bundle() },
      fixture('action-execution.v2.history.json'),
      'fixture.action-execution.v2',
    );
  });

  it('deprecatePatch keeps patched histories replayable once pre-patch histories are gone', async () => {
    await Worker.runReplayHistory(
      { workflowBundle: await bundle('deprecated.ts') },
      fixture('action-execution.v2.history.json'),
      'fixture.action-execution.v2',
    );
  });

  it('an unpatched behaviour change is caught as a DeterminismViolationError', async () => {
    const replay = Worker.runReplayHistory(
      { workflowBundle: await bundle('unpatched.ts') },
      fixture('action-execution.v1.history.json'),
      'fixture.action-execution.v1',
    );
    await expect(replay).rejects.toBeInstanceOf(DeterminismViolationError);
  });
});
