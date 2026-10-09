import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const workflow = readFileSync('.github/workflows/verify.yml', 'utf8');
const scripts: Record<string, string> = JSON.parse(
  readFileSync('package.json', 'utf8'),
).scripts;

it('CI pins third-party actions by commit SHA, needs no secrets and runs every section 72 gate including SAST', () => {
  const uses = [...workflow.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]!);
  expect(uses.length).toBeGreaterThan(0);
  for (const action of uses)
    expect(action).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w.-]+)?@[0-9a-f]{40}$/);
  expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
  expect(workflow).toMatch(/^permissions:\s*\n\s*contents: read/m);
  expect(workflow.match(/security-events: write/g)).toHaveLength(1);
  for (const sast of ['codeql-action/init@', 'codeql-action/analyze@'])
    expect(workflow).toContain(sast);
  expect(workflow).toContain('queries: security-extended');
  for (const gate of [
    'pnpm format:check',
    'eslint packages apps workers scripts tests',
    'pnpm typecheck',
    'pnpm architecture',
    'pnpm secrets',
    'pnpm test:schema-compat',
    'pnpm test:plugins',
    'pnpm test:report',
    'pnpm build',
    'forge fmt --root contracts --check',
    'forge build --root contracts',
    'forge test --root contracts',
    'pnpm test:integration',
  ])
    expect(workflow, gate).toContain(gate);
  for (const script of [
    'format:check',
    'typecheck',
    'architecture',
    'secrets',
    'test:schema-compat',
    'test:plugins',
    'test:report',
    'test:integration',
  ])
    expect(scripts[script], script).toBeDefined();
});
