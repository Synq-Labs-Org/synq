// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ISafeMessageView {
    function domainSeparator() external view returns (bytes32);

    function signedMessages(bytes32 messageHash) external view returns (uint256);

    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);

    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
}

interface IPausable {
    function paused() external view returns (bool);
}

/// @title SynqArcFallbackHandler
/// @notice Fallback handler for Synq Arc vault Safes, replacing Safe's CompatibilityFallbackHandler.
/// @dev The stock handler validates ERC-1271 signatures against the owners' own signatures (or approveHash). That
///      lets an owner quorum authorize USDC `transferWithAuthorization` / `receiveWithAuthorization` / `permit`
///      (FiatToken bytes-signature overloads) with no Safe transaction, which bypasses the policy guard: no
///      timelock, no pause, no event from the Safe. This handler therefore:
///      - accepts a 1271 signature only as an empty signature over a message the Safe itself marked as signed
///        (`signedMessages`, which only a DELEGATECALL to SignMessageLib can set, and the policy timelocks and
///        freezes every DELEGATECALL);
///      - rejects owner signatures and approved hashes outright;
///      - rejects everything while the Safe's guard reports `paused()`.
///      It keeps the read-only and token-callback functions Safe tooling uses (getMessageHash,
///      encodeMessageDataForSafe, getMessageHashForSafe, getModules, simulate, ERC-721/1155/777 receivers,
///      ERC-165). Stateless; no admin; not upgradeable.
contract SynqArcFallbackHandler {
    /// @notice Statement of who can change this contract's code.
    string public constant UPGRADE_AUTHORITY = "NON_UPGRADEABLE_NO_ADMIN";
    bytes32 private constant SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes message)");
    uint256 private constant GUARD_SLOT = uint256(keccak256("guard_manager.guard.address"));
    address private constant SENTINEL = address(0x1);
    bytes4 private constant LEGACY_MAGIC = 0x20c13b0b;
    bytes4 private constant MAGIC = 0x1626ba7e;

    // ------------------------------------------------------------------ ERC-1271

    /// @notice ERC-1271 (bytes32). Valid only for a Safe-approved message with an empty signature, while unpaused.
    function isValidSignature(bytes32 dataHash, bytes calldata signature) external view returns (bytes4) {
        return _approved(abi.encode(dataHash), signature) ? MAGIC : bytes4(0);
    }

    /// @notice Legacy ERC-1271 (bytes). Same rule as the bytes32 variant.
    function isValidSignature(bytes calldata data, bytes calldata signature) external view returns (bytes4) {
        return _approved(data, signature) ? LEGACY_MAGIC : bytes4(0);
    }

    // ------------------------------------------------------------------ message hashing (Safe tooling)

    function getMessageHash(bytes calldata message) external view returns (bytes32) {
        return keccak256(encodeMessageDataForSafe(msg.sender, message));
    }

    function getMessageHashForSafe(address safe, bytes calldata message) external view returns (bytes32) {
        return keccak256(encodeMessageDataForSafe(safe, message));
    }

    function encodeMessageDataForSafe(address safe, bytes memory message) public view returns (bytes memory) {
        bytes32 safeMessageHash = keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(message)));
        return abi.encodePacked(bytes1(0x19), bytes1(0x01), ISafeMessageView(safe).domainSeparator(), safeMessageHash);
    }

    /// @notice First ten modules of the calling Safe.
    function getModules() external view returns (address[] memory modules) {
        (modules,) = ISafeMessageView(msg.sender).getModulesPaginated(SENTINEL, 10);
    }

    /// @notice Runs Safe's simulateAndRevert (state is always rolled back) and returns or re-throws the result.
    function simulate(address targetContract, bytes calldata calldataPayload)
        external
        returns (bytes memory response)
    {
        (, bytes memory ret) =
            msg.sender.call(abi.encodeWithSelector(bytes4(0xb4faba09), targetContract, calldataPayload));
        // simulateAndRevert reverts with abi.encodePacked(bool success, uint256 length, bytes returnData).
        if (ret.length < 64) revert("simulate: malformed");
        bool success;
        uint256 length;
        assembly {
            success := mload(add(ret, 0x20))
            length := mload(add(ret, 0x40))
        }
        if (length > ret.length - 64) revert("simulate: malformed");
        response = new bytes(length);
        for (uint256 i; i < length; ++i) {
            response[i] = ret[64 + i];
        }
        if (!success) {
            assembly {
                revert(add(response, 0x20), mload(response))
            }
        }
    }

    // ------------------------------------------------------------------ token callbacks

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function tokensReceived(address, address, address, uint256, bytes calldata, bytes calldata) external pure {}

    /// @notice ERC-165: ERC-1155 receiver, ERC-721 receiver, ERC-165.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x4e2312e0 || interfaceId == 0x150b7a02 || interfaceId == 0x01ffc9a7;
    }

    // ------------------------------------------------------------------ internal

    function _approved(bytes memory data, bytes calldata signature) private view returns (bool) {
        if (signature.length != 0) return false;
        ISafeMessageView safe = ISafeMessageView(msg.sender);
        if (_paused(safe)) return false;
        return safe.signedMessages(keccak256(encodeMessageDataForSafe(msg.sender, data))) != 0;
    }

    /// @dev Reads the Safe's guard; a guard that cannot answer `paused()` counts as paused (fail closed).
    function _paused(ISafeMessageView safe) private view returns (bool) {
        address guard = abi.decode(safe.getStorageAt(GUARD_SLOT, 1), (address));
        if (guard == address(0)) return false;
        (bool ok, bytes memory ret) = guard.staticcall(abi.encodeWithSelector(IPausable.paused.selector));
        return !ok || ret.length < 32 || abi.decode(ret, (bool));
    }
}
