---
title: Smart contracts
description: The Solidity contracts behind Synq vaults, escrow, mandates and risk attestations.
---

Synq's contracts live in `contracts/src` (Solidity 0.8.28, built and tested with Foundry through `corepack pnpm test:contracts`). Money only moves through them, or through a wallet the user controls. The server, the agents and the Kernel can propose and authorize, but the chain enforces.

> **Testnet**
> Everything runs on Arc testnet (chain id 5042002). Mainnet broadcasts are locked off (`SYNQ_ALLOW_MAINNET_BROADCAST=false`). The addresses below are testnet addresses.

## Two generations

| Generation                            | Contracts                                                                                                                                                                                                                                                 | Used for                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Arc vault stack (`contracts/src/arc`) | [SynqArcVaultFactory](/docs/contracts/vault-factory), [SynqArcVaultPolicy](/docs/contracts/vault-policy), [SynqArcFallbackHandler](/docs/contracts/fallback-handler), [SynqMilestoneEscrow](/docs/contracts/milestone-escrow)                             | Current business and group vaults, scoped operator payments, client escrow |
| Mandate stack (`contracts/src/*.sol`) | [SynqGroupFactory and SynqSafeModuleSetup](/docs/contracts/group-factory), [MandateRegistry](/docs/contracts/mandate-registry), [ExecutionModule](/docs/contracts/execution-module), [RiskAttestationRegistry](/docs/contracts/risk-attestation-registry) | Quorum-signed execution grants within mandate envelopes, and the risk gate |

## The Safe vault

A Synq vault is a Safe v1.4.1 account (the canonical SafeL2 singleton and proxy factory). Its owners keep custody: transfers need an M-of-N EIP-712 owner signature, as for any Safe. The factory adds a policy contract that acts as the Safe's transaction guard and as an enabled module, and a stricter fallback handler.

```text
                 owner quorum (M-of-N signatures)
                          |
                          v
   +-----------------------------------------------+
   |  Safe proxy (SafeL2 v1.4.1)                    |
   |   guard           = SynqArcVaultPolicy         |
   |   module          = SynqArcVaultPolicy         |
   |   fallback handler= SynqArcFallbackHandler     |
   +-----------------------------------------------+
        ^                    ^                  ^
        |                    |                  |
   checkTransaction     pay(recipient,       isValidSignature
   (timelock, pause,    amount, ref)         (only Safe-approved
    atomic txs)         scoped operator       messages, never
                        within caps           while paused)
```

What the policy adds on top of plain Safe custody:

- **Governance timelock**: owner-initiated governance (owner or threshold changes, module and guard changes, `DELEGATECALL`, operator scope expansion) must be queued, wait the vault's delay (1 hour to 30 days), then execute once inside a 14-day grace window.
- **Scoped operator**: one address may pay allowlisted recipients, in one token, under a per-payment cap and a rolling 24-hour cap. It cannot change governance.
- **Guardian pause**: a guardian can freeze outflows for at most 7 days, then must wait 2 days before pausing again. It cannot move funds.
- **Atomic transactions**: Safe gas refunds and non-zero `safeTxGas` are rejected.

The factory creates all of this in one transaction and verifies the result (module enabled, guard and fallback handler slots, threshold) before it returns, otherwise it reverts with `SetupVerificationFailed`.

## Deployed Arc testnet addresses

These come from the contract list in `sources/arc_registry.json`, which `packages/chain-registry` loads and validates (including pinned code hashes). The registry is the only place addresses live; if this table and the registry differ, the registry is right.

| Contract                   | Registry kind               | Address                                      |
| -------------------------- | --------------------------- | -------------------------------------------- |
| SynqArcVaultFactory        | `SYNQ_ARC_VAULT_FACTORY`    | `0x883f80e404b4122084F9a877790A502b3d7f621c` |
| SynqArcVaultSetup (helper) | `SYNQ_ARC_VAULT_SETUP`      | `0x85742244b0F439EE28ce5e9f412eC73AD38eD7Cf` |
| SynqArcFallbackHandler     | `SYNQ_ARC_FALLBACK_HANDLER` | `0x925B2C16FfF6a0912F02327384df25903054dB0c` |
| SynqMilestoneEscrow        | `SYNQ_MILESTONE_ESCROW`     | `0xB9894B4224CCD0EaECC7637fc40AEdD600783b7D` |
| Example vault Safe (proxy) | `SYNQ_ARC_VAULT_SAFE`       | `0x4aD226BDc7964B8B54802436C3D961942b2d58e1` |
| Example vault policy       | `SYNQ_ARC_VAULT_POLICY`     | `0xaD1C4188379001939Fb94d999556292574D1e86c` |

The mandate stack (`SynqGroupFactory`, `MandateRegistry`, `ExecutionModule`, `RiskAttestationRegistry`) has no entry in the Arc registry; it is deployed per environment by deployment records read by the execution worker and read model, not by fixed registry entries.

The Arc USDC ERC-20 interface used by the vault stack is a 6-decimal view of Arc's native USDC (18-decimal native units), with one balance and two interfaces. The registry converts between them with `arcNativeToUsdc` and `usdcToArcNativeWei`.

## Common properties

- No Synq contract has an owner, an admin key or a proxy, except `RiskAttestationRegistry`, which has a two-step owner that can only rotate the forwarder and workflow checks. Each contract exposes `UPGRADE_AUTHORITY()` where it applies, and tests check that the statement does not drift.
- Contracts use a simple reentrancy lock and update state before every token transfer.
- Tests: `corepack pnpm test:contracts` runs `forge build` and `forge test` offline in `contracts`.
