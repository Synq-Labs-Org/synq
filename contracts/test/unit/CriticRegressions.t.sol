// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SynqTestBase} from "../utils/SynqTestBase.sol";
import {SynqGroupFactory} from "../../src/SynqGroupFactory.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {ExecutionModule} from "../../src/ExecutionModule.sol";
import {SynqSafeModuleSetup} from "../../src/SynqSafeModuleSetup.sol";
import {ISafe, ISafeProxyFactory} from "../../src/interfaces/ISafe.sol";
import {ISafeFull} from "../utils/ISafeFull.sol";

/// @notice Regressions for the contracts critic findings (M1, L1, I1), asserting the fixed behaviour.
contract CriticRegressionsTest is SynqTestBase {
    address internal attacker = makeAddr("attacker");

    function _factoryInitializer(address[] memory safeOwners, uint256 threshold) internal view returns (bytes memory) {
        return abi.encodeCall(
            ISafe.setup,
            (
                safeOwners,
                threshold,
                address(factory.moduleSetup()),
                abi.encodeCall(SynqSafeModuleSetup.enableModule, (address(module))),
                fallbackHandler,
                address(0),
                0,
                payable(address(0))
            )
        );
    }

    // ------------------------------------------------------------------ M1: proxy squatting via SafeProxyFactory

    function test_M1_A1_copiedInitializerCannotSquatProxyAndVictimStillCreates() public {
        address victim = makeAddr("victim");
        bytes32 salt = keccak256("victim-salt");
        bytes32 gid = factory.computeGroupId(victim, salt);
        bytes memory initializer = _factoryInitializer(owners(), 2);
        address predicted = factory.predictAccount(initializer, uint256(gid));
        assertEq(predicted.code.length, 0);

        vm.prank(attacker);
        vm.expectRevert();
        ISafeProxyFactory(safeProxyFactory).createProxyWithNonce(safeSingleton, initializer, uint256(gid));
        assertEq(predicted.code.length, 0, "no proxy squatted");

        vm.prank(victim);
        (bytes32 id, address account) = factory.createGroup(owners(), 2, salt);
        assertEq(id, gid);
        assertEq(account, predicted);
        assertTrue(ISafeFull(account).isModuleEnabled(address(module)));
        assertEq(registry.groupOf(account), gid);
        assertFalse(factory.isCreating(account));
    }

    function test_M1_setupHelperUnusableOutsideFactoryCreation() public {
        address[] memory attackerOwners = new address[](1);
        attackerOwners[0] = attacker;
        bytes memory initializer = _factoryInitializer(attackerOwners, 1);
        vm.prank(attacker);
        vm.expectRevert();
        ISafeProxyFactory(safeProxyFactory).createProxyWithNonce(safeSingleton, initializer, 123);
        assertEq(factory.predictAccount(initializer, 123).code.length, 0);
    }

    function test_M1_differentSafeElsewhereIsHarmless() public {
        address[] memory attackerOwners = new address[](1);
        attackerOwners[0] = attacker;
        bytes memory plainInitializer = abi.encodeCall(
            ISafe.setup, (attackerOwners, 1, address(0), "", fallbackHandler, address(0), 0, payable(address(0)))
        );
        vm.prank(attacker);
        address other = ISafeProxyFactory(safeProxyFactory).createProxyWithNonce(
            safeSingleton, plainInitializer, uint256(factory.computeGroupId(creator, SALT))
        );
        assertTrue(other != address(safe));
        assertEq(registry.groupOf(other), bytes32(0));
        vm.prank(other);
        vm.expectRevert(ExecutionModule.AccountNotRegistered.selector);
        module.setExecutor(attacker, true);
        vm.prank(other);
        vm.expectRevert(MandateRegistry.OnlyGroupAccount.selector);
        registry.configureMandate(keccak256("m"), defaultConfig());
        vm.prank(creator);
        (, address fresh) = factory.createGroup(owners(), THRESHOLD, keccak256("after-attack"));
        assertTrue(ISafeFull(fresh).isModuleEnabled(address(module)));
    }

    // ------------------------------------------------------------------ L1: module added as Safe owner

    function test_L1_A2_moduleAsOwnerBlocksExecution() public {
        safeCall(address(safe), abi.encodeCall(ISafeFull.addOwnerWithThreshold, (address(module), 2)));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(77, 10e6);
        bytes32 digest = grantDigest(module, grant);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY1, digest);
        bytes memory human = abi.encodePacked(r, s, v);
        bytes memory mod = abi.encodePacked(bytes32(uint256(uint160(address(module)))), bytes32(0), uint8(1));
        bytes memory sigs =
            vm.addr(KEY1) < address(module) ? abi.encodePacked(human, mod) : abi.encodePacked(mod, human);
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.ModuleIsSafeOwner.selector);
        module.execute(grant, data, sigs);

        vm.prank(executor);
        vm.expectRevert(ExecutionModule.ModuleIsSafeOwner.selector);
        module.execute(grant, data, signGrant(grant));
        assertEq(token.balanceOf(recipient), 0);

        address prev = _prevOwner(address(module));
        safeCall(address(safe), abi.encodeCall(ISafeFull.removeOwner, (prev, address(module), 2)));
        execGrant(grant, data);
        assertEq(token.balanceOf(recipient), 10e6);
    }

    function test_L1_moduleSelfApprovalSignatureRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY1, grantDigest(module, grant));
        bytes memory human = abi.encodePacked(r, s, v);
        bytes memory mod = abi.encodePacked(bytes32(uint256(uint160(address(module)))), bytes32(0), uint8(1));
        bool humanFirst = vm.addr(KEY1) < address(module);
        bytes memory sigs = humanFirst ? abi.encodePacked(human, mod) : abi.encodePacked(mod, human);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ExecutionModule.ModuleSelfApproval.selector, humanFirst ? 1 : 0));
        module.execute(grant, data, sigs);
    }

    // ------------------------------------------------------------------ I1: narrowing supersession must invalidate

    function test_I1_A3_nonSensitiveNarrowingRejectedAndSensitiveInvalidatesOldGrants() public {
        MandateRegistry.MandateConfig memory c2 = defaultConfig();
        address other = makeAddr("other");
        c2.recipients[0] = other;
        c2.callTargets[1] = other;
        c2.maxTokenPerAction = 1e6;
        vm.prank(address(safe));
        vm.expectRevert(MandateRegistry.NarrowingSupersessionMustInvalidate.selector);
        registry.supersedeMandate(MANDATE, 2, c2, false);
        assertEq(registry.mandateState(address(safe), MANDATE).currentVersion, 1);

        safeCall(address(registry), abi.encodeCall(MandateRegistry.supersedeMandate, (MANDATE, 2, c2, true)));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(78, 900e6);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(MandateRegistry.MandateVersionNotValid.selector, 1));
        assertEq(token.balanceOf(recipient), 0);
    }

    function test_I1_everyNarrowingDimensionRequiresInvalidation() public {
        for (uint256 k; k < 9; ++k) {
            MandateRegistry.MandateConfig memory c = defaultConfig();
            if (k == 0) c.maxTokenPerAction -= 1;
            else if (k == 1) c.maxNativePerAction -= 1;
            else if (k == 2) c.cumulativeTokenCap -= 1;
            else if (k == 3) c.cumulativeNativeCap -= 1;
            else if (k == 4) c.validUntil -= 1;
            else if (k == 5) c.validAfter += 1;
            else if (k == 6) c.callSelectors[0] = bytes4(0x23b872dd);
            else if (k == 7) c.callTargets[1] = makeAddr("replacementTarget");
            else c.recipients[0] = makeAddr("replacementRecipient");
            vm.prank(address(safe));
            vm.expectRevert(MandateRegistry.NarrowingSupersessionMustInvalidate.selector);
            registry.supersedeMandate(MANDATE, 2, c, false);
        }
    }

    function test_I1_pureWideningKeepsOlderVersionGrantable() public {
        MandateRegistry.MandateConfig memory wider = defaultConfig();
        wider.maxTokenPerAction = MAX_TOKEN * 2;
        wider.cumulativeTokenCap = CUM_TOKEN * 2;
        wider.validUntil += 1 days;
        address extra = makeAddr("extraRecipient");
        wider.recipients = new address[](2);
        wider.recipients[0] = recipient;
        wider.recipients[1] = extra;
        safeCall(address(registry), abi.encodeCall(MandateRegistry.supersedeMandate, (MANDATE, 2, wider, false)));
        assertEq(registry.mandateState(address(safe), MANDATE).minValidVersion, 1);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 100e6);
        execGrant(grant, data);
        assertEq(token.balanceOf(recipient), 100e6);
        MandateRegistry.MandateLists memory lists = registry.mandateLists(address(safe), MANDATE, 2);
        assertEq(lists.recipients.length, 2);
    }

    function _prevOwner(address owner) internal view returns (address) {
        address[] memory list = safe.getOwners();
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == owner) return i == 0 ? address(1) : list[i - 1];
        }
        revert("owner not found");
    }
}
