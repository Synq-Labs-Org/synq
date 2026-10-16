# Synq

Synq is an AI finance team for freelancers and small businesses, running on Arc. You talk to it in a chat. Its agents draft invoices, collect payment and propose payouts. Money moves only after an owner-signed mandate passes a deterministic Kernel and a governed vault on chain. Agents propose; they never hold keys, and a chat "yes" is never an approval.

Everything here runs on **Arc testnet (chain 5042002)** and Ethereum Sepolia. Mainnet broadcasting is disabled (`SYNQ_ALLOW_MAINNET_BROADCAST=false`), and Arc mainnet is read-only in the registry.

## What works

- **Arc USDC payments.** Exact integer amounts. The 18-decimal native and 6-decimal ERC-20 views of USDC are kept apart, and Arc's mirror Transfer log is never counted. Receipts are reconciled after every send.
- **Invoices and checkout.** Invoices are bound to payments through Arc's Memo contract. Partial, exact and overpaid invoices are handled. A checkout API and page (`/pay/[token]`) are backed by Postgres.
- **Cross-chain collection.**
  - Circle CCTP V2 from Sepolia to Arc, with the invoice reference in hookData. An invoice is marked paid only after its mint is reconciled.
  - Circle Gateway deposits and spends.
  - A route ladder picks the cheapest route within the fee policy: direct Arc USDC, then CCTP, then Gateway, otherwise a human handoff.
- **Authority chain.** An owner-signed EIP-712 mandate, then the Kernel's `decide`, then a one-use MAC'd grant bound to the exact call. The executor admits the grant before it signs. Every payout that starts in a chat needs an EIP-712 approval from the owner.
- **Governed vault and escrow.** Canonical Safe v1.4.1 on Arc with a non-upgradeable Synq policy:
  - timelocked governance;
  - a scoped operator with an allowlist and per-payment and 24-hour caps;
  - a bounded guardian pause;
  - a restricted ERC-1271 handler;
  - milestone escrow with a dispute deadline.
- **Exactly-once execution.** Signed bytes are recorded before broadcast, and recovery never signs twice. There is a transactional outbox, a consumer inbox, a reorg-aware indexer and cash reservations.
- **Governance.** Snapshots, delegation, an M-of-N council whose decisions are consumed once, and channel linking by wallet signature plus a one-time code.
- **Telegram.** Guest Mode (`answerGuestQuery`), a webhook secret, Mini App initData checks, and opt-in chat memory (off by default).
- **Finance AI team.**
  - A Supervisor leads the Invoice, CFO, Payment, Risk and Audit agents over a fresh WorldSnapshot.
  - A decision needs data no older than 60 s.
  - Risk can hard-block a changed payout wallet.
  - Audit explains every payment from on-chain reads.

Not yet live: Circle developer-controlled and agent wallets, which wait on Circle credentials (a local testnet EOA stands in, clearly labelled), and the live Telegram guest round trip, which needs BotFather Guest Mode and a deploy.

## Setup

Toolchain:

- Node 22.23.1 and pnpm 10.28.2. Run `nvm use`, `corepack enable`, then `corepack pnpm install --frozen-lockfile`.
- Foundry 1.2.3 and Solidity 0.8.28 are pinned.
- `corepack pnpm preflight` checks the local environment.

Addresses and contract code hashes live only in `sources/arc_registry.json`. Code hashes are checked before every call.

Testnet keys and provider credentials are read from `~/.synq` (mode 600) and are never committed. Load them with `set -a; . ~/.synq/p11.env; set +a`.

## Commands

| Command                          | What it does                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `corepack pnpm typecheck`        | TypeScript, including the web app                                                         |
| `corepack pnpm lint`             | ESLint plus the architecture boundaries (only `workers/execution` and `scripts` may sign) |
| `corepack pnpm secrets`          | Secret scan of tracked files                                                              |
| `corepack pnpm format:check`     | Prettier                                                                                  |
| `corepack pnpm test`             | Unit tests                                                                                |
| `corepack pnpm test:contracts`   | Foundry tests, including the Arc vault and escrow                                         |
| `corepack pnpm test:integration` | Postgres, Anvil, Redis and Temporal suites (needs Docker; runs in CI)                     |
| `corepack pnpm dev`              | API server                                                                                |

## Arc testnet proofs

Each script sends real testnet transactions and writes JSON evidence. All of them refuse to run against mainnet.

```sh
node --import tsx scripts/arc-freelancer-demo.ts    # end-to-end: chat → invoice → CCTP payment → vault payout → audit → fraud block → books vs chain
node --import tsx scripts/arc-transfer.ts           # Arc USDC transfer and reconciliation
node --import tsx scripts/arc-granted-payout.ts     # Kernel-granted payout
node --import tsx scripts/arc-invoice-proof.ts      # Memo-bound invoice payments
node --import tsx scripts/arc-checkout-proof.ts     # checkout API + Postgres + Memo payment
node --import tsx scripts/arc-cctp-proof.ts         # CCTP V2 Sepolia → Arc
node --import tsx scripts/arc-gateway-proof.ts      # Gateway deposit and spend
node --import tsx scripts/arc-outbox-proof.ts --key k --crash; node --import tsx scripts/arc-outbox-proof.ts --key k   # crash after broadcast, no re-sign
node --import tsx scripts/arc-ap-proof.ts           # contractor payout and changed-wallet denial
node --import tsx scripts/arc-vault-proof.ts        # Safe vault, timelock, pause and escrow
```

The checkout and demo scripts need Postgres.

## Safety rules

- No mainnet value-moving transactions without fresh, explicit human authorization.
- LLM agents never get treasury keys, and chat messages never count as signed approvals.
- A phone number or Telegram username alone is never financial authorization.
- No mock integration is presented as live.
