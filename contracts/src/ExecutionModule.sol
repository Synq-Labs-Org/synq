// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MandateRegistry} from "./MandateRegistry.sol";

interface ISynqAccount {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
    function execTransactionFromModule(address target, uint256 value, bytes calldata data, uint8 operation)
        external
        returns (bool success);
}

interface IBalanceToken {
    function balanceOf(address owner) external view returns (uint256);
}

contract ExecutionModule {
    struct ExecutionGrant {
        bytes32 intentHash;
        bytes32 mandateId;
        uint256 mandateVersion;
        address executor;
        address target;
        bytes4 selector;
        bytes32 calldataHash;
        address inputToken;
        uint256 maxInputAmount;
        uint256 value;
        uint256 validAfter;
        uint256 validUntil;
        uint256 nonce;
        bytes32 pluginId;
        uint256 minOutputAmount;
        uint256 chainId;
    }

    bytes32 public constant GRANT_TYPEHASH = keccak256(
        "ExecutionGrant(bytes32 intentHash,bytes32 mandateId,uint256 mandateVersion,address executor,address target,bytes4 selector,bytes32 calldataHash,address inputToken,uint256 maxInputAmount,uint256 value,uint256 validAfter,uint256 validUntil,uint256 nonce,bytes32 pluginId,uint256 minOutputAmount,uint256 chainId)"
    );
    ISynqAccount public immutable account;
    MandateRegistry public immutable registry;
    bytes32 public immutable groupId;
    bool public paused;
    bool private entered;
    mapping(uint256 => bool) public usedNonces;
    mapping(bytes32 => bool) public executedIntents;
    mapping(bytes32 => uint256) public spent;

    event PauseChanged(bytes32 indexed groupId, address indexed account, bool paused);
    event GrantExecuted(
        bytes32 indexed groupId,
        bytes32 indexed intentHash,
        bytes32 indexed mandateId,
        uint256 mandateVersion,
        address account,
        address executor,
        bytes32 pluginId,
        uint256 chainId,
        uint256 nonce,
        bytes32 grantHash,
        address target,
        bytes4 selector,
        bytes32 calldataHash,
        address inputToken,
        address recipient,
        uint256 inputAmount,
        uint256 value,
        uint256 outputAmount
    );

    constructor(address account_, address registry_) {
        account = ISynqAccount(account_);
        registry = MandateRegistry(registry_);
        require(registry.account() == account_, "registry");
        groupId = registry.groupId();
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"
                ),
                keccak256("SynqExecutionModule"),
                keccak256("1"),
                block.chainid,
                address(this),
                keccak256(abi.encode(address(account), groupId))
            )
        );
    }

    function hashGrant(ExecutionGrant calldata grant) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(GRANT_TYPEHASH, grant))));
    }

    function setPaused(bool paused_) external {
        require(msg.sender == address(account), "account only");
        paused = paused_;
        emit PauseChanged(groupId, address(account), paused_);
    }

    function execute(ExecutionGrant calldata g, bytes calldata data, bytes calldata signatures) external {
        require(!entered && !paused, "paused/reentrant");
        require(msg.sender == g.executor && g.chainId == block.chainid, "principal/chain");
        require(g.intentHash != bytes32(0) && g.pluginId != bytes32(0), "identity");
        require(!usedNonces[g.nonce] && !executedIntents[g.intentHash], "replay");
        require(block.timestamp >= g.validAfter && block.timestamp < g.validUntil, "time");
        require(
            g.mandateVersion == registry.currentVersion(g.mandateId) && !registry.revoked(g.mandateId),
            "mandate version"
        );
        MandateRegistry.Mandate memory m = registry.getMandate(g.mandateId, g.mandateVersion);
        require(g.validUntil <= m.validUntil && block.timestamp < m.validUntil, "mandate time");
        require(g.target == m.target && g.selector == m.selector && g.inputToken == m.inputToken, "allowlist");
        require(
            g.target != address(account) && g.target != address(this) && g.target != address(registry), "governance"
        );
        require(keccak256(data) == g.calldataHash && g.value <= m.maxValue, "data/value");
        bytes32 digest = hashGrant(g);
        require(account.isValidSignature(digest, signatures) == 0x1626ba7e, "quorum");
        address recipient = g.target;
        uint256 amount = g.value;
        uint256 beforeAccount;
        uint256 beforeRecipient;
        if (g.inputToken == address(0)) {
            require(data.length == 0 && g.maxInputAmount == 0 && g.minOutputAmount == 0, "native only");
        } else {
            require(data.length == 68 && bytes4(data[:4]) == 0xa9059cbb && g.value == 0, "transfer only");
            (recipient, amount) = abi.decode(data[4:], (address, uint256));
            require(
                recipient != address(0) && recipient != address(account) && amount == g.maxInputAmount, "token amount"
            );
            require(g.minOutputAmount <= amount, "output cap");
            beforeAccount = IBalanceToken(g.inputToken).balanceOf(address(account));
            beforeRecipient = IBalanceToken(g.inputToken).balanceOf(recipient);
        }
        require(amount > 0 && amount <= m.maxPerCall && spent[g.mandateId] + amount <= m.cumulativeCap, "spend cap");
        entered = true;
        usedNonces[g.nonce] = true;
        executedIntents[g.intentHash] = true;
        spent[g.mandateId] += amount;
        require(account.execTransactionFromModule(g.target, g.value, data, 0), "execution");
        uint256 outputAmount;
        if (g.inputToken != address(0)) {
            require(beforeAccount - IBalanceToken(g.inputToken).balanceOf(address(account)) == amount, "token debit");
            outputAmount = IBalanceToken(g.inputToken).balanceOf(recipient) - beforeRecipient;
            require(outputAmount >= g.minOutputAmount && outputAmount == amount, "token output");
        }
        entered = false;
        emit GrantExecuted(
            groupId,
            g.intentHash,
            g.mandateId,
            g.mandateVersion,
            address(account),
            g.executor,
            g.pluginId,
            g.chainId,
            g.nonce,
            digest,
            g.target,
            g.selector,
            g.calldataHash,
            g.inputToken,
            recipient,
            g.inputToken == address(0) ? 0 : amount,
            g.value,
            outputAmount
        );
    }
}
