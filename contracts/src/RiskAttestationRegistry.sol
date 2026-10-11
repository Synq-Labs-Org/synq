// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165, IReceiver} from "./interfaces/IReceiver.sol";

/// @title RiskAttestationRegistry
/// @notice Stores the latest stablecoin risk attestation per asset, written only through the configured Chainlink
///         CRE forwarder. Readers (the Synq Kernel risk gate) treat UNKNOWN and STALE as fail-closed.
/// @dev Report payload: abi.encode(bytes32 assetId, uint64 timestamp, uint256 referencePrice, uint32 deviationBps,
///      uint64 stalenessSec, uint8 status, bytes32 sourceConfigHash) — exactly 224 bytes. `referencePrice` has
///      REFERENCE_DECIMALS decimals. Timestamps are strictly monotonic per asset, so a delayed or replayed report can
///      never overwrite a newer one. Optional workflow identity checks follow the CRE ReceiverTemplate semantics and
///      accept 62- or 64-byte metadata (production KeystoneForwarder delivers 64 bytes).
contract RiskAttestationRegistry is IReceiver {
    enum Status {
        UNKNOWN,
        HEALTHY,
        DEGRADED,
        STALE
    }

    struct Attestation {
        uint64 timestamp;
        uint64 stalenessSec;
        uint32 deviationBps;
        Status status;
        uint256 referencePrice;
        bytes32 sourceConfigHash;
        bytes32 workflowId;
        uint64 recordedAt;
        uint64 recordedBlock;
    }

    /// @notice Decimals of `referencePrice`.
    uint8 public constant REFERENCE_DECIMALS = 8;
    /// @notice Maximum seconds an attestation timestamp may lie ahead of the block timestamp.
    uint64 public constant MAX_FUTURE_SKEW = 300;
    /// @notice Exact report length (seven static ABI words).
    uint256 public constant REPORT_LENGTH = 224;

    /// @notice Administrator allowed to rotate the forwarder and workflow identity checks.
    address public owner;
    /// @notice Pending administrator of a two-step ownership transfer.
    address public pendingOwner;
    /// @notice The only address allowed to call `onReport`.
    address public forwarder;
    /// @notice If non-zero, only reports from this workflow id are accepted.
    bytes32 public expectedWorkflowId;
    /// @notice If non-zero, only reports from this workflow owner are accepted.
    address public expectedAuthor;
    /// @notice If non-zero (requires `expectedAuthor`), only reports from this workflow name are accepted.
    bytes10 public expectedWorkflowName;

    mapping(bytes32 assetId => Attestation) private _latest;

    event AttestationRecorded(
        bytes32 indexed assetId,
        Status indexed status,
        uint64 timestamp,
        uint256 referencePrice,
        uint32 deviationBps,
        uint64 stalenessSec,
        bytes32 sourceConfigHash,
        bytes32 workflowId
    );
    event ForwarderUpdated(address indexed previous, address indexed current);
    event WorkflowExpectationUpdated(bytes32 workflowId, address author, bytes10 workflowName);
    event OwnershipTransferStarted(address indexed previous, address indexed pending);
    event OwnershipTransferred(address indexed previous, address indexed current);

    error InvalidForwarder();
    error InvalidSender(address sender, address expected);
    error NotOwner(address caller);
    error NotPendingOwner(address caller);
    error InvalidMetadata(uint256 length);
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidAuthor(address received, address expected);
    error InvalidWorkflowName(bytes10 received, bytes10 expected);
    error WorkflowNameRequiresAuthor();
    error InvalidReportLength(uint256 length);
    error InvalidAsset();
    error InvalidStatus(uint8 status);
    error MissingReferencePrice();
    error StaleAttestation(bytes32 assetId, uint64 latest, uint64 provided);
    error FutureAttestation(uint64 timestamp, uint256 blockTimestamp);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _;
    }

    /// @param forwarder_ CRE forwarder (MockKeystoneForwarder for simulation, KeystoneForwarder for production).
    constructor(address forwarder_) {
        if (forwarder_ == address(0)) revert InvalidForwarder();
        owner = msg.sender;
        forwarder = forwarder_;
        emit OwnershipTransferred(address(0), msg.sender);
        emit ForwarderUpdated(address(0), forwarder_);
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);
        bytes32 workflowId = _checkMetadata(metadata);
        if (report.length != REPORT_LENGTH) revert InvalidReportLength(report.length);
        (
            bytes32 assetId,
            uint64 timestamp,
            uint256 referencePrice,
            uint32 deviationBps,
            uint64 stalenessSec,
            uint8 rawStatus,
            bytes32 sourceConfigHash
        ) = abi.decode(report, (bytes32, uint64, uint256, uint32, uint64, uint8, bytes32));
        if (assetId == bytes32(0)) revert InvalidAsset();
        if (rawStatus > uint8(type(Status).max)) revert InvalidStatus(rawStatus);
        Status status = Status(rawStatus);
        if ((status == Status.HEALTHY || status == Status.DEGRADED) && referencePrice == 0) {
            revert MissingReferencePrice();
        }
        uint64 latestTimestamp = _latest[assetId].timestamp;
        if (timestamp <= latestTimestamp) revert StaleAttestation(assetId, latestTimestamp, timestamp);
        if (timestamp > block.timestamp + MAX_FUTURE_SKEW) revert FutureAttestation(timestamp, block.timestamp);

        _latest[assetId] = Attestation({
            timestamp: timestamp,
            stalenessSec: stalenessSec,
            deviationBps: deviationBps,
            status: status,
            referencePrice: referencePrice,
            sourceConfigHash: sourceConfigHash,
            workflowId: workflowId,
            recordedAt: uint64(block.timestamp),
            recordedBlock: uint64(block.number)
        });
        emit AttestationRecorded(
            assetId, status, timestamp, referencePrice, deviationBps, stalenessSec, sourceConfigHash, workflowId
        );
    }

    /// @notice Latest attestation for `assetId` (all-zero with status UNKNOWN if none was recorded).
    function latest(bytes32 assetId) external view returns (Attestation memory) {
        return _latest[assetId];
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) external pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Rotates the forwarder (e.g. MockKeystoneForwarder to the production KeystoneForwarder).
    function setForwarder(address forwarder_) external onlyOwner {
        if (forwarder_ == address(0)) revert InvalidForwarder();
        emit ForwarderUpdated(forwarder, forwarder_);
        forwarder = forwarder_;
    }

    /// @notice Sets the optional workflow identity checks. Zero values disable a check; a workflow name requires an
    ///         author because names are truncated to 10 bytes and unique only per owner.
    function setWorkflowExpectation(bytes32 workflowId, address author, bytes10 workflowName) external onlyOwner {
        if (workflowName != bytes10(0) && author == address(0)) revert WorkflowNameRequiresAuthor();
        expectedWorkflowId = workflowId;
        expectedAuthor = author;
        expectedWorkflowName = workflowName;
        emit WorkflowExpectationUpdated(workflowId, author, workflowName);
    }

    /// @notice Starts a two-step ownership transfer.
    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    /// @notice Completes a two-step ownership transfer.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner(msg.sender);
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function _checkMetadata(bytes calldata metadata) private view returns (bytes32 workflowId) {
        bool identityChecked =
            expectedWorkflowId != bytes32(0) || expectedAuthor != address(0) || expectedWorkflowName != bytes10(0);
        bool decodable = metadata.length == 62 || metadata.length == 64;
        if (!decodable) {
            if (identityChecked) revert InvalidMetadata(metadata.length);
            return bytes32(0);
        }
        workflowId = bytes32(metadata[0:32]);
        if (!identityChecked) return workflowId;
        bytes10 workflowName = bytes10(metadata[32:42]);
        address author = address(bytes20(metadata[42:62]));
        if (expectedWorkflowId != bytes32(0) && workflowId != expectedWorkflowId) {
            revert InvalidWorkflowId(workflowId, expectedWorkflowId);
        }
        if (expectedAuthor != address(0) && author != expectedAuthor) revert InvalidAuthor(author, expectedAuthor);
        if (expectedWorkflowName != bytes10(0) && workflowName != expectedWorkflowName) {
            revert InvalidWorkflowName(workflowName, expectedWorkflowName);
        }
    }
}
