// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase} from "./ArcVaultBase.sol";
import {SynqArcVaultFactory} from "../../../src/arc/SynqArcVaultFactory.sol";
import {SynqArcVaultPolicy} from "../../../src/arc/SynqArcVaultPolicy.sol";
import {SynqMilestoneEscrow} from "../../../src/arc/SynqMilestoneEscrow.sol";
import {ISafeFull} from "../../utils/ISafeFull.sol";

/// @notice Escrow payee whose token hook re-enters every escrow entry point.
contract ReentrantPayee {
    SynqMilestoneEscrow internal immutable escrow;
    uint256 public dealId;
    uint256 public attempts;
    uint256 public blocked;

    constructor(SynqMilestoneEscrow escrow_) {
        escrow = escrow_;
    }

    function setDeal(uint256 id) external {
        dealId = id;
    }

    function onTokenReceived(address, uint256) external {
        for (uint256 i; i < 2; ++i) {
            _try(abi.encodeCall(SynqMilestoneEscrow.withdraw, (dealId, i)));
            _try(abi.encodeCall(SynqMilestoneEscrow.refund, (dealId, i)));
        }
    }

    function _try(bytes memory data) private {
        ++attempts;
        (bool ok, bytes memory ret) = address(escrow).call(data);
        if (!ok && ret.length == 4 && bytes4(ret) == SynqMilestoneEscrow.Reentrancy.selector) ++blocked;
    }
}

/// @notice Contract operator that is also its own allowlisted recipient and re-enters pay() from the token hook.
contract ReentrantOperator {
    SynqArcVaultPolicy public policy;
    address public payee;
    uint256 public blocked;

    function arm(SynqArcVaultPolicy policy_, address payee_) external {
        policy = policy_;
        payee = payee_;
    }

    function start(uint256 amount) external {
        policy.pay(payee, amount, bytes32("first"));
    }

    function reenter(uint256 amount) external {
        try policy.pay(payee, amount, bytes32("again")) {}
        catch (bytes memory ret) {
            if (bytes4(ret) == SynqArcVaultPolicy.Reentrancy.selector) ++blocked;
        }
    }
}

/// @notice Allowlisted payee whose token hook calls back into its colluding operator to re-enter pay().
contract CollidingPayee {
    ReentrantOperator internal immutable op;

    constructor(ReentrantOperator op_) {
        op = op_;
    }

    function onTokenReceived(address, uint256 amount) external {
        op.reenter(amount);
    }
}

/// @notice Recipient of an owner-approved Safe transfer that replays the owners' signatures from its hook.
contract ReplayingRecipient {
    ISafeFull internal immutable safe;
    address public to;
    uint256 public value;
    bytes public data;
    bytes public signatures;
    bool public replayRejected;

    constructor(ISafeFull safe_) {
        safe = safe_;
    }

    function arm(address to_, uint256 value_, bytes calldata data_, bytes calldata signatures_) external {
        to = to_;
        value = value_;
        data = data_;
        signatures = signatures_;
    }

    function onTokenReceived(address, uint256) external {
        _replay();
    }

    receive() external payable {
        _replay();
    }

    function _replay() private {
        try safe.execTransaction(to, value, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures) {}
        catch Error(string memory reason) {
            replayRejected = keccak256(bytes(reason)) == keccak256("GS026");
        }
    }
}

/// @notice P07-04: a reentrant hook or provider cannot drain the vault or the escrow.
contract P07_04_ReentrancyTest is ArcVaultBase {
    function test_P07_04_escrowPayeeHookCannotDoubleWithdrawOrRefund() public {
        SynqMilestoneEscrow escrow = newEscrow();
        ReentrantPayee attacker = new ReentrantPayee(escrow);
        token.setHook(address(attacker), true);
        address payer = makeAddr("payer");
        token.mint(payer, 1_000e6);
        uint128[] memory amounts = new uint128[](2);
        amounts[0] = 400e6;
        amounts[1] = 600e6;
        vm.startPrank(payer);
        token.approve(address(escrow), type(uint256).max);
        uint256 dealId = escrow.open(address(attacker), address(0), uint64(block.timestamp + 1 days), "", amounts);
        attacker.setDeal(dealId);
        escrow.release(dealId, 0);
        vm.stopPrank();

        escrow.withdraw(dealId, 0);
        assertEq(attacker.attempts(), 4);
        assertEq(attacker.blocked(), 4, "every re-entry hit the guard");
        assertEq(token.balanceOf(address(attacker)), 400e6, "paid exactly once");
        assertEq(token.balanceOf(address(escrow)), 600e6);
        assertEq(escrow.totalLiability(), 600e6);
        assertEq(uint8(escrow.milestone(dealId, 1).status), uint8(SynqMilestoneEscrow.Status.Funded));
    }

    function test_P07_04_operatorHookCannotRepeatPayment() public {
        ReentrantOperator attacker = new ReentrantOperator();
        CollidingPayee payee = new CollidingPayee(attacker);
        token.setHook(address(payee), true);
        address[] memory recipients = new address[](1);
        recipients[0] = address(payee);
        // A vault whose operator is the attacker contract and whose allowlisted payee colludes with it.
        address[] memory list = owners();
        vm.prank(creator);
        (, address account, SynqArcVaultPolicy p) =
            factory.createVault(_params(list, address(attacker), recipients), keccak256("reentrant-operator"));
        attacker.arm(p, address(payee));
        token.mint(account, 1_000e6);

        attacker.start(100e6);
        assertEq(attacker.blocked(), 1);
        assertEq(token.balanceOf(address(payee)), 100e6);
        assertEq(token.balanceOf(account), 900e6);
        assertEq(p.windowSpent(), 100e6);
    }

    function test_P07_04_safeRecipientHookCannotReplayOwnerSignatures() public {
        ReplayingRecipient attacker = new ReplayingRecipient(safe);
        token.setHook(address(attacker), true);
        bytes memory data = transferData(address(attacker), 100e6);
        bytes memory signatures = signDigest(txHash(address(token), 0, data, CALL), keys(KEY1, KEY2));
        attacker.arm(address(token), 0, data, signatures);
        vm.prank(stranger);
        safe.execTransaction(address(token), 0, data, CALL, 0, 0, 0, address(0), payable(address(0)), signatures);
        assertTrue(attacker.replayRejected());
        assertEq(token.balanceOf(address(attacker)), 100e6);
        assertEq(token.balanceOf(address(safe)), FUNDING - 100e6);
    }

    function test_P07_04_nativeRecipientCannotReplayOwnerSignatures() public {
        ReplayingRecipient attacker = new ReplayingRecipient(safe);
        bytes memory signatures = signDigest(txHash(address(attacker), 1 ether, "", CALL), keys(KEY1, KEY3));
        attacker.arm(address(attacker), 1 ether, "", signatures);
        vm.prank(stranger);
        safe.execTransaction(address(attacker), 1 ether, "", CALL, 0, 0, 0, address(0), payable(address(0)), signatures);
        assertTrue(attacker.replayRejected());
        assertEq(address(attacker).balance, 1 ether);
        assertEq(address(safe).balance, 9 ether);
    }

    function test_P07_04_escrowRefusesShortDeliveryFromHostileToken() public {
        ShortToken bad = new ShortToken();
        SynqMilestoneEscrow escrow = new SynqMilestoneEscrow(address(bad));
        bad.mint(address(this), 100e6);
        bad.approve(address(escrow), type(uint256).max);
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 100e6;
        vm.expectRevert(SynqMilestoneEscrow.InvalidAmount.selector);
        escrow.open(vendor, address(0), uint64(block.timestamp + 1), "", amounts);
    }

    function _params(address[] memory list, address op, address[] memory recipients)
        private
        view
        returns (SynqArcVaultFactory.VaultParams memory)
    {
        return SynqArcVaultFactory.VaultParams({
            owners: list,
            threshold: THRESHOLD,
            guardian: guardian,
            operator: op,
            delay: DELAY,
            recipients: recipients,
            perPaymentCap: PER_PAYMENT,
            windowCap: WINDOW_CAP
        });
    }
}

/// @notice Fee-on-transfer token: the escrow receives less than it is told it got.
contract ShortToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - amount / 100;
        return true;
    }
}
