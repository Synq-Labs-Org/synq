// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafeArc, ISafeArcProxyFactory} from "./ISafeArc.sol";
import {SynqArcVaultPolicy} from "./SynqArcVaultPolicy.sol";

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
/// @notice Creates Synq group vaults on Arc: a Safe v1.4.1 proxy (canonical singleton, proxy factory and
///         fallback handler, verified by code hash off-chain before use) with a fresh SynqArcVaultPolicy installed
///         as both module and guard in the same transaction.
/// @dev Upgrade authority: none. The factory has no owner, no proxy and no mutable configuration. Each vault's
///      code can change only through its own owner quorum after its policy timelock (see SynqArcVaultPolicy).
contract SynqArcVaultFactory {
    /// @notice Maximum owners per vault.
    uint256 public constant MAX_OWNERS = 20;
    /// @notice Safe v1.4.1 guard storage slot: keccak256("guard_manager.guard.address").
    uint256 public constant GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;
    address private constant SENTINEL = address(0x1);

    /// @notice Safe singleton (SafeL2 v1.4.1).
    address public immutable safeSingleton;
    /// @notice SafeProxyFactory v1.4.1.
    ISafeArcProxyFactory public immutable safeProxyFactory;
    /// @notice CompatibilityFallbackHandler v1.4.1.
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

    constructor(address safeSingleton_, address safeProxyFactory_, address fallbackHandler_, address token_) {
        if (safeSingleton_.code.length == 0) revert InfrastructureMissing(safeSingleton_);
        if (safeProxyFactory_.code.length == 0) revert InfrastructureMissing(safeProxyFactory_);
        if (fallbackHandler_.code.length == 0) revert InfrastructureMissing(fallbackHandler_);
        if (token_.code.length == 0) revert InfrastructureMissing(token_);
        safeSingleton = safeSingleton_;
        safeProxyFactory = ISafeArcProxyFactory(safeProxyFactory_);
        fallbackHandler = fallbackHandler_;
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
        bytes memory guard = ISafeArc(safe).getStorageAt(GUARD_SLOT, 1);
        if (
            safe != predicted || !ISafeArc(safe).isModuleEnabled(address(policy))
                || abi.decode(guard, (address)) != address(policy) || ISafeArc(safe).getThreshold() != p.threshold
        ) revert SetupVerificationFailed();
        emit VaultCreated(
            vaultId, safe, address(policy), p.owners, p.threshold, p.guardian, p.operator, p.delay, msg.sender
        );
    }

    function _validate(VaultParams calldata p) private view {
        uint256 count = p.owners.length;
        if (count == 0 || count > MAX_OWNERS) revert InvalidOwners();
        if (p.threshold == 0 || p.threshold > count) revert InvalidThreshold();
        if (p.operator != address(0) && p.operator == p.guardian) revert InvalidRole(p.operator);
        for (uint256 i; i < count; ++i) {
            address owner = p.owners[i];
            if (
                owner == address(0) || owner == SENTINEL || owner == address(this) || owner == address(setupHelper)
                    || owner == token
            ) revert InvalidOwner(owner);
            // The scoped operator must never be able to count toward the quorum.
            if (owner == p.operator) revert InvalidRole(owner);
            for (uint256 j; j < i; ++j) {
                if (p.owners[j] == owner) revert InvalidOwner(owner);
            }
        }
    }
}
