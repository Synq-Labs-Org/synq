import SwiftUI

// The fund screens of the Messages extension: Start, the tabbed fund (Home,
// Flights, Ask, Gifts, Group) and compact mode, plus routing to a payment or a
// trip. Nothing here moves money: payments, approvals, joining and activation
// all open the Synq page, where the passkey ceremony happens.

// MARK: - Root

/// Expanded/compact fund screen: tabs, one payment or one trip, and the sheets.
struct FundScreen: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    @State var tab: SynqTab = .home
    @State var command = ""
    @Environment(\.synqCompact) private var compact
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqScreen {
            if compact {
                FundHomeView(model: model, actions: actions, command: $command, onTab: select)
            } else {
                VStack(spacing: 0) {
                    content.frame(maxHeight: .infinity, alignment: .top)
                    SynqTabBar(selected: selectedTab, onSelect: select)
                }
            }
        }
        .animation(theme.motion.spring, value: model.selectedTrip)
        .animation(theme.motion.spring, value: model.selectedProposal)
        .sheet(item: $model.sendSheet) { prefill in
            if let view = model.view {
                SendSheet(view: view, prefill: prefill, onContinue: { recipient, amount in
                    model.sendSheet = nil
                    if let group = view.group {
                        actions.open(model.client.sendPage(groupId: group.chainGroupId,
                                                           recipientId: recipient.recipientId, amount: amount))
                    }
                }, onCancel: { model.sendSheet = nil })
                .environment(\.synqTheme, theme)
            }
        }
        .sheet(item: $model.planSheet) { prefill in
            PlanTripSheet(prefill: prefill.draft, onSearch: { plan in
                model.planSheet = nil
                model.runFlight(plan)
            }, onCancel: { model.planSheet = nil })
            .environment(\.synqTheme, theme)
        }
        .sheet(item: $model.giftSheet) { prefill in
            GiftSheet(prefill: prefill, maxBudget: Int(Double(model.view?.maxPayment ?? "500") ?? 500),
                      onSearch: { query, budget in
                          model.giftSheet = nil
                          model.runGift(query: query, maxPrice: budget)
                      }, onCancel: { model.giftSheet = nil })
            .environment(\.synqTheme, theme)
        }
    }

    /// A trip shows under Flights or Gifts; a payment under Group.
    private var selectedTab: SynqTab {
        if let id = model.selectedTrip { return model.trips.first { $0.tripId == id }?.isGift == true ? .gifts : .trips }
        if model.selectedProposal != nil { return .group }
        return tab
    }

    private func select(_ t: SynqTab) {
        withAnimation(theme.motion.spring) {
            model.selectedTrip = nil
            model.selectedProposal = nil
            tab = t
        }
        if t != .home { actions.expand() }
    }

    @ViewBuilder
    private var content: some View {
        if let tripId = model.selectedTrip {
            if let trip = model.trips.first(where: { $0.tripId == tripId }) {
                TripDetailView(model: model, trip: trip, actions: actions)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                loading
            }
        } else if let hash = model.selectedProposal {
            if let ref = model.ref, let p = model.view?.proposals.first(where: { $0.intentHash == hash }) {
                ProposalDetailView(
                    proposal: p,
                    fundName: model.view?.name ?? ref.name,
                    network: model.network,
                    onApprove: { actions.open(model.client.approvalPage(p.intentHash)) },
                    onExplorer: { actions.open($0) },
                    onShare: { actions.insertProposal(ref, p) },
                    onBack: { withAnimation(theme.motion.spring) { model.selectedProposal = nil } }
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                loading
            }
        } else {
            switch tab {
            case .home: FundHomeView(model: model, actions: actions, command: $command, onTab: select)
            case .trips: FlightsView(model: model, actions: actions, onTab: select)
            case .ask: AskView(model: model, actions: actions, command: $command, onTab: select)
            case .gifts: GiftsView(model: model, actions: actions, onTab: select)
            case .group: GroupView(model: model, actions: actions, onTab: select)
            }
        }
    }

    private var loading: some View {
        VStack(spacing: theme.space.m) {
            if let error = model.error {
                SynqNote(text: error, error: true)
                SynqButton(title: "Back to the fund", kind: .compact) {
                    model.selectedTrip = nil
                    model.selectedProposal = nil
                }
            } else {
                SynqSpinner(size: 22)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// The live bubble in the transcript for an invite, a payment or a trip card.
struct FundBubble: View {
    @ObservedObject var model: FundModel

    var body: some View {
        if let tripId = model.selectedTrip {
            FundTripBubble(trip: model.trips.first { $0.tripId == tripId },
                           fundName: model.view?.name ?? model.ref?.name)
        } else if let hash = model.selectedProposal {
            FundProposalBubble(proposal: model.view?.proposals.first { $0.intentHash == hash },
                               fundName: model.view?.name ?? model.ref?.name, network: model.network)
        } else {
            FundInviteBubble(fallbackName: model.ref?.name ?? "Synq fund", view: model.view)
        }
    }
}

// MARK: - Start

struct StartFundView: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    let onPasteLink: () -> Void
    @State var text = ""
    @Environment(\.synqCompact) private var compact
    @Environment(\.synqTheme) private var theme

    private var plan: (name: String, flight: FlightPlan?, draft: FlightDraft?) { FundModel.startPlan(for: text) }
    private var canStart: Bool { !plan.name.isEmpty && !model.busy }

    var body: some View {
        SynqScreen {
            if compact { compactBody } else { expandedBody }
        }
    }

    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqWordmarkBar(network: networkTitle(SynqNetwork.fundBackend))
            SynqHeroArt(slot: .home)
            SynqStack {
                SynqPanel(label: "New group fund") {
                    Text(plan.name.isEmpty ? "Start a group fund" : plan.name).synqType(.headline).lineLimit(1)
                    Text("Pool money with this chat. Everyone joins with a passkey, and every payment needs two approvals.")
                        .synqType(.body, .secondary).fixedSize(horizontal: false, vertical: true)
                    SynqCommandField(text: $text, placeholder: "Name it, or tell Synq the plan…", busy: model.busy,
                                     onSubmit: start, onFocus: actions.expand)
                    interpretation
                    examples
                }
                SynqButton(title: model.busy ? "Starting…" : "Start \(plan.name.isEmpty ? "fund" : "“\(plan.name)”") & invite chat",
                           trailingIcon: .send, busy: model.busy, action: start)
                    .disabled(!canStart)
                if let error = model.error { SynqNote(text: error, error: true) }
                HStack {
                    SynqButton(title: "Paste a Synq link", icon: .copy, kind: .compact, action: onPasteLink)
                    Spacer()
                    Text("Test money only").synqType(.caption, .tertiary)
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }

    private var compactBody: some View {
        VStack(alignment: .leading, spacing: theme.space.m) {
            SynqWordmarkBar(network: networkTitle(SynqNetwork.fundBackend), compact: true)
            SynqStack(spacing: \.m) {
                Text("Start a group fund · everyone joins with a passkey").synqType(.caption, .secondary)
                SynqCommandField(text: $text, placeholder: "Name it, or tell Synq the plan…", busy: model.busy,
                                 onSubmit: start, onFocus: actions.expand)
                SynqButton(title: model.busy ? "Starting…" : "Start & invite chat", trailingIcon: .send,
                           busy: model.busy, action: start)
                    .disabled(!canStart)
                if let error = model.error { SynqNote(text: error, error: true) }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }

    @ViewBuilder
    private var interpretation: some View {
        if let flight = plan.flight {
            SynqGroup {
                SynqRow(icon: .flight, title: "Then searches \(flight.origin) → \(flight.destination)",
                        subtitle: "\(TripFormat.range(flight.departureDate, flight.returnDate)) · \(TripFormat.travellers(flight.travelers)) · once the fund is live",
                        trailing: .none)
            }
        } else if let d = plan.draft {
            SynqGroup {
                SynqRow(icon: .flight, title: "A trip to \(d.destinationLabel ?? "")",
                        subtitle: "Add where from and when, and Synq searches once the fund is live", trailing: .none)
            }
        }
    }

    private var examples: some View {
        ChipScroller {
            ForEach(["Goa trip Dec 1–5", "Sam's birthday gift", "Flat bills"], id: \.self) { ex in
                SynqChip(title: ex) {
                    text = ex == "Goa trip Dec 1–5" ? "Flights from Delhi to Goa Dec 1–5 for 3" : ex
                }
            }
        }
    }

    private func start() {
        guard canStart else { return }
        model.create(fromCommand: text) { ref in actions.insertInvite(ref, nil) }
    }
}

// MARK: - Home

struct FundHomeView: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    @Binding var command: String
    var onTab: (SynqTab) -> Void = { _ in }
    @Environment(\.synqCompact) private var compact
    @Environment(\.synqTheme) private var theme

    var body: some View {
        if compact { compactBody } else { expandedBody }
    }

    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqWordmarkBar(network: networkTitle(model.network),
                            action: model.ref.map { ref in
                                SynqHeaderAction(icon: .share, label: "Share the fund card in this chat") {
                                    actions.insertInvite(ref, model.view)
                                }
                            })
            SynqHeroArt(slot: .home)
            SynqStack {
                if let view = model.view, let ref = model.ref {
                    if view.state == "ACTIVE" {
                        active(ref, view)
                    } else {
                        FundStatePanel(model: model, actions: actions, ref: ref, view: view)
                    }
                } else if model.error == nil {
                    SynqSpinner(size: 22).frame(maxWidth: .infinity)
                }
                if let error = model.error { SynqNote(text: error, error: true) }
                SynqNote(text: "Cards never approve anything. Payments are approved with passkeys on the Synq page.")
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }

    @ViewBuilder
    private func active(_ ref: FundRef, _ v: FundView) -> some View {
        FundSummaryPanel(view: v, onInvite: { actions.insertInvite(ref, v) }, onOpen: { onTab(.group) })
        CommandActivity(model: model, onPerform: perform)
        SynqGroup {
            SynqRow(icon: .flight, title: "Book a flight", subtitle: "Find & approve together") { onTab(.trips) }
            SynqRow(icon: .gift, title: "Send a gift", subtitle: "Split with the group", divider: true) { onTab(.gifts) }
            SynqRow(icon: .send, title: "Send payment", subtitle: "Approve with passkeys", divider: true) {
                open { model.sendSheet = SendPrefill() }
            }
            .disabled(v.recipients.isEmpty)
            SynqRow(icon: .grid, title: "More", subtitle: "Ask Synq, trips, test money", divider: true) { onTab(.ask) }
        }
        if !v.proposals.isEmpty {
            SynqSectionLabel(text: "Payments", trailing: "\(v.proposals.count)")
            PaymentList(proposals: Array(v.proposals.prefix(3)), network: v.networkLabel) { p in
                withAnimation(theme.motion.spring) { model.selectedProposal = p.intentHash }
            }
        }
        if !model.trips.isEmpty {
            SynqSectionLabel(text: "Trips & gifts", trailing: "\(model.trips.count)")
            TripRows(trips: Array(model.trips.prefix(3))) { t in
                withAnimation(theme.motion.spring) { model.selectedTrip = t.tripId }
            }
        }
    }

    private func perform(_ outcome: CommandOutcome) {
        switch outcome {
        case .suggestFlight(let p), .runFlight(let p): model.runFlight(p)
        case .suggestGift(let q, let m), .runGift(let q, let m): model.runGift(query: q, maxPrice: m)
        case .completeFlight(let d): open { model.planSheet = PlanPrefill(draft: d) }
        case .send(let id, _, let amount): open { model.sendSheet = SendPrefill(recipientId: id, amount: amount) }
        case .testMoney: model.requestTestFunds()
        case .answer: break
        }
    }

    private func open(_ present: () -> Void) {
        actions.expand()
        present()
    }

    private func submit() {
        let text = command
        command = ""
        model.submit(text)
    }

    // MARK: Compact

    private var compactBody: some View {
        VStack(alignment: .leading, spacing: theme.space.m) {
            SynqWordmarkBar(network: networkTitle(model.network), compact: true)
            SynqStack(spacing: \.m) {
                if let v = model.view {
                    HStack(alignment: .center, spacing: theme.space.m) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(v.name).synqType(.bodyStrong).lineLimit(1)
                            if let t = v.treasury {
                                SynqAmount(amount: cardAmount(t.balance), unit: t.symbol, large: false)
                            } else {
                                Text(v.stateText).synqType(.caption, .secondary)
                            }
                        }
                        Spacer(minLength: 0)
                        SynqBadge(kind: v.tone.badge, text: v.cardStatus)
                    }
                }
                if model.view?.state == "ACTIVE" {
                    SynqCommandField(text: $command, placeholder: "Ask or tell Synq…",
                                     busy: model.asking || model.searching != nil, onSubmit: submit, onFocus: actions.expand)
                    if let s = model.searching {
                        SearchingPanel(progress: s, compact: true)
                    } else {
                        ChipScroller {
                            SynqChip(title: "Flight", icon: .flight) { open { model.planSheet = PlanPrefill() } }
                            SynqChip(title: "Gift", icon: .gift) { open { model.giftSheet = GiftPrefill() } }
                            SynqChip(title: "Send", icon: .send) { open { model.sendSheet = SendPrefill() } }
                                .disabled(model.view?.recipients.isEmpty ?? true)
                            SynqChip(title: "Test money", icon: .plus) { model.requestTestFunds() }
                                .disabled(!(model.view?.canRequestTestFunds ?? false) || model.busy)
                        }
                    }
                } else if let ref = model.ref {
                    SynqButton(title: model.view?.state == "SETUP" ? "Activate with passkey" : "Join with passkey",
                               icon: .passkey, trailingIcon: .back, kind: .primary) {
                        actions.open(model.client.fundPage(ref.fundId, key: ref.key))
                    }
                }
                if let error = model.error { SynqNote(text: error, error: true) }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

/// The fund's group-fund panel: name, members, balance, approvals and avatars.
struct FundSummaryPanel: View {
    let view: FundView
    let onInvite: () -> Void
    let onOpen: () -> Void
    @Environment(\.synqTheme) private var theme

    private var next: FundProposal? { view.pendingProposals.first }

    var body: some View {
        SynqPanel(label: "Group fund") {
            VStack(alignment: .leading, spacing: 4) {
                Text(view.name).synqType(.headline).lineLimit(1)
                Text(subtitle).synqType(.caption, .secondary)
            }
            if let t = view.treasury {
                SynqAmount(amount: cardAmount(t.balance), unit: t.symbol)
            }
            if let next {
                SynqProgress(value: next.approvals.counted, total: next.approvals.required,
                             label: "\(next.approvals.counted)/\(next.approvals.required)")
            } else {
                SynqProgress(value: view.activatedCount, total: view.members.count,
                             label: "\(view.activatedCount)/\(view.members.count)")
            }
            HStack(spacing: theme.space.s) {
                ForEach(view.members.prefix(4)) { m in SynqAvatar(id: m.principalId, name: m.name, size: 34) }
                SynqIconButton(icon: .plus, label: "Invite to this chat", action: onInvite)
                Spacer()
                Button {
                    Haptics.tap()
                    onOpen()
                } label: {
                    SynqIconView(icon: .back, size: 16, ink: .secondary).rotationEffect(.degrees(180))
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(view.name)")
            }
        }
    }

    private var subtitle: String {
        if let next { return "\(view.memberSummary) · \(next.approvals.counted) of \(next.approvals.required) approvals" }
        return "\(view.memberSummary) · \(view.threshold) of \(view.members.count) approve each payment"
    }
}

/// Forming, setting up, launching or failed: what to do next.
struct FundStatePanel: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    let ref: FundRef
    let view: FundView
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqPanel(label: "Group fund") {
            HStack {
                Text(view.name).synqType(.headline).lineLimit(1)
                Spacer()
                SynqBadge(kind: view.tone.badge, text: view.cardStatus)
            }
            Text(explanation).synqType(.body, .secondary).fixedSize(horizontal: false, vertical: true)
            switch view.state {
            case "FORMING":
                SynqProgress(value: min(view.members.count, view.minMembers), total: view.minMembers,
                             label: "\(view.members.count) joined")
            case "SETUP":
                if let s = view.setup { SynqProgress(value: s.signed, total: s.required, label: "\(s.signed)/\(s.required) signed") }
            case "LAUNCHING":
                HStack(spacing: theme.space.s) {
                    SynqSpinner(size: 16)
                    Text("Creating the shared wallet on \(networkTitle(view.networkLabel))").synqType(.caption, .secondary)
                }
                SynqScanBar()
            default:
                EmptyView()
            }
            HStack(spacing: theme.space.s) {
                ForEach(view.members.prefix(6)) { m in
                    SynqAvatar(id: m.principalId, name: m.name,
                               status: view.state == "SETUP" ? (m.signedSetup ? .approved : .pending) : .none, size: 32)
                }
                if view.members.isEmpty { Text("No one has joined yet.").synqType(.caption, .tertiary) }
            }
        }
        switch view.state {
        case "FORMING":
            SynqButton(title: "Join with passkey", icon: .passkey, trailingIcon: .back, kind: .primary) {
                actions.open(model.client.fundPage(ref.fundId, key: ref.key))
            }
            if ref.adminKey != nil {
                SynqButton(title: model.busy ? "Launching…" : "Launch fund · \(view.members.count) joined",
                           trailingIcon: .send, busy: model.busy) { model.launch() }
                    .disabled(model.busy || view.members.count < view.minMembers)
            }
        case "SETUP":
            SynqButton(title: "Activate with passkey", icon: .passkey, trailingIcon: .back, kind: .primary) {
                actions.open(model.client.fundPage(ref.fundId, key: ref.key))
            }
        case "LAUNCHING":
            EmptyView()
        default:
            if ref.adminKey != nil {
                SynqButton(title: model.busy ? "Retrying…" : "Try launching again", icon: .refresh, busy: model.busy) {
                    model.launch()
                }
            }
        }
        if let p = ref.pendingFlight {
            SynqGroup {
                SynqRow(icon: .flight, title: "Queued: \(p.origin) → \(p.destination)",
                        subtitle: "\(TripFormat.range(p.departureDate, p.returnDate)) · \(TripFormat.travellers(p.travelers)) · searches when the fund goes live",
                        trailing: .badge(.pending, "Queued"))
            }
        }
    }

    private var explanation: String {
        switch view.state {
        case "FORMING":
            return ref.adminKey != nil
                ? "Everyone joins with a passkey on the Synq page. Launch when at least \(view.minMembers) have joined."
                : "Everyone joins with a passkey on the Synq page. The person who started it launches the fund."
        case "SETUP":
            return "Each member activates once with a passkey. The fund goes live when \(view.threshold) have."
        case "LAUNCHING":
            return "Creating the group wallet. This takes a few seconds."
        default:
            return view.error ?? "Setting up the fund failed."
        }
    }
}

// MARK: - Ask (centre tab)

struct AskView: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    @Binding var command: String
    var onTab: (SynqTab) -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqHeader(title: "Ask Synq", onBack: { onTab(.home) })
            SynqHeroArt(slot: .agent)
            SynqStack {
                if model.view?.state == "ACTIVE" {
                    SynqCommandField(text: $command, placeholder: "Ask or tell Synq… e.g. book a flight from Delhi to Goa Dec 1–5 for 3",
                                     busy: model.asking || model.searching != nil, onSubmit: submit, onFocus: actions.expand)
                    CommandActivity(model: model, onPerform: perform)
                    if command.isEmpty && model.note == nil && model.searching == nil && !model.asking {
                        suggestions
                    }
                    SynqGroup {
                        SynqRow(icon: .money, title: "Add test money", subtitle: "Testnet AUSD for this fund", trailing: .arrow) {
                            model.requestTestFunds()
                        }
                        .disabled(!(model.view?.canRequestTestFunds ?? false) || model.busy)
                        SynqRow(icon: .invite, title: "Invite this chat", subtitle: "Share the fund card", divider: true) {
                            if let ref = model.ref { actions.insertInvite(ref, model.view) }
                        }
                    }
                    SynqNote(text: "Synq runs clear flight and gift searches straight away. Paying always opens the passkey page.")
                } else {
                    SynqNote(text: "Ask Synq opens once the fund is live.")
                }
                if let error = model.error { SynqNote(text: error, error: true) }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }

    private var suggestions: some View {
        let first = model.view?.recipients.first?.name ?? "Priya"
        let ideas: [(SynqIcon, String, String)] = [
            (.flight, "Flights Delhi → Goa Dec 1–5 for 3", "Book a flight from Delhi to Goa Dec 1–5 for 3"),
            (.gift, "Gift under $40", "Find a gift for car lovers under $40"),
            (.send, "Send 5 to \(first)", "Send 5 to \(first)"),
        ]
        return VStack(alignment: .leading, spacing: theme.space.s) {
            SynqSectionLabel(text: "Try")
            ForEach(ideas, id: \.1) { idea in
                SynqChip(title: idea.1, icon: idea.0) { command = idea.2 }
            }
        }
    }

    private func submit() {
        let text = command
        command = ""
        model.submit(text)
    }

    private func perform(_ outcome: CommandOutcome) {
        switch outcome {
        case .suggestFlight(let p), .runFlight(let p): model.runFlight(p)
        case .suggestGift(let q, let m), .runGift(let q, let m): model.runGift(query: q, maxPrice: m)
        case .completeFlight(let d): model.planSheet = PlanPrefill(draft: d)
        case .send(let id, _, let amount): model.sendSheet = SendPrefill(recipientId: id, amount: amount)
        case .testMoney: model.requestTestFunds()
        case .answer: break
        }
    }
}

/// Thinking, searching and Synq's reply, shown wherever the command field is.
struct CommandActivity: View {
    @ObservedObject var model: FundModel
    let onPerform: (CommandOutcome) -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        if model.asking {
            HStack(spacing: theme.space.s) {
                SynqSpinner(ink: .secondary, size: 14)
                Text(model.note?.prompt.isEmpty == false ? "Reading “\(model.note?.prompt ?? "")”…" : "Reading that…")
                    .synqType(.caption, .secondary).lineLimit(1)
            }
        }
        if let s = model.searching {
            SearchingPanel(progress: s)
        }
        if let note = model.note, model.searching == nil {
            CommandReplyPanel(note: note, busy: model.busy, onRun: { onPerform(note.outcome) },
                              onDismiss: { withAnimation(theme.motion.quick) { model.note = nil } })
        }
    }
}

/// The "searching DEL → GOI · Dec 1–5 · 3 travellers" state.
struct SearchingPanel: View {
    var progress: SearchProgress
    var compact = false
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqPanel(label: progress.kind == .flight ? "Searching flights" : "Searching gifts") {
            HStack(spacing: theme.space.m) {
                SynqIconView(icon: progress.kind == .flight ? .flight : .gift, size: 20)
                VStack(alignment: .leading, spacing: 2) {
                    Text(progress.headline).synqType(compact ? .bodyStrong : .amountMedium).lineLimit(1)
                    Text(progress.detail).synqType(.caption, .secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                SynqSpinner(ink: .secondary, size: 16)
            }
            SynqScanBar()
            if !compact {
                Text(progress.kind == .flight ? "Duffel test mode · the group votes before anyone pays"
                                              : "Live prices · the group votes before anyone pays")
                    .synqType(.caption, .tertiary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Searching \(progress.kind == .flight ? "flights" : "gifts"): \(progress.headline), \(progress.detail)")
    }
}

/// Synq's reply to a command, with the one next step when it needs a tap.
struct CommandReplyPanel: View {
    var note: CommandNote
    var busy: Bool
    var onRun: () -> Void
    var onDismiss: () -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqPanel(label: "Synq") {
            HStack(alignment: .top) {
                SynqEcho(text: note.prompt)
                Spacer(minLength: theme.space.s)
                Button(action: onDismiss) { SynqIconView(icon: .close, size: 12, ink: .tertiary).frame(width: 28, height: 24) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss")
            }
            Text(note.reply.isEmpty ? "Done." : note.reply).synqType(.body).fixedSize(horizontal: false, vertical: true)
            action
        }
    }

    @ViewBuilder
    private var action: some View {
        switch note.outcome {
        case .suggestFlight(let p), .runFlight(let p):
            SynqButton(title: "Search \(p.origin) → \(p.destination)", icon: .flight, busy: busy, action: onRun).disabled(busy)
        case .suggestGift(let q, let m), .runGift(let q, let m):
            SynqButton(title: "Search gifts: \(q) · under $\(m)", icon: .gift, busy: busy, action: onRun).disabled(busy)
        case .completeFlight:
            SynqButton(title: "Add the missing details", icon: .calendar, action: onRun)
        case .send(_, let name, let amount):
            SynqButton(title: "Send \(amount) to \(name)", icon: .send, action: onRun)
        case .testMoney:
            SynqButton(title: "Add test money", icon: .plus, action: onRun)
        case .answer:
            EmptyView()
        }
    }
}

/// The user's own words, echoed with the theme's prompt glyph.
struct SynqEcho: View {
    let text: String
    @Environment(\.synqTheme) private var theme

    var body: some View {
        Text(theme.glyphs.prompt.isEmpty ? "“\(text)”" : "\(theme.glyphs.prompt) \(text)")
            .synqType(.mono, .secondary).lineLimit(2)
    }
}

// MARK: - Group (the fund)

struct GroupView: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    var onTab: (SynqTab) -> Void
    @Environment(\.synqTheme) private var theme

    /// Where the group is headed: the latest flight's destination, if any.
    private var place: String? { model.trips.first { !$0.isGift }?.destination }

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqHeader(title: model.view?.name ?? model.ref?.name ?? "Group", onBack: { onTab(.home) },
                       actions: model.ref.map { ref in
                           [SynqHeaderAction(icon: .settings, label: "Fund settings on the Synq page") {
                               actions.open(model.client.fundPage(ref.fundId, key: ref.key))
                           }]
                       } ?? [])
            SynqHeroArt(slot: .fund, place: place)
            SynqStack {
                if let v = model.view, let ref = model.ref {
                    if v.state == "ACTIVE" { active(ref, v) } else { FundStatePanel(model: model, actions: actions, ref: ref, view: v) }
                } else if model.error == nil {
                    SynqSpinner(size: 22).frame(maxWidth: .infinity)
                }
                if let error = model.error { SynqNote(text: error, error: true) }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }

    @ViewBuilder
    private func active(_ ref: FundRef, _ v: FundView) -> some View {
        let next = v.pendingProposals.first
        VStack(alignment: .leading, spacing: theme.space.s) {
            Text("Total pool").synqType(.sectionLabel, .secondary)
            if let t = v.treasury { SynqAmount(amount: cardAmount(t.balance), unit: t.symbol) }
            if let next {
                SynqProgress(value: next.approvals.counted, total: next.approvals.required,
                             label: "\(next.approvals.counted)/\(next.approvals.required) approvals")
            } else {
                SynqProgress(value: v.activatedCount, total: v.members.count,
                             label: "\(v.activatedCount)/\(v.members.count) activated")
            }
        }
        SynqDivider()
        MemberGrid(view: v, next: next)
        SynqSectionLabel(text: "Payments", trailing: v.proposals.isEmpty ? nil : "\(v.proposals.count)")
        if v.proposals.isEmpty {
            SynqNote(text: "No payments yet. Send one from Home; the group approves it with passkeys.")
        } else {
            PaymentList(proposals: v.proposals, network: v.networkLabel) { p in
                withAnimation(theme.motion.spring) { model.selectedProposal = p.intentHash }
            }
        }
        if let next {
            SynqButton(title: "Approve next payment (\(v.pendingProposals.count))", trailingIcon: .external) {
                actions.open(model.client.approvalPage(next.intentHash))
            }
        }
        SynqGroup {
            SynqRow(icon: .passkey, title: "Group passkey",
                    subtitle: "\(v.threshold) of \(v.members.count) required for approvals", trailing: .chevron) {
                actions.open(model.client.fundPage(ref.fundId, key: ref.key))
            }
            SynqRow(icon: .invite, title: "Invite to this chat", subtitle: "Share the fund card", trailing: .chevron,
                    divider: true) { actions.insertInvite(ref, v) }
            if v.canRequestTestFunds {
                SynqRow(icon: .money, title: "Add test money", subtitle: "Testnet AUSD, not real money", trailing: .chevron,
                        divider: true) { model.requestTestFunds() }
                    .disabled(model.busy)
            }
        }
        SynqNote(text: "Network: \(networkTitle(v.networkLabel)). Approvals happen on the Synq page with each member's passkey.")
    }
}

/// Members with their pixel avatars and where they stand on the next payment.
struct MemberGrid: View {
    let view: FundView
    let next: FundProposal?
    @Environment(\.synqTheme) private var theme

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: theme.space.s), count: 4), spacing: theme.space.m) {
            ForEach(view.members) { m in
                let (status, line) = standing(m)
                VStack(spacing: 4) {
                    SynqAvatar(id: m.principalId, name: m.name, status: status, size: 50)
                    Text(m.name).synqType(.caption).lineLimit(1)
                    Text(line).synqType(.caption, .secondary).lineLimit(1)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(m.name), \(line)")
            }
        }
    }

    private func standing(_ m: FundMember) -> (SynqAvatarStatus, String) {
        if let next {
            return next.approvals.names.contains(m.name) ? (.approved, "Approved") : (.pending, "Pending")
        }
        return m.activated ? (.none, "Active") : (.pending, "Not active")
    }
}

/// Payment rows: icon, recipient, exact amount, status badge and time.
struct PaymentList: View {
    let proposals: [FundProposal]
    let network: String
    let onOpen: (FundProposal) -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqGroup {
            ForEach(Array(proposals.enumerated()), id: \.element.id) { i, p in
                VStack(spacing: 0) {
                    if i > 0 { SynqDivider() }
                    Button {
                        Haptics.tap()
                        onOpen(p)
                    } label: {
                        HStack(alignment: .top, spacing: theme.space.m) {
                            SynqIconView(icon: icon(p), size: 20).frame(width: 28).padding(.top, 2)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(title(p)).synqType(.bodyStrong).lineLimit(1)
                                SynqAmount(amount: cardAmount(p.amount), unit: p.symbol, large: false)
                                Text("to \(p.recipient)\(p.sender.map { " · by \($0)" } ?? "")").synqType(.caption, .secondary).lineLimit(1)
                            }
                            Spacer(minLength: theme.space.s)
                            VStack(alignment: .trailing, spacing: theme.space.s) {
                                SynqBadge(kind: p.tone.badge, text: p.state == "PAID" ? "Paid" : p.state == "PENDING"
                                          ? "\(p.approvals.counted) of \(p.approvals.required)" : p.cardStatus)
                                Text(TripFormat.stamp(p.createdAt)).synqType(.caption, .tertiary)
                            }
                        }
                        .padding(.horizontal, theme.space.l)
                        .padding(.vertical, theme.space.m)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(SynqPressStyle())
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Payment of \(p.amount) \(p.symbol) to \(p.recipient), \(p.statusText)")
                }
            }
        }
    }

    private func icon(_ p: FundProposal) -> SynqIcon {
        switch p.recipient {
        case "Synq Travel": return .flight
        case "Synq Gifts": return .gift
        default: return .send
        }
    }

    private func title(_ p: FundProposal) -> String {
        switch p.recipient {
        case "Synq Travel": return "Flight booking"
        case "Synq Gifts": return "Gift order"
        default: return "Payment to \(p.recipient)"
        }
    }
}

/// Trip and gift rows.
struct TripRows: View {
    let trips: [TripView]
    let onOpen: (TripView) -> Void

    var body: some View {
        SynqGroup {
            ForEach(Array(trips.enumerated()), id: \.element.id) { i, t in
                SynqRow(icon: t.isGift ? .gift : .flight, title: t.routeTitle,
                        subtitle: t.isGift ? "\(t.options.count) options · under $\(t.maxPrice ?? "")"
                                           : "\(t.dateText) · \(TripFormat.travellers(t.travelers ?? 1))",
                        trailing: .badge(t.tone.badge, t.cardStatus), divider: i > 0) { onOpen(t) }
            }
        }
    }
}

/// A horizontal row of chips that scrolls on device (a clipped row in still renders).
struct ChipScroller<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @Environment(\.synqRenderMode) private var mode
    @Environment(\.synqTheme) private var theme

    var body: some View {
        if mode.isStill {
            HStack(spacing: theme.space.s) { content() }
                .fixedSize()
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                .clipped()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: theme.space.s) { content() }.padding(.vertical, 2)
            }
        }
    }
}
