// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HookToken} from "../unit/arc/ArcVaultBase.sol";
import {SynqMilestoneEscrow} from "../../src/arc/SynqMilestoneEscrow.sol";

/// @notice Drives several escrow deals with random actors and calls; ghost accounting tracks every milestone.
contract EscrowHandler is Test {
    SynqMilestoneEscrow public immutable escrow;
    HookToken public immutable token;
    address[4] internal actors;
    uint256[] public deals;
    mapping(uint256 => mapping(uint256 => uint256)) public paidOut;
    mapping(uint256 => mapping(uint256 => uint256)) public refunded;
    uint256 public funded;
    uint256 public totalPaid;
    uint256 public totalRefunded;

    constructor(SynqMilestoneEscrow e, HookToken t, address[4] memory a) {
        escrow = e;
        token = t;
        actors = a;
    }

    function open(uint64 a, uint64 b) external {
        uint128 x = uint128(bound(a, 1, 1e9));
        uint128 y = uint128(bound(b, 1, 1e9));
        address payer = actors[0];
        token.mint(payer, uint256(x) + y);
        uint128[] memory amounts = new uint128[](2);
        amounts[0] = x;
        amounts[1] = y;
        vm.startPrank(payer);
        token.approve(address(escrow), uint256(x) + y);
        deals.push(
            escrow.open(actors[1], actors[2], uint64(block.timestamp + 10 days), keccak256(abi.encode(x, y)), amounts)
        );
        vm.stopPrank();
        funded += uint256(x) + y;
    }

    function _pick(uint256 seed) internal view returns (uint256 dealId, uint256 index, address who) {
        dealId = deals[seed % deals.length];
        index = (seed >> 8) % 2;
        who = actors[(seed >> 16) % 4];
    }

    function release(uint256 seed) external {
        if (deals.length == 0) return;
        (uint256 d, uint256 i, address who) = _pick(seed);
        vm.prank(who);
        try escrow.release(d, i) {} catch {}
    }

    function withdraw(uint256 seed) external {
        if (deals.length == 0) return;
        (uint256 d, uint256 i, address who) = _pick(seed);
        uint256 before = token.balanceOf(actors[1]);
        vm.prank(who);
        try escrow.withdraw(d, i) {
            uint256 got = token.balanceOf(actors[1]) - before;
            paidOut[d][i] += got;
            totalPaid += got;
        } catch {}
    }

    function refund(uint256 seed) external {
        if (deals.length == 0) return;
        (uint256 d, uint256 i, address who) = _pick(seed);
        uint256 before = token.balanceOf(actors[0]);
        vm.prank(who);
        try escrow.refund(d, i) {
            uint256 got = token.balanceOf(actors[0]) - before;
            refunded[d][i] += got;
            totalRefunded += got;
        } catch {}
    }

    function dispute(uint256 seed) external {
        if (deals.length == 0) return;
        (uint256 d,, address who) = _pick(seed);
        vm.prank(who);
        try escrow.dispute(d) {} catch {}
    }

    function warp(uint32 by) external {
        vm.warp(block.timestamp + bound(by, 1, 15 days));
    }

    function dealCount() external view returns (uint256) {
        return deals.length;
    }
}

/// @notice No double release or refund, and conservation: escrow balance == liability == funded - paid - refunded.
contract EscrowInvariantsTest is Test {
    SynqMilestoneEscrow internal escrow;
    HookToken internal token;
    EscrowHandler internal handler;
    address[4] internal actors = [makeAddr("payer"), makeAddr("payee"), makeAddr("arbiter"), makeAddr("stranger")];

    function setUp() public {
        vm.warp(1_790_000_000);
        token = new HookToken();
        escrow = new SynqMilestoneEscrow(address(token));
        handler = new EscrowHandler(escrow, token, actors);
        handler.open(10_000, 20_000);
        targetContract(address(handler));
    }

    function invariant_conservation() public view {
        assertEq(token.balanceOf(address(escrow)), escrow.totalLiability());
        assertEq(handler.funded(), token.balanceOf(address(escrow)) + handler.totalPaid() + handler.totalRefunded());
        assertEq(token.balanceOf(actors[2]), 0);
        assertEq(token.balanceOf(actors[3]), 0);
    }

    function invariant_eachMilestoneLeavesAtMostOnce() public view {
        for (uint256 k; k < handler.dealCount(); ++k) {
            uint256 d = handler.deals(k);
            for (uint256 i; i < 2; ++i) {
                uint256 amount = escrow.milestone(d, i).amount;
                uint256 paid = handler.paidOut(d, i);
                uint256 back = handler.refunded(d, i);
                assertTrue(paid == 0 || back == 0);
                assertLe(paid + back, amount);
                SynqMilestoneEscrow.Status s = escrow.milestone(d, i).status;
                if (s == SynqMilestoneEscrow.Status.Withdrawn) assertEq(paid, amount);
                if (s == SynqMilestoneEscrow.Status.Refunded) assertEq(back, amount);
                if (s == SynqMilestoneEscrow.Status.Funded || s == SynqMilestoneEscrow.Status.Released) {
                    assertEq(paid + back, 0);
                }
            }
        }
    }
}
