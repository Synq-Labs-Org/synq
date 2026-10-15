// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafeArc, ISafeArcProxyFactory} from "./ISafeArc.sol";
import {SynqArcVaultPolicy} from "./SynqArcVaultPolicy.sol";
import {SynqArcFallbackHandler} from "./SynqArcFallbackHandler.sol";

interface ISynqArcVaultCreation {
    function isCreating(address account) external view returns (bool);
}

/// @title SynqArcVaultSetup
/// @notice Setup-time helper reached through Safe.setup's delegatecall. It enables the policy as module and guard,
///         and only while the deploying SynqArcVaultFactory is creating that exact Safe.
contract SynqArcVaultSetup {
    address private immutable _self;
    /// @notice SynqArcVaultFactory that deployed this helper.
    address public immutable factory;

    error OnlyDelegateCall();
    error NotFactoryCreation();

    constructor() {
        _self = address(this);
        factory = msg.sender;
    }

    /// @notice Enables `policy` as module and guard on the Safe executing this code via delegatecall.
    /// @param policy SynqArcVaultPolicy for this Safe.
    function install(address policy) external {
        if (address(this) == _self) revert OnlyDelegateCall();
        if (!ISynqArcVaultCreation(factory).isCreating(address(this))) revert NotFactoryCreation();
        ISafeArc(address(this)).enableModule(policy);
        ISafeArc(address(this)).setGuard(policy);
    }
}

/// @title SynqArcVaultFactory
/// @notice Creates Synq group vaults on Arc: a Safe v1.4.1 proxy (canonical singleton and proxy factory, verified
///         by code hash off-chain before use) with a fresh SynqArcVaultPolicy installed as both module and guard and
///         SynqArcFallbackHandler as fallback handler, all in the same transaction. The stock
///         CompatibilityFallbackHandler is deliberately not used: its owner-signature ERC-1271 path bypasses the
///         guard (see SynqArcFallbackHandler).
/// @dev Upgrade authority: none. The factory has no owner, no proxy and no mutable configuration. Each vault's
///      code can change only through its own owner quorum after its policy timelock (see SynqArcVaultPolicy).
contract SynqArcVaultFactory {
    /// @notice Maximum owners per vault.
    uint256 public constant MAX_OWNERS = 20;
    /// @notice Safe v1.4.1 guard storage slot: keccak256("guard_manager.guard.address").
    uint256 public constant GUARD_SLOT = uint256(keccak256("guard_manager.guard.address"));
    /// @notice Safe v1.4.1 fallback handler storage slot: keccak256("fallback_manager.handler.address").
    uint256 public constant FALLBACK_HANDLER_SLOT = uint256(keccak256("fallback_manager.handler.address"));
    address private constant SENTINEL = address(0x1);

    /// @notice Safe singleton (SafeL2 v1.4.1).
    address public immutable safeSingleton;
    /// @notice SafeProxyFactory v1.4.1.
    ISafeArcProxyFactory public immutable safeProxyFactory;
    /// @notice SynqArcFallbackHandler installed on every vault (deployed by this factory).
    address public immutable fallbackHandler;
    /// @notice Asset every vault's operator may pay (Arc USDC).
    address public immutable token;
    /// @notice Delegatecall helper used by Safe.setup.
    SynqArcVaultSetup public immutable setupHelper;
    /// @notice keccak256 of the SafeProxy init code for `safeSingleton`.
    bytes32 public immutable proxyInitCodeHash;

    address private _creating;

    struct VaultParams {
        address[] owners;
        uint256 threshold;
        address guardian;
        address operator;
        uint256 delay;
        address[] recipients;
        uint256 perPaymentCap;
        uint256 windowCap;
    }

    /// @notice A vault Safe was created with `policy` as module and guard.
    event VaultCreated(
        bytes32 indexed vaultId,
        address indexed safe,
        address indexed policy,
        address[] owners,
        uint256 threshold,
        address guardian,
        address operator,
        uint256 delay,
        address creator
    );

    error InfrastructureMissing(address value);
    error InvalidOwners();
    error InvalidThreshold();
    error InvalidOwner(address owner);
    error InvalidRole(address value);
    error SetupVerificationFailed();
    error CreationInProgress();

    /// @notice A replacement policy was deployed already bound to `safe` (install it with a timelocked setGuard).
    event ReplacementPolicyDeployed(address indexed safe, address indexed policy, address guardian, address operator);

    constructor(address safeSingleton_, address safeProxyFactory_, address token_) {
        if (safeSingleton_.code.length == 0) revert InfrastructureMissing(safeSingleton_);
        if (safeProxyFactory_.code.length == 0) revert InfrastructureMissing(safeProxyFactory_);
        if (token_.code.length == 0) revert InfrastructureMissing(token_);
        safeSingleton = safeSingleton_;
        safeProxyFactory = ISafeArcProxyFactory(safeProxyFactory_);
        fallbackHandler = address(new SynqArcFallbackHandler());
        token = token_;
        setupHelper = new SynqArcVaultSetup();
        proxyInitCodeHash = keccak256(
            abi.encodePacked(
                ISafeArcProxyFactory(safeProxyFactory_).proxyCreationCode(), uint256(uint160(safeSingleton_))
            )
        );
    }

    /// @notice Whether `account` is the Safe proxy this factory is creating in the current call.
    function isCreating(address account) external view returns (bool) {
        return account != address(0) && account == _creating;
    }

    /// @notice Vault id namespaced by chain, factory, creator and salt.
    function computeVaultId(address creator, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), creator, salt));
    }

    /// @notice CREATE2 address SafeProxyFactory will assign for `initializer` and `saltNonce`.
    function predictSafe(bytes memory initializer, uint256 saltNonce) public view returns (address) {
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        return address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(safeProxyFactory), salt, proxyInitCodeHash)))
            )
        );
    }

    /// @notice Creates a vault Safe and its policy.
    /// @param p Owners, threshold, guardian, operator, timelock delay and initial operator scope.
    /// @param salt Creator-chosen salt.
    function createVault(VaultParams calldata p, bytes32 salt)
        external
        returns (bytes32 vaultId, address safe, SynqArcVaultPolicy policy)
    {
        if (_creating != address(0)) revert CreationInProgress();
        _validate(p);
        vaultId = computeVaultId(msg.sender, salt);
        policy = new SynqArcVaultPolicy{salt: vaultId}(
            token, p.delay, p.guardian, p.operator, p.recipients, p.perPaymentCap, p.windowCap
        );
        bytes memory initializer = abi.encodeCall(
            ISafeArc.setup,
            (
                p.owners,
                p.threshold,
                address(setupHelper),
                abi.encodeCall(SynqArcVaultSetup.install, (address(policy))),
                fallbackHandler,
                address(0),
                0,
                payable(address(0))
            )
        );
        address predicted = predictSafe(initializer, uint256(vaultId));
        _creating = predicted;
        safe = safeProxyFactory.createProxyWithNonce(safeSingleton, initializer, uint256(vaultId));
        delete _creating;
        policy.bind(safe);
        if (
            safe != predicted || !ISafeArc(safe).isModuleEnabled(address(policy))
                || _slot(safe, GUARD_SLOT) != address(policy) || _slot(safe, FALLBACK_HANDLER_SLOT) != fallbackHandler
                || ISafeArc(safe).getThreshold() != p.threshold
        ) revert SetupVerificationFailed();
        emit VaultCreated(
            vaultId, safe, address(policy), p.owners, p.threshold, p.guardian, p.operator, p.delay, msg.sender
        );
    }

    /// @notice Deploys a replacement policy already bound to the calling Safe. Only the Safe itself (an owner-quorum
    ///         transaction) can mint its own replacement; installing it is a separate timelocked setGuard /
    ///         enableModule, which the current policy accepts only for a guard bound to the same Safe.
    function deployReplacementPolicy(
        address guardian,
        address operator,
        uint256 delay,
        address[] calldata recipients,
        uint256 perPaymentCap,
        uint256 windowCap,
        bytes32 salt
    ) external returns (SynqArcVaultPolicy policy) {
        address safe = msg.sender;
        if (safe.code.length == 0) revert InvalidRole(safe);
        _validateRoles(guardian, operator, recipients);
        if (operator != address(0) && ISafeArc(safe).isOwner(operator)) revert InvalidRole(operator);
        policy = new SynqArcVaultPolicy{salt: keccak256(abi.encode(block.chainid, safe, salt))}(
            token, delay, guardian, operator, recipients, perPaymentCap, windowCap
        );
        policy.bind(safe);
        emit ReplacementPolicyDeployed(safe, address(policy), guardian, operator);
    }

    function _slot(address safe, uint256 slot) private view returns (address) {
        return abi.decode(ISafeArc(safe).getStorageAt(slot, 1), (address));
    }

    function _validateRoles(address guardian, address operator, address[] calldata recipients) private pure {
        if (operator != address(0) && operator == guardian) revert InvalidRole(operator);
        for (uint256 i; i < recipients.length; ++i) {
            // The operator may never pay itself.
            if (operator != address(0) && recipients[i] == operator) revert InvalidRole(operator);
        }
    }

    function _validate(VaultParams calldata p) private view {
        uint256 count = p.owners.length;
        if (count == 0 || count > MAX_OWNERS) revert InvalidOwners();
        if (p.threshold == 0 || p.threshold > count) revert InvalidThreshold();
        _validateRoles(p.guardian, p.operator, p.recipients);
        for (uint256 i; i < count; ++i) {
            address owner = p.owners[i];
            if (
                owner == address(0) || owner == SENTINEL || owner == address(this) || owner == address(setupHelper)
                    || owner == token || owner == fallbackHandler
            ) revert InvalidOwner(owner);
            // The scoped operator must never be able to count toward the quorum.
            if (owner == p.operator) revert InvalidRole(owner);
            for (uint256 j; j < i; ++j) {
                if (p.owners[j] == owner) revert InvalidOwner(owner);
            }
        }
    }
}
