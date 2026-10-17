import Foundation
import SynqContracts
@testable import SynqShared
import XCTest

final class DomainRulesTests: XCTestCase {
    static let ws = "00000000-0000-4000-8000-000000000001"

    // MARK: Links

    func testUniversalLinksRouteOnlyOnTheSynqHost() {
        let host = "synqlabs.world"
        func r(_ s: String) -> SynqLinkRouter.Result { SynqLinkRouter.route(URL(string: s)!, host: host) }
        XCTAssertEqual(r("https://synqlabs.world/w/\(Self.ws)/inbox/lead_1"), .destination(.lead(workspaceId: Self.ws, leadId: "lead_1")))
        XCTAssertEqual(r("https://synqlabs.world/w/\(Self.ws)/deals/d1"), .destination(.deal(workspaceId: Self.ws, dealId: "d1")))
        XCTAssertEqual(r("https://synqlabs.world/w/\(Self.ws)/agents/run1"), .destination(.agentRun(workspaceId: Self.ws, runId: "run1")))
        XCTAssertEqual(r("https://synqlabs.world/personal/circles/c1"), .destination(.circle(circleId: "c1")))
        XCTAssertEqual(r("https://synqlabs.world/approve/req-1"), .destination(.approval(requestId: "req-1")))
        XCTAssertEqual(r("https://SYNQLABS.world/notifications"), .destination(.notifications))
        // Legacy review cards and checkout stay on the web.
        if case .web = r("https://synqlabs.world/approve?p=1&g=2&n=3") {} else { XCTFail("legacy approve must stay on the web") }
        if case .web = r("https://synqlabs.world/pay/tok123456789") {} else { XCTFail("checkout must stay on the web") }
        XCTAssertEqual(r("https://evil.example/w/\(Self.ws)/inbox/lead_1"), .rejected)
        XCTAssertEqual(r("http://synqlabs.world/approve/req-1"), .rejected)
        XCTAssertEqual(r("https://user@synqlabs.world/approve/req-1"), .rejected)
        if case .web = r("https://synqlabs.world/w/\(Self.ws)/inbox/a%2Fb") {} else { XCTFail("odd ids fall back to the web") }
        let key = String(repeating: "K", count: 32)
        XCTAssertEqual(r("https://synqlabs.world/fund/fnd_0123456789abcdef0123#k=\(key)"),
                       .fund(.invite(fundId: "fnd_0123456789abcdef0123", key: key)))
    }

    func testPushTapsFollowOnlySiteRelativePaths() {
        XCTAssertEqual(PushCenter.path(from: ["link": "/w/x/inbox/y"]), "/w/x/inbox/y")
        XCTAssertNil(PushCenter.path(from: ["link": "https://evil.example/w"]))
        XCTAssertNil(PushCenter.path(from: ["link": "//evil.example/w"]))
        XCTAssertNil(PushCenter.path(from: ["eventId": "e1"]))
    }

    // MARK: Money

    func testMoneyIsExactIntegerArithmetic() {
        XCTAssertEqual(SynqMoney.decimal("40000000", decimals: 6), "40")
        XCTAssertEqual(SynqMoney.decimal("1", decimals: 6), "0.000001")
        XCTAssertEqual(SynqMoney.decimal("0", decimals: 6), "0")
        XCTAssertEqual(SynqMoney.decimal("123456789012345678901234567890", decimals: 18), "123456789012.34567890123456789")
        XCTAssertEqual(SynqMoney.decimal("5", decimals: 0), "5")
        XCTAssertNil(SynqMoney.decimal("1.5", decimals: 6))
        XCTAssertNil(SynqMoney.decimal("-1", decimals: 6))
        XCTAssertNil(SynqMoney.decimal("", decimals: 6))
        XCTAssertEqual(SynqMoney.grouped("1234567.5"), "1,234,567.5")
        XCTAssertEqual(SynqMoney.text("abc", decimals: 6, symbol: "USDC"), "Unknown amount")
        let m = Money(assetId: "arc-testnet:USDC", symbol: "USDC", chainId: 5042002, decimals: 6, units: "1250000000")
        XCTAssertEqual(m.text, "1,250 USDC")
        XCTAssertEqual(m.network, "Arc testnet")
    }

    func testExplorerLinksMustBelongToTheReceiptsChain() {
        let tx = "0x" + String(repeating: "ab", count: 32)
        XCTAssertNotNil(SynqChains.explorerURL("https://testnet.arcscan.app/tx/\(tx)", chainId: 5042002, txHash: tx))
        XCTAssertNil(SynqChains.explorerURL("https://sepolia.etherscan.io/tx/\(tx)", chainId: 5042002, txHash: tx), "wrong chain")
        XCTAssertNil(SynqChains.explorerURL("https://testnet.arcscan.app/tx/0xother", chainId: 5042002, txHash: tx), "wrong tx")
        XCTAssertNil(SynqChains.explorerURL("http://testnet.arcscan.app/tx/\(tx)", chainId: 5042002, txHash: tx), "not https")
    }

    // MARK: Agent events

    func event(_ id: String, _ seq: String, ws: String = ws, tx: String? = nil, status: RunStatus = .pending) -> AgentEconomicEvent {
        AgentEconomicEvent(eventId: id, workspaceId: ws, runId: "r1", sequence: seq, correlationId: "c", kind: .intent,
                           actor: .deterministic, status: status, summary: id, sourceKind: "kernel",
                           observedAt: "2026-10-17T10:00:00Z", proofLevel: .notVerified, txHash: tx, chainId: tx == nil ? nil : 5042002)
    }

    func testTimelineDropsDuplicatesAndOtherWorkspacesAndOrdersBySequence() {
        let merged = AgentTimeline.merge([event("a", "2"), event("b", "10")],
                                         [event("a", "2"), event("c", "9"), event("x", "1", ws: "other")], workspaceId: Self.ws)
        XCTAssertEqual(merged.map(\.eventId), ["a", "c", "b"])
        XCTAssertTrue(AgentTimeline.sequenceLess("99", "100"))
        XCTAssertFalse(AgentTimeline.sequenceLess("100", "099"))
    }

    func testPaymentIsFinalOnlyWithAFinalReceipt() {
        let tx = "0xabc"
        let e = event("p", "1", tx: tx, status: .finalized)
        XCTAssertEqual(AgentTimeline.settlement(e, receipts: []), .pending, "a FINALIZED event without a receipt is not final")
        let pending = Receipt(chainId: 5042002, txHash: tx, finality: .pending)
        XCTAssertEqual(AgentTimeline.settlement(e, receipts: [pending]), .pending)
        let otherChain = Receipt(chainId: 10143, txHash: tx, finality: .finalized, ledgerEntryId: "l1")
        XCTAssertEqual(AgentTimeline.settlement(e, receipts: [otherChain]), .pending, "a receipt on another chain does not count")
        let final = Receipt(chainId: 5042002, txHash: tx, finality: .finalized)
        XCTAssertEqual(AgentTimeline.settlement(e, receipts: [final]), .final(reconciled: false))
        let reconciled = Receipt(chainId: 5042002, txHash: tx, finality: .finalized, ledgerEntryId: "l1")
        XCTAssertEqual(AgentTimeline.settlement(e, receipts: [reconciled]), .final(reconciled: true))
        XCTAssertEqual(AgentTimeline.settlement(e, receipts: [Receipt(chainId: 5042002, txHash: tx, finality: .reorged)]), .reorged)
    }

    func testEventFeedResumesFromItsCursorWithoutDuplicates() async throws {
        func se(_ id: String, _ c: String) -> StreamEvent {
            StreamEvent(cursor: c, eventId: id, type: .agentEvent, workspaceId: Self.ws, observedAt: "2026-10-17T10:00:00Z")
        }
        let pages = PageQueue([
            .success(StreamEventPage(items: [se("e1", "c1"), se("e2", "c2")], nextCursor: "c2")),
            .failure(APIFailure.offline),
            .success(StreamEventPage(items: [se("e2", "c2"), se("e3", "c3")], nextCursor: "c3")),
        ])
        let feed = EventCursorFeed { cursor in try await pages.next(cursor) }
        let first = try await feed.poll()
        XCTAssertEqual(first.map(\.eventId), ["e1", "e2"])
        do { _ = try await feed.poll(); XCTFail("offline") } catch {}
        let again = try await feed.poll()
        XCTAssertEqual(again.map(\.eventId), ["e3"], "the replayed e2 is not delivered twice")
        let cursors = await pages.cursors
        XCTAssertEqual(cursors, [nil, "c2", "c2"], "after the disconnect the feed resumes from the last cursor")
    }

    // MARK: Typed data

    func signingRequest(message: String, chainId: Int = 5042002, expires: String = "2099-01-01T00:00:00Z") -> (Data, SigningRequest) {
        let json = #"""
        {"request":{"requestId":"r1","workspaceId":"w1","workspaceName":"Studio","purpose":"PAYOUT","summary":"Pay","amount":{"assetId":"arc-testnet:USDC","symbol":"USDC","chainId":5042002,"decimals":6,"units":"40000000"},"approvals":1,"threshold":2,"expiresAt":"\#(expires)"},
         "signer":"0x1111…1111","enforcedBy":"Safe",
         "typedData":{"domain":{"name":"Synq","version":"1","chainId":\#(chainId)},"types":{"Payout":[{"name":"amount","type":"uint256"},{"name":"to","type":"address"}]},"primaryType":"Payout","message":\#(message)}}
        """#
        let data = Data(json.utf8)
        return (data, try! JSONDecoder().decode(SigningRequest.self, from: data))
    }

    func testTypedDataPassesWhenIntegersAreStrings() {
        let (data, req) = signingRequest(message: #"{"amount":"40000000","to":"0x3333333333333333333333333333333333333333"}"#)
        let p = TypedDataGuard.prepare(responseBody: data, request: req)
        XCTAssertTrue(p.canSign, p.problems.joined())
        XCTAssertFalse(p.json.isEmpty)
        let lines = TypedDataGuard.lines(req.typedData)
        XCTAssertTrue(lines.contains { $0.0 == "amount (uint256)" && $0.1 == "40000000" })
    }

    func testTypedDataRefusesNumbersChainMismatchAndExpiry() {
        let (d1, r1) = signingRequest(message: #"{"amount":40000000,"to":"0x3"}"#)
        XCTAssertFalse(TypedDataGuard.prepare(responseBody: d1, request: r1).canSign, "uint as JSON number")
        let (d2, r2) = signingRequest(message: #"{"amount":"1","to":"0x3"}"#, chainId: 1)
        XCTAssertFalse(TypedDataGuard.prepare(responseBody: d2, request: r2).canSign, "domain chain differs from the amount's chain")
        let (d3, r3) = signingRequest(message: #"{"amount":"1","to":"0x3"}"#, expires: "2001-01-01T00:00:00Z")
        XCTAssertFalse(TypedDataGuard.prepare(responseBody: d3, request: r3).canSign, "expired")
    }

    func testGeneratedSigningFixturePassesTheGuard() throws {
        let data = try Data(contentsOf: ContractFixtureTests.fixtures.appendingPathComponent("SigningRequest.json"))
        let req = try JSONDecoder().decode(SigningRequest.self, from: data)
        let p = TypedDataGuard.prepare(responseBody: data, request: req, now: SynqTime.parse("2026-10-17T10:00:00Z")!)
        XCTAssertTrue(p.canSign, p.problems.joined(separator: "; "))
    }

    func testPurposeLabelsNeverReadLikeSignIn() {
        for p in ApprovalPurpose.allCases {
            XCTAssertFalse(p.label.lowercased().contains("sign in"))
        }
        XCTAssertTrue(ApprovalPurpose.payout.movesMoney)
        XCTAssertFalse(ApprovalPurpose.dealTerms.movesMoney)
    }
}

actor PageQueue {
    private var results: [Result<StreamEventPage, Error>]
    private(set) var cursors: [String?] = []
    init(_ results: [Result<StreamEventPage, Error>]) { self.results = results }
    func next(_ cursor: String?) throws -> StreamEventPage {
        cursors.append(cursor)
        return try results.removeFirst().get()
    }
}
