import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [phase = '', ...vitestArgs] = process.argv.slice(2);
if (!/^P\d{2}$/.test(phase)) {
  console.error('usage: node scripts/test-report.mjs <PXX> [vitest args]');
  process.exit(2);
}
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
};
const commit = git('rev-parse', 'HEAD');
const startedAt = new Date().toISOString();
const runId = `${startedAt.replace(/[:.]/g, '-')}-${(commit ?? 'nogit').slice(0, 12)}`;
const directory = join('reports', 'tests', phase, runId);
mkdirSync(directory, { recursive: true });
const resultsPath = join(directory, 'vitest.json');
const args = vitestArgs.length
  ? vitestArgs
  : ['--exclude', '**/*.integration.test.ts'];
const child = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--reporter=json',
    `--outputFile=${resultsPath}`,
    '--reporter=default',
    ...args,
  ],
  { stdio: 'inherit' },
);
const results = JSON.parse(readFileSync(resultsPath, 'utf8'));
const matrix = {};
for (const file of results.testResults ?? [])
  for (const test of file.assertionResults ?? [])
    for (const id of test.fullName.match(/\b(?:[A-Z]{2,7}|P\d{2})-\d{3}\b/g) ??
      [])
      (matrix[id] ??= []).push({ test: test.fullName, status: test.status });
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const summary = {
  phase,
  runId,
  startedAt,
  completedAt: new Date().toISOString(),
  commit,
  dirtyTree: (git('status', '--porcelain') ?? '') !== '',
  networkProfile: process.env.SYNQ_NETWORK ?? 'local/anvil',
  node: process.versions.node,
  toolVersions: manifest.devDependencies,
  runtimeVersions: manifest.dependencies,
  vitestArgs: args,
  exitCode: child.status,
  totals: {
    suites: results.numTotalTestSuites,
    tests: results.numTotalTests,
    passed: results.numPassedTests,
    failed: results.numFailedTests,
    skipped: results.numPendingTests + (results.numTodoTests ?? 0),
  },
  matrix,
};
writeFileSync(
  join(directory, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
);
console.log(`Machine-readable results: ${directory}`);
process.exitCode = child.status ?? 1;
