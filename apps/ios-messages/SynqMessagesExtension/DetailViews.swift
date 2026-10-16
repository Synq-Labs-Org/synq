import SwiftUI

// Flights and Gifts tabs (search forms and recent searches), trip/gift detail
// (ranked options, both legs of a return flight, votes, pay) and payment detail.
// Paying and approving always open the Synq page (passkey).

// MARK: - Flights tab

struct FlightsView: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    var onTab: (SynqTab) -> Void
    @Environment(\.synqTheme) private var theme

    private var flights: [TripView] { model.trips.filter { !$0.isGift } }
    private var live: Bool { model.view?.state == "ACTIVE" }

    /// Starts from the group's latest flight search, if there is one.
    private var lastSearch: FlightDraft {
        guard let t = flights.first else { return FlightDraft(travelers: model.view?.members.count) }
        return FlightDraft(origin: t.origin, destination: t.destination, originLabel: t.originLabel,
                           destinationLabel: t.destinationLabel, departureDate: t.departureDate,
                           returnDate: t.returnDate, travelers: t.travelers)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqHeader(title: "Flights", onBack: { onTab(.home) })
            SynqHeroArt(slot: .flights)
            SynqStack {
                SynqDisplay(line: "Let's find it for the group.")
                FlightSearchForm(prefill: lastSearch,
                                 busy: model.searching != nil, onSearch: { model.runFlight($0) })
                    .disabled(!live)
                if !live { SynqNote(text: "Flights open once the fund is live.") }
                if let s = model.searching, s.kind == .flight { SearchingPanel(progress: s) }
                if let error = model.error { SynqNote(text: error, error: true) }
                SynqSectionLabel(text: "Recent searches", seeAll: !flights.isEmpty)
                if flights.isEmpty {
                    SynqNote(text: "Search together, vote, then pay from the fund. Duffel test mode: no real ticket is issued.")
                } else {
                    SynqGroup {
                        ForEach(Array(flights.prefix(5).enumerated()), id: \.element.id) { i, t in
                            SynqRow(icon: .flight, title: t.routeTitle,
                                    subtitle: "\(t.dateText) · \(TripFormat.travellers(t.travelers ?? 1))",
                                    trailing: .chevron, divider: i > 0) {
                                withAnimation(theme.motion.spring) { model.selectedTrip = t.tripId }
                            }
                        }
                    }
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

/// FROM / TO / DATES / TRAVELLERS as one outlined field group, then the search button.
struct FlightSearchForm: View {
    let busy: Bool
    let onSearch: (FlightPlan) -> Void
    @State private var origin: String
    @State private var destination: String
    @State private var date: Date
    @State private var returning: Bool
    @State private var returnDate: Date
    @State private var travelers: Int
    @State private var editingDates = false
    @Environment(\.synqTheme) private var theme
    @Environment(\.synqRenderMode) private var mode

    init(prefill: FlightDraft = FlightDraft(), busy: Bool = false, onSearch: @escaping (FlightPlan) -> Void) {
        self.busy = busy
        self.onSearch = onSearch
        let cal = Calendar(identifier: .gregorian)
        let fallback = cal.date(byAdding: .day, value: 30, to: Date()) ?? Date()
        let dep = prefill.departureDate.flatMap { Self.date($0) } ?? fallback
        _origin = State(initialValue: prefill.origin ?? "")
        _destination = State(initialValue: prefill.destination ?? "")
        _date = State(initialValue: dep)
        _returning = State(initialValue: prefill.returnDate != nil || prefill.departureDate == nil)
        _returnDate = State(initialValue: prefill.returnDate.flatMap { Self.date($0) }
            ?? cal.date(byAdding: .day, value: 4, to: dep) ?? dep)
        _travelers = State(initialValue: max(1, min(4, prefill.travelers ?? 2)))
    }

    private static func date(_ s: String) -> Date? {
        let p = s.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return Calendar(identifier: .gregorian).date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }

    private static func day(_ d: Date) -> String { QuickParser.day(d, Calendar(identifier: .gregorian)) }

    /// A typed code or a known city name.
    static func code(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces)
        if let c = Airports.cities[t.lowercased()] { return c }
        let u = t.uppercased()
        return u.range(of: FlightPlan.iata, options: .regularExpression) != nil ? u : nil
    }

    private var plan: FlightPlan? {
        guard let o = Self.code(origin), let d = Self.code(destination) else { return nil }
        let p = FlightPlan(origin: o, destination: d, departureDate: Self.day(date),
                           returnDate: returning ? Self.day(returnDate) : nil, travelers: travelers,
                           originLabel: Airports.label(for: o), destinationLabel: Airports.label(for: d), cabin: nil)
        return p.isValid(today: QuickParser.today()) ? p : nil
    }

    private func label(_ typed: String) -> String? {
        guard let c = Self.code(typed) else { return nil }
        return Airports.label(for: c).map { "\($0) (\(c))" }
    }

    private var dates: String {
        returning ? "\(TripFormat.day(Self.day(date))) – \(TripFormat.day(Self.day(returnDate)))"
                  : "\(TripFormat.day(Self.day(date))) · one way"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.m) {
            SynqGroup {
                SynqField(label: "From", icon: .pin, text: $origin, placeholder: "Delhi or DEL", detail: label(origin),
                          keyboard: .codes, trailingIcon: .swap, trailingLabel: "Swap from and to") {
                    swap(&origin, &destination)
                }
                SynqField(label: "To", icon: .pin, text: $destination, placeholder: "Goa or GOI", detail: label(destination),
                          keyboard: .codes, trailingIcon: .pin, divider: true)
                SynqField(label: "Dates", icon: .calendar, value: dates, trailingIcon: .calendar,
                          trailingLabel: editingDates ? "Done choosing dates" : "Choose dates", trailingAction: {
                              withAnimation(theme.motion.quick) { editingDates.toggle() }
                          }, divider: true)
                if editingDates && !mode.isStill {
                    VStack(spacing: theme.space.s) {
                        DatePicker("Depart", selection: $date, in: (Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())...,
                                   displayedComponents: .date)
                        if returning {
                            DatePicker("Return", selection: $returnDate, in: date..., displayedComponents: .date)
                        }
                    }
                    .synqType(.body)
                    .padding(.horizontal, theme.space.l)
                    .padding(.bottom, theme.space.m)
                }
                SynqField(label: "Travellers", icon: .people, value: TripFormat.travellers(travelers), trailingIcon: .people,
                          trailingLabel: "Add a traveller (up to 4)", trailingAction: { travelers = travelers % 4 + 1 },
                          divider: true)
                    .accessibilityAdjustableAction { dir in
                        switch dir {
                        case .increment: if travelers < 4 { travelers += 1 }
                        case .decrement: if travelers > 1 { travelers -= 1 }
                        @unknown default: break
                        }
                    }
            }
            HStack(spacing: theme.space.s) {
                SynqChip(title: "Return", selected: returning) { returning = true }
                SynqChip(title: "One way", selected: !returning) { returning = false }
                Spacer()
            }
            SynqButton(title: plan.map { "Search \($0.origin) → \($0.destination)" } ?? "Search flights",
                       trailingIcon: .search, busy: busy) {
                if let plan { onSearch(plan) }
            }
            .disabled(plan == nil || busy)
        }
    }
}

// MARK: - Gifts tab

struct GiftsView: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    var onTab: (SynqTab) -> Void
    @Environment(\.synqTheme) private var theme

    private var gifts: [TripView] { model.trips.filter(\.isGift) }
    private var live: Bool { model.view?.state == "ACTIVE" }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqHeader(title: "Gifts", onBack: { onTab(.home) })
            SynqHeroArt(slot: .gift)
            SynqStack {
                GiftSearchForm(prefill: GiftPrefill(), maxBudget: Int(Double(model.view?.maxPayment ?? "500") ?? 500),
                               busy: model.searching != nil) { q, b in model.runGift(query: q, maxPrice: b) }
                    .disabled(!live)
                if !live { SynqNote(text: "Gifts open once the fund is live.") }
                if let s = model.searching, s.kind == .gift { SearchingPanel(progress: s) }
                if let error = model.error { SynqNote(text: error, error: true) }
                SynqSectionLabel(text: "Recent gifts", seeAll: !gifts.isEmpty)
                if gifts.isEmpty {
                    SynqNote(text: "Live prices from online stores; Synq buys with a sandbox card (no real order).")
                } else {
                    TripRows(trips: Array(gifts.prefix(5))) { t in
                        withAnimation(theme.motion.spring) { model.selectedTrip = t.tripId }
                    }
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

struct GiftSearchForm: View {
    let maxBudget: Int
    let busy: Bool
    let onSearch: (String, String) -> Void
    @State private var query: String
    @State private var budget: String
    @Environment(\.synqTheme) private var theme

    init(prefill: GiftPrefill, maxBudget: Int, busy: Bool = false, onSearch: @escaping (String, String) -> Void) {
        self.maxBudget = max(1, min(500, maxBudget))
        self.busy = busy
        self.onSearch = onSearch
        _query = State(initialValue: prefill.query)
        _budget = State(initialValue: prefill.maxPrice)
    }

    private var valid: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
            && budget.range(of: "^[0-9]{1,3}$", options: .regularExpression) != nil
            && (Int(budget) ?? 0) >= 1 && (Int(budget) ?? 0) <= maxBudget
    }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.m) {
            SynqGroup {
                SynqField(label: "Looking for", icon: .gift, text: $query, placeholder: "e.g. gifts for car lovers")
                SynqField(label: "Budget", icon: .money, text: $budget, placeholder: "50", detail: "USD max",
                          keyboard: .number, divider: true)
            }
            HStack(spacing: theme.space.s) {
                ForEach(["25", "50", "100"], id: \.self) { b in
                    SynqChip(title: "$\(b)", selected: budget == b) { budget = b }
                }
                Spacer()
            }
            SynqButton(title: "Search gifts", trailingIcon: .search, busy: busy) {
                onSearch(query.trimmingCharacters(in: .whitespaces), budget)
            }
            .disabled(!valid || busy)
            SynqNote(text: "The group votes, approves the payment with passkeys, and Synq buys it with a sandbox card.")
        }
    }
}

// MARK: - Trip detail

struct TripDetailView: View {
    @ObservedObject var model: FundModel
    let trip: TripView
    let actions: FundActions
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqHeader(title: trip.isGift ? "Gift" : trip.routeTitle,
                       onBack: { withAnimation(theme.motion.spring) { model.selectedTrip = nil } },
                       actions: [SynqHeaderAction(icon: .share, label: "Share in this chat") {
                           if let ref = model.ref { actions.insertTrip(ref, trip) }
                       }])
            SynqHeroArt(slot: trip.isGift ? .gift : .flights, place: trip.isGift ? nil : trip.destination)
            SynqStack {
                summary
                banner
                SynqSectionLabel(text: trip.isGift ? "Options" : "Flights", trailing: "Ranked by Synq")
                ForEach(Array(trip.options.enumerated()), id: \.element.id) { i, o in
                    OptionCard(trip: trip, option: o, rank: i + 1) { model.vote(trip, option: o.optionId) }
                }
                if trip.options.isEmpty {
                    SynqNote(text: trip.error ?? "No options yet.", error: trip.state == "FAILED")
                }
                cta
                SynqNote(text: trip.label)
                if let error = model.error { SynqNote(text: error, error: true) }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
        .onAppear { model.loadTrip(trip.tripId) }
    }

    private var summary: some View {
        SynqPanel(label: trip.isGift ? "Group gift" : (trip.isReturn ? "Return flight" : "Flight")) {
            Text(trip.isGift ? (trip.query ?? trip.title).capitalizedFirst : trip.cardTitle)
                .synqType(.headline).fixedSize(horizontal: false, vertical: true)
            Text(subtitle).synqType(.caption, .secondary)
            HStack(spacing: theme.space.s) {
                SynqBadge(kind: trip.tone.badge, text: trip.stateText)
                Spacer()
                Text(trip.modeLabel.uppercased()).synqType(.caption, .tertiary)
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
    private var banner: some View {
        switch trip.state {
        case "AWAITING_PAYMENT":
            SynqGroup {
                SynqRow(icon: .passkey, title: "Waiting for approvals",
                        subtitle: "\(trip.payment.map { cardAmount($0.amount) } ?? "") AUSD to \(trip.payTo?.label ?? "Synq Travel"). Share the payment so others can approve it.",
                        trailing: .badge(.pending, "Pending"))
            }
        case "BOOKING":
            SynqPanel(label: trip.isGift ? "Buying" : "Booking") {
                Text(trip.isGift ? "Paid. Buying it now with a sandbox card; no real order." : "Paid. Booking now with Duffel test mode; no real ticket.")
                    .synqType(.body, .secondary)
                SynqScanBar()
            }
        case "BOOKED":
            SynqGroup {
                SynqRow(icon: .check, title: trip.isGift ? "Bought" : "Booked",
                        subtitle: trip.booking?.reference.map { "Reference \($0)" } ?? "Done.",
                        trailing: .badge(.approved, trip.isGift ? "Bought" : "Booked"))
            }
        case "FAILED":
            SynqGroup {
                SynqRow(icon: .warning, title: "Could not complete", subtitle: trip.error ?? "Try another search.",
                        trailing: .badge(.danger, "Failed"))
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var cta: some View {
        switch trip.state {
        case "VOTING":
            if let leading = trip.leadingOption {
                SynqButton(title: "Pay \(cardAmount(leading.total)) \(leading.currency) & \(trip.isGift ? "buy" : "book")",
                           icon: .passkey, trailingIcon: .forward, kind: .primary, busy: model.busy) {
                    model.choose(trip, option: leading.optionId) { actions.open($0) }
                }
                .disabled(model.busy)
                SynqNote(text: "Goes with the leading option. You confirm on the Synq page with your passkey, then \(model.view?.threshold ?? 2) members approve. Synq \(trip.isGift ? "buys" : "books") it once paid.")
            }
        case "AWAITING_PAYMENT":
            if let group = model.view?.group, let payTo = trip.payTo, let amount = trip.payment?.amount {
                SynqButton(title: "Open the payment", icon: .passkey, trailingIcon: .forward, kind: .primary) {
                    actions.open(model.client.tripPaymentPage(groupId: group.chainGroupId, payTo: payTo, amount: amount))
                }
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
    let onVote: () -> Void
    @Environment(\.synqTheme) private var theme

    private var mine: Bool { trip.myVote == option.optionId }
    private var leading: Bool { trip.leading == option.optionId }
    private var chosen: Bool { trip.chosen == option.optionId }
    private var highlighted: Bool { chosen || (trip.chosen == nil && leading) }

    var body: some View {
        SynqGroup(emphasis: highlighted) {
            VStack(alignment: .leading, spacing: theme.space.m) {
                HStack(alignment: .top, spacing: theme.space.m) {
                    Text("\(rank)").synqType(.amountMedium, highlighted ? .primary : .tertiary)
                        .frame(width: 22, alignment: .leading)
                        .accessibilityLabel("Rank \(rank)")
                    VStack(alignment: .leading, spacing: theme.space.xxs) {
                        Text(option.title).synqType(.bodyStrong).lineLimit(2)
                        if trip.isGift { Text(option.detail).synqType(.caption, .secondary).lineLimit(1) }
                    }
                    Spacer(minLength: theme.space.xs)
                    VStack(alignment: .trailing, spacing: 0) {
                        Text(trip.isGift ? "$\(option.total)" : cardAmount(option.total)).synqType(.amountMedium).monospacedDigit()
                        Text(trip.isGift ? "total" : "\(option.currency) total").synqType(.caption, .tertiary)
                    }
                }
                if !trip.isGift {
                    VStack(spacing: theme.space.s) {
                        ForEach(Array(trip.legs(for: option).enumerated()), id: \.offset) { _, leg in LegView(leg: leg) }
                    }
                }
                HStack(spacing: theme.space.s) {
                    if chosen { SynqBadge(kind: .approved, text: "Chosen") } else if leading && trip.voteCount > 0 { SynqBadge(kind: .live, text: "Leading") }
                    if option.refundable { SynqBadge(kind: .neutral, text: "Refundable") }
                    Spacer(minLength: 0)
                    if trip.state == "VOTING" {
                        SynqChip(title: "\(option.votes)", icon: mine ? .voted : .vote, selected: mine, action: onVote)
                            .accessibilityLabel("\(mine ? "Your vote. " : "Vote. ")\(option.votes) votes")
                    } else {
                        HStack(spacing: theme.space.xs) {
                            SynqIconView(icon: .voted, size: 12, ink: .tertiary)
                            Text("\(option.votes)").synqType(.caption, .tertiary)
                        }
                    }
                }
            }
            .padding(theme.space.l)
        }
    }
}

struct LegView: View {
    let leg: LegLine
    @Environment(\.synqTheme) private var theme

    var body: some View {
        HStack(spacing: theme.space.m) {
            SynqIconView(icon: leg.label == "Return" ? .flightLand : .flight, size: 13, ink: .secondary).frame(width: 18)
            VStack(alignment: .leading, spacing: theme.space.xxs) {
                Text(leg.label).synqType(.sectionLabel, .tertiary)
                Text(leg.day).synqType(.caption, .secondary)
            }
            .frame(width: 86, alignment: .leading)
            endpoint(leg.from, leg.depart)
            VStack(spacing: theme.space.xxs) {
                SynqRule()
                if !leg.note.isEmpty { Text(leg.note).synqType(.caption, .tertiary).lineLimit(1).minimumScaleFactor(0.8) }
            }
            endpoint(leg.to, leg.arrive)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(leg.label): \(leg.from) to \(leg.to), \(leg.day)\(leg.depart.map { ", departs \($0)" } ?? ""). \(leg.note)")
    }

    private func endpoint(_ code: String, _ time: String?) -> some View {
        VStack(spacing: 0) {
            Text(time ?? code).synqType(.bodyStrong).monospacedDigit()
            if time != nil { Text(code).synqType(.caption, .tertiary) }
        }
        .lineLimit(1)
        .fixedSize()
    }
}

// MARK: - Payment detail

struct ProposalDetailView: View {
    let proposal: FundProposal
    let fundName: String
    let network: String
    let onApprove: () -> Void
    let onExplorer: (URL) -> Void
    let onShare: () -> Void
    let onBack: (() -> Void)?
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqHeader(title: "Payment", onBack: onBack,
                       actions: [SynqHeaderAction(icon: .share, label: "Share in this chat", action: onShare)])
            SynqHeroArt(slot: proposal.state == "PAID" ? .receipt : .send)
            SynqStack {
                SynqPanel(label: fundName) {
                    SynqAmount(amount: cardAmount(proposal.amount), unit: proposal.symbol)
                    Text("to \(proposal.recipient) · from \(fundName)").synqType(.body, .secondary)
                    HStack(spacing: theme.space.s) {
                        SynqBadge(kind: proposal.tone.badge, text: proposal.statusText)
                        if let sender = proposal.sender { Text("Proposed by \(sender)").synqType(.caption, .tertiary) }
                        Spacer(minLength: 0)
                    }
                }
                SynqPanel(label: "Approvals") {
                    SynqProgress(value: proposal.approvals.counted, total: proposal.approvals.required,
                                 label: "\(proposal.approvals.counted) of \(proposal.approvals.required)")
                    if proposal.approvals.names.isEmpty {
                        Text("No approvals yet. Members approve with their passkeys on the Synq page.").synqType(.caption, .secondary)
                    } else {
                        HStack(spacing: theme.space.m) {
                            ForEach(proposal.approvals.names, id: \.self) { n in
                                VStack(spacing: theme.space.xs) {
                                    SynqAvatar(id: n, name: n, status: .approved, size: 40)
                                    Text(n).synqType(.caption)
                                }
                            }
                        }
                        Text("Approved by " + proposal.approvals.names.joined(separator: ", ")).synqType(.caption, .secondary)
                    }
                }
                switch proposal.state {
                case "PENDING":
                    SynqButton(title: "Approve with passkey", icon: .passkey, trailingIcon: .forward, kind: .primary, action: onApprove)
                    SynqNote(text: "Cards never approve anything. You approve on the Synq page with your passkey.")
                case "PAID":
                    if let s = proposal.explorer, let url = URL(string: s) {
                        SynqGroup {
                            SynqRow(icon: .external, title: "View the transaction",
                                    subtitle: "\(networkTitle(network))\(proposal.transactionHash.map { " · " + shortId($0) } ?? "")",
                                    trailing: .chevron) { onExplorer(url) }
                        }
                    }
                default:
                    EmptyView()
                }
                if onBack == nil {
                    SynqButton(title: "Share the latest status in this chat", icon: .share, action: onShare)
                }
                SynqNote(text: "Network: \(networkTitle(network)). Exact amount: \(proposal.amount) \(proposal.symbol).")
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}
