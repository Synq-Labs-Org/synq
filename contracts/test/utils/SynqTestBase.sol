// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SynqGroupFactory} from "../../src/SynqGroupFactory.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {ExecutionModule} from "../../src/ExecutionModule.sol";
import {LocalTestToken} from "../../src/test/LocalTestToken.sol";
import {ISafeFull} from "./ISafeFull.sol";

/// @notice Shared fixture: Safe v1.4.1 from vendored source, a 2-of-3 Synq group, a token mandate and an executor.
abstract contract SynqTestBase is Test {
    uint256 internal constant KEY1 = 0xA11CE;
    uint256 internal constant KEY2 = 0xB0B;
    uint256 internal constant KEY3 = 0xCA401;
    uint256 internal constant THRESHOLD = 2;
    bytes32 internal constant MANDATE = keccak256("synq.mandate.transfers");
    bytes32 internal constant PLUGIN = keccak256("synq.plugin.transfer");
    bytes32 internal constant SALT = keccak256("synq.group.salt");
    uint256 internal constant T0 = 1_760_000_000;

    uint256 internal constant MAX_TOKEN = 1_000e6;
    uint256 internal constant MAX_NATIVE = 1 ether;
    uint256 internal constant CUM_TOKEN = 2_500e6;
    uint256 internal constant CUM_NATIVE = 2.5 ether;
    uint256 internal constant SAFE_TOKEN_FUNDING = 1_000_000e6;
    uint256 internal constant SAFE_NATIVE_FUNDING = 100 ether;

    address internal safeSingleton;
    address internal safeProxyFactory;
    address internal fallbackHandler;
    address internal multiSendCallOnly;
    SynqGroupFactory internal factory;
    MandateRegistry internal registry;
    ExecutionModule internal module;
    ISafeFull internal safe;
    bytes32 internal groupId;
    LocalTestToken internal token;

    uint256 internal homeChainId;
    address internal executor = makeAddr("executor");
    address internal recipient = makeAddr("recipient");
    address internal creator = makeAddr("creator");

    function setUp() public virtual {
        vm.warp(T0);
        homeChainId = block.chainid;
        safeSingleton = deployCode("out/SafeL2.sol/SafeL2.json");
        safeProxyFactory = deployCode("out/SafeProxyFactory.sol/SafeProxyFactory.json");
        fallbackHandler = deployCode("out/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json");
        multiSendCallOnly = deployCode("out/MultiSendCallOnly.sol/MultiSendCallOnly.json");
        factory = new SynqGroupFactory(safeSingleton, safeProxyFactory, fallbackHandler);
        registry = factory.registry();
        module = factory.module();
        address account;
        vm.prank(creator);
        (groupId, account) = factory.createGroup(owners(), THRESHOLD, SALT);
        safe = ISafeFull(account);
        token = new LocalTestToken();
        token.mint(account, SAFE_TOKEN_FUNDING);
        vm.deal(account, SAFE_NATIVE_FUNDING);
        safeCall(address(module), abi.encodeCall(ExecutionModule.setExecutor, (executor, true)));
        safeCall(address(registry), abi.encodeCall(MandateRegistry.configureMandate, (MANDATE, defaultConfig())));
    }

    function owners() internal pure returns (address[] memory list) {
        list = new address[](3);
        list[0] = vm.addr(KEY1);
        list[1] = vm.addr(KEY2);
        list[2] = vm.addr(KEY3);
    }

    function keys(uint256 a, uint256 b) internal pure returns (uint256[] memory list) {
        list = new uint256[](2);
        list[0] = a;
        list[1] = b;
    }

    function defaultConfig() internal view returns (MandateRegistry.MandateConfig memory config) {
        address[] memory targets = new address[](2);
        bytes4[] memory selectors = new bytes4[](2);
        targets[0] = address(token);
        selectors[0] = bytes4(0xa9059cbb);
        targets[1] = recipient;
        selectors[1] = bytes4(0);
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        config = MandateRegistry.MandateConfig({
            mandateHash: keccak256("mandate-document-v1"),
            token: address(token),
            maxTokenPerAction: MAX_TOKEN,
            maxNativePerAction: MAX_NATIVE,
            cumulativeTokenCap: CUM_TOKEN,
            cumulativeNativeCap: CUM_NATIVE,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 30 days,
            callTargets: targets,
            callSelectors: selectors,
            recipients: recipients
        });
    }

    // ---------------------------------------------------------------- Safe owner transactions

    function signDigest(bytes32 digest, uint256[] memory signerKeys) internal pure returns (bytes memory signatures) {
        uint256[] memory sorted = sortKeys(signerKeys);
        for (uint256 i; i < sorted.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(sorted[i], digest);
            signatures = abi.encodePacked(signatures, r, s, v);
        }
    }

    function sortKeys(uint256[] memory input) internal pure returns (uint256[] memory sorted) {
        sorted = new uint256[](input.length);
        for (uint256 i; i < input.length; ++i) {
            sorted[i] = input[i];
        }
        for (uint256 i = 1; i < sorted.length; ++i) {
            uint256 current = sorted[i];
            uint256 j = i;
            while (j > 0 && vm.addr(sorted[j - 1]) > vm.addr(current)) {
                sorted[j] = sorted[j - 1];
                --j;
            }
            sorted[j] = current;
        }
    }

    function safeTxHash(ISafeFull account, address to, uint256 value, bytes memory data, uint8 operation)
        internal
        view
        returns (bytes32)
    {
        return account.getTransactionHash(to, value, data, operation, 0, 0, 0, address(0), address(0), account.nonce());
    }

    function safeExecWith(
        ISafeFull account,
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation,
        uint256[] memory signerKeys
    ) internal returns (bool) {
        bytes memory signatures = signDigest(safeTxHash(account, to, value, data, operation), signerKeys);
        return account.execTransaction(to, value, data, operation, 0, 0, 0, address(0), payable(address(0)), signatures);
    }

    function safeCall(address to, bytes memory data) internal {
        assertTrue(safeExecWith(safe, to, 0, data, 0, keys(KEY1, KEY2)), "safe call");
    }

    // ---------------------------------------------------------------- Grants

    function transferData(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount);
    }

    function tokenGrant(uint256 nonce, uint256 amount)
        internal
        view
        returns (ExecutionModule.ExecutionGrant memory grant, bytes memory data)
    {
        data = transferData(recipient, amount);
        grant = ExecutionModule.ExecutionGrant({
            groupId: groupId,
            account: address(safe),
            mandateId: MANDATE,
            mandateVersion: 1,
            executor: executor,
            pluginId: PLUGIN,
            chainId: block.chainid,
            target: address(token),
            selector: bytes4(0xa9059cbb),
            calldataHash: keccak256(data),
            token: address(token),
            maxInputAmount: amount,
            nativeValue: 0,
            minOutputAmount: amount,
            recipient: recipient,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 1 hours,
            nonce: nonce,
            intentHash: keccak256(abi.encode("intent", nonce))
        });
    }

    function nativeGrant(uint256 nonce, uint256 value)
        internal
        view
        returns (ExecutionModule.ExecutionGrant memory grant, bytes memory data)
    {
        data = "";
        grant = ExecutionModule.ExecutionGrant({
            groupId: groupId,
            account: address(safe),
            mandateId: MANDATE,
            mandateVersion: 1,
            executor: executor,
            pluginId: PLUGIN,
            chainId: block.chainid,
            target: recipient,
            selector: bytes4(0),
            calldataHash: keccak256(data),
            token: address(0),
            maxInputAmount: 0,
            nativeValue: value,
            minOutputAmount: value,
            recipient: recipient,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 1 hours,
            nonce: nonce,
            intentHash: keccak256(abi.encode("native-intent", nonce))
        });
    }

    function grantDigest(ExecutionModule target, ExecutionModule.ExecutionGrant memory grant)
        internal
        view
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("SynqExecutionModule"),
                keccak256("1"),
                block.chainid,
                address(target)
            )
        );
        bytes32 typeHash = keccak256(
            "ExecutionGrant(bytes32 groupId,address account,bytes32 mandateId,uint256 mandateVersion,address executor,bytes32 pluginId,uint256 chainId,address target,bytes4 selector,bytes32 calldataHash,address token,uint256 maxInputAmount,uint256 nativeValue,uint256 minOutputAmount,address recipient,uint256 validAfter,uint256 validUntil,uint256 nonce,bytes32 intentHash)"
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typeHash, grant))));
    }

    function signGrant(ExecutionModule.ExecutionGrant memory grant) internal view returns (bytes memory) {
        return signDigest(grantDigest(module, grant), keys(KEY1, KEY2));
    }

    function execGrant(ExecutionModule.ExecutionGrant memory grant, bytes memory data) internal returns (bytes32) {
        bytes memory signatures = signGrant(grant);
        vm.prank(grant.executor);
        return module.execute(grant, data, signatures);
    }

    function execGrantExpectRevert(ExecutionModule.ExecutionGrant memory grant, bytes memory data, bytes memory err)
        internal
    {
        bytes memory signatures = signGrant(grant);
        vm.prank(grant.executor);
        vm.expectRevert(err);
        module.execute(grant, data, signatures);
    }

    function spentToken() internal view returns (uint256) {
        return registry.mandateState(address(safe), MANDATE).spentToken;
    }

    function spentNative() internal view returns (uint256) {
        return registry.mandateState(address(safe), MANDATE).spentNative;
    }
}
