// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafe} from "./interfaces/ISafe.sol";

interface ISynqGroupCreation {
    function isCreating(address account) external view returns (bool);
}

/// @title SynqSafeModuleSetup
/// @notice Setup-time helper reached through Safe.setup's delegatecall; it only enables one module on the new Safe,
///         and only while the deploying SynqGroupFactory is creating that exact Safe.
contract SynqSafeModuleSetup {
    address private immutable _self;
    /// @notice SynqGroupFactory that deployed this helper.
    address public immutable factory;

    error OnlyDelegateCall();
    error NotFactoryCreation();

    constructor() {
        _self = address(this);
        factory = msg.sender;
    }

    /// @notice Enables `module` on the Safe executing this code via delegatecall.
    /// @dev Reverts when called directly, and reverts unless the factory is currently creating `address(this)`
    ///      (the Safe), so a copied factory initializer cannot be replayed through SafeProxyFactory. In the
    ///      delegatecall context `address(this)` is the Safe, so the Safe calls its own `enableModule` and passes
    ///      Safe's `authorized` check.
    /// @param module Module to enable.
    function enableModule(address module) external {
        if (address(this) == _self) revert OnlyDelegateCall();
        if (!ISynqGroupCreation(factory).isCreating(address(this))) revert NotFactoryCreation();
        ISafe(address(this)).enableModule(module);
    }
}
