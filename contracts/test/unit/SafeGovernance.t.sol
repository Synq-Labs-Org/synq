// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SynqTestBase} from "../utils/SynqTestBase.sol";
import {ExecutionModule} from "../../src/ExecutionModule.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";

/// @notice Safe-native owner governance stays authoritative and independent of the Synq module.
contract SafeGovernanceTest is SynqTestBase {
    address internal constant SENTINEL = address(1);
    uint256 internal constant NEW_OWNER_KEY = 0xF00D;

    // ------------------------------------------------------------------ CON-008 / CON-018 owner recovery while paused

    function test_CON008_CON018_ownerRecoveryWorksWhilePaused() public {
        safeCall(address(module), abi.encodeCall(ExecutionModule.pause, ()));
        address vault = makeAddr("recoveryVault");
        safeCall(address(token), abi.encodeWithSelector(bytes4(0xa9059cbb), vault, SAFE_TOKEN_FUNDING));
        assertTrue(safeExecWith(safe, vault, SAFE_NATIVE_FUNDING, "", 0, keys(KEY2, KEY3)));
        assertEq(token.balanceOf(vault), SAFE_TOKEN_FUNDING);
        assertEq(vault.balance, SAFE_NATIVE_FUNDING);
        assertTrue(module.paused(address(safe)));

        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 1e6);
        execGrantExpectRevert(
            grant, data, abi.encodeWithSelector(ExecutionModule.ExecutionPaused.selector, address(safe))
        );
    }

    function test_CON008_CON018_moduleUninstallAndMandateRevokeWorkWhilePaused() public {
        safeCall(address(module), abi.encodeCall(ExecutionModule.pause, ()));
        safeCall(address(registry), abi.encodeCall(MandateRegistry.revokeMandate, (MANDATE)));
        safeCall(address(safe), abi.encodeCall(safe.disableModule, (SENTINEL, address(module))));
        assertFalse(safe.isModuleEnabled(address(module)));
        address vault = makeAddr("recoveryVault");
        safeCall(address(token), abi.encodeWithSelector(bytes4(0xa9059cbb), vault, 1e6));
        assertEq(token.balanceOf(vault), 1e6);
    }

    // ------------------------------------------------------------------ owner rotation via Safe

    function test_ownerRotationViaSafe_rotatedOwnerLosesGrantAuthority() public {
        address oldOwner = vm.addr(KEY3);
        address newOwner = vm.addr(NEW_OWNER_KEY);
        address prev = _prevOwner(oldOwner);
        safeCall(address(safe), abi.encodeCall(safe.swapOwner, (prev, oldOwner, newOwner)));
        assertFalse(safe.isOwner(oldOwner));
        assertTrue(safe.isOwner(newOwner));

        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory stale = signDigest(grantDigest(module, grant), keys(KEY1, KEY3));
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, stale);

        bytes memory fresh = signDigest(grantDigest(module, grant), keys(KEY1, NEW_OWNER_KEY));
        vm.prank(executor);
        module.execute(grant, data, fresh);
        assertEq(spentToken(), 10e6);
    }

    function test_ownerRotationWorksWhilePaused() public {
        safeCall(address(module), abi.encodeCall(ExecutionModule.pause, ()));
        address newOwner = vm.addr(NEW_OWNER_KEY);
        safeCall(address(safe), abi.encodeCall(safe.addOwnerWithThreshold, (newOwner, 3)));
        assertTrue(safe.isOwner(newOwner));
        assertEq(safe.getThreshold(), 3);
    }

    // ------------------------------------------------------------------ CON-004 / CON-014 agent/module cannot change governance

    function test_CON004_CON014_executorCannotCallSafeGovernanceDirectly() public {
        vm.startPrank(executor);
        vm.expectRevert(bytes("GS031"));
        safe.addOwnerWithThreshold(executor, 1);
        vm.expectRevert(bytes("GS031"));
        safe.changeThreshold(1);
        vm.expectRevert(bytes("GS031"));
        safe.enableModule(executor);
        vm.expectRevert(bytes("GS031"));
        safe.disableModule(SENTINEL, address(module));
        vm.expectRevert(bytes("GS031"));
        safe.setGuard(executor);
        vm.expectRevert(bytes("GS031"));
        safe.setFallbackHandler(executor);
        vm.expectRevert(bytes("GS104"));
        safe.execTransactionFromModule(address(safe), 0, abi.encodeCall(safe.changeThreshold, (1)), 0);
        vm.stopPrank();
    }

    function test_CON004_CON014_grantTargetingSafeGovernanceRejected() public {
        bytes[4] memory calls = [
            abi.encodeCall(safe.addOwnerWithThreshold, (executor, 1)),
            abi.encodeCall(safe.changeThreshold, (1)),
            abi.encodeCall(safe.enableModule, (executor)),
            abi.encodeCall(safe.swapOwner, (SENTINEL, vm.addr(KEY1), executor))
        ];
        for (uint256 i; i < calls.length; ++i) {
            (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(i + 1, 10e6);
            grant.target = address(safe);
            grant.selector = bytes4(calls[i]);
            grant.calldataHash = keccak256(calls[i]);
            execGrantExpectRevert(
                grant, calls[i], abi.encodeWithSelector(ExecutionModule.ProtectedAddress.selector, address(safe))
            );
        }
        _assertGovernanceUnchanged();
    }

    function test_CON004_CON014_grantTargetingSynqGovernanceRejected() public {
        bytes memory setModule = abi.encodeCall(MandateRegistry.setModule, (executor));
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(1, 10e6);
        grant.target = address(registry);
        grant.selector = MandateRegistry.setModule.selector;
        grant.calldataHash = keccak256(setModule);
        execGrantExpectRevert(
            grant, setModule, abi.encodeWithSelector(ExecutionModule.ProtectedAddress.selector, address(registry))
        );
        bytes memory unpause = abi.encodeCall(ExecutionModule.unpause, ());
        grant.target = address(module);
        grant.selector = ExecutionModule.unpause.selector;
        grant.calldataHash = keccak256(unpause);
        execGrantExpectRevert(
            grant, unpause, abi.encodeWithSelector(ExecutionModule.ProtectedAddress.selector, address(module))
        );
        assertEq(registry.moduleOf(address(safe)), address(module));
    }

    function test_CON004_CON014_moduleOnlyEverRequestsCallOperation() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signGrant(grant);
        vm.expectCall(
            address(safe), abi.encodeCall(safe.execTransactionFromModule, (address(token), 0, data, uint8(0)))
        );
        vm.prank(executor);
        module.execute(grant, data, signatures);
        _assertGovernanceUnchanged();
    }

    function _assertGovernanceUnchanged() internal view {
        assertEq(safe.getThreshold(), THRESHOLD);
        address[] memory current = safe.getOwners();
        assertEq(current.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertTrue(safe.isOwner(owners()[i]));
        }
        (address[] memory modules,) = safe.getModulesPaginated(SENTINEL, 10);
        assertEq(modules.length, 1);
        assertEq(modules[0], address(module));
    }

    function _prevOwner(address owner) internal view returns (address) {
        address[] memory list = safe.getOwners();
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == owner) return i == 0 ? SENTINEL : list[i - 1];
        }
        revert("owner not found");
    }
}
