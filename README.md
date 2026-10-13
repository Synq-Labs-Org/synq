# Synq

Synq is a collective agentic wallet on Monad: a group chat proposes, a deterministic Kernel authorizes, and the group's Safe executes.

Node 22.23.1 and pnpm 10.28.2; run `nvm use`, `corepack enable`, then `corepack pnpm install --frozen-lockfile`. Foundry 1.2.3 and Solidity 0.8.28 are pinned. `corepack pnpm preflight` checks the local environment.

Commands: `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm build`, `corepack pnpm test`, `corepack pnpm test:contracts`, `corepack pnpm test:integration`, `corepack pnpm architecture`, `corepack pnpm demo`, `corepack pnpm test:indexer`, `corepack pnpm dev`. Full local integrations require Docker plus Anvil.

The local demo deploys actual sandbox contracts to a fresh Anvil chain, obtains independently signed approvals from three explicit software fixture principals, authorizes through the deterministic Kernel, transfers LOCAL_TEST tokens, then reconstructs state from actual receipts/logs. LOCAL_TEST has no AUSD relationship. Official AUSD remains the Monad testnet treasury denomination. Mainnet mutation is disabled.
