import Foundation
import SwiftUI
import SynqContracts

/// Everything the app has read for one context. Owned only by `SynqAppModel`;
/// dropping it (context switch, sign-out, expiry, revocation) drops every
/// record it holds. Reads are in memory only.
@MainActor
public final class ContextScope: ObservableObject {
    public let context: WorkspaceContext
    let api: SynqAPI
    let token: @Sendable () async throws -> String
    var onSessionEnded: ((Bool) -> Void)?
    private var remotes: [String: AnyObject] = [:]
    private var cancels: [() -> Void] = []

    /// A group fund opened from a link on this iPhone.
    @Published public var openedFund: FundRef?

    init(context: WorkspaceContext, api: SynqAPI, token: @escaping @Sendable () async throws -> String) {
        self.context = context
        self.api = api
        self.token = token
    }

    /// For previews and tests.
    public static func preview(_ context: WorkspaceContext, host: String = "synq.example") -> ContextScope {
        let api = SynqAPI(host: host, store: SessionStore(host: host, secrets: MemorySecretStore()))
        return ContextScope(context: context, api: api, token: { throw APIFailure.signedOut })
    }

    public var workspaceId: String? { context.workspaceId }

    /// One remote per key, created on first use and kept for the scope's life.
    func remote<T>(_ key: String, route: String, _ work: @escaping (ContextScope) async throws -> T) -> Remote<T> {
        if let r = remotes[key] as? Remote<T> { return r }
        let r = Remote<T>(routeId: route) { [weak self] in
            guard let self else { throw CancellationError() }
            return try await work(self)
        }
        r.onSessionEnded = { [weak self] revoked in self?.onSessionEnded?(revoked) }
        remotes[key] = r
        cancels.append { [weak r] in r?.cancel() }
        return r
    }

    /// Installs a preset value (previews and tests only; marked LOCAL_FIXTURE where shown).
    public func preset<T>(_ key: String, route: String, _ state: RemoteState<T>) {
        remotes[key] = Remote<T>(routeId: route, preset: state)
    }

    func cancelAll() {
        cancels.forEach { $0() }
        cancels = []
        remotes = [:]
        openedFund = nil
    }

    public var remoteCount: Int { remotes.count }

    func openFund(_ ref: FundRef) { openedFund = ref }

    var v2: WorkspaceClient { WorkspaceClient(host: api.host, token: token) }

    // MARK: Personal (v3)

    public var personalOverview: Remote<PersonalOverview> {
        remote("personal.overview", route: "personal.overview") { try await $0.api.call("personal.overview", as: PersonalOverview.self) }
    }

    public var circles: Remote<CirclePage> {
        remote("personal.circles", route: "personal.circles") { try await $0.api.call("personal.circles", as: CirclePage.self) }
    }

    public func circle(_ id: String) -> Remote<CircleDetail> {
        remote("personal.circle:\(id)", route: "personal.circle") {
            try await $0.api.call("personal.circle", params: ["circleId": id], as: CircleDetail.self)
        }
    }

    /// Group workspaces from /v2 while v3 circles are not served (real reads).
    public var legacyGroups: Remote<[WorkspaceSummary]> {
        remote("v2.groups", route: "v2.workspaces") { s in try await s.legacy { try await s.v2.list().filter { $0.kind == "GROUP" } } }
    }

    public func legacyGroup(_ id: String) -> Remote<WorkspaceGroup> {
        remote("v2.group:\(id)", route: "v2.contributions") { s in try await s.legacy { try await s.v2.group(id) } }
    }

    // MARK: Business (v3)

    public var overview: Remote<WorkspaceOverview> {
        remote("workspace.overview", route: "workspace.overview") {
            try await $0.api.call("workspace.overview", params: ["workspaceId": try $0.requireWorkspace()], as: WorkspaceOverview.self)
        }
    }

    public func inbox(filter: InboxFilter) -> Remote<InboxPage> {
        remote("workspace.inbox:\(filter.rawValue)", route: "workspace.inbox") {
            try await $0.api.call("workspace.inbox", params: ["workspaceId": try $0.requireWorkspace()],
                                  query: filter.query, as: InboxPage.self)
        }
    }

    public func lead(_ id: String) -> Remote<LeadDetail> {
        remote("workspace.lead:\(id)", route: "workspace.lead") {
            try await $0.api.call("workspace.lead", params: ["workspaceId": try $0.requireWorkspace(), "leadId": id], as: LeadDetail.self)
        }
    }

    public var agentRuns: Remote<AgentRunPage> {
        remote("workspace.agentRuns", route: "workspace.agentRuns") {
            try await $0.api.call("workspace.agentRuns", params: ["workspaceId": try $0.requireWorkspace()], as: AgentRunPage.self)
        }
    }

    public func agentRun(_ id: String) -> Remote<AgentRunDetail> {
        remote("workspace.agentRun:\(id)", route: "workspace.agentRun") {
            try await $0.api.call("workspace.agentRun", params: ["workspaceId": try $0.requireWorkspace(), "runId": id], as: AgentRunDetail.self)
        }
    }

    public var mandates: Remote<Mandates> {
        remote("workspace.mandates", route: "workspace.mandates") {
            try await $0.api.call("workspace.mandates", params: ["workspaceId": try $0.requireWorkspace()], as: Mandates.self)
        }
    }

    // MARK: Business (/v2, live today)

    public var legacySnapshot: Remote<WorkspaceSnapshot> {
        remote("v2.snapshot", route: "v2.snapshot") { s in try await s.legacy { try await s.v2.snapshot(try s.requireWorkspace()) } }
    }

    public var legacyInvoices: Remote<[WorkspaceInvoice]> {
        remote("v2.invoices", route: "v2.invoices") { s in try await s.legacy { try await s.v2.invoices(try s.requireWorkspace()) } }
    }

    public var legacyPayouts: Remote<[WorkspacePayout]> {
        remote("v2.payouts", route: "v2.payouts") { s in try await s.legacy { try await s.v2.payouts(try s.requireWorkspace()) } }
    }

    public var legacyDeals: Remote<[WorkspaceDeal]> {
        remote("v2.deals", route: "v2.deals") { s in try await s.legacy { try await s.v2.deals(try s.requireWorkspace()) } }
    }

    public var legacyBooks: Remote<WorkspaceBooks> {
        remote("v2.books", route: "v2.books") { s in try await s.legacy { try await s.v2.books(try s.requireWorkspace()) } }
    }

    // MARK: Everyone

    public var approvals: Remote<ApprovalPage> {
        remote("approvals.list", route: "approvals.list") { try await $0.api.call("approvals.list", as: ApprovalPage.self) }
    }

    public var notifications: Remote<NotificationPage> {
        remote("notifications.list", route: "notifications.list") { try await $0.api.call("notifications.list", as: NotificationPage.self) }
    }

    public var sessions: Remote<SessionList> {
        remote("auth.sessions", route: "auth.sessions") { try await $0.api.call("auth.sessions", as: SessionList.self) }
    }

    // MARK: Helpers

    func requireWorkspace() throws -> String {
        guard let id = context.workspaceId else { throw APIFailure.notFound }
        return id
    }

    /// Maps the /v2 client's errors onto the contract's.
    func legacy<T>(_ work: () async throws -> T) async throws -> T {
        do {
            return try await work()
        } catch let e as FundAPIError {
            switch e.error {
            case "SESSION_EXPIRED": throw APIFailure.sessionEnded(revoked: false)
            case "NOT_FOUND", "WORKSPACE_NOT_FOUND": throw APIFailure.notFound
            case "FORBIDDEN": throw APIFailure.forbidden(e.message)
            default: throw APIFailure.server(e.message)
            }
        } catch let e as URLError {
            throw e.code == .cancelled ? CancellationError() as Error : APIFailure.offline
        }
    }
}

/// Owner inbox filters, sent to the server (`handling`), never applied locally
/// on a partial page.
public enum InboxFilter: String, CaseIterable, Identifiable, Sendable {
    case all, agent, human, frozen
    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .all: return "All"
        case .agent: return "Agent"
        case .human: return "Taken over"
        case .frozen: return "Frozen"
        }
    }
    var query: [URLQueryItem] {
        switch self {
        case .all: return []
        case .agent: return [URLQueryItem(name: "handling", value: "AGENT")]
        case .human: return [URLQueryItem(name: "handling", value: "HUMAN")]
        case .frozen: return [URLQueryItem(name: "handling", value: "FROZEN")]
        }
    }
}
