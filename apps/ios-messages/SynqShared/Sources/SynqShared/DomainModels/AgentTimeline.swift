import Foundation
import SynqContracts

/// Ordering, de-duplication and truth rules for agent run events, kept apart from
/// the views so they are unit-tested.
public enum AgentTimeline {
    /// Compares decimal sequence strings without converting to a fixed-width integer.
    public static func sequenceLess(_ a: String, _ b: String) -> Bool {
        let x = a.drop(while: { $0 == "0" }), y = b.drop(while: { $0 == "0" })
        return x.count != y.count ? x.count < y.count : x < y
    }

    /// Merges a page of events into what is shown: one row per `eventId`, in
    /// sequence order, and only events of `workspaceId` (anything else is dropped).
    public static func merge(_ existing: [AgentEconomicEvent], _ incoming: [AgentEconomicEvent],
                             workspaceId: String) -> [AgentEconomicEvent] {
        var byId: [String: AgentEconomicEvent] = [:]
        for e in existing + incoming where e.workspaceId == workspaceId {
            if byId[e.eventId] == nil { byId[e.eventId] = e }
        }
        return byId.values.sorted { sequenceLess($0.sequence, $1.sequence) }
    }

    /// A receipt counts as final only when the chain receipt says so.
    public static func receipt(for event: AgentEconomicEvent, in receipts: [Receipt]) -> Receipt? {
        guard let hash = event.txHash?.lowercased() else { return nil }
        return receipts.first { $0.txHash.lowercased() == hash && (event.chainId == nil || $0.chainId == event.chainId) }
    }

    public enum Settlement: Equatable {
        case notAPayment
        /// Sent but no final receipt: never shown as final.
        case pending
        case final(reconciled: Bool)
        case reorged
    }

    /// What the row may claim about money, from receipts, not from the event text.
    public static func settlement(_ event: AgentEconomicEvent, receipts: [Receipt]) -> Settlement {
        guard event.txHash != nil else { return .notAPayment }
        guard let r = receipt(for: event, in: receipts) else { return .pending }
        switch r.finality {
        case .finalized: return .final(reconciled: r.ledgerEntryId != nil)
        case .reorged: return .reorged
        case .pending, .unknown: return .pending
        }
    }

    public static func actorWord(_ a: EventActor) -> String {
        switch a {
        case .model: return "Model suggestion"
        case .deterministic: return "Deterministic check"
        case .human: return "Person"
        case .chain: return "Chain"
        case .provider: return "Provider"
        case .unknown: return "Unknown source"
        }
    }

    public static func statusWord(_ s: RunStatus) -> String {
        switch s {
        case .pending: return "Pending"
        case .requiresOwner: return "Needs owner"
        case .authorized: return "Authorized"
        case .broadcast: return "Broadcast"
        case .finalized: return "Finalized"
        case .reconciled: return "Reconciled"
        case .blocked: return "Blocked"
        case .rejected: return "Rejected"
        case .timedOut: return "Timed out"
        case .reorgPending: return "Reorg pending"
        case .revoked: return "Revoked"
        case .quarantined: return "Quarantined"
        case .unknown: return "Unknown"
        }
    }
}

/// Polls `GET /v3/events/since` from a cursor: after a disconnect it resumes from
/// the last cursor it saw, and an event seen twice is delivered once.
public actor EventCursorFeed {
    public private(set) var cursor: String?
    private var seen: Set<String> = []
    private var order: [String] = []
    private let limit: Int
    private let fetch: @Sendable (String?) async throws -> StreamEventPage

    public init(cursor: String? = nil, remember limit: Int = 2000,
                fetch: @escaping @Sendable (String?) async throws -> StreamEventPage) {
        self.cursor = cursor
        self.limit = limit
        self.fetch = fetch
    }

    /// New events since the last call, in server order, without duplicates.
    public func poll() async throws -> [StreamEvent] {
        let page = try await fetch(cursor)
        var fresh: [StreamEvent] = []
        for e in page.items where !seen.contains(e.eventId) {
            seen.insert(e.eventId)
            order.append(e.eventId)
            fresh.append(e)
        }
        while order.count > limit { seen.remove(order.removeFirst()) }
        if let next = page.nextCursor ?? page.items.last?.cursor { cursor = next }
        return fresh
    }
}
