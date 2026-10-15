// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase} from "./ArcVaultBase.sol";
import {SynqMilestoneEscrow} from "../../../src/arc/SynqMilestoneEscrow.sol";

/// @notice P07-03: escrow disallows withdrawal before release conditions are met.
contract P07_03_EscrowReleaseTest is ArcVaultBase {
    SynqMilestoneEscrow internal escrow;
    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal arbiter = makeAddr("arbiter");
    uint256 internal dealId;

    function setUp() public override {
        super.setUp();
        escrow = newEscrow();
        token.mint(payer, 1_000e6);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        uint128[] memory amounts = new uint128[](2);
        amounts[0] = 300e6;
        amounts[1] = 700e6;
        vm.prank(payer);
        dealId = escrow.open(payee, arbiter, uint64(block.timestamp + 30 days), keccak256("terms-v1"), amounts);
    }

    function test_P07_03_fundedEscrowHoldsExactTotal() public view {
        assertEq(token.balanceOf(address(escrow)), 1_000e6);
        assertEq(escrow.totalLiability(), 1_000e6);
        SynqMilestoneEscrow.Deal memory d = escrow.deal(dealId);
        assertEq(d.payer, payer);
        assertEq(d.payee, payee);
        assertEq(d.milestoneCount, 2);
    }

    function test_P07_03_withdrawBeforeReleaseReverts() public {
        for (uint256 i; i < 2; ++i) {
            vm.prank(payee);
            vm.expectRevert(
                abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Funded)
            );
            escrow.withdraw(dealId, i);
        }
        assertEq(token.balanceOf(payee), 0);
    }

    function test_P07_03_payeeCannotReleaseItself() public {
        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.NotAuthorized.selector, payee));
        escrow.release(dealId, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.NotAuthorized.selector, stranger));
        escrow.release(dealId, 0);
    }

    function test_P07_03_releaseThenWithdrawPaysPayeeOnce() public {
        vm.prank(payer);
        escrow.release(dealId, 0);
        // Anyone may trigger the withdrawal, but the funds go to the deal's payee.
        vm.prank(stranger);
        escrow.withdraw(dealId, 0);
        assertEq(token.balanceOf(payee), 300e6);
        assertEq(token.balanceOf(stranger), 0);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Withdrawn)
        );
        escrow.withdraw(dealId, 0);
        // The other milestone is still locked.
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Funded)
        );
        escrow.withdraw(dealId, 1);
        assertEq(escrow.totalLiability(), 700e6);
        assertEq(token.balanceOf(address(escrow)), 700e6);
    }

    function test_P07_03_disputeFreezesPayerReleaseUntilArbiter() public {
        vm.prank(payee);
        escrow.dispute(dealId);
        vm.prank(payer);
        vm.expectRevert(SynqMilestoneEscrow.DealDisputed.selector);
        escrow.release(dealId, 1);
        vm.prank(arbiter);
        escrow.release(dealId, 1);
        escrow.withdraw(dealId, 1);
        assertEq(token.balanceOf(payee), 700e6);
    }

    function test_P07_03_unknownDealAndMilestoneRejected() public {
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.UnknownDeal.selector, 99));
        escrow.withdraw(99, 0);
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.UnknownMilestone.selector, dealId, 2));
        escrow.withdraw(dealId, 2);
    }

    function test_P07_03_invalidDealsRejected() public {
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 1e6;
        vm.startPrank(payer);
        vm.expectRevert(SynqMilestoneEscrow.InvalidDeal.selector);
        escrow.open(payer, address(0), uint64(block.timestamp + 1), bytes32(0), amounts);
        vm.expectRevert(SynqMilestoneEscrow.InvalidDeal.selector);
        escrow.open(payee, payee, uint64(block.timestamp + 1), bytes32(0), amounts);
        vm.expectRevert(SynqMilestoneEscrow.InvalidDeal.selector);
        escrow.open(payee, address(0), uint64(block.timestamp), bytes32(0), amounts);
        amounts[0] = 0;
        vm.expectRevert(SynqMilestoneEscrow.InvalidAmount.selector);
        escrow.open(payee, address(0), uint64(block.timestamp + 1), bytes32(0), amounts);
        vm.stopPrank();
    }

    function testFuzz_P07_03_noWithdrawWithoutRelease(address caller, uint8 index) public {
        vm.assume(caller != payer && caller != arbiter);
        uint256 i = bound(index, 0, 1);
        vm.prank(caller);
        vm.expectRevert();
        escrow.release(dealId, i);
        vm.prank(caller);
        vm.expectRevert();
        escrow.withdraw(dealId, i);
        assertEq(token.balanceOf(address(escrow)), 1_000e6);
    }
}
