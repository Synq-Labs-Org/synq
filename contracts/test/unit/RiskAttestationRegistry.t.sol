// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RiskAttestationRegistry} from "../../src/RiskAttestationRegistry.sol";
import {IERC165, IReceiver} from "../../src/interfaces/IReceiver.sol";

contract RiskAttestationRegistryTest is Test {
    RiskAttestationRegistry internal registry;
    address internal forwarder = makeAddr("forwarder");
    address internal attacker = makeAddr("attacker");
    address internal author = makeAddr("workflowOwner");
    bytes32 internal constant AUSD = keccak256("eip155:10143/erc20:ausd");
    bytes32 internal constant USDC = keccak256("eip155:10143/erc20:usdc");
    bytes32 internal constant CONFIG = keccak256("config");
    bytes32 internal constant WORKFLOW_ID = keccak256("workflow");
    bytes10 internal constant WORKFLOW_NAME = bytes10("synqausdrk");
    uint64 internal constant T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);
        registry = new RiskAttestationRegistry(forwarder);
    }

    function report(bytes32 asset, uint64 timestamp, uint256 price, uint8 status)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(asset, timestamp, price, uint32(17), uint64(42), status, CONFIG);
    }

    function metadata(bytes32 id, bytes10 name, address owner_, bool withReportId)
        internal
        pure
        returns (bytes memory)
    {
        return withReportId ? abi.encodePacked(id, name, owner_, bytes2(0x0001)) : abi.encodePacked(id, name, owner_);
    }

    function deliver(bytes memory meta, bytes memory payload) internal {
        vm.prank(forwarder);
        registry.onReport(meta, payload);
    }

    function test_constructorRejectsZeroForwarder() public {
        vm.expectRevert(RiskAttestationRegistry.InvalidForwarder.selector);
        new RiskAttestationRegistry(address(0));
    }

    function test_recordsAttestationFromForwarder() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit RiskAttestationRegistry.AttestationRecorded(
            AUSD, RiskAttestationRegistry.Status.HEALTHY, T0 - 10, 99_983_010, 17, 42, CONFIG, bytes32(0)
        );
        deliver("", report(AUSD, T0 - 10, 99_983_010, 1));
        RiskAttestationRegistry.Attestation memory a = registry.latest(AUSD);
        assertEq(a.timestamp, T0 - 10);
        assertEq(a.referencePrice, 99_983_010);
        assertEq(a.deviationBps, 17);
        assertEq(a.stalenessSec, 42);
        assertEq(uint8(a.status), 1);
        assertEq(a.sourceConfigHash, CONFIG);
        assertEq(a.recordedAt, T0);
        assertEq(a.recordedBlock, block.number);
        assertEq(registry.latest(USDC).timestamp, 0);
        assertEq(uint8(registry.latest(USDC).status), 0);
    }

    function test_rejectsUnauthorizedWriter() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidSender.selector, attacker, forwarder));
        registry.onReport("", report(AUSD, T0, 1e8, 1));
        vm.expectRevert(
            abi.encodeWithSelector(RiskAttestationRegistry.InvalidSender.selector, address(this), forwarder)
        );
        registry.onReport("", report(AUSD, T0, 1e8, 1));
        assertEq(registry.latest(AUSD).timestamp, 0);
    }

    function test_rejectsOlderOrEqualAttestation() public {
        deliver("", report(AUSD, T0, 1e8, 1));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.StaleAttestation.selector, AUSD, T0, T0));
        registry.onReport("", report(AUSD, T0, 1e8, 2));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.StaleAttestation.selector, AUSD, T0, T0 - 1));
        registry.onReport("", report(AUSD, T0 - 1, 1e8, 1));
        assertEq(uint8(registry.latest(AUSD).status), 1);
        deliver("", report(USDC, T0 - 100, 1e8, 1));
        vm.warp(T0 + 60);
        deliver("", report(AUSD, T0 + 60, 98_000_000, 2));
        assertEq(uint8(registry.latest(AUSD).status), 2);
    }

    function test_rejectsFutureTimestampBeyondSkew() public {
        uint64 future = T0 + registry.MAX_FUTURE_SKEW() + 1;
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.FutureAttestation.selector, future, T0));
        registry.onReport("", report(AUSD, future, 1e8, 1));
        deliver("", report(AUSD, T0 + registry.MAX_FUTURE_SKEW(), 1e8, 1));
    }

    function test_rejectsMalformedReports() public {
        vm.startPrank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidStatus.selector, uint8(4)));
        registry.onReport("", report(AUSD, T0, 1e8, 4));
        vm.expectRevert(RiskAttestationRegistry.MissingReferencePrice.selector);
        registry.onReport("", report(AUSD, T0, 0, 1));
        vm.expectRevert(RiskAttestationRegistry.MissingReferencePrice.selector);
        registry.onReport("", report(AUSD, T0, 0, 2));
        vm.expectRevert(RiskAttestationRegistry.InvalidAsset.selector);
        registry.onReport("", report(bytes32(0), T0, 1e8, 1));
        bytes memory full = report(AUSD, T0, 1e8, 1);
        bytes memory short = new bytes(full.length - 1);
        for (uint256 i; i < short.length; ++i) {
            short[i] = full[i];
        }
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidReportLength.selector, short.length));
        registry.onReport("", short);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidReportLength.selector, full.length + 32));
        registry.onReport("", bytes.concat(full, bytes32(0)));
        bytes memory overflow =
            abi.encode(AUSD, uint256(type(uint64).max) + 1, 1e8, uint32(1), uint64(1), uint8(1), CONFIG);
        vm.expectRevert();
        registry.onReport("", overflow);
        vm.stopPrank();
        deliver("", report(AUSD, T0, 0, 0));
        deliver("", report(USDC, T0, 0, 3));
        assertEq(uint8(registry.latest(USDC).status), 3);
    }

    function test_metadataLength64And62AcceptedWhenIdentityChecked() public {
        registry.setWorkflowExpectation(WORKFLOW_ID, author, WORKFLOW_NAME);
        deliver(metadata(WORKFLOW_ID, WORKFLOW_NAME, author, true), report(AUSD, T0 - 2, 1e8, 1));
        assertEq(registry.latest(AUSD).workflowId, WORKFLOW_ID);
        deliver(metadata(WORKFLOW_ID, WORKFLOW_NAME, author, false), report(AUSD, T0 - 1, 1e8, 1));
        for (uint256 length; length < 96; ++length) {
            if (length == 62 || length == 64) continue;
            vm.prank(forwarder);
            vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidMetadata.selector, length));
            registry.onReport(new bytes(length), report(AUSD, T0, 1e8, 1));
        }
    }

    function test_metadataIgnoredWithoutIdentityChecks() public {
        deliver(new bytes(7), report(AUSD, T0 - 3, 1e8, 1));
        assertEq(registry.latest(AUSD).workflowId, bytes32(0));
        deliver(metadata(WORKFLOW_ID, WORKFLOW_NAME, author, true), report(AUSD, T0 - 2, 1e8, 1));
        assertEq(registry.latest(AUSD).workflowId, WORKFLOW_ID);
    }

    function test_rejectsWrongWorkflowIdentity() public {
        registry.setWorkflowExpectation(WORKFLOW_ID, author, WORKFLOW_NAME);
        vm.startPrank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(RiskAttestationRegistry.InvalidWorkflowId.selector, bytes32(uint256(1)), WORKFLOW_ID)
        );
        registry.onReport(metadata(bytes32(uint256(1)), WORKFLOW_NAME, author, true), report(AUSD, T0, 1e8, 1));
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidAuthor.selector, attacker, author));
        registry.onReport(metadata(WORKFLOW_ID, WORKFLOW_NAME, attacker, true), report(AUSD, T0, 1e8, 1));
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskAttestationRegistry.InvalidWorkflowName.selector, bytes10("otherflow0"), WORKFLOW_NAME
            )
        );
        registry.onReport(metadata(WORKFLOW_ID, bytes10("otherflow0"), author, true), report(AUSD, T0, 1e8, 1));
        vm.stopPrank();
        assertEq(registry.latest(AUSD).timestamp, 0);
    }

    function test_workflowNameRequiresAuthor() public {
        vm.expectRevert(RiskAttestationRegistry.WorkflowNameRequiresAuthor.selector);
        registry.setWorkflowExpectation(bytes32(0), address(0), WORKFLOW_NAME);
        registry.setWorkflowExpectation(WORKFLOW_ID, address(0), bytes10(0));
        deliver(metadata(WORKFLOW_ID, bytes10(0), attacker, true), report(AUSD, T0, 1e8, 1));
    }

    function test_adminFunctionsAreOwnerOnlyAndForwarderNeverZero() public {
        vm.startPrank(attacker);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.NotOwner.selector, attacker));
        registry.setForwarder(attacker);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.NotOwner.selector, attacker));
        registry.setWorkflowExpectation(bytes32(0), address(0), bytes10(0));
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.NotOwner.selector, attacker));
        registry.transferOwnership(attacker);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.NotPendingOwner.selector, attacker));
        registry.acceptOwnership();
        vm.stopPrank();
        vm.expectRevert(RiskAttestationRegistry.InvalidForwarder.selector);
        registry.setForwarder(address(0));

        address production = makeAddr("productionForwarder");
        registry.setForwarder(production);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidSender.selector, forwarder, production));
        registry.onReport("", report(AUSD, T0, 1e8, 1));

        address next = makeAddr("nextOwner");
        registry.transferOwnership(next);
        assertEq(registry.owner(), address(this));
        vm.prank(next);
        registry.acceptOwnership();
        assertEq(registry.owner(), next);
        assertEq(registry.pendingOwner(), address(0));
    }

    function test_supportsReceiverInterfaces() public view {
        assertTrue(registry.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(registry.supportsInterface(type(IERC165).interfaceId));
        assertFalse(registry.supportsInterface(0xffffffff));
    }
}
