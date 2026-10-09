// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafe} from "./interfaces/ISafe.sol";
import {MandateRegistry} from "./MandateRegistry.sol";

interface IERC20Balance {
    function balanceOf(address owner) external view returns (uint256);
}

/// @title ExecutionModule
/// @notice Safe module that executes owner-quorum-signed Synq ExecutionGrants within MandateRegistry envelopes.
/// @dev One deployment serves many Safes; all per-account state is keyed by the Safe address and governed by that Safe.
///      Grants are EIP-712 typed data over this module's domain and are verified with the Safe's own
///      `checkSignatures`, so EOA, eth_sign, approved-hash and contract-owner (ERC-1271) signatures follow Safe rules.
///      Execution is always a CALL through `execTransactionFromModule`; DELEGATECALL is never requested.
contract ExecutionModule {
    /// @notice Owner-signed authorization for exactly one delegated action.
    struct ExecutionGrant {
        bytes32 groupId;
        address account;
        bytes32 mandateId;
        uint256 mandateVersion;
        address executor;
        bytes32 pluginId;
        uint256 chainId;
        address target;
        bytes4 selector;
        bytes32 calldataHash;
        address token;
        uint256 maxInputAmount;
        uint256 nativeValue;
        uint256 minOutputAmount;
        address recipient;
        uint256 validAfter;
        uint256 validUntil;
        uint256 nonce;
        bytes32 intentHash;
    }

    /// @notice EIP-712 domain name.
    string public constant NAME = "SynqExecutionModule";
    /// @notice EIP-712 domain version.
    string public constant VERSION = "1";
    /// @notice EIP-712 domain type hash.
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @notice EIP-712 ExecutionGrant type hash.
    bytes32 public constant GRANT_TYPEHASH = keccak256(
        "ExecutionGrant(bytes32 groupId,address account,bytes32 mandateId,uint256 mandateVersion,address executor,bytes32 pluginId,uint256 chainId,address target,bytes4 selector,bytes32 calldataHash,address token,uint256 maxInputAmount,uint256 nativeValue,uint256 minOutputAmount,address recipient,uint256 validAfter,uint256 validUntil,uint256 nonce,bytes32 intentHash)"
    );
    /// @notice ERC20 `transfer(address,uint256)` selector, the only token action this module executes.
    bytes4 public constant TRANSFER_SELECTOR = 0xa9059cbb;

    uint256 private constant SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint8 private constant CALL_OPERATION = 0;

    /// @notice Registry holding group bindings, mandate envelopes and cumulative spend.
    MandateRegistry public immutable registry;
    /// @notice Factory bound to `registry`; excluded as a target or recipient.
    address public immutable factory;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;
    uint256 private _lock = 1;

    /// @notice Executors each Safe allows to submit grants.
    mapping(address account => mapping(address executor => bool)) public isExecutor;
    /// @notice Whether delegated execution is paused for a Safe.
    mapping(address account => bool) public paused;
    /// @notice Consumed or cancelled grant nonces per Safe.
    mapping(address account => mapping(uint256 nonce => bool)) public nonceUsed;
    /// @notice Executed intent hashes per Safe.
    mapping(address account => mapping(bytes32 intentHash => bool)) public intentUsed;

    /// @notice A Safe allowed or disallowed an executor.
    event ExecutorSet(bytes32 indexed groupId, address indexed account, address indexed executor, bool allowed);
    /// @notice A Safe paused delegated execution.
    event Paused(bytes32 indexed groupId, address indexed account);
    /// @notice A Safe resumed delegated execution.
    event Unpaused(bytes32 indexed groupId, address indexed account);
    /// @notice A Safe cancelled an unused grant nonce.
    event NonceCancelled(bytes32 indexed groupId, address indexed account, uint256 indexed nonce);
    /// @notice A grant executed and its balance effects were verified.
    event GrantExecuted(
        bytes32 indexed groupId,
        bytes32 indexed intentHash,
        bytes32 indexed mandateId,
        uint256 mandateVersion,
        address account,
        address executor,
        bytes32 pluginId,
        uint256 chainId,
        uint256 nonce,
        bytes32 grantHash,
        address target,
        bytes4 selector,
        bytes32 calldataHash,
        address token,
        address recipient,
        uint256 tokenAmount,
        uint256 nativeValue,
        uint256 outputAmount
    );

    error AccountNotRegistered();
    error InvalidExecutor();
    error AlreadyPaused();
    error NotPaused();
    error Reentrancy();
    error ExecutionPaused(address account);
    error InvalidSignatures();
    error MalleableSignature(uint256 index);
    error ModuleIsSafeOwner();
    error ModuleSelfApproval(uint256 index);
    error WrongChain(uint256 expected, uint256 provided);
    error UnauthorizedExecutor(address caller);
    error GroupMismatch();
    error ModuleNotAuthorized();
    error ModuleNotEnabled();
    error GrantNotYetValid();
    error GrantExpired();
    error InvalidIntent();
    error NonceAlreadyUsed(uint256 nonce);
    error IntentAlreadyExecuted(bytes32 intentHash);
    error CalldataMismatch();
    error SelectorMismatch();
    error ProtectedAddress(address value);
    error UnsupportedAction(bytes4 selector);
    error InvalidActionShape();
    error ExecutionFailed();
    error BalanceDeltaMismatch();
    error InsufficientOutput();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    modifier onlyRegisteredAccount() {
        if (registry.groupOf(msg.sender) == bytes32(0)) revert AccountNotRegistered();
        _;
    }

    /// @param registry_ MandateRegistry whose factory creates the Safes this module serves.
    constructor(MandateRegistry registry_) {
        registry = registry_;
        factory = registry_.factory();
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    /// @notice Allows or disallows `executor` to submit grants for the calling Safe.
    /// @dev Only a registered group Safe (owner quorum). Executors still need a quorum-signed grant naming them.
    /// @param executor Executor address.
    /// @param allowed Whether the executor is allowed.
    function setExecutor(address executor, bool allowed) external onlyRegisteredAccount {
        if (executor == address(0)) revert InvalidExecutor();
        isExecutor[msg.sender][executor] = allowed;
        emit ExecutorSet(registry.groupOf(msg.sender), msg.sender, executor, allowed);
    }

    /// @notice Pauses delegated execution for the calling Safe. Safe-native owner transactions are unaffected.
    function pause() external onlyRegisteredAccount {
        if (paused[msg.sender]) revert AlreadyPaused();
        paused[msg.sender] = true;
        emit Paused(registry.groupOf(msg.sender), msg.sender);
    }

    /// @notice Resumes delegated execution for the calling Safe.
    function unpause() external onlyRegisteredAccount {
        if (!paused[msg.sender]) revert NotPaused();
        paused[msg.sender] = false;
        emit Unpaused(registry.groupOf(msg.sender), msg.sender);
    }

    /// @notice Cancels an unused grant nonce of the calling Safe so no grant using it can execute.
    /// @param nonce Grant nonce.
    function cancelNonce(uint256 nonce) external onlyRegisteredAccount {
        if (nonceUsed[msg.sender][nonce]) revert NonceAlreadyUsed(nonce);
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(registry.groupOf(msg.sender), msg.sender, nonce);
    }

    /// @notice EIP-712 domain separator for the current chain.
    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    /// @notice EIP-712 struct hash of a grant.
    /// @param grant Execution grant.
    function grantStructHash(ExecutionGrant calldata grant) public pure returns (bytes32) {
        return keccak256(abi.encode(GRANT_TYPEHASH, grant));
    }

    /// @notice EIP-712 digest that Safe owners sign for a grant.
    /// @param grant Execution grant.
    function hashGrant(ExecutionGrant calldata grant) external view returns (bytes32) {
        return _digest(grantStructHash(grant));
    }

    /// @notice Executes one quorum-signed grant from the named Safe.
    /// @dev Reverts with ModuleIsSafeOwner if this module is an owner of the Safe: Safe treats `msg.sender == owner`
    ///      as an approved-hash signature, which would let any executor fill a quorum slot.
    ///      Order: pause, quorum signature (Safe `checkSignatures`), grant/executor/group binding, validity window,
    ///      replay, calldata and action shape, registry envelope + spend accounting, CALL via the Safe, balance deltas.
    /// @param grant Execution grant signed by a threshold of the Safe's owners.
    /// @param data Exact calldata; keccak256(data) must equal `grant.calldataHash`.
    /// @param signatures Safe-format signatures over `hashGrant(grant)`.
    /// @return grantHash EIP-712 digest of the executed grant.
    function execute(ExecutionGrant calldata grant, bytes calldata data, bytes calldata signatures)
        external
        nonReentrant
        returns (bytes32 grantHash)
    {
        if (paused[grant.account]) revert ExecutionPaused(grant.account);
        bytes32 structHash = grantStructHash(grant);
        grantHash = _digest(structHash);
        _checkQuorum(grant.account, grantHash, structHash, signatures);

        if (grant.chainId != block.chainid) revert WrongChain(block.chainid, grant.chainId);
        if (msg.sender != grant.executor || !isExecutor[grant.account][msg.sender]) {
            revert UnauthorizedExecutor(msg.sender);
        }
        if (grant.groupId == bytes32(0) || registry.groupOf(grant.account) != grant.groupId) revert GroupMismatch();
        if (registry.moduleOf(grant.account) != address(this)) revert ModuleNotAuthorized();
        if (!ISafe(grant.account).isModuleEnabled(address(this))) revert ModuleNotEnabled();
        if (block.timestamp < grant.validAfter) revert GrantNotYetValid();
        if (block.timestamp >= grant.validUntil) revert GrantExpired();
        if (grant.intentHash == bytes32(0)) revert InvalidIntent();
        if (nonceUsed[grant.account][grant.nonce]) revert NonceAlreadyUsed(grant.nonce);
        if (intentUsed[grant.account][grant.intentHash]) revert IntentAlreadyExecuted(grant.intentHash);
        if (keccak256(data) != grant.calldataHash) revert CalldataMismatch();
        _requireNotProtected(grant.account, grant.target);
        _requireNotProtected(grant.account, grant.recipient);
        uint256 tokenAmount = _validateAction(grant, data);

        nonceUsed[grant.account][grant.nonce] = true;
        intentUsed[grant.account][grant.intentHash] = true;
        registry.authorizeSpend(
            grant.account,
            grant.mandateId,
            grant.mandateVersion,
            MandateRegistry.SpendRequest({
                target: grant.target,
                selector: grant.selector,
                recipient: grant.recipient,
                token: grant.token,
                tokenAmount: tokenAmount,
                nativeAmount: grant.nativeValue
            })
        );

        uint256 output = _executeAndVerify(grant, data, tokenAmount);
        _emitExecuted(grant, grantHash, tokenAmount, output);
    }

    function _checkQuorum(address account, bytes32 digest, bytes32 structHash, bytes calldata signatures)
        private
        view
    {
        if (account.code.length == 0) revert InvalidSignatures();
        uint256 threshold;
        try ISafe(account).getThreshold() returns (uint256 value) {
            threshold = value;
        } catch {
            revert InvalidSignatures();
        }
        if (threshold == 0 || threshold > signatures.length / 65) revert InvalidSignatures();
        bool moduleIsOwner;
        try ISafe(account).isOwner(address(this)) returns (bool value) {
            moduleIsOwner = value;
        } catch {
            revert InvalidSignatures();
        }
        if (moduleIsOwner) revert ModuleIsSafeOwner();
        for (uint256 i; i < threshold; ++i) {
            uint256 offset = i * 65;
            uint8 v = uint8(signatures[offset + 64]);
            if (v == 1 && address(uint160(uint256(bytes32(signatures[offset:offset + 32])))) == address(this)) {
                revert ModuleSelfApproval(i);
            }
            if (v > 1 && uint256(bytes32(signatures[offset + 32:offset + 64])) > SECP256K1_HALF_N) {
                revert MalleableSignature(i);
            }
        }
        bytes memory preimage = abi.encodePacked(bytes2(0x1901), domainSeparator(), structHash);
        try ISafe(account).checkSignatures(digest, preimage, signatures) {}
        catch {
            revert InvalidSignatures();
        }
    }

    function _validateAction(ExecutionGrant calldata grant, bytes calldata data) private pure returns (uint256) {
        if (data.length == 0) {
            if (grant.selector != bytes4(0)) revert SelectorMismatch();
            if (
                grant.token != address(0) || grant.maxInputAmount != 0 || grant.nativeValue == 0
                    || grant.recipient != grant.target || grant.minOutputAmount > grant.nativeValue
            ) revert InvalidActionShape();
            return 0;
        }
        if (data.length < 4 || bytes4(data[:4]) != grant.selector) revert SelectorMismatch();
        if (grant.selector != TRANSFER_SELECTOR) revert UnsupportedAction(grant.selector);
        if (data.length != 68 || grant.token == address(0) || grant.target != grant.token || grant.nativeValue != 0) {
            revert InvalidActionShape();
        }
        uint256 rawRecipient = uint256(bytes32(data[4:36]));
        uint256 amount = uint256(bytes32(data[36:68]));
        if (
            rawRecipient >> 160 != 0 || address(uint160(rawRecipient)) != grant.recipient || amount == 0
                || amount != grant.maxInputAmount || grant.minOutputAmount > amount
        ) revert InvalidActionShape();
        return amount;
    }

    function _executeAndVerify(ExecutionGrant calldata grant, bytes calldata data, uint256 tokenAmount)
        private
        returns (uint256 output)
    {
        address account = grant.account;
        address recipient = grant.recipient;
        bool isToken = tokenAmount != 0;
        uint256 accountBefore = isToken ? IERC20Balance(grant.token).balanceOf(account) : account.balance;
        uint256 recipientBefore = isToken ? IERC20Balance(grant.token).balanceOf(recipient) : recipient.balance;
        if (!ISafe(account).execTransactionFromModule(grant.target, grant.nativeValue, data, CALL_OPERATION)) {
            revert ExecutionFailed();
        }
        uint256 accountAfter = isToken ? IERC20Balance(grant.token).balanceOf(account) : account.balance;
        uint256 recipientAfter = isToken ? IERC20Balance(grant.token).balanceOf(recipient) : recipient.balance;
        uint256 expected = isToken ? tokenAmount : grant.nativeValue;
        if (accountAfter > accountBefore || accountBefore - accountAfter != expected) revert BalanceDeltaMismatch();
        if (recipientAfter < recipientBefore) revert BalanceDeltaMismatch();
        output = recipientAfter - recipientBefore;
        if (output != expected) revert BalanceDeltaMismatch();
        if (output < grant.minOutputAmount) revert InsufficientOutput();
    }

    function _emitExecuted(ExecutionGrant calldata grant, bytes32 grantHash, uint256 tokenAmount, uint256 output)
        private
    {
        emit GrantExecuted(
            grant.groupId,
            grant.intentHash,
            grant.mandateId,
            grant.mandateVersion,
            grant.account,
            msg.sender,
            grant.pluginId,
            grant.chainId,
            grant.nonce,
            grantHash,
            grant.target,
            grant.selector,
            grant.calldataHash,
            grant.token,
            grant.recipient,
            tokenAmount,
            grant.nativeValue,
            output
        );
    }

    function _requireNotProtected(address account, address value) private view {
        if (
            value == address(0) || value == account || value == address(this) || value == address(registry)
                || value == factory
        ) revert ProtectedAddress(value);
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked(bytes2(0x1901), domainSeparator(), structHash));
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(NAME)), keccak256(bytes(VERSION)), block.chainid, address(this))
        );
    }
}
