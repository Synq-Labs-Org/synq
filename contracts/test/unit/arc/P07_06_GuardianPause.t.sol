// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase, SafeMigration} from "./ArcVaultBase.sol";
import {SynqArcVaultPolicy} from "../../../src/arc/SynqArcVaultPolicy.sol";

/// @notice P07-06: the emergency guardian freezes only outflows; it cannot move funds or govern.
contract P07_06_GuardianPauseTest is ArcVaultBase {
    function _pause() internal {
        vm.prank(guardian);
        policy.pause();
        assertTrue(policy.paused());
    }

    function test_P07_06_pauseFreezesQuorumTokenAndNativeOutflows() public {
        _pause();
        execExpectRevert(
            address(token),
            0,
            transferData(stranger, 1e6),
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.OutflowsPaused.selector)
        );
        execExpectRevert(
            stranger,
            1 ether,
            "",
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.OutflowsPaused.selector)
        );
        assertEq(token.balanceOf(address(safe)), FUNDING);
    }

    function test_P07_06_pauseFreezesOperatorPayments() public {
        _pause();
        vm.prank(operator);
        vm.expectRevert(SynqArcVaultPolicy.OutflowsPaused.selector);
        policy.pay(vendor, 1e6, bytes32(0));
    }

    function test_P07_06_pauseFreezesQueuedDelegatecall() public {
        SafeMigration migration = new SafeMigration();
        bytes memory data = abi.encodeCall(SafeMigration.migrate, (address(0xdead)));
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(migration), 0, data, DELEGATECALL)));
        vm.warp(block.timestamp + DELAY);
        _pause();
        execExpectRevert(
            address(migration),
            0,
            data,
            DELEGATECALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.OutflowsPaused.selector)
        );
    }

    function test_P07_06_governanceAndRecoveryStillWorkWhilePaused() public {
        _pause();
        // Owner recovery: swap a compromised owner through the timelock while paused.
        address replacement = makeAddr("replacement");
        address[] memory list = safe.getOwners();
        address prev = list[0] == vm.addr(KEY2) ? address(0x1) : list[0];
        bytes memory swap = abi.encodeCall(safe.swapOwner, (prev, vm.addr(KEY2), replacement));
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(safe), 0, swap, CALL)));
        vm.warp(block.timestamp + DELAY);
        assertTrue(policy.paused(), "still paused after the delay");
        assertTrue(exec(address(safe), 0, swap, CALL, keys(KEY1, KEY3)));
        assertTrue(safe.isOwner(replacement));
        assertFalse(safe.isOwner(vm.addr(KEY2)));
        // Scope reduction is instant while paused.
        assertTrue(
            exec(address(policy), 0, abi.encodeCall(SynqArcVaultPolicy.revokeOperator, ()), CALL, keys(KEY1, KEY3))
        );
        assertEq(policy.operator(), address(0));
        // Deposits are not outflows.
        token.mint(address(safe), 1e6);
        assertEq(token.balanceOf(address(safe)), FUNDING + 1e6);
    }

    function test_P07_06_guardianHasNoFundOrGovernanceAuthority() public {
        vm.startPrank(guardian);
        vm.expectRevert(bytes("GS031"));
        safe.addOwnerWithThreshold(guardian, 1);
        vm.expectRevert(bytes("GS031"));
        safe.changeThreshold(1);
        vm.expectRevert(SynqArcVaultPolicy.NotSafe.selector);
        policy.queue(address(safe), 0, abi.encodeCall(safe.changeThreshold, (1)), CALL);
        vm.expectRevert(SynqArcVaultPolicy.NotSafe.selector);
        policy.setGuardian(address(0));
        vm.expectRevert(SynqArcVaultPolicy.NotOperator.selector);
        policy.pay(vendor, 1e6, bytes32(0));
        vm.expectRevert(bytes("GS104"));
        safe.execTransactionFromModule(address(token), 0, transferData(guardian, 1), CALL);
        vm.stopPrank();
        assertEq(token.balanceOf(guardian), 0);
    }

    function test_P07_06_pauseIsBoundedAndOwnersCanUnpauseOrReplaceGuardian() public {
        _pause();
        assertEq(policy.pausedUntil(), block.timestamp + policy.MAX_PAUSE());
        vm.warp(block.timestamp + policy.MAX_PAUSE());
        assertFalse(policy.paused(), "pause expires on its own");

        _pause();
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.unpause, ()));
        assertFalse(policy.paused());

        _pause();
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.setGuardian, (makeAddr("newGuardian"))));
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.unpause, ()));
        vm.prank(guardian);
        vm.expectRevert(SynqArcVaultPolicy.NotGuardian.selector);
        policy.pause();
        assertTrue(exec(address(token), 0, transferData(stranger, 1e6), CALL, keys(KEY1, KEY2)));
    }

    function test_P07_06_onlyGuardianCanPause() public {
        vm.prank(operator);
        vm.expectRevert(SynqArcVaultPolicy.NotGuardian.selector);
        policy.pause();
        vm.prank(vm.addr(KEY1));
        vm.expectRevert(SynqArcVaultPolicy.NotGuardian.selector);
        policy.pause();
        vm.prank(stranger);
        vm.expectRevert(SynqArcVaultPolicy.NotGuardian.selector);
        policy.unpause();
    }
}
