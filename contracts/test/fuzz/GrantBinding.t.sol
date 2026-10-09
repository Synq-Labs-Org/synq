// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SynqTestBase} from "../utils/SynqTestBase.sol";
import {ExecutionModule} from "../../src/ExecutionModule.sol";

/// @notice Every signed grant field is bound: mutating any field after signing fails at the signature check itself.
contract GrantBindingFuzzTest is SynqTestBase {
    ExecutionModule.ExecutionGrant internal signedGrant;
    bytes internal signedData;
    bytes internal signedSignatures;

    function setUp() public override {
        super.setUp();
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = tokenGrant(1, 100e6);
        signedGrant = grant;
        signedData = data;
        signedSignatures = signGrant(grant);
    }

    function _expectSignatureFailure(ExecutionModule.ExecutionGrant memory mutated) internal {
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(mutated, signedData, signedSignatures);
        assertEq(spentToken(), 0);
        assertEq(token.balanceOf(recipient), 0);
    }

    function _base() internal view returns (ExecutionModule.ExecutionGrant memory) {
        return signedGrant;
    }

    function test_unmutatedGrantExecutes() public {
        vm.prank(executor);
        module.execute(signedGrant, signedData, signedSignatures);
        assertEq(token.balanceOf(recipient), 100e6);
    }

    function testFuzz_bound_groupId(bytes32 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.groupId);
        g.groupId = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_account(address value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.account);
        g.account = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_mandateId(bytes32 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.mandateId);
        g.mandateId = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_mandateVersion(uint256 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.mandateVersion);
        g.mandateVersion = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_executor(address value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.executor);
        g.executor = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_pluginId(bytes32 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.pluginId);
        g.pluginId = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_chainId(uint256 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.chainId);
        g.chainId = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_target(address value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.target);
        g.target = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_selector(bytes4 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.selector);
        g.selector = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_calldataHash(bytes32 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.calldataHash);
        g.calldataHash = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_token(address value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.token);
        g.token = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_maxInputAmount(uint256 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.maxInputAmount);
        g.maxInputAmount = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_nativeValue(uint256 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.nativeValue);
        g.nativeValue = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_minOutputAmount(uint256 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.minOutputAmount);
        g.minOutputAmount = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_recipient(address value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.recipient);
        g.recipient = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_validAfter(uint256 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.validAfter);
        g.validAfter = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_validUntil(uint256 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.validUntil);
        g.validUntil = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_nonce(uint256 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.nonce);
        g.nonce = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_intentHash(bytes32 value) public {
        ExecutionModule.ExecutionGrant memory g = _base();
        vm.assume(value != g.intentHash);
        g.intentHash = value;
        _expectSignatureFailure(g);
    }

    function testFuzz_bound_signatureBytes(uint256 position, uint8 delta) public {
        vm.assume(delta != 0);
        bytes memory signatures = signedSignatures;
        position = bound(position, 0, signatures.length - 1);
        signatures[position] = bytes1(uint8(signatures[position]) ^ delta);
        vm.prank(executor);
        (bool ok, bytes memory err) =
            address(module).call(abi.encodeCall(ExecutionModule.execute, (signedGrant, signedData, signatures)));
        assertFalse(ok);
        bytes4 selector = bytes4(err);
        assertTrue(
            selector == ExecutionModule.InvalidSignatures.selector
                || selector == ExecutionModule.MalleableSignature.selector,
            "signature-specific error"
        );
        assertEq(spentToken(), 0);
    }

    function testFuzz_arbitraryCalldataUnderOwnerSignatureCannotEscapeEnvelope(
        bytes calldata raw,
        bytes4 rawSelector,
        uint8 shape,
        uint8 targetChoice,
        uint8 selectorChoice,
        uint8 toChoice,
        uint256 amount
    ) public {
        address[4] memory targets = [address(token), recipient, makeAddr("elsewhere"), address(safe)];
        address[6] memory payees =
            [recipient, makeAddr("stranger"), address(module), address(registry), address(token), address(safe)];
        bytes4[3] memory selectors = [bytes4(0xa9059cbb), bytes4(0x095ea7b3), bytes4(0x23b872dd)];
        address target = targets[targetChoice % 4];
        address to = payees[toChoice % 6];
        amount = bound(amount, 0, 2 * MAX_TOKEN);
        bytes4 selector;
        bytes memory data;
        if (shape % 2 == 0) {
            selector = rawSelector;
            data = raw;
        } else {
            selector = selectors[selectorChoice % 3];
            data = abi.encodeWithSelector(selector, to, amount);
        }
        (ExecutionModule.ExecutionGrant memory grant,) = tokenGrant(9, amount);
        grant.target = target;
        grant.selector = selector;
        grant.calldataHash = keccak256(data);
        bool expected = shape % 2 == 1 && target == address(token) && selector == bytes4(0xa9059cbb) && to == recipient
            && amount > 0 && amount <= MAX_TOKEN;
        bytes memory signatures = signGrant(grant);
        uint256 safeBefore = token.balanceOf(address(safe));
        vm.prank(executor);
        try module.execute(grant, data, signatures) {
            assertTrue(expected, "unexpected success");
            assertEq(token.balanceOf(address(safe)), safeBefore - amount);
            assertEq(token.balanceOf(recipient), amount);
            assertEq(spentToken(), amount);
        } catch {
            assertFalse(expected, "valid transfer rejected");
            assertEq(token.balanceOf(address(safe)), safeBefore);
            assertEq(spentToken(), 0);
            assertFalse(module.nonceUsed(address(safe), 9));
        }
    }

    function testFuzz_unsignedCalldataRejected(bytes calldata data) public {
        vm.assume(keccak256(data) != signedGrant.calldataHash);
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.CalldataMismatch.selector);
        module.execute(signedGrant, data, signedSignatures);
    }

    function testFuzz_randomSignaturesNeverAuthorize(bytes calldata signatures) public {
        vm.prank(executor);
        (bool ok, bytes memory err) =
            address(module).call(abi.encodeCall(ExecutionModule.execute, (signedGrant, signedData, signatures)));
        assertFalse(ok);
        bytes4 selector = bytes4(err);
        assertTrue(
            selector == ExecutionModule.InvalidSignatures.selector
                || selector == ExecutionModule.MalleableSignature.selector
        );
    }
}
