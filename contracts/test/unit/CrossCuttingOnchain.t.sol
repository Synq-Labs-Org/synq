// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase, SafeMigration} from "./arc/ArcVaultBase.sol";
import {SynqArcVaultPolicy} from "../../src/arc/SynqArcVaultPolicy.sol";
import {SynqMilestoneEscrow} from "../../src/arc/SynqMilestoneEscrow.sol";

/// @notice Cross-cutting ONCHAIN rows X-ONC-03..07 against the deployed-source vault policy (Safe v1.4.1 guard +
///         module) and milestone escrow. LOCAL_FIXTURE: Foundry EVM, no network.
contract CrossCuttingOnchainTest is ArcVaultBase {
    bytes32 internal constant REF = keccak256("x-onc");
    uint256 internal constant ARC_TESTNET = 5042002;
    uint256 internal constant ARC_MAINNET = 5042;

    function keys3() internal pure returns (uint256[] memory list) {
        list = new uint256[](3);
        list[0] = KEY1;
        list[1] = KEY2;
        list[2] = KEY3;
    }

    // ------------------------------------------------------------------ X-ONC-03

    /// @notice X-ONC-03: the scoped operator can pay only allowlisted recipients; any other address reverts and
    ///         no value leaves the vault.
    function testFuzz_X_ONC_03_operatorCannotPayUnexpectedRecipient(address recipient, uint256 amount) public {
        vm.assume(recipient != vendor && recipient != address(0));
        amount = bound(amount, 1, PER_PAYMENT);
        uint256 before = token.balanceOf(address(safe));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.RecipientNotAllowed.selector, recipient));
        policy.pay(recipient, amount, REF);
        assertEq(token.balanceOf(address(safe)), before);
    }

    function test_X_ONC_03_operatorHasNoOtherPathToFunds() public {
        // Not a Safe module: a direct module call is refused by the Safe.
        vm.prank(operator);
        vm.expectRevert(bytes("GS104"));
        safe.execTransactionFromModule(address(token), 0, transferData(stranger, 1e6), CALL);
        // Widening the allowlist is a scope expansion: owner quorum alone is not enough without the timelock.
        bytes memory add = abi.encodeCall(SynqArcVaultPolicy.addRecipient, (stranger));
        execExpectRevert(
            address(policy),
            0,
            add,
            CALL,
            keys3(),
            abi.encodeWithSelector(
                SynqArcVaultPolicy.NotQueued.selector, policy.operationId(address(policy), 0, add, CALL)
            )
        );
        // The allowlisted vendor is still payable, within caps.
        vm.prank(operator);
        policy.pay(vendor, PER_PAYMENT, REF);
        assertEq(token.balanceOf(vendor), PER_PAYMENT);
    }

    // ------------------------------------------------------------------ X-ONC-04

    function _openDeal(SynqMilestoneEscrow escrow, address payee, address arbiter)
        internal
        returns (uint256 dealId, uint256 total)
    {
        uint128[] memory amounts = new uint128[](3);
        amounts[0] = 10e6;
        amounts[1] = 20e6;
        amounts[2] = 30e6;
        total = 60e6;
        address payer = makeAddr("payer");
        token.mint(payer, total);
        vm.startPrank(payer);
        token.approve(address(escrow), total);
        dealId = escrow.open(payee, arbiter, uint64(block.timestamp + 10 days), keccak256("terms"), amounts);
        vm.stopPrank();
    }

    /// @notice X-ONC-04: a refunded milestone can never be released or withdrawn, and a released one never refunded.
    function test_X_ONC_04_releaseAfterRefundReverts() public {
        SynqMilestoneEscrow escrow = newEscrow();
        address payee = makeAddr("payee");
        address arbiter = makeAddr("arbiter");
        (uint256 dealId,) = _openDeal(escrow, payee, arbiter);
        address payer = makeAddr("payer");

        vm.warp(block.timestamp + 10 days);
        vm.prank(stranger);
        escrow.refund(dealId, 0);
        vm.prank(payer);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Refunded)
        );
        escrow.release(dealId, 0);
        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Refunded)
        );
        escrow.release(dealId, 0);
        vm.prank(payee);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Refunded)
        );
        escrow.withdraw(dealId, 0);

        vm.prank(payer);
        escrow.release(dealId, 1);
        vm.prank(arbiter);
        vm.expectRevert(
            abi.encodeWithSelector(SynqMilestoneEscrow.WrongStatus.selector, SynqMilestoneEscrow.Status.Released)
        );
        escrow.refund(dealId, 1);
        escrow.withdraw(dealId, 1);
        assertEq(token.balanceOf(payee), 20e6);
        assertEq(token.balanceOf(payer), 10e6);
        assertEq(escrow.totalLiability(), 30e6);
        assertEq(token.balanceOf(address(escrow)), 30e6);
    }

    /// @notice X-ONC-04 (property): under any order of release/refund/withdraw by any actor at any time, every
    ///         milestone leaves once and payee + payer + escrow always equals the funded total.
    function testFuzz_X_ONC_04_conservationUnderAnyOrder(uint256 seed) public {
        SynqMilestoneEscrow escrow = newEscrow();
        address payee = makeAddr("payee");
        address arbiter = makeAddr("arbiter");
        address payer = makeAddr("payer");
        (uint256 dealId, uint256 total) = _openDeal(escrow, payee, arbiter);
        address[4] memory who = [payer, payee, arbiter, stranger];
        for (uint256 step; step < 24; ++step) {
            uint256 r = uint256(keccak256(abi.encode(seed, step)));
            uint256 i = r % 3;
            vm.prank(who[(r >> 8) % 4]);
            uint256 op = (r >> 16) % 4;
            if (op == 0) {
                try escrow.release(dealId, i) {} catch {}
            } else if (op == 1) {
                try escrow.refund(dealId, i) {} catch {}
            } else if (op == 2) {
                try escrow.withdraw(dealId, i) {} catch {}
            } else {
                vm.warp(block.timestamp + ((r >> 24) % 6 days));
            }
            assertEq(token.balanceOf(payee) + token.balanceOf(payer) + token.balanceOf(address(escrow)), total);
            assertEq(escrow.totalLiability(), token.balanceOf(address(escrow)));
        }
        uint256 paid;
        uint256 refunded;
        for (uint256 i; i < 3; ++i) {
            SynqMilestoneEscrow.Milestone memory m = escrow.milestone(dealId, i);
            if (m.status == SynqMilestoneEscrow.Status.Withdrawn) paid += m.amount;
            if (m.status == SynqMilestoneEscrow.Status.Refunded) refunded += m.amount;
        }
        assertEq(token.balanceOf(payee), paid);
        assertEq(token.balanceOf(payer), refunded);
    }

    // ------------------------------------------------------------------ X-ONC-05

    /// @notice X-ONC-05: every code/authority change (singleton migration, guard/module/fallback swap, threshold
    ///         change) is refused without the timelock, even with every owner signing.
    function test_X_ONC_05_upgradeWithoutTimelockIsRefused() public {
        SafeMigration migration = new SafeMigration();
        address newSingleton = deployCode("out/SafeL2.sol/SafeL2.json");
        bytes memory migrate = abi.encodeCall(SafeMigration.migrate, (newSingleton));
        execExpectRevert(
            address(migration),
            0,
            migrate,
            DELEGATECALL,
            keys3(),
            abi.encodeWithSelector(
                SynqArcVaultPolicy.NotQueued.selector, policy.operationId(address(migration), 0, migrate, DELEGATECALL)
            )
        );
        bytes[4] memory calls = [
            abi.encodeCall(safe.setGuard, (address(0))),
            abi.encodeCall(safe.enableModule, (stranger)),
            abi.encodeCall(safe.setFallbackHandler, (stranger)),
            abi.encodeCall(safe.changeThreshold, (1))
        ];
        for (uint256 i; i < calls.length; ++i) {
            execExpectRevert(
                address(safe),
                0,
                calls[i],
                CALL,
                keys3(),
                abi.encodeWithSelector(
                    SynqArcVaultPolicy.NotQueued.selector, policy.operationId(address(safe), 0, calls[i], CALL)
                )
            );
        }
        // Queued, but before the delay: still refused.
        quorum(
            address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(migration), 0, migrate, DELEGATECALL))
        );
        bytes32 id = policy.operationId(address(migration), 0, migrate, DELEGATECALL);
        execExpectRevert(
            address(migration),
            0,
            migrate,
            DELEGATECALL,
            keys3(),
            abi.encodeWithSelector(SynqArcVaultPolicy.NotReady.selector, id, policy.eta(id))
        );
        assertEq(guardOf(safe), address(policy));
        assertTrue(safe.isModuleEnabled(address(policy)));
        assertEq(safe.getThreshold(), THRESHOLD);
        assertEq(address(uint160(uint256(vm.load(address(safe), bytes32(0))))), safeSingleton);
    }

    // ------------------------------------------------------------------ X-ONC-06

    /// @notice X-ONC-06: the delegate (scoped operator), the guardian, a single owner and any stranger cannot
    ///         change the owner set; only the owner quorum can, and only through the timelock.
    function test_X_ONC_06_delegateCannotChangeOwnerSet() public {
        address intruder = makeAddr("intruder");
        address[3] memory actors = [operator, guardian, stranger];
        for (uint256 i; i < actors.length; ++i) {
            vm.prank(actors[i]);
            vm.expectRevert(bytes("GS031"));
            safe.addOwnerWithThreshold(intruder, 1);
            vm.prank(actors[i]);
            vm.expectRevert(SynqArcVaultPolicy.NotSafe.selector);
            policy.setOperator(intruder);
        }
        bytes memory add = abi.encodeCall(safe.addOwnerWithThreshold, (intruder, 1));
        // One owner is below threshold.
        execExpectRevert(address(safe), 0, add, CALL, keys(KEY1), bytes("GS020"));
        // The full quorum without the timelock is refused.
        execExpectRevert(
            address(safe),
            0,
            add,
            CALL,
            keys3(),
            abi.encodeWithSelector(
                SynqArcVaultPolicy.NotQueued.selector, policy.operationId(address(safe), 0, add, CALL)
            )
        );
        assertFalse(safe.isOwner(intruder));
        // A timelocked owner-quorum change is the only path.
        timelocked(address(safe), 0, add, CALL);
        assertTrue(safe.isOwner(intruder));
        // The operator can never be an owner (separation of duties).
        bytes memory makeOperator = abi.encodeCall(SynqArcVaultPolicy.setOperator, (intruder));
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(policy), 0, makeOperator, CALL)));
        vm.warp(policy.eta(policy.operationId(address(policy), 0, makeOperator, CALL)));
        execExpectRevert(address(policy), 0, makeOperator, CALL, keys(KEY2, KEY3), bytes("GS013"));
    }

    // ------------------------------------------------------------------ X-ONC-07

    /// @notice X-ONC-07: an expired queued operation, an already-executed calldata hash, and signatures replayed
    ///         under another chain id (testnet -> mainnet) are all refused.
    function test_X_ONC_07_expiredOrReplayedCalldataIsRefused() public {
        bytes memory data = abi.encodeCall(safe.changeThreshold, (3));
        bytes32 id = policy.operationId(address(safe), 0, data, CALL);
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(safe), 0, data, CALL)));
        vm.warp(policy.eta(id) + policy.GRACE_PERIOD() + 1);
        execExpectRevert(
            address(safe),
            0,
            data,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.Expired.selector, id)
        );

        // Re-queued and executed once; the same calldata hash cannot run again.
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(safe), 0, data, CALL)));
        vm.warp(policy.eta(id));
        bytes memory signatures = signDigest(txHash(address(safe), 0, data, CALL), keys(KEY1, KEY2));
        uint256 nonceBefore = safe.nonce();
        vm.prank(stranger);
        assertTrue(
            safe.execTransaction(address(safe), 0, data, CALL, 0, 0, 0, address(0), payable(address(0)), signatures)
        );
        assertEq(safe.getThreshold(), 3);
        execExpectRevert(
            address(safe), 0, data, CALL, keys3(), abi.encodeWithSelector(SynqArcVaultPolicy.NotQueued.selector, id)
        );
        // The exact signed payload is bound to the consumed Safe nonce.
        vm.prank(stranger);
        vm.expectRevert();
        safe.execTransaction(address(safe), 0, data, CALL, 0, 0, 0, address(0), payable(address(0)), signatures);
        assertEq(safe.nonce(), nonceBefore + 1);
    }

    function test_X_ONC_07_signaturesDoNotReplayAcrossChains() public {
        vm.chainId(ARC_TESTNET);
        bytes memory pay = transferData(vendor, 1e6);
        bytes memory testnetSigs = signDigest(txHash(address(token), 0, pay, CALL), keys(KEY1, KEY2));
        bytes32 testnetDomain = safe.domainSeparator();
        // Same vault address, same nonce, mainnet chain id: the EIP-712 domain differs, the signatures do not verify.
        vm.chainId(ARC_MAINNET);
        assertTrue(safe.domainSeparator() != testnetDomain);
        uint256 before = token.balanceOf(vendor);
        vm.prank(stranger);
        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(address(token), 0, pay, CALL, 0, 0, 0, address(0), payable(address(0)), testnetSigs);
        assertEq(token.balanceOf(vendor), before);
        // Back on the signed chain they are valid (proving the refusal is the chain binding).
        vm.chainId(ARC_TESTNET);
        vm.prank(stranger);
        assertTrue(
            safe.execTransaction(address(token), 0, pay, CALL, 0, 0, 0, address(0), payable(address(0)), testnetSigs)
        );
        assertEq(token.balanceOf(vendor), before + 1e6);
    }
}
