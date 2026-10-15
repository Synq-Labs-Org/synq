// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SynqArcVaultFactory} from "../../../src/arc/SynqArcVaultFactory.sol";
import {SynqArcVaultPolicy} from "../../../src/arc/SynqArcVaultPolicy.sol";
import {SynqMilestoneEscrow} from "../../../src/arc/SynqMilestoneEscrow.sol";
import {ISafeFull} from "../../utils/ISafeFull.sol";

/// @notice 6-decimal ERC-20 with an optional receive hook, standing in for a hostile token/provider. Plain transfers
///         to addresses without a registered hook behave like Arc USDC's ERC-20 interface.
contract HookToken {
    string public constant name = "Synq Local Hook USDC";
    string public constant symbol = "HUSDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public hooked;

    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setHook(address account, bool on) external {
        hooked[account] = on;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(to != address(0), "to");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        if (hooked[to]) ITokenHook(to).onTokenReceived(from, amount);
    }
}

interface ITokenHook {
    function onTokenReceived(address from, uint256 amount) external;
}

/// @notice Delegatecall target that rewrites the Safe singleton (slot 0) and threshold (slot 4): an "upgrade".
contract SafeMigration {
    function migrate(address newSingleton) external {
        assembly {
            sstore(0, newSingleton)
        }
    }
}

/// @notice Shared fixture: Safe v1.4.1 from vendored source, a 2-of-3 Arc vault with policy, an operator, a guardian.
abstract contract ArcVaultBase is Test {
    uint256 internal constant KEY1 = 0xA11CE;
    uint256 internal constant KEY2 = 0xB0B;
    uint256 internal constant KEY3 = 0xCA401;
    uint256 internal constant OPERATOR_KEY = 0x0DE7A70E;
    uint256 internal constant THRESHOLD = 2;
    uint256 internal constant DELAY = 2 days;
    uint256 internal constant PER_PAYMENT = 100e6;
    uint256 internal constant WINDOW_CAP = 250e6;
    uint256 internal constant FUNDING = 10_000e6;
    uint256 internal constant T0 = 1_760_000_000;
    uint8 internal constant CALL = 0;
    uint8 internal constant DELEGATECALL = 1;

    address internal safeSingleton;
    address internal safeProxyFactory;
    address internal fallbackHandler;
    SynqArcVaultFactory internal factory;
    SynqArcVaultPolicy internal policy;
    ISafeFull internal safe;
    HookToken internal token;

    address internal operator;
    address internal guardian = makeAddr("guardian");
    address internal vendor = makeAddr("vendor");
    address internal stranger = makeAddr("stranger");
    address internal creator = makeAddr("creator");

    function setUp() public virtual {
        vm.warp(T0);
        operator = vm.addr(OPERATOR_KEY);
        safeSingleton = deployCode("out/SafeL2.sol/SafeL2.json");
        safeProxyFactory = deployCode("out/SafeProxyFactory.sol/SafeProxyFactory.json");
        fallbackHandler = deployCode("out/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json");
        token = new HookToken();
        factory = new SynqArcVaultFactory(safeSingleton, safeProxyFactory, fallbackHandler, address(token));
        (address account, SynqArcVaultPolicy p) = createVault(vendor, keccak256("vault"));
        safe = ISafeFull(account);
        policy = p;
        token.mint(account, FUNDING);
        vm.deal(account, 10 ether);
    }

    function createVault(address recipient, bytes32 salt) internal returns (address account, SynqArcVaultPolicy p) {
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        SynqArcVaultFactory.VaultParams memory params = SynqArcVaultFactory.VaultParams({
            owners: owners(),
            threshold: THRESHOLD,
            guardian: guardian,
            operator: operator,
            delay: DELAY,
            recipients: recipients,
            perPaymentCap: PER_PAYMENT,
            windowCap: WINDOW_CAP
        });
        vm.prank(creator);
        (, account, p) = factory.createVault(params, salt);
    }

    function owners() internal pure returns (address[] memory list) {
        list = new address[](3);
        list[0] = vm.addr(KEY1);
        list[1] = vm.addr(KEY2);
        list[2] = vm.addr(KEY3);
    }

    function keys(uint256 a) internal pure returns (uint256[] memory list) {
        list = new uint256[](1);
        list[0] = a;
    }

    function keys(uint256 a, uint256 b) internal pure returns (uint256[] memory list) {
        list = new uint256[](2);
        list[0] = a;
        list[1] = b;
    }

    function signDigest(bytes32 digest, uint256[] memory signerKeys) internal pure returns (bytes memory signatures) {
        uint256[] memory sorted = new uint256[](signerKeys.length);
        for (uint256 i; i < signerKeys.length; ++i) {
            sorted[i] = signerKeys[i];
        }
        for (uint256 i = 1; i < sorted.length; ++i) {
            uint256 current = sorted[i];
            uint256 j = i;
            while (j > 0 && vm.addr(sorted[j - 1]) > vm.addr(current)) {
                sorted[j] = sorted[j - 1];
                --j;
            }
            sorted[j] = current;
        }
        for (uint256 i; i < sorted.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(sorted[i], digest);
            signatures = abi.encodePacked(signatures, r, s, v);
        }
    }

    function txHash(address to, uint256 value, bytes memory data, uint8 operation) internal view returns (bytes32) {
        return safe.getTransactionHash(to, value, data, operation, 0, 0, 0, address(0), address(0), safe.nonce());
    }

    /// @dev Owner-signed Safe transaction, submitted by `stranger` (any relayer may submit).
    function exec(address to, uint256 value, bytes memory data, uint8 operation, uint256[] memory signerKeys)
        internal
        returns (bool)
    {
        bytes memory signatures = signDigest(txHash(to, value, data, operation), signerKeys);
        vm.prank(stranger);
        return safe.execTransaction(to, value, data, operation, 0, 0, 0, address(0), payable(address(0)), signatures);
    }

    function execExpectRevert(
        address to,
        uint256 value,
        bytes memory data,
        uint8 operation,
        uint256[] memory signerKeys,
        bytes memory err
    ) internal {
        bytes memory signatures = signDigest(txHash(to, value, data, operation), signerKeys);
        vm.prank(stranger);
        vm.expectRevert(err);
        safe.execTransaction(to, value, data, operation, 0, 0, 0, address(0), payable(address(0)), signatures);
    }

    function quorum(address to, bytes memory data) internal {
        assertTrue(exec(to, 0, data, CALL, keys(KEY1, KEY2)), "quorum call");
    }

    /// @dev Queue through the quorum, wait the delay, execute through the quorum.
    function timelocked(address to, uint256 value, bytes memory data, uint8 operation) internal {
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (to, value, data, operation)));
        vm.warp(block.timestamp + DELAY);
        assertTrue(exec(to, value, data, operation, keys(KEY2, KEY3)), "timelocked exec");
    }

    function transferData(address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount);
    }

    function guardOf(ISafeFull account) internal view returns (address) {
        return abi.decode(account.getStorageAt(factory.GUARD_SLOT(), 1), (address));
    }

    function newEscrow() internal returns (SynqMilestoneEscrow) {
        return new SynqMilestoneEscrow(address(token));
    }
}
