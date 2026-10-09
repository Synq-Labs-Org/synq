// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MandateRegistry {
    struct Mandate {
        address target;
        bytes4 selector;
        address inputToken;
        uint256 maxPerCall;
        uint256 cumulativeCap;
        uint256 maxValue;
        uint256 validUntil;
    }

    address public immutable account;
    bytes32 public immutable groupId;
    mapping(bytes32 => uint256) public currentVersion;
    mapping(bytes32 => bool) public revoked;
    mapping(bytes32 => mapping(uint256 => Mandate)) private mandates;

    event MandateConfigured(
        bytes32 indexed groupId,
        bytes32 indexed mandateId,
        uint256 indexed version,
        address account,
        address target,
        bytes4 selector,
        address inputToken,
        uint256 maxPerCall,
        uint256 cumulativeCap,
        uint256 maxValue,
        uint256 validUntil
    );
    event MandateRevoked(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed version, address account);

    constructor(address account_, bytes32 groupId_) {
        require(account_ != address(0) && groupId_ != bytes32(0), "identity");
        account = account_;
        groupId = groupId_;
    }

    function configure(bytes32 id, uint256 version, Mandate calldata mandate) external {
        require(msg.sender == account, "account only");
        require(id != bytes32(0) && version == currentVersion[id] + 1, "version");
        require(mandate.target != address(0) && mandate.validUntil > block.timestamp, "mandate");
        require(mandate.maxPerCall > 0 && mandate.cumulativeCap >= mandate.maxPerCall, "cap");
        if (mandate.inputToken == address(0)) {
            require(mandate.selector == bytes4(0) && mandate.maxValue > 0, "native");
        } else {
            require(
                mandate.target == mandate.inputToken && mandate.selector == 0xa9059cbb && mandate.maxValue == 0, "token"
            );
        }
        if (version > 1) require(mandate.inputToken == mandates[id][version - 1].inputToken, "asset immutable");
        mandates[id][version] = mandate;
        currentVersion[id] = version;
        revoked[id] = false;
        emit MandateConfigured(
            groupId,
            id,
            version,
            account,
            mandate.target,
            mandate.selector,
            mandate.inputToken,
            mandate.maxPerCall,
            mandate.cumulativeCap,
            mandate.maxValue,
            mandate.validUntil
        );
    }

    function revoke(bytes32 id) external {
        require(msg.sender == account && currentVersion[id] != 0, "account only");
        revoked[id] = true;
        emit MandateRevoked(groupId, id, currentVersion[id], account);
    }

    function getMandate(bytes32 id, uint256 version) external view returns (Mandate memory) {
        return mandates[id][version];
    }
}
