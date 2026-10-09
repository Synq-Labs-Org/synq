# Synq local authorization sandbox

Non-production contracts for deterministic authorization and integration tests. Production collective ownership remains Safe; this account implements only the module call interface plus fixed 2-of-3 EOA ERC-1271 validation. It is not a Safe implementation, audited wallet, Safe deployment, or production migration candidate.

```sh
cd contracts
forge fmt --check
forge build --offline
forge test --offline -vv
python3 export-abi.py
```

Pinned compiler: Solidity 0.8.28, Cancun, optimizer 200, via IR. First build needs compiler download; no external Solidity dependencies. Offline testing avoids a Foundry/macOS proxy initialization panic observed in the sandbox. The runner may warn that its user-level signature cache is not writable; actual test exit status remains authoritative.

See [grant and event ABI](abi/INTEGRATION.md). The module executes only exact native transfers or ERC20 `transfer(address,uint256)` calls. Token balance checks reject fee, rebase, false-return-without-effect, and excess-debit behavior. The grant binds exact calldata, principal/plugin/intent/mandate identities and EIP712 account/group/module/chain domain. Native transfer target is mandate-approved; a contract recipient may run its receive function. No delegatecall, approvals, swaps or owner changes exist in the delegated path.

Cumulative spend persists across mandate versions; denomination is immutable within a mandate ID. Each grant nonce and economic intent hash may execute once per module. Grant validity is `validAfter <= timestamp < validUntil`; mandate expiry is also exclusive. Revocation and security supersession invalidate outstanding grants. Account owners retain a signed recovery and module-uninstall path while delegated execution is paused.

`src/test/LocalTestToken.sol` is a permissionless local fixture explicitly named `LOCAL_TEST`, with no relationship to AUSD or any official deployment. Tests use synthetic EOA keys 1/2/3 only. No testnet or mainnet address is fabricated here.

Evidence: [raw Foundry results](evidence/foundry-tests.txt), [runtime finding and repair](evidence/runtime-finding.md), [source review](evidence/source-review.md). Tests cover exact quorum, nonce/intent replay, EIP712 domains, signed-field mutation, caps, expiry boundaries, token balance semantics, pause/revocation/supersession/recovery, arbitrary calldata, reentrancy, and governance isolation. Invariants use a stateful handler for valid signed spends, pause transitions, unauthorized governance attempts and replay attempts; 128 runs × 32 depth per invariant with fail_on_revert enabled.

Local test results do not establish production Safe compatibility or live Monad deployment/fork/canary completion. Root integration captures real Anvil addresses, transaction hashes and event projection; live Monad deployment and funded test credentials are separate gate evidence.
