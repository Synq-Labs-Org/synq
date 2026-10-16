import SwiftUI

// Maps the fund API's views onto holo cards, and the live transcript bubbles.
// Labels stay truthful: the network comes from the fund (Monad testnet for the
// current backend), trips say Duffel test mode, gifts a sandbox card.

/// Money on a card always shows two decimals, like a statement.
func cardAmount(_ s: String) -> String {
    guard let d = Decimal(string: s, locale: Locale(identifier: "en_US_POSIX")) else { return s }
    let f = NumberFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.minimumFractionDigits = 2
    f.maximumFractionDigits = 6
    f.minimumIntegerDigits = 1
    return f.string(from: d as NSDecimalNumber) ?? s
}

/// "fnd_3a1f…" → "FND-3A1F"; a stable short id for the set line.
func setCode(_ prefix: String, _ id: String) -> String {
    let tail = id.replacingOccurrences(of: "0x", with: "").split(separator: "_").last.map(String.init) ?? id
    return "\(prefix)-\(tail.prefix(4).uppercased())"
}

extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}

private func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String {
    "\(n) \(n == 1 ? one : (many ?? one + "s"))"
}

// MARK: - Fund

extension FundView {
    var tone: SynqTone {
        switch state {
        case "FORMING", "SETUP": return .waiting
        case "LAUNCHING": return .moving
        case "ACTIVE": return .live
        default: return .failed
        }
    }

    var cardStatus: String {
        switch state {
        case "FORMING": return "Joining"
        case "LAUNCHING": return "Minting"
        case "SETUP": return setup.map { "Activating \($0.signed)/\($0.required)" } ?? "Activating"
        case "ACTIVE": return "Live"
        default: return "Failed"
        }
    }

    var activatedCount: Int { members.filter(\.activated).count }

    var holo: HoloCardModel {
        let rarity: HoloRarity = state == "ACTIVE" ? .rare : .common
        let headline: String?
        let unit: String
        var moves: [HoloMove]
        let flavor: String
        switch state {
        case "ACTIVE":
            headline = treasury.map { cardAmount($0.balance) }
            unit = treasury?.symbol ?? "AUSD"
            flavor = "Shared wallet · \(threshold) of \(members.count) approve every payment"
            moves = [
                HoloMove(symbol: "signature", name: "Approvals", detail: "Passkeys needed per payment",
                         value: "\(threshold) of \(members.count)"),
                HoloMove(symbol: "person.2.fill", name: "Members",
                         detail: members.prefix(3).map(\.name).joined(separator: ", "),
                         pips: .init(on: activatedCount, total: members.count)),
            ]
            let paid = proposals.filter { $0.state == "PAID" }.count
            let pending = proposals.filter { $0.state == "PENDING" }.count
            moves.append(HoloMove(symbol: "bolt.fill", name: "Payments",
                                  detail: "\(paid) paid · \(pending) waiting", value: maxPayment.map { "≤ \($0)" }))
        case "SETUP":
            headline = setup.map { "\($0.signed)/\($0.required)" }
            unit = "SIGNED"
            flavor = "Everyone activates once with Face ID"
            moves = [
                HoloMove(symbol: "faceid", name: "Activate", detail: "One passkey signature each",
                         pips: setup.map { .init(on: $0.signed, total: $0.required) }),
                HoloMove(symbol: "person.2.fill", name: "Members", detail: members.prefix(3).map(\.name).joined(separator: ", "),
                         value: "\(members.count)"),
                HoloMove(symbol: "dot.radiowaves.left.and.right", name: "Go live",
                         detail: "Live once \(setup?.required ?? threshold) have signed"),
            ]
        default:
            headline = "\(members.count)"
            unit = "JOINED"
            flavor = state == "LAUNCHING" ? "Creating the shared wallet" : "Join with Face ID · \(minMembers) needed to launch"
            moves = [
                HoloMove(symbol: "faceid", name: "Join", detail: "Face ID on the Synq page",
                         pips: .init(on: min(members.count, minMembers), total: minMembers)),
                HoloMove(symbol: "signature", name: "Approvals", detail: "Payments need \(threshold) members",
                         value: "\(threshold)"),
                HoloMove(symbol: "paperplane.fill", name: "Launch",
                         detail: state == "LAUNCHING" ? "Shared wallet on its way" : "The starter launches when ready"),
            ]
        }
        let stats: [HoloStat] = state == "ACTIVE"
            ? [HoloStat(label: "Threshold", value: "\(threshold)"), HoloStat(label: "Members", value: "\(members.count)"),
               HoloStat(label: "Limit", value: maxPayment ?? "—")]
            : [HoloStat(label: "Needed", value: "\(minMembers)"), HoloStat(label: "Joined", value: "\(members.count)"),
               HoloStat(label: "Approve", value: "\(threshold)")]
        let label = [
            "Synq group fund \(name).",
            state == "ACTIVE" ? "Balance \(headline ?? "unknown") \(unit)." : "\(plural(members.count, "member")) joined.",
            "Status \(cardStatus).",
            "\(threshold) members approve each payment.",
            "Network \(networkLabel).",
            "\(rarity.name) card.",
        ].joined(separator: " ")
        return HoloCardModel(kind: .fund, rarity: rarity, stage: "Group fund", name: name, headline: headline,
                             unit: unit, status: cardStatus, tone: tone, flavor: flavor, moves: moves,
                             setCode: setCode("FND", fundId), network: networkLabel,
                             art: HoloArtSpec(count: max(2, members.count)), stats: stats, accessibilityLabel: label)
    }
}

/// The card shown before a fund exists (Start screen) or while it loads.
func draftFundCard(name: String, network: String = SynqNetwork.fundBackend) -> HoloCardModel {
    let n = name.isEmpty ? "Your fund" : name
    return HoloCardModel(kind: .fund, rarity: .common, stage: "Group fund", name: n, headline: nil, unit: "AUSD",
                         status: "New", tone: .waiting, flavor: "Pool money with this chat",
                         moves: [
                            HoloMove(symbol: "faceid", name: "Join", detail: "Everyone joins with Face ID", value: "2+"),
                            HoloMove(symbol: "signature", name: "Approvals", detail: "Every payment needs two", value: "2"),
                            HoloMove(symbol: "lock.shield.fill", name: "Guarded", detail: "Synq never approves for you"),
                         ],
                         setCode: "FND-NEW", network: network, art: HoloArtSpec(count: 3),
                         stats: [HoloStat(label: "Members", value: "2–8"), HoloStat(label: "Approve", value: "2"),
                                 HoloStat(label: "Money", value: "Test")],
                         accessibilityLabel: "New Synq group fund \(n). Network \(network). Common card.")
}

// MARK: - Payment

extension FundProposal {
    var tone: SynqTone {
        switch state {
        case "PAID": return .done
        case "EXECUTING": return .moving
        case "REJECTED": return .failed
        default: return .waiting
        }
    }

    var rarity: HoloRarity {
        switch state {
        case "PAID": return .holoRare
        case "EXECUTING": return .rare
        default: return .common
        }
    }

    var cardStatus: String {
        switch state {
        case "PAID": return "Paid"
        case "EXECUTING": return "Sending"
        case "REJECTED": return "Void"
        default: return "\(approvals.counted) of \(approvals.required)"
        }
    }

    func holo(fundName: String, network: String) -> HoloCardModel {
        var moves = [
            HoloMove(symbol: "signature", name: "Approvals",
                     detail: approvals.names.isEmpty ? "Passkeys on the Synq page" : approvals.names.joined(separator: ", "),
                     pips: .init(on: approvals.counted, total: approvals.required)),
            HoloMove(symbol: "arrow.up.right", name: recipient, detail: "Recipient", value: nil),
        ]
        if state == "PAID", let tx = transactionHash {
            moves.append(HoloMove(symbol: "checkmark.seal.fill", name: "Settled", detail: "tx \(tx.prefix(10))…"))
        } else if let sender {
            moves.append(HoloMove(symbol: "person.fill", name: "Proposed", detail: "by \(sender)"))
        }
        let label = "Synq payment of \(amount) \(symbol) to \(recipient) from \(fundName). "
            + "Status \(statusText). \(approvals.counted) of \(approvals.required) approvals. Network \(network). \(rarity.name) card."
        return HoloCardModel(kind: .payment, rarity: rarity, stage: "Payment", name: "To \(recipient)",
                             headline: cardAmount(amount), unit: symbol, status: cardStatus, tone: tone,
                             flavor: "From \(fundName)" + (sender.map { " · proposed by \($0)" } ?? ""),
                             moves: moves, setCode: setCode("PAY", intentHash), network: network,
                             stats: [HoloStat(label: "Approvals", value: "\(approvals.counted)/\(approvals.required)"),
                                     HoloStat(label: "Asset", value: symbol),
                                     HoloStat(label: "Fund", value: fundName)],
                             accessibilityLabel: label)
    }
}

// MARK: - Trips and gifts

extension TripView {
    var tone: SynqTone {
        switch state {
        case "VOTING", "AWAITING_PAYMENT": return .waiting
        case "BOOKING": return .moving
        case "BOOKED": return .done
        default: return .failed
        }
    }

    var rarity: HoloRarity {
        switch state {
        case "BOOKED": return .holoRare
        case "BOOKING": return .rare
        default: return .common
        }
    }

    var cardStatus: String {
        switch state {
        case "VOTING": return "Voting"
        case "AWAITING_PAYMENT": return "Approve"
        case "BOOKING": return isGift ? "Buying" : "Booking"
        case "BOOKED": return isGift ? "Bought" : "Booked"
        default: return "Failed"
        }
    }

    var isReturn: Bool { returnDate != nil }
    var leadingOption: TripOptionView? {
        chosenOption ?? options.first { $0.optionId == leading } ?? options.first
    }

    var originLabel: String { origin.flatMap { Airports.label(for: $0) } ?? origin ?? "" }
    var destinationLabel: String { destination.flatMap { Airports.label(for: $0) } ?? destination ?? "" }

    /// "Delhi → Goa", or the gift being chosen.
    var cardTitle: String {
        if isGift { return leadingOption?.title ?? (query ?? title) }
        return "\(originLabel) → \(destinationLabel)"
    }

    var dateText: String { TripFormat.range(departureDate, returnDate) }

    func holo(fundName: String) -> HoloCardModel {
        let price: (String, String)? = payment.map { (cardAmount($0.amount), "AUSD") }
            ?? leadingOption.map { (cardAmount($0.total), $0.currency) }
        var moves: [HoloMove] = []
        let flavor: String
        if isGift {
            flavor = "\(maxPrice.map { "Under $\($0)" } ?? "Gift") · live prices · sandbox card"
            if let top = leadingOption {
                moves.append(HoloMove(symbol: "star.fill", name: chosen == nil ? "Top pick" : "Chosen",
                                      detail: top.title, value: "$\(top.total)"))
            }
            moves.append(HoloMove(symbol: "hand.thumbsup.fill", name: "Votes", detail: plural(options.count, "option"),
                                  value: "\(voteCount)"))
            moves.append(HoloMove(symbol: "gift.fill", name: (query ?? "Gift").capitalizedFirst, detail: "From \(fundName)"))
        } else {
            flavor = "\(dateText) · \(TripFormat.travellers(travelers ?? 1)) · Duffel test mode"
            moves.append(HoloMove(symbol: "airplane.departure", name: "Outbound",
                                  detail: TripFormat.day(departureDate, weekday: true),
                                  value: "\(origin ?? "") → \(destination ?? "")"))
            if let r = returnDate {
                moves.append(HoloMove(symbol: "airplane.arrival", name: "Return", detail: TripFormat.day(r, weekday: true),
                                      value: "\(destination ?? "") → \(origin ?? "")"))
            }
            moves.append(HoloMove(symbol: "hand.thumbsup.fill", name: "Votes",
                                  detail: "\(plural(options.count, "option")) · \(fundName)", value: "\(voteCount)"))
        }
        let what = isGift ? "gift \(cardTitle)" : "\(isReturn ? "return " : "")flight \(cardTitle), \(dateText)"
        let label = "Synq group \(what). \(price.map { "Price \($0.0) \($0.1). " } ?? "")Status \(stateText). "
            + "\(plural(voteCount, "vote")). \(rarity.name) card."
        return HoloCardModel(kind: isGift ? .gift : .trip, rarity: rarity,
                             stage: isGift ? "Group gift" : (isReturn ? "Return flight" : "Flight"),
                             name: cardTitle, headline: price?.0, unit: price?.1 ?? "",
                             status: cardStatus, tone: tone, flavor: flavor, moves: moves,
                             setCode: setCode(isGift ? "GFT" : "TRP", tripId), network: isGift ? "Sandbox" : "Duffel test",
                             art: HoloArtSpec(from: origin, to: destination, roundTrip: isReturn, count: options.count),
                             stats: isGift
                                ? [HoloStat(label: "Budget", value: maxPrice.map { "$\($0)" } ?? "—"),
                                   HoloStat(label: "Options", value: "\(options.count)"),
                                   HoloStat(label: "Votes", value: "\(voteCount)")]
                                : [HoloStat(label: "Travellers", value: "\(travelers ?? 1)"),
                                   HoloStat(label: "Options", value: "\(options.count)"),
                                   HoloStat(label: "Trip", value: isReturn ? "Return" : "One way")],
                             accessibilityLabel: label)
    }
}

// MARK: - Transcript bubbles

struct FundInviteBubble: View {
    let fallbackName: String
    let view: FundView?

    var body: some View {
        HoloBubbleScene(model: view?.holo ?? draftFundCard(name: fallbackName))
            .animation(.spring(response: 0.6, dampingFraction: 0.75), value: view?.state)
    }
}

struct FundProposalBubble: View {
    let proposal: FundProposal?
    let fundName: String?
    var network: String = SynqNetwork.fundBackend

    var body: some View {
        HoloBubbleScene(model: proposal?.holo(fundName: fundName ?? "Synq", network: network)
            ?? HoloCardModel(kind: .payment, rarity: .common, stage: "Payment", name: "Payment", headline: "—",
                             unit: "AUSD", status: "Review", tone: .waiting, flavor: fundName ?? "Synq",
                             moves: [HoloMove(symbol: "signature", name: "Approvals", detail: "Tap to review")],
                             setCode: "PAY", network: network,
                             accessibilityLabel: "Synq payment. Tap to review."))
            .animation(.spring(response: 0.6, dampingFraction: 0.75), value: proposal?.state)
    }
}

struct FundTripBubble: View {
    let trip: TripView?
    let fundName: String?

    var body: some View {
        HoloBubbleScene(model: trip?.holo(fundName: fundName ?? "Synq")
            ?? HoloCardModel(kind: .trip, rarity: .common, stage: "Group pick", name: "Group pick", headline: nil,
                             unit: "", status: "Vote", tone: .waiting, flavor: fundName ?? "Synq",
                             moves: [HoloMove(symbol: "hand.thumbsup.fill", name: "Vote", detail: "Tap to open")],
                             setCode: "TRP", network: "Duffel test",
                             accessibilityLabel: "Synq group pick. Tap to vote."))
            .animation(.spring(response: 0.6, dampingFraction: 0.75), value: trip?.state)
    }
}
