// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ArcVaultBase} from "./ArcVaultBase.sol";
import {SynqArcVaultPolicy} from "../../../src/arc/SynqArcVaultPolicy.sol";
import {SynqArcVaultFactory} from "../../../src/arc/SynqArcVaultFactory.sol";
import {SynqMilestoneEscrow} from "../../../src/arc/SynqMilestoneEscrow.sol";
import {ISafeFull} from "../../utils/ISafeFull.sol";

/// @notice FiatToken v2.2-shaped token: EIP-3009 and EIP-2612 with `bytes signature` overloads. A contract signer
///         is validated through ERC-1271 isValidSignature(bytes32,bytes), exactly as Circle's SignatureChecker does.
contract MockFiatToken {
    string public constant name = "USDC";
    string public constant version = "2";
    uint8 public constant decimals = 6;
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 public immutable DOMAIN_SEPARATOR;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => uint256) public nonces;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferWithAuthorizationDigest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
                )
            )
        );
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "FiatTokenV2: authorization window");
        require(!authorizationState[from][nonce], "FiatTokenV2: authorization is used");
        bytes32 digest = transferWithAuthorizationDigest(from, to, value, validAfter, validBefore, nonce);
        require(_valid(from, digest, signature), "FiatTokenV2: invalid signature");
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function permitDigest(address owner, address spender, uint256 value, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, nonces[owner], deadline))
            )
        );
    }

    function permit(address owner, address spender, uint256 value, uint256 deadline, bytes memory signature) external {
        require(deadline >= block.timestamp, "FiatTokenV2: permit is expired");
        require(_valid(owner, permitDigest(owner, spender, value, deadline), signature), "EIP2612: invalid signature");
        nonces[owner]++;
        allowance[owner][spender] = value;
    }

    function _valid(address signer, bytes32 digest, bytes memory signature) private view returns (bool) {
        if (signer.code.length == 0) {
            if (signature.length != 65) return false;
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
            return ecrecover(digest, v, r, s) == signer;
        }
        (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(bytes4(0x1626ba7e), digest, signature));
        return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == bytes4(0x1626ba7e);
    }
}

interface ISafeMessages {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
    function getModules() external view returns (address[] memory);
    function getMessageHash(bytes calldata message) external view returns (bytes32);
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface ISafeProxyFactoryLike {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address);
}

/// @notice Regression tests for the independent critic's findings on the first Arc vault commit. Each test failed
///         against that commit. New entry points are reached by low-level call so this file compiled against it.
contract ArcVaultCriticFindingsTest is ArcVaultBase {
    bytes32 internal constant SAFE_MSG_TYPEHASH = keccak256("SafeMessage(bytes message)");

    // ---------------------------------------------------------------- F1 (HIGH): pause holds against the quorum

    function _queueAndExpectEarly(bytes memory data) internal returns (bytes32 id) {
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(policy), 0, data, CALL)));
        id = policy.operationId(address(policy), 0, data, CALL);
    }

    function test_F1_P07_06_quorumCannotUnpauseOrSwapGuardianInstantly() public {
        vm.prank(guardian);
        policy.pause();
        bytes memory unpause = abi.encodeCall(SynqArcVaultPolicy.unpause, ());
        execExpectRevert(
            address(policy),
            0,
            unpause,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(
                SynqArcVaultPolicy.NotQueued.selector, policy.operationId(address(policy), 0, unpause, CALL)
            )
        );
        bytes memory swap = abi.encodeCall(SynqArcVaultPolicy.setGuardian, (stranger));
        execExpectRevert(
            address(policy),
            0,
            swap,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(
                SynqArcVaultPolicy.NotQueued.selector, policy.operationId(address(policy), 0, swap, CALL)
            )
        );
        assertTrue(policy.paused());
        assertEq(policy.guardian(), guardian);
    }

    function testFuzz_F1_P07_06_pauseHoldsAgainstQuorumForMinOfMaxPauseAndDelay(uint256 elapsed) public {
        uint256 pausedAt = block.timestamp;
        vm.prank(guardian);
        policy.pause();
        // A stolen quorum queues the unpause at once.
        bytes memory unpause = abi.encodeCall(SynqArcVaultPolicy.unpause, ());
        bytes32 id = _queueAndExpectEarly(unpause);
        uint256 hold = DELAY < policy.MAX_PAUSE() ? DELAY : policy.MAX_PAUSE();
        elapsed = bound(elapsed, 0, hold - 1);
        vm.warp(pausedAt + elapsed);
        execExpectRevert(
            address(policy),
            0,
            unpause,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.NotReady.selector, id, policy.eta(id))
        );
        execExpectRevert(
            address(token),
            0,
            transferData(stranger, 1e6),
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.OutflowsPaused.selector)
        );
        assertEq(token.balanceOf(address(safe)), FUNDING);
    }

    function test_F1_P07_06_timelockedUnpauseRunsWhilePausedAndGuardianStillUnpausesInstantly() public {
        vm.prank(guardian);
        policy.pause();
        timelocked(address(policy), 0, abi.encodeCall(SynqArcVaultPolicy.unpause, ()), CALL);
        assertFalse(policy.paused());

        vm.warp(vm.getBlockTimestamp() + policy.PAUSE_COOLDOWN());
        vm.prank(guardian);
        policy.pause();
        vm.prank(guardian);
        policy.unpause();
        assertFalse(policy.paused());
    }

    function test_F1_P07_06_pauseOutlastsDelayLongerThanMaxPause() public {
        address[] memory recipients = new address[](0);
        SynqArcVaultFactory.VaultParams memory p = SynqArcVaultFactory.VaultParams({
            owners: owners(),
            threshold: THRESHOLD,
            guardian: guardian,
            operator: operator,
            delay: 10 days,
            recipients: recipients,
            perPaymentCap: 0,
            windowCap: 0
        });
        vm.prank(creator);
        (, address account, SynqArcVaultPolicy slow) = factory.createVault(p, keccak256("slow"));
        safe = ISafeFull(account);
        policy = slow;
        token.mint(account, 1e6);
        vm.prank(guardian);
        slow.pause();
        bytes memory unpause = abi.encodeCall(SynqArcVaultPolicy.unpause, ());
        execExpectRevert(
            address(slow),
            0,
            unpause,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(
                SynqArcVaultPolicy.NotQueued.selector, slow.operationId(address(slow), 0, unpause, CALL)
            )
        );
        _queueAndExpectEarly(unpause);
        vm.warp(block.timestamp + slow.MAX_PAUSE() - 1);
        execExpectRevert(
            address(token),
            0,
            transferData(stranger, 1e6),
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(SynqArcVaultPolicy.OutflowsPaused.selector)
        );
    }

    // ---------------------------------------------------------------- F2 (HIGH): ERC-1271 bypass of the guard

    function _ownerSafeMessageSigs(ISafeFull account, bytes32 digest) internal view returns (bytes memory) {
        bytes32 safeMessageHash = keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256(abi.encode(digest))));
        bytes32 messageHash =
            keccak256(abi.encodePacked(bytes1(0x19), bytes1(0x01), account.domainSeparator(), safeMessageHash));
        return signDigest(messageHash, keys(KEY1, KEY2));
    }

    function _stockHandlerSafe() internal returns (ISafeFull account) {
        bytes memory initializer = abi.encodeCall(
            ISafeFull.setup, (owners(), 2, address(0), "", fallbackHandler, address(0), 0, payable(address(0)))
        );
        account =
            ISafeFull(ISafeProxyFactoryLike(safeProxyFactory).createProxyWithNonce(safeSingleton, initializer, 99));
    }

    function test_F2_control_stockHandlerLetsOwnerSignaturesMoveFiatTokenWithoutSafeTx() public {
        MockFiatToken fiat = new MockFiatToken();
        ISafeFull stock = _stockHandlerSafe();
        fiat.mint(address(stock), 100e6);
        bytes32 nonce = keccak256("n");
        bytes32 digest =
            fiat.transferWithAuthorizationDigest(address(stock), stranger, 100e6, 0, type(uint256).max, nonce);
        bytes memory sig = _ownerSafeMessageSigs(stock, digest);
        fiat.transferWithAuthorization(address(stock), stranger, 100e6, 0, type(uint256).max, nonce, sig);
        assertEq(fiat.balanceOf(stranger), 100e6, "the class of attack the Synq handler closes");
        assertEq(stock.nonce(), 0, "no Safe transaction ran");
    }

    function test_F2_P07_01_ownerSignaturesCannotMoveFiatTokenThroughErc1271() public {
        MockFiatToken fiat = new MockFiatToken();
        fiat.mint(address(safe), 100e6);
        bytes32 nonce = keccak256("n");
        bytes32 digest =
            fiat.transferWithAuthorizationDigest(address(safe), stranger, 100e6, 0, type(uint256).max, nonce);
        bytes memory sig = _ownerSafeMessageSigs(safe, digest);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        fiat.transferWithAuthorization(address(safe), stranger, 100e6, 0, type(uint256).max, nonce, sig);

        bytes32 permitDigest = fiat.permitDigest(address(safe), stranger, type(uint256).max, type(uint256).max);
        bytes memory permitSig = _ownerSafeMessageSigs(safe, permitDigest);
        vm.expectRevert(bytes("EIP2612: invalid signature"));
        fiat.permit(address(safe), stranger, type(uint256).max, type(uint256).max, permitSig);

        assertEq(fiat.balanceOf(address(safe)), 100e6);
        assertEq(fiat.allowance(address(safe), stranger), 0);
        assertNotEq(ISafeMessages(address(safe)).isValidSignature(digest, sig), bytes4(0x1626ba7e));
    }

    function test_F2_P07_06_timelockedSignedMessageIsHonouredOnlyWhileUnpaused() public {
        address lib = deployCode("out/SignMessageLib.sol/SignMessageLib.json");
        bytes32 digest = keccak256("synq-arc-1271-approval");
        bytes memory signData = abi.encodeWithSignature("signMessage(bytes)", abi.encode(digest));
        timelocked(lib, 0, signData, DELEGATECALL);
        assertEq(ISafeMessages(address(safe)).isValidSignature(digest, ""), bytes4(0x1626ba7e));
        vm.prank(guardian);
        policy.pause();
        assertNotEq(ISafeMessages(address(safe)).isValidSignature(digest, ""), bytes4(0x1626ba7e));
    }

    function test_F2_handlerKeepsSafeToolingFunctions() public {
        address[] memory mods = ISafeMessages(address(safe)).getModules();
        assertEq(mods.length, 1);
        assertEq(mods[0], address(policy));
        assertEq(ISafeMessages(address(safe)).onERC721Received(address(0), address(0), 0, ""), bytes4(0x150b7a02));
        assertTrue(ISafeMessages(address(safe)).supportsInterface(0x150b7a02));
        bytes32 expected = keccak256(
            abi.encodePacked(
                bytes1(0x19),
                bytes1(0x01),
                safe.domainSeparator(),
                keccak256(abi.encode(SAFE_MSG_TYPEHASH, keccak256("m")))
            )
        );
        assertEq(ISafeMessages(address(safe)).getMessageHash("m"), expected);
        assertNotEq(factory.fallbackHandler(), fallbackHandler, "not the stock CompatibilityFallbackHandler");
    }

    // ---------------------------------------------------------------- F3 (MEDIUM): permanent escrow dispute

    function _disputedDeal()
        internal
        returns (SynqMilestoneEscrow escrow, uint256 dealId, address payer, address payee)
    {
        escrow = newEscrow();
        payer = makeAddr("payer");
        payee = makeAddr("payee");
        token.mint(payer, 100e6);
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 100e6;
        vm.startPrank(payer);
        token.approve(address(escrow), type(uint256).max);
        dealId = escrow.open(payee, makeAddr("arbiter"), uint64(block.timestamp + 1 days), "", amounts);
        vm.stopPrank();
        vm.prank(payee);
        escrow.dispute(dealId);
    }

    function test_F3_P07_05_timeoutRefundResumesAfterDisputeDeadline() public {
        (SynqMilestoneEscrow escrow, uint256 dealId, address payer,) = _disputedDeal();
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(SynqMilestoneEscrow.DealDisputed.selector);
        escrow.refund(dealId, 0);
        vm.warp(block.timestamp + 365 days);
        vm.prank(stranger);
        escrow.refund(dealId, 0);
        assertEq(token.balanceOf(payer), 100e6);
    }

    function test_F3_P07_05_raiserCanWithdrawDisputeButOthersCannot() public {
        (SynqMilestoneEscrow escrow, uint256 dealId, address payer, address payee) = _disputedDeal();
        vm.prank(payer);
        (bool ok,) = address(escrow).call(abi.encodeWithSignature("withdrawDispute(uint256)", dealId));
        assertFalse(ok, "only the party that raised it");
        vm.prank(payee);
        (ok,) = address(escrow).call(abi.encodeWithSignature("withdrawDispute(uint256)", dealId));
        assertTrue(ok, "raiser withdraws");
        vm.prank(payer);
        escrow.release(dealId, 0);
        escrow.withdraw(dealId, 0);
        assertEq(token.balanceOf(payee), 100e6);
    }

    function test_F3_P07_05_eachPartyDisputesAtMostOnceAndPayerCannotBurnPayeeRight() public {
        (SynqMilestoneEscrow escrow, uint256 dealId, address payer, address payee) = _disputedDeal();
        // Payee raised in the fixture; it cannot renew after withdrawing or lapsing.
        vm.prank(payee);
        escrow.withdrawDispute(dealId);
        vm.prank(payee);
        vm.expectRevert(SynqMilestoneEscrow.DisputeAlreadyUsed.selector);
        escrow.dispute(dealId);
        // The payer gets its own single dispute; while active the payee cannot stack another.
        vm.prank(payer);
        escrow.dispute(dealId);
        assertTrue(escrow.disputeActive(dealId));
        vm.prank(payee);
        vm.expectRevert(SynqMilestoneEscrow.DealDisputed.selector);
        escrow.dispute(dealId);
        // After the payer's dispute lapses, no further dispute can be raised and payer release resumes.
        vm.warp(vm.getBlockTimestamp() + escrow.DISPUTE_PERIOD());
        assertFalse(escrow.disputeActive(dealId));
        vm.prank(payer);
        vm.expectRevert(SynqMilestoneEscrow.DisputeAlreadyUsed.selector);
        escrow.dispute(dealId);
        vm.prank(payer);
        escrow.release(dealId, 0);
    }

    function test_F3_P07_05_payerRaiseAndWithdrawLeavesPayeeItsDispute() public {
        SynqMilestoneEscrow escrow = newEscrow();
        address payer = makeAddr("payer2");
        address payee = makeAddr("payee2");
        token.mint(payer, 10e6);
        uint128[] memory amounts = new uint128[](1);
        amounts[0] = 10e6;
        vm.startPrank(payer);
        token.approve(address(escrow), type(uint256).max);
        uint256 dealId = escrow.open(payee, makeAddr("arbiter2"), uint64(vm.getBlockTimestamp() + 1 days), "", amounts);
        escrow.dispute(dealId);
        escrow.withdrawDispute(dealId);
        vm.stopPrank();
        vm.prank(payee);
        escrow.dispute(dealId);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert(SynqMilestoneEscrow.DealDisputed.selector);
        escrow.refund(dealId, 0);
    }

    // ---------------------------------------------------------------- F4 (LOW): expired op blocks its id

    function test_F4_P07_07_expiredOperationCanBeRequeued() public {
        bytes memory data = abi.encodeCall(safe.changeThreshold, (3));
        bytes memory q = abi.encodeCall(SynqArcVaultPolicy.queue, (address(safe), 0, data, CALL));
        quorum(address(policy), q);
        bytes32 id = policy.operationId(address(safe), 0, data, CALL);
        vm.warp(policy.eta(id) + policy.GRACE_PERIOD() + 1);
        quorum(address(policy), q);
        assertEq(policy.eta(id), block.timestamp + DELAY);
        vm.warp(block.timestamp + DELAY);
        assertTrue(exec(address(safe), 0, data, CALL, keys(KEY1, KEY2)));
        assertEq(safe.getThreshold(), 3);
    }

    // ---------------------------------------------------------------- F5 (LOW): unbound replacement guard bricks

    function test_F5_P07_07_unboundReplacementGuardIsRefused() public {
        address[] memory none = new address[](0);
        SynqArcVaultPolicy unbound = new SynqArcVaultPolicy(address(token), DELAY, guardian, operator, none, 0, 0);
        bytes memory data = abi.encodeCall(safe.setGuard, (address(unbound)));
        quorum(address(policy), abi.encodeCall(SynqArcVaultPolicy.queue, (address(safe), 0, data, CALL)));
        vm.warp(block.timestamp + DELAY);
        execExpectRevert(
            address(safe),
            0,
            data,
            CALL,
            keys(KEY1, KEY2),
            abi.encodeWithSelector(bytes4(keccak256("InvalidReplacement(address)")), address(unbound))
        );
        // The Safe still works.
        assertTrue(exec(address(token), 0, transferData(stranger, 1e6), CALL, keys(KEY1, KEY2)));
    }

    function test_F5_P07_07_factoryReplacementPolicyIsBoundAndSwapsCleanly() public {
        address[] memory recipients = new address[](1);
        recipients[0] = vendor;
        bytes memory deploy = abi.encodeWithSignature(
            "deployReplacementPolicy(address,address,uint256,address[],uint256,uint256,bytes32)",
            guardian,
            operator,
            DELAY,
            recipients,
            PER_PAYMENT,
            WINDOW_CAP,
            bytes32("v2")
        );
        // Only the Safe can mint its own replacement (a quorum transaction).
        vm.prank(stranger);
        (bool ok,) = address(factory).call(deploy);
        assertFalse(ok);
        vm.prank(address(safe));
        bytes memory ret;
        (ok, ret) = address(factory).call(deploy);
        assertTrue(ok, "replacement deploy");
        address replacement = abi.decode(ret, (address));
        assertEq(SynqArcVaultPolicy(replacement).safe(), address(safe));
        timelocked(address(safe), 0, abi.encodeCall(safe.setGuard, (replacement)), CALL);
        assertEq(guardOf(safe), replacement);
        assertTrue(exec(address(token), 0, transferData(stranger, 1e6), CALL, keys(KEY1, KEY2)));
    }

    // ---------------------------------------------------------------- F6 (LOW): endless re-pause

    function test_F6_P07_06_guardianCannotRepauseWithoutCooldown() public {
        uint256 t = vm.getBlockTimestamp();
        vm.startPrank(guardian);
        policy.pause();
        policy.unpause();
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.PauseCooldown.selector, t + 2 days));
        policy.pause();
        vm.stopPrank();
        assertFalse(policy.paused());

        vm.warp(t + 30 days);
        vm.prank(guardian);
        policy.pause();
        uint256 until = t + 30 days + 7 days;
        vm.warp(until);
        assertFalse(policy.paused());
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.PauseCooldown.selector, until + 2 days));
        policy.pause();
        // The cooldown is an outflow window for the owners.
        assertTrue(exec(address(token), 0, transferData(stranger, 1e6), CALL, keys(KEY1, KEY2)));
        vm.warp(until + 2 days);
        vm.prank(guardian);
        policy.pause();
        assertTrue(policy.paused());
    }

    // ---------------------------------------------------------------- F7 (LOW): operator as its own recipient

    function test_F7_P07_02_operatorCannotBeItsOwnRecipient() public {
        address[] memory recipients = new address[](1);
        recipients[0] = operator;
        SynqArcVaultFactory.VaultParams memory p = SynqArcVaultFactory.VaultParams({
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
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultFactory.InvalidRole.selector, operator));
        factory.createVault(p, keccak256("self-pay"));

        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.InvalidAddress.selector, operator));
        new SynqArcVaultPolicy(address(token), DELAY, guardian, operator, recipients, 0, 0);

        vm.startPrank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.InvalidAddress.selector, operator));
        policy.addRecipient(operator);
        vm.expectRevert(abi.encodeWithSelector(SynqArcVaultPolicy.InvalidAddress.selector, vendor));
        policy.setOperator(vendor);
        vm.stopPrank();
    }
}
