// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SynqTestBase} from "../utils/SynqTestBase.sol";
import {SynqGroupFactory} from "../../src/SynqGroupFactory.sol";
import {SynqSafeModuleSetup} from "../../src/SynqSafeModuleSetup.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {ISafeFull} from "../utils/ISafeFull.sol";

contract SynqGroupFactoryTest is SynqTestBase {
    bytes32 internal constant FALLBACK_HANDLER_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    event GroupCreated(
        bytes32 indexed groupId,
        address indexed account,
        address[] owners,
        uint256 threshold,
        address module,
        address registry,
        address indexed creator,
        bytes32 salt
    );

    function test_createGroup_deploysSafeWithModuleHandlerAndBinding() public view {
        assertEq(safe.VERSION(), "1.4.1");
        assertEq(safe.getThreshold(), THRESHOLD);
        address[] memory actual = safe.getOwners();
        assertEq(actual.length, 3);
        for (uint256 i; i < 3; ++i) {
            assertTrue(safe.isOwner(owners()[i]));
        }
        (address[] memory modules,) = safe.getModulesPaginated(address(1), 10);
        assertEq(modules.length, 1);
        assertEq(modules[0], address(module));
        bytes memory handler = safe.getStorageAt(uint256(FALLBACK_HANDLER_SLOT), 1);
        assertEq(abi.decode(handler, (address)), fallbackHandler);
        assertEq(registry.groupOf(address(safe)), groupId);
        assertEq(registry.accountOf(groupId), address(safe));
        assertEq(registry.moduleOf(address(safe)), address(module));
        assertEq(groupId, factory.computeGroupId(creator, SALT));
        assertEq(registry.factory(), address(factory));
        assertEq(address(module.registry()), address(registry));
        assertEq(module.factory(), address(factory));
    }

    function test_createGroup_emitsGroupCreated() public {
        bytes32 salt = keccak256("second");
        bytes32 expectedId = factory.computeGroupId(address(this), salt);
        vm.expectEmit(true, false, true, false, address(factory));
        emit GroupCreated(expectedId, address(0), owners(), 2, address(module), address(registry), address(this), salt);
        (bytes32 id, address account) = factory.createGroup(owners(), 2, salt);
        assertEq(id, expectedId);
        assertEq(registry.accountOf(id), account);
    }

    function test_createGroup_groupIdNamespacedByCreator() public {
        address frontRunner = makeAddr("frontRunner");
        address[] memory attackerOwners = new address[](1);
        attackerOwners[0] = frontRunner;
        vm.prank(frontRunner);
        (bytes32 attackerId,) = factory.createGroup(attackerOwners, 1, SALT);
        assertTrue(attackerId != groupId);
        assertEq(registry.accountOf(groupId), address(safe));
    }

    function test_createGroup_sameCreatorAndSaltReverts() public {
        vm.prank(creator);
        vm.expectRevert(bytes("Create2 call failed"));
        factory.createGroup(owners(), THRESHOLD, SALT);
    }

    function test_createGroup_rejectsInvalidOwnerSets() public {
        address[] memory none = new address[](0);
        vm.expectRevert(SynqGroupFactory.InvalidOwners.selector);
        factory.createGroup(none, 1, keccak256("a"));

        vm.expectRevert(SynqGroupFactory.InvalidThreshold.selector);
        factory.createGroup(owners(), 0, keccak256("b"));

        vm.expectRevert(SynqGroupFactory.InvalidThreshold.selector);
        factory.createGroup(owners(), 4, keccak256("c"));

        address[] memory dup = owners();
        dup[2] = dup[0];
        vm.expectRevert(abi.encodeWithSelector(SynqGroupFactory.InvalidOwner.selector, dup[0]));
        factory.createGroup(dup, 2, keccak256("d"));

        address[] memory protectedOwners = owners();
        protectedOwners[1] = address(module);
        vm.expectRevert(abi.encodeWithSelector(SynqGroupFactory.InvalidOwner.selector, address(module)));
        factory.createGroup(protectedOwners, 2, keccak256("e"));

        protectedOwners[1] = address(registry);
        vm.expectRevert(abi.encodeWithSelector(SynqGroupFactory.InvalidOwner.selector, address(registry)));
        factory.createGroup(protectedOwners, 2, keccak256("f"));

        protectedOwners[1] = address(1);
        vm.expectRevert(abi.encodeWithSelector(SynqGroupFactory.InvalidOwner.selector, address(1)));
        factory.createGroup(protectedOwners, 2, keccak256("g"));

        protectedOwners[1] = address(0);
        vm.expectRevert(abi.encodeWithSelector(SynqGroupFactory.InvalidOwner.selector, address(0)));
        factory.createGroup(protectedOwners, 2, keccak256("h"));
    }

    function test_constructor_requiresSafeInfrastructureCode() public {
        address missing = makeAddr("missing");
        vm.expectRevert(abi.encodeWithSelector(SynqGroupFactory.InfrastructureMissing.selector, missing));
        new SynqGroupFactory(missing, safeProxyFactory, fallbackHandler);
        vm.expectRevert(abi.encodeWithSelector(SynqGroupFactory.InfrastructureMissing.selector, missing));
        new SynqGroupFactory(safeSingleton, missing, fallbackHandler);
        vm.expectRevert(abi.encodeWithSelector(SynqGroupFactory.InfrastructureMissing.selector, missing));
        new SynqGroupFactory(safeSingleton, safeProxyFactory, missing);
    }

    function test_moduleSetup_rejectsDirectCall() public {
        SynqSafeModuleSetup setupHelper = factory.moduleSetup();
        vm.expectRevert(SynqSafeModuleSetup.OnlyDelegateCall.selector);
        setupHelper.enableModule(address(module));
    }

    function test_registry_bindGroupOnlyFactory() public {
        vm.expectRevert(MandateRegistry.OnlyFactory.selector);
        registry.bindGroup(keccak256("x"), makeAddr("acct"), address(module));
    }

    function test_safeSetup_cannotBeReplayed() public {
        vm.expectRevert(bytes("GS200"));
        safe.setup(owners(), 1, address(0), "", address(0), address(0), 0, payable(address(0)));
    }
}
