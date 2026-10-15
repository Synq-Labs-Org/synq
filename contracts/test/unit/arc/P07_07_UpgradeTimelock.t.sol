// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase, SafeMigration} from "./ArcVaultBase.sol";
import {SynqArcVaultPolicy} from "../../../src/arc/SynqArcVaultPolicy.sol";
import {SynqArcVaultFactory, SynqArcVaultSetup} from "../../../src/arc/SynqArcVaultFactory.sol";
import {SynqMilestoneEscrow} from "../../../src/arc/SynqMilestoneEscrow.sol";

interface ISafeProxyFactoryLike {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address);
}

/// @notice P07-07: upgrade authority is explicit (owner quorum + timelock) and exercised, not hidden.
contract P07_07_UpgradeTimelockTest is ArcVaultBase {
    bytes32 internal constant EIP1967_IMPLEMENTATION = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
    bytes32 internal constant EIP1967_ADMIN = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);

    function test_P07_07_upgradeAuthorityIsDeclared() public view {
        assertEq(
            policy.UPGRADE_AUTHORITY(),
            "NON_UPGRADEABLE_POLICY; SAFE_CODE_AND_POLICY_SWAP_ONLY_BY_OWNER_QUORUM_AFTER_TIMELOCK"
        );
        assertEq(policy.delay(), DELAY);
        assertEq(policy.safe(), address(safe));
        assertEq(guardOf(safe), address(policy));
        assertTrue(safe.isModuleEnabled(address(policy)));
        // No proxy slots on the Synq contracts: there is no hidden implementation to swap.
        assertEq(vm.load(address(policy), EIP1967_IMPLEMENTATION), bytes32(0));
        assertEq(vm.load(address(policy), EIP1967_ADMIN), bytes32(0));
        assertEq(vm.load(address(factory), EIP1967_IMPLEMENTATION), bytes32(0));
    }

    function test_P07_07_escrowHasNoUpgradeOrAdmin() public {
        SynqMilestoneEscrow escrow = newEscrow();
        assertEq(escrow.UPGRADE_AUTHORITY(), "NON_UPGRADEABLE_NO_ADMIN");
        assertEq(vm.load(address(escrow), EIP1967_IMPLEMENTATION), bytes32(0));
        assertEq(vm.load(address(escrow), EIP1967_ADMIN), bytes32(0));
    }

    function test_P07_07_singletonMigrationRequiresQueueDelayAndRunsOnce() public {
        SafeMigration migration = new SafeMigration();
        address newSingleton = deployCode("out/SafeL2.sol/SafeL2.json");
        bytes memory data = abi.encodeCall(SafeMigration.migrate, (newSingleton));
        bytes32 id = policy.operationId(address(migration), 0, data, DELEGATECALL);

        // Not queued: refused even with full quorum.
        execExpectRevert(
            address(migration),
            0,
            data,
            DELEGATECALL,
            keys(KEY1, KEY2, KEY3),
            abi.encodeWithSelector(SynqArcVaultPolicy.NotQueued.selector, id)
        );
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(migration), 0, data, DELEGATECALL)));
        uint256 readyAt = policy.eta(id);
        assertEq(readyAt, block.timestamp + DELAY);

        // Queued but early: refused.
        vm.warp(readyAt - 1);
        execExpectRevert(
            address(migration),
            0,
            data,
            DELEGATECALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.NotReady.selector, id, readyAt)
        );
        // After the delay, below quorum is still refused.
        vm.warp(readyAt);
        execExpectRevert(address(migration), 0, data, DELEGATECALL, keys(KEY3), bytes("GS020"));
        // Quorum after the delay: executes, once.
        assertTrue(exec(address(migration), 0, data, DELEGATECALL, keys(KEY1, KEY2)));
        assertEq(address(uint160(uint256(vm.load(address(safe), bytes32(0))))), newSingleton);
        assertEq(policy.eta(id), 0);
        execExpectRevert(
            address(migration),
            0,
            data,
            DELEGATECALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.NotQueued.selector, id)
        );
    }

    function test_P07_07_guardAndModuleRemovalAreTimelocked() public {
        bytes memory unguard = abi.encodeCall(safe.setGuard, (address(0)));
        bytes memory unmodule = abi.encodeCall(safe.disableModule, (address(0x1), address(policy)));
        execExpectRevert(
            address(safe),
            0,
            unguard,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(
                SynqArcVaultPolicy.NotQueued.selector, policy.operationId(address(safe), 0, unguard, CALL)
            )
        );
        execExpectRevert(
            address(safe),
            0,
            unmodule,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(
                SynqArcVaultPolicy.NotQueued.selector, policy.operationId(address(safe), 0, unmodule, CALL)
            )
        );
        timelocked(address(safe), 0, unguard, CALL);
        assertEq(guardOf(safe), address(0));
    }

    function test_P07_07_queuedOperationExpiresAfterGrace() public {
        bytes memory data = abi.encodeCall(safe.changeThreshold, (3));
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(safe), 0, data, CALL)));
        bytes32 id = policy.operationId(address(safe), 0, data, CALL);
        vm.warp(policy.eta(id) + policy.GRACE_PERIOD() + 1);
        execExpectRevert(
            address(safe),
            0,
            data,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.Expired.selector, id)
        );
    }

    function test_P07_07_cancelledOperationCannotRun() public {
        bytes memory data = abi.encodeCall(safe.addOwnerWithThreshold, (makeAddr("new"), 2));
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(safe), 0, data, CALL)));
        bytes32 id = policy.operationId(address(safe), 0, data, CALL);
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.cancel, (id)));
        vm.warp(block.timestamp + DELAY);
        execExpectRevert(
            address(safe),
            0,
            data,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.NotQueued.selector, id)
        );
    }

    function test_P07_07_ownerAddAndThresholdChangeAfterTimelock() public {
        address newOwner = makeAddr("newOwner");
        timelocked(address(safe), 0, abi.encodeCall(safe.addOwnerWithThreshold, (newOwner, 3)), CALL);
        assertTrue(safe.isOwner(newOwner));
        assertEq(safe.getThreshold(), 3);
    }

    function test_P07_07_refundsAndSafeTxGasRejected() public {
        bytes memory data = transferData(stranger, 1e6);
        bytes32 digest =
            safe.getTransactionHash(address(token), 0, data, CALL, 0, 0, 1, address(0), stranger, safe.nonce());
        bytes memory signatures = signDigest(digest, keys(KEY1, KEY2));
        vm.prank(stranger);
        vm.expectRevert(SynqArcVaultPolicy.RefundsDisabled.selector);
        safe.execTransaction(address(token), 0, data, CALL, 0, 0, 1, address(0), payable(stranger), signatures);
    }

    function test_P07_07_delayBoundsAndWriteOnceBinding() public {
        address[] memory none = new address[](0);
        vm.expectRevert(SynqArcVaultPolicy.InvalidDelay.selector);
        new SynqArcVaultPolicy(address(token), 1 hours - 1, guardian, operator, none, 0, 0);
        vm.expectRevert(SynqArcVaultPolicy.InvalidDelay.selector);
        new SynqArcVaultPolicy(address(token), 30 days + 1, guardian, operator, none, 0, 0);
        vm.prank(address(factory));
        vm.expectRevert(SynqArcVaultPolicy.AlreadyBound.selector);
        policy.bind(stranger);
        vm.prank(stranger);
        vm.expectRevert(SynqArcVaultPolicy.NotFactory.selector);
        policy.bind(stranger);
    }

    function test_P07_07_setupHelperCannotBeReplayed() public {
        SynqArcVaultSetup helper = factory.setupHelper();
        vm.expectRevert(SynqArcVaultSetup.OnlyDelegateCall.selector);
        helper.install(address(policy));
    }

    /// @dev A front-runner who sees a pending createVault rebuilds its exact initializer and salt nonce and pushes
    ///      it through SafeProxyFactory first. The setup helper refuses (the factory is not creating that proxy), so
    ///      the squat reverts and the honest createVault still lands on the predicted addresses.
    function test_P07_07_frontRunOfPendingCreateVaultCannotSquat() public {
        bytes32 salt = keccak256("pending-vault");
        bytes32 vaultId = factory.computeVaultId(creator, salt);
        address[] memory recipients = new address[](1);
        recipients[0] = vendor;
        bytes memory policyInit = abi.encodePacked(
            type(SynqArcVaultPolicy).creationCode,
            abi.encode(address(token), DELAY, guardian, operator, recipients, PER_PAYMENT, WINDOW_CAP)
        );
        address predictedPolicy = vm.computeCreate2Address(vaultId, keccak256(policyInit), address(factory));
        bytes memory initializer = abi.encodeCall(
            safe.setup,
            (
                owners(),
                THRESHOLD,
                address(factory.setupHelper()),
                abi.encodeCall(SynqArcVaultSetup.install, (predictedPolicy)),
                factory.fallbackHandler(),
                address(0),
                0,
                payable(address(0))
            )
        );
        address predictedSafe = factory.predictSafe(initializer, uint256(vaultId));
        assertEq(predictedSafe.code.length, 0);

        vm.prank(stranger);
        // SafeProxyFactory bubbles the failed setup (GS000 from NotFactoryCreation) as an empty revert.
        vm.expectRevert(bytes(""));
        ISafeProxyFactoryLike(safeProxyFactory).createProxyWithNonce(safeSingleton, initializer, uint256(vaultId));
        assertEq(predictedSafe.code.length, 0, "not squatted");

        (address account, SynqArcVaultPolicy p) = createVault(vendor, salt);
        assertEq(account, predictedSafe);
        assertEq(address(p), predictedPolicy);
        assertEq(p.safe(), account);
    }

    function keys(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory list) {
        list = new uint256[](3);
        list[0] = a;
        list[1] = b;
        list[2] = c;
    }
}
