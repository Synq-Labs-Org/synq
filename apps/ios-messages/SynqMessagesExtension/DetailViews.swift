import SwiftUI

// Trip/gift detail (ranked options, both legs of a return flight, votes, pay) and
// payment detail. Paying and approving always open the Synq page (passkey).

/// Back chip + optional share button.
struct DetailTopBar: View {
    var title: String
    var onBack: () -> Void
    var onShare: (() -> Void)?

    var body: some View {
        HStack {
            Button {
                Haptics.tap()
                onBack()
            } label: {
                Label(title, systemImage: "chevron.left").labelStyle(.titleAndIcon)
            }
            .buttonStyle(.glassCompact)
            Spacer()
            if let onShare {
                Button {
                    Haptics.tap()
                    onShare()
                } label: {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.glassCompact)
                .accessibilityLabel("Share in this chat")
            }
        }
    }
}

// MARK: - Trip

struct TripDetailView: View {
    @ObservedObject var model: FundModel
    let trip: TripView
    let actions: FundActions

    private var accent: Color { trip.isGift ? Theme.pink : Theme.teal }
    private var accentHi: Color { trip.isGift ? Theme.pinkHi : Theme.tealHi }
    private var fundName: String { model.view?.name ?? "Fund" }

    var body: some View {
        SynqScreen(accent: accent, secondary: Theme.violet) {
            VStack(alignment: .leading, spacing: Theme.s4) {
                DetailTopBar(title: fundName,
                             onBack: { withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) { model.selectedTrip = nil } },
                             onShare: { if let ref = model.ref { actions.insertTrip(ref, trip) } })
                HoloStage { light in HoloCardFace(model: trip.holo(fundName: fundName), light: light) }
                    .frame(width: 200)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.s3)
                    .id(trip.rarity)
                    .animation(.spring(response: 0.6, dampingFraction: 0.75), value: trip.state)
                header
                stateBanner
                SectionHeader(title: trip.isGift ? "Options" : "Flights", trailing: "Ranked by Synq · tap to vote")
                ForEach(Array(trip.options.enumerated()), id: \.element.id) { i, o in
                    OptionCard(trip: trip, option: o, rank: i + 1, accent: accent, accentHi: accentHi,
                               onVote: { model.vote(trip, option: o.optionId) })
                }
                if trip.options.isEmpty {
                    NoteText(text: trip.error ?? "No options yet.", tone: trip.state == "FAILED" ? .failed : nil)
                }
                cta
                NoteText(text: trip.label)
                if let error = model.error { NoteText(text: error, tone: .failed) }
            }
            .padding(.horizontal, Theme.s5)
            .padding(.vertical, Theme.s3)
            .synqScroll()
        }
        .onAppear { model.loadTrip(trip.tripId) }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(trip.isGift ? (trip.query ?? trip.title).capitalizedFirst : trip.cardTitle)
                .font(.synq(.title, .bold))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: Theme.s2) {
                StatusPill(text: trip.stateText, tone: trip.tone)
                Text(subtitle)
                    .font(.synq(.footnote, .medium))
                    .foregroundStyle(Theme.text2)
                    .lineLimit(2)
            }
        }
    }

    private var subtitle: String {
        if trip.isGift { return "Budget $\(trip.maxPrice ?? "—") · \(trip.options.count) options" }
        let dates = trip.returnDate.map { "\(TripFormat.day(trip.departureDate, weekday: true)) – \(TripFormat.day($0, weekday: true))" }
            ?? TripFormat.day(trip.departureDate, weekday: true)
        return "\(dates) · \(TripFormat.travellers(trip.travelers ?? 1))"
    }

    @ViewBuilder
    private var stateBanner: some View {
        switch trip.state {
        case "AWAITING_PAYMENT":
            InfoRow(symbol: "signature", color: Theme.amber,
                    title: "Waiting for approvals",
                    detail: "\(trip.payment.map { cardAmount($0.amount) } ?? "") AUSD to \(trip.payTo?.label ?? "Synq Travel"). Share the payment from Payments so others can approve it.")
        case "BOOKING":
            InfoRow(symbol: "airplane", color: Theme.sky, title: trip.isGift ? "Paid. Buying it now" : "Paid. Booking now",
                    detail: trip.isGift ? "With a sandbox card; no real order." : "With Duffel test mode; no real ticket.",
                    spinning: true)
        case "BOOKED":
            InfoRow(symbol: "checkmark.seal.fill", color: Theme.mint, title: trip.stateText,
                    detail: trip.booking?.reference.map { "Reference \($0)" } ?? "Done.")
        case "FAILED":
            InfoRow(symbol: "exclamationmark.triangle.fill", color: Theme.coral, title: "Could not complete",
                    detail: trip.error ?? "Try another search.")
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var cta: some View {
        switch trip.state {
        case "VOTING":
            if let leading = trip.leadingOption {
                VStack(alignment: .leading, spacing: Theme.s2) {
                    Button {
                        model.choose(trip, option: leading.optionId) { actions.open($0) }
                    } label: {
                        Label("Pay \(cardAmount(leading.total)) \(leading.currency) & \(trip.isGift ? "buy" : "book")", systemImage: "faceid")
                    }
                    .buttonStyle(.glow(accent, accentHi))
                    .disabled(model.busy)
                    NoteText(text: "Goes with the leading option. You confirm on the Synq page with Face ID, then \(model.view?.threshold ?? 2) members approve. Synq \(trip.isGift ? "buys" : "books") it once paid.")
                }
                .padding(.top, Theme.s2)
            }
        case "AWAITING_PAYMENT":
            if let group = model.view?.group, let payTo = trip.payTo, let amount = trip.payment?.amount {
                Button {
                    actions.open(model.client.tripPaymentPage(groupId: group.chainGroupId, payTo: payTo, amount: amount))
                } label: {
                    Label("Open the payment", systemImage: "faceid")
                }
                .buttonStyle(.glass)
            }
        default:
            EmptyView()
        }
    }
}

/// One leg of a flight option, as shown on the option card.
struct LegLine: Equatable {
    var label: String
    var from: String
    var to: String
    var depart: String?
    var arrive: String?
    var day: String
    var note: String
}

extension TripView {
    /// Outbound (and return) legs for an option: from the server when it sends
    /// them, otherwise from the trip's route and dates.
    func legs(for o: TripOptionView) -> [LegLine] {
        func time(_ s: String?) -> String? {
            guard let s, s.count >= 16 else { return nil }
            let i = s.index(s.startIndex, offsetBy: 11)
            return String(s[i..<s.index(i, offsetBy: 5)])
        }
        func day(_ s: String?) -> String? { s.map { String($0.prefix(10)) } }
        let parts = o.detail.components(separatedBy: " · ")
        let stopsNote = parts.dropFirst().first ?? ""
        let cabin = parts.dropFirst(2).first ?? ""
        if let legs = o.legs, !legs.isEmpty {
            return legs.prefix(2).enumerated().map { i, l in
                let stops = l.stops.map { $0 == 0 ? "nonstop" : "\($0) stop\($0 > 1 ? "s" : "")" } ?? (i == 0 ? stopsNote : "")
                return LegLine(label: i == 0 ? "Outbound" : "Return",
                               from: l.origin ?? (i == 0 ? origin ?? "" : destination ?? ""),
                               to: l.destination ?? (i == 0 ? destination ?? "" : origin ?? ""),
                               depart: time(l.departAt), arrive: time(l.arriveAt),
                               day: TripFormat.day(day(l.departAt) ?? l.date ?? (i == 0 ? departureDate : returnDate), weekday: true),
                               note: [stops, l.duration ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
            }
        }
        var out = [LegLine(label: "Outbound", from: origin ?? "", to: destination ?? "", depart: nil, arrive: nil,
                           day: TripFormat.day(departureDate, weekday: true),
                           note: [stopsNote, cabin].filter { !$0.isEmpty }.joined(separator: " · "))]
        if let r = returnDate {
            out.append(LegLine(label: "Return", from: destination ?? "", to: origin ?? "", depart: nil, arrive: nil,
                               day: TripFormat.day(r, weekday: true), note: cabin))
        }
        return out
    }
}

struct OptionCard: View {
    let trip: TripView
    let option: TripOptionView
    let rank: Int
    let accent: Color
    let accentHi: Color
    let onVote: () -> Void

    private var mine: Bool { trip.myVote == option.optionId }
    private var leading: Bool { trip.leading == option.optionId }
    private var chosen: Bool { trip.chosen == option.optionId }
    private var highlighted: Bool { chosen || (trip.chosen == nil && leading) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            HStack(alignment: .center, spacing: Theme.s3) {
                Text("\(rank)")
                    .font(.synq(.subheadline, .heavy))
                    .foregroundStyle(highlighted ? Color.white : Theme.text2)
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(highlighted
                                              ? AnyShapeStyle(LinearGradient(colors: [accentHi, accent], startPoint: .top, endPoint: .bottom))
                                              : AnyShapeStyle(Color.white.opacity(0.08))))
                    .shadow(color: highlighted ? accent.opacity(0.7) : .clear, radius: 6)
                    .accessibilityLabel("Rank \(rank)")
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.title)
                        .font(.synq(.subheadline, .semibold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(2)
                    if trip.isGift {
                        Text(option.detail).font(.synq(.caption)).foregroundStyle(Theme.text2).lineLimit(1)
                    }
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 0) {
                    Text(trip.isGift ? "$\(option.total)" : cardAmount(option.total))
                        .font(.synq(.title3, .heavy))
                        .monospacedDigit()
                        .foregroundStyle(Theme.text)
                    Text(trip.isGift ? "total" : "\(option.currency) total")
                        .font(.synq(.caption2, .semibold))
                        .foregroundStyle(Theme.text3)
                }
            }
            if !trip.isGift {
                VStack(spacing: Theme.s2) {
                    ForEach(Array(trip.legs(for: option).enumerated()), id: \.offset) { _, leg in
                        LegView(leg: leg, accentHi: accentHi)
                    }
                }
            }
            HStack(spacing: Theme.s2) {
                if chosen { tag("Chosen", Theme.mint) } else if leading && trip.voteCount > 0 { tag("Leading", accentHi) }
                if option.refundable { tag("Refundable", Theme.sky) }
                Spacer(minLength: 0)
                if trip.state == "VOTING" {
                    Button(action: onVote) {
                        Label("\(option.votes)", systemImage: mine ? "hand.thumbsup.fill" : "hand.thumbsup")
                    }
                    .buttonStyle(ChipButtonStyle(selected: mine, accent: accent))
                    .accessibilityLabel("\(mine ? "Your vote. " : "Vote. ")\(option.votes) votes")
                } else {
                    Label("\(option.votes)", systemImage: "hand.thumbsup.fill")
                        .font(.synq(.footnote, .semibold))
                        .foregroundStyle(Theme.text3)
                }
            }
        }
        .padding(Theme.s4)
        .glass(radius: Theme.radius, tint: highlighted ? accent : nil, strong: highlighted)
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
            .strokeBorder(highlighted ? AnyShapeStyle(LinearGradient(colors: [accentHi, accent.opacity(0.2)],
                                                                      startPoint: .topLeading, endPoint: .bottomTrailing))
                                      : AnyShapeStyle(Color.clear), lineWidth: 1.2))
        .shadow(color: highlighted ? accent.opacity(0.25) : .clear, radius: 14, y: 4)
    }

    private func tag(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.synq(.caption2, .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Capsule().fill(color.opacity(0.12)))
            .overlay(Capsule().strokeBorder(color.opacity(0.3), lineWidth: 0.6))
    }
}

struct LegView: View {
    let leg: LegLine
    let accentHi: Color

    var body: some View {
        HStack(spacing: Theme.s3) {
            Image(systemName: leg.label == "Return" ? "airplane.arrival" : "airplane.departure")
                .font(.synq(.footnote, .bold))
                .foregroundStyle(accentHi)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(leg.label.uppercased())
                    .font(.synq(.caption2, .heavy))
                    .tracking(0.8)
                    .foregroundStyle(Theme.text3)
                Text(leg.day).font(.synq(.caption, .medium)).foregroundStyle(Theme.text2)
            }
            .frame(width: 84, alignment: .leading)
            HStack(spacing: 6) {
                endpoint(leg.from, leg.depart)
                VStack(spacing: 2) {
                    ZStack {
                        Capsule().fill(Color.white.opacity(0.18)).frame(height: 1)
                        Image(systemName: "airplane").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.text2)
                    }
                    if !leg.note.isEmpty {
                        Text(leg.note).font(.synq(.caption2)).foregroundStyle(Theme.text3).lineLimit(1).minimumScaleFactor(0.8)
                    }
                }
                endpoint(leg.to, leg.arrive)
            }
        }
        .padding(.horizontal, Theme.s2)
        .padding(.vertical, Theme.s2)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.04)))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(leg.label): \(leg.from) to \(leg.to), \(leg.day)\(leg.depart.map { ", departs \($0)" } ?? ""). \(leg.note)")
    }

    private func endpoint(_ code: String, _ time: String?) -> some View {
        VStack(spacing: 0) {
            Text(time ?? code).font(.synq(.subheadline, .bold)).monospacedDigit().foregroundStyle(Theme.text)
            if time != nil {
                Text(code).font(.synq(.caption2, .semibold)).foregroundStyle(Theme.text3)
            }
        }
        .lineLimit(1)
        .fixedSize()
    }
}

// MARK: - Payment

struct ProposalDetailView: View {
    let proposal: FundProposal
    let fundName: String
    let network: String
    let onApprove: () -> Void
    let onExplorer: (URL) -> Void
    let onShare: () -> Void
    let onBack: (() -> Void)?

    var body: some View {
        SynqScreen(accent: Theme.blue, secondary: Theme.violet) {
            VStack(alignment: .leading, spacing: Theme.s4) {
                if let onBack {
                    DetailTopBar(title: fundName, onBack: onBack, onShare: onShare)
                }
                HoloStage { light in HoloCardFace(model: proposal.holo(fundName: fundName, network: network), light: light) }
                    .frame(width: 214)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.s3)
                    .id(proposal.rarity)
                    .animation(.spring(response: 0.6, dampingFraction: 0.75), value: proposal.state)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(cardAmount(proposal.amount)).font(.synq(.largeTitle, .heavy)).monospacedDigit()
                        Text(proposal.symbol).font(.synq(.headline, .bold)).foregroundStyle(Theme.text2)
                    }
                    .foregroundStyle(Theme.text)
                    Text("to \(proposal.recipient) · from \(fundName)")
                        .font(.synq(.subheadline)).foregroundStyle(Theme.text2)
                    HStack(spacing: Theme.s2) {
                        StatusPill(text: proposal.statusText, tone: proposal.tone)
                        if let sender = proposal.sender {
                            Text("Proposed by \(sender)").font(.synq(.footnote)).foregroundStyle(Theme.text3)
                        }
                    }
                }
                approvals
                switch proposal.state {
                case "PENDING":
                    Button(action: onApprove) { Label("Approve with Face ID", systemImage: "faceid") }
                        .buttonStyle(.glow(Theme.blue, Theme.blueHi))
                    NoteText(text: "Tapping the card never approves anything. You approve on the Synq page with your passkey.")
                case "PAID":
                    if let s = proposal.explorer, let url = URL(string: s) {
                        Button { onExplorer(url) } label: { Label("View the transaction on \(network)", systemImage: "arrow.up.forward.square") }
                            .buttonStyle(.glass)
                    }
                default:
                    EmptyView()
                }
                if onBack == nil {
                    Button(action: onShare) { Label("Share the latest status in this chat", systemImage: "square.and.arrow.up") }
                        .buttonStyle(.glass)
                }
            }
            .padding(.horizontal, Theme.s5)
            .padding(.vertical, Theme.s3)
            .synqScroll()
        }
    }

    private var approvals: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            HStack {
                Text("Approvals").font(.synq(.headline, .bold)).foregroundStyle(Theme.text)
                Spacer()
                HoloPips(pips: .init(on: proposal.approvals.counted, total: proposal.approvals.required), color: Theme.blueHi, size: 10)
                Text("\(proposal.approvals.counted) of \(proposal.approvals.required)")
                    .font(.synq(.subheadline, .bold)).monospacedDigit().foregroundStyle(Theme.text)
            }
            if proposal.approvals.names.isEmpty {
                NoteText(text: "No approvals yet. Members approve with their passkeys on the Synq page.")
            } else {
                AvatarStack(people: proposal.approvals.names.map { .init(id: $0, name: $0, active: true) }, size: 30)
                Text("Approved by " + proposal.approvals.names.joined(separator: ", "))
                    .font(.synq(.footnote)).foregroundStyle(Theme.text2)
            }
        }
        .padding(Theme.s4)
        .glass(tint: Theme.blue)
        .accessibilityElement(children: .combine)
    }
}
