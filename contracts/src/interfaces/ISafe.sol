// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Subset of the Safe v1.4.1 account interface used by Synq contracts.
interface ISafe {
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

    function enableModule(address module) external;

    function isModuleEnabled(address module) external view returns (bool);

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success);

    function checkSignatures(bytes32 dataHash, bytes calldata data, bytes calldata signatures) external view;

    function getThreshold() external view returns (uint256);

    function getOwners() external view returns (address[] memory);

    function isOwner(address owner) external view returns (bool);
}

/// @notice Subset of the Safe v1.4.1 SafeProxyFactory interface.
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);

    function proxyCreationCode() external pure returns (bytes memory);
}
