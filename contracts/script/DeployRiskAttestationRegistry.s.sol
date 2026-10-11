// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {RiskAttestationRegistry} from "../src/RiskAttestationRegistry.sol";
import {SynqChainRegistry} from "./SynqChainRegistry.sol";

/// @notice Deploys RiskAttestationRegistry on Monad testnet with the CRE MockKeystoneForwarder from
///         sources/chain_registry.json (contracts.testnetCreMockForwarder) as the only allowed writer, so
///         `cre workflow simulate --broadcast` can deliver reports. The forwarder codehash must match the registry.
/// @dev Inputs (environment): SYNQ_DEPLOYER_PRIVATE_KEY, populated from SYNQ_TESTNET_KEY_FILE by
///      script/deploy-risk-attestation.sh. Writes deployments/<chainId>.risk-attestation.json only when broadcasting.
contract DeployRiskAttestationRegistry is Script {
    string internal constant FORWARDER_KEY = "testnetCreMockForwarder";

    error ForwarderCodehashMismatch(address forwarder, bytes32 actual, bytes32 expected);
    error PostDeployCheckFailed();

    function run() external returns (RiskAttestationRegistry registry) {
        SynqChainRegistry.RegistryContract memory forwarder =
            SynqChainRegistry.contractEntry(SynqChainRegistry.load(), FORWARDER_KEY, block.chainid);
        if (forwarder.codeHash == bytes32(0) || forwarder.addr.codehash != forwarder.codeHash) {
            revert ForwarderCodehashMismatch(forwarder.addr, forwarder.addr.codehash, forwarder.codeHash);
        }
        uint256 deployerKey = vm.envUint("SYNQ_DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        vm.startBroadcast(deployerKey);
        registry = new RiskAttestationRegistry(forwarder.addr);
        vm.stopBroadcast();
        if (registry.forwarder() != forwarder.addr || registry.owner() != deployer) revert PostDeployCheckFailed();

        console.log("chainId", block.chainid);
        console.log("deployer", deployer);
        console.log("forwarder", forwarder.addr);
        console.log("RiskAttestationRegistry", address(registry));

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory key = "manifest";
            vm.serializeUint(key, "chainId", block.chainid);
            vm.serializeUint(key, "simulatedAtBlock", block.number);
            vm.serializeAddress(key, "deployer", deployer);
            vm.serializeString(key, "forwarderRegistryKey", FORWARDER_KEY);
            vm.serializeAddress(key, "forwarder", forwarder.addr);
            vm.serializeString(key, "forwarderKind", "CRE_MOCK_FORWARDER");
            string memory json = vm.serializeAddress(key, "RiskAttestationRegistry", address(registry));
            vm.writeJson(
                json,
                string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".risk-attestation.json")
            );
        }
    }
}
