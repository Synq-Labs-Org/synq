import SwiftUI

/// What the Messages controller hands the fund screens: actions that need the
/// conversation or Safari.
struct FundActions {
    var insertInvite: (FundRef, FundView?) -> Void
    var insertProposal: (FundRef, FundProposal) -> Void
    var insertTrip: (FundRef, TripView) -> Void
    var open: (URL) -> Void
    var expand: () -> Void
}

@MainActor
final class FundModel: ObservableObject {
    @Published var ref: FundRef?
    @Published var view: FundView?
    @Published var error: String?
    @Published var busy = false
    @Published var selectedProposal: String?
    @Published var selectedTrip: String?
    @Published var trips: [TripView] = []
    @Published var askReply: AskReply?
    @Published var asking = false
    @Published var sendDraft: (recipientId: String, amount: String)?
    let voter = deviceVoterId()

    let client: FundClient
    let book: FundBook
    var conversation: String?
    private var polling: Task<Void, Never>?

    init(client: FundClient, book: FundBook = FundBook()) {
        self.client = client
        self.book = book
    }

    func show(_ ref: FundRef?, proposal: String? = nil, trip: String? = nil) {
        if ref?.fundId != self.ref?.fundId {
            view = nil
            trips = []
            askReply = nil
        }
        self.ref = ref
        selectedProposal = proposal
        selectedTrip = trip
        error = nil
        refresh()
    }

    func refresh() {
        guard let ref else { return }
        Task {
            do {
                let v = try await client.view(fundId: ref.fundId, key: ref.key)
                view = v
                error = nil
                if v.state == "ACTIVE" {
                    trips = (try? await client.trips(fundId: ref.fundId, key: ref.key, voter: voter)) ?? trips
                }
                if v.name != ref.name {
                    self.ref = book.remember(fundId: ref.fundId, key: ref.key, name: v.name, conversation: conversation)
                }
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }

    /// Follows server-side progress (launch, setup, approvals) while the app is open.
    func startPolling() {
        polling?.cancel()
        polling = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard let self, !Task.isCancelled else { return }
                let live = self.view.map { v in
                    v.state == "LAUNCHING" || v.state == "SETUP" || v.state == "FORMING"
                        || v.proposals.contains { $0.state == "PENDING" || $0.state == "EXECUTING" }
                        || self.trips.contains { $0.state == "AWAITING_PAYMENT" || $0.state == "BOOKING" || $0.state == "VOTING" }
                } ?? true
                if live { self.refresh() }
            }
        }
    }

    func stopPolling() {
        polling?.cancel()
        polling = nil
    }

    func create(name: String, then insert: @escaping (FundRef) -> Void) {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let created = try await client.create(name: name)
                let ref = book.remember(fundId: created.fundId, key: created.key, name: name,
                                        adminKey: created.adminKey, conversation: conversation)
                show(ref)
                insert(ref)
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }

    func launch() {
        guard let ref, let admin = ref.adminKey else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await client.launch(fundId: ref.fundId, adminKey: admin)
                refresh()
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }

    func ask(_ text: String) {
        guard let ref, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        asking = true
        askReply = nil
        error = nil
        Task {
            defer { asking = false }
            do {
                askReply = try await client.ask(fundId: ref.fundId, key: ref.key, text: text)
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }

    func startTrip(origin: String, destination: String, departureDate: String, travelers: Int) {
        guard let ref else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                let trip = try await client.startTrip(fundId: ref.fundId, key: ref.key, origin: origin,
                                                      destination: destination, departureDate: departureDate,
                                                      travelers: travelers)
                trips.removeAll { $0.tripId == trip.tripId }
                trips.insert(trip, at: 0)
                selectedTrip = trip.tripId
                askReply = nil
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }

    private func replaceTrip(_ trip: TripView) {
        if let i = trips.firstIndex(where: { $0.tripId == trip.tripId }) { trips[i] = trip } else { trips.insert(trip, at: 0) }
    }

    func loadTrip(_ tripId: String) {
        guard let ref else { return }
        Task {
            if let t = try? await client.trip(fundId: ref.fundId, key: ref.key, tripId: tripId, voter: voter) {
                replaceTrip(t)
            }
        }
    }

    func vote(_ trip: TripView, option: String) {
        guard let ref else { return }
        Task {
            do {
                replaceTrip(try await client.vote(fundId: ref.fundId, key: ref.key, tripId: trip.tripId,
                                                  voter: voter, optionId: option))
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }

    /// Picks an option and returns where the group pays for it.
    func choose(_ trip: TripView, option: String, then pay: @escaping (URL) -> Void) {
        guard let ref else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let t = try await client.choose(fundId: ref.fundId, key: ref.key, tripId: trip.tripId, optionId: option)
                replaceTrip(t)
                if let group = view?.group, let payTo = t.payTo, let amount = t.payment?.amount {
                    pay(client.tripPaymentPage(groupId: group.chainGroupId, payTo: payTo, amount: amount))
                }
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }

    func requestTestFunds() {
        guard let ref else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                view = try await client.requestTestFunds(fundId: ref.fundId, key: ref.key)
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }
}

// MARK: - Start

struct StartFundView: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    let onPasteLink: () -> Void
    @State private var name = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Synq").font(.caption.bold()).foregroundStyle(.secondary)
                Text("Start a group fund").font(.title2.bold())
                Text("Everyone in this chat joins with Face ID. The money sits in a shared wallet, and every payment needs two people to approve it.")
                    .font(.subheadline).foregroundStyle(.secondary)
                TextField("What is it for? e.g. Lisbon trip", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.done)
                    .onTapGesture { actions.expand() }
                Button {
                    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
                    model.create(name: trimmed) { ref in actions.insertInvite(ref, nil) }
                } label: {
                    Text(model.busy ? "Starting…" : "Start fund and invite this chat")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let error = model.error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                Divider()
                Button("Paste a Synq link instead", action: onPasteLink)
                    .font(.footnote)
                Text("Monad testnet · test money only")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}

// MARK: - Fund home

struct FundHomeView: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    @State private var sending = false
    @State private var planning = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let ref = model.ref {
                    header(ref)
                    if let view = model.view {
                        content(ref, view)
                    } else if model.error == nil {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                if let error = model.error {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
            .padding()
        }
        .sheet(isPresented: $sending, onDismiss: { model.sendDraft = nil }) {
            if let view = model.view {
                SendSheet(view: view,
                          initialRecipient: model.sendDraft?.recipientId,
                          initialAmount: model.sendDraft?.amount ?? "",
                          onContinue: { recipient, amount in
                    sending = false
                    if let group = view.group {
                        actions.open(model.client.sendPage(groupId: group.chainGroupId,
                                                           recipientId: recipient.recipientId,
                                                           amount: amount))
                    }
                }, onCancel: { sending = false })
            }
        }
        .sheet(isPresented: $planning) {
            PlanTripSheet(onSearch: { origin, destination, date, travelers in
                planning = false
                model.startTrip(origin: origin, destination: destination, departureDate: date, travelers: travelers)
            }, onCancel: { planning = false })
        }
    }

    @ViewBuilder
    private func header(_ ref: FundRef) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Synq fund").font(.caption.bold()).foregroundStyle(.secondary)
                Text(model.view?.name ?? ref.name).font(.title2.bold())
            }
            Spacer()
            if let v = model.view {
                Text(v.stateText).font(.caption.bold())
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Capsule().fill(v.state == "ACTIVE" ? Color.green.opacity(0.2) : Color.secondary.opacity(0.15)))
            }
        }
    }

    @ViewBuilder
    private func content(_ ref: FundRef, _ v: FundView) -> some View {
        if let t = v.treasury {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(t.balance) \(t.symbol)").font(.system(size: 34, weight: .bold, design: .rounded))
                Text("in the group wallet · Monad testnet").font(.caption).foregroundStyle(.secondary)
            }
        }
        switch v.state {
        case "FORMING":
            forming(ref, v)
        case "LAUNCHING":
            HStack { ProgressView(); Text("Creating the shared wallet on Monad testnet…") }
            members(v)
        case "SETUP":
            Text("Each member activates once with Face ID. The fund goes live when \(v.threshold) have.")
                .font(.subheadline).foregroundStyle(.secondary)
            primary("Activate with Face ID") { actions.open(model.client.fundPage(ref.fundId, key: ref.key)) }
            members(v)
        case "ACTIVE":
            active(ref, v)
        default:
            Text(v.error ?? "Setting up the fund failed.").font(.subheadline).foregroundStyle(.red)
            if ref.adminKey != nil {
                primary(model.busy ? "Retrying…" : "Try launching again") { model.launch() }
            }
        }
    }

    @ViewBuilder
    private func forming(_ ref: FundRef, _ v: FundView) -> some View {
        Text("Everyone joins with Face ID on the Synq page. \(ref.adminKey != nil ? "Launch when at least \(v.minMembers) have joined." : "The person who started it launches the fund.")")
            .font(.subheadline).foregroundStyle(.secondary)
        primary("Join with Face ID") { actions.open(model.client.fundPage(ref.fundId, key: ref.key)) }
        if ref.adminKey != nil {
            Button {
                model.launch()
            } label: {
                Text(model.busy ? "Launching…" : "Launch fund (\(v.members.count) joined)")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(model.busy || v.members.count < v.minMembers)
        }
        Button("Share the invite again") { actions.insertInvite(ref, v) }.font(.footnote)
        members(v)
    }

    @ViewBuilder
    private func active(_ ref: FundRef, _ v: FundView) -> some View {
        AskBar(model: model, actions: actions,
               onSend: { recipientId, amount in
                   model.sendDraft = (recipientId, amount)
                   actions.expand()
                   sending = true
               })
        HStack(spacing: 10) {
            Button {
                actions.expand()
                sending = true
            } label: {
                Label("Send", systemImage: "arrow.up.circle.fill").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(v.recipients.isEmpty)
            Button {
                model.requestTestFunds()
            } label: {
                Label("Add test money", systemImage: "plus.circle").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(model.busy || !v.canRequestTestFunds)
        }
        if v.members.contains(where: { !$0.activated }) {
            Button("Not activated yet? Activate with Face ID") {
                actions.open(model.client.fundPage(ref.fundId, key: ref.key))
            }.font(.footnote)
        }
        HStack {
            Text("Trips").font(.headline)
            Spacer()
            Button {
                actions.expand()
                planning = true
            } label: { Label("Plan a trip", systemImage: "airplane") }
                .font(.subheadline)
        }
        .padding(.top, 4)
        if model.trips.isEmpty {
            Text("Search flights together, vote, and pay from the fund. Duffel test mode.")
                .font(.caption).foregroundStyle(.secondary)
        }
        ForEach(model.trips.prefix(4)) { t in
            Button {
                model.selectedTrip = t.tripId
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(t.title).font(.subheadline.bold()).foregroundStyle(.primary)
                        Text(t.stateText).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").foregroundStyle(.secondary)
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
            }
        }
        if !v.proposals.isEmpty {
            Text("Payments").font(.headline).padding(.top, 4)
            ForEach(v.proposals) { p in
                ProposalRow(proposal: p,
                            onOpen: { model.selectedProposal = p.intentHash },
                            onShare: { actions.insertProposal(ref, p) })
            }
            Text("After you send, come back here and share the payment so others can approve it.")
                .font(.caption).foregroundStyle(.secondary)
        }
        members(v)
    }

    @ViewBuilder
    private func members(_ v: FundView) -> some View {
        Text("Members").font(.headline).padding(.top, 4)
        if v.members.isEmpty {
            Text("No one has joined yet.").font(.subheadline).foregroundStyle(.secondary)
        }
        ForEach(v.members) { m in
            HStack {
                Image(systemName: m.activated ? "checkmark.seal.fill" : "person.crop.circle")
                    .foregroundStyle(m.activated ? .green : .secondary)
                Text(m.name)
                Spacer()
                if v.state != "FORMING" && !m.activated {
                    Text("not activated").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func primary(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Text(title).frame(maxWidth: .infinity) }
            .buttonStyle(.borderedProminent)
    }
}

struct ProposalRow: View {
    let proposal: FundProposal
    let onOpen: () -> Void
    let onShare: () -> Void

    var body: some View {
        HStack {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(proposal.title).font(.subheadline.bold()).foregroundStyle(.primary)
                    Text(proposal.statusText + (proposal.sender.map { " · from \($0)" } ?? ""))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if proposal.state == "PENDING" || proposal.state == "PAID" {
                Button("Share", action: onShare).font(.caption.bold()).buttonStyle(.bordered)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08)))
    }
}

// MARK: - Send

struct SendSheet: View {
    let view: FundView
    let onContinue: (FundRecipient, String) -> Void
    let onCancel: () -> Void
    @State private var recipient: FundRecipient?
    @State private var amount: String

    init(view: FundView, initialRecipient: String? = nil, initialAmount: String = "",
         onContinue: @escaping (FundRecipient, String) -> Void, onCancel: @escaping () -> Void) {
        self.view = view
        self.onContinue = onContinue
        self.onCancel = onCancel
        _recipient = State(initialValue: view.recipients.first { $0.recipientId == initialRecipient })
        _amount = State(initialValue: initialAmount)
    }

    private var maxAmount: Decimal { Decimal(string: view.maxPayment ?? "5") ?? 5 }
    private var normalized: String? { normalizedAmount(amount, max: maxAmount) }

    var body: some View {
        NavigationStack {
            Form {
                Section("To") {
                    Picker("Member", selection: $recipient) {
                        Text("Choose").tag(FundRecipient?.none)
                        ForEach(view.recipients) { r in Text(r.name).tag(FundRecipient?.some(r)) }
                    }
                }
                Section {
                    TextField("Amount", text: $amount).keyboardType(.decimalPad)
                } header: {
                    Text("Amount (\(view.treasury?.symbol ?? "AUSD"))")
                } footer: {
                    Text("Up to \(view.maxPayment ?? "5") per payment. You confirm on the Synq page with Face ID, then \(view.threshold) members approve.")
                }
                Section {
                    Button("Continue with Face ID") {
                        if let recipient, let normalized { onContinue(recipient, normalized) }
                    }
                    .disabled(recipient == nil || normalized == nil)
                }
            }
            .navigationTitle("Send from \(view.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) } }
        }
    }
}

// MARK: - Payment detail

struct ProposalDetailView: View {
    let proposal: FundProposal
    let fundName: String
    let onApprove: () -> Void
    let onExplorer: (URL) -> Void
    let onShare: () -> Void
    let onBack: (() -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let onBack {
                    Button("‹ \(fundName)", action: onBack).font(.subheadline)
                }
                Text("Payment from \(fundName)").font(.caption.bold()).foregroundStyle(.secondary)
                Text(proposal.title).font(.title2.bold())
                if let sender = proposal.sender {
                    Text("Proposed by \(sender)").font(.subheadline).foregroundStyle(.secondary)
                }
                Text(proposal.statusText).font(.headline)
                if !proposal.approvals.names.isEmpty {
                    Text("Approved by " + proposal.approvals.names.joined(separator: ", "))
                        .font(.subheadline)
                }
                switch proposal.state {
                case "PENDING":
                    Button(action: onApprove) {
                        Text("Approve with Face ID").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    Text("Tapping the card never approves anything; you approve on the Synq page with your passkey.")
                        .font(.footnote).foregroundStyle(.secondary)
                case "PAID":
                    if let s = proposal.explorer, let url = URL(string: s) {
                        Button("View the transaction") { onExplorer(url) }
                    }
                default:
                    EmptyView()
                }
                Button("Share the latest status in this chat", action: onShare)
                    .font(.footnote)
            }
            .padding()
        }
    }
}

// MARK: - Transcript bubbles

struct FundInviteBubble: View {
    let fallbackName: String
    let view: FundView?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Synq fund").font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                if let v = view { Text(v.memberSummary).font(.caption) }
            }
            Text(view?.name ?? fallbackName).font(.headline).lineLimit(2)
            if let t = view?.treasury {
                Text("\(t.balance) \(t.symbol)").font(.title3.bold())
            }
            Text(view.map { $0.state == "FORMING" ? "Tap to join with Face ID" : $0.stateText } ?? "Tap to open")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct FundProposalBubble: View {
    let proposal: FundProposal?
    let fundName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(fundName.map { "Synq · \($0)" } ?? "Synq payment").font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                if let p = proposal {
                    Text(p.state == "PAID" ? "Paid ✓" : p.statusText).font(.caption.bold())
                        .foregroundStyle(p.state == "PAID" ? .green : .primary)
                }
            }
            Text(proposal?.title ?? "Group payment").font(.headline).lineLimit(2)
            Text(proposal?.state == "PENDING" ? "Tap to review and approve" : "Tap for details")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}


// MARK: - Ask Synq

struct AskBar: View {
    @ObservedObject var model: FundModel
    let actions: FundActions
    let onSend: (String, String) -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("Ask Synq… e.g. flights to Goa for 3 on Dec 1", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit(submit)
                    .onTapGesture { actions.expand() }
                Button(action: submit) {
                    Image(systemName: model.asking ? "ellipsis.circle" : "arrow.up.circle.fill").font(.title2)
                }
                .disabled(model.asking || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if model.asking { ProgressView().frame(maxWidth: .infinity, alignment: .leading) }
            if let r = model.askReply {
                VStack(alignment: .leading, spacing: 8) {
                    Text(r.reply).font(.subheadline)
                    if let action = r.action { actionButton(action) }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.accentColor.opacity(0.08)))
            }
        }
    }

    private func submit() {
        let q = text
        text = ""
        model.ask(q)
    }

    @ViewBuilder
    private func actionButton(_ action: AskAction) -> some View {
        switch action {
        case .send(let id, let name, let amount):
            Button("Send \(amount) to \(name)") { onSend(id, amount) }.buttonStyle(.borderedProminent)
        case .flightSearch(let o, let d, let date, let n):
            Button("Find flights \(o) → \(d) on \(date) for \(n)") {
                model.startTrip(origin: o, destination: d, departureDate: date, travelers: n)
            }
            .buttonStyle(.borderedProminent)
            .disabled(model.busy)
        case .testMoney:
            Button("Add test money") { model.requestTestFunds() }.buttonStyle(.bordered)
        }
    }
}

// MARK: - Trips

struct PlanTripSheet: View {
    let onSearch: (String, String, String, Int) -> Void
    let onCancel: () -> Void
    @State private var origin = ""
    @State private var destination = ""
    @State private var date = Calendar.current.date(byAdding: .day, value: 30, to: Date()) ?? Date()
    @State private var travelers = 2

    private var valid: Bool {
        let o = origin.uppercased(), d = destination.uppercased()
        return o.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil
            && d.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil && o != d
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("From (airport code, e.g. DEL)", text: $origin)
                        .textInputAutocapitalization(.characters)
                    TextField("To (airport code, e.g. GOI)", text: $destination)
                        .textInputAutocapitalization(.characters)
                    DatePicker("Departure", selection: $date,
                               in: (Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())...,
                               displayedComponents: .date)
                    Stepper("Travellers: \(travelers)", value: $travelers, in: 1...4)
                } footer: {
                    Text("Duffel test mode: you'll see Duffel Airways test flights. Booking needs the group to approve the payment; no real ticket is issued.")
                }
                Section {
                    Button("Search flights") {
                        let f = DateFormatter()
                        f.calendar = Calendar(identifier: .gregorian)
                        f.locale = Locale(identifier: "en_US_POSIX")
                        f.dateFormat = "yyyy-MM-dd"
                        onSearch(origin.uppercased(), destination.uppercased(), f.string(from: date), travelers)
                    }
                    .disabled(!valid)
                }
            }
            .navigationTitle("Plan a trip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) } }
        }
    }
}

struct TripDetailView: View {
    @ObservedObject var model: FundModel
    let trip: TripView
    let actions: FundActions

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Button("‹ \(model.view?.name ?? "Fund")") { model.selectedTrip = nil }.font(.subheadline)
                Text("Group trip").font(.caption.bold()).foregroundStyle(.secondary)
                Text(trip.title).font(.title2.bold())
                Text("\(trip.travelers) traveller\(trip.travelers == 1 ? "" : "s") · \(trip.stateText)")
                    .font(.subheadline).foregroundStyle(.secondary)
                ForEach(trip.options) { o in option(o) }
                switch trip.state {
                case "VOTING":
                    if let leading = trip.options.first(where: { $0.optionId == trip.leading }) ?? trip.options.first {
                        Button {
                            model.choose(trip, option: leading.optionId) { actions.open($0) }
                        } label: {
                            Text("Pay \(leading.total) from the fund and book").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy)
                        Text("You confirm the payment with Face ID; it needs \(model.view?.threshold ?? 2) approvals. Once paid, Synq books it.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                case "AWAITING_PAYMENT":
                    Text("Waiting for the group to approve \(trip.payment?.amount ?? "") AUSD to \(trip.payTo?.label ?? "Synq Travel").")
                        .font(.subheadline)
                    if let group = model.view?.group, let payTo = trip.payTo, let amount = trip.payment?.amount {
                        Button("Open the payment") {
                            actions.open(model.client.tripPaymentPage(groupId: group.chainGroupId, payTo: payTo, amount: amount))
                        }
                    }
                    Text("Back in this chat, share the payment from Payments so others can approve it.")
                        .font(.caption).foregroundStyle(.secondary)
                case "BOOKING":
                    HStack { ProgressView(); Text("Paid. Booking with Duffel…") }
                case "BOOKED":
                    Text("Booked ✓\(trip.booking?.reference.map { " · ref \($0)" } ?? "")").font(.headline).foregroundStyle(.green)
                default:
                    Text(trip.error ?? "Could not book this trip.").font(.subheadline).foregroundStyle(.red)
                }
                Button("Share this trip in the chat") {
                    if let ref = model.ref { actions.insertTrip(ref, trip) }
                }
                .font(.footnote)
                Text(trip.label).font(.caption2).foregroundStyle(.secondary)
                if let error = model.error { Text(error).font(.footnote).foregroundStyle(.red) }
            }
            .padding()
        }
        .onAppear { model.loadTrip(trip.tripId) }
    }

    private func option(_ o: TripOptionView) -> some View {
        let mine = trip.myVote == o.optionId
        return HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text(o.title).font(.subheadline.bold())
                Text(o.detail).font(.caption).foregroundStyle(.secondary)
                Text("\(o.total) \(o.currency)\(o.refundable ? " · refundable" : "")").font(.caption)
            }
            Spacer()
            if trip.state == "VOTING" {
                Button {
                    model.vote(trip, option: o.optionId)
                } label: {
                    Label("\(o.votes)", systemImage: mine ? "hand.thumbsup.fill" : "hand.thumbsup")
                }
                .buttonStyle(.bordered)
            } else if trip.chosen == o.optionId {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(mine ? 0.15 : 0.08)))
    }
}

struct FundTripBubble: View {
    let trip: TripView?
    let fundName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(fundName.map { "Synq trip · \($0)" } ?? "Synq trip").font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                if let t = trip { Text(t.stateText).font(.caption.bold()) }
            }
            Text(trip?.title ?? "Group trip").font(.headline).lineLimit(2)
            Text(trip?.state == "VOTING" ? "Tap to vote" : "Tap for details")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
