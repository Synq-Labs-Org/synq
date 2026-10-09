// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SynqTestBase} from "../utils/SynqTestBase.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";

contract MandateRegistryTest is SynqTestBase {
    bytes32 internal constant FRESH = keccak256("fresh");

    event MandateSuperseded(
        bytes32 indexed groupId,
        bytes32 indexed mandateId,
        uint256 indexed newVersion,
        address account,
        uint256 previousVersion,
        bool securitySensitive,
        uint256 minValidVersion
    );
    event MandateRevoked(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed version, address account);
    event GroupModuleChanged(
        bytes32 indexed groupId, address indexed account, address previousModule, address newModule
    );

    function test_configure_storesTermsAllowlistsAndState() public view {
        MandateRegistry.MandateState memory state = registry.mandateState(address(safe), MANDATE);
        assertEq(uint8(state.status), uint8(MandateRegistry.MandateStatus.Active));
        assertEq(state.currentVersion, 1);
        assertEq(state.minValidVersion, 1);
        MandateRegistry.MandateTerms memory terms = registry.mandateTerms(address(safe), MANDATE, 1);
        assertEq(terms.mandateHash, keccak256("mandate-document-v1"));
        assertEq(terms.token, address(token));
        assertEq(terms.maxTokenPerAction, MAX_TOKEN);
        assertEq(terms.cumulativeNativeCap, CUM_NATIVE);
        assertTrue(registry.isCallAllowed(address(safe), MANDATE, 1, address(token), bytes4(0xa9059cbb)));
        assertTrue(registry.isCallAllowed(address(safe), MANDATE, 1, recipient, bytes4(0)));
        assertFalse(registry.isCallAllowed(address(safe), MANDATE, 1, address(token), bytes4(0x095ea7b3)));
        assertTrue(registry.isRecipientAllowed(address(safe), MANDATE, 1, recipient));
        assertFalse(registry.isRecipientAllowed(address(safe), MANDATE, 1, executor));
    }

    function test_governance_onlyGroupSafe() public {
        MandateRegistry.MandateConfig memory config = defaultConfig();
        address[3] memory callers = [executor, vm.addr(KEY1), address(module)];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert(MandateRegistry.OnlyGroupAccount.selector);
            registry.configureMandate(FRESH, config);
            vm.expectRevert(MandateRegistry.OnlyGroupAccount.selector);
            registry.supersedeMandate(MANDATE, 2, config, true);
            vm.expectRevert(MandateRegistry.OnlyGroupAccount.selector);
            registry.revokeMandate(MANDATE);
            vm.expectRevert(MandateRegistry.OnlyGroupAccount.selector);
            registry.setModule(callers[i]);
            vm.stopPrank();
        }
    }

    function test_mandatesAreIsolatedPerGroup() public {
        vm.prank(creator);
        (, address other) = factory.createGroup(owners(), THRESHOLD, keccak256("other"));
        assertEq(uint8(registry.mandateState(other, MANDATE).status), uint8(MandateRegistry.MandateStatus.None));
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.MandateNotFound.selector, MANDATE));
        registry.revokeMandate(MANDATE);
    }

    function test_configure_rejectsExistingId() public {
        vm.prank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.MandateAlreadyExists.selector, MANDATE));
        registry.configureMandate(MANDATE, defaultConfig());
    }

    function test_revocationIsTerminal() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit MandateRevoked(groupId, MANDATE, 1, address(safe));
        safeCall(address(registry), abi.encodeCall(MandateRegistry.revokeMandate, (MANDATE)));
        vm.startPrank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.MandateIsRevoked.selector, MANDATE));
        registry.configureMandate(MANDATE, defaultConfig());
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.MandateIsRevoked.selector, MANDATE));
        registry.supersedeMandate(MANDATE, 2, defaultConfig(), false);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.MandateIsRevoked.selector, MANDATE));
        registry.revokeMandate(MANDATE);
        vm.stopPrank();
        assertEq(uint8(registry.mandateState(address(safe), MANDATE).status), uint8(MandateRegistry.MandateStatus.Revoked));
    }

    function test_supersede_versionMustIncrementByOne() public {
        vm.startPrank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidVersion.selector, 2, 3));
        registry.supersedeMandate(MANDATE, 3, defaultConfig(), false);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.InvalidVersion.selector, 2, 1));
        registry.supersedeMandate(MANDATE, 1, defaultConfig(), false);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.MandateNotFound.selector, FRESH));
        registry.supersedeMandate(FRESH, 1, defaultConfig(), false);
        vm.stopPrank();
    }

    function test_supersede_emitsAndTracksMinValidVersion() public {
        vm.expectEmit(true, true, true, true, address(registry));
        emit MandateSuperseded(groupId, MANDATE, 2, address(safe), 1, false, 1);
        safeCall(
            address(registry), abi.encodeCall(MandateRegistry.supersedeMandate, (MANDATE, 2, defaultConfig(), false))
        );
        vm.expectEmit(true, true, true, true, address(registry));
        emit MandateSuperseded(groupId, MANDATE, 3, address(safe), 2, true, 3);
        safeCall(
            address(registry), abi.encodeCall(MandateRegistry.supersedeMandate, (MANDATE, 3, defaultConfig(), true))
        );
        MandateRegistry.MandateState memory state = registry.mandateState(address(safe), MANDATE);
        assertEq(state.currentVersion, 3);
        assertEq(state.minValidVersion, 3);
    }

    function test_supersede_tokenDenominationImmutable() public {
        MandateRegistry.MandateConfig memory config = defaultConfig();
        config.token = makeAddr("otherToken");
        vm.prank(address(safe));
        vm.expectRevert(MandateRegistry.TokenChanged.selector);
        registry.supersedeMandate(MANDATE, 2, config, true);
    }

    function test_supersede_preservesCumulativeSpendAcrossVersions() public {
        vm.prank(address(module));
        registry.authorizeSpend(
            address(safe),
            MANDATE,
            1,
            MandateRegistry.SpendRequest(address(token), bytes4(0xa9059cbb), recipient, address(token), 100e6, 0)
        );
        safeCall(
            address(registry), abi.encodeCall(MandateRegistry.supersedeMandate, (MANDATE, 2, defaultConfig(), true))
        );
        assertEq(spentToken(), 100e6);
    }

    function test_configValidation_windowsCapsAndLists() public {
        vm.startPrank(address(safe));
        MandateRegistry.MandateConfig memory config = defaultConfig();
        config.validUntil = config.validAfter;
        vm.expectRevert(MandateRegistry.InvalidWindow.selector);
        registry.configureMandate(FRESH, config);

        config = defaultConfig();
        config.validAfter = block.timestamp - 100;
        config.validUntil = block.timestamp;
        vm.expectRevert(MandateRegistry.InvalidWindow.selector);
        registry.configureMandate(FRESH, config);

        config = defaultConfig();
        config.token = address(0);
        vm.expectRevert(MandateRegistry.InvalidCaps.selector);
        registry.configureMandate(FRESH, config);

        config = defaultConfig();
        config.callSelectors = new bytes4[](1);
        vm.expectRevert(MandateRegistry.InvalidCallList.selector);
        registry.configureMandate(FRESH, config);

        config = defaultConfig();
        config.callTargets = new address[](0);
        config.callSelectors = new bytes4[](0);
        vm.expectRevert(MandateRegistry.InvalidCallList.selector);
        registry.configureMandate(FRESH, config);

        config = defaultConfig();
        config.recipients = new address[](33);
        for (uint256 i; i < 33; ++i) {
            config.recipients[i] = address(uint160(0x1000 + i));
        }
        vm.expectRevert(MandateRegistry.ListTooLong.selector);
        registry.configureMandate(FRESH, config);

        vm.expectRevert(MandateRegistry.InvalidMandateId.selector);
        registry.configureMandate(bytes32(0), defaultConfig());
        vm.stopPrank();
    }

    function test_configValidation_forbidsSynqAndAccountAddresses() public {
        address[5] memory forbidden = [address(0), address(safe), address(registry), address(factory), address(module)];
        vm.startPrank(address(safe));
        for (uint256 i; i < forbidden.length; ++i) {
            MandateRegistry.MandateConfig memory config = defaultConfig();
            config.recipients[0] = forbidden[i];
            vm.expectRevert(abi.encodeWithSelector(MandateRegistry.ForbiddenAddress.selector, forbidden[i]));
            registry.configureMandate(FRESH, config);

            config = defaultConfig();
            config.callTargets[1] = forbidden[i];
            vm.expectRevert(abi.encodeWithSelector(MandateRegistry.ForbiddenAddress.selector, forbidden[i]));
            registry.configureMandate(FRESH, config);

            if (forbidden[i] != address(0)) {
                config = defaultConfig();
                config.token = forbidden[i];
                vm.expectRevert(abi.encodeWithSelector(MandateRegistry.ForbiddenAddress.selector, forbidden[i]));
                registry.configureMandate(FRESH, config);
            }
        }
        MandateRegistry.MandateConfig memory tokenAsRecipient = defaultConfig();
        tokenAsRecipient.recipients[0] = address(token);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.ForbiddenAddress.selector, address(token)));
        registry.configureMandate(FRESH, tokenAsRecipient);
        vm.stopPrank();
    }

    function test_setModule_emitsAndRejectsSelfReferences() public {
        address replacement = makeAddr("replacement");
        vm.expectEmit(true, true, true, true, address(registry));
        emit GroupModuleChanged(groupId, address(safe), address(module), replacement);
        safeCall(address(registry), abi.encodeCall(MandateRegistry.setModule, (replacement)));
        assertEq(registry.moduleOf(address(safe)), replacement);
        vm.startPrank(address(safe));
        vm.expectRevert(MandateRegistry.InvalidModule.selector);
        registry.setModule(address(safe));
        vm.expectRevert(MandateRegistry.InvalidModule.selector);
        registry.setModule(address(registry));
        vm.expectRevert(MandateRegistry.InvalidModule.selector);
        registry.setModule(address(factory));
        vm.stopPrank();
    }

    function test_authorizeSpend_tokenMismatchAndNativeOnlyMandate() public {
        vm.prank(address(module));
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.TokenMismatch.selector, address(0xBEEF)));
        registry.authorizeSpend(
            address(safe),
            MANDATE,
            1,
            MandateRegistry.SpendRequest(address(token), bytes4(0xa9059cbb), recipient, address(0xBEEF), 1, 0)
        );
    }
}
