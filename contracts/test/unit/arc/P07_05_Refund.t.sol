// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase} from "./ArcVaultBase.sol";
import {SynqMilestoneEscrow} from "../../../src/arc/SynqMilestoneEscrow.sol";

/// @notice P07-05: a refund cannot be double claimed or redirected.
contract P07_05_RefundTest is ArcVaultBase {
    SynqMilestoneEscrow internal escrow;
    address internal payer = makeAddr("payer");
    address internal payee = makeAddr("payee");
    address internal arbiter = makeAddr("arbiter");
    uint64 internal refundAfter;
    uint256 internal dealId;

    function setUp() public override {
        super.setUp();
        escrow = newEscrow();
        token.mint(payer, 1_000e6);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        uint128[] memory amounts = new uint128[](3);
        amounts[0] = 200e6;
        amounts[1] = 300e6;
        amounts[2] = 500e6;
        refundAfter = uint64(block.timestamp + 7 days);
        vm.prank(payer);
        dealId = escrow.open(payee, arbiter, refundAfter, keccak256("terms-v1"), amounts);
    }

    function test_P07_05_timeoutRefundGoesToPayerOnce() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.RefundNotYetAllowed.selector, refundAfter));
        escrow.refund(dealId, 0);

        vm.warp(refundAfter);
        vm.prank(stranger);
        escrow.refund(dealId, 0);
        assertEq(token.balanceOf(payer), 200e6);
        assertEq(token.balanceOf(stranger), 0);

        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Refunded)
        );
        vm.prank(payer);
        escrow.refund(dealId, 0);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Refunded)
        );
        vm.prank(arbiter);
        escrow.refund(dealId, 0);
        assertEq(token.balanceOf(payer), 200e6);
        assertEq(escrow.totalLiability(), 800e6);
    }

    function test_P07_05_refundedMilestoneCannotBeReleasedOrWithdrawn() public {
        vm.prank(arbiter);
        escrow.refund(dealId, 1);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Refunded)
        );
        escrow.release(dealId, 1);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Refunded)
        );
        escrow.withdraw(dealId, 1);
        assertEq(token.balanceOf(payee), 0);
        assertEq(token.balanceOf(payer), 300e6);
    }

    function test_P07_05_releasedMilestoneCannotBeRefunded() public {
        vm.prank(payer);
        escrow.release(dealId, 2);
        vm.warp(refundAfter);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Released)
        );
        escrow.refund(dealId, 2);
        escrow.withdraw(dealId, 2);
        assertEq(token.balanceOf(payee), 500e6);
    }

    function test_P07_05_payeeOrArbiterRefundStillGoesToPayer() public {
        vm.prank(payee);
        escrow.refund(dealId, 0);
        vm.prank(arbiter);
        escrow.refund(dealId, 1);
        assertEq(token.balanceOf(payer), 500e6);
        assertEq(token.balanceOf(payee), 0);
        assertEq(token.balanceOf(arbiter), 0);
    }

    function test_P07_05_disputeBlocksTimeoutRefundButNotArbiter() public {
        vm.prank(payee);
        escrow.dispute(dealId);
        vm.warp(refundAfter + 1);
        vm.prank(payer);
        vm.expectRevert(SynqMilestoneEscrow.DealDisputed.selector);
        escrow.refund(dealId, 0);
        vm.prank(arbiter);
        escrow.refund(dealId, 0);
        assertEq(token.balanceOf(payer), 200e6);
    }

    function test_P07_05_onlyPartiesCanDispute() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.NotAuthorized.selector, stranger));
        escrow.dispute(dealId);
    }

    function testFuzz_P07_05_refundAlwaysToOriginalPayerExactlyOnce(address caller, uint8 index, uint32 extra) public {
        vm.assume(caller != payer && caller != payee && caller != arbiter && caller != address(escrow));
        uint256 i = bound(index, 0, 2);
        uint256 amount = escrow.milestone(dealId, i).amount;
        vm.warp(uint256(refundAfter) + extra);
        uint256 callerBefore = token.balanceOf(caller);
        vm.prank(caller);
        escrow.refund(dealId, i);
        assertEq(token.balanceOf(payer), amount);
        assertEq(token.balanceOf(caller), callerBefore);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Refunded)
        );
        escrow.refund(dealId, i);
        assertEq(token.balanceOf(address(escrow)), escrow.totalLiability());
    }
}
