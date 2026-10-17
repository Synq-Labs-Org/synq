import Foundation
import SynqContracts
@testable import SynqShared
import XCTest

/// The safe default ports do nothing and say so, fund scope never carries a
/// conversation, and card links still route exactly as before the extraction.
@MainActor
final class PortsAndRoutingTests: XCTestCase {
    func testDefaultWalletSignerRefusesAndSaysWhy() async {
        let signer = NoWalletSigner()
        XCTAssertEqual(signer.availability.status, .notConfigured)
        let request = SigningRequest(
            request: ApprovalItem(requestId: "r1", workspaceId: "w1", workspaceName: "W", purpose: .payout,
                                  summary: "s", approvals: 0, threshold: 1, expiresAt: "2026-10-17T00:00:00Z"),
            signer: "0x1…1", signerAddress: "0x" + String(repeating: "1", count: 40), enforcedBy: "x",
            steps: [SigningStep(label: "Approve", typedData: TypedData(domain: [:], types: [:], primaryType: "X", message: [:]))])
        do {
            _ = try await signer.sign(request, step: 0, typedDataJSON: Data(), gesture: UserApprovalGesture(requestId: "r1"))
            XCTFail("the default signer must never return a signature")
        } catch let e as WalletApprovalError {
            XCTAssertEqual(e, .notConfigured(signer.availability.reason))
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testCardsAreOnlyOfferedWhereTheyCanBeInserted() {
        XCTAssertFalse(NoMessagesCards().canInsert)
        XCTAssertFalse(FundActions(cards: NoMessagesCards(), links: NoDeepLinks()).canInsertCards)
        XCTAssertFalse(FundActions.none.canInsertCards)
    }

    func testFundContextDropsTheConversation() {
        let ref = FundRef(fundId: "fnd_00000000000000000001", key: String(repeating: "k", count: 32), name: "Goa",
                          adminKey: "admin", conversations: ["a,b"], lastUsed: Date())
        let ctx = FundContext(ref)
        XCTAssertEqual(ctx, FundContext(fundId: ref.fundId, key: ref.key, name: "Goa"))
        // FundContext has no conversation and no admin key to leak into business calls.
        XCTAssertEqual(Mirror(reflecting: ctx).children.compactMap(\.label).sorted(), ["fundId", "key", "name"])
    }

    func testFundLinksRouteAsBefore() {
        let host = "synq.example"
        let key = String(repeating: "A", count: 32)
        let invite = URL(string: "https://\(host)/fund/fnd_0123456789abcdef0123#k=\(key)")!
        XCTAssertEqual(FundLink(url: invite, allowedHost: host), .invite(fundId: "fnd_0123456789abcdef0123", key: key))
        let trip = URL(string: "https://\(host)/fund/fnd_0123456789abcdef0123/t/trp_0123456789abcdef#k=\(key)")!
        XCTAssertEqual(FundLink(url: trip, allowedHost: host),
                       .trip(fundId: "fnd_0123456789abcdef0123", key: key, tripId: "trp_0123456789abcdef"))
        XCTAssertNil(FundLink(url: invite, allowedHost: "evil.example"))
        XCTAssertNil(FundLink(url: URL(string: invite.absoluteString.replacingOccurrences(of: "https", with: "http"))!,
                              allowedHost: host))
        // Round trip: the URL an invite card carries parses back to the same link.
        let link = FundLink.invite(fundId: "fnd_0123456789abcdef0123", key: key)
        XCTAssertEqual(FundLink(url: link.url(host: host), allowedHost: host), link)
    }

    func testContextsDropUnknownKindsAndScopeCaches() {
        let business = Context(contextId: "w1", kind: .business, workspaceId: "w1", displayName: "Studio",
                               role: .owner, workspaceStatus: .active, unreadCount: 2)
        let unknown = Context(contextId: "x", kind: .unknown, displayName: "?", unreadCount: 0)
        let headless = Context(contextId: "y", kind: .business, displayName: "No id", unreadCount: 0)
        XCTAssertEqual(WorkspaceContext(business, principalId: "p1")?.cacheScope, "p1/w1")
        XCTAssertNil(WorkspaceContext(unknown, principalId: "p1"))
        XCTAssertNil(WorkspaceContext(headless, principalId: "p1"))
        XCTAssertNotEqual(WorkspaceContext(business, principalId: "p1")?.cacheScope,
                          WorkspaceContext(business, principalId: "p2")?.cacheScope)
    }
}
