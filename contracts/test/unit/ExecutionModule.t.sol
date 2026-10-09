// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SynqTestBase} from "../utils/SynqTestBase.sol";
import {ExecutionModule} from "../../src/ExecutionModule.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {LocalTestToken} from "../../src/test/LocalTestToken.sol";
import {MisbehavingToken, ReentrantRecipient, HookToken, RejectingRecipient} from "../utils/TestFixtures.sol";

contract ExecutionModuleTest is SynqTestBase {
    bytes32 internal constant MANDATE2 = keccak256("synq.mandate.second");
    address internal constant SENTINEL = address(1);

    event GrantExecuted(
        bytes32 indexed groupId,
        bytes32 indexed intentHash,
        bytes32 indexed mandateId,
        uint256 mandateVersion,
        address account,
        address executor,
        bytes32 pluginId,
        uint256 chainId,
        uint256 nonce,
        bytes32 grantHash,
        address target,
        bytes4 selector,
        bytes32 calldataHash,
        address token,
        address recipient,
        uint256 tokenAmount,
        uint256 nativeValue,
        uint256 outputAmount
    );

    // ------------------------------------------------------------------ helpers

    function configureSecondMandate(address tokenAddr, address target, bytes4 selector, address payee) internal {
        MandateRegistry.MandateConfig memory config = defaultConfig();
        config.token = tokenAddr;
        config.callTargets = new address[](1);
        config.callSelectors = new bytes4[](1);
        config.callTargets[0] = target;
        config.callSelectors[0] = selector;
        config.recipients = new address[](1);
        config.recipients[0] = payee;
        if (tokenAddr == address(0)) {
            config.maxTokenPerAction = 0;
            config.cumulativeTokenCap = 0;
        }
        safeCall(address(registry), abi.encodeCall(MandateRegistry.configureMandate, (MANDATE2, config)));
    }

    function supersede(uint256 version, MandateRegistry.MandateConfig memory config, bool sensitive) internal {
        safeCall(
            address(registry), abi.encodeCall(MandateRegistry.supersedeMandate, (MANDATE, version, config, sensitive))
        );
    }

    // ------------------------------------------------------------------ happy paths and encoding

    function test_tokenTransfer_executesRecordsSpendAndEmits() public {
        uint256 amount = 150e6;
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, amount);
        bytes32 digest = grantDigest(module, grant);
        vm.expectEmit(true, true, true, true, address(module));
        emit GrantExecuted(
            groupId,
            grant.intentHash,
            MANDATE,
            1,
            address(safe),
            executor,
            PLUGIN,
            block.chainid,
            1,
            digest,
            address(token),
            bytes4(0xa9059cbb),
            keccak256(data),
            address(token),
            recipient,
            amount,
            0,
            amount
        );
        bytes32 returned = execGrant(grant, data);
        assertEq(returned, digest);
        assertEq(token.balanceOf(recipient), amount);
        assertEq(token.balanceOf(address(safe)), SAFE_TOKEN_FUNDING - amount);
        assertEq(spentToken(), amount);
        assertTrue(module.nonceUsed(address(safe), 1));
        assertTrue(module.intentUsed(address(safe), grant.intentHash));
    }

    function test_nativeTransfer_executesAndRecordsSpend() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = nativeGrant(7, 0.4 ether);
        execGrant(grant, data);
        assertEq(recipient.balance, 0.4 ether);
        assertEq(address(safe).balance, SAFE_NATIVE_FUNDING - 0.4 ether);
        assertEq(spentNative(), 0.4 ether);
        assertEq(spentToken(), 0);
    }

    function test_hashGrant_matchesIndependentEip712Encoding() public view {
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(3, 1e6);
        assertEq(module.hashGrant(grant), grantDigest(module, grant));
        assertEq(
            module.GRANT_TYPEHASH(),
            keccak256(
                "ExecutionGrant(bytes32 groupId,address account,bytes32 mandateId,uint256 mandateVersion,address executor,bytes32 pluginId,uint256 chainId,address target,bytes4 selector,bytes32 calldataHash,address token,uint256 maxInputAmount,uint256 nativeValue,uint256 minOutputAmount,address recipient,uint256 validAfter,uint256 validUntil,uint256 nonce,bytes32 intentHash)"
            )
        );
        assertEq(
            module.domainSeparator(),
            keccak256(
                abi.encode(
                    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                    keccak256("SynqExecutionModule"),
                    keccak256("1"),
                    block.chainid,
                    address(module)
                )
            )
        );
    }

    // ------------------------------------------------------------------ CON-001 / CON-011 / CON-021 unauthorized execution

    function test_CON001_CON011_CON021_unauthorizedCallerReverts() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signGrant(grant);
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(ExecutionModule.UnauthorizedExecutor.selector, attacker));
        module.execute(grant, data, signatures);
        assertEq(spentToken(), 0);
    }

    function test_CON001_CON011_CON021_signedExecutorNotAllowedBySafeReverts() public {
        address rogue = makeAddr("rogue");
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.executor = rogue;
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.UnauthorizedExecutor.selector, rogue));
    }

    function test_CON001_executorRemovedBySafeReverts() public {
        safeCall(address(module), abi.encodeCall(ExecutionModule.setExecutor, (executor, false)));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        execGrantExpectRevert(
            grant, data, abi.encodeWithSelector(ExecutionModule.UnauthorizedExecutor.selector, executor)
        );
    }

    function test_CON001_nonOwnerSignaturesRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signDigest(grantDigest(module, grant), keys(0xDEAD1, 0xDEAD2));
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, signatures);
    }

    function test_CON001_belowThresholdRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        uint256[] memory one = new uint256[](1);
        one[0] = KEY1;
        bytes memory signatures = signDigest(grantDigest(module, grant), one);
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, signatures);
    }

    function test_CON001_executorCannotManageExecutorsOrPause() public {
        vm.startPrank(executor);
        vm.expectRevert(ExecutionModule.AccountNotRegistered.selector);
        module.setExecutor(makeAddr("friend"), true);
        vm.expectRevert(ExecutionModule.AccountNotRegistered.selector);
        module.unpause();
        vm.expectRevert(ExecutionModule.AccountNotRegistered.selector);
        module.cancelNonce(1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ CON-002 / CON-012 / CON-022 duplicate grant

    function test_CON002_CON012_CON022_replaySameGrantReverts() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signGrant(grant);
        vm.prank(executor);
        module.execute(grant, data, signatures);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ExecutionModule.NonceAlreadyUsed.selector, 1));
        module.execute(grant, data, signatures);
        assertEq(spentToken(), 10e6);
        assertEq(token.balanceOf(recipient), 10e6);
    }

    function test_CON002_intentReuseWithFreshNonceReverts() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        execGrant(grant, data);
        grant.nonce = 2;
        execGrantExpectRevert(
            grant, data, abi.encodeWithSelector(ExecutionModule.IntentAlreadyExecuted.selector, grant.intentHash)
        );
    }

    function test_CON002_nonceReuseWithFreshIntentReverts() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        execGrant(grant, data);
        grant.intentHash = keccak256("another intent");
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.NonceAlreadyUsed.selector, 1));
    }

    function test_CON002_cancelledNonceCannotExecute() public {
        safeCall(address(module), abi.encodeCall(ExecutionModule.cancelNonce, (5)));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(5, 10e6);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.NonceAlreadyUsed.selector, 5));
    }

    function test_CON002_signatureCannotBeReplayedOnAnotherGroup() public {
        vm.prank(creator);
        (, address otherAccount) = factory.createGroup(owners(), THRESHOLD, keccak256("other"));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signGrant(grant);
        grant.account = otherAccount;
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, signatures);
    }

    function test_zeroIntentHashRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.intentHash = bytes32(0);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.InvalidIntent.selector));
    }

    // ------------------------------------------------------------------ CON-003 / CON-013 expired grant

    function test_CON003_CON013_expiredGrantRevertsAtExclusiveBoundary() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signGrant(grant);
        vm.warp(grant.validUntil);
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.GrantExpired.selector);
        module.execute(grant, data, signatures);

        vm.warp(grant.validUntil - 1);
        vm.prank(executor);
        module.execute(grant, data, signatures);
        assertEq(spentToken(), 10e6);
    }

    function test_CON003_notYetValidGrantReverts() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.validAfter = block.timestamp + 10;
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.GrantNotYetValid.selector));
    }

    function test_CON003_expiredMandateReverts() public {
        vm.warp(T0 + 30 days - 10);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signGrant(grant);
        vm.warp(T0 + 30 days);
        vm.prank(executor);
        vm.expectRevert(MandateRegistry.MandateOutsideWindow.selector);
        module.execute(grant, data, signatures);
    }

    // ------------------------------------------------------------------ wrong chain domain

    function test_wrongChainDomain_signatureForOtherChainRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        vm.chainId(1);
        bytes memory signatures = signDigest(grantDigest(module, grant), keys(KEY1, KEY2));
        vm.chainId(homeChainId);
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, signatures);
    }

    function test_wrongChainDomain_grantChainIdFieldMismatchRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.chainId = 1;
        execGrantExpectRevert(
            grant, data, abi.encodeWithSelector(ExecutionModule.WrongChain.selector, block.chainid, 1)
        );
    }

    function test_wrongChainDomain_chainSplitRecomputesDomain() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signGrant(grant);
        bytes32 before = module.domainSeparator();
        vm.chainId(424242);
        assertTrue(module.domainSeparator() != before);
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, signatures);
    }

    // ------------------------------------------------------------------ wrong module / group binding

    function test_wrongModule_grantSignedForOtherModuleDomainRejected() public {
        ExecutionModule other = new ExecutionModule(registry);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signDigest(grantDigest(other, grant), keys(KEY1, KEY2));
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, signatures);
    }

    function test_wrongModule_enabledButNotAuthorizedInRegistry() public {
        ExecutionModule other = new ExecutionModule(registry);
        safeCall(address(safe), abi.encodeCall(safe.enableModule, (address(other))));
        safeCall(address(other), abi.encodeCall(ExecutionModule.setExecutor, (executor, true)));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory signatures = signDigest(grantDigest(other, grant), keys(KEY1, KEY2));
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.ModuleNotAuthorized.selector);
        other.execute(grant, data, signatures);
    }

    function test_wrongModule_registryModuleSwitchedAwayRejected() public {
        safeCall(address(registry), abi.encodeCall(MandateRegistry.setModule, (address(0))));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.ModuleNotAuthorized.selector));
    }

    function test_wrongModule_disabledOnSafeRejected() public {
        safeCall(address(safe), abi.encodeCall(safe.disableModule, (SENTINEL, address(module))));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.ModuleNotEnabled.selector));
    }

    function test_groupIdMismatchRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.groupId = keccak256("someone else's group");
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.GroupMismatch.selector));
    }

    // ------------------------------------------------------------------ CON-005 / CON-015 target / selector

    function test_CON005_CON015_selectorOutsideAllowlistReverts() public {
        bytes memory data = abi.encodeWithSelector(bytes4(0x095ea7b3), recipient, 10e6);
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(1, 10e6);
        grant.selector = bytes4(0x095ea7b3);
        grant.calldataHash = keccak256(data);
        execGrantExpectRevert(
            grant, data, abi.encodeWithSelector(ExecutionModule.UnsupportedAction.selector, bytes4(0x095ea7b3))
        );
    }

    function test_CON005_CON015_allowlistedApproveStillUnsupported() public {
        MandateRegistry.MandateConfig memory config = defaultConfig();
        config.callSelectors[1] = bytes4(0x095ea7b3);
        config.callTargets[1] = address(token);
        supersede(2, config, true);
        bytes memory data = abi.encodeWithSelector(bytes4(0x095ea7b3), recipient, 10e6);
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(1, 10e6);
        grant.mandateVersion = 2;
        grant.selector = bytes4(0x095ea7b3);
        grant.calldataHash = keccak256(data);
        execGrantExpectRevert(
            grant, data, abi.encodeWithSelector(ExecutionModule.UnsupportedAction.selector, bytes4(0x095ea7b3))
        );
    }

    function test_CON005_CON015_targetOutsideAllowlistReverts() public {
        LocalTestToken other = new LocalTestToken();
        other.mint(address(safe), 1_000e6);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.target = address(other);
        grant.token = address(other);
        execGrantExpectRevert(
            grant,
            data,
            abi.encodeWithSelector(MandateRegistry.CallNotAllowed.selector, address(other), bytes4(0xa9059cbb))
        );
        assertEq(other.balanceOf(recipient), 0);
    }

    function test_CON005_nativeTargetOutsideAllowlistReverts() public {
        address stranger = makeAddr("stranger");
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = nativeGrant(1, 0.1 ether);
        grant.target = stranger;
        grant.recipient = stranger;
        execGrantExpectRevert(
            grant, data, abi.encodeWithSelector(MandateRegistry.CallNotAllowed.selector, stranger, bytes4(0))
        );
    }

    function test_CON005_selectorFieldMustMatchCalldata() public {
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(1, 10e6);
        bytes memory data = abi.encodeWithSelector(bytes4(0x095ea7b3), recipient, 10e6);
        grant.calldataHash = keccak256(data);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.SelectorMismatch.selector));
    }

    function test_calldataMustMatchSignedHash() public {
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(1, 10e6);
        bytes memory other = transferData(recipient, 11e6);
        execGrantExpectRevert(grant, other, abi.encodeWithSelector(ExecutionModule.CalldataMismatch.selector));
    }

    function test_protectedTargetsRejected() public {
        address[4] memory protectedTargets = [address(safe), address(module), address(registry), address(factory)];
        for (uint256 i; i < protectedTargets.length; ++i) {
            (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = nativeGrant(10 + i, 0.1 ether);
            grant.target = protectedTargets[i];
            execGrantExpectRevert(
                grant, data, abi.encodeWithSelector(ExecutionModule.ProtectedAddress.selector, protectedTargets[i])
            );
        }
    }

    // ------------------------------------------------------------------ recipient allowlist (audit fix)

    function test_recipientNotAllowlistedReverts() public {
        address stranger = makeAddr("stranger");
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(1, 10e6);
        bytes memory data = transferData(stranger, 10e6);
        grant.recipient = stranger;
        grant.calldataHash = keccak256(data);
        execGrantExpectRevert(
            grant, data, abi.encodeWithSelector(MandateRegistry.RecipientNotAllowed.selector, stranger)
        );
    }

    function test_recipientCannotStrandFundsInSynqContracts() public {
        address[4] memory sinks = [address(module), address(registry), address(factory), address(safe)];
        for (uint256 i; i < sinks.length; ++i) {
            (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(20 + i, 10e6);
            bytes memory data = transferData(sinks[i], 10e6);
            grant.recipient = sinks[i];
            grant.calldataHash = keccak256(data);
            execGrantExpectRevert(
                grant, data, abi.encodeWithSelector(ExecutionModule.ProtectedAddress.selector, sinks[i])
            );
        }
        (ExecutionModule.ExecutionGrant memory tokenSink,) = tokenGrant(30, 10e6);
        bytes memory toToken = transferData(address(token), 10e6);
        tokenSink.recipient = address(token);
        tokenSink.calldataHash = keccak256(toToken);
        execGrantExpectRevert(
            tokenSink, toToken, abi.encodeWithSelector(MandateRegistry.RecipientNotAllowed.selector, address(token))
        );
        assertEq(
            token.balanceOf(address(module)) + token.balanceOf(address(registry)) + token.balanceOf(address(token)), 0
        );
    }

    function test_recipientFieldMustMatchCalldata() public {
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(1, 10e6);
        bytes memory data = transferData(makeAddr("stranger"), 10e6);
        grant.calldataHash = keccak256(data);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.InvalidActionShape.selector));
    }

    function test_amountFieldMustMatchCalldata() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.maxInputAmount = 9e6;
        grant.minOutputAmount = 9e6;
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.InvalidActionShape.selector));
    }

    function test_minOutputAboveAmountRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.minOutputAmount = 10e6 + 1;
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.InvalidActionShape.selector));
    }

    function test_tokenActionCannotCarryNativeValue() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.nativeValue = 1;
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.InvalidActionShape.selector));
    }

    function test_dirtyRecipientBitsRejected() public {
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(1, 10e6);
        bytes memory data = abi.encodePacked(
            bytes4(0xa9059cbb), bytes32(uint256(uint160(recipient)) | (uint256(1) << 200)), uint256(10e6)
        );
        grant.calldataHash = keccak256(data);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.InvalidActionShape.selector));
    }

    // ------------------------------------------------------------------ CON-006 / CON-016 value cap (fuzz)

    function testFuzz_CON006_CON016_nativeValueCapExceededReverts(uint256 value) public {
        value = bound(value, MAX_NATIVE + 1, SAFE_NATIVE_FUNDING);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = nativeGrant(1, value);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(MandateRegistry.PerActionCapExceeded.selector));
        assertEq(address(safe).balance, SAFE_NATIVE_FUNDING);
    }

    function testFuzz_CON006_CON016_tokenAmountCapExceededReverts(uint256 amount) public {
        amount = bound(amount, MAX_TOKEN + 1, SAFE_TOKEN_FUNDING);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, amount);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(MandateRegistry.PerActionCapExceeded.selector));
        assertEq(token.balanceOf(address(safe)), SAFE_TOKEN_FUNDING);
    }

    function testFuzz_CON006_CON016_withinValueCapSucceeds(uint256 value) public {
        value = bound(value, 1, MAX_NATIVE);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = nativeGrant(1, value);
        execGrant(grant, data);
        assertEq(recipient.balance, value);
        assertEq(spentNative(), value);
    }

    // ------------------------------------------------------------------ cumulative cap

    function test_cumulativeTokenCapEnforced() public {
        uint256[3] memory amounts = [uint256(1_000e6), 1_000e6, 500e6];
        for (uint256 i; i < amounts.length; ++i) {
            (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(i + 1, amounts[i]);
            execGrant(grant, data);
        }
        assertEq(spentToken(), CUM_TOKEN);
        (ExecutionModule.ExecutionGrant memory over, bytes memory overData) = tokenGrant(9, 1);
        execGrantExpectRevert(over, overData, abi.encodeWithSelector(MandateRegistry.CumulativeCapExceeded.selector));
        assertEq(token.balanceOf(recipient), CUM_TOKEN);
    }

    function test_cumulativeNativeCapEnforced() public {
        for (uint256 i; i < 2; ++i) {
            (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = nativeGrant(i + 1, 1 ether);
            execGrant(grant, data);
        }
        (ExecutionModule.ExecutionGrant memory over, bytes memory overData) = nativeGrant(9, 0.5 ether + 1);
        execGrantExpectRevert(over, overData, abi.encodeWithSelector(MandateRegistry.CumulativeCapExceeded.selector));
        (ExecutionModule.ExecutionGrant memory exact, bytes memory exactData) = nativeGrant(10, 0.5 ether);
        execGrant(exact, exactData);
        assertEq(spentNative(), CUM_NATIVE);
    }

    function testFuzz_cumulativeCapNeverExceeded(uint256[6] memory amounts) public {
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 1, MAX_TOKEN);
            (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(i + 1, amount);
            if (total + amount > CUM_TOKEN) {
                execGrantExpectRevert(
                    grant, data, abi.encodeWithSelector(MandateRegistry.CumulativeCapExceeded.selector)
                );
            } else {
                execGrant(grant, data);
                total += amount;
            }
            assertLe(spentToken(), CUM_TOKEN);
            assertEq(spentToken(), total);
        }
    }

    // ------------------------------------------------------------------ CON-007 / CON-017 pause

    function test_CON007_CON017_pauseBlocksDelegatedExecution() public {
        safeCall(address(module), abi.encodeCall(ExecutionModule.pause, ()));
        assertTrue(module.paused(address(safe)));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        execGrantExpectRevert(
            grant, data, abi.encodeWithSelector(ExecutionModule.ExecutionPaused.selector, address(safe))
        );
        safeCall(address(module), abi.encodeCall(ExecutionModule.unpause, ()));
        execGrant(grant, data);
        assertEq(spentToken(), 10e6);
    }

    function test_CON007_pauseStateTransitionsAreStrict() public {
        vm.startPrank(address(safe));
        module.pause();
        vm.expectRevert(ExecutionModule.AlreadyPaused.selector);
        module.pause();
        module.unpause();
        vm.expectRevert(ExecutionModule.NotPaused.selector);
        module.unpause();
        vm.stopPrank();
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(ExecutionModule.AccountNotRegistered.selector);
        module.pause();
    }

    // ------------------------------------------------------------------ CON-010 / CON-020 reentrancy

    function test_CON010_CON020_nativeRecipientReentryHasNoDoubleEffect() public {
        ReentrantRecipient attacker = new ReentrantRecipient();
        configureSecondMandate(address(0), address(attacker), bytes4(0), address(attacker));
        (ExecutionModule.ExecutionGrant memory first, bytes memory data) = nativeGrant(1, 0.1 ether);
        first.mandateId = MANDATE2;
        first.target = address(attacker);
        first.recipient = address(attacker);
        (ExecutionModule.ExecutionGrant memory second,) = nativeGrant(2, 0.1 ether);
        second.mandateId = MANDATE2;
        second.target = address(attacker);
        second.recipient = address(attacker);
        second.executor = address(attacker);
        safeCall(address(module), abi.encodeCall(ExecutionModule.setExecutor, (address(attacker), true)));
        attacker.arm(module, second, data, signGrant(second));

        execGrantExpectRevert(first, data, abi.encodeWithSelector(ExecutionModule.ExecutionFailed.selector));
        assertEq(address(attacker).balance, 0);
        assertEq(registry.mandateState(address(safe), MANDATE2).spentNative, 0);
        assertFalse(module.nonceUsed(address(safe), 1));
        assertFalse(module.nonceUsed(address(safe), 2));
    }

    function test_CON010_CON020_tokenHookReentryBlocked() public {
        HookToken hook = new HookToken();
        hook.mint(address(safe), 1_000e6);
        configureSecondMandate(address(hook), address(hook), bytes4(0xa9059cbb), recipient);
        (ExecutionModule.ExecutionGrant memory first, bytes memory data) = tokenGrant(1, 100e6);
        first.mandateId = MANDATE2;
        first.target = address(hook);
        first.token = address(hook);
        (ExecutionModule.ExecutionGrant memory second, bytes memory data2) = tokenGrant(2, 100e6);
        second.mandateId = MANDATE2;
        second.target = address(hook);
        second.token = address(hook);
        second.executor = address(hook);
        safeCall(address(module), abi.encodeCall(ExecutionModule.setExecutor, (address(hook), true)));
        hook.arm(module, second, data2, signGrant(second));

        execGrant(first, data);
        assertFalse(hook.reentrySucceeded());
        assertEq(hook.balanceOf(recipient), 100e6);
        assertEq(registry.mandateState(address(safe), MANDATE2).spentToken, 100e6);
        assertFalse(module.nonceUsed(address(safe), 2));
    }

    // ------------------------------------------------------------------ balance-delta verification

    function test_feeOnTransferTokenRejected() public {
        _misbehavingTokenRejected(1, false, 0);
    }

    function test_falseReturnWithoutEffectRejected() public {
        _misbehavingTokenRejected(0, true, 0);
    }

    function test_excessDebitTokenRejected() public {
        _misbehavingTokenRejected(0, false, 1);
    }

    function _misbehavingTokenRejected(uint256 fee, bool returnFalse, uint256 extraDebit) internal {
        MisbehavingToken bad = new MisbehavingToken();
        bad.mint(address(safe), 1_000e6);
        bad.setModes(fee, returnFalse, extraDebit);
        configureSecondMandate(address(bad), address(bad), bytes4(0xa9059cbb), recipient);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 100e6);
        grant.mandateId = MANDATE2;
        grant.target = address(bad);
        grant.token = address(bad);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.BalanceDeltaMismatch.selector));
        assertEq(registry.mandateState(address(safe), MANDATE2).spentToken, 0);
    }

    function test_rejectingNativeRecipientRollsBackAuthority() public {
        RejectingRecipient sink = new RejectingRecipient();
        configureSecondMandate(address(0), address(sink), bytes4(0), address(sink));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = nativeGrant(1, 0.1 ether);
        grant.mandateId = MANDATE2;
        grant.target = address(sink);
        grant.recipient = address(sink);
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(ExecutionModule.ExecutionFailed.selector));
        assertFalse(module.nonceUsed(address(safe), 1));
        assertFalse(module.intentUsed(address(safe), grant.intentHash));
    }

    // ------------------------------------------------------------------ revocation and supersession

    function test_revokedMandateCannotExecute() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        safeCall(address(registry), abi.encodeCall(MandateRegistry.revokeMandate, (MANDATE)));
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(MandateRegistry.MandateNotActive.selector, MANDATE));
    }

    function test_supersession_securitySensitiveInvalidatesPriorVersionGrants() public {
        (ExecutionModule.ExecutionGrant memory v1Grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory v1Signatures = signGrant(v1Grant);
        supersede(2, defaultConfig(), true);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.MandateVersionNotValid.selector, 1));
        module.execute(v1Grant, data, v1Signatures);

        (ExecutionModule.ExecutionGrant memory v2Grant, bytes memory data2) = tokenGrant(2, 10e6);
        v2Grant.mandateVersion = 2;
        execGrant(v2Grant, data2);
        assertEq(spentToken(), 10e6);
    }

    function test_supersession_nonSensitiveCapReductionRejected() public {
        MandateRegistry.MandateConfig memory tighter = defaultConfig();
        tighter.cumulativeTokenCap = 500e6;
        vm.prank(address(safe));
        vm.expectRevert(MandateRegistry.NarrowingSupersessionMustInvalidate.selector);
        registry.supersedeMandate(MANDATE, 2, tighter, false);
        (ExecutionModule.ExecutionGrant memory small, bytes memory smallData) = tokenGrant(2, 600e6);
        execGrant(small, smallData);
        assertEq(spentToken(), 600e6);
    }

    function test_supersession_tokenCapBelowSpendDoesNotBlockNativeDimension() public {
        (ExecutionModule.ExecutionGrant memory spend, bytes memory spendData) = tokenGrant(1, 100e6);
        execGrant(spend, spendData);
        MandateRegistry.MandateConfig memory lowered = defaultConfig();
        lowered.cumulativeTokenCap = 50e6;
        supersede(2, lowered, true);
        (ExecutionModule.ExecutionGrant memory native, bytes memory nativeData) = nativeGrant(2, 0.3 ether);
        native.mandateVersion = 2;
        execGrant(native, nativeData);
        assertEq(spentNative(), 0.3 ether);
        (ExecutionModule.ExecutionGrant memory more, bytes memory moreData) = tokenGrant(3, 1);
        more.mandateVersion = 2;
        execGrantExpectRevert(more, moreData, abi.encodeWithSelector(MandateRegistry.CumulativeCapExceeded.selector));
    }

    function test_supersession_futureVersionGrantRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        grant.mandateVersion = 2;
        execGrantExpectRevert(grant, data, abi.encodeWithSelector(MandateRegistry.MandateVersionNotValid.selector, 2));
    }

    // ------------------------------------------------------------------ spend accounting lives in the registry

    function test_secondModuleCannotResetCumulativeCap() public {
        (ExecutionModule.ExecutionGrant memory g1, bytes memory d1) = tokenGrant(1, 1_000e6);
        execGrant(g1, d1);
        (ExecutionModule.ExecutionGrant memory g2, bytes memory d2) = tokenGrant(2, 1_000e6);
        execGrant(g2, d2);

        ExecutionModule replacement = new ExecutionModule(registry);
        safeCall(address(safe), abi.encodeCall(safe.enableModule, (address(replacement))));
        safeCall(address(registry), abi.encodeCall(MandateRegistry.setModule, (address(replacement))));
        safeCall(address(replacement), abi.encodeCall(ExecutionModule.setExecutor, (executor, true)));
        assertEq(spentToken(), 2_000e6);

        (ExecutionModule.ExecutionGrant memory g3, bytes memory d3) = tokenGrant(1, 1_000e6);
        bytes memory s3 = signDigest(grantDigest(replacement, g3), keys(KEY1, KEY2));
        vm.prank(executor);
        vm.expectRevert(MandateRegistry.CumulativeCapExceeded.selector);
        replacement.execute(g3, d3, s3);

        (ExecutionModule.ExecutionGrant memory g4, bytes memory d4) = tokenGrant(4, 500e6);
        bytes memory s4 = signDigest(grantDigest(replacement, g4), keys(KEY1, KEY2));
        vm.prank(executor);
        replacement.execute(g4, d4, s4);
        assertEq(spentToken(), CUM_TOKEN);

        (ExecutionModule.ExecutionGrant memory g5, bytes memory d5) = tokenGrant(5, 1e6);
        execGrantExpectRevert(g5, d5, abi.encodeWithSelector(ExecutionModule.ModuleNotAuthorized.selector));
    }

    function test_onlyAuthorizedModuleRecordsSpend() public {
        MandateRegistry.SpendRequest memory request = MandateRegistry.SpendRequest({
            target: address(token),
            selector: bytes4(0xa9059cbb),
            recipient: recipient,
            token: address(token),
            tokenAmount: 1,
            nativeAmount: 0
        });
        address rogue = makeAddr("rogue");
        vm.prank(rogue);
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.UnauthorizedModule.selector, rogue));
        registry.authorizeSpend(address(safe), MANDATE, 1, request);
        vm.prank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(MandateRegistry.UnauthorizedModule.selector, address(safe)));
        registry.authorizeSpend(address(safe), MANDATE, 1, request);
    }
}
