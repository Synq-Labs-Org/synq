// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase} from "./ArcVaultBase.sol";
import {SynqArcVaultPolicy} from "../../../src/arc/SynqArcVaultPolicy.sol";
import {SynqArcVaultFactory} from "../../../src/arc/SynqArcVaultFactory.sol";

/// @notice P07-02: the operator cannot add an owner or disable the threshold; it can only pay within scope.
contract P07_02_OperatorScopeTest is ArcVaultBase {
    function test_P07_02_operatorCannotCallSafeOwnerManagement() public {
        vm.startPrank(operator);
        vm.expectRevert(bytes("GS031"));
        safe.addOwnerWithThreshold(operator, 1);
        vm.expectRevert(bytes("GS031"));
        safe.changeThreshold(1);
        vm.expectRevert(bytes("GS031"));
        safe.removeOwner(vm.addr(KEY1), vm.addr(KEY2), 1);
        vm.expectRevert(bytes("GS031"));
        safe.enableModule(operator);
        vm.expectRevert(bytes("GS031"));
        safe.setGuard(address(0));
        vm.expectRevert(bytes("GS104"));
        safe.execTransactionFromModule(address(safe), 0, abi.encodeCall(safe.changeThreshold, (1)), CALL);
        vm.stopPrank();
        assertEq(safe.getThreshold(), THRESHOLD);
        assertEq(safe.getOwners().length, 3);
        assertFalse(safe.isOwner(operator));
    }

    function test_P07_02_operatorCannotChangePolicyGovernance() public {
        vm.startPrank(operator);
        vm.expectRevert(SynqArcVaultPolicy.NotSafe.selector);
        policy.queue(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (operator, 1)), CALL);
        vm.expectRevert(SynqArcVaultPolicy.NotSafe.selector);
        policy.setOperator(stranger);
        vm.expectRevert(SynqArcVaultPolicy.NotSafe.selector);
        policy.addRecipient(stranger);
        vm.expectRevert(SynqArcVaultPolicy.NotSafe.selector);
        policy.setCaps(type(uint256).max, type(uint256).max);
        vm.expectRevert(SynqArcVaultPolicy.NotSafe.selector);
        policy.setGuardian(operator);
        vm.expectRevert(SynqArcVaultPolicy.NotSafe.selector);
        policy.checkTransaction(address(safe), 0, "", CALL, 0, 0, 0, address(0), payable(address(0)), "", operator);
        vm.expectRevert(SynqArcVaultPolicy.NotGuardian.selector);
        policy.pause();
        vm.stopPrank();
    }

    function test_P07_02_operatorPlusOneOwnerCannotAddOwner() public {
        bytes memory data = abi.encodeCall(safe.addOwnerWithThreshold, (operator, 1));
        execExpectRevert(address(safe), 0, data, CALL, keys(KEY1, OPERATOR_KEY), bytes("GS026"));
    }

    function test_P07_02_quorumCannotAddOwnerOrDisableThresholdWithoutTimelock() public {
        bytes memory addOwner = abi.encodeCall(safe.addOwnerWithThreshold, (operator, 1));
        bytes32 id = policy.operationId(address(safe), 0, addOwner, CALL);
        execExpectRevert(
            address(safe),
            0,
            addOwner,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.NotQueued.selector, id)
        );
        bytes memory lower = abi.encodeCall(safe.changeThreshold, (1));
        id = policy.operationId(address(safe), 0, lower, CALL);
        execExpectRevert(
            address(safe),
            0,
            lower,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.NotQueued.selector, id)
        );
        assertEq(safe.getThreshold(), THRESHOLD);
    }

    function test_P07_02_operatorPaysOnlyAllowlistedWithinCaps() public {
        vm.prank(operator);
        policy.pay(vendor, 100e6, keccak256("inv-1"));
        assertEq(token.balanceOf(vendor), 100e6);

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.RecipientNotAllowed.selector, stranger));
        policy.pay(stranger, 1e6, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.RecipientNotAllowed.selector, operator));
        policy.pay(operator, 1e6, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.CapExceeded.selector, 100e6 + 1, PER_PAYMENT));
        policy.pay(vendor, 100e6 + 1, bytes32(0));
        policy.pay(vendor, 100e6, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.CapExceeded.selector, 250e6 + 1, WINDOW_CAP));
        policy.pay(vendor, 50e6 + 1, bytes32(0));
        policy.pay(vendor, 50e6, bytes32(0));
        vm.stopPrank();
        assertEq(token.balanceOf(vendor), 250e6);

        vm.warp(block.timestamp + 1 days);
        vm.prank(operator);
        policy.pay(vendor, 100e6, bytes32(0));
        assertEq(token.balanceOf(vendor), 350e6);
    }

    function test_P07_02_onlyOperatorCanPay() public {
        vm.prank(vm.addr(KEY1));
        vm.expectRevert(SynqArcVaultPolicy.NotOperator.selector);
        policy.pay(vendor, 1e6, bytes32(0));
        vm.prank(guardian);
        vm.expectRevert(SynqArcVaultPolicy.NotOperator.selector);
        policy.pay(vendor, 1e6, bytes32(0));
    }

    function test_P07_02_scopeExpansionIsTimelockedButRevocationIsInstant() public {
        bytes memory add = abi.encodeCall(SynqArcVaultPolicy.addRecipient, (stranger));
        execExpectRevert(
            address(policy),
            0,
            add,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(
                SynqArcVaultPolicy.NotQueued.selector, policy.operationId(address(policy), 0, add, CALL)
            )
        );
        timelocked(address(policy), 0, add, CALL);
        assertTrue(policy.isRecipient(stranger));

        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.revokeOperator, ()));
        assertEq(policy.operator(), address(0));
        vm.prank(operator);
        vm.expectRevert(SynqArcVaultPolicy.NotOperator.selector);
        policy.pay(vendor, 1e6, bytes32(0));
    }

    function test_P07_02_ownerCannotBecomeOperator() public {
        bytes memory data = abi.encodeCall(SynqArcVaultPolicy.setOperator, (vm.addr(KEY1)));
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(policy), 0, data, CALL)));
        vm.warp(block.timestamp + DELAY);
        execExpectRevert(address(policy), 0, data, CALL, keys(KEY1, KEY2), bytes("GS013"));
        assertEq(policy.operator(), operator);
    }

    function test_P07_02_factoryRejectsOperatorAsOwner() public {
        address[] memory list = owners();
        address[] memory recipients = new address[](0);
        SynqArcVaultFactory.VaultParams memory params = SynqArcVaultFactory.VaultParams({
            owners: list,
            threshold: 2,
            guardian: guardian,
            operator: list[0],
            delay: DELAY,
            recipients: recipients,
            perPaymentCap: 0,
            windowCap: 0
        });
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultFactory.InvalidRole.selector, list[0]));
        factory.createVault(params, bytes32("x"));
    }

    function testFuzz_P07_02_operatorNeverExceedsCaps(uint256[6] memory amounts) public {
        uint256 paid;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 1, 2 * PER_PAYMENT);
            vm.prank(operator);
            try policy.pay(vendor, amount, bytes32(i)) {
                assertLe(amount, PER_PAYMENT);
                paid += amount;
            } catch {}
        }
        assertLe(paid, WINDOW_CAP);
        assertEq(token.balanceOf(vendor), paid);
        assertEq(token.balanceOf(address(safe)), FUNDING - paid);
    }
}
