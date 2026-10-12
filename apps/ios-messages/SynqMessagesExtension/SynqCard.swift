import Foundation

/// Swift mirror of the canonical `synq.card/v1` schema (packages/schemas/src/cards.ts).
/// Display only: amounts are the backend's exact decimal strings and are never parsed
/// into numbers or recomputed here.
struct CardMoney: Codable, Equatable {
    let amount: String
    let symbol: String
    var text: String { "\(amount) \(symbol)" }
}

struct CardAction: Codable, Equatable {
    let kind: String
    let label: String
    let url: String
    let style: String
}

struct CardQuorum: Codable, Equatable {
    let counted: Int
    let required: Int
}

struct CardRecipient: Codable, Equatable {
    let label: String
    let address: String?
}

struct CardOption: Codable, Equatable {
    let optionId: String
    let product: String?
    let price: CardMoney?
    let delivery: String?
    let votes: Int?
    let hotel: String?
    let room: String?
    let total: CardMoney?
    let cancellation: String?
    let preferenceVotes: Int?
}

struct SynqCard: Codable, Equatable {
    let schema: String
    let type: String
    let cardId: String
    let groupId: String
    let groupLabel: String
    let issuedAt: Int
    let actions: [CardAction]
    // GROUP_TREASURY
    let balance: CardMoney?
    let available: CardMoney?
    let reserved: CardMoney?
    let memberCount: Int?
    // APPROVAL_PROPOSAL
    let proposalId: String?
    let proposalKind: String?
    let amount: CardMoney?
    let recipient: CardRecipient?
    let reason: String?
    let quorum: CardQuorum?
    let status: String?
    // GROUP_GIFT / HOTEL_COMPARISON
    let occasion: String?
    let stay: String?
    let options: [CardOption]?
    let provider: String?
    // DCA_MANDATE
    let asset: String?
    let frequency: String?
    let perExecutionLimit: CardMoney?
    let cumulativeLimit: CardMoney?
    // EXECUTION_RECEIPT
    let label: String?
    let transactionHash: String?
    let settlementStatus: String?
    let executionMode: String?

    static let supportedSchema = "synq.card/v1"

    var title: String {
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
    var lines: [String] {
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
