---
title: Chain registry
description: The single source of truth for networks, assets and contract addresses, and why code never compares raw chain ids.
---

`packages/chain-registry` pins every network, token and contract Synq touches. Addresses live in exactly one data file, `sources/arc_registry.json`, which the package loads and validates with Zod at import time. Nothing in the registry is inferred from model output: the only way to name an asset is through its tables.

## Networks

The Arc registry (`packages/chain-registry/src/arc.ts`) defines these profiles:

| Name                                         | Chain id                | Role                                       | Mutation |
| -------------------------------------------- | ----------------------- | ------------------------------------------ | -------- |
| `arc-testnet`                                | 5042002                 | The home network. Native gas token is USDC | Enabled  |
| `arc-mainnet`                                | 5042                    | Read-only                                  | Disabled |
| `eth-sepolia`, `base-sepolia`, `arb-sepolia` | 11155111, 84532, 421614 | Circle CCTP testnet source routes          | Enabled  |

Each profile carries its RPC environment variable name and fallback RPC list, explorer, faucet, native symbol, confirmations, the Circle CCTP domain, and for Arc the published base-fee floor (20 gwei) that executors never bid below. Executors refuse to sign for any chain whose profile has `mutationEnabled: false`.

The older registry in `src/index.ts` keeps the archived Monad profiles (`sandbox/monad-testnet`, `proof/monad-mainnet`) and the local Anvil profile `local/anvil`, which CI uses as `SYNQ_NETWORK`. Those deployments must never be replayed on Arc.

## Assets and contracts

- `token(chain, symbol)` returns a registry asset (`USDC`, `EURC`, `USYC`) with address, decimals and a pinned bytecode hash; `assetByAddress(chainId, address)` resolves an address back to a registry asset or throws.
- `contract(chain, kind)` returns a pinned contract by kind: Circle CCTP and Gateway contracts, Arc's Memo, Multicall3 and Permit2, the ERC-8004 and ERC-8183 registries, the Safe v1.4.1 singleton, proxy factory and fallback handler, ERC-4337 entry points, Circle App Kit and Earn contracts, USYC contracts, and Synq's own `SYNQ_ARC_VAULT_FACTORY`, `SYNQ_ARC_VAULT_SETUP`, `SYNQ_ARC_FALLBACK_HANDLER`, `SYNQ_MILESTONE_ESCROW`, `SYNQ_ARC_VAULT_SAFE` and `SYNQ_ARC_VAULT_POLICY`. Each entry says whether the address is a proxy; for a proxy the pin covers the proxy bytecode, not an upgradeable implementation. The Synq addresses are listed in [Smart contracts](/docs/contracts).
- `assetFromModel(input)` is the gate for anything a model suggests: it only accepts a symbol that exists in the registry, never a free-form address.

## Code hash verification

Every executor path calls `verifyCode` before trusting an address: the deployed bytecode hash at the address must equal the registry pin. A missing pin is `UNPINNED_CODE`, no code is `NO_CODE`, and a different hash is `CODE_HASH_MISMATCH`. The Arc indexer does the same check before trusting any log from an emitter and halts the stream on a mismatch.

## Arc USDC: one balance, two interfaces

On Arc the native gas token is USDC with 18 decimals, and the same balance is exposed as a 6-decimal ERC-20. `arcNativeToUsdc` converts wei to ERC-20 units and reports the sub-micro-USDC remainder as `dustWei` rather than hiding it; `usdcToArcNativeWei` goes the other way and only accepts Arc USDC. Value always moves through the 6-decimal interface.

## No raw chain-id comparisons

Code outside the registry and `packages/schemas` must not compare against raw chain ids. `scripts/architecture.mjs` parses every TypeScript file and fails with `raw chain-id comparison ...; use @synq/chain-registry profile helpers` when it finds an equality comparison against a distinctive chain id literal (the local `31337` and the archived Monad `10143`). Use the helpers instead: `chainProfile`, `chainById`, `isLocalChain`, `isMutationEnabledChain`, `profileForChainId`.

## Updating the registry

1. Verify the address and fetch the deployed bytecode hash from a live RPC.
2. Edit `sources/arc_registry.json`. Never hard-code an address in a package.
3. Run `corepack pnpm registry:probe` (alias of the testnet probe) to compare pins with the chain.
4. Run the typecheck and `corepack pnpm exec vitest run tests/arc` so the schema validation and the pinned expectations still hold.
