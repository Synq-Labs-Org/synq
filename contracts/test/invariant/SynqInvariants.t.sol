// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SynqTestBase} from "../utils/SynqTestBase.sol";
import {SynqHandler} from "./SynqHandler.sol";
import {console} from "forge-std/console.sol";

/// @notice Bible section 42 invariants 1-10 under an active handler that mixes valid spends with violation attempts.
contract SynqInvariantsTest is SynqTestBase {
    SynqHandler internal handler;
    address internal vault = makeAddr("recoveryVault");
    uint256 internal tokenSupply;
    uint256 internal nativeSupply;

    function setUp() public override {
        super.setUp();
        handler = new SynqHandler(
            SynqHandler.Context({
                safe: safe,
                module: module,
                registry: registry,
                token: token,
                factory: address(factory),
                executor: executor,
                recipient: recipient,
                vault: vault,
                groupId: groupId,
                mandateId: MANDATE,
                key1: KEY1,
                key2: KEY2,
                key3: KEY3,
                maxToken: MAX_TOKEN,
                maxNative: MAX_NATIVE,
                cumToken: CUM_TOKEN,
                cumNative: CUM_NATIVE,
                validAfter: T0,
                validUntil: T0 + 30 days
            })
        );
        safeCall(address(module), abi.encodeWithSignature("setExecutor(address,bool)", address(handler), false));
        tokenSupply = token.balanceOf(address(safe));
        nativeSupply = address(safe).balance;
        targetContract(address(handler));
    }

    /// Invariant 1: an unauthorized principal (wrong executor, forged signatures) never executes.
    function invariant_inv1_unauthorizedPrincipalCannotExecute() public view {
        assertFalse(handler.violationUnauthorized());
    }

    /// Invariant 2: expired grants, expired mandates and revoked mandates never execute.
    function invariant_inv2_expiredOrRevokedCannotExecute() public view {
        assertFalse(handler.violationExpired());
        assertFalse(handler.violationRevoked());
    }

    /// Invariant 3: an executed grant can never be replayed.
    function invariant_inv3_grantCannotBeReplayed() public view {
        assertFalse(handler.violationReplay());
    }

    /// Invariant 4 (CON-004/CON-014): owners, threshold and modules are unchanged by the agent/module path.
    function invariant_inv4_CON004_CON014_ownersThresholdModulesUnchanged() public view {
        assertFalse(handler.violationGovernance());
        assertEq(safe.getThreshold(), THRESHOLD);
        address[] memory current = safe.getOwners();
        assertEq(current.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertTrue(safe.isOwner(owners()[i]));
        }
        (address[] memory modules,) = safe.getModulesPaginated(address(1), 10);
        assertEq(modules.length, 1);
        assertEq(modules[0], address(module));
        assertEq(registry.moduleOf(address(safe)), address(module));
    }

    /// Invariant 5: spend never exceeds the mandate cumulative cap; registry ledger equals observed spend.
    function invariant_inv5_spendWithinCumulativeCap() public view {
        assertFalse(handler.violationOverCap());
        assertEq(spentToken(), handler.ghostTokenSpent());
        assertEq(spentNative(), handler.ghostNativeSpent());
        assertLe(spentToken(), 2 * CUM_TOKEN * handler.currentVersion());
    }

    /// Invariant 6: targets/selectors outside the allowlist never execute.
    function invariant_inv6_disallowedTargetSelectorCannotExecute() public view {
        assertFalse(handler.violationDisallowedCall());
    }

    /// Invariant 7: arbitrary calls cannot bypass policy; the only token movements are recorded spends and recovery.
    function invariant_inv7_noArbitraryCallBypass() public view {
        assertFalse(handler.violationDisallowedCall());
        assertFalse(handler.violationRecipient());
        assertEq(token.balanceOf(recipient), handler.ghostTokenSpent());
        assertEq(
            token.balanceOf(address(safe)), tokenSupply - handler.ghostTokenSpent() - handler.ghostTokenRecovered()
        );
    }

    /// Invariant 8: pause blocks delegated execution while owner recovery keeps working.
    function invariant_inv8_pauseBlocksDelegationNotRecovery() public view {
        assertFalse(handler.violationPaused());
        assertFalse(handler.violationRecoveryBlocked());
        assertEq(module.paused(address(safe)), handler.paused());
    }

    /// Invariant 9: grants for versions invalidated by security-sensitive supersession never execute.
    function invariant_inv9_staleVersionCannotExecute() public view {
        assertFalse(handler.violationStaleVersion());
    }

    /// Invariant 10: no funds become stranded in Synq contracts; all value is in the Safe, recipient or vault.
    function invariant_inv10_noStrandedFunds() public view {
        address[4] memory sinks = [address(module), address(registry), address(factory), address(token)];
        for (uint256 i; i < sinks.length; ++i) {
            assertEq(token.balanceOf(sinks[i]), 0);
            assertEq(sinks[i].balance, 0);
        }
        assertEq(token.balanceOf(address(safe)) + token.balanceOf(recipient) + token.balanceOf(vault), tokenSupply);
        assertEq(address(safe).balance + recipient.balance + vault.balance, nativeSupply);
    }

    /// Model agreement: every action the model deems valid is accepted (no over-restriction hiding behind reverts).
    function invariant_modelAgreement() public view {
        assertFalse(handler.unexpectedRejection());
    }

    function afterInvariant() external view {
        console.log(
            "run summary: tokenSpends=%s/%s nativeSpends=%s",
            handler.successes("spendToken"),
            handler.calls("spendToken"),
            handler.successes("spendNative")
        );
        console.log(
            "  version=%s paused=%s revoked=%s", handler.currentVersion(), handler.paused(), handler.revoked()
        );
        console.log(
            "  attempts: replay=%s unauthorized=%s disallowed=%s",
            handler.calls("replay"),
            handler.calls("unauthorizedExecutor") + handler.calls("forgedSignatures"),
            handler.calls("disallowedCall") + handler.calls("nonAllowlistedRecipient")
        );
    }
}
