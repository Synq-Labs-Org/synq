import Foundation

/// Swift mirror of the canonical `synq.card/v1` schema (packages/schemas/src/cards.ts).
/// Display only: amounts are the backend's exact decimal strings and are never parsed
/// into numbers or recomputed here.
public struct CardMoney: Codable, Equatable {
    public let amount: String
    public let symbol: String
    public var text: String { "\(amount) \(symbol)" }
}

public struct CardAction: Codable, Equatable {
    public let kind: String
    public let label: String
    public let url: String
    public let style: String
}

public struct CardQuorum: Codable, Equatable {
    public let counted: Int
    public let required: Int
}

public struct CardRecipient: Codable, Equatable {
    public let label: String
    public let address: String?
}

public struct CardOption: Codable, Equatable {
    public let optionId: String
    public let product: String?
    public let price: CardMoney?
    public let delivery: String?
    public let votes: Int?
    public let hotel: String?
    public let room: String?
    public let total: CardMoney?
    public let cancellation: String?
    public let preferenceVotes: Int?
}

public struct SynqCard: Codable, Equatable {
    public let schema: String
    public let type: String
    public let cardId: String
    public let groupId: String
    public let groupLabel: String
    public let issuedAt: Int
    public let actions: [CardAction]
    // GROUP_TREASURY
    public let balance: CardMoney?
    public let available: CardMoney?
    public let reserved: CardMoney?
    public let memberCount: Int?
    // APPROVAL_PROPOSAL
    public let proposalId: String?
    public let proposalKind: String?
    public let amount: CardMoney?
    public let recipient: CardRecipient?
    public let reason: String?
    public let quorum: CardQuorum?
    public let status: String?
    // GROUP_GIFT / HOTEL_COMPARISON
    public let occasion: String?
    public let stay: String?
    public let options: [CardOption]?
    public let provider: String?
    // DCA_MANDATE
    public let asset: String?
    public let frequency: String?
    public let perExecutionLimit: CardMoney?
    public let cumulativeLimit: CardMoney?
    // EXECUTION_RECEIPT
    public let label: String?
    public let transactionHash: String?
    public let settlementStatus: String?
    public let executionMode: String?

    public static let supportedSchema = "synq.card/v1"

    public var title: String {
        switch type {
        case "GROUP_TREASURY": return "\(groupLabel) treasury"
        case "APPROVAL_PROPOSAL": return reason ?? "Group proposal"
        case "GROUP_GIFT": return "Group gift: \(occasion ?? "")"
        case "HOTEL_COMPARISON": return "Hotels: \(stay ?? "")"
        case "DCA_MANDATE": return "DCA \(asset ?? "")"
        case "EXECUTION_RECEIPT": return "Receipt: \(label ?? "")"
        default: return "Synq"
        }
    }

    /// Detail lines; mirrors the server renderers' wording without any arithmetic.
    public var lines: [String] {
        var out: [String] = []
        switch type {
        case "GROUP_TREASURY":
            if let b = balance { out.append("Balance \(b.text)") }
            if let a = available, let r = reserved { out.append("Available \(a.text) · Reserved \(r.text)") }
            if let m = memberCount { out.append("\(m) members") }
        case "APPROVAL_PROPOSAL":
            if let a = amount { out.append("Amount \(a.text)") }
            if let r = recipient { out.append("To \(r.label)") }
            if let q = quorum { out.append("\(q.counted)/\(q.required) verified approvals") }
            if let s = status { out.append(s.capitalized) }
        case "GROUP_GIFT", "HOTEL_COMPARISON":
            for o in options ?? [] {
                if let p = o.product, let price = o.price { out.append("\(p): \(price.text)") }
                if let h = o.hotel, let t = o.total { out.append("\(h), \(o.room ?? ""): \(t.text)") }
            }
            if let p = provider { out.append("\(p) [\(executionMode ?? "")]") }
        case "DCA_MANDATE":
            if let l = perExecutionLimit { out.append("Per run \(l.text)") }
            if let c = cumulativeLimit { out.append("Limit \(c.text)") }
            if let f = frequency { out.append(f) }
        case "EXECUTION_RECEIPT":
            out.append("\(status ?? "") · \(settlementStatus ?? "")")
            out.append("[\(executionMode ?? "UNKNOWN")]")
            if let h = transactionHash { out.append("tx \(h.prefix(10))…") }
        default:
            break
        }
        return out
    }
}
