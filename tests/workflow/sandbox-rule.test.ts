import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkArchitecture,
  checkWorkflowSandbox,
} from '../../scripts/architecture.mjs';

function sandbox(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'synq-wf-sandbox-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return checkWorkflowSandbox(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const wf = (source: string) =>
  sandbox({ 'workers/workflow/src/workflows/flow.ts': source });

describe('workflow sandbox boundary', () => {
  it.each([
    ["import { createPublicClient } from 'viem';\n", 'imports viem'],
    ["import pg from 'pg';\n", 'imports pg'],
    ["import { createClient } from 'redis';\n", 'imports redis'],
    ["import { readFileSync } from 'node:fs';\n", 'imports node:fs'],
    ["import { Kernel } from '@synq/kernel';\n", 'imports @synq/kernel'],
    [
      "import { openDurableKernel } from '@synq/api/kernel-runtime';\n",
      'imports @synq/api/kernel-runtime',
    ],
    [
      "import { submitGrantTransaction } from '@synq/execution-worker';\n",
      'imports @synq/execution-worker',
    ],
    [
      "import { createEconomicActivities } from '../activities/economic.js';\n",
      'imports ../activities/economic.js',
    ],
    ["export const r = () => fetch('https://x');\n", 'uses fetch'],
    ['export const k = process.env.KEY;\n', 'uses process.env'],
    ["export const m = () => import('./other.js');\n", 'dynamic import'],
    ['export const t = setInterval(() => 1, 5);\n', 'uses setInterval'],
  ])('refuses %s', (source, violation) => {
    expect(wf(source)).toEqual([
      `workers/workflow/src/workflows/flow.ts: workflow sandbox ${violation}`,
    ]);
  });

  it('allows the workflow SDK, pure schemas and domain, local workflow modules and type-only imports', () => {
    expect(
      wf(
        [
          "import { condition, proxyActivities } from '@temporalio/workflow';",
          "import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';",
          "import { ACTION_MACHINE } from '@synq/domain';",
          "import type { StartActionExecution } from '@synq/schemas';",
          "import type { EconomicActivities } from '../activities/types.js';",
          "import { type Kernel } from '@synq/kernel';",
          "import { helper } from './common.js';",
          'export const ok = { condition, proxyActivities, ACTION_MACHINE, helper, s: Date.now() };',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('only applies inside workflow directories', () => {
    expect(
      sandbox({
        'workers/workflow/src/activities/economic.ts':
          "import { createPublicClient } from 'viem';\nexport const c = createPublicClient;\n",
      }),
    ).toEqual([]);
  });

  it('is part of the repository architecture check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'synq-wf-arch-'));
    try {
      mkdirSync(join(dir, 'workers/workflow/src/workflows'), {
        recursive: true,
      });
      writeFileSync(
        join(dir, 'workers/workflow/package.json'),
        JSON.stringify({ name: '@synq/workflow-worker' }),
      );
      writeFileSync(
        join(dir, 'workers/workflow/src/workflows/flow.ts'),
        "import pg from 'pg';\nexport const p = pg;\n",
      );
      expect(checkArchitecture(dir)).toContain(
        'workers/workflow/src/workflows/flow.ts: workflow sandbox imports pg',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real workflow sources pass', () => {
    expect(checkWorkflowSandbox(process.cwd())).toEqual([]);
  });
});
