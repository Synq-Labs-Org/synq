import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkflowConfig } from '../../../workers/workflow/src/config.js';
import type { CrashPoint } from '../../../workers/workflow/src/activities/faults.js';

const ENTRY = resolve('workers/workflow/src/local/worker-main.ts');

export type WorkerProcessOptions = {
  manifestPath: string;
  address: string;
  config: WorkflowConfig;
  crashAt?: CrashPoint;
  faultDir?: string;
  extraEnv?: Record<string, string>;
};

/** A local-anvil worker in its own OS process, so the harness can SIGKILL it at any point. */
export class WorkerProcess {
  static readonly live = new Set<WorkerProcess>();
  static async killAll(): Promise<void> {
    await Promise.all([...WorkerProcess.live].map((w) => w.kill9()));
  }
  private stderr = '';
  private exited: Promise<number | null>;
  private constructor(readonly child: ChildProcess) {
    WorkerProcess.live.add(this);
    this.exited = new Promise((r) =>
      child.once('exit', (code) => {
        WorkerProcess.live.delete(this);
        r(code);
      }),
    );
    child.stderr?.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-20_000);
    });
  }
  get pid(): number {
    return this.child.pid!;
  }
  get log(): string {
    return this.stderr;
  }

  static async start(options: WorkerProcessOptions): Promise<WorkerProcess> {
    const { config } = options;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', ENTRY, options.manifestPath],
      {
        cwd: resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          TEMPORAL_ADDRESS: options.address,
          TEMPORAL_NAMESPACE: config.namespace,
          SYNQ_TQ_ECONOMIC: config.taskQueues.economic,
          SYNQ_TQ_APPROVAL: config.taskQueues.approval,
          SYNQ_TQ_STRATEGY: config.taskQueues.strategy,
          SYNQ_TQ_OPERATIONS: config.taskQueues.operations,
          SYNQ_ALLOW_MAINNET_BROADCAST: 'false',
          SYNQ_WORKFLOW_LOG_LEVEL: 'ERROR',
          ...(options.crashAt
            ? { SYNQ_WORKFLOW_CRASH_AT: options.crashAt }
            : {}),
          ...(options.faultDir
            ? { SYNQ_WORKFLOW_FAULT_DIR: options.faultDir }
            : {}),
          ...options.extraEnv,
        },
      },
    );
    const worker = new WorkerProcess(child);
    await new Promise<void>((resolveReady, reject) => {
      let out = '';
      const timer = setTimeout(
        () => reject(new Error(`worker not ready: ${worker.stderr}`)),
        90_000,
      );
      child.stdout!.on('data', (chunk) => {
        out += String(chunk);
        if (out.includes('"ready":true')) {
          clearTimeout(timer);
          resolveReady();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`worker exited ${code}: ${worker.stderr}`));
      });
    });
    return worker;
  }

  /** Hard kill: no shutdown hooks, no in-flight completion, exactly like a crashed host. */
  async kill9(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGKILL');
    await this.exited;
  }
  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 10_000);
    await this.exited;
    clearTimeout(timer);
  }
}

export async function waitForMarker(
  dir: string,
  point: CrashPoint,
  worker: WorkerProcess,
  timeoutMs = 90_000,
): Promise<void> {
  const marker = join(dir, `reached-${point}`);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(marker)) {
    if (worker.child.exitCode !== null)
      throw new Error(`worker exited before ${point}: ${worker.log}`);
    if (Date.now() > deadline)
      throw new Error(`crash point ${point} not reached: ${worker.log}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
