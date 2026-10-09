// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafe, ISafeProxyFactory} from "./interfaces/ISafe.sol";
import {MandateRegistry} from "./MandateRegistry.sol";
import {ExecutionModule} from "./ExecutionModule.sol";
import {SynqSafeModuleSetup} from "./SynqSafeModuleSetup.sol";

/// @title SynqGroupFactory
/// @notice Creates Synq group accounts as Safe v1.4.1 proxies with ExecutionModule enabled and binds them in the
///         MandateRegistry. Deploys its own registry, module and setup helper so the trust graph is fixed at deploy.
contract SynqGroupFactory {
    /// @notice Maximum owners per group.
    uint256 public constant MAX_OWNERS = 20;
    address private constant SENTINEL = address(0x1);

    /// @notice Safe singleton (SafeL2 v1.4.1) used for every group proxy.
    address public immutable safeSingleton;
    /// @notice Canonical SafeProxyFactory v1.4.1.
    ISafeProxyFactory public immutable safeProxyFactory;
    /// @notice CompatibilityFallbackHandler v1.4.1 installed on every group Safe.
    address public immutable fallbackHandler;
    /// @notice Registry bound to this factory.
    MandateRegistry public immutable registry;
    /// @notice ExecutionModule enabled on every group Safe at creation.
    ExecutionModule public immutable module;
    /// @notice Delegatecall helper used by Safe.setup to enable `module`.
    SynqSafeModuleSetup public immutable moduleSetup;

    /// @notice A group Safe was created, `module` enabled and the group bound in `registry`.
    event GroupCreated(
        bytes32 indexed groupId,
        address indexed account,
        address[] owners,
        uint256 threshold,
        address module,
        address registry,
        address indexed creator,
        bytes32 salt
    );

    error InfrastructureMissing(address value);
    error InvalidOwners();
    error InvalidThreshold();
    error InvalidOwner(address owner);
    error SetupVerificationFailed();

    /// @param safeSingleton_ SafeL2 v1.4.1 singleton.
    /// @param safeProxyFactory_ SafeProxyFactory v1.4.1.
    /// @param fallbackHandler_ CompatibilityFallbackHandler v1.4.1.
    constructor(address safeSingleton_, address safeProxyFactory_, address fallbackHandler_) {
        if (safeSingleton_.code.length == 0) revert InfrastructureMissing(safeSingleton_);
        if (safeProxyFactory_.code.length == 0) revert InfrastructureMissing(safeProxyFactory_);
        if (fallbackHandler_.code.length == 0) revert InfrastructureMissing(fallbackHandler_);
        safeSingleton = safeSingleton_;
        safeProxyFactory = ISafeProxyFactory(safeProxyFactory_);
        fallbackHandler = fallbackHandler_;
        registry = new MandateRegistry();
        module = new ExecutionModule(registry);
        moduleSetup = new SynqSafeModuleSetup();
    }

    /// @notice Deterministic group id for a creator and salt on this chain and factory.
    /// @param creator Address calling `createGroup`.
    /// @param salt Creator-chosen salt.
    function computeGroupId(address creator, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), creator, salt));
    }

    /// @notice Creates a Safe group account with `owners`/`threshold`, enables the module and binds the group.
    /// @dev The group id is namespaced by `msg.sender`, so a front-runner cannot claim another creator's id.
    /// @param owners Safe owners (unique, non-zero, not Synq contracts).
    /// @param threshold Safe owner threshold (1..owners.length).
    /// @param salt Creator-chosen salt.
    /// @return groupId Group id.
    /// @return account Safe proxy address.
    function createGroup(address[] calldata owners, uint256 threshold, bytes32 salt)
        external
        returns (bytes32 groupId, address account)
    {
        _validateOwners(owners, threshold);
        groupId = computeGroupId(msg.sender, salt);
        bytes memory initializer = abi.encodeCall(
            ISafe.setup,
            (
                owners,
                threshold,
                address(moduleSetup),
                abi.encodeCall(SynqSafeModuleSetup.enableModule, (address(module))),
                fallbackHandler,
                address(0),
                0,
                payable(address(0))
            )
        );
        account = safeProxyFactory.createProxyWithNonce(safeSingleton, initializer, uint256(groupId));
        if (!ISafe(account).isModuleEnabled(address(module)) || ISafe(account).getThreshold() != threshold) {
            revert SetupVerificationFailed();
        }
        registry.bindGroup(groupId, account, address(module));
        emit GroupCreated(groupId, account, owners, threshold, address(module), address(registry), msg.sender, salt);
    }

    function _validateOwners(address[] calldata owners, uint256 threshold) private view {
        uint256 count = owners.length;
        if (count == 0 || count > MAX_OWNERS) revert InvalidOwners();
        if (threshold == 0 || threshold > count) revert InvalidThreshold();
        for (uint256 i; i < count; ++i) {
            address owner = owners[i];
            if (
                owner == address(0) || owner == SENTINEL || owner == address(this) || owner == address(registry)
                    || owner == address(module) || owner == address(moduleSetup)
            ) revert InvalidOwner(owner);
            for (uint256 j; j < i; ++j) {
                if (owners[j] == owner) revert InvalidOwner(owner);
            }
        }
    }
}
