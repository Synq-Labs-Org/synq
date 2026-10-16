// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase} from "./arc/ArcVaultBase.sol";
import {SynqArcVaultPolicy} from "../../src/arc/SynqArcVaultPolicy.sol";

/// @notice X-KER-07 (cross-cutting): an emergency pause stops spending but never withdraws. Fuzzed over amounts,
///         recipients and timing on the real Safe v1.4.1 vault with SynqArcVaultPolicy as its guard and module.
///         Complements P07_06_GuardianPause (fixed cases) with property checks on every balance involved.
contract CrossCuttingKernelTest is ArcVaultBase {
    function _balances(address[4] memory who) internal view returns (uint256[4] memory b) {
        for (uint256 i; i < 4; ++i) {
            b[i] = token.balanceOf(who[i]);
        }
    }

    function _pause() internal {
        vm.prank(guardian);
        policy.pause();
        assertTrue(policy.paused());
    }

    /// @dev Pausing moves no funds; while paused neither the operator nor the owner quorum can move token or native
    ///      value out; after the pause expires the operator path works again within caps.
    function testFuzz_X_KER_07_pauseFreezesEveryOutflowAndMovesNothing(uint256 amount, uint256 elapsed, address to)
        public
    {
        amount = bound(amount, 1, PER_PAYMENT);
        elapsed = bound(elapsed, 0, policy.MAX_PAUSE() - 1);
        vm.assume(to != address(0) && to != address(safe) && to != address(policy) && to != address(token));
        address[4] memory who = [address(safe), vendor, guardian, to];
        uint256[4] memory before = _balances(who);
        uint256 nativeBefore = address(safe).balance;

        _pause();
        // The pause itself transfers nothing.
        uint256[4] memory afterPause = _balances(who);
        for (uint256 i; i < 4; ++i) {
            assertEq(afterPause[i], before[i], "pause moved tokens");
        }
        vm.warp(block.timestamp + elapsed);
        assertTrue(policy.paused());

        vm.prank(operator);
        vm.expectRevert(SynqArcVaultPolicy.OutflowsPaused.selector);
        policy.pay(vendor, amount, bytes32("x-ker-07"));

        execExpectRevert(
            address(token),
            0,
            transferData(to, amount),
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.OutflowsPaused.selector)
        );
        execExpectRevert(
            to, amount, "", CALL, keys(KEY1, KEY3), abi.encodeWithSelector(SynqArcVaultPolicy.OutflowsPaused.selector)
        );

        uint256[4] memory during = _balances(who);
        for (uint256 i; i < 4; ++i) {
            assertEq(during[i], before[i], "funds moved while paused");
        }
        assertEq(address(safe).balance, nativeBefore, "native moved while paused");

        // The pause ends on its own; spending resumes only within the operator caps.
        vm.warp(policy.pausedUntil());
        assertFalse(policy.paused());
        vm.prank(operator);
        policy.pay(vendor, amount, bytes32("x-ker-07"));
        assertEq(token.balanceOf(address(safe)) + token.balanceOf(vendor), before[0] + before[1], "conservation");
    }

    /// @dev The guardian has no path to any funds, paused or not: it cannot pay, call the Safe as a module, or
    ///      extend or re-arm its own pause to hold funds hostage indefinitely.
    function testFuzz_X_KER_07_guardianNeverWithdraws(uint256 amount) public {
        amount = bound(amount, 1, FUNDING);
        _pause();
        vm.startPrank(guardian);
        vm.expectRevert(SynqArcVaultPolicy.NotOperator.selector);
        policy.pay(vendor, amount, bytes32(0));
        vm.expectRevert(bytes("GS104"));
        safe.execTransactionFromModule(address(token), 0, transferData(guardian, amount), CALL);
        vm.expectRevert(bytes("GS104"));
        safe.execTransactionFromModule(guardian, amount, "", CALL);
        uint256 until = policy.pausedUntil();
        vm.expectRevert(
            abi.encodeWithSelector(SynqArcVaultPolicy.PauseCooldown.selector, until + policy.PAUSE_COOLDOWN())
        );
        policy.pause();
        vm.stopPrank();
        assertEq(policy.pausedUntil(), until, "pause extended");
        assertEq(token.balanceOf(guardian), 0);
        assertEq(guardian.balance, 0);
        assertEq(token.balanceOf(address(safe)), FUNDING);
    }
}
