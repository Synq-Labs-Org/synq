import Foundation
import SynqContracts
import XCTest

/// The generated Swift models decode every generated fixture (LOCAL_FIXTURE data,
/// synthetic, never shipped), and unknown enum values decode as `.unknown`.
final class ContractFixtureTests: XCTestCase {
    static let fixtures = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../../../packages/contracts/generated/fixtures").standardizedFileURL

    func fixture<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
        let data = try Data(contentsOf: Self.fixtures.appendingPathComponent("\(name).json"))
        return try JSONDecoder().decode(T.self, from: data)
    }

    func testEveryFixtureDecodes() throws {
        _ = try fixture("Meta", as: Meta.self)
        _ = try fixture("Contexts", as: Contexts.self)
        _ = try fixture("PersonalOverview", as: PersonalOverview.self)
        _ = try fixture("WorkspaceOverview", as: WorkspaceOverview.self)
        _ = try fixture("InboxPage", as: InboxPage.self)
        _ = try fixture("LeadDetail", as: LeadDetail.self)
        _ = try fixture("AgentRunDetail", as: AgentRunDetail.self)
        _ = try fixture("Mandates", as: Mandates.self)
        _ = try fixture("ApprovalPage", as: ApprovalPage.self)
        _ = try fixture("SigningRequest", as: SigningRequest.self)
        _ = try fixture("NotificationPage", as: NotificationPage.self)
        _ = try fixture("ClientLeadList", as: ClientLeadList.self)
        _ = try fixture("ClientLeadDetail", as: ClientLeadDetail.self)
    }

    /// Every fixture the generator writes is covered by the test above.
    func testNoFixtureIsSkipped() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: Self.fixtures.path).filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertEqual(names, ["AgentRunDetail.json", "ApprovalPage.json", "ClientLeadDetail.json", "ClientLeadList.json", "Contexts.json", "InboxPage.json", "LeadDetail.json",
                               "Mandates.json", "Meta.json", "NotificationPage.json", "PersonalOverview.json",
                               "SigningRequest.json", "WorkspaceOverview.json"])
    }

    func testUnknownEnumValueDecodesAsUnknown() throws {
        let json = #"{"status":"SOMETHING_NEW","reason":"later"}"#.data(using: .utf8)!
        let cap = try JSONDecoder().decode(Capability.self, from: json)
        XCTAssertEqual(cap.status, .unknown)
    }
}
