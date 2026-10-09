# Synq contracts on Safe v1.4.1

Synq group accounts are Safe v1.4.1 proxies (SafeL2 singleton, CompatibilityFallbackHandler). On top of them sits a small, non-upgradeable Synq module layer, as described in ADR-0009:

- `SynqGroupFactory`: creates a group Safe through the canonical SafeProxyFactory, enables `ExecutionModule` during `Safe.setup` via `SynqSafeModuleSetup`. The helper works only while the factory is creating that exact proxy, so a copied initializer cannot squat the address. The factory then binds the group in `MandateRegistry` and emits `GroupCreated`. Its constructor deploys the registry, module and setup helper. The Safe infrastructure addresses are constructor parameters.
- `MandateRegistry`: per-group mandate governance. Only the group's Safe can call it (owner quorum). It handles versions, supersession with optional invalidation, terminal revocation, the (target, selector) and recipient allowlists, per-action and cumulative caps, and the cumulative spend ledger. The ledger is keyed by (account, mandateId) and written only by the group's authorized module.
- `ExecutionModule`: verifies EIP-712 `ExecutionGrant`s with the Safe's own `checkSignatures` and rejects high-s ECDSA. It enforces the executor, nonce, intent, window, chain and group bindings and executes only CALLs through `execTransactionFromModule`. It then verifies exact balance deltas. Each Safe can pause or unpause it, and it has a reentrancy guard.

A non-sensitive mandate supersession may only widen the mandate; any narrowing must be security-sensitive. The module refuses to execute while it is a Safe owner. Safe `approvedHashes` are permanent: to revoke a specific outstanding grant, use `cancelNonce`, pause, a security-sensitive supersession, `revokeMandate` or executor removal.

Owner recovery, owner rotation, threshold changes and module enable/disable are Safe-native operations (`execTransaction` with quorum). They work while the module is paused. Integration details, the EIP-712 type string, events and errors are in [abi/INTEGRATION.md](abi/INTEGRATION.md).

## Vendored dependencies

| Dependency | Upstream | Tag | Commit | Vendored paths |
|---|---|---|---|---|
| Safe smart account | github.com/safe-global/safe-smart-account (now safe-fndn) | v1.4.1 | `bf943f80fec5ac647159d26161446ac5d716a294` | `lib/safe-smart-account/{contracts,LICENSE,README.md}` |
| forge-std | github.com/foundry-rs/forge-std | v1.9.7 | `77041d2ce690e692d6e03cc812b57d1ddaa4d505` | `lib/forge-std/{src,LICENSE-*,README.md}` |

- The sources were extracted from the GitHub tarballs of those exact commits on 2026-10-09:
  - Safe tarball sha256: `3e8970c21af00edee1f0f9667251cd6468b6072ab360d16bbbb106d1011281ee`
  - forge-std tarball sha256: `a387f7c2a10387f889b0d18b999cfa667a5273ac11cc11e18923022eb8b24bc3`
- The tag-to-commit mapping was verified with the GitHub refs API.
- No vendored file is modified.

## Build and test

The compiler is pinned to solc 0.8.28 with Cancun, optimizer 200 and via-IR for Synq sources. Safe v1.4.1 hits stack-too-deep under via-IR, so `lib/safe-smart-account/**` compiles with the legacy pipeline through a per-path compiler profile. Synq sources never import Safe sources: they use `src/interfaces/ISafe.sol`. Tests deploy Safe from artifacts with `deployCode("out/<Name>.sol/<Name>.json")`, so the tests exercise the same via-IR Synq bytecode that gets deployed.

```sh
forge fmt --check --root contracts
forge build --root contracts --offline
forge test --root contracts --offline                   # unit + fuzz + invariant (fork suite excluded)
FOUNDRY_PROFILE=fork forge test --root contracts --fork-url https://testnet-rpc.monad.xyz   # fork suite
python3 contracts/export-abi.py                          # refresh abi/*.json after a build
```

`--offline` avoids a Foundry/macOS proxy initialization panic seen in this environment (evidence/runtime-finding.md).

## Test layout

Every test ID in tests/TEST_MATRIX.csv (CON-001 to CON-022) appears in a test name.

- `test/unit/`: factory, registry, module, Safe-native signature paths (ECDSA, eth_sign, approved hash, nested-Safe ERC-1271 owner, malformed and malleable signatures), and Safe governance (recovery and rotation while paused; the module and executor cannot change owners, threshold or modules).
- `test/unit/CriticRegressions.t.sol`: the critic's attacks A1 (proxy squat), A2 (module as owner) and A3 (narrowing non-sensitive supersession), ported with assertions that they now fail, plus each narrowing dimension and the harmless different-Safe case.
- `test/fuzz/GrantBinding.t.sol`: every one of the 19 signed grant fields is mutated after signing, and each mutation must revert with `InvalidSignatures` specifically. It also covers model-checked arbitrary calldata, unsigned calldata and random signature bytes.
- `test/invariant/`: §42 invariants 1–10 plus a model-agreement invariant, driven by an active handler (`SynqHandler`). The handler mixes valid spends with over-cap, stale-version, expired, replay, forged-signature, wrong-executor, non-allowlisted-recipient, disallowed-call and governance attacks. It also covers pause, revoke, supersede, warp and owner recovery. Mutation check: removing the cumulative-cap check makes `invariant_inv5_spendWithinCumulativeCap` fail (evidence/mutation-check.md).
- `test/fork/MonadFork.t.sol`: runs against Monad testnet (chain 10143) using the real Safe v1.4.1 bytecode at the registry addresses. Codehashes are asserted against safe-deployments `codeHash`. The test funds the group Safe from the Agora faucet `requestFunds(address)` with official test AUSD (6 decimals), then executes a 2-of-3-approved AUSD transfer. It also covers caps, pause and owner recovery.

## Deployment

`script/Deploy.s.sol` deploys `SynqGroupFactory`, which in turn deploys the registry, module and setup helper. It refuses to run unless SafeL2 reports `VERSION() == "1.4.1"`. On non-local chains it also requires the singleton, proxy factory and fallback handler codehashes to equal the safe-deployments v1.4.1 canonical `codeHash`. Use the `script/deploy.sh` wrapper:

```sh
SYNQ_TESTNET_KEY_FILE=/secure/path/test-only.key \
SYNQ_SAFE_L2_SINGLETON=0x29fcB43b46531BcA003ddC8FCB67FFE91900C762 \
SYNQ_SAFE_PROXY_FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67 \
SYNQ_SAFE_FALLBACK_HANDLER=0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99 \
contracts/script/deploy.sh                 # simulation
contracts/script/deploy.sh --broadcast     # submit; writes deployments/<chainId>.json
```

- The wrapper reads the key from the file into `SYNQ_DEPLOYER_PRIVATE_KEY` inside its own process only. The key is never printed or passed as an argument.
- Broadcast receipts with tx hashes are written to `broadcast/` (gitignored), so capture them into the deployment report.
- Monad charges by gas limit. The simulated deployment uses about 6.41M gas (evidence/deploy-dryrun-monad-testnet.txt).

## Evidence

The `evidence/` directory holds raw logs:

- formatting, build and versions;
- the offline suite;
- the fork suite;
- the mutation check;
- the deployment dry-run;
- the source review.

`src/test/LocalTestToken.sol` is a permissionless local fixture with no relationship to AUSD.

## Known limitations

- The module executes only exact ERC20 `transfer` and plain native transfers. Swaps and other adapters need a future policy module.
- Recurring capabilities are not modelled; every grant is single-use.
- The registry only binds Safes created by its factory.
- No guard is installed (ADR-0009 defers `SynqModuleGuard`).
- The vendored Safe is compiled with solc 0.8.28 (legacy pipeline) for local tests. Canonical bytecode was built with 0.7.6, so the fork suite is the evidence for the deployed bytecode.
