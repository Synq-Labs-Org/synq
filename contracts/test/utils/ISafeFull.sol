// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test-side view of the Safe v1.4.1 ABI (owner management, transactions, signatures).
interface ISafeFull {
    function VERSION() external view returns (string memory);
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function nonce() external view returns (uint256);
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
    function isOwner(address owner) external view returns (bool);
    function isModuleEnabled(address module) external view returns (bool);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
    function domainSeparator() external view returns (bytes32);
    function signedMessages(bytes32 messageHash) external view returns (uint256);
    function approvedHashes(address owner, bytes32 hash) external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external payable returns (bool success);
    function approveHash(bytes32 hashToApprove) external;
    function addOwnerWithThreshold(address owner, uint256 threshold) external;
    function removeOwner(address prevOwner, address owner, uint256 threshold) external;
    function swapOwner(address prevOwner, address oldOwner, address newOwner) external;
    function changeThreshold(uint256 threshold) external;
    function enableModule(address module) external;
    function disableModule(address prevModule, address module) external;
    function setGuard(address guard) external;
    function setFallbackHandler(address handler) external;
    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success);
    function checkSignatures(bytes32 dataHash, bytes calldata data, bytes calldata signatures) external view;
}

interface ICompatibilityFallbackHandler {
    function getMessageHashForSafe(address safe, bytes calldata message) external view returns (bytes32);
}
