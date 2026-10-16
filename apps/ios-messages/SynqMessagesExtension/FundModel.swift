import SwiftUI

/// What the Messages controller hands the fund screens: actions that need the
/// conversation or Safari.
struct FundActions {
    var insertInvite: (FundRef, FundView?) -> Void
    var insertProposal: (FundRef, FundProposal) -> Void
    var insertTrip: (FundRef, TripView) -> Void
    /// Shares an issued invoice's checkout link as an INVOICE card.
    var insertInvoice: (BusinessInvoice) -> Void = { _ in }
    /// Opens the Synq page (passkey ceremonies) in the in-app browser.
    var open: (URL) -> Void
    var expand: () -> Void

    static let none = FundActions(insertInvite: { _, _ in }, insertProposal: { _, _ in }, insertTrip: { _, _ in },
                                  open: { _ in }, expand: {})
}

/// A search in flight, shown as the animated "searching" card.
struct SearchProgress: Equatable {
    enum Kind: Equatable { case flight, gift }
    var kind: Kind
    var headline: String
    var detail: String
    var from: String?
    var to: String?

    static func flight(_ p: FlightPlan) -> SearchProgress {
        SearchProgress(kind: .flight, headline: "\(p.origin) → \(p.destination)",
                       detail: "\(TripFormat.range(p.departureDate, p.returnDate)) · \(TripFormat.travellers(p.travelers))",
                       from: p.origin, to: p.destination)
    }

    static func gift(query: String, maxPrice: String) -> SearchProgress {
        SearchProgress(kind: .gift, headline: query.capitalizedFirst, detail: "Under $\(maxPrice) · live prices")
    }
}

/// Requests to open a sheet, pre-filled; a fresh id each time re-presents it.
struct SendPrefill: Identifiable, Equatable {
    var id = UUID()
    var recipientId: String?
    var amount: String = ""
}

struct PlanPrefill: Identifiable, Equatable {
    var id = UUID()
    var draft = FlightDraft()
}

struct GiftPrefill: Identifiable, Equatable {
    var id = UUID()
    var query = ""
    var maxPrice = "50"
}

/// Synq's answer to the last command, with the next step when it needs a tap.
struct CommandNote: Equatable {
    var prompt: String
    var reply: String
    var outcome: CommandOutcome
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
    @Published var asking = false
    @Published var searching: SearchProgress?
    @Published var note: CommandNote?
    /// Set to open the Send, Plan Trip or Gift sheet, pre-filled.
    @Published var sendSheet: SendPrefill?
    @Published var planSheet: PlanPrefill?
    @Published var giftSheet: GiftPrefill?
    let voter = deviceVoterId()

    let client: FundClient
    @Published var workspaces: [WorkspaceSummary] = []
    @Published var workspaceSignedIn = false
    @Published var workspaceBusy = false
    @Published var workspaceError: String?
    let book: FundBook
    /// The Arc business features, scoped by the same fund id and key.
    let business: BusinessModel
    var conversation: String?
    private var polling: Task<Void, Never>?

    init(client: FundClient, book: FundBook = FundBook()) {
        self.client = client
        self.book = book
        business = BusinessModel(client: BusinessClient(host: client.host))
        workspaceSignedIn = WorkspaceKeychain.load(host: client.host) != nil
        if workspaceSignedIn { Task { await refreshWorkspaces() } }
    }

    func signInWorkspace(code: String) {
        guard !workspaceBusy else { return }
        workspaceBusy = true; workspaceError = nil
        Task {
            defer { workspaceBusy = false }
            do {
                try await WorkspaceClient(host: client.host).redeem(code: code)
                workspaceSignedIn = true
                await refreshWorkspaces()
            } catch {
                workspaceError = (error as? FundAPIError)?.message ?? "Could not sign in. Try a new private code."
            }
        }
    }

    func refreshWorkspaces() async {
        workspaceBusy = true
        defer { workspaceBusy = false }
        do { workspaces = try await WorkspaceClient(host: client.host).list(); workspaceError = nil }
        catch {
            workspaceError = (error as? FundAPIError)?.message ?? "Could not load your workspaces."
            if WorkspaceKeychain.load(host: client.host) == nil { workspaceSignedIn = false; workspaces = [] }
        }
    }

    func signOutWorkspace() {
        guard !workspaceBusy else { return }
        workspaceBusy = true
        Task {
            await WorkspaceClient(host: client.host).logout()
            workspaceSignedIn = false; workspaces = []; workspaceError = nil; workspaceBusy = false
        }
    }

    var network: String { view?.networkLabel ?? SynqNetwork.fundBackend }

    func show(_ ref: FundRef?, proposal: String? = nil, trip: String? = nil) {
        if ref?.fundId != self.ref?.fundId {
            view = nil
            trips = []
            note = nil
            searching = nil
        }
        self.ref = ref
        selectedProposal = proposal
        selectedTrip = trip
        error = nil
        business.show(ref)
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
                    runPendingFlight()
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
                if live && self.searching == nil { self.refresh() }
            }
        }
    }

    func stopPolling() {
        polling?.cancel()
        polling = nil
    }

    // MARK: Start

    /// What the Start screen's command field would create: a fund name and,
    /// for a flight instruction, the search to run once the fund is live.
    static func startPlan(for text: String, today: Date = Date(), calendar: Calendar = .current)
        -> (name: String, flight: FlightPlan?, draft: FlightDraft?) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if case .flight(let d)? = QuickParser.parse(trimmed, today: today, calendar: calendar), let dest = d.destinationLabel {
            let plan = d.plan(defaultTravelers: 2, today: QuickParser.today(today, calendar: calendar))
            return ("\(dest) trip", plan, d)
        }
        return (String(trimmed.prefix(40)), nil, nil)
    }

    func create(fromCommand text: String, then insert: @escaping (FundRef) -> Void) {
        let plan = Self.startPlan(for: text)
        guard !plan.name.isEmpty else { return }
        busy = true
        error = nil
        Haptics.tap()
        Task {
            defer { busy = false }
            do {
                let created = try await client.create(name: plan.name)
                book.remember(fundId: created.fundId, key: created.key, name: plan.name,
                              adminKey: created.adminKey, conversation: conversation)
                let ref = book.setPendingFlight(plan.flight, for: created.fundId) ?? book.ref(created.fundId)
                guard let ref else { return }
                Haptics.success()
                show(ref)
                insert(ref)
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }

    /// A flight typed on the Start screen runs as soon as the fund is live.
    private func runPendingFlight() {
        guard let ref, let plan = ref.pendingFlight, searching == nil else { return }
        self.ref = book.setPendingFlight(nil, for: ref.fundId) ?? ref
        if plan.isValid(today: QuickParser.today()) {
            runFlight(plan)
        } else {
            planSheet = PlanPrefill(draft: FlightDraft(origin: plan.origin, destination: plan.destination,
                                                       originLabel: plan.originLabel, destinationLabel: plan.destinationLabel,
                                                       departureDate: nil, returnDate: nil, travelers: plan.travelers,
                                                       cabin: plan.cabin))
        }
    }

    func launch() {
        guard let ref, let admin = ref.adminKey else { return }
        busy = true
        Haptics.tap()
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

    // MARK: Command bar

    /// Sends the instruction to Ask Synq, falls back to the on-device parser, and
    /// runs searches straight away when the instruction is clear.
    func submit(_ text: String) {
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let ref, !prompt.isEmpty, !asking else { return }
        // Business instructions open their screen on the device; Ask Synq never sees them.
        if let command = BusinessParser.parse(prompt) {
            note = nil
            error = nil
            Haptics.tap()
            business.route(command)
            return
        }
        asking = true
        note = nil
        error = nil
        Haptics.tap()
        let local = QuickParser.parse(prompt)
        Task {
            var reply: AskReply?
            var failure: String?
            do {
                reply = try await client.ask(fundId: ref.fundId, key: ref.key, text: prompt)
            } catch let e as FundAPIError {
                failure = e.message
            } catch {
                failure = "Could not reach Synq. Check your connection."
            }
            asking = false
            let outcome = CommandResolver.resolve(reply: reply, local: local,
                                                  defaultTravelers: view?.members.count ?? 2,
                                                  today: QuickParser.today())
            if outcome == .answer, reply == nil {
                error = failure ?? "Could not reach Synq. Check your connection."
                return
            }
            perform(outcome, prompt: prompt, reply: reply?.reply)
        }
    }

    func perform(_ outcome: CommandOutcome, prompt: String, reply: String?) {
        switch outcome {
        case .runFlight(let plan):
            runFlight(plan)
        case .runGift(let query, let maxPrice):
            runGift(query: query, maxPrice: maxPrice)
        case .send(let id, _, let amount):
            note = CommandNote(prompt: prompt, reply: reply ?? "Opening Send.", outcome: outcome)
            sendSheet = SendPrefill(recipientId: id, amount: amount)
        case .completeFlight(let d):
            note = CommandNote(prompt: prompt, reply: reply ?? "Nearly there. Add the missing details.", outcome: outcome)
            planSheet = PlanPrefill(draft: d)
        case .suggestFlight(let p):
            note = CommandNote(prompt: prompt, reply: reply ?? "Want me to search \(TripFormat.summary(p))?", outcome: outcome)
        case .suggestGift(let q, _):
            note = CommandNote(prompt: prompt, reply: reply ?? "Search gifts for “\(q)”?", outcome: outcome)
        case .testMoney:
            note = CommandNote(prompt: prompt, reply: reply ?? "Top up the fund with test money?", outcome: outcome)
        case .answer:
            note = CommandNote(prompt: prompt, reply: reply ?? "", outcome: outcome)
        }
    }

    func runFlight(_ plan: FlightPlan) {
        guard let ref, searching == nil else { return }
        guard view?.state == "ACTIVE" else {
            error = "Trips open once the fund is live."
            return
        }
        searching = .flight(plan)
        note = nil
        error = nil
        Haptics.soft()
        Task {
            do {
                let trip = try await client.startTrip(fundId: ref.fundId, key: ref.key, plan: plan)
                withAnimation(.spring(response: 0.5, dampingFraction: 0.85)) {
                    trips.removeAll { $0.tripId == trip.tripId }
                    trips.insert(trip, at: 0)
                    searching = nil
                    selectedTrip = trip.tripId
                }
                Haptics.success()
            } catch let e as FundAPIError {
                searching = nil
                error = e.message
                Haptics.warning()
            } catch {
                searching = nil
                self.error = "The flight search did not finish. Try again in a moment."
                Haptics.warning()
            }
        }
    }

    func runGift(query: String, maxPrice: String) {
        guard let ref, searching == nil else { return }
        guard view?.state == "ACTIVE" else {
            error = "Gifts open once the fund is live."
            return
        }
        searching = .gift(query: query, maxPrice: maxPrice)
        note = nil
        error = nil
        Haptics.soft()
        Task {
            do {
                let gift = try await client.startGift(fundId: ref.fundId, key: ref.key, query: query, maxPrice: maxPrice)
                withAnimation(.spring(response: 0.5, dampingFraction: 0.85)) {
                    trips.removeAll { $0.tripId == gift.tripId }
                    trips.insert(gift, at: 0)
                    searching = nil
                    selectedTrip = gift.tripId
                }
                Haptics.success()
            } catch let e as FundAPIError {
                searching = nil
                error = e.message
                Haptics.warning()
            } catch {
                searching = nil
                self.error = "The gift search did not finish. Try again in a moment."
                Haptics.warning()
            }
        }
    }

    // MARK: Trips

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
        Haptics.tap()
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

    /// Picks an option and returns where the group pays for it (the Synq page,
    /// where the payer confirms with Face ID; members then approve with theirs).
    func choose(_ trip: TripView, option: String, then pay: @escaping (URL) -> Void) {
        guard let ref else { return }
        busy = true
        Haptics.tap()
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
        Haptics.tap()
        Task {
            defer { busy = false }
            do {
                view = try await client.requestTestFunds(fundId: ref.fundId, key: ref.key)
                note = nil
                Haptics.success()
            } catch let e as FundAPIError {
                error = e.message
            } catch {
                self.error = "Could not reach Synq. Check your connection."
            }
        }
    }
}
