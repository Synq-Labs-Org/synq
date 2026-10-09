// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISafe} from "./interfaces/ISafe.sol";

/// @title SynqSafeModuleSetup
/// @notice Setup-time helper reached through Safe.setup's delegatecall; it only enables one module on the new Safe.
contract SynqSafeModuleSetup {
    address private immutable _self;

    error OnlyDelegateCall();

    constructor() {
        _self = address(this);
    }

    /// @notice Enables `module` on the Safe executing this code via delegatecall.
    /// @dev Reverts when called directly. In the delegatecall context `address(this)` is the Safe, so the Safe calls
    ///      its own `enableModule` and passes Safe's `authorized` check.
    /// @param module Module to enable.
    function enableModule(address module) external {
        if (address(this) == _self) revert OnlyDelegateCall();
        ISafe(address(this)).enableModule(module);
    }
}
