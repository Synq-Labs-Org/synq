// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {ExecutionModule} from "../../src/ExecutionModule.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {LocalTestToken} from "../../src/test/LocalTestToken.sol";
import {ISafeFull} from "../utils/ISafeFull.sol";

/// @notice Active invariant handler: mixes valid delegated spends with deliberate violation attempts and keeps an
///         expected-outcome model. Any success the model forbids sets a violation flag; any valid action the
///         contracts reject sets `unexpectedRejection`.
contract SynqHandler is CommonBase, StdUtils {
    struct Context {
        ISafeFull safe;
        ExecutionModule module;
        MandateRegistry registry;
        LocalTestToken token;
        address factory;
        address executor;
        address recipient;
        address vault;
        bytes32 groupId;
        bytes32 mandateId;
        uint256 key1;
        uint256 key2;
        uint256 key3;
        uint256 maxToken;
        uint256 maxNative;
        uint256 cumToken;
        uint256 cumNative;
        uint256 validAfter;
        uint256 validUntil;
    }

    struct Executed {
        ExecutionModule.ExecutionGrant grant;
        bytes data;
        bytes signatures;
    }

    Context internal ctx;
    Executed[] internal executed;
    uint256 internal nextNonce = 1_000;

    bool public paused;
    bool public revoked;
    uint256 public currentVersion = 1;
    uint256 public minValidVersion = 1;
    mapping(uint256 version => uint256) public tokenCapOf;
    mapping(uint256 version => uint256) public nativeCapOf;

    uint256 public ghostTokenSpent;
    uint256 public ghostNativeSpent;
    uint256 public ghostTokenRecovered;
    uint256 public ghostNativeRecovered;

    bool public violationUnauthorized;
    bool public violationExpired;
    bool public violationRevoked;
    bool public violationReplay;
    bool public violationGovernance;
    bool public violationOverCap;
    bool public violationDisallowedCall;
    bool public violationPaused;
    bool public violationRecoveryBlocked;
    bool public violationStaleVersion;
    bool public violationRecipient;
    bool public unexpectedRejection;

    mapping(bytes32 action => uint256) public calls;
    mapping(bytes32 action => uint256) public successes;

    constructor(Context memory context) {
        ctx = context;
        tokenCapOf[1] = context.cumToken;
        nativeCapOf[1] = context.cumNative;
    }

    // ------------------------------------------------------------------ valid-looking spends (model-checked)

    function spendToken(uint256 amount, bool stale) external {
        calls["spendToken"]++;
        amount = bound(amount, 1, (ctx.maxToken * 5) / 4);
        uint256 version = stale && currentVersion > 1 ? currentVersion - 1 : currentVersion;
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _tokenGrant(amount, ctx.recipient);
        grant.mandateVersion = version;
        bool overCap = amount > ctx.maxToken || ghostTokenSpent + amount > _min(tokenCapOf[version], tokenCapOf[currentVersion]);
        bool staleInvalid = version < minValidVersion;
        bool expected = !paused && !revoked && !staleInvalid && !overCap && _inMandateWindow();
        if (_execute(grant, data)) {
            successes["spendToken"]++;
            if (paused) violationPaused = true;
            if (revoked) violationRevoked = true;
            if (staleInvalid) violationStaleVersion = true;
            if (overCap) violationOverCap = true;
            if (!_inMandateWindow()) violationExpired = true;
            ghostTokenSpent += amount;
        } else if (expected) {
            unexpectedRejection = true;
        }
    }

    function spendNative(uint256 value, bool stale) external {
        calls["spendNative"]++;
        value = bound(value, 1, (ctx.maxNative * 5) / 4);
        uint256 version = stale && currentVersion > 1 ? currentVersion - 1 : currentVersion;
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _nativeGrant(value);
        grant.mandateVersion = version;
        bool overCap =
            value > ctx.maxNative || ghostNativeSpent + value > _min(nativeCapOf[version], nativeCapOf[currentVersion]);
        bool staleInvalid = version < minValidVersion;
        bool expected = !paused && !revoked && !staleInvalid && !overCap && _inMandateWindow();
        if (_execute(grant, data)) {
            successes["spendNative"]++;
            if (paused) violationPaused = true;
            if (revoked) violationRevoked = true;
            if (staleInvalid) violationStaleVersion = true;
            if (overCap) violationOverCap = true;
            if (!_inMandateWindow()) violationExpired = true;
            ghostNativeSpent += value;
        } else if (expected) {
            unexpectedRejection = true;
        }
    }

    // ------------------------------------------------------------------ violation attempts

    function replay(uint256 index) external {
        calls["replay"]++;
        if (executed.length == 0) return;
        Executed storage previous = executed[bound(index, 0, executed.length - 1)];
        vm.prank(ctx.executor);
        try ctx.module.execute(previous.grant, previous.data, previous.signatures) {
            violationReplay = true;
        } catch {}
    }

    function unauthorizedExecutor(uint256 amount, address caller, bool namedInGrant) external {
        calls["unauthorizedExecutor"]++;
        if (caller == ctx.executor) caller = address(0xBAD);
        amount = bound(amount, 1, ctx.maxToken);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _tokenGrant(amount, ctx.recipient);
        if (namedInGrant) grant.executor = caller;
        bytes memory signatures = _signGrant(grant, ctx.key1, ctx.key2);
        vm.prank(caller);
        try ctx.module.execute(grant, data, signatures) {
            violationUnauthorized = true;
        } catch {}
    }

    function forgedSignatures(uint256 amount, uint256 fakeKeySeed) external {
        calls["forgedSignatures"]++;
        amount = bound(amount, 1, ctx.maxToken);
        uint256 fakeKey = bound(fakeKeySeed, 1, 1_000_000) + 0xFA0000;
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _tokenGrant(amount, ctx.recipient);
        bytes memory signatures = _signGrant(grant, ctx.key1, fakeKey);
        vm.prank(ctx.executor);
        try ctx.module.execute(grant, data, signatures) {
            violationUnauthorized = true;
        } catch {}
    }

    function expiredGrant(uint256 amount, uint256 age) external {
        calls["expiredGrant"]++;
        amount = bound(amount, 1, ctx.maxToken);
        age = bound(age, 0, 3 days);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _tokenGrant(amount, ctx.recipient);
        grant.validUntil = block.timestamp - age;
        grant.validAfter = grant.validUntil > 1 hours ? grant.validUntil - 1 hours : 0;
        if (_execute(grant, data)) violationExpired = true;
    }

    function nonAllowlistedRecipient(uint256 amount, uint8 choice, address arbitrary) external {
        calls["nonAllowlistedRecipient"]++;
        amount = bound(amount, 1, ctx.maxToken);
        address[6] memory sinks = [
            address(ctx.module), address(ctx.registry), address(ctx.token), ctx.factory, address(ctx.safe), arbitrary
        ];
        address to = sinks[choice % 6];
        if (to == ctx.recipient) to = address(0xD00D);
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _tokenGrant(amount, to);
        if (_execute(grant, data)) violationRecipient = true;
    }

    function disallowedCall(uint256 amount, uint8 choice) external {
        calls["disallowedCall"]++;
        amount = bound(amount, 1, ctx.maxToken);
        (ExecutionModule.ExecutionGrant memory grant,) = _tokenGrant(amount, ctx.recipient);
        bytes memory data;
        uint8 c = choice % 5;
        if (c == 0) {
            data = abi.encodeWithSelector(bytes4(0x095ea7b3), ctx.recipient, type(uint256).max);
        } else if (c == 1) {
            data = abi.encodeWithSelector(bytes4(0x23b872dd), address(ctx.safe), ctx.recipient, amount);
        } else if (c == 2) {
            data = abi.encodeCall(ISafeFull.addOwnerWithThreshold, (ctx.executor, 1));
            grant.target = address(ctx.safe);
        } else if (c == 3) {
            data = abi.encodeCall(ExecutionModule.unpause, ());
            grant.target = address(ctx.module);
        } else {
            data = abi.encodeCall(MandateRegistry.setModule, (ctx.executor));
            grant.target = address(ctx.registry);
        }
        grant.selector = bytes4(data);
        grant.calldataHash = keccak256(data);
        if (_execute(grant, data)) violationDisallowedCall = true;
    }

    function governanceAttack(uint8 choice, address newOwner) external {
        calls["governanceAttack"]++;
        if (newOwner == address(0) || newOwner == address(1)) newOwner = address(0xA77AC);
        bytes memory payload;
        uint8 c = choice % 4;
        if (c == 0) payload = abi.encodeCall(ISafeFull.addOwnerWithThreshold, (newOwner, 1));
        else if (c == 1) payload = abi.encodeCall(ISafeFull.changeThreshold, (1));
        else if (c == 2) payload = abi.encodeCall(ISafeFull.enableModule, (newOwner));
        else payload = abi.encodeCall(ISafeFull.disableModule, (address(1), address(ctx.module)));
        vm.prank(ctx.executor);
        (bool ok,) = address(ctx.safe).call(payload);
        if (ok) violationGovernance = true;
        vm.prank(ctx.executor);
        (ok,) = address(ctx.safe).call(
            abi.encodeCall(ISafeFull.execTransactionFromModule, (address(ctx.safe), 0, payload, 1))
        );
        if (ok) violationGovernance = true;
    }

    // ------------------------------------------------------------------ owner-quorum governance

    function togglePause(uint256 seed) external {
        calls["togglePause"]++;
        if (paused ? seed % 4 == 0 : seed % 4 != 0) return;
        bytes memory payload =
            paused ? abi.encodeCall(ExecutionModule.unpause, ()) : abi.encodeCall(ExecutionModule.pause, ());
        if (_safeExec(address(ctx.module), 0, payload)) {
            paused = !paused;
        } else {
            unexpectedRejection = true;
        }
    }

    function revoke(uint256 seed) external {
        calls["revoke"]++;
        if (revoked || seed % 40 != 0) return;
        if (_safeExec(address(ctx.registry), 0, abi.encodeCall(MandateRegistry.revokeMandate, (ctx.mandateId)))) {
            revoked = true;
        } else {
            unexpectedRejection = true;
        }
    }

    function supersede(bool sensitive, uint256 tokenCap, uint256 nativeCap) external {
        calls["supersede"]++;
        if (revoked || block.timestamp >= ctx.validUntil) return;
        tokenCap = bound(tokenCap, ctx.cumToken / 2, 2 * ctx.cumToken);
        nativeCap = bound(nativeCap, ctx.cumNative / 2, 2 * ctx.cumNative);
        uint256 next = currentVersion + 1;
        MandateRegistry.MandateConfig memory config = _config(tokenCap, nativeCap);
        if (
            _safeExec(
                address(ctx.registry),
                0,
                abi.encodeCall(MandateRegistry.supersedeMandate, (ctx.mandateId, next, config, sensitive))
            )
        ) {
            currentVersion = next;
            tokenCapOf[next] = tokenCap;
            nativeCapOf[next] = nativeCap;
            if (sensitive) minValidVersion = next;
        } else {
            unexpectedRejection = true;
        }
    }

    function ownerRecovery(uint256 amount, bool native) external {
        calls["ownerRecovery"]++;
        bool ok;
        if (native) {
            amount = bound(amount, 0, address(ctx.safe).balance / 100);
            ok = _safeExec(ctx.vault, amount, "");
            if (ok) ghostNativeRecovered += amount;
        } else {
            amount = bound(amount, 0, ctx.token.balanceOf(address(ctx.safe)) / 100);
            ok = _safeExec(address(ctx.token), 0, abi.encodeWithSelector(bytes4(0xa9059cbb), ctx.vault, amount));
            if (ok) ghostTokenRecovered += amount;
        }
        if (!ok) violationRecoveryBlocked = true;
    }

    function warp(uint256 dt) external {
        calls["warp"]++;
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
    }

    function executedCount() external view returns (uint256) {
        return executed.length;
    }

    // ------------------------------------------------------------------ internals

    function _execute(ExecutionModule.ExecutionGrant memory grant, bytes memory data) internal returns (bool ok) {
        bytes memory signatures = _signGrant(grant, ctx.key1, ctx.key2);
        vm.prank(ctx.executor);
        try ctx.module.execute(grant, data, signatures) {
            ok = true;
            Executed storage record = executed.push();
            record.grant = grant;
            record.data = data;
            record.signatures = signatures;
        } catch {}
    }

    function _safeExec(address to, uint256 value, bytes memory data) internal returns (bool) {
        ISafeFull safe = ctx.safe;
        bytes32 txHash = safe.getTransactionHash(to, value, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        bytes memory signatures = _sign(txHash, ctx.key2, ctx.key3);
        try safe.execTransaction(to, value, data, 0, 0, 0, 0, address(0), payable(address(0)), signatures) returns (
            bool success
        ) {
            return success;
        } catch {
            return false;
        }
    }

    function _tokenGrant(uint256 amount, address to)
        internal
        returns (ExecutionModule.ExecutionGrant memory grant, bytes memory data)
    {
        data = abi.encodeWithSelector(bytes4(0xa9059cbb), to, amount);
        uint256 nonce = nextNonce++;
        grant = ExecutionModule.ExecutionGrant({
            groupId: ctx.groupId,
            account: address(ctx.safe),
            mandateId: ctx.mandateId,
            mandateVersion: currentVersion,
            executor: ctx.executor,
            pluginId: keccak256("synq.plugin.invariant"),
            chainId: block.chainid,
            target: address(ctx.token),
            selector: bytes4(0xa9059cbb),
            calldataHash: keccak256(data),
            token: address(ctx.token),
            maxInputAmount: amount,
            nativeValue: 0,
            minOutputAmount: amount,
            recipient: to,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 1 hours,
            nonce: nonce,
            intentHash: keccak256(abi.encode("invariant-intent", nonce))
        });
    }

    function _nativeGrant(uint256 value)
        internal
        returns (ExecutionModule.ExecutionGrant memory grant, bytes memory data)
    {
        (grant, data) = _tokenGrant(1, ctx.recipient);
        data = "";
        grant.target = ctx.recipient;
        grant.selector = bytes4(0);
        grant.calldataHash = keccak256(data);
        grant.token = address(0);
        grant.maxInputAmount = 0;
        grant.nativeValue = value;
        grant.minOutputAmount = value;
    }

    function _signGrant(ExecutionModule.ExecutionGrant memory grant, uint256 a, uint256 b)
        internal
        view
        returns (bytes memory)
    {
        return _sign(ctx.module.hashGrant(grant), a, b);
    }

    function _sign(bytes32 digest, uint256 a, uint256 b) internal pure returns (bytes memory) {
        if (vm.addr(a) > vm.addr(b)) (a, b) = (b, a);
        (uint8 va, bytes32 ra, bytes32 sa) = vm.sign(a, digest);
        (uint8 vb, bytes32 rb, bytes32 sb) = vm.sign(b, digest);
        return abi.encodePacked(ra, sa, va, rb, sb, vb);
    }

    function _config(uint256 tokenCap, uint256 nativeCap)
        internal
        view
        returns (MandateRegistry.MandateConfig memory config)
    {
        address[] memory targets = new address[](2);
        bytes4[] memory selectors = new bytes4[](2);
        targets[0] = address(ctx.token);
        selectors[0] = bytes4(0xa9059cbb);
        targets[1] = ctx.recipient;
        address[] memory recipients = new address[](1);
        recipients[0] = ctx.recipient;
        config = MandateRegistry.MandateConfig({
            mandateHash: keccak256(abi.encode("mandate", currentVersion + 1)),
            token: address(ctx.token),
            maxTokenPerAction: ctx.maxToken,
            maxNativePerAction: ctx.maxNative,
            cumulativeTokenCap: tokenCap,
            cumulativeNativeCap: nativeCap,
            validAfter: ctx.validAfter,
            validUntil: ctx.validUntil,
            callTargets: targets,
            callSelectors: selectors,
            recipients: recipients
        });
    }

    function _inMandateWindow() internal view returns (bool) {
        return block.timestamp >= ctx.validAfter && block.timestamp < ctx.validUntil;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}
