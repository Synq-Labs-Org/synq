// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Fixture, TestToken} from "./ExecutionModule.t.sol";
import {SandboxAccount} from "../src/SandboxAccount.sol";
import {MandateRegistry} from "../src/MandateRegistry.sol";
import {ExecutionModule} from "../src/ExecutionModule.sol";

contract CriticCallbackToken {
    mapping(address => uint256) public balanceOf;
    ExecutionModule private module;
    ExecutionModule.ExecutionGrant private nested;
    bytes private sig;
    bool public blocked;

    function prepare(ExecutionModule m, ExecutionModule.ExecutionGrant calldata g, bytes calldata s, address a)
        external
    {
        module = m;
        nested = g;
        sig = s;
        balanceOf[a] = 1000;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        try module.execute(nested, "", sig) {}
        catch {
            blocked = true;
        }
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract CriticSecurityTest is Fixture {
    function testGroupSaltAloneCannotReuseSignatures() public {
        MandateRegistry alternate = new MandateRegistry(address(account), keccak256("different group"));
        ExecutionModule other = new ExecutionModule(address(account), address(alternate));
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        bytes32 foreignDomain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"
                ),
                keccak256("SynqExecutionModule"),
                keccak256("1"),
                block.chainid,
                address(module),
                keccak256(abi.encode(address(account), alternate.groupId()))
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", foreignDomain, keccak256(abi.encode(module.GRANT_TYPEHASH(), g))));
        bytes memory sig = signatures(digest);
        require(other.groupId() != module.groupId(), "group isolation");
        vm.prank(executor);
        vm.expectRevert(bytes("quorum"));
        module.execute(g, "", sig);
        require(!module.usedNonces(1) && module.spent(ID) == 0, "no effect");
    }

    function testAccountSaltAloneCannotReuseSignatures() public {
        SandboxAccount alternate = new SandboxAccount([vm.addr(1), vm.addr(2), vm.addr(3)]);
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        bytes32 foreignDomain = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)"
                ),
                keccak256("SynqExecutionModule"),
                keccak256("1"),
                block.chainid,
                address(module),
                keccak256(abi.encode(address(alternate), GROUP))
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", foreignDomain, keccak256(abi.encode(module.GRANT_TYPEHASH(), g))));
        bytes memory sig = signatures(digest);
        vm.prank(executor);
        vm.expectRevert(bytes("quorum"));
        module.execute(g, "", sig);
    }

    function testCallbackCannotExecuteDifferentSignedGrant() public {
        CriticCallbackToken token = new CriticCallbackToken();
        bytes32 tokenId = keccak256("callback token");
        configure(tokenId, 1, address(token), address(token), 100, 200, 0);
        ExecutionModule.ExecutionGrant memory nested = grant(2, 100);
        nested.executor = address(token);
        token.prepare(module, nested, signatures(module.hashGrant(nested)), address(account));
        ExecutionModule.ExecutionGrant memory g = grant(1, 0);
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", recipient, 10);
        g.mandateId = tokenId;
        g.target = address(token);
        g.inputToken = address(token);
        g.selector = 0xa9059cbb;
        g.calldataHash = keccak256(data);
        g.maxInputAmount = 10;
        g.minOutputAmount = 10;
        run(g, data);
        require(token.blocked() && module.spent(tokenId) == 10 && module.spent(ID) == 0, "single effect");
        require(!module.usedNonces(2) && !module.executedIntents(nested.intentHash), "nested authority intact");
        require(token.balanceOf(address(account)) == 990 && token.balanceOf(recipient) == 10, "token effect");
    }

    function testSignedCalldataCannotRedirectRecipient() public {
        TestToken token = new TestToken();
        bytes32 tokenId = keccak256("token");
        configure(tokenId, 1, address(token), address(token), 100, 200, 0);
        token.mint(address(account), 1000);
        bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", recipient, 10);
        ExecutionModule.ExecutionGrant memory g = grant(1, 0);
        g.mandateId = tokenId;
        g.target = address(token);
        g.inputToken = address(token);
        g.selector = 0xa9059cbb;
        g.calldataHash = keccak256(data);
        g.maxInputAmount = 10;
        g.minOutputAmount = 10;
        bytes memory sig = signatures(module.hashGrant(g));
        bytes memory redirected = abi.encodeWithSignature("transfer(address,uint256)", address(0xBAD), 10);
        vm.prank(executor);
        vm.expectRevert(bytes("data/value"));
        module.execute(g, redirected, sig);
        require(token.balanceOf(address(account)) == 1000 && !module.usedNonces(1), "atomic rejection");
    }

    function testRejectedSignatureAndDisabledModuleDoNotConsumeAuthority() public {
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        vm.prank(executor);
        vm.expectRevert(bytes("quorum"));
        module.execute(g, "", hex"00");
        ownerCall(address(account), abi.encodeCall(account.setModule, (address(module), false)));
        vm.expectRevert(bytes("module call"));
        run(g, "");
        require(!module.usedNonces(1) && !module.executedIntents(g.intentHash) && module.spent(ID) == 0, "rollback");
        ownerCall(address(account), abi.encodeCall(account.setModule, (address(module), true)));
        run(g, "");
        require(recipient.balance == 10 && module.spent(ID) == 10, "retry exact grant");
    }

    function testNonceAndIntentCannotCrossMandatesWithinModule() public {
        run(grant(1, 10), "");
        bytes32 alternate = keccak256("alternate mandate");
        configure(alternate, 1, recipient, address(0), 100, 200, 100);
        ExecutionModule.ExecutionGrant memory g = grant(1, 10);
        g.mandateId = alternate;
        g.intentHash = keccak256("new intent");
        vm.expectRevert(bytes("replay"));
        run(g, "");
        g = grant(2, 10);
        g.mandateId = alternate;
        g.intentHash = grant(1, 10).intentHash;
        vm.expectRevert(bytes("replay"));
        run(g, "");
        require(module.spent(alternate) == 0 && recipient.balance == 10, "no cross mandate replay");
    }
}
