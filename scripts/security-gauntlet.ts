import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const targets = [
  [
    'Prompt injection',
    'tests/brain/evals.test.ts',
    'prompt injection in web evidence cannot move funds',
  ],
  [
    'Agent privilege escalation',
    'tests/brain/evals.test.ts',
    'tries to call the signer directly',
  ],
  [
    'Subagent capability escalation',
    'tests/brain/subagents.test.ts',
    'Capabilities(child)',
  ],
  [
    'Fake plugin capability',
    'tests/brain/evals.test.ts',
    'missing plugin and an unknown provider',
  ],
  ['Stale WorldSnapshot', 'tests/brain/evals.test.ts', 'stale market snapshot'],
  [
    'Wrong AUSD address',
    'tests/kuru/flow.test.ts',
    'wrong token and wrong chain',
  ],
  [
    'Same-symbol malicious token',
    'tests/perpl/collateral-markets.test.ts',
    'without trusting the symbol',
  ],
  [
    'Bridge duplicate settlement',
    'tests/funding/storage.integration.test.ts',
    'one chain event cannot credit two sessions',
  ],
  [
    'Temporal duplicate signal',
    'tests/workflow/action-execution.integration.test.ts',
    'duplicate approval update once',
  ],
  [
    'Duplicate economic Activity',
    'tests/workflow/action-execution.integration.test.ts',
    'timeout',
  ],
  [
    'Kuru quote tampering',
    'tests/kuru/flow.test.ts',
    'min-output breach and slippage beyond policy',
  ],
  [
    'Kuru calldata mutation',
    'tests/kuru/flow.test.ts',
    'calldata mutation is rejected',
  ],
  [
    'Stale CRE attestation',
    'tests/cre/stable-risk-gate.test.ts',
    'stale underlying references',
  ],
  [
    'Fake risk-attestation writer',
    'tests/cre/risk-gate.integration.test.ts',
    'unauthorized writer',
  ],
  [
    'Perpl API-key theft simulation',
    'tests/perpl/auth.test.ts',
    'read-only key trading attempt',
  ],
  [
    'Perpl withdrawal attempt',
    'tests/perpl/boundaries.test.ts',
    'no withdraw or transfer path',
  ],
  [
    'WebSocket event replay',
    'tests/perpl/ws.test.ts',
    'dedups duplicate fills',
  ],
  [
    'Cross-network collateral confusion',
    'tests/perpl/collateral-markets.test.ts',
    'wrong collateral',
  ],
  [
    'Mainnet/testnet config mixup',
    'tests/brain/evals.test.ts',
    'wrong network profile',
  ],
] as const;
const evidenceDir = resolve('bounty-evidence/integration');
mkdirSync(evidenceDir, { recursive: true });
const outputPath = resolve(evidenceDir, 'gauntlet-vitest.json');
const dedicatedFile = 'tests/gauntlet/integrated-attacks.test.ts';
const files = [dedicatedFile, ...new Set(targets.map((t) => t[1]))];
const args = [
  'pnpm',
  'exec',
  'vitest',
  'run',
  ...files,
  '--maxWorkers=2',
  '--no-file-parallelism',
  '--testTimeout=60000',
  '--hookTimeout=180000',
  '--reporter=json',
  `--outputFile=${outputPath}`,
];
const exitCode = await new Promise<number>((done, reject) => {
  const child = spawn('corepack', args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      SYNQ_ALLOW_MAINNET_BROADCAST: 'false',
      SYNQ_MAINNET_CANARY_MAX_USD: '0',
    },
  });
  child.once('error', reject);
  child.once('exit', (code) => done(code ?? 1));
});
type Assertion = { fullName: string; status: string };
const report = JSON.parse(readFileSync(outputPath, 'utf8')) as {
  numPassedTests: number;
  numFailedTests: number;
  testResults: { name: string; assertionResults: Assertion[] }[];
};
const table = targets.map(([target, file, pattern], index) => {
  const cases = report.testResults
    .filter((r) => r.name.endsWith(file))
    .flatMap((r) => r.assertionResults)
    .filter((a) => a.fullName.toLowerCase().includes(pattern.toLowerCase()));
  const dedicated = report.testResults
    .filter((r) => r.name.endsWith(dedicatedFile))
    .flatMap((r) => r.assertionResults)
    .filter((a) => a.fullName.includes(`target ${index + 1}:`));
  const passed =
    cases.length > 0 &&
    cases.every((c) => c.status === 'passed') &&
    dedicated.length === 1 &&
    dedicated[0]?.status === 'passed';
  return {
    targetId: index + 1,
    target,
    file,
    dedicatedFile,
    dedicatedCases: dedicated.map((c) => c.fullName),
    cases: cases.map((c) => c.fullName),
    status: passed ? 'PASS' : 'FAIL',
    attackerWins: passed ? 0 : null,
  };
});
const passed = exitCode === 0 && table.every((t) => t.status === 'PASS');
const result = {
  executionMode: 'SIMULATION',
  criterion:
    'Unauthorized economic state mutation. Dedicated Brain/World/Kernel/Temporal/local venue scenarios compare balances, economic nonces, registry state, grants and venue positions before/after; mapped boundary regressions additionally assert zero grants, zero attacker-directed transfers, no double credits/orders, or absence of a withdrawal/signing authority. Allowed control executions are counted separately by those tests.',
  command: ['corepack', ...args].join(' '),
  passedTests: report.numPassedTests,
  failedTests: report.numFailedTests,
  attackerWins: passed ? 0 : null,
  status: passed ? 'PASS' : 'FAIL',
  targets: table,
};
writeFileSync(
  resolve(evidenceDir, 'gauntlet-results.json'),
  JSON.stringify(result, null, 2) + '\n',
);
writeFileSync(
  resolve(evidenceDir, 'GAUNTLET.md'),
  '# Adversarial gauntlet\n\nExecution mode: SIMULATION. Criterion: unauthorized economic state mutation. A passing guard is evidence for zero attacker wins in the exercised path; this is not a proof against every possible attack.\n\n| # | Target | Result | Attacker wins | Executable evidence |\n|---|---|---|---|---|\n' +
    table
      .map(
        (t) =>
          `| ${t.targetId} | ${t.target} | ${t.status} | ${t.attackerWins ?? 'UNKNOWN'} | [${t.file}](../../${t.file}) |`,
      )
      .join('\n') +
    '\n\nRaw results: [gauntlet-vitest.json](gauntlet-vitest.json). Coverage mapping: [gauntlet-results.json](gauntlet-results.json).\n',
);
console.log(
  JSON.stringify({
    status: result.status,
    targets: table.length,
    attackerWins: result.attackerWins,
    passedTests: result.passedTests,
  }),
);
if (!passed) process.exitCode = 1;
