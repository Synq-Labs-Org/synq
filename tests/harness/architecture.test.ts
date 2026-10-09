import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { checkArchitecture } from '../../scripts/architecture.mjs';
it('detects indirect forbidden planner signing imports and dependency cycles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synq-boundary-'));
  try {
    mkdirSync(join(dir, 'packages/agent-runtime'), { recursive: true });
    mkdirSync(join(dir, 'workers/execution'), { recursive: true });
    writeFileSync(
      join(dir, 'packages/agent-runtime/index.ts'),
      "import { signer } from '../../workers/execution/index.js';\n",
    );
    writeFileSync(
      join(dir, 'workers/execution/index.ts'),
      "import '../../packages/agent-runtime/index.js';\n",
    );
    const errors: string[] = checkArchitecture(dir);
    expect(errors.some((e) => e.includes('signing authority'))).toBe(true);
    expect(errors.some((e) => e.includes('cycle'))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
