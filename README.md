# Synq

The application repository is this directory. The sibling `../Synq_Agent_Build_Pack_v1.2/` is an untracked agent reference pack; its Markdown Bible specifies the architecture. Application code, tests and build records are kept here.

Node 22.23.1 and pnpm 10.28.2; run `nvm use`, `corepack enable`, then `corepack pnpm install --frozen-lockfile`. Foundry 1.2.3 and Solidity 0.8.28 are pinned. `corepack pnpm preflight` checks the local environment.

Commands: `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm build`, `corepack pnpm test`, `corepack pnpm test:contracts`, `corepack pnpm test:integration`, `corepack pnpm architecture`, `corepack pnpm test:indexer`, `corepack pnpm dev`. Full local integrations require Docker plus Anvil. Setup and evidence details are recorded in docs/ and reports/.

The local demo deploys actual sandbox contracts to a fresh Anvil chain, obtains independently signed approvals from three explicit software fixture principals, authorizes through the deterministic Kernel, transfers LOCAL_TEST tokens, then reconstructs state from actual receipts/logs. LOCAL_TEST has no AUSD relationship. Official AUSD remains the Monad testnet treasury denomination. Mainnet mutation is disabled.

Detailed setup, real indexer restart/rebuild commands and explicit external gates: [development runbook](docs/development/RUNBOOK.md). Actual capability/evidence/status: [integration report](reports/phase-completions/FOUNDATION-INTEGRATION.md).
