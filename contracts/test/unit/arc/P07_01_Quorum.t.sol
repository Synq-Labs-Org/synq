// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase} from "./ArcVaultBase.sol";

/// @notice P07-01: below quorum cannot withdraw.
contract P07_01_QuorumTest is ArcVaultBase {
    function test_P07_01_twoOfThreeWithdrawSucceeds() public {
        uint256 before = token.balanceOf(stranger);
        assertTrue(exec(address(token), 0, transferData(stranger, 500e6), CALL, keys(KEY1, KEY3)));
        assertEq(token.balanceOf(stranger) - before, 500e6);
        assertEq(token.balanceOf(address(safe)), FUNDING - 500e6);
        assertEq(safe.nonce(), 1);
    }

    function test_P07_01_singleOwnerCannotWithdrawToken() public {
        for (uint256 k = 1; k <= 3; ++k) {
            uint256 key = k == 1 ? KEY1 : k == 2 ? KEY2 : KEY3;
            execExpectRevert(address(token), 0, transferData(stranger, 1e6), CALL, keys(key), bytes("GS020"));
        }
        assertEq(token.balanceOf(address(safe)), FUNDING);
        assertEq(safe.nonce(), 0);
    }

    function test_P07_01_singleOwnerCannotWithdrawNative() public {
        execExpectRevert(stranger, 1 ether, "", CALL, keys(KEY2), bytes("GS020"));
        assertEq(address(safe).balance, 10 ether);
    }

    function test_P07_01_sameOwnerTwiceIsNotQuorum() public {
        bytes32 digest = txHash(address(token), 0, transferData(stranger, 1e6), CALL);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY1, digest);
        bytes memory doubled = abi.encodePacked(r, s, v, r, s, v);
        vm.prank(stranger);
        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(
            address(token), 0, transferData(stranger, 1e6), CALL, 0, 0, 0, address(0), payable(address(0)), doubled
        );
    }

    function test_P07_01_operatorSignatureDoesNotCountTowardQuorum() public {
        execExpectRevert(address(token), 0, transferData(stranger, 1e6), CALL, keys(KEY1, OPERATOR_KEY), bytes("GS026"));
    }

    function test_P07_01_signaturesCannotBeReplayed() public {
        bytes memory data = transferData(stranger, 1e6);
        bytes memory signatures = signDigest(txHash(address(token), 0, data, CALL), keys(KEY1, KEY2));
        vm.prank(stranger);
        safe.execTransaction(address(token), 0, data, CALL, 0, 0, 0, address(0), payable(address(0)), signatures);
        vm.prank(stranger);
        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(address(token), 0, data, CALL, 0, 0, 0, address(0), payable(address(0)), signatures);
        assertEq(token.balanceOf(stranger), 1e6);
    }

    function test_P07_01_wrongChainSignatureRejected() public {
        bytes memory data = transferData(stranger, 1e6);
        bytes32 digest = txHash(address(token), 0, data, CALL);
        bytes memory signatures = signDigest(digest, keys(KEY1, KEY2));
        vm.chainId(block.chainid + 1);
        vm.prank(stranger);
        vm.expectRevert(bytes("GS026"));
        safe.execTransaction(address(token), 0, data, CALL, 0, 0, 0, address(0), payable(address(0)), signatures);
    }

    function testFuzz_P07_01_anySingleSignerCannotWithdraw(uint256 key, uint96 amount) public {
        key = bound(key, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        execExpectRevert(address(token), 0, transferData(stranger, amount), CALL, keys(key), bytes("GS020"));
        assertEq(token.balanceOf(address(safe)), FUNDING);
    }
}
