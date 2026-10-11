// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RiskAttestationRegistry} from "../../src/RiskAttestationRegistry.sol";

contract RiskAttestationFuzzTest is Test {
    RiskAttestationRegistry internal registry;
    address internal forwarder = makeAddr("forwarder");
    bytes32 internal constant AUSD = keccak256("ausd");
    uint64 internal constant T0 = 1_800_000_000;

    function setUp() public {
        vm.warp(T0);
        registry = new RiskAttestationRegistry(forwarder);
    }

    function payload(uint64 timestamp, uint8 status) internal pure returns (bytes memory) {
        return abi.encode(AUSD, timestamp, uint256(1e8), uint32(0), uint64(0), status, bytes32(0));
    }

    function testFuzz_onlyForwarderWrites(address sender, uint64 timestamp) public {
        vm.assume(sender != forwarder);
        timestamp = uint64(bound(timestamp, 1, T0));
        vm.prank(sender);
        vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidSender.selector, sender, forwarder));
        registry.onReport("", payload(timestamp, 1));
        assertEq(registry.latest(AUSD).timestamp, 0);
    }

    function testFuzz_timestampsAreStrictlyMonotonic(uint64 first, uint64 second) public {
        first = uint64(bound(first, 1, T0));
        second = uint64(bound(second, 1, T0));
        vm.prank(forwarder);
        registry.onReport("", payload(first, 1));
        vm.prank(forwarder);
        if (second <= first) {
            vm.expectRevert(
                abi.encodeWithSelector(RiskAttestationRegistry.StaleAttestation.selector, AUSD, first, second)
            );
            registry.onReport("", payload(second, 2));
            assertEq(registry.latest(AUSD).timestamp, first);
            assertEq(uint8(registry.latest(AUSD).status), 1);
        } else {
            registry.onReport("", payload(second, 2));
            assertEq(registry.latest(AUSD).timestamp, second);
            assertEq(uint8(registry.latest(AUSD).status), 2);
        }
    }

    function testFuzz_statusRange(uint8 status) public {
        vm.prank(forwarder);
        if (status > 3) {
            vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidStatus.selector, status));
        }
        registry.onReport("", payload(T0, status));
        if (status <= 3) assertEq(uint8(registry.latest(AUSD).status), status);
    }

    function testFuzz_metadataLengthWithIdentityCheck(bytes calldata meta) public {
        registry.setWorkflowExpectation(keccak256("wf"), address(0), bytes10(0));
        vm.prank(forwarder);
        if (meta.length != 62 && meta.length != 64) {
            vm.expectRevert(abi.encodeWithSelector(RiskAttestationRegistry.InvalidMetadata.selector, meta.length));
        } else if (bytes32(meta[0:32]) != keccak256("wf")) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    RiskAttestationRegistry.InvalidWorkflowId.selector, bytes32(meta[0:32]), keccak256("wf")
                )
            );
        }
        registry.onReport(meta, payload(T0, 1));
    }
}
