// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title MandateRegistry
/// @notice Per-group mandate governance and cumulative spend ledger for Synq groups backed by Safe accounts.
/// @dev Governance functions accept calls only from the bound group account (the Safe itself), so every change
///      requires Safe owner quorum. Spend is recorded here, keyed by (account, mandateId), and only by the module the
///      group's Safe authorized in this registry; replacing or redeploying a module never resets cumulative spend.
contract MandateRegistry {
    enum MandateStatus {
        None,
        Active,
        Revoked
    }

    /// @notice Mandate envelope supplied by the group's Safe when configuring or superseding a mandate.
    /// @dev `token` is the ERC20 denomination for token spend; address(0) means the mandate permits no token spend.
    ///      `callTargets[i]`/`callSelectors[i]` form the (target, selector) allowlist; native transfers use selector 0.
    struct MandateConfig {
        bytes32 mandateHash;
        address token;
        uint256 maxTokenPerAction;
        uint256 maxNativePerAction;
        uint256 cumulativeTokenCap;
        uint256 cumulativeNativeCap;
        uint256 validAfter;
        uint256 validUntil;
        address[] callTargets;
        bytes4[] callSelectors;
        address[] recipients;
    }

    /// @notice Scalar terms stored for each mandate version.
    struct MandateTerms {
        bytes32 mandateHash;
        address token;
        uint256 maxTokenPerAction;
        uint256 maxNativePerAction;
        uint256 cumulativeTokenCap;
        uint256 cumulativeNativeCap;
        uint256 validAfter;
        uint256 validUntil;
    }

    /// @notice Mutable lifecycle and spend state of a mandate id.
    struct MandateState {
        MandateStatus status;
        uint256 currentVersion;
        uint256 minValidVersion;
        uint256 spentToken;
        uint256 spentNative;
    }

    /// @notice One delegated action presented by the group's authorized module for envelope checks and accounting.
    struct SpendRequest {
        address target;
        bytes4 selector;
        address recipient;
        address token;
        uint256 tokenAmount;
        uint256 nativeAmount;
    }

    /// @notice Maximum entries per allowlist, bounding configuration gas.
    uint256 public constant MAX_LIST_LENGTH = 32;

    /// @notice The only address allowed to bind new groups (the SynqGroupFactory that deployed this registry).
    address public immutable factory;

    /// @notice Group id bound to a Safe account (zero if unbound).
    mapping(address account => bytes32 groupId) public groupOf;
    /// @notice Safe account bound to a group id (zero if unbound).
    mapping(bytes32 groupId => address account) public accountOf;
    /// @notice Module authorized by the group's Safe to record spend for that account.
    mapping(address account => address module) public moduleOf;

    mapping(address account => mapping(bytes32 mandateId => MandateState)) private _state;
    mapping(address account => mapping(bytes32 mandateId => mapping(uint256 version => MandateTerms))) private _terms;
    mapping(address account => mapping(bytes32 mandateId => mapping(uint256 version => mapping(bytes32 callKey => bool))))
        private _callAllowed;
    mapping(
        address account => mapping(bytes32 mandateId => mapping(uint256 version => mapping(address recipient => bool)))
    ) private _recipientAllowed;

    /// @notice A factory-created Safe account was bound to a group id and initial module.
    event GroupBound(bytes32 indexed groupId, address indexed account, address indexed module);
    /// @notice The group's Safe changed which module may record spend.
    event GroupModuleChanged(
        bytes32 indexed groupId, address indexed account, address previousModule, address newModule
    );
    /// @notice A mandate version was written (version 1 on configure, N+1 on supersede).
    event MandateConfigured(
        bytes32 indexed groupId,
        bytes32 indexed mandateId,
        uint256 indexed version,
        address account,
        bytes32 mandateHash,
        address token,
        uint256 maxTokenPerAction,
        uint256 maxNativePerAction,
        uint256 cumulativeTokenCap,
        uint256 cumulativeNativeCap,
        uint256 validAfter,
        uint256 validUntil,
        address[] callTargets,
        bytes4[] callSelectors,
        address[] recipients
    );
    /// @notice A mandate was superseded by a new version; `minValidVersion` is the oldest version still grantable.
    event MandateSuperseded(
        bytes32 indexed groupId,
        bytes32 indexed mandateId,
        uint256 indexed newVersion,
        address account,
        uint256 previousVersion,
        bool securitySensitive,
        uint256 minValidVersion
    );
    /// @notice A mandate was revoked. Revocation is terminal.
    event MandateRevoked(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed version, address account);
    /// @notice Spend was recorded against a mandate by the group's authorized module.
    event SpendRecorded(
        bytes32 indexed groupId,
        bytes32 indexed mandateId,
        uint256 indexed version,
        address account,
        address module,
        uint256 tokenAmount,
        uint256 nativeAmount,
        uint256 spentToken,
        uint256 spentNative
    );

    error OnlyFactory();
    error OnlyGroupAccount();
    error InvalidBinding();
    error GroupAlreadyBound();
    error InvalidModule();
    error MandateAlreadyExists(bytes32 mandateId);
    error MandateNotFound(bytes32 mandateId);
    error MandateIsRevoked(bytes32 mandateId);
    error InvalidMandateId();
    error InvalidVersion(uint256 expected, uint256 provided);
    error TokenChanged();
    error InvalidWindow();
    error InvalidCaps();
    error InvalidCallList();
    error ListTooLong();
    error ForbiddenAddress(address value);
    error UnauthorizedModule(address caller);
    error MandateNotActive(bytes32 mandateId);
    error MandateVersionNotValid(uint256 version);
    error MandateOutsideWindow();
    error CallNotAllowed(address target, bytes4 selector);
    error RecipientNotAllowed(address recipient);
    error TokenMismatch(address token);
    error PerActionCapExceeded();
    error CumulativeCapExceeded();

    modifier onlyGroupAccount() {
        if (groupOf[msg.sender] == bytes32(0)) revert OnlyGroupAccount();
        _;
    }

    /// @notice Sets the deploying SynqGroupFactory as the sole group binder.
    constructor() {
        factory = msg.sender;
    }

    /// @notice Binds a freshly created Safe account to a group id and its initial module.
    /// @dev Factory only; each group id and account can be bound once.
    /// @param groupId Synq group id.
    /// @param account Safe proxy created by the factory.
    /// @param module ExecutionModule enabled on the Safe during setup.
    function bindGroup(bytes32 groupId, address account, address module) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (groupId == bytes32(0) || account == address(0) || module == address(0)) revert InvalidBinding();
        if (accountOf[groupId] != address(0) || groupOf[account] != bytes32(0)) revert GroupAlreadyBound();
        accountOf[groupId] = account;
        groupOf[account] = groupId;
        moduleOf[account] = module;
        emit GroupBound(groupId, account, module);
    }

    /// @notice Changes the module allowed to record spend for the calling group account.
    /// @dev Only the group's Safe (owner quorum). address(0) disables delegated spend entirely. Spend totals persist.
    /// @param newModule New module address, or address(0).
    function setModule(address newModule) external onlyGroupAccount {
        if (newModule == msg.sender || newModule == address(this) || newModule == factory) revert InvalidModule();
        address previous = moduleOf[msg.sender];
        moduleOf[msg.sender] = newModule;
        emit GroupModuleChanged(groupOf[msg.sender], msg.sender, previous, newModule);
    }

    /// @notice Creates version 1 of a mandate for the calling group account.
    /// @dev Only the group's Safe. Reverts if the id was ever used, including revoked ids (revocation is terminal).
    /// @param mandateId Mandate id.
    /// @param config Mandate envelope.
    function configureMandate(bytes32 mandateId, MandateConfig calldata config) external onlyGroupAccount {
        if (mandateId == bytes32(0)) revert InvalidMandateId();
        MandateState storage state = _state[msg.sender][mandateId];
        if (state.status == MandateStatus.Revoked) revert MandateIsRevoked(mandateId);
        if (state.status == MandateStatus.Active) revert MandateAlreadyExists(mandateId);
        _write(mandateId, 1, config);
        state.status = MandateStatus.Active;
        state.currentVersion = 1;
        state.minValidVersion = 1;
    }

    /// @notice Supersedes an active mandate with version `newVersion` (= current + 1).
    /// @dev Only the group's Safe. The token denomination is immutable per mandate id. If `securitySensitive`, grants
    ///      for every earlier version become invalid; otherwise earlier versions stay grantable under their own terms
    ///      while cumulative spend is capped by the stricter of the granted and current versions.
    /// @param mandateId Mandate id.
    /// @param newVersion Expected new version number.
    /// @param config New mandate envelope.
    /// @param securitySensitive Whether to invalidate grants for earlier versions.
    function supersedeMandate(bytes32 mandateId, uint256 newVersion, MandateConfig calldata config, bool securitySensitive)
        external
        onlyGroupAccount
    {
        MandateState storage state = _state[msg.sender][mandateId];
        if (state.status == MandateStatus.Revoked) revert MandateIsRevoked(mandateId);
        if (state.status == MandateStatus.None) revert MandateNotFound(mandateId);
        uint256 previous = state.currentVersion;
        if (newVersion != previous + 1) revert InvalidVersion(previous + 1, newVersion);
        if (config.token != _terms[msg.sender][mandateId][previous].token) revert TokenChanged();
        _write(mandateId, newVersion, config);
        state.currentVersion = newVersion;
        if (securitySensitive) state.minValidVersion = newVersion;
        emit MandateSuperseded(
            groupOf[msg.sender], mandateId, newVersion, msg.sender, previous, securitySensitive, state.minValidVersion
        );
    }

    /// @notice Permanently revokes an active mandate of the calling group account.
    /// @dev Only the group's Safe. A revoked mandate id can never be configured or superseded again.
    /// @param mandateId Mandate id.
    function revokeMandate(bytes32 mandateId) external onlyGroupAccount {
        MandateState storage state = _state[msg.sender][mandateId];
        if (state.status == MandateStatus.Revoked) revert MandateIsRevoked(mandateId);
        if (state.status == MandateStatus.None) revert MandateNotFound(mandateId);
        state.status = MandateStatus.Revoked;
        emit MandateRevoked(groupOf[msg.sender], mandateId, state.currentVersion, msg.sender);
    }

    /// @notice Checks a delegated action against the mandate envelope and records its spend.
    /// @dev Callable only by the module the account's Safe authorized via `bindGroup`/`setModule`. Reverts on any
    ///      envelope violation; on success increments cumulative spend before the module executes the call.
    /// @param account Group Safe account.
    /// @param mandateId Mandate id named by the grant.
    /// @param version Mandate version named by the grant.
    /// @param request Action target, selector, recipient, token and amounts.
    function authorizeSpend(address account, bytes32 mandateId, uint256 version, SpendRequest calldata request)
        external
    {
        if (msg.sender != moduleOf[account] || msg.sender == address(0)) revert UnauthorizedModule(msg.sender);
        MandateState storage state = _state[account][mandateId];
        if (state.status != MandateStatus.Active) revert MandateNotActive(mandateId);
        if (version < state.minValidVersion || version > state.currentVersion) revert MandateVersionNotValid(version);
        MandateTerms storage terms = _terms[account][mandateId][version];
        if (block.timestamp < terms.validAfter || block.timestamp >= terms.validUntil) revert MandateOutsideWindow();
        if (!_callAllowed[account][mandateId][version][_callKey(request.target, request.selector)]) {
            revert CallNotAllowed(request.target, request.selector);
        }
        if (!_recipientAllowed[account][mandateId][version][request.recipient]) {
            revert RecipientNotAllowed(request.recipient);
        }
        if (request.tokenAmount != 0 && (terms.token == address(0) || request.token != terms.token)) {
            revert TokenMismatch(request.token);
        }
        if (request.tokenAmount > terms.maxTokenPerAction || request.nativeAmount > terms.maxNativePerAction) {
            revert PerActionCapExceeded();
        }
        MandateTerms storage current = _terms[account][mandateId][state.currentVersion];
        uint256 spentToken = state.spentToken + request.tokenAmount;
        uint256 spentNative = state.spentNative + request.nativeAmount;
        if (
            spentToken > _min(terms.cumulativeTokenCap, current.cumulativeTokenCap)
                || spentNative > _min(terms.cumulativeNativeCap, current.cumulativeNativeCap)
        ) revert CumulativeCapExceeded();
        state.spentToken = spentToken;
        state.spentNative = spentNative;
        emit SpendRecorded(
            groupOf[account],
            mandateId,
            version,
            account,
            msg.sender,
            request.tokenAmount,
            request.nativeAmount,
            spentToken,
            spentNative
        );
    }

    /// @notice Returns the lifecycle and spend state of a mandate.
    /// @param account Group Safe account.
    /// @param mandateId Mandate id.
    function mandateState(address account, bytes32 mandateId) external view returns (MandateState memory) {
        return _state[account][mandateId];
    }

    /// @notice Returns the scalar terms of a mandate version.
    /// @param account Group Safe account.
    /// @param mandateId Mandate id.
    /// @param version Mandate version.
    function mandateTerms(address account, bytes32 mandateId, uint256 version)
        external
        view
        returns (MandateTerms memory)
    {
        return _terms[account][mandateId][version];
    }

    /// @notice Whether (target, selector) is allowlisted in a mandate version.
    /// @param account Group Safe account.
    /// @param mandateId Mandate id.
    /// @param version Mandate version.
    /// @param target Call target.
    /// @param selector Function selector (zero for a plain native transfer).
    function isCallAllowed(address account, bytes32 mandateId, uint256 version, address target, bytes4 selector)
        external
        view
        returns (bool)
    {
        return _callAllowed[account][mandateId][version][_callKey(target, selector)];
    }

    /// @notice Whether `recipient` is allowlisted in a mandate version.
    /// @param account Group Safe account.
    /// @param mandateId Mandate id.
    /// @param version Mandate version.
    /// @param recipient Recipient address.
    function isRecipientAllowed(address account, bytes32 mandateId, uint256 version, address recipient)
        external
        view
        returns (bool)
    {
        return _recipientAllowed[account][mandateId][version][recipient];
    }

    function _write(bytes32 mandateId, uint256 version, MandateConfig calldata config) private {
        _validate(config);
        _terms[msg.sender][mandateId][version] = MandateTerms({
            mandateHash: config.mandateHash,
            token: config.token,
            maxTokenPerAction: config.maxTokenPerAction,
            maxNativePerAction: config.maxNativePerAction,
            cumulativeTokenCap: config.cumulativeTokenCap,
            cumulativeNativeCap: config.cumulativeNativeCap,
            validAfter: config.validAfter,
            validUntil: config.validUntil
        });
        for (uint256 i; i < config.callTargets.length; ++i) {
            _callAllowed[msg.sender][mandateId][version][_callKey(config.callTargets[i], config.callSelectors[i])] = true;
        }
        for (uint256 i; i < config.recipients.length; ++i) {
            _recipientAllowed[msg.sender][mandateId][version][config.recipients[i]] = true;
        }
        emit MandateConfigured(
            groupOf[msg.sender],
            mandateId,
            version,
            msg.sender,
            config.mandateHash,
            config.token,
            config.maxTokenPerAction,
            config.maxNativePerAction,
            config.cumulativeTokenCap,
            config.cumulativeNativeCap,
            config.validAfter,
            config.validUntil,
            config.callTargets,
            config.callSelectors,
            config.recipients
        );
    }

    function _validate(MandateConfig calldata config) private view {
        if (config.validUntil <= config.validAfter || config.validUntil <= block.timestamp) revert InvalidWindow();
        if (config.token == address(0) && (config.maxTokenPerAction != 0 || config.cumulativeTokenCap != 0)) {
            revert InvalidCaps();
        }
        uint256 calls = config.callTargets.length;
        if (calls == 0 || calls != config.callSelectors.length) revert InvalidCallList();
        if (calls > MAX_LIST_LENGTH || config.recipients.length > MAX_LIST_LENGTH) revert ListTooLong();
        if (config.token != address(0)) _requireNotProtected(config.token);
        for (uint256 i; i < calls; ++i) {
            _requireNotProtected(config.callTargets[i]);
        }
        for (uint256 i; i < config.recipients.length; ++i) {
            address recipient = config.recipients[i];
            _requireNotProtected(recipient);
            if (recipient == config.token) revert ForbiddenAddress(recipient);
        }
    }

    function _requireNotProtected(address value) private view {
        if (
            value == address(0) || value == msg.sender || value == address(this) || value == factory
                || value == moduleOf[msg.sender]
        ) revert ForbiddenAddress(value);
    }

    function _callKey(address target, bytes4 selector) private pure returns (bytes32) {
        return keccak256(abi.encode(target, selector));
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
