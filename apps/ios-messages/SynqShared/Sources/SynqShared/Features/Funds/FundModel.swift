import SwiftUI

/// What a host hands the fund screens: actions that need the conversation (the
/// Messages card port) or a secure browser (the deep-link port).
public struct FundActions {
    public var insertInvite: (FundRef, FundView?) -> Void
    public var insertProposal: (FundRef, FundProposal) -> Void
    public var insertTrip: (FundRef, TripView) -> Void
    /// Shares an issued invoice's checkout link as an INVOICE card.
    public var insertInvoice: (BusinessInvoice) -> Void = { _ in }
    /// Opens the Synq page (passkey ceremonies) in the in-app browser.
    var open: (URL) -> Void
    public var expand: () -> Void
    /// False outside Messages: "share in this chat" actions are not offered.
    public var canInsertCards = true

    public static let none = FundActions(insertInvite: { _, _ in }, insertProposal: { _, _ in }, insertTrip: { _, _ in },
                                  open: { _ in }, expand: {}, canInsertCards: false)

    /// Builds the actions from the host's ports. `expand` asks Messages for the
    /// expanded panel; the full-screen app passes nothing.
    @MainActor
    public init(cards: MessagesCardPort, links: DeepLinkPort, expand: @escaping () -> Void = {}) {
        self.init(insertInvite: { [weak cards] ref, view in cards?.insertInvite(ref, view: view) },
                  insertProposal: { [weak cards] ref, p in cards?.insertProposal(ref, p) },
                  insertTrip: { [weak cards] ref, t in cards?.insertTrip(ref, t) },
                  insertInvoice: { [weak cards] invoice in cards?.insertInvoice(invoice) },
                  open: { [weak links] url in links?.openSecurely(url) },
                  expand: expand, canInsertCards: cards.canInsert)
    }

    public init(insertInvite: @escaping (FundRef, FundView?) -> Void, insertProposal: @escaping (FundRef, FundProposal) -> Void,
         insertTrip: @escaping (FundRef, TripView) -> Void, insertInvoice: @escaping (BusinessInvoice) -> Void = { _ in },
         open: @escaping (URL) -> Void, expand: @escaping () -> Void, canInsertCards: Bool = true) {
        self.insertInvite = insertInvite
        self.insertProposal = insertProposal
        self.insertTrip = insertTrip
        self.insertInvoice = insertInvoice
        self.open = open
        self.expand = expand
        self.canInsertCards = canInsertCards
    }
}

/// A search in flight, shown as the animated "searching" card.
public struct SearchProgress: Equatable {
    public enum Kind: Equatable { case flight, gift }
    public var kind: Kind
    public var headline: String
    public var detail: String
    public var from: String?
    public var to: String?

    public static func flight(_ p: FlightPlan) -> SearchProgress {
        SearchProgress(kind: .flight, headline: "\(p.origin) → \(p.destination)",
                       detail: "\(TripFormat.range(p.departureDate, p.returnDate)) · \(TripFormat.travellers(p.travelers))",
                       from: p.origin, to: p.destination)
    }

    public static func gift(query: String, maxPrice: String) -> SearchProgress {
        SearchProgress(kind: .gift, headline: query.capitalizedFirst, detail: "Under $\(maxPrice) · live prices")
    }
}

/// Requests to open a sheet, pre-filled; a fresh id each time re-presents it.
public struct SendPrefill: Identifiable, Equatable {
    public var id = UUID()
    public var recipientId: String?
    public var amount: String = ""
}

public struct PlanPrefill: Identifiable, Equatable {
    public var id = UUID()
    public var draft = FlightDraft()
}

public struct GiftPrefill: Identifiable, Equatable {
    public var id = UUID()
    public var query = ""
    public var maxPrice = "50"
}

/// Synq's answer to the last command, with the next step when it needs a tap.
public struct CommandNote: Equatable {
    public var prompt: String
    public var reply: String
    public var outcome: CommandOutcome
}

@MainActor
public final class FundModel: ObservableObject {
    @Published public var ref: FundRef?
    @Published public var view: FundView?
    @Published public var error: String?
    @Published public var busy = false
    @Published public var selectedProposal: String?
    @Published public var selectedTrip: String?
    @Published public var trips: [TripView] = []
    @Published public var asking = false
    @Published public var searching: SearchProgress?
    @Published public var note: CommandNote?
    /// Set to open the Send, Plan Trip or Gift sheet, pre-filled.
    @Published public var sendSheet: SendPrefill?
    @Published public var planSheet: PlanPrefill?
    @Published public var giftSheet: GiftPrefill?
    public let voter = deviceVoterId()

    public let client: FundClient
    @Published public var workspaces: [WorkspaceSummary] = []
    @Published public var workspaceSnapshot: WorkspaceSnapshot?
    @Published public var workspaceCapabilities: WorkspaceCapabilities?
    @Published public var selectedWorkspace: WorkspaceSummary?
    @Published public var workspaceInvoices: [WorkspaceInvoice]?
    @Published public var workspacePayouts: [WorkspacePayout]?
    @Published public var workspaceVendors: [WorkspaceVendor]?
    /// Optional sources: nil means the server does not offer it (or it failed), shown as unavailable.
    @Published public var workspaceBooks: WorkspaceBooks?
    @Published public var workspaceDeals: [WorkspaceDeal]?
    @Published public var workspaceSplits: [WorkspaceSplit]?
    @Published public var workspaceSwaps: [WorkspaceSwap]?
    @Published public var workspaceGroup: WorkspaceGroup?
    @Published public var workspaceReply: WorkspaceTeamReply?
    @Published public var workspaceLoading = false
    @Published public var workspaceAsking = false
    @Published public var workspaceDetailError: String?
    private var workspaceLoad: Task<Void, Never>?
    private var workspaceAsk: Task<Void, Never>?
    private var workspaceRequestId = UUID().uuidString
    private var workspaceQuestion = ""
    @Published public var workspaceSignedIn = false
    @Published public var workspaceBusy = false
    @Published public var workspaceError: String?
    public let book: FundBook
    /// The Arc business features, scoped by the same fund id and key.
    public let business: BusinessModel
    public var conversation: String?
    private var polling: Task<Void, Never>?

    public init(client: FundClient, book: FundBook = FundBook()) {
        self.client = client
        self.book = book
        business = BusinessModel(client: BusinessClient(host: client.host))
        workspaceSignedIn = WorkspaceKeychain.load(host: client.host) != nil
        if workspaceSignedIn { Task { await refreshWorkspaces() } }
    }

    public func signInWorkspace(code: String) {
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

    public func refreshWorkspaces() async {
        workspaceBusy = true
        defer { workspaceBusy = false }
        do {
            workspaces = try await WorkspaceClient(host: client.host).list(); workspaceError = nil
            if let selected = selectedWorkspace, !workspaces.contains(where: { $0.id == selected.id }) { selectWorkspace(nil) }
        }
        catch {
            workspaceError = (error as? FundAPIError)?.message ?? "Could not load your workspaces."
            if WorkspaceKeychain.load(host: client.host) == nil { workspaceSignedIn = false; workspaces = []; selectWorkspace(nil) }
        }
    }

    public func signOutWorkspace() {
        guard !workspaceBusy else { return }
        workspaceBusy = true
        Task {
            await WorkspaceClient(host: client.host).logout()
            selectWorkspace(nil)
            workspaceSignedIn = false; workspaces = []; workspaceError = nil; workspaceBusy = false
        }
    }

    private func workspaceFailure(_ message: String) {
        if WorkspaceKeychain.load(host: client.host) == nil {
            selectWorkspace(nil)
            workspaces = []; workspaceSignedIn = false
            workspaceError = "Your session expired. Sign in again with a new private code."
        } else { workspaceDetailError = message }
    }
    public func selectWorkspace(_ workspace: WorkspaceSummary?) {
        workspaceLoad?.cancel(); workspaceAsk?.cancel()
        let changedWorkspace = selectedWorkspace?.id != workspace?.id
        selectedWorkspace = workspace
        workspaceInvoices = nil; workspacePayouts = nil; workspaceVendors = nil
        workspaceBooks = nil; workspaceDeals = nil; workspaceSplits = nil; workspaceSwaps = nil; workspaceGroup = nil
        workspaceSnapshot = nil; workspaceCapabilities = nil
        workspaceReply = nil; workspaceDetailError = nil; workspaceAsking = false; workspaceLoading = false
        if changedWorkspace || workspace == nil { workspaceRequestId = UUID().uuidString; workspaceQuestion = "" }
        guard let workspace else { return }
        workspaceLoading = true
        workspaceLoad = Task {
            defer { if selectedWorkspace?.id == workspace.id && !Task.isCancelled { workspaceLoading = false } }
            let client = WorkspaceClient(host: client.host)
            do {
                let invoices = try await client.invoices(workspace.id)
                guard !Task.isCancelled, selectedWorkspace?.id == workspace.id else { return }
                workspaceInvoices = invoices
            } catch { if !Task.isCancelled && selectedWorkspace?.id == workspace.id { workspaceFailure("Some workspace data could not be loaded. Refresh or sign in again.") } }
            guard !Task.isCancelled else { return }
            do {
                let payouts = try await client.payouts(workspace.id)
                guard !Task.isCancelled, selectedWorkspace?.id == workspace.id else { return }
                workspacePayouts = payouts
            } catch { if !Task.isCancelled && selectedWorkspace?.id == workspace.id { workspaceFailure("Payment requests unavailable. Refresh or sign in again.") } }
            guard !Task.isCancelled else { return }
            do {
                let finance = try await client.finance(workspace.id)
                guard !Task.isCancelled, selectedWorkspace?.id == workspace.id else { return }
                workspaceVendors = finance.vendors
            } catch { if !Task.isCancelled && selectedWorkspace?.id == workspace.id { workspaceFailure("Vendors unavailable. Refresh or sign in again.") } }
            guard !Task.isCancelled else { return }
            do {
                let snapshot = try await client.snapshot(workspace.id)
                guard !Task.isCancelled, selectedWorkspace?.id == workspace.id else { return }
                workspaceSnapshot = snapshot
            } catch { if !Task.isCancelled && selectedWorkspace?.id == workspace.id { workspaceFailure("Treasury snapshot unavailable. Refresh or sign in again.") } }
            guard !Task.isCancelled else { return }
            do {
                let capabilities = try await client.capabilities()
                guard !Task.isCancelled, selectedWorkspace?.id == workspace.id else { return }
                workspaceCapabilities = capabilities
            } catch { if !Task.isCancelled && selectedWorkspace?.id == workspace.id { workspaceFailure("Feature availability could not be checked.") } }
            guard !Task.isCancelled else { return }
            let books = try? await client.books(workspace.id)
            let deals = try? await client.deals(workspace.id)
            let splits = try? await client.splits(workspace.id)
            let swaps = try? await client.swaps(workspace.id)
            let group = workspace.kind == "GROUP" ? try? await client.group(workspace.id) : nil
            guard !Task.isCancelled, selectedWorkspace?.id == workspace.id else { return }
            workspaceBooks = books; workspaceDeals = deals; workspaceSplits = splits
            workspaceSwaps = swaps; workspaceGroup = group

        }
    }
    public func askWorkspace(_ message: String) {
        guard let workspace = selectedWorkspace, !workspaceAsking else { return }
        if workspaceQuestion != message { workspaceRequestId = UUID().uuidString; workspaceQuestion = message }
        let requestId = workspaceRequestId
        workspaceAsking = true; workspaceDetailError = nil; workspaceReply = nil
        workspaceAsk = Task {
            defer { if selectedWorkspace?.id == workspace.id && !Task.isCancelled { workspaceAsking = false } }
            do {
                let reply = try await WorkspaceClient(host: client.host).ask(workspace.id, message: message, requestId: requestId)
                guard !Task.isCancelled, selectedWorkspace?.id == workspace.id else { return }
                workspaceReply = reply
            } catch {
                if !Task.isCancelled && selectedWorkspace?.id == workspace.id { workspaceFailure((error as? FundAPIError)?.message ?? "The team could not respond. Retry the same question safely.") }
            }
        }
    }

    public var network: String { view?.networkLabel ?? SynqNetwork.fundBackend }

    public func show(_ ref: FundRef?, proposal: String? = nil, trip: String? = nil) {
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

    public func refresh() {
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
    public func startPolling() {
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

    public func stopPolling() {
        polling?.cancel()
        polling = nil
    }

    // MARK: Start

    /// What the Start screen's command field would create: a fund name and,
    /// for a flight instruction, the search to run once the fund is live.
    public static func startPlan(for text: String, today: Date = Date(), calendar: Calendar = .current)
        -> (name: String, flight: FlightPlan?, draft: FlightDraft?) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if case .flight(let d)? = QuickParser.parse(trimmed, today: today, calendar: calendar), let dest = d.destinationLabel {
            let plan = d.plan(defaultTravelers: 2, today: QuickParser.today(today, calendar: calendar))
            return ("\(dest) trip", plan, d)
        }
        return (String(trimmed.prefix(40)), nil, nil)
    }

    public func create(fromCommand text: String, then insert: @escaping (FundRef) -> Void) {
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

    public func launch() {
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
    public func submit(_ text: String) {
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

    public func perform(_ outcome: CommandOutcome, prompt: String, reply: String?) {
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

    public func runFlight(_ plan: FlightPlan) {
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

    public func runGift(query: String, maxPrice: String) {
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

    public func loadTrip(_ tripId: String) {
        guard let ref else { return }
        Task {
            if let t = try? await client.trip(fundId: ref.fundId, key: ref.key, tripId: tripId, voter: voter) {
                replaceTrip(t)
            }
        }
    }

    public func vote(_ trip: TripView, option: String) {
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
    public func choose(_ trip: TripView, option: String, then pay: @escaping (URL) -> Void) {
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

    public func requestTestFunds() {
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
