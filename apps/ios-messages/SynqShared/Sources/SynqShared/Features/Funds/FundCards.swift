import SwiftUI

// Maps the fund API's views onto card models, status words and the live
// transcript bubbles. Labels stay truthful: the network comes from the fund
// (Monad testnet for the current backend), trips say Duffel test mode, gifts a
// sandbox card.

/// Money on a card always shows two decimals, like a statement.
public func cardAmount(_ s: String) -> String {
    guard let d = Decimal(string: s, locale: Locale(identifier: "en_US_POSIX")) else { return s }
    let f = NumberFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.minimumFractionDigits = 2
    f.maximumFractionDigits = 6
    f.minimumIntegerDigits = 1
    return f.string(from: d as NSDecimalNumber) ?? s
}

/// "0x3a1f…7f2d"-style short form of an id or address.
public func shortId(_ s: String) -> String {
    s.count > 12 ? "\(s.prefix(6))…\(s.suffix(4))" : s
}

/// Network labels in title case ("Monad testnet" → "Monad Testnet").
public func networkTitle(_ s: String) -> String {
    s.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
}

extension String {
    public var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

private func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String {
    "\(n) \(n == 1 ? one : (many ?? one + "s"))"
}

// MARK: - Fund

extension FundView {
    public var tone: SynqTone {
        switch state {
        case "FORMING", "SETUP": return .waiting
        case "LAUNCHING": return .moving
        case "ACTIVE": return .live
        default: return .failed
        }
    }

    public var cardStatus: String {
        switch state {
        case "FORMING": return "Joining"
        case "LAUNCHING": return "Creating"
        case "SETUP": return setup.map { "Activating \($0.signed)/\($0.required)" } ?? "Activating"
        case "ACTIVE": return "Live"
        default: return "Failed"
        }
    }

    public var activatedCount: Int { members.filter(\.activated).count }
    public var pendingProposals: [FundProposal] { proposals.filter { $0.state == "PENDING" } }

    public var card: SynqCardModel {
        let balance = treasury.map { cardAmount($0.balance) }
        let label = [
            "Synq group fund \(name).",
            state == "ACTIVE" ? "Balance \(balance ?? "unknown") \(treasury?.symbol ?? "AUSD")." : "\(plural(members.count, "member")) joined.",
            "Status \(cardStatus).", "\(threshold) members approve each payment.", "Network \(networkLabel).",
        ].joined(separator: " ")
        return SynqCardModel(art: .fund, eyebrow: "Group fund", title: name,
                             amount: state == "ACTIVE" ? balance : nil, unit: treasury?.symbol ?? "AUSD",
                             detail: state == "ACTIVE" ? "\(threshold) of \(members.count) approve each payment"
                                                       : "\(memberSummary) · join with Face ID",
                             badge: tone.badge, status: cardStatus,
                             progress: state == "SETUP" ? setup.map { ($0.signed, $0.required) }
                                 : state == "FORMING" ? (min(members.count, minMembers), minMembers) : nil,
                             network: networkTitle(networkLabel), accessibilityLabel: label)
    }
}

/// The card shown before a fund exists or while it loads.
public func draftFundCard(name: String, network: String = SynqNetwork.fundBackend) -> SynqCardModel {
    let n = name.isEmpty ? "Your fund" : name
    return SynqCardModel(art: .fund, eyebrow: "Group fund", title: n, amount: nil, unit: "AUSD",
                         detail: "Everyone joins with Face ID", badge: .pending, status: "New", progress: nil,
                         network: networkTitle(network), accessibilityLabel: "New Synq group fund \(n). Network \(network).")
}

// MARK: - Payment

extension FundProposal {
    public var tone: SynqTone {
        switch state {
        case "PAID": return .done
        case "EXECUTING": return .moving
        case "REJECTED": return .failed
        default: return .waiting
        }
    }

    public var cardStatus: String {
        switch state {
        case "PAID": return "Paid"
        case "EXECUTING": return "Sending"
        case "REJECTED": return "Rejected"
        default: return "\(approvals.counted) of \(approvals.required)"
        }
    }

    public func card(fundName: String, network: String) -> SynqCardModel {
        let label = "Synq payment of \(amount) \(symbol) to \(recipient) from \(fundName). "
            + "Status \(statusText). \(approvals.counted) of \(approvals.required) approvals. Network \(network)."
        return SynqCardModel(art: state == "PAID" ? .receipt : .send, eyebrow: "Payment · \(fundName)",
                             title: "To \(recipient)", amount: cardAmount(amount), unit: symbol,
                             detail: sender.map { "Proposed by \($0)" } ?? "From \(fundName)",
                             badge: tone.badge, status: cardStatus,
                             progress: state == "PENDING" ? (approvals.counted, approvals.required) : nil,
                             network: networkTitle(network), accessibilityLabel: label)
    }
}

// MARK: - Trips and gifts

extension TripView {
    public var tone: SynqTone {
        switch state {
        case "VOTING", "AWAITING_PAYMENT": return .waiting
        case "BOOKING": return .moving
        case "BOOKED": return .done
        default: return .failed
        }
    }

    public var cardStatus: String {
        switch state {
        case "VOTING": return "Voting"
        case "AWAITING_PAYMENT": return "Approve"
        case "BOOKING": return isGift ? "Buying" : "Booking"
        case "BOOKED": return isGift ? "Bought" : "Booked"
        default: return "Failed"
        }
    }

    public var isReturn: Bool { returnDate != nil }
    public var leadingOption: TripOptionView? {
        chosenOption ?? options.first { $0.optionId == leading } ?? options.first
    }

    public var originLabel: String { origin.flatMap { Airports.label(for: $0) } ?? origin ?? "" }
    public var destinationLabel: String { destination.flatMap { Airports.label(for: $0) } ?? destination ?? "" }

    /// "Delhi → Goa", or the gift being chosen.
    public var cardTitle: String {
        if isGift { return leadingOption?.title ?? (query ?? title) }
        return "\(originLabel) → \(destinationLabel)"
    }

    /// "DEL → GOI", or the gift search.
    public var routeTitle: String {
        isGift ? (query ?? title).capitalizedFirst : "\(origin ?? "") → \(destination ?? "")"
    }

    public var dateText: String { TripFormat.range(departureDate, returnDate) }

    /// The provider mode, always shown: flights are Duffel test mode, gifts a sandbox card.
    public var modeLabel: String { isGift ? "Sandbox" : "Duffel test" }

    public func card(fundName: String) -> SynqCardModel {
        let price: (String, String)? = payment.map { (cardAmount($0.amount), "AUSD") }
            ?? leadingOption.map { (cardAmount($0.total), $0.currency) }
        let what = isGift ? "gift \(cardTitle)" : "\(isReturn ? "return " : "")flight \(cardTitle), \(dateText)"
        let label = "Synq group \(what). \(price.map { "Price \($0.0) \($0.1). " } ?? "")Status \(stateText). "
            + "\(plural(voteCount, "vote")). \(modeLabel)."
        return SynqCardModel(art: isGift ? .gift : .flights,
                             eyebrow: isGift ? "Group gift" : (isReturn ? "Return flight" : "Flight"),
                             title: isGift ? cardTitle : "\(routeTitle) · \(dateText)",
                             amount: price?.0, unit: price?.1 ?? "",
                             detail: isGift ? "\(plural(options.count, "option")) · \(plural(voteCount, "vote"))"
                                            : "\(TripFormat.travellers(travelers ?? 1)) · \(plural(voteCount, "vote"))",
                             badge: tone.badge, status: cardStatus, progress: nil, network: modeLabel,
                             accessibilityLabel: label)
    }
}

// MARK: - Transcript bubbles

public struct FundInviteBubble: View {
    public let fallbackName: String
    public let view: FundView?

    public var body: some View { SynqCardBubble(model: view?.card ?? draftFundCard(name: fallbackName)) }
}

public struct FundProposalBubble: View {
    public let proposal: FundProposal?
    public let fundName: String?
    public var network: String = SynqNetwork.fundBackend

    public var body: some View {
        SynqCardBubble(model: proposal?.card(fundName: fundName ?? "Synq", network: network)
            ?? SynqCardModel(art: .send, eyebrow: "Payment", title: fundName ?? "Synq", amount: nil, unit: "AUSD",
                             detail: "Tap to review", badge: .pending, status: "Review", progress: nil,
                             network: networkTitle(network), accessibilityLabel: "Synq payment. Tap to review."))
    }
}

public struct FundTripBubble: View {
    public let trip: TripView?
    public let fundName: String?

    public var body: some View {
        SynqCardBubble(model: trip?.card(fundName: fundName ?? "Synq")
            ?? SynqCardModel(art: .flights, eyebrow: "Group pick", title: fundName ?? "Synq", amount: nil, unit: "",
                             detail: "Tap to vote", badge: .pending, status: "Vote", progress: nil,
                             network: "Duffel test", accessibilityLabel: "Synq group pick. Tap to vote."))
    }
}
