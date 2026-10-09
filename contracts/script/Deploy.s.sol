// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {SynqGroupFactory} from "../src/SynqGroupFactory.sol";
import {ExecutionModule} from "../src/ExecutionModule.sol";

interface ISafeVersion {
    function VERSION() external view returns (string memory);
}

/// @notice Deploys SynqGroupFactory, which deploys MandateRegistry, ExecutionModule and SynqSafeModuleSetup in its
///         constructor, against registry-provided Safe v1.4.1 infrastructure.
/// @dev Inputs (environment):
///      SYNQ_DEPLOYER_PRIVATE_KEY   test-only deployer key; populate from SYNQ_TESTNET_KEY_FILE via script/deploy.sh.
///      SYNQ_SAFE_L2_SINGLETON      SafeL2 v1.4.1 address from the Safe deployments registry.
///      SYNQ_SAFE_PROXY_FACTORY     SafeProxyFactory v1.4.1 address from the Safe deployments registry.
///      SYNQ_SAFE_FALLBACK_HANDLER  CompatibilityFallbackHandler v1.4.1 address from the Safe deployments registry.
///      On chains other than 31337 the on-chain codehashes must equal the registry's canonical v1.4.1 codeHash values.
///      A manifest is written to deployments/<chainId>.json only when broadcasting.
contract Deploy is Script {
    bytes32 internal constant SAFE_L2_CODEHASH = 0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff;
    bytes32 internal constant SAFE_PROXY_FACTORY_CODEHASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    bytes32 internal constant FALLBACK_HANDLER_CODEHASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    error NonCanonicalSafeInfrastructure(address value, bytes32 actual, bytes32 expected);
    error UnexpectedSafeVersion(string version);
    error PostDeployCheckFailed();

    /// @notice Runs the deployment (simulation unless invoked with --broadcast).
    function run() external returns (SynqGroupFactory factory) {
        address singleton = vm.envAddress("SYNQ_SAFE_L2_SINGLETON");
        address proxyFactory = vm.envAddress("SYNQ_SAFE_PROXY_FACTORY");
        address handler = vm.envAddress("SYNQ_SAFE_FALLBACK_HANDLER");
        _checkInfrastructure(singleton, proxyFactory, handler);

        uint256 deployerKey = vm.envUint("SYNQ_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);
        factory = new SynqGroupFactory(singleton, proxyFactory, handler);
        vm.stopBroadcast();

        ExecutionModule module = factory.module();
        if (
            factory.registry().factory() != address(factory)
                || address(module.registry()) != address(factory.registry()) || module.factory() != address(factory)
        ) revert PostDeployCheckFailed();

        console.log("chainId", block.chainid);
        console.log("deployer", deployer);
        console.log("SynqGroupFactory", address(factory));
        console.log("MandateRegistry", address(factory.registry()));
        console.log("ExecutionModule", address(module));
        console.log("SynqSafeModuleSetup", address(factory.moduleSetup()));
        console.logBytes32(module.domainSeparator());

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            _writeManifest(factory, deployer, singleton, proxyFactory, handler);
        }
    }

    function _checkInfrastructure(address singleton, address proxyFactory, address handler) internal view {
        string memory version = ISafeVersion(singleton).VERSION();
        if (keccak256(bytes(version)) != keccak256("1.4.1")) revert UnexpectedSafeVersion(version);
        if (block.chainid == LOCAL_CHAIN_ID) return;
        _requireCodehash(singleton, SAFE_L2_CODEHASH);
        _requireCodehash(proxyFactory, SAFE_PROXY_FACTORY_CODEHASH);
        _requireCodehash(handler, FALLBACK_HANDLER_CODEHASH);
    }

    function _requireCodehash(address value, bytes32 expected) internal view {
        if (value.codehash != expected) revert NonCanonicalSafeInfrastructure(value, value.codehash, expected);
    }

    function _writeManifest(
        SynqGroupFactory factory,
        address deployer,
        address singleton,
        address proxyFactory,
        address handler
    ) internal {
        string memory key = "manifest";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeUint(key, "simulatedAtBlock", block.number);
        vm.serializeAddress(key, "deployer", deployer);
        vm.serializeAddress(key, "SynqGroupFactory", address(factory));
        vm.serializeAddress(key, "MandateRegistry", address(factory.registry()));
        vm.serializeAddress(key, "ExecutionModule", address(factory.module()));
        vm.serializeAddress(key, "SynqSafeModuleSetup", address(factory.moduleSetup()));
        vm.serializeAddress(key, "safeL2Singleton", singleton);
        vm.serializeAddress(key, "safeProxyFactory", proxyFactory);
        vm.serializeAddress(key, "compatibilityFallbackHandler", handler);
        vm.serializeString(key, "safeVersion", "1.4.1");
        vm.serializeString(key, "eip712Name", factory.module().NAME());
        vm.serializeString(key, "eip712Version", factory.module().VERSION());
        string memory json = vm.serializeBytes32(key, "grantTypehash", factory.module().GRANT_TYPEHASH());
        vm.writeJson(json, string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json"));
    }
}
