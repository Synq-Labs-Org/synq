// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice Reads network facts (Safe infrastructure, assets, faucet) from sources/chain_registry.json so Foundry
///         scripts and fork tests never carry their own address or codehash constants.
library SynqChainRegistry {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct RegistryContract {
        address addr;
        bytes32 codeHash;
        uint256 chainId;
        string version;
    }

    struct SafeInfrastructure {
        RegistryContract singleton;
        RegistryContract proxyFactory;
        RegistryContract fallbackHandler;
    }

    struct RegistryAsset {
        address addr;
        uint256 chainId;
        uint8 decimals;
        string symbol;
    }

    error RegistryChainMismatch(string key, uint256 expected, uint256 actual);
    error RegistryUnsupportedChain(uint256 chainId);

    /// @notice Raw registry JSON (requires fs read permission on ../sources).
    function load() internal view returns (string memory) {
        return VM.readFile(string.concat(VM.projectRoot(), "/../sources/chain_registry.json"));
    }

    /// @notice Registry key prefix for the Monad network with `chainId`.
    function prefix(uint256 chainId) internal pure returns (string memory) {
        if (chainId == 10143) return "testnet";
        revert RegistryUnsupportedChain(chainId);
    }

    /// @notice Registry `contracts.<key>` entry, checked to belong to `chainId`.
    function contractEntry(string memory json, string memory key, uint256 chainId)
        internal
        view
        returns (RegistryContract memory entry)
    {
        string memory base = string.concat(".contracts.", key);
        entry.chainId = VM.parseJsonUint(json, string.concat(base, ".chainId"));
        if (entry.chainId != chainId) revert RegistryChainMismatch(key, chainId, entry.chainId);
        entry.addr = VM.parseJsonAddress(json, string.concat(base, ".address"));
        if (VM.keyExistsJson(json, string.concat(base, ".codeHash"))) {
            entry.codeHash = VM.parseJsonBytes32(json, string.concat(base, ".codeHash"));
        }
        if (VM.keyExistsJson(json, string.concat(base, ".version"))) {
            entry.version = VM.parseJsonString(json, string.concat(base, ".version"));
        }
    }

    /// @notice Safe v1.4.1 SafeL2, SafeProxyFactory and CompatibilityFallbackHandler for `chainId`.
    function safeInfrastructure(string memory json, uint256 chainId)
        internal
        view
        returns (SafeInfrastructure memory infra)
    {
        string memory p = prefix(chainId);
        infra.singleton = contractEntry(json, string.concat(p, "SafeL2"), chainId);
        infra.proxyFactory = contractEntry(json, string.concat(p, "SafeProxyFactory"), chainId);
        infra.fallbackHandler = contractEntry(json, string.concat(p, "SafeFallbackHandler"), chainId);
    }

    /// @notice Registry `assets.<key>` entry, checked to belong to `chainId`.
    function asset(string memory json, string memory key, uint256 chainId)
        internal
        pure
        returns (RegistryAsset memory entry)
    {
        string memory base = string.concat(".assets.", key);
        entry.chainId = VM.parseJsonUint(json, string.concat(base, ".chainId"));
        if (entry.chainId != chainId) revert RegistryChainMismatch(key, chainId, entry.chainId);
        entry.addr = VM.parseJsonAddress(json, string.concat(base, ".address"));
        entry.decimals = uint8(VM.parseJsonUint(json, string.concat(base, ".decimals")));
        entry.symbol = VM.parseJsonString(json, string.concat(base, ".symbol"));
    }
}
