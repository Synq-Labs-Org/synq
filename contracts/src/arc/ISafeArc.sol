// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Subset of the Safe v1.4.1 account interface used by the Arc vault contracts.
interface ISafeArc {
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

    function setGuard(address guard) external;

    function isModuleEnabled(address module) external view returns (bool);

    function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success);

    function getThreshold() external view returns (uint256);

    function isOwner(address owner) external view returns (bool);

    function getStorageAt(uint256 offset, uint256 length) external view returns (bytes memory);
}

/// @notice Subset of the Safe v1.4.1 SafeProxyFactory interface.
interface ISafeArcProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);

    function proxyCreationCode() external pure returns (bytes memory);
}

/// @notice Minimal ERC-20 surface (Arc USDC at 0x3600…0000 is a 6-decimal ERC-20 view of native USDC).
interface IERC20Arc {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);
}
