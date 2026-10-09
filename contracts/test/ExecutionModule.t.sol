// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SandboxAccount} from "../src/SandboxAccount.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {ExecutionModule} from "../src/ExecutionModule.sol";

interface Vm {
    function addr(uint256 key) external returns (address);
    function sign(uint256 key, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function deal(address who, uint256 amount) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
    function prank(address who) external;
    function expectRevert() external;
    function expectRevert(bytes calldata reason) external;
}

contract TestToken {
    mapping(address => uint256) public balanceOf;
    bool public fee;
    bool public noTransfer;
    bool public extraDebit;

    function mint(address owner, uint256 amount) external {
        balanceOf[owner] += amount;
    }

    function modes(bool f, bool n, bool e) external {
        fee = f;
        noTransfer = n;
        extraDebit = e;
    }

    function transfer(address recipient, uint256 amount) external returns (bool) {
        if (noTransfer) return false;
        balanceOf[msg.sender] -= amount + (extraDebit ? 1 : 0);
        balanceOf[recipient] += amount - (fee ? 1 : 0);
        return true;
    }
}

contract ReentrantRecipient {
    ExecutionModule private module;
    ExecutionModule.ExecutionGrant private grant;
    bytes private signatures;
    bool public blocked;

    function start(ExecutionModule module_, ExecutionModule.ExecutionGrant calldata grant_, bytes calldata sig)
        external
    {
        module = module_;
        grant = grant_;
        signatures = sig;
        module.execute(grant, "", signatures);
    }

    receive() external payable {
        try module.execute(grant, "", signatures) {}
        catch {
            blocked = true;
        }
    }
}

abstract contract Fixture {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SandboxAccount account;
    MandateRegistry registry;
    ExecutionModule module;
    address executor = address(0xE);
    address recipient = address(0xBEEF);
    bytes32 constant ID = keccak256("mandate");
    bytes32 constant GROUP = keccak256("group");

    function setUp() public virtual {
        vm.warp(1000);
        account = new SandboxAccount([vm.addr(1), vm.addr(2), vm.addr(3)]);
        registry = new MandateRegistry(address(account), GROUP);
        module = new ExecutionModule(address(account), address(registry));
        ownerCall(address(account), abi.encodeCall(account.setModule, (address(module), true)));
        configure(ID, 1, recipient, address(0), 100, 200, 100);
        vm.deal(address(account), 1000);
    }

    function signatures(bytes32 digest) internal returns (bytes memory) {
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(2, digest);
        if (vm.addr(1) < vm.addr(2)) return abi.encodePacked(r1, s1, v1, r2, s2, v2);
        return abi.encodePacked(r2, s2, v2, r1, s1, v1);
    }

    function ownerCall(address target, bytes memory data) internal {
        bytes32 digest = account.ownerTransactionHash(target, 0, data, account.ownerNonce());
        account.ownerExecute(target, 0, data, signatures(digest));
    }

    function configure(
        bytes32 id,
        uint256 version,
        address target,
        address token,
        uint256 perCall,
        uint256 cap,
        uint256 value
    ) internal {
        MandateRegistry.Mandate memory m = MandateRegistry.Mandate(
            target, token == address(0) ? bytes4(0) : bytes4(0xa9059cbb), token, perCall, cap, value, 2000
        );
        ownerCall(address(registry), abi.encodeCall(registry.configure, (id, version, m)));
    }

    function grant(uint256 nonce, uint256 value) internal view returns (ExecutionModule.ExecutionGrant memory g) {
        g = ExecutionModule.ExecutionGrant(
            keccak256(abi.encode("intent", nonce)),
            ID,
            1,
            executor,
            recipient,
            0x00000000,
            keccak256(""),
            address(0),
            0,
            value,
            1000,
            2000,
            nonce,
            keccak256("plugin"),
            0,
            block.chainid
        );
    }

    function localHashGrant(ExecutionModule.ExecutionGrant memory g) internal view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"
                ),
                keccak256("SynqExecutionModule"),
                keccak256("1"),
                block.chainid,
                address(module),
                keccak256(abi.encode(address(account), GROUP))
            )
        );
        bytes32 typeHash = keccak256(
            "ExecutionGrant(bytes32 intentHash,bytes32 mandateId,uint256 mandateVersion,address executor,address target,bytes4 selector,bytes32 calldataHash,address inputToken,uint256 maxInputAmount,uint256 value,uint256 validAfter,uint256 validUntil,uint256 nonce,bytes32 pluginId,uint256 minOutputAmount,uint256 chainId)"
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(typeHash, g))));
    }

    function run(ExecutionModule.ExecutionGrant memory g, bytes memory data) internal {
        bytes memory sig = signatures(localHashGrant(g));
        vm.prank(g.executor);
        module.execute(g, data, sig);
    }
}

contract RejectNative {
    receive() external payable {
        revert("no native");
    }
}

contract ExecutionModuleTest is Fixture {
    function testExactExpiryBoundaryRejectsGrantAndMandate() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.validUntil = 1000;
        vm.expectRevert(bytes("time"));
        run(g, "");
        g.validUntil = 2000;
        vm.warp(2000);
        vm.expectRevert(bytes("time"));
        run(g, "");
        require(module.spent(ID) == 0, "expiry no effect");
    }

    function testOwnerCannotChangeDenominationUnderExistingSpend() public {
        MandateRegistry.Mandate memory m =
            MandateRegistry.Mandate(address(7), 0xa9059cbb, address(7), 100, 200, 0, 2000);
        bytes memory data = abi.encodeCall(registry.configure, (ID, 2, m));
        bytes32 digest = account.ownerTransactionHash(address(registry), 0, data, account.ownerNonce());
        bytes memory sig = signatures(digest);
        vm.expectRevert(bytes("owner call"));
        account.ownerExecute(address(registry), 0, data, sig);
        require(registry.currentVersion(ID) == 1, "no denomination switch");
    }

    function testRevertingNativeExecutionRollsBackAuthority() public {
        RejectNative reject = new RejectNative();
        configure(ID, 2, address(reject), address(0), 100, 200, 100);
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.mandateVersion = 2;
        g.target = address(reject);
        vm.expectRevert(bytes("execution"));
        run(g, "");
        require(!module.usedNonces(1) && !module.executedIntents(g.intentHash) && module.spent(ID) == 0, "rollback");
    }

    function testPerCallCapSeparateFromValueCap() public {
        configure(ID, 2, recipient, address(0), 5, 200, 100);
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.mandateVersion = 2;
        vm.expectRevert(bytes("spend cap"));
        run(g, "");
    }

    function testTokenApproveAndTrailingCalldataRejected() public {
        TestToken token = new TestToken();
        (ExecutionModule.ExecutionGrant memory g, bytes memory data) = tokenGrant(token, 10);
        data = abi.encodeWithSignature("approve(address,uint256)", recipient, 10);
        g.calldataHash = keccak256(data);
        vm.expectRevert(bytes("transfer only"));
        run(g, data);
        data = bytes.concat(abi.encodeWithSignature("transfer(address,uint256)", recipient, 10), hex"00");
        g.calldataHash = keccak256(data);
        vm.expectRevert(bytes("transfer only"));
        run(g, data);
    }

    function testUnknownAndMalleableOwnerSignaturesRejected() public {
        bytes32 digest = module.hashGrant(grant(1, 10));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(4, digest);
        bytes memory unknown = abi.encodePacked(r, s, v, r, s, v);
        require(account.isValidSignature(digest, unknown) == 0xffffffff, "unknown");
        bytes memory good = signatures(digest);
        for (uint256 i = 32; i < 64; ++i) {
            good[i] = 0xff;
        }
        require(account.isValidSignature(digest, good) == 0xffffffff, "malleable");
    }

    function testDirectAccountModuleAndDelegatecallRejected() public {
        vm.expectRevert(bytes("module call"));
        account.execTransactionFromModule(recipient, 1, "", 0);
        vm.prank(address(module));
        vm.expectRevert(bytes("module call"));
        account.execTransactionFromModule(recipient, 1, "", 1);
    }

    function testTokenWrongAssetAndMinimumOutputRejected() public {
        TestToken token = new TestToken();
        (ExecutionModule.ExecutionGrant memory g, bytes memory data) = tokenGrant(token, 10);
        g.minOutputAmount = 11;
        vm.expectRevert(bytes("output cap"));
        run(g, data);
        g.minOutputAmount = 10;
        g.inputToken = address(7);
        vm.expectRevert(bytes("allowlist"));
        run(g, data);
    }

    function testExactEip712ReferenceDigest() public view {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        require(localHashGrant(g) == module.hashGrant(g), "EIP712 independent encoding");
    }

    function testTwoDistinctOwnersExecuteExactGrant() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        run(g, "");
        require(recipient.balance == 10 && account.ownerNonce() == 2, "effect");
        require(module.spent(ID) == 10 && module.usedNonces(1) && module.executedIntents(g.intentHash), "accounting");
    }

    function testOneOwnerAndDuplicateOwnerRejected() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, module.hashGrant(g));
        bytes memory single = abi.encodePacked(r, s, v);
        require(account.isValidSignature(module.hashGrant(g), single) == 0xffffffff, "one owner");
        require(account.isValidSignature(module.hashGrant(g), bytes.concat(single, single)) == 0xffffffff, "duplicate");
    }

    function testMalformedAndUnsortedSignatures() public {
        bytes32 digest = module.hashGrant(grant(1, 10));
        require(account.isValidSignature(digest, hex"1234") == 0xffffffff, "malformed");
        bytes memory sig = signatures(digest);
        bytes memory swapped = new bytes(130);
        for (uint256 i; i < 65; ++i) {
            swapped[i] = sig[i + 65];
            swapped[i + 65] = sig[i];
        }
        require(account.isValidSignature(digest, swapped) == 0xffffffff, "order");
        sig[64] = bytes1(uint8(0));
        require(account.isValidSignature(digest, sig) == 0xffffffff, "v");
    }

    function testUnauthorizedExecutor() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        bytes memory sig = signatures(module.hashGrant(g));
        vm.expectRevert(bytes("principal/chain"));
        module.execute(g, "", sig);
    }

    function testReplayNonceAndIntent() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        run(g, "");
        vm.expectRevert(bytes("replay"));
        run(g, "");
        g.nonce = 2;
        vm.expectRevert(bytes("replay"));
        run(g, "");
    }

    function testExpiredNotYetValidAndMandateExpiry() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.validUntil = 999;
        vm.expectRevert(bytes("time"));
        run(g, "");
        g.validUntil = 2000;
        g.validAfter = 1001;
        vm.expectRevert(bytes("time"));
        run(g, "");
        g.validAfter = 1000;
        g.validUntil = 2001;
        vm.expectRevert(bytes("mandate time"));
        run(g, "");
    }

    function testWrongChainAndCrossChainSignature() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        bytes memory sig = signatures(module.hashGrant(g));
        vm.chainId(block.chainid + 1);
        vm.prank(executor);
        vm.expectRevert(bytes("principal/chain"));
        module.execute(g, "", sig);
        g.chainId = block.chainid;
        vm.prank(executor);
        vm.expectRevert(bytes("quorum"));
        module.execute(g, "", sig);
    }

    function testWrongModuleDomain() public {
        ExecutionModule other = new ExecutionModule(address(account), address(registry));
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        bytes memory sig = signatures(module.hashGrant(g));
        vm.prank(executor);
        vm.expectRevert(bytes("quorum"));
        other.execute(g, "", sig);
        require(module.domainSeparator() != other.domainSeparator(), "module domain");
    }

    function testAccountAndGroupDomainIsolation() public {
        SandboxAccount otherAccount = new SandboxAccount([vm.addr(1), vm.addr(2), vm.addr(3)]);
        MandateRegistry otherRegistry = new MandateRegistry(address(otherAccount), keccak256("other group"));
        ExecutionModule other = new ExecutionModule(address(otherAccount), address(otherRegistry));
        require(module.domainSeparator() != other.domainSeparator(), "account/group");
        bytes32 digest = module.hashGrant(grant(1, 10));
        require(
            otherAccount.isValidSignature(other.hashGrant(grant(1, 10)), signatures(digest)) == 0xffffffff, "digest"
        );
    }

    function testTargetSelectorAndCalldataTampering() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.target = address(7);
        vm.expectRevert(bytes("allowlist"));
        run(g, "");
        g.target = recipient;
        g.selector = 0xa9059cbb;
        vm.expectRevert(bytes("allowlist"));
        run(g, "");
        g.selector = 0;
        vm.expectRevert(bytes("data/value"));
        run(g, hex"1234");
        g.calldataHash = keccak256(hex"1234");
        vm.expectRevert(bytes("native only"));
        run(g, hex"1234");
    }

    function testSignedGrantMutationRejected() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        bytes memory sig = signatures(module.hashGrant(g));
        g.pluginId = keccak256("different plugin");
        vm.prank(executor);
        vm.expectRevert(bytes("quorum"));
        module.execute(g, "", sig);
    }

    function testValueAndCumulativeCaps() public {
        vm.expectRevert(bytes("data/value"));
        run(grant(1, 101), "");
        run(grant(1, 100), "");
        run(grant(2, 100), "");
        vm.expectRevert(bytes("spend cap"));
        run(grant(3, 1), "");
    }

    function testPauseAndOwnerRecoveryAndUninstall() public {
        ownerCall(address(module), abi.encodeCall(module.setPaused, (true)));
        vm.expectRevert(bytes("paused/reentrant"));
        run(grant(1, 10), "");
        bytes32 hash = account.ownerTransactionHash(recipient, 10, "", account.ownerNonce());
        account.ownerExecute(recipient, 10, "", signatures(hash));
        require(recipient.balance == 10, "recovery");
        ownerCall(address(account), abi.encodeCall(account.setModule, (address(module), false)));
        ownerCall(address(module), abi.encodeCall(module.setPaused, (false)));
        vm.expectRevert(bytes("module call"));
        run(grant(1, 10), "");
        require(!module.usedNonces(1) && module.spent(ID) == 0, "rollback");
    }

    function testRevokeAndSecuritySupersession() public {
        ownerCall(address(registry), abi.encodeCall(registry.revoke, (ID)));
        vm.expectRevert(bytes("mandate version"));
        run(grant(1, 10), "");
        configure(ID, 2, recipient, address(0), 100, 200, 100);
        vm.expectRevert(bytes("mandate version"));
        run(grant(1, 10), "");
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.mandateVersion = 2;
        run(g, "");
    }

    function testSupersessionDoesNotResetSpend() public {
        run(grant(1, 100), "");
        configure(ID, 2, recipient, address(0), 100, 100, 100);
        ExecutionModule.ExecutionGrant memory g = grant(2, 1);
        g.mandateVersion = 2;
        vm.expectRevert(bytes("spend cap"));
        run(g, "");
    }

    function testGovernanceCannotBeReachedThroughModule() public {
        configure(ID, 2, address(account), address(0), 100, 200, 100);
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.mandateVersion = 2;
        g.target = address(account);
        vm.expectRevert(bytes("governance"));
        run(g, "");
        require(account.getThreshold() == 2 && account.getOwners()[0] == vm.addr(1), "owners unchanged");
        vm.expectRevert(bytes("owners only"));
        account.setModule(executor, true);
        vm.expectRevert(bytes("account only"));
        module.setPaused(true);
        vm.expectRevert(bytes("account only"));
        registry.revoke(ID);
    }

    function testOwnerReplayAndInvalidOwnerSignature() public {
        bytes memory data = abi.encodeCall(module.setPaused, (true));
        bytes32 digest = account.ownerTransactionHash(address(module), 0, data, account.ownerNonce());
        bytes memory sig = signatures(digest);
        account.ownerExecute(address(module), 0, data, sig);
        vm.expectRevert(bytes("quorum"));
        account.ownerExecute(address(module), 0, data, sig);
    }

    function tokenGrant(TestToken token, uint256 amount)
        internal
        returns (ExecutionModule.ExecutionGrant memory g, bytes memory data)
    {
        configure(keccak256("token mandate"), 1, address(token), address(token), 100, 200, 0);
        token.mint(address(account), 1000);
        data = abi.encodeWithSignature("transfer(address,uint256)", recipient, amount);
        g = grant(1, 0);
        g.mandateId = keccak256("token mandate");
        g.target = address(token);
        g.selector = 0xa9059cbb;
        g.calldataHash = keccak256(data);
        g.inputToken = address(token);
        g.maxInputAmount = amount;
        g.minOutputAmount = amount;
    }

    function testTokenTransferActualBalances() public {
        TestToken token = new TestToken();
        (ExecutionModule.ExecutionGrant memory g, bytes memory data) = tokenGrant(token, 10);
        run(g, data);
        require(token.balanceOf(recipient) == 10 && token.balanceOf(address(account)) == 990, "token effect");
    }

    function testTokenClaimedAmountCannotHideSpend() public {
        TestToken token = new TestToken();
        (ExecutionModule.ExecutionGrant memory g, bytes memory data) = tokenGrant(token, 100);
        g.maxInputAmount = 1;
        vm.expectRevert(bytes("token amount"));
        run(g, data);
    }

    function testFeeFalseAndOverDebitTokensRollback() public {
        TestToken token = new TestToken();
        (ExecutionModule.ExecutionGrant memory g, bytes memory data) = tokenGrant(token, 10);
        token.modes(true, false, false);
        vm.expectRevert(bytes("token output"));
        run(g, data);
        token.modes(false, true, false);
        vm.expectRevert(bytes("token debit"));
        run(g, data);
        token.modes(false, false, true);
        vm.expectRevert(bytes("token debit"));
        run(g, data);
        require(token.balanceOf(address(account)) == 1000 && !module.usedNonces(1), "atomic rollback");
    }

    function testReentrantRecipientBlockedWithSingleEffect() public {
        ReentrantRecipient reentrant = new ReentrantRecipient();
        configure(ID, 2, address(reentrant), address(0), 100, 200, 100);
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.mandateVersion = 2;
        g.target = address(reentrant);
        g.executor = address(reentrant);
        reentrant.start(module, g, signatures(module.hashGrant(g)));
        require(reentrant.blocked() && address(reentrant).balance == 10 && module.spent(ID) == 10, "reentrancy");
    }

    function testFuzzNativeAmountBound(uint256 amount) public {
        amount = amount % 1000;
        if (amount == 0 || amount > 100) {
            vm.expectRevert();
            run(grant(1, amount), "");
        } else {
            run(grant(1, amount), "");
            require(recipient.balance == amount, "bounded");
        }
    }

    function testFuzzArbitraryCalldataCannotExecute(bytes memory data) public {
        if (data.length == 0) return;
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.calldataHash = keccak256(data);
        vm.expectRevert(bytes("native only"));
        run(g, data);
        require(recipient.balance == 0 && module.spent(ID) == 0, "no spend");
    }

    function testFuzzTokenAmountCaps(uint256 amount) public {
        amount = amount % 1000;
        TestToken token = new TestToken();
        (ExecutionModule.ExecutionGrant memory g, bytes memory data) = tokenGrant(token, amount);
        if (amount == 0 || amount > 100) {
            vm.expectRevert(bytes("spend cap"));
            run(g, data);
        } else {
            run(g, data);
            require(token.balanceOf(recipient) == amount, "token bounded");
        }
    }

    function testFuzzEverySignedFieldBound(uint8 field, uint256 mutation) public {
        if (mutation == 0) mutation = 1;
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        bytes memory sig = signatures(module.hashGrant(g));
        field = field % 16;
        if (field == 0) g.intentHash = bytes32(uint256(g.intentHash) ^ mutation);
        else if (field == 1) g.mandateId = bytes32(uint256(g.mandateId) ^ mutation);
        else if (field == 2) g.mandateVersion = 2;
        else if (field == 3) g.executor = address(0xF);
        else if (field == 4) g.target = address(7);
        else if (field == 5) g.selector = 0xdeadbeef;
        else if (field == 6) g.calldataHash = bytes32(uint256(g.calldataHash) ^ mutation);
        else if (field == 7) g.inputToken = address(7);
        else if (field == 8) g.maxInputAmount = mutation;
        else if (field == 9) g.value = 11;
        else if (field == 10) g.validAfter = 999;
        else if (field == 11) g.validUntil = 1999;
        else if (field == 12) g.nonce = 2;
        else if (field == 13) g.pluginId = bytes32(uint256(g.pluginId) ^ mutation);
        else if (field == 14) g.minOutputAmount = mutation;
        else g.chainId = block.chainid + 1;
        vm.prank(executor);
        vm.expectRevert();
        module.execute(g, "", sig);
        require(module.spent(ID) == 0, "no unsigned mutation");
    }
}

contract ExecutionHandler {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    SandboxAccount public account;
    ExecutionModule public module;
    bytes32 public id;
    address public recipient;
    uint256 public nextNonce = 1;
    uint256 public successes;
    bool public paused;

    constructor(SandboxAccount a, ExecutionModule m, bytes32 i, address r) {
        account = a;
        module = m;
        id = i;
        recipient = r;
    }

    function sig(bytes32 digest) private returns (bytes memory) {
        (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(1, digest);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(2, digest);
        return vm.addr(1) < vm.addr(2)
            ? abi.encodePacked(r1, s1, v1, r2, s2, v2)
            : abi.encodePacked(r2, s2, v2, r1, s1, v1);
    }

    function spend(uint256 seed) external {
        uint256 nonce = nextNonce++;
        uint256 remaining = 200 - module.spent(id);
        if (remaining == 0 || paused) return;
        uint256 amount = 1 + seed % (remaining < 100 ? remaining : 100);
        ExecutionModule.ExecutionGrant memory g = ExecutionModule.ExecutionGrant(
            keccak256(abi.encode(nonce)),
            id,
            1,
            address(this),
            recipient,
            0,
            keccak256(""),
            address(0),
            0,
            amount,
            1000,
            2000,
            nonce,
            keccak256("plugin"),
            0,
            block.chainid
        );
        bytes memory signatures = sig(module.hashGrant(g));
        module.execute(g, "", signatures);
        successes++;
        try module.execute(g, "", signatures) {
            revert("replay succeeded");
        } catch {}
    }

    function pause(bool state) external {
        bytes memory data = abi.encodeCall(module.setPaused, (state));
        bytes32 digest = account.ownerTransactionHash(address(module), 0, data, account.ownerNonce());
        account.ownerExecute(address(module), 0, data, sig(digest));
        paused = state;
    }

    function unauthorized(uint256 seed) external {
        address intruder = address(uint160(seed));
        if (intruder == address(this) || intruder == address(account)) return;
        vm.prank(intruder);
        (bool ok,) = address(account).call(abi.encodeCall(account.setModule, (intruder, true)));
        require(!ok, "unauthorized governance");
    }
}

contract ExecutionInvariantTest is Fixture {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    struct FuzzArtifactSelector {
        string artifact;
        bytes4[] selectors;
    }

    struct FuzzInterface {
        address addr;
        string[] artifacts;
    }

    function targetArtifactSelectors() public pure returns (FuzzArtifactSelector[] memory) {
        return new FuzzArtifactSelector[](0);
    }

    function targetArtifacts() public pure returns (string[] memory) {
        return new string[](0);
    }

    function excludeArtifacts() public pure returns (string[] memory) {
        return new string[](0);
    }

    function targetSenders() public pure returns (address[] memory) {
        return new address[](0);
    }

    function excludeSenders() public pure returns (address[] memory) {
        return new address[](0);
    }

    function excludeContracts() public pure returns (address[] memory) {
        return new address[](0);
    }

    function targetInterfaces() public pure returns (FuzzInterface[] memory) {
        return new FuzzInterface[](0);
    }

    function targetSelectors() public pure returns (FuzzSelector[] memory) {
        return new FuzzSelector[](0);
    }

    function excludeSelectors() public pure returns (FuzzSelector[] memory) {
        return new FuzzSelector[](0);
    }

    ExecutionHandler handler;
    address[] private targets;

    function setUp() public override {
        super.setUp();
        handler = new ExecutionHandler(account, module, ID, recipient);
        targets.push(address(handler));
    }

    function targetContracts() public view returns (address[] memory) {
        return targets;
    }

    function invariantCumulativeSpendAndConservation() public view {
        require(module.spent(ID) <= 200 && recipient.balance == module.spent(ID), "cap/conservation");
        require(address(account).balance + recipient.balance == 1000, "funds");
    }

    function invariantOwnersAndThresholdImmutable() public {
        address[3] memory owners = account.getOwners();
        require(
            account.getThreshold() == 2 && owners[0] == vm.addr(1) && owners[1] == vm.addr(2) && owners[2] == vm.addr(3),
            "ownership"
        );
    }

    function invariantPauseStateConsistent() public view {
        require(module.paused() == handler.paused(), "pause");
    }
}
