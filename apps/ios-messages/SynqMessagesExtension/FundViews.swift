import SwiftUI

// The fund screens of the Messages extension: Start, Fund home (with the command
// bar), and the routing between home, a payment and a trip. Tapping a card only
// tilts it; anything that moves money opens the Synq page for a passkey.

// MARK: - Root

/// Dark scene every screen sits on.
struct SynqScreen<Content: View>: View {
    var accent: Color = Theme.violet
    var secondary: Color = Theme.blue
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack {
            Theme.ink.ignoresSafeArea()
            SynqBackdrop(accent: accent, secondary: secondary)
            content()
        }
        .preferredColorScheme(.dark)
        .tint(accent)
    }
}

/// Expanded/compact fund screen: the fund home, one payment or one trip.
struct FundScreen: View {
    @ObservedObject var model: FundModel
    let actions: FundActions

    var body: some View {
        Group {
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
                        onBack: { withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) { model.selectedProposal = nil } }
                    )
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                } else {
                    loading
                }
            } else {
                FundHomeView(model: model, actions: actions)
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: model.selectedTrip)
        .animation(.spring(response: 0.45, dampingFraction: 0.85), value: model.selectedProposal)
    }

    private var loading: some View {
        SynqScreen {
            VStack(spacing: Theme.s3) {
                if let error = model.error {
                    NoteText(text: error, tone: .failed)
                    Button("Back to the fund") {
                        model.selectedTrip = nil
                        model.selectedProposal = nil
                    }
                    .buttonStyle(.glassCompact)
                } else {
                    SynqSpinner(color: Theme.violetHi)
                }
            }
            .padding()
        }
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

    private var plan: (name: String, flight: FlightPlan?, draft: FlightDraft?) { FundModel.startPlan(for: text) }
    private var canStart: Bool { !plan.name.isEmpty && !model.busy }

    var body: some View {
        SynqScreen {
            if compact { compactBody } else { expandedBody }
        }
    }

    private var expandedBody: some View {
        VStack(spacing: Theme.s4) {
            BrandBar(network: SynqNetwork.fundBackend)
            HoloStage { light in
                HoloCardFace(model: draftFundCard(name: plan.name), light: light)
            }
            .frame(width: 214)
            .padding(.vertical, Theme.s4)
            VStack(spacing: Theme.s2) {
                Text("Start a group fund")
                    .font(.synq(.largeTitle, .bold))
                    .foregroundStyle(Theme.text)
                Text("Pool money with this chat. Everyone joins with Face ID, and every payment needs two approvals.")
                    .font(.synq(.subheadline))
                    .foregroundStyle(Theme.text2)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            CommandBar(text: $text, placeholder: "Name it, or tell Synq the plan…", busy: model.busy,
                       onSubmit: start, onFocus: actions.expand)
            interpretation
            examples
            Button(action: start) {
                Label(model.busy ? "Starting…" : "Start \(plan.name.isEmpty ? "fund" : "“\(plan.name)”") & invite chat",
                      systemImage: "sparkles")
            }
            .buttonStyle(.glow)
            .disabled(!canStart)
            if let error = model.error { NoteText(text: error, tone: .failed) }
            HStack {
                Button("Paste a Synq link", action: onPasteLink).buttonStyle(.glassCompact)
                Spacer()
                Text("Test money only").font(.synq(.caption)).foregroundStyle(Theme.text3)
            }
            .padding(.top, Theme.s2)
        }
        .padding(.horizontal, Theme.s5)
        .padding(.vertical, Theme.s3)
        .synqScroll()
    }

    private var compactBody: some View {
        VStack(spacing: Theme.s3) {
            HStack(spacing: Theme.s3) {
                HoloThumb(model: draftFundCard(name: plan.name)).frame(width: 44)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Start a group fund").font(.synq(.headline, .bold)).foregroundStyle(Theme.text)
                    Text("Everyone joins with Face ID · \(SynqNetwork.fundBackend)")
                        .font(.synq(.caption)).foregroundStyle(Theme.text2)
                }
                Spacer(minLength: 0)
            }
            CommandBar(text: $text, placeholder: "Name it, or tell Synq the plan…", busy: model.busy,
                       onSubmit: start, onFocus: actions.expand)
            Button(action: start) { Text(model.busy ? "Starting…" : "Start & invite chat") }
                .buttonStyle(.glow)
                .disabled(!canStart)
            if let error = model.error { NoteText(text: error, tone: .failed) }
        }
        .padding(.horizontal, Theme.s4)
        .padding(.vertical, Theme.s3)
        .synqScroll()
    }

    @ViewBuilder
    private var interpretation: some View {
        if let flight = plan.flight {
            InfoRow(symbol: "airplane", color: Theme.teal,
                    title: "Then searches \(flight.origin) → \(flight.destination)",
                    detail: "\(TripFormat.range(flight.departureDate, flight.returnDate)) · \(TripFormat.travellers(flight.travelers)) · runs once the fund is live")
                .transition(.opacity.combined(with: .move(edge: .top)))
        } else if let d = plan.draft {
            InfoRow(symbol: "airplane", color: Theme.teal, title: "A trip to \(d.destinationLabel ?? "")",
                    detail: "Add where from and when, and Synq searches once the fund is live")
        }
    }

    private var examples: some View {
        HStack(spacing: Theme.s2) {
            ForEach(["Goa trip Dec 1–5", "Sam's birthday gift", "Flat bills"], id: \.self) { ex in
                Button(ex) {
                    Haptics.tap()
                    text = ex == "Goa trip Dec 1–5" ? "Flights from Delhi to Goa Dec 1–5 for 3" : ex
                }
                .buttonStyle(.chip)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func start() {
        guard canStart else { return }
        model.create(fromCommand: text) { ref in actions.insertInvite(ref, nil) }
    }
}

// MARK: - Fund home

struct FundHomeView: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    @State var command = ""
    @Environment(\.synqCompact) private var compact

    var body: some View {
        SynqScreen(accent: Theme.violet, secondary: model.searching?.kind == .gift ? Theme.pink : Theme.teal) {
            Group {
                if compact { compactBody } else { expandedBody }
            }
        }
        .sheet(item: $model.sendSheet) { prefill in
            if let view = model.view {
                SendSheet(view: view, prefill: prefill, onContinue: { recipient, amount in
                    model.sendSheet = nil
                    if let group = view.group {
                        actions.open(model.client.sendPage(groupId: group.chainGroupId,
                                                           recipientId: recipient.recipientId, amount: amount))
                    }
                }, onCancel: { model.sendSheet = nil })
            }
        }
        .sheet(item: $model.planSheet) { prefill in
            PlanTripSheet(prefill: prefill.draft, onSearch: { plan in
                model.planSheet = nil
                model.runFlight(plan)
            }, onCancel: { model.planSheet = nil })
        }
        .sheet(item: $model.giftSheet) { prefill in
            GiftSheet(prefill: prefill, maxBudget: Int(Double(model.view?.maxPayment ?? "500") ?? 500),
                      onSearch: { query, budget in
                          model.giftSheet = nil
                          model.runGift(query: query, maxPrice: budget)
                      }, onCancel: { model.giftSheet = nil })
        }
    }

    private var card: HoloCardModel {
        model.view?.holo ?? draftFundCard(name: model.ref?.name ?? "Synq fund", network: model.network)
    }

    // MARK: Expanded

    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: Theme.s4) {
            BrandBar(network: model.network) {
                if let ref = model.ref {
                    Button {
                        Haptics.tap()
                        actions.insertInvite(ref, model.view)
                    } label: {
                        Image(systemName: "person.badge.plus").font(.synq(.subheadline, .semibold))
                    }
                    .buttonStyle(GlassButtonStyle(fill: false))
                    .accessibilityLabel("Share the invite in this chat")
                }
            }
            HoloStage { light in HoloCardFace(model: card, light: light) }
                .frame(width: 232)
                .frame(maxWidth: .infinity)
                .padding(.vertical, Theme.s4)
                .id(card.rarity)
                .transition(.scale(scale: 0.92).combined(with: .opacity))
                .animation(.spring(response: 0.6, dampingFraction: 0.75), value: model.view?.state)
                .animation(.snappy, value: model.view?.treasury?.balance)
            statusLine
            if let view = model.view, let ref = model.ref {
                content(ref, view)
            } else if model.error == nil {
                SynqSpinner(color: Theme.violetHi).frame(maxWidth: .infinity)
            }
            if let error = model.error { NoteText(text: error, tone: .failed) }
            NoteText(text: "Tapping a card never approves anything. Payments are approved with passkeys on the Synq page.")
                .padding(.top, Theme.s2)
        }
        .padding(.horizontal, Theme.s5)
        .padding(.vertical, Theme.s3)
        .synqScroll()
    }

    @ViewBuilder
    private var statusLine: some View {
        if let v = model.view {
            HStack(spacing: Theme.s2) {
                StatusPill(text: v.stateText, tone: v.tone)
                Text(v.state == "ACTIVE" ? "\(v.threshold) of \(v.members.count) approve each payment" : v.memberSummary)
                    .font(.synq(.footnote, .medium))
                    .foregroundStyle(Theme.text2)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private func content(_ ref: FundRef, _ v: FundView) -> some View {
        switch v.state {
        case "FORMING":
            forming(ref, v)
        case "LAUNCHING":
            InfoRow(symbol: "sparkles", color: Theme.violet, title: "Creating the shared wallet",
                    detail: "On \(v.networkLabel). This takes a few seconds.", spinning: true)
            MembersPanel(view: v, onActivate: nil)
        case "SETUP":
            Text("Each member activates once with Face ID. The fund goes live when \(v.threshold) have.")
                .font(.synq(.subheadline)).foregroundStyle(Theme.text2)
            Button { actions.open(model.client.fundPage(ref.fundId, key: ref.key)) } label: {
                Label("Activate with Face ID", systemImage: "faceid")
            }
            .buttonStyle(.glow)
            pendingFlightRow(ref)
            MembersPanel(view: v, onActivate: nil)
        case "ACTIVE":
            active(ref, v)
        default:
            NoteText(text: v.error ?? "Setting up the fund failed.", tone: .failed)
            if ref.adminKey != nil {
                Button(model.busy ? "Retrying…" : "Try launching again") { model.launch() }.buttonStyle(.glow)
            }
        }
    }

    @ViewBuilder
    private func forming(_ ref: FundRef, _ v: FundView) -> some View {
        Text(ref.adminKey != nil
             ? "Everyone joins with Face ID on the Synq page. Launch when at least \(v.minMembers) have joined."
             : "Everyone joins with Face ID on the Synq page. The person who started it launches the fund.")
            .font(.synq(.subheadline)).foregroundStyle(Theme.text2)
            .fixedSize(horizontal: false, vertical: true)
        Button { actions.open(model.client.fundPage(ref.fundId, key: ref.key)) } label: {
            Label("Join with Face ID", systemImage: "faceid")
        }
        .buttonStyle(.glow)
        if ref.adminKey != nil {
            Button { model.launch() } label: {
                Label(model.busy ? "Launching…" : "Launch fund · \(v.members.count) joined", systemImage: "paperplane.fill")
            }
            .buttonStyle(.glass)
            .disabled(model.busy || v.members.count < v.minMembers)
        }
        pendingFlightRow(ref)
        MembersPanel(view: v, onActivate: nil)
    }

    @ViewBuilder
    private func pendingFlightRow(_ ref: FundRef) -> some View {
        if let p = ref.pendingFlight {
            InfoRow(symbol: "airplane", color: Theme.teal, title: "Queued: \(p.origin) → \(p.destination)",
                    detail: "\(TripFormat.range(p.departureDate, p.returnDate)) · \(TripFormat.travellers(p.travelers)) · searches when the fund goes live")
        }
    }

    @ViewBuilder
    private func active(_ ref: FundRef, _ v: FundView) -> some View {
        CommandBar(text: $command, placeholder: "Ask or tell Synq… e.g. book a flight from Delhi to Goa Dec 1–5 for 3",
                   busy: model.asking || model.searching != nil,
                   onSubmit: submit, onFocus: actions.expand)
        if model.asking { ThinkingRow(prompt: model.note?.prompt ?? "") }
        if let s = model.searching {
            SearchingCard(progress: s).transition(.scale(scale: 0.96).combined(with: .opacity))
        }
        if let note = model.note, model.searching == nil {
            CommandReplyCard(note: note, busy: model.busy, onRun: { perform(note.outcome) },
                             onDismiss: { withAnimation { model.note = nil } })
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
        if command.isEmpty && model.note == nil && model.searching == nil && !model.asking {
            suggestions(v)
        }
        QuickActions(canSend: !v.recipients.isEmpty, canTestMoney: v.canRequestTestFunds && !model.busy,
                     onSend: { open { model.sendSheet = SendPrefill() } },
                     onFlight: { open { model.planSheet = PlanPrefill() } },
                     onGift: { open { model.giftSheet = GiftPrefill() } },
                     onTestMoney: { model.requestTestFunds() })
        if !model.trips.isEmpty || model.searching == nil {
            SectionHeader(title: "Trips & gifts", trailing: model.trips.isEmpty ? nil : "\(model.trips.count)")
            if model.trips.isEmpty {
                NoteText(text: "Search flights or gifts together, vote, then pay from the fund. Duffel test mode and sandbox cards only.")
            }
            ForEach(model.trips.prefix(4)) { t in
                TripRow(trip: t, fundName: v.name) {
                    withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) { model.selectedTrip = t.tripId }
                }
            }
        }
        if !v.proposals.isEmpty {
            SectionHeader(title: "Payments", trailing: "\(v.proposals.count)")
            ForEach(v.proposals) { p in
                ProposalRow(proposal: p, fundName: v.name, network: v.networkLabel,
                            onOpen: { withAnimation(.spring(response: 0.45, dampingFraction: 0.85)) { model.selectedProposal = p.intentHash } },
                            onShare: { actions.insertProposal(ref, p) })
            }
            NoteText(text: "After you send, share the payment card here so the others can approve it.")
        }
        SectionHeader(title: "Members")
        MembersPanel(view: v, onActivate: v.members.contains { !$0.activated }
                     ? { actions.open(model.client.fundPage(ref.fundId, key: ref.key)) } : nil)
    }

    private func suggestions(_ v: FundView) -> some View {
        let first = v.recipients.first?.name ?? "Priya"
        let ideas: [(String, String, String)] = [
            ("airplane", "Flights Delhi → Goa Dec 1–5 for 3", "Book a flight from Delhi to Goa Dec 1–5 for 3"),
            ("gift", "Gift under $40", "Find a gift for car lovers under $40"),
            ("arrow.up.right", "Send 5 to \(first)", "Send 5 to \(first)"),
        ]
        return ChipScroller {
                ForEach(ideas, id: \.1) { idea in
                    Button {
                        Haptics.tap()
                        command = idea.2
                    } label: {
                        Label(idea.1, systemImage: idea.0)
                    }
                    .buttonStyle(.chip)
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
        case .completeFlight(let d): open { model.planSheet = PlanPrefill(draft: d) }
        case .send(let id, _, let amount): open { model.sendSheet = SendPrefill(recipientId: id, amount: amount) }
        case .testMoney: model.requestTestFunds()
        case .answer: break
        }
    }

    private func open(_ present: () -> Void) {
        Haptics.tap()
        actions.expand()
        present()
    }

    // MARK: Compact

    private var compactBody: some View {
        VStack(spacing: Theme.s3) {
            HStack(spacing: Theme.s3) {
                HoloStage(interactive: false) { light in HoloThumb(model: card, light: light) }
                    .frame(width: 50)
                VStack(alignment: .leading, spacing: 3) {
                    Text(card.name).font(.synq(.headline, .bold)).foregroundStyle(Theme.text).lineLimit(1)
                    if let h = card.headline {
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(h).font(.synq(.title2, .heavy)).monospacedDigit().foregroundStyle(Theme.text)
                            Text(card.unit).font(.synq(.caption, .bold)).foregroundStyle(Theme.text2)
                        }
                    }
                }
                Spacer(minLength: 0)
                StatusPill(text: card.status, tone: card.tone, compact: true)
            }
            if model.view?.state == "ACTIVE" {
                CommandBar(text: $command, placeholder: "Ask or tell Synq…", busy: model.asking || model.searching != nil,
                           onSubmit: submit, onFocus: actions.expand)
                if let s = model.searching {
                    SearchingCard(progress: s, compact: true)
                } else {
                    QuickActions(canSend: !(model.view?.recipients.isEmpty ?? true),
                                 canTestMoney: model.view?.canRequestTestFunds ?? false,
                                 onSend: { open { model.sendSheet = SendPrefill() } },
                                 onFlight: { open { model.planSheet = PlanPrefill() } },
                                 onGift: { open { model.giftSheet = GiftPrefill() } },
                                 onTestMoney: { model.requestTestFunds() }, compact: true)
                }
            } else if let ref = model.ref {
                Button { actions.open(model.client.fundPage(ref.fundId, key: ref.key)) } label: {
                    Label(model.view?.state == "SETUP" ? "Activate with Face ID" : "Join with Face ID", systemImage: "faceid")
                }
                .buttonStyle(.glow)
            }
            if let error = model.error { NoteText(text: error, tone: .failed) }
        }
        .padding(.horizontal, Theme.s4)
        .padding(.vertical, Theme.s3)
        .synqScroll()
    }
}

/// A horizontal row of chips that scrolls on device (a clipped row in still renders).
struct ChipScroller<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @Environment(\.synqRenderMode) private var mode

    var body: some View {
        if mode.isStill {
            HStack(spacing: Theme.s2) { content() }
                .fixedSize()
                .frame(maxWidth: .infinity, alignment: .leading)
                .clipped()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.s2) { content() }.padding(.vertical, 4)
            }
        }
    }
}

// MARK: - Command bar

struct CommandBar: View {
    @Binding var text: String
    var placeholder: String
    var busy: Bool
    var accent: Color = Theme.violet
    var accentHi: Color = Theme.violetHi
    var onSubmit: () -> Void
    var onFocus: () -> Void
    @FocusState private var focused: Bool
    @Environment(\.synqRenderMode) private var mode

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .center, spacing: Theme.s2) {
            Image(systemName: "sparkles")
                .font(.synq(.body, .semibold))
                .foregroundStyle(LinearGradient(colors: [accentHi, Theme.tealHi], startPoint: .topLeading, endPoint: .bottomTrailing))
                .accessibilityHidden(true)
            field
            Button {
                submit()
            } label: {
                Group {
                    if busy { SynqSpinner(color: .white, size: 16) } else { Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)) }
                }
                .foregroundStyle(Color.white)
                .frame(width: 34, height: 34)
                .background(Circle().fill(LinearGradient(colors: [accentHi, accent], startPoint: .topLeading, endPoint: .bottomTrailing)))
                .shadow(color: accent.opacity(empty ? 0 : 0.7), radius: 8)
                .opacity(empty && !busy ? 0.45 : 1)
            }
            .buttonStyle(.plain)
            .disabled(empty || busy)
            .accessibilityLabel("Send to Synq")
        }
        .padding(.leading, 14)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(GlassBackground(radius: 24, tint: accent, strong: true))
        .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous)
            .strokeBorder(LinearGradient(colors: [accentHi.opacity(focused ? 0.9 : 0.35), Theme.tealHi.opacity(focused ? 0.6 : 0.1)],
                                         startPoint: .leading, endPoint: .trailing), lineWidth: focused ? 1.4 : 1))
        .shadow(color: accent.opacity(focused ? 0.45 : 0.2), radius: focused ? 18 : 10, y: 4)
        .animation(.easeOut(duration: 0.2), value: focused)
    }

    @ViewBuilder
    private var field: some View {
        if mode.isStill {
            Text(text.isEmpty ? placeholder : text)
                .font(.synq(.body))
                .foregroundStyle(text.isEmpty ? Theme.text3 : Theme.text)
                .lineLimit(2)
                .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
        } else {
            TextField("", text: $text, prompt: Text(placeholder).foregroundColor(Theme.text3), axis: .vertical)
                .font(.synq(.body))
                .foregroundStyle(Theme.text)
                .lineLimit(1...4)
                .submitLabel(.send)
                .focused($focused)
                .frame(minHeight: 34)
                .onSubmit(submit)
                .onChange(of: text) { _, new in
                    // Return in a multi-line field inserts a newline; treat it as send.
                    if new.contains("\n") {
                        text = new.replacingOccurrences(of: "\n", with: "")
                        submit()
                    }
                }
                .onChange(of: focused) { _, isFocused in if isFocused { onFocus() } }
                .accessibilityLabel("Ask or tell Synq")
        }
    }

    private func submit() {
        guard !empty, !busy else { return }
        focused = false
        onSubmit()
    }
}

/// While Ask Synq reads the instruction.
struct ThinkingRow: View {
    var prompt: String

    var body: some View {
        HStack(spacing: Theme.s2) {
            SynqSpinner(color: Theme.violetHi, size: 16)
            Text(prompt.isEmpty ? "Reading that…" : "Reading “\(prompt)”…")
                .font(.synq(.footnote, .medium))
                .foregroundStyle(Theme.text2)
                .lineLimit(1)
        }
        .padding(.horizontal, Theme.s2)
    }
}

/// The animated "searching DEL → GOI · Dec 1–5 · 3 travellers" state.
struct SearchingCard: View {
    var progress: SearchProgress
    var compact = false
    @Environment(\.synqRenderMode) private var mode
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var accent: Color { progress.kind == .flight ? Theme.teal : Theme.pink }
    private var accentHi: Color { progress.kind == .flight ? Theme.tealHi : Theme.pinkHi }

    var body: some View {
        Group {
            if let phase = mode.phase {
                content(t: phase)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { tl in
                    let t = reduceMotion ? 0.55 : (tl.date.timeIntervalSinceReferenceDate / 2.4).truncatingRemainder(dividingBy: 1)
                    content(t: t)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Searching \(progress.kind == .flight ? "flights" : "gifts"): \(progress.headline), \(progress.detail)")
    }

    private func content(t: Double) -> some View {
        VStack(alignment: .leading, spacing: compact ? Theme.s2 : Theme.s3) {
            HStack(spacing: Theme.s3) {
                if progress.kind == .flight {
                    RouteGraphic(from: progress.from ?? "", to: progress.to ?? "", t: t, color: accentHi)
                        .frame(width: compact ? 96 : 118, height: compact ? 44 : 54)
                } else {
                    PulseIcon(symbol: "gift.fill", color: accent, t: t).frame(width: 54, height: 54)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(progress.kind == .flight ? "Searching flights" : "Searching gifts")
                        .font(.synq(.caption, .bold))
                        .foregroundStyle(accentHi)
                        .textCase(.uppercase)
                    Text(progress.headline)
                        .font(.synq(compact ? .headline : .title3, .bold))
                        .foregroundStyle(Theme.text)
                        .lineLimit(1)
                    Text(progress.detail)
                        .font(.synq(.footnote, .medium))
                        .foregroundStyle(Theme.text2)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Spacer(minLength: 0)
            }
            ShimmerBar(t: t, color: accentHi)
            if !compact {
                Text(progress.kind == .flight ? "Duffel test mode · the group votes before anyone pays"
                                              : "Live prices · the group votes before anyone pays")
                    .font(.synq(.caption2))
                    .foregroundStyle(Theme.text3)
            }
        }
        .padding(compact ? Theme.s3 : Theme.s4)
        .background(GlassBackground(radius: Theme.radius, tint: accent, strong: true))
        .shadow(color: accent.opacity(0.35), radius: 18, y: 6)
    }
}

struct RouteGraphic: View {
    var from: String
    var to: String
    var t: Double
    var color: Color

    var body: some View {
        Canvas { ctx, size in
            let w = size.width, h = size.height
            let a = CGPoint(x: w * 0.12, y: h * 0.62), b = CGPoint(x: w * 0.88, y: h * 0.62)
            let c = CGPoint(x: w * 0.5, y: -h * 0.25)
            var arc = Path()
            arc.move(to: a)
            arc.addQuadCurve(to: b, control: c)
            ctx.stroke(arc, with: .color(Color.white.opacity(0.3)), style: StrokeStyle(lineWidth: 1.2, dash: [3, 4]))
            // Travelled part.
            let k = CGFloat(t)
            var done = Path()
            done.move(to: a)
            let steps = 24
            for i in 1...steps {
                let u = k * CGFloat(i) / CGFloat(steps)
                done.addLine(to: point(a, c, b, u))
            }
            var glow = ctx
            glow.addFilter(.blur(radius: 3))
            glow.stroke(done, with: .color(color), lineWidth: 2.5)
            ctx.stroke(done, with: .color(.white), lineWidth: 1.4)
            for p in [a, b] {
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - 3, y: p.y - 3, width: 6, height: 6)), with: .color(.white))
            }
            let font = Font.system(size: h * 0.24, weight: .heavy, design: .rounded)
            ctx.draw(Text(from).font(font).foregroundColor(.white), at: CGPoint(x: a.x + 4, y: h * 0.9))
            ctx.draw(Text(to).font(font).foregroundColor(.white), at: CGPoint(x: b.x - 4, y: h * 0.9))
            let p = point(a, c, b, k)
            let d = derivative(a, c, b, k)
            var plane = ctx
            plane.translateBy(x: p.x, y: p.y)
            plane.rotate(by: .radians(Double(atan2(d.y, d.x))))
            var halo = plane
            halo.addFilter(.blur(radius: 5))
            halo.fill(Path(ellipseIn: CGRect(x: -8, y: -8, width: 16, height: 16)), with: .color(color))
            plane.draw(Text(Image(systemName: "airplane")).font(.system(size: h * 0.3, weight: .bold)).foregroundColor(.white),
                       at: .zero)
        }
    }

    private func point(_ a: CGPoint, _ c: CGPoint, _ b: CGPoint, _ u: CGFloat) -> CGPoint {
        let v = 1 - u
        return CGPoint(x: v * v * a.x + 2 * v * u * c.x + u * u * b.x, y: v * v * a.y + 2 * v * u * c.y + u * u * b.y)
    }

    private func derivative(_ a: CGPoint, _ c: CGPoint, _ b: CGPoint, _ u: CGFloat) -> CGPoint {
        CGPoint(x: 2 * (1 - u) * (c.x - a.x) + 2 * u * (b.x - c.x), y: 2 * (1 - u) * (c.y - a.y) + 2 * u * (b.y - c.y))
    }
}

struct PulseIcon: View {
    var symbol: String
    var color: Color
    var t: Double

    var body: some View {
        ZStack {
            ForEach(0..<2) { i in
                let p = (t + Double(i) * 0.5).truncatingRemainder(dividingBy: 1)
                Circle().stroke(color.opacity(1 - p), lineWidth: 1.5).scaleEffect(0.5 + p * 0.6)
            }
            IconTile(symbol: symbol, color: color, size: 34)
        }
    }
}

struct ShimmerBar: View {
    var t: Double
    var color: Color

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.08))
                Capsule()
                    .fill(LinearGradient(colors: [.clear, color, .white, color, .clear], startPoint: .leading, endPoint: .trailing))
                    .frame(width: w * 0.35)
                    .offset(x: -w * 0.35 + (w * 1.35) * CGFloat(t))
            }
            .clipShape(Capsule())
        }
        .frame(height: 4)
    }
}

/// A rotating arc spinner (ProgressView does not render in still previews).
struct SynqSpinner: View {
    var color: Color
    var size: CGFloat = 22
    @Environment(\.synqRenderMode) private var mode

    var body: some View {
        if let phase = mode.phase {
            arc(phase)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30)) { tl in
                arc((tl.date.timeIntervalSinceReferenceDate / 0.9).truncatingRemainder(dividingBy: 1))
            }
        }
    }

    private func arc(_ t: Double) -> some View {
        Circle()
            .trim(from: 0.08, to: 0.78)
            .stroke(AngularGradient(colors: [color.opacity(0), color], center: .center),
                    style: StrokeStyle(lineWidth: max(2, size * 0.12), lineCap: .round))
            .rotationEffect(.degrees(t * 360))
            .frame(width: size, height: size)
            .accessibilityLabel("Loading")
    }
}

/// Synq's reply to a command, with the one next step when it needs a tap.
struct CommandReplyCard: View {
    var note: CommandNote
    var busy: Bool
    var onRun: () -> Void
    var onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            HStack {
                Spacer(minLength: 40)
                Text(note.prompt)
                    .font(.synq(.subheadline, .medium))
                    .foregroundStyle(Color.white)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(LinearGradient(colors: [Theme.violet, Theme.rgb(0x5B45D6)], startPoint: .top, endPoint: .bottom)))
            }
            HStack(alignment: .top, spacing: Theme.s2) {
                SynqAvatar(size: 28)
                Text(note.reply.isEmpty ? "Done." : note.reply)
                    .font(.synq(.subheadline))
                    .foregroundStyle(Theme.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button(action: onDismiss) {
                    Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.text3)
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss")
            }
            action
        }
        .padding(Theme.s4)
        .glass(tint: Theme.violet)
    }

    @ViewBuilder
    private var action: some View {
        switch note.outcome {
        case .suggestFlight(let p), .runFlight(let p):
            Button(action: onRun) { Label("Search \(TripFormat.summary(p))", systemImage: "airplane") }
                .buttonStyle(.glow(Theme.teal, Theme.tealHi))
                .disabled(busy)
        case .suggestGift(let q, let m), .runGift(let q, let m):
            Button(action: onRun) { Label("Search gifts: \(q) · under $\(m)", systemImage: "gift.fill") }
                .buttonStyle(.glow(Theme.pink, Theme.pinkHi))
                .disabled(busy)
        case .completeFlight:
            Button(action: onRun) { Label("Add the missing details", systemImage: "slider.horizontal.3") }
                .buttonStyle(.glass)
        case .send(_, let name, let amount):
            Button(action: onRun) { Label("Send \(amount) to \(name)", systemImage: "arrow.up.right") }
                .buttonStyle(.glass)
        case .testMoney:
            Button(action: onRun) { Label("Add test money", systemImage: "plus.circle.fill") }
                .buttonStyle(.glass)
        case .answer:
            EmptyView()
        }
    }
}

// MARK: - Home pieces

struct QuickActions: View {
    var canSend: Bool
    var canTestMoney: Bool
    var onSend: () -> Void
    var onFlight: () -> Void
    var onGift: () -> Void
    var onTestMoney: () -> Void
    var compact = false

    var body: some View {
        HStack(spacing: Theme.s2) {
            tile("Send", "arrow.up.right", Theme.blue, enabled: canSend, action: onSend)
            tile("Flight", "airplane", Theme.teal, enabled: true, action: onFlight)
            tile("Gift", "gift.fill", Theme.pink, enabled: true, action: onGift)
            tile("Test money", "plus", Theme.violet, enabled: canTestMoney, action: onTestMoney)
        }
    }

    private func tile(_ title: String, _ symbol: String, _ color: Color, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: compact ? 4 : 8) {
                IconTile(symbol: symbol, color: color, size: compact ? 30 : 38)
                Text(title)
                    .font(.synq(.caption, .semibold))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, compact ? Theme.s2 : Theme.s3)
            .glass(radius: Theme.radiusSmall)
            .opacity(enabled ? 1 : 0.4)
        }
        .buttonStyle(PressableStyle())
        .disabled(!enabled)
    }
}

/// Gentle press feedback for custom tiles and rows.
struct PressableStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.85 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// A glass row with a tinted icon, a title and a detail.
struct InfoRow: View {
    var symbol: String
    var color: Color
    var title: String
    var detail: String
    var spinning = false

    var body: some View {
        HStack(spacing: Theme.s3) {
            if spinning { SynqSpinner(color: color).frame(width: 38, height: 38) } else { IconTile(symbol: symbol, color: color, size: 38) }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.synq(.subheadline, .semibold)).foregroundStyle(Theme.text)
                Text(detail).font(.synq(.caption)).foregroundStyle(Theme.text2).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(Theme.s3)
        .glass(radius: Theme.radiusSmall, tint: color)
        .accessibilityElement(children: .combine)
    }
}

struct TripRow: View {
    let trip: TripView
    let fundName: String
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: Theme.s3) {
                HoloThumb(model: trip.holo(fundName: fundName)).frame(width: 38)
                VStack(alignment: .leading, spacing: 3) {
                    Text(trip.cardTitle)
                        .font(.synq(.subheadline, .semibold)).foregroundStyle(Theme.text).lineLimit(1)
                    Text(trip.isGift ? "\(trip.options.count) options · under $\(trip.maxPrice ?? "")"
                                     : "\(trip.dateText) · \(TripFormat.travellers(trip.travelers ?? 1))")
                        .font(.synq(.caption)).foregroundStyle(Theme.text2).lineLimit(1)
                }
                Spacer(minLength: 4)
                StatusPill(text: trip.cardStatus, tone: trip.tone, compact: true)
                Image(systemName: "chevron.right").font(.synq(.caption, .bold)).foregroundStyle(Theme.text3)
            }
            .padding(Theme.s3)
            .glass(radius: Theme.radiusSmall)
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("\(trip.cardTitle), \(trip.stateText)")
    }
}

struct ProposalRow: View {
    let proposal: FundProposal
    let fundName: String
    let network: String
    let onOpen: () -> Void
    let onShare: () -> Void

    var body: some View {
        HStack(spacing: Theme.s3) {
            Button(action: onOpen) {
                HStack(spacing: Theme.s3) {
                    HoloThumb(model: proposal.holo(fundName: fundName, network: network)).frame(width: 38)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline, spacing: 4) {
                            Text(cardAmount(proposal.amount)).font(.synq(.headline, .bold)).monospacedDigit()
                            Text(proposal.symbol).font(.synq(.caption2, .bold)).foregroundStyle(Theme.text2)
                        }
                        .foregroundStyle(Theme.text)
                        Text("to \(proposal.recipient)\(proposal.sender.map { " · from \($0)" } ?? "")")
                            .font(.synq(.caption)).foregroundStyle(Theme.text2).lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    VStack(alignment: .trailing, spacing: 5) {
                        StatusPill(text: proposal.cardStatus, tone: proposal.tone, compact: true)
                        HoloPips(pips: .init(on: proposal.approvals.counted, total: proposal.approvals.required),
                                 color: Theme.blueHi, size: 7)
                    }
                }
            }
            .buttonStyle(PressableStyle())
            if proposal.state == "PENDING" || proposal.state == "PAID" {
                Button(action: onShare) { Image(systemName: "square.and.arrow.up").font(.synq(.footnote, .bold)) }
                    .buttonStyle(ChipButtonStyle())
                    .accessibilityLabel("Share in this chat")
            }
        }
        .padding(Theme.s3)
        .glass(radius: Theme.radiusSmall)
        .accessibilityElement(children: .contain)
    }
}

struct MembersPanel: View {
    let view: FundView
    let onActivate: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.s3) {
            HStack(spacing: Theme.s3) {
                AvatarStack(people: view.members.map { .init(id: $0.principalId, name: $0.name, active: $0.activated || view.state == "FORMING") })
                VStack(alignment: .leading, spacing: 2) {
                    Text(view.memberSummary).font(.synq(.subheadline, .semibold)).foregroundStyle(Theme.text)
                    Text(view.state == "FORMING" ? "\(view.minMembers) needed to launch"
                                                 : "\(view.activatedCount) activated with Face ID")
                        .font(.synq(.caption)).foregroundStyle(Theme.text2)
                }
                Spacer(minLength: 0)
            }
            if view.members.isEmpty {
                NoteText(text: "No one has joined yet.")
            }
            if let onActivate {
                Button(action: onActivate) { Label("Not activated? Activate with Face ID", systemImage: "faceid") }
                    .buttonStyle(.glass)
            }
        }
        .padding(Theme.s3)
        .glass(radius: Theme.radiusSmall)
    }
}
