// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice ERC-165 interface detection.
interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE report receiver called by the KeystoneForwarder (or the MockKeystoneForwarder in simulation).
interface IReceiver is IERC165 {
    /// @param metadata Workflow identity: abi.encodePacked(bytes32 workflowId, bytes10 workflowName, address owner)
    ///        followed by a 2-byte report id (64 bytes on production delivery).
    /// @param report Workflow report payload.
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
