// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SynqTestBase} from "../utils/SynqTestBase.sol";
import {ExecutionModule} from "../../src/ExecutionModule.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {ISafeFull, ICompatibilityFallbackHandler} from "../utils/ISafeFull.sol";

/// @notice Safe-native signature paths for grants and CON-009/CON-019 malformed-signature cases.
contract SignaturesTest is SynqTestBase {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant NESTED_OWNER_KEY = 0xD00D;

    function _exec(ExecutionModule.ExecutionGrant memory grant, bytes memory data, bytes memory signatures) internal {
        vm.prank(executor);
        module.execute(grant, data, signatures);
    }

    function _expectInvalid(ExecutionModule.ExecutionGrant memory grant, bytes memory data, bytes memory signatures)
        internal
    {
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, signatures);
        assertEq(spentToken(), 0);
    }

    // ------------------------------------------------------------------ accepted Safe-native paths

    function test_ethSignPathAccepted() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes32 digest = grantDigest(module, grant);
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        uint256[] memory sorted = sortKeys(keys(KEY1, KEY2));
        bytes memory signatures;
        for (uint256 i; i < 2; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(sorted[i], prefixed);
            signatures = abi.encodePacked(signatures, r, s, v + 4);
        }
        _exec(grant, data, signatures);
        assertEq(spentToken(), 10e6);
    }

    function test_approvedHashPathAccepted() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes32 digest = module.hashGrant(grant);
        uint256[] memory sorted = sortKeys(keys(KEY1, KEY3));
        bytes memory signatures;
        for (uint256 i; i < 2; ++i) {
            address owner = vm.addr(sorted[i]);
            vm.prank(owner);
            safe.approveHash(digest);
            signatures = abi.encodePacked(signatures, bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
        }
        _exec(grant, data, signatures);
        assertEq(spentToken(), 10e6);
    }

    function test_approvedHashWithoutOnchainApprovalRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        uint256[] memory sorted = sortKeys(keys(KEY1, KEY3));
        bytes memory signatures;
        for (uint256 i; i < 2; ++i) {
            signatures =
                abi.encodePacked(signatures, bytes32(uint256(uint160(vm.addr(sorted[i])))), bytes32(0), uint8(1));
        }
        _expectInvalid(grant, data, signatures);
    }

    function test_contractOwnerErc1271PathAccepted() public {
        (ISafeFull group, address nested) = _groupWithNestedSafeOwner();
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _grantFor(group);
        bytes memory signatures = _nestedSignatures(grant, nested, NESTED_OWNER_KEY);
        vm.prank(executor);
        module.execute(grant, data, signatures);
        assertEq(token.balanceOf(recipient), 10e6);
    }

    function test_contractOwnerSignatureByWrongInnerKeyRejected() public {
        (ISafeFull group, address nested) = _groupWithNestedSafeOwner();
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _grantFor(group);
        bytes memory signatures = _nestedSignatures(grant, nested, 0xBADBAD);
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, signatures);
    }

    // ------------------------------------------------------------------ CON-009 / CON-019 malformed signatures

    function test_CON009_CON019_trueMalleabilityRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes32 digest = grantDigest(module, grant);
        uint256[] memory sorted = sortKeys(keys(KEY1, KEY2));
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(sorted[0], digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(sorted[1], digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s1));
        uint8 flippedV = v1 == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r1, highS), vm.addr(sorted[1]), "malleated signature recovers same owner");
        bytes memory signatures = abi.encodePacked(r0, s0, v0, r1, highS, flippedV);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ExecutionModule.MalleableSignature.selector, 1));
        module.execute(grant, data, signatures);
        assertEq(spentToken(), 0);
    }

    function test_CON009_CON019_malleatedEthSignRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", grantDigest(module, grant)));
        uint256[] memory sorted = sortKeys(keys(KEY1, KEY2));
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(sorted[0], prefixed);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(sorted[1], prefixed);
        bytes memory signatures =
            abi.encodePacked(r0, bytes32(SECP256K1_N - uint256(s0)), (v0 == 27 ? 28 : 27) + 4, r1, s1, v1 + 4);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ExecutionModule.MalleableSignature.selector, 0));
        module.execute(grant, data, signatures);
    }

    function test_CON009_CON019_wrongLengthRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory valid = signGrant(grant);
        bytes memory truncated = new bytes(valid.length - 1);
        for (uint256 i; i < truncated.length; ++i) {
            truncated[i] = valid[i];
        }
        _expectInvalid(grant, data, truncated);
        _expectInvalid(grant, data, "");
        _expectInvalid(grant, data, new bytes(64));
    }

    function test_CON009_CON019_wrongVRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        uint8[4] memory badVs = [uint8(26), 29, 30, 2];
        for (uint256 k; k < badVs.length; ++k) {
            bytes memory signatures = signGrant(grant);
            signatures[64] = bytes1(badVs[k]);
            _expectInvalid(grant, data, signatures);
        }
    }

    function test_CON009_CON019_unsortedOwnersRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes32 digest = grantDigest(module, grant);
        uint256[] memory sorted = sortKeys(keys(KEY1, KEY2));
        (uint8 v0, bytes32 r0, bytes32 s0) = vm.sign(sorted[0], digest);
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(sorted[1], digest);
        _expectInvalid(grant, data, abi.encodePacked(r1, s1, v1, r0, s0, v0));
    }

    function test_CON009_CON019_duplicateOwnerRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY1, grantDigest(module, grant));
        _expectInvalid(grant, data, abi.encodePacked(r, s, v, r, s, v));
    }

    function test_CON009_CON019_contractSignaturePointerOutOfBoundsRejected() public {
        (ISafeFull group, address nested) = _groupWithNestedSafeOwner();
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _grantFor(group);
        bytes memory signatures = _nestedSignatures(grant, nested, NESTED_OWNER_KEY);
        uint256 nestedIndex = nested < vm.addr(KEY1) ? 0 : 1;
        bytes32 badPointer = bytes32(uint256(10_000));
        for (uint256 i; i < 32; ++i) {
            signatures[nestedIndex * 65 + 32 + i] = badPointer[i];
        }
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, signatures);
    }

    function test_CON009_CON019_garbageSignatureBytesRejected() public {
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        bytes memory garbage = new bytes(130);
        for (uint256 i; i < garbage.length; ++i) {
            garbage[i] = bytes1(uint8(i * 7 + 3));
        }
        garbage[32] = 0x00;
        garbage[97] = 0x00;
        garbage[64] = bytes1(uint8(27));
        garbage[129] = bytes1(uint8(28));
        _expectInvalid(grant, data, garbage);
    }

    function test_raisedThresholdRequiresMoreSignatures() public {
        safeCall(address(safe), abi.encodeCall(safe.changeThreshold, (3)));
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 10e6);
        _expectInvalid(grant, data, signGrant(grant));
        uint256[] memory all = new uint256[](3);
        all[0] = KEY1;
        all[1] = KEY2;
        all[2] = KEY3;
        _exec(grant, data, signDigest(grantDigest(module, grant), all));
        assertEq(spentToken(), 10e6);
    }

    // ------------------------------------------------------------------ helpers

    function _groupWithNestedSafeOwner() internal returns (ISafeFull group, address nested) {
        address[] memory nestedOwners = new address[](1);
        nestedOwners[0] = vm.addr(NESTED_OWNER_KEY);
        (, nested) = factory.createGroup(nestedOwners, 1, keccak256("nested"));
        address[] memory groupOwners = new address[](3);
        groupOwners[0] = nested;
        groupOwners[1] = vm.addr(KEY1);
        groupOwners[2] = vm.addr(KEY2);
        (, address account) = factory.createGroup(groupOwners, 2, keccak256("with-contract-owner"));
        group = ISafeFull(account);
        token.mint(account, 1_000e6);
        uint256[] memory signers = keys(KEY1, KEY2);
        assertTrue(
            safeExecWith(
                group, address(module), 0, abi.encodeCall(ExecutionModule.setExecutor, (executor, true)), 0, signers
            )
        );
        assertTrue(
            safeExecWith(
                group,
                address(registry),
                0,
                abi.encodeCall(MandateRegistry.configureMandate, (MANDATE, defaultConfig())),
                0,
                signers
            )
        );
    }

    function _grantFor(ISafeFull group)
        internal
        view
        returns (ExecutionModule.ExecutionGrant memory grant, bytes memory data)
    {
        (grant, data) = tokenGrant(1, 10e6);
        grant.account = address(group);
        grant.groupId = registry.groupOf(address(group));
    }

    function _nestedSignatures(ExecutionModule.ExecutionGrant memory grant, address nested, uint256 innerKey)
        internal
        view
        returns (bytes memory)
    {
        bytes memory preimage =
            abi.encodePacked(bytes2(0x1901), module.domainSeparator(), module.grantStructHash(grant));
        assertEq(keccak256(preimage), module.hashGrant(grant));
        bytes32 messageHash = ICompatibilityFallbackHandler(fallbackHandler).getMessageHashForSafe(nested, preimage);
        (uint8 vi, bytes32 ri, bytes32 si) = vm.sign(innerKey, messageHash);
        bytes memory inner = abi.encodePacked(ri, si, vi);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY1, module.hashGrant(grant));
        bytes memory contractPart = abi.encodePacked(bytes32(uint256(uint160(nested))), bytes32(uint256(130)), uint8(0));
        bytes memory ecdsaPart = abi.encodePacked(r, s, v);
        bytes memory head = nested < vm.addr(KEY1)
            ? abi.encodePacked(contractPart, ecdsaPart)
            : abi.encodePacked(ecdsaPart, contractPart);
        return abi.encodePacked(head, uint256(inner.length), inner);
    }
}
