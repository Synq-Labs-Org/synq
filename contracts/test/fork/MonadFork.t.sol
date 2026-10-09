// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SynqGroupFactory} from "../../src/SynqGroupFactory.sol";
import {MandateRegistry} from "../../src/MandateRegistry.sol";
import {ExecutionModule} from "../../src/ExecutionModule.sol";
import {ISafeFull} from "../utils/ISafeFull.sol";

interface IAgoraFaucet {
    function requestFunds(address recipient) external;
    function token() external view returns (address);
    function faucetDripAmount() external view returns (uint256);
    function maxAmountToOwn() external view returns (uint256);
    function maxDripFrequency() external view returns (uint256);
    function lastDripTimestamp() external view returns (uint256);
}

interface IERC20Meta {
    function balanceOf(address owner) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Fork tests against Monad testnet (chain 10143): canonical Safe v1.4.1 bytecode at registry addresses,
///         official test AUSD and the Agora faucet. Run with:
///         FOUNDRY_PROFILE=fork forge test --root contracts --fork-url https://testnet-rpc.monad.xyz
contract MonadForkTest is Test {
    uint256 internal constant MONAD_TESTNET = 10143;
    address internal constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    address internal constant COMPATIBILITY_FALLBACK_HANDLER = 0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99;
    address internal constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    address internal constant AGORA_FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;
    // codeHash values from safe-global/safe-deployments src/assets/v1.4.1/*.json (deployments.canonical).
    bytes32 internal constant SAFE_L2_CODEHASH = 0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff;
    bytes32 internal constant SAFE_PROXY_FACTORY_CODEHASH =
        0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    bytes32 internal constant FALLBACK_HANDLER_CODEHASH =
        0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9;
    bytes32 internal constant FALLBACK_HANDLER_SLOT = 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5;

    uint256 internal constant KEY1 = 0xA11CE;
    uint256 internal constant KEY2 = 0xB0B;
    uint256 internal constant KEY3 = 0xCA401;
    bytes32 internal constant MANDATE = keccak256("synq.fork.mandate.ausd");
    uint256 internal constant PER_ACTION = 5e6;
    uint256 internal constant CUMULATIVE = 8e6;
    uint256 internal constant TRANSFER_AMOUNT = 1_500_000;

    SynqGroupFactory internal factory;
    MandateRegistry internal registry;
    ExecutionModule internal module;
    ISafeFull internal safe;
    bytes32 internal groupId;
    address internal executor = makeAddr("fork-executor");
    address internal recipient = makeAddr("fork-recipient");

    modifier onlyMonadFork() {
        if (block.chainid != MONAD_TESTNET) {
            vm.skip(true);
        }
        _;
    }

    function setUp() public {
        if (block.chainid != MONAD_TESTNET) return;
        factory = new SynqGroupFactory(SAFE_L2_SINGLETON, SAFE_PROXY_FACTORY, COMPATIBILITY_FALLBACK_HANDLER);
        registry = factory.registry();
        module = factory.module();
        address[] memory owners = new address[](3);
        owners[0] = vm.addr(KEY1);
        owners[1] = vm.addr(KEY2);
        owners[2] = vm.addr(KEY3);
        address account;
        (groupId, account) = factory.createGroup(owners, 2, keccak256("synq.fork.group"));
        safe = ISafeFull(account);
        _safeCall(address(module), abi.encodeCall(ExecutionModule.setExecutor, (executor, true)));
        _safeCall(address(registry), abi.encodeCall(MandateRegistry.configureMandate, (MANDATE, _mandate())));
    }

    function test_fork_canonicalSafeInfrastructure() public onlyMonadFork {
        assertEq(ISafeFull(SAFE_L2_SINGLETON).VERSION(), "1.4.1");
        assertEq(SAFE_L2_SINGLETON.codehash, SAFE_L2_CODEHASH);
        assertEq(SAFE_PROXY_FACTORY.codehash, SAFE_PROXY_FACTORY_CODEHASH);
        assertEq(COMPATIBILITY_FALLBACK_HANDLER.codehash, FALLBACK_HANDLER_CODEHASH);
        assertEq(IERC20Meta(AUSD).decimals(), 6);
        assertEq(IERC20Meta(AUSD).symbol(), "AUSD");
        assertEq(IAgoraFaucet(AGORA_FAUCET).token(), AUSD);
        emit log_named_uint("fork block", block.number);
    }

    function test_fork_groupCreatedOnRealSafe() public onlyMonadFork {
        assertEq(safe.VERSION(), "1.4.1");
        assertEq(safe.getThreshold(), 2);
        assertEq(safe.getOwners().length, 3);
        assertTrue(safe.isModuleEnabled(address(module)));
        assertEq(
            abi.decode(safe.getStorageAt(uint256(FALLBACK_HANDLER_SLOT), 1), (address)), COMPATIBILITY_FALLBACK_HANDLER
        );
        assertEq(registry.groupOf(address(safe)), groupId);
        assertEq(registry.moduleOf(address(safe)), address(module));
    }

    function test_fork_twoOfThreeApprovedAusdTransferViaFaucetFunding() public onlyMonadFork {
        _fundFromFaucet();
        uint256 safeBefore = IERC20Meta(AUSD).balanceOf(address(safe));
        uint256 recipientBefore = IERC20Meta(AUSD).balanceOf(recipient);

        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _grant(1, TRANSFER_AMOUNT);
        bytes memory signatures = _sign(module.hashGrant(grant), KEY1, KEY3);
        vm.prank(executor);
        bytes32 grantHash = module.execute(grant, data, signatures);

        assertEq(IERC20Meta(AUSD).balanceOf(address(safe)), safeBefore - TRANSFER_AMOUNT);
        assertEq(IERC20Meta(AUSD).balanceOf(recipient), recipientBefore + TRANSFER_AMOUNT);
        assertEq(registry.mandateState(address(safe), MANDATE).spentToken, TRANSFER_AMOUNT);
        assertTrue(module.nonceUsed(address(safe), 1));
        emit log_named_address("group safe", address(safe));
        emit log_named_bytes32("grant hash", grantHash);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ExecutionModule.NonceAlreadyUsed.selector, 1));
        module.execute(grant, data, signatures);
    }

    function test_fork_singleOwnerSignatureInsufficient() public onlyMonadFork {
        _fundFromFaucet();
        (ExecutionModule.ExecutionGrant memory grant, bytes memory data) = _grant(1, TRANSFER_AMOUNT);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(KEY1, module.hashGrant(grant));
        vm.prank(executor);
        vm.expectRevert(ExecutionModule.InvalidSignatures.selector);
        module.execute(grant, data, abi.encodePacked(r, s, v));
    }

    function test_fork_capsPauseAndOwnerRecoveryOnRealSafe() public onlyMonadFork {
        _fundFromFaucet();
        (ExecutionModule.ExecutionGrant memory overAction, bytes memory overData) = _grant(1, PER_ACTION + 1);
        bytes memory overSigs = _sign(module.hashGrant(overAction), KEY1, KEY2);
        vm.prank(executor);
        vm.expectRevert(MandateRegistry.PerActionCapExceeded.selector);
        module.execute(overAction, overData, overSigs);

        (ExecutionModule.ExecutionGrant memory g1, bytes memory d1) = _grant(2, PER_ACTION);
        bytes memory s1 = _sign(module.hashGrant(g1), KEY1, KEY2);
        vm.prank(executor);
        module.execute(g1, d1, s1);
        (ExecutionModule.ExecutionGrant memory g2, bytes memory d2) = _grant(3, CUMULATIVE - PER_ACTION + 1);
        bytes memory s2 = _sign(module.hashGrant(g2), KEY1, KEY2);
        vm.prank(executor);
        vm.expectRevert(MandateRegistry.CumulativeCapExceeded.selector);
        module.execute(g2, d2, s2);

        _safeCall(address(module), abi.encodeCall(ExecutionModule.pause, ()));
        (ExecutionModule.ExecutionGrant memory g3, bytes memory d3) = _grant(4, 1);
        bytes memory s3 = _sign(module.hashGrant(g3), KEY1, KEY2);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ExecutionModule.ExecutionPaused.selector, address(safe)));
        module.execute(g3, d3, s3);

        address vault = makeAddr("fork-recovery-vault");
        uint256 remaining = IERC20Meta(AUSD).balanceOf(address(safe));
        _safeCall(AUSD, abi.encodeWithSelector(bytes4(0xa9059cbb), vault, remaining));
        assertEq(IERC20Meta(AUSD).balanceOf(vault), remaining);
        assertEq(IERC20Meta(AUSD).balanceOf(address(safe)), 0);
    }

    function _fundFromFaucet() internal {
        IAgoraFaucet faucet = IAgoraFaucet(AGORA_FAUCET);
        vm.warp(_max(block.timestamp, faucet.lastDripTimestamp() + faucet.maxDripFrequency() + 1));
        uint256 before = IERC20Meta(AUSD).balanceOf(address(safe));
        faucet.requestFunds(address(safe));
        assertEq(IERC20Meta(AUSD).balanceOf(address(safe)), before + faucet.faucetDripAmount());
    }

    function _mandate() internal view returns (MandateRegistry.MandateConfig memory config) {
        address[] memory targets = new address[](1);
        bytes4[] memory selectors = new bytes4[](1);
        targets[0] = AUSD;
        selectors[0] = bytes4(0xa9059cbb);
        address[] memory recipients = new address[](1);
        recipients[0] = recipient;
        config = MandateRegistry.MandateConfig({
            mandateHash: keccak256("synq.fork.mandate.document"),
            token: AUSD,
            maxTokenPerAction: PER_ACTION,
            maxNativePerAction: 0,
            cumulativeTokenCap: CUMULATIVE,
            cumulativeNativeCap: 0,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 7 days,
            callTargets: targets,
            callSelectors: selectors,
            recipients: recipients
        });
    }

    function _grant(uint256 nonce, uint256 amount)
        internal
        view
        returns (ExecutionModule.ExecutionGrant memory grant, bytes memory data)
    {
        data = abi.encodeWithSelector(bytes4(0xa9059cbb), recipient, amount);
        grant = ExecutionModule.ExecutionGrant({
            groupId: groupId,
            account: address(safe),
            mandateId: MANDATE,
            mandateVersion: 1,
            executor: executor,
            pluginId: keccak256("synq.plugin.transfer"),
            chainId: block.chainid,
            target: AUSD,
            selector: bytes4(0xa9059cbb),
            calldataHash: keccak256(data),
            token: AUSD,
            maxInputAmount: amount,
            nativeValue: 0,
            minOutputAmount: amount,
            recipient: recipient,
            validAfter: block.timestamp,
            validUntil: block.timestamp + 1 hours,
            nonce: nonce,
            intentHash: keccak256(abi.encode("fork-intent", nonce))
        });
    }

    function _safeCall(address to, bytes memory data) internal {
        bytes32 txHash = safe.getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), safe.nonce());
        assertTrue(
            safe.execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), _sign(txHash, KEY2, KEY3))
        );
    }

    function _sign(bytes32 digest, uint256 a, uint256 b) internal pure returns (bytes memory) {
        if (vm.addr(a) > vm.addr(b)) (a, b) = (b, a);
        (uint8 va, bytes32 ra, bytes32 sa) = vm.sign(a, digest);
        (uint8 vb, bytes32 rb, bytes32 sb) = vm.sign(b, digest);
        return abi.encodePacked(ra, sa, va, rb, sb, vb);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }
}
