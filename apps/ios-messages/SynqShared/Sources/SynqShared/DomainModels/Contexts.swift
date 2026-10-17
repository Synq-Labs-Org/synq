import Foundation
import SynqContracts

/// The context a signed-in person is looking at: Personal, or one business
/// workspace with their role in it. Everything cached for a context is keyed by
/// `cacheScope`, so switching context or signing out can drop exactly that data.
/// It never carries a signing wallet: switching context does not switch wallets.
public struct WorkspaceContext: Equatable, Hashable, Identifiable, Sendable {
    public enum Kind: String, Sendable { case personal, business }

    public let principalId: String
    public let contextId: String
    public let kind: Kind
    public let workspaceId: String?
    public let displayName: String
    public let role: Role?
    public let status: WorkspaceStatus?
    public let unreadCount: Int

    public var id: String { contextId }
    public var cacheScope: String { "\(principalId)/\(contextId)" }
    public var isBusiness: Bool { kind == .business }

    public init(principalId: String, contextId: String, kind: Kind, workspaceId: String?, displayName: String,
                role: Role?, status: WorkspaceStatus?, unreadCount: Int) {
        self.principalId = principalId
        self.contextId = contextId
        self.kind = kind
        self.workspaceId = workspaceId
        self.displayName = displayName
        self.role = role
        self.status = status
        self.unreadCount = unreadCount
    }

    /// From the server's list; a context of a kind this version does not know is
    /// dropped rather than guessed at.
    public init?(_ c: Context, principalId: String) {
        switch c.kind {
        case .personal:
            self.init(principalId: principalId, contextId: c.contextId, kind: .personal, workspaceId: nil,
                      displayName: c.displayName, role: nil, status: nil, unreadCount: c.unreadCount)
        case .business:
            guard let id = c.workspaceId else { return nil }
            self.init(principalId: principalId, contextId: c.contextId, kind: .business, workspaceId: id,
                      displayName: c.displayName, role: c.role, status: c.workspaceStatus, unreadCount: c.unreadCount)
        case .unknown:
            return nil
        }
    }

    public static func personal(principalId: String) -> WorkspaceContext {
        WorkspaceContext(principalId: principalId, contextId: "personal", kind: .personal, workspaceId: nil,
                         displayName: "Personal", role: nil, status: nil, unreadCount: 0)
    }
}

/// A group fund as the fund API knows it: the id and its capability key. Unlike
/// `FundRef` it has no idea which Messages conversation it came from.
public struct FundContext: Equatable, Hashable, Sendable {
    public let fundId: String
    public let key: String
    public let name: String

    public init(fundId: String, key: String, name: String) {
        self.fundId = fundId
        self.key = key
        self.name = name
    }

    public init(_ ref: FundRef) {
        self.init(fundId: ref.fundId, key: ref.key, name: ref.name)
    }
}

public enum SynqText {
    /// "agentLeases" or "agent_leases" → "Agent leases"; server keys are never shown raw.
    public static func words(_ key: String) -> String {
        let spaced = key.replacingOccurrences(of: "([a-z0-9])([A-Z])", with: "$1 $2", options: .regularExpression)
            .replacingOccurrences(of: "[_-]+", with: " ", options: .regularExpression).lowercased()
        return spaced.prefix(1).uppercased() + spaced.dropFirst()
    }
}
