// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {SynqGroupFactory} from "../src/SynqGroupFactory.sol";
import {ExecutionModule} from "../src/ExecutionModule.sol";
import {SynqChainRegistry} from "./SynqChainRegistry.sol";

interface ISafeVersion {
    function VERSION() external view returns (string memory);
}

/// @notice Deploys SynqGroupFactory, which deploys MandateRegistry, ExecutionModule and SynqSafeModuleSetup in its
///         constructor, against Safe v1.4.1 infrastructure taken from sources/chain_registry.json.
/// @dev Inputs (environment):
///      SYNQ_DEPLOYER_PRIVATE_KEY  test-only deployer key; populate from SYNQ_TESTNET_KEY_FILE via script/deploy.sh.
///      On Monad testnet the SafeL2, SafeProxyFactory and CompatibilityFallbackHandler addresses and codeHash values
///      come from the chain registry (contracts.testnetSafeL2 / testnetSafeProxyFactory / testnetSafeFallbackHandler)
///      and the on-chain codehashes must match. On local Anvil (31337) the locally deployed Safe addresses are read
///      from SYNQ_SAFE_L2_SINGLETON, SYNQ_SAFE_PROXY_FACTORY and SYNQ_SAFE_FALLBACK_HANDLER. Other chains are refused.
///      A manifest is written to deployments/<chainId>.json only when broadcasting.
contract Deploy is Script {
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    error NonCanonicalSafeInfrastructure(address value, bytes32 actual, bytes32 expected);
    error UnexpectedSafeVersion(string version);
    error PostDeployCheckFailed();

    /// @notice Runs the deployment (simulation unless invoked with --broadcast).
    function run() external returns (SynqGroupFactory factory) {
        (address singleton, address proxyFactory, address handler) = _infrastructure();

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

    function _infrastructure() internal view returns (address singleton, address proxyFactory, address handler) {
        if (block.chainid == LOCAL_CHAIN_ID) {
            singleton = vm.envAddress("SYNQ_SAFE_L2_SINGLETON");
            proxyFactory = vm.envAddress("SYNQ_SAFE_PROXY_FACTORY");
            handler = vm.envAddress("SYNQ_SAFE_FALLBACK_HANDLER");
            _requireVersion(singleton);
            return (singleton, proxyFactory, handler);
        }
        SynqChainRegistry.SafeInfrastructure memory infra =
            SynqChainRegistry.safeInfrastructure(SynqChainRegistry.load(), block.chainid);
        _requireCanonical(infra.singleton);
        _requireCanonical(infra.proxyFactory);
        _requireCanonical(infra.fallbackHandler);
        _requireVersion(infra.singleton.addr);
        return (infra.singleton.addr, infra.proxyFactory.addr, infra.fallbackHandler.addr);
    }

    function _requireCanonical(SynqChainRegistry.RegistryContract memory entry) internal view {
        if (keccak256(bytes(entry.version)) != keccak256("1.4.1")) revert UnexpectedSafeVersion(entry.version);
        if (entry.codeHash == bytes32(0) || entry.addr.codehash != entry.codeHash) {
            revert NonCanonicalSafeInfrastructure(entry.addr, entry.addr.codehash, entry.codeHash);
        }
    }

    function _requireVersion(address singleton) internal view {
        string memory version = ISafeVersion(singleton).VERSION();
        if (keccak256(bytes(version)) != keccak256("1.4.1")) revert UnexpectedSafeVersion(version);
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
