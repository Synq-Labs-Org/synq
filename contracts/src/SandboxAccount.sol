// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Non-production, fixed-owner sandbox implementing Safe's module call interface.
contract SandboxAccount {
    bytes4 private constant MAGIC = 0x1626ba7e;
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    mapping(address => bool) public isOwner;
    mapping(address => bool) public isModuleEnabled;
    address[3] private owners;
    uint256 public ownerNonce;

    event ModuleChanged(address indexed module, bool enabled);
    event OwnerExecuted(bytes32 indexed digest, address indexed target, uint256 value, uint256 nonce);

    constructor(address[3] memory initialOwners) {
        for (uint256 i; i < 3; ++i) {
            require(initialOwners[i] != address(0) && !isOwner[initialOwners[i]], "owner");
            owners[i] = initialOwners[i];
            isOwner[initialOwners[i]] = true;
        }
    }

    receive() external payable {}

    function getOwners() external view returns (address[3] memory) {
        return owners;
    }

    function getThreshold() external pure returns (uint256) {
        return 2;
    }

    function isValidSignature(bytes32 digest, bytes calldata signatures) public view returns (bytes4) {
        if (signatures.length != 130) return 0xffffffff;
        address previous;
        for (uint256 i; i < 2; ++i) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(add(signatures.offset, mul(i, 65)))
                s := calldataload(add(add(signatures.offset, mul(i, 65)), 32))
                v := byte(0, calldataload(add(add(signatures.offset, mul(i, 65)), 64)))
            }
            if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) return 0xffffffff;
            address signer = ecrecover(digest, v, r, s);
            if (!isOwner[signer] || signer <= previous) return 0xffffffff;
            previous = signer;
        }
        return MAGIC;
    }

    function ownerTransactionHash(address target, uint256 value, bytes calldata data, uint256 nonce)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode("SynqSandboxOwner", block.chainid, address(this), target, value, keccak256(data), nonce)
        );
    }

    function ownerExecute(address target, uint256 value, bytes calldata data, bytes calldata signatures) external {
        uint256 nonce = ownerNonce;
        bytes32 digest = ownerTransactionHash(target, value, data, nonce);
        require(isValidSignature(digest, signatures) == MAGIC, "quorum");
        ownerNonce = nonce + 1;
        (bool ok,) = target.call{value: value}(data);
        require(ok, "owner call");
        emit OwnerExecuted(digest, target, value, nonce);
    }

    function setModule(address module, bool enabled) external {
        require(msg.sender == address(this), "owners only");
        require(module != address(0), "module");
        isModuleEnabled[module] = enabled;
        emit ModuleChanged(module, enabled);
    }

    function execTransactionFromModule(address target, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success)
    {
        require(isModuleEnabled[msg.sender] && operation == 0 && target != address(this), "module call");
        (success,) = target.call{value: value}(data);
    }
}
