// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RiskAttestationRegistry} from "../../src/RiskAttestationRegistry.sol";

contract RiskAttestationHandler is Test {
    RiskAttestationRegistry public immutable registry;
    address public immutable forwarder;
    bytes32[2] public assets = [keccak256("ausd"), keccak256("usdc")];
    mapping(bytes32 => uint64) public maxAccepted;
    uint256 public accepted;
    uint256 public rejected;
    bool public foreignWriteSucceeded;

    constructor(RiskAttestationRegistry registry_, address forwarder_) {
        registry = registry_;
        forwarder = forwarder_;
    }

    function deliver(uint256 assetSeed, uint64 timestamp, uint8 status, uint256 price, uint256 warp) external {
        vm.warp(block.timestamp + bound(warp, 0, 1 days));
        bytes32 asset = assets[assetSeed % 2];
        timestamp = uint64(bound(timestamp, 0, block.timestamp + 600));
        status = uint8(bound(status, 0, 5));
        price = bound(price, 0, 2e8);
        vm.prank(forwarder);
        try registry.onReport("", abi.encode(asset, timestamp, price, uint32(0), uint64(0), status, bytes32(0))) {
            accepted++;
            if (timestamp > maxAccepted[asset]) maxAccepted[asset] = timestamp;
        } catch {
            rejected++;
        }
    }

    function forge(address sender, uint256 assetSeed, uint64 timestamp) external {
        if (sender == forwarder) return;
        bytes32 asset = assets[assetSeed % 2];
        vm.prank(sender);
        try registry.onReport(
            "", abi.encode(asset, timestamp, uint256(1e8), uint32(0), uint64(0), uint8(1), bytes32(0))
        ) {
            foreignWriteSucceeded = true;
        } catch {}
    }
}

contract RiskAttestationInvariantsTest is Test {
    RiskAttestationRegistry internal registry;
    RiskAttestationHandler internal handler;
    address internal forwarder = makeAddr("forwarder");

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new RiskAttestationRegistry(forwarder);
        handler = new RiskAttestationHandler(registry, forwarder);
        targetContract(address(handler));
    }

    function invariant_latestTimestampIsTheMaximumAccepted() public view {
        for (uint256 i; i < 2; ++i) {
            bytes32 asset = handler.assets(i);
            assertEq(registry.latest(asset).timestamp, handler.maxAccepted(asset));
        }
    }

    function invariant_statusAndPriceAreConsistent() public view {
        for (uint256 i; i < 2; ++i) {
            RiskAttestationRegistry.Attestation memory a = registry.latest(handler.assets(i));
            assertLe(uint8(a.status), 3);
            if (
                a.status == RiskAttestationRegistry.Status.HEALTHY
                    || a.status == RiskAttestationRegistry.Status.DEGRADED
            ) {
                assertGt(a.referencePrice, 0);
            }
            assertLe(a.timestamp, a.recordedAt + registry.MAX_FUTURE_SKEW());
        }
    }

    function invariant_onlyForwarderCanWrite() public view {
        assertFalse(handler.foreignWriteSucceeded());
    }

    function afterInvariant() external view {
        assertGt(handler.accepted(), 0);
        assertGt(handler.rejected(), 0);
    }
}
