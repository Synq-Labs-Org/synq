# Synq indexed proof

Pinned real Envio 3.14.0 uses `chains`, `indexer.onEvent` and `.envio/types.d.ts`. From this directory run `pnpm install --ignore-workspace`, copy `.env.example` to `.env`, fill actual deployed addresses and the start block, then `pnpm codegen`, `pnpm typecheck` and `pnpm start`. PostgreSQL connection variables use Envio's documented names; local credentials are never production secrets. RPC `for: sync` uses the configured RPC instead of requiring a HyperSync token. Starting at block zero captures complete token balance history; a later start requires a separately verified baseline and is not currently supported by the projector.

The TreasuryToken entry is the verified official AUSD address in the testnet example. A local explicit test token is allowed only in a local chain profile and must remain labelled as a test token. Registry/module addresses have no guessed defaults. Never put the application treasury key in an indexer environment.

Handlers write only versioned ChainEvent entities through Envio's rollback-aware context. The application consumes the canonical rows and `envio_chains.progress_block`, not the block of the last event. PostgreSQL application projection receives the initial deployment/membership artifact and indexes exact subscribed event proofs. Any reorg requires replacing the journal suffix before dependent authorization resumes. Redis flush or application projection deletion can rebuild from canonical rows and artifacts. A live testnet claim additionally needs actual deployment receipts and independently checked indexed progress.

Envio codegen does not check handlers; `pnpm typecheck` is mandatory after generation. Tests in `tests/read-model` distinguish event fixtures, real storage integration, and live indexing evidence.
