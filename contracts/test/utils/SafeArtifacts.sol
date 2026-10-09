// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Compiles the vendored Safe v1.4.1 contracts (legacy codegen profile) so tests can deploy them with deployCode
// without pulling Synq sources into the legacy compilation unit.
import {SafeL2} from "@safe-global/safe-smart-account/contracts/SafeL2.sol";
import {SafeProxyFactory} from "@safe-global/safe-smart-account/contracts/proxies/SafeProxyFactory.sol";
import {CompatibilityFallbackHandler} from
    "@safe-global/safe-smart-account/contracts/handler/CompatibilityFallbackHandler.sol";
import {MultiSendCallOnly} from "@safe-global/safe-smart-account/contracts/libraries/MultiSendCallOnly.sol";
