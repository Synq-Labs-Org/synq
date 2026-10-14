import SwiftUI

/// What the Messages controller hands the fund screens: actions that need the
/// conversation or Safari.
struct FundActions {
    var insertInvite: (FundRef, FundView?) -> Void
    var insertProposal: (FundRef, FundProposal) -> Void
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

    let client: FundClient
    let book: FundBook
    var conversation: String?
    private var polling: Task<Void, Never>?

    init(client: FundClient, book: FundBook = FundBook()) {
        self.client = client
        self.book = book
    }

    func show(_ ref: FundRef?, proposal: String? = nil) {
        if ref?.fundId != self.ref?.fundId { view = nil }
        self.ref = ref
        selectedProposal = proposal
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
        .sheet(isPresented: $sending) {
            if let ref = model.ref, let view = model.view {
                SendSheet(view: view, onContinue: { recipient, amount in
                    sending = false
                    if let group = view.group {
                        actions.open(model.client.sendPage(groupId: group.chainGroupId,
                                                           recipientId: recipient.recipientId,
                                                           amount: amount))
                    }
                    _ = ref
                }, onCancel: { sending = false })
            }
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
    @State private var amount = ""

    private var normalized: String? { normalizedAmount(amount, max: 5) }

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
                    Text("Up to 5 per payment. You confirm on the Synq page with Face ID, then \(view.threshold) members approve.")
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
