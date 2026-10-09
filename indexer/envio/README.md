# Synq indexed proof (Envio 3.14)

`config.yaml` indexes the Synq factory, registry and module from the deployment block, registers every group Safe from `GroupCreated` (`contractRegister`), indexes SafeL2 owner/threshold/module/guard events of those Safes, and indexes official AUSD `Transfer` events only when a registered account is sender or recipient (wildcard event with a `where` filter on `chain.TreasuryAccount.addresses`; non-treasury tokens are dropped in the handler). `rollback_on_reorg` is on. All addresses and the start block come from `sources/chain_registry.json` and `contracts/deployments/<chainId>.json` (+ receipts) via `scripts/envio-env.ts`.

Commands from the repository root:

- `corepack pnpm indexer:codegen && corepack pnpm indexer:typecheck`
- `corepack pnpm indexer:start [profile] [observed-accounts.json]` runs `envio start` for the profile (default `sandbox/monad-testnet`); set `ENVIO_PG_*` for the database.
- `corepack pnpm indexer:testnet-evidence` indexes Monad testnet from the deployment block, projects it and writes `reports/evidence/envio-testnet/`.
- `corepack pnpm test:indexer` runs the Envio fork suite (needs `anvil`, Postgres and Redis from `infra/compose.yaml`, and network access to the Monad testnet RPC).

The RPC source is used (`for: sync`), so no HyperSync token is needed; public Monad RPC limits `eth_getLogs` to 100 blocks, which `SYNQ_RPC_LOG_RANGE` encodes. Handlers write only `ChainEvent` rows with id `chainId:txHash:logIndex`; the application projection in `packages/read-model` consumes them with `envio_chains.progress_block`. See ADR-0007.
