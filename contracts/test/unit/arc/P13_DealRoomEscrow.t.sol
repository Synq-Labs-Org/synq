// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HookToken} from "./ArcVaultBase.sol";
import {SynqMilestoneEscrow} from "../../../src/arc/SynqMilestoneEscrow.sol";

/// @notice 6-decimal token that delivers less than asked (fee on transfer): the escrow must refuse it.
contract ShortToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - 1;
        return true;
    }
}

/// @notice Deal Room acceptance on the deployed SynqMilestoneEscrow (unchanged contract): the escrow holds exactly the
///         signed amounts in the agreed asset under the signed terms hash, releases only on payer or arbiter
///         authority and exactly once, holds funds while a dispute is active, and refunds only the funder.
contract P13_DealRoomEscrowTest is Test {
    uint256 internal constant T0 = 1_790_000_000;
    bytes32 internal constant TERMS_V1 = keccak256("Synq DealRoom DealTerms v1");
    uint128 internal constant M0 = 10_000; // 0.01 USDC
    uint128 internal constant M1 = 20_000; // 0.02 USDC

    HookToken internal token;
    SynqMilestoneEscrow internal escrow;
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal arbiter = makeAddr("arbiter");
    address internal stranger = makeAddr("stranger");
    uint64 internal refundAfter;
    uint256 internal dealId;

    function setUp() public {
        vm.warp(T0);
        token = new HookToken();
        escrow = new SynqMilestoneEscrow(address(token));
        token.mint(client, 1_000_000);
        refundAfter = uint64(T0 + 21 days);
        dealId = _open(M0, M1);
    }

    function _open(uint128 a, uint128 b) internal returns (uint256 id) {
        uint128[] memory amounts = new uint128[](2);
        amounts[0] = a;
        amounts[1] = b;
        vm.startPrank(client);
        token.approve(address(escrow), uint256(a) + b);
        id = escrow.open(freelancer, arbiter, refundAfter, TERMS_V1, amounts);
        vm.stopPrank();
    }

    function _status(uint256 i) internal view returns (SynqMilestoneEscrow.Status) {
        return escrow.milestone(dealId, i).status;
    }

    function _wrong(SynqMilestoneEscrow.Status s) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, s);
    }

    // ------------------------------------------------------------------ P13-04

    function test_P13_04_escrowHoldsExactAgreedAssetAmountAndTermsHash() public view {
        assertEq(escrow.token(), address(token));
        assertEq(token.balanceOf(address(escrow)), M0 + M1);
        assertEq(token.balanceOf(client), 1_000_000 - M0 - M1);
        assertEq(token.allowance(client, address(escrow)), 0);
        SynqMilestoneEscrow.Deal memory d = escrow.deal(dealId);
        assertEq(d.payer, client);
        assertEq(d.payee, freelancer);
        assertEq(d.arbiter, arbiter);
        assertEq(d.refundAfter, refundAfter);
        assertEq(d.termsHash, TERMS_V1);
        assertEq(d.milestoneCount, 2);
        assertEq(escrow.milestone(dealId, 0).amount, M0);
        assertEq(escrow.milestone(dealId, 1).amount, M1);
        assertEq(uint8(_status(0)), uint8(SynqMilestoneEscrow.Status.Funded));
    }

    function test_P13_04_shortDeliveryAndZeroOrSelfDealsRefused() public {
        ShortToken short = new ShortToken();
        SynqMilestoneEscrow e = new SynqMilestoneEscrow(address(short));
        short.mint(client, 1_000);
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 100;
        vm.startPrank(client);
        short.approve(address(e), 100);
        vm.expectRevert(SynqMilestoneEscrow.InvalidAmount.selector);
        e.open(freelancer, arbiter, refundAfter, TERMS_V1, amounts);
        amounts[0] = 0;
        token.approve(address(escrow), 100);
        vm.expectRevert(SynqMilestoneEscrow.InvalidAmount.selector);
        escrow.open(freelancer, arbiter, refundAfter, TERMS_V1, amounts);
        amounts[0] = 100;
        vm.expectRevert(SynqMilestoneEscrow.InvalidDeal.selector);
        escrow.open(client, arbiter, refundAfter, TERMS_V1, amounts);
        vm.expectRevert(SynqMilestoneEscrow.InvalidDeal.selector);
        escrow.open(freelancer, freelancer, refundAfter, TERMS_V1, amounts);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ P13-05

    function test_P13_05_onlyPayerOrArbiterReleasesAndExactlyOnce() public {
        vm.prank(freelancer);
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.NotAuthorized.selector, freelancer));
        escrow.release(dealId, 0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.NotAuthorized.selector, stranger));
        escrow.release(dealId, 0);
        vm.prank(client);
        escrow.release(dealId, 0);
        vm.prank(client);
        vm.expectRevert(_wrong(SynqMilestoneEscrow.Status.Released));
        escrow.release(dealId, 0);
        vm.prank(arbiter);
        vm.expectRevert(_wrong(SynqMilestoneEscrow.Status.Released));
        escrow.release(dealId, 0);
        vm.prank(stranger);
        escrow.withdraw(dealId, 0);
        assertEq(token.balanceOf(freelancer), M0);
        assertEq(token.balanceOf(stranger), 0);
        vm.expectRevert(_wrong(SynqMilestoneEscrow.Status.Withdrawn));
        escrow.withdraw(dealId, 0);
        vm.prank(client);
        vm.expectRevert(_wrong(SynqMilestoneEscrow.Status.Withdrawn));
        escrow.release(dealId, 0);
        // A released milestone can no longer be refunded.
        vm.prank(arbiter);
        vm.expectRevert(_wrong(SynqMilestoneEscrow.Status.Withdrawn));
        escrow.refund(dealId, 0);
        assertEq(escrow.totalLiability(), M1);
    }

    // ------------------------------------------------------------------ P13-06

    function test_P13_06_disputeHoldsPayerReleaseAndTimeoutRefundUntilArbiter() public {
        vm.prank(client);
        escrow.dispute(dealId);
        assertTrue(escrow.disputeActive(dealId));
        vm.prank(client);
        vm.expectRevert(SynqMilestoneEscrow.DealDisputed.selector);
        escrow.release(dealId, 1);
        vm.warp(refundAfter + 1);
        vm.prank(stranger);
        vm.expectRevert(SynqMilestoneEscrow.DealDisputed.selector);
        escrow.refund(dealId, 1);
        // The dispute cannot be stacked or renewed while active.
        vm.prank(freelancer);
        vm.expectRevert(SynqMilestoneEscrow.DealDisputed.selector);
        escrow.dispute(dealId);
        assertEq(token.balanceOf(address(escrow)), M0 + M1);
        // The arbiter is the only one who can settle while the dispute is active.
        vm.prank(arbiter);
        escrow.release(dealId, 0);
        assertEq(uint8(_status(0)), uint8(SynqMilestoneEscrow.Status.Released));
        assertEq(uint8(_status(1)), uint8(SynqMilestoneEscrow.Status.Funded));
    }

    function test_P13_06_disputesAreBounded() public {
        vm.prank(freelancer);
        escrow.dispute(dealId);
        vm.warp(block.timestamp + escrow.DISPUTE_PERIOD());
        assertFalse(escrow.disputeActive(dealId));
        vm.prank(freelancer);
        vm.expectRevert(SynqMilestoneEscrow.DisputeAlreadyUsed.selector);
        escrow.dispute(dealId);
        vm.prank(client);
        escrow.release(dealId, 1);
    }

    // ------------------------------------------------------------------ P13-07

    function test_P13_07_cancellationRefundsOnlyTheFunder() public {
        uint256 before = token.balanceOf(client);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.RefundNotYetAllowed.selector, refundAfter));
        escrow.refund(dealId, 1);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(SynqMilestoneEscrow.RefundNotYetAllowed.selector, refundAfter));
        escrow.refund(dealId, 1);
        // Arbiter-resolved dispute: refund, called by the arbiter, pays the funder.
        vm.prank(client);
        escrow.dispute(dealId);
        vm.prank(arbiter);
        escrow.refund(dealId, 1);
        assertEq(token.balanceOf(client), before + M1);
        assertEq(token.balanceOf(arbiter), 0);
        vm.prank(arbiter);
        vm.expectRevert(_wrong(SynqMilestoneEscrow.Status.Refunded));
        escrow.refund(dealId, 1);
        vm.prank(arbiter);
        vm.expectRevert(_wrong(SynqMilestoneEscrow.Status.Refunded));
        escrow.release(dealId, 1);
        // The payee giving a milestone back also pays the funder, never itself.
        vm.prank(freelancer);
        escrow.refund(dealId, 0);
        assertEq(token.balanceOf(client), before + M0 + M1);
        assertEq(token.balanceOf(freelancer), 0);
        assertEq(escrow.totalLiability(), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_P13_07_timeoutRefundByAnyoneStillPaysTheFunder() public {
        vm.warp(refundAfter);
        vm.prank(stranger);
        escrow.refund(dealId, 0);
        assertEq(token.balanceOf(stranger), 0);
        assertEq(escrow.milestone(dealId, 0).amount, M0);
        assertEq(uint8(_status(0)), uint8(SynqMilestoneEscrow.Status.Refunded));
    }

    // ------------------------------------------------------------------ fuzz

    /// @dev Any sequence of release/withdraw/refund/dispute by any actor moves each milestone out at most once, and
    ///      escrow balance + paid out always equals what was funded.
    function testFuzz_P13_noDoubleReleaseOrRefund(uint8[16] calldata ops) public {
        address[4] memory actors = [client, freelancer, arbiter, stranger];
        uint256 total = uint256(M0) + M1;
        for (uint256 k; k < ops.length; ++k) {
            uint8 op = ops[k];
            address who = actors[op % 4];
            uint256 i = (op >> 2) % 2;
            uint8 fn = (op >> 3) % 5;
            if (fn == 4) vm.warp(block.timestamp + 11 days);
            vm.prank(who);
            if (fn == 0) try escrow.release(dealId, i) {} catch {}
            else if (fn == 1) try escrow.withdraw(dealId, i) {} catch {}
            else if (fn == 2) try escrow.refund(dealId, i) {} catch {}
            else if (fn == 3) try escrow.dispute(dealId) {} catch {}
            uint256 paid = token.balanceOf(freelancer);
            uint256 back = token.balanceOf(client) - (1_000_000 - total);
            assertEq(paid + back + token.balanceOf(address(escrow)), total);
            assertEq(token.balanceOf(address(escrow)), escrow.totalLiability());
            assertLe(paid, total);
            // Each milestone leaves once: payouts and refunds are whole milestones, never both for one.
            assertTrue(paid == 0 || paid == M0 || paid == M1 || paid == total);
            assertTrue(back == 0 || back == M0 || back == M1 || back == total);
            assertLe(paid + back, total);
        }
        assertEq(token.balanceOf(stranger), 0);
        assertEq(token.balanceOf(arbiter), 0);
    }
}
