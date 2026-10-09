import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
const failures: string[] = [];
if (process.versions.node.split('.')[0] !== '22')
  failures.push('Node 22 required; run nvm use.');
if (!existsSync('pnpm-lock.yaml'))
  failures.push('Missing pnpm-lock.yaml; run corepack pnpm install.');
for (const tool of ['forge', 'anvil']) {
  try {
    console.log(
      execFileSync(tool, ['--version'], { encoding: 'utf8' }).split('\n')[0],
    );
  } catch {
    failures.push(`${tool} is required for real local integration tests.`);
  }
}
const network = process.env.SYNQ_NETWORK ?? 'local';
if (!['local', 'monad-testnet'].includes(network))
  failures.push('Only local and monad-testnet profiles are enabled.');
if (network === 'monad-testnet' && !process.env.SYNQ_TESTNET_KEY_FILE)
  failures.push(
    'SYNQ_TESTNET_KEY_FILE must reference a test-only key outside source control for deployment.',
  );
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Preflight passed: Node ${process.versions.node}; ${network}; no signing key required for unit tests.`,
  );
