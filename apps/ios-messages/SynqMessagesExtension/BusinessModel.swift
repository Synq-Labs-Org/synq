import SwiftUI

/// Which business screen is open, and what it was opened with.
struct BusinessSheet: Identifiable, Equatable {
    var id = UUID()
    var kind: BusinessFeatureKind
    var text = ""
    var payer = ""
    var amount = ""
    var note = ""
    /// Run straight away (a clear command-bar instruction), never for money.
    var autoRun = false
}

/// State of the Arc business features for the chat's fund. Every call is a read,
/// a draft or a proposal; signing happens on the Synq page in the owner's wallet.
@MainActor
final class BusinessModel: ObservableObject {
    @Published var capabilities: BusinessCapabilities?
    /// Set when the server has no business routes at all (an older deployment).
    @Published var offServer: String?
    @Published var checked = false
    @Published var sheet: BusinessSheet?
    @Published var busy: BusinessFeatureKind?
    @Published var error: String?
    @Published var deal: DealDraft?
    @Published var invoice: BusinessInvoice?
    @Published var team: TeamResult?
    @Published var teamQuestion: String?
    @Published var treasury: TreasuryView?
    @Published var split: SplitPreview?
    @Published var vendors: [BusinessVendor]?

    let client: BusinessClient
    private(set) var ref: FundRef?

    init(client: BusinessClient) {
        self.client = client
    }

    var businessName: String { capabilities?.business ?? "Arc business" }
    var network: String { capabilities?.network ?? BusinessNetwork.label }

    func availability(_ kind: BusinessFeatureKind) -> BusinessAvailability {
        if let offServer { return .off(offServer) }
        guard let caps = capabilities else { return checked ? .off(BusinessAvailability.notOnServer) : .checking }
        guard let f = caps.feature(kind) else { return .off(BusinessAvailability.notOnServer) }
        return f.enabled ? .enabled : .off(f.reason ?? BusinessAvailability.notOnServer)
    }

    func show(_ ref: FundRef?) {
        if ref?.fundId != self.ref?.fundId {
            capabilities = nil
            offServer = nil
            checked = false
            deal = nil
            invoice = nil
            team = nil
            treasury = nil
            split = nil
            vendors = nil
        }
        self.ref = ref
        loadCapabilities()
    }

    func loadCapabilities() {
        guard let ref else { return }
        Task {
            do {
                capabilities = try await client.capabilities(fundId: ref.fundId, key: ref.key)
                offServer = nil
            } catch BusinessError.notEnabled(let m) {
                offServer = m
            } catch {
                // Unreachable: keep what we had; the screens retry.
            }
            checked = true
        }
    }

    func open(_ kind: BusinessFeatureKind, text: String = "", payer: String = "", amount: String = "",
              note: String = "", autoRun: Bool = false) {
        error = nil
        sheet = BusinessSheet(kind: kind, text: text, payer: payer, amount: amount, note: note, autoRun: autoRun)
    }

    /// A command-bar instruction: open the screen pre-filled; reads and drafts run at once.
    func route(_ command: BusinessCommand) {
        switch command {
        case .deal(let text): open(.deals, text: text)
        case .invoice(let payer, let amount, let description):
            open(.invoices, payer: payer, amount: amount, note: description)
        case .team(let q): open(.team, text: q, autoRun: true)
        case .split(let amount): open(.splits, amount: amount, autoRun: true)
        case .treasury: open(.treasury, autoRun: true)
        }
    }

    // MARK: Calls

    private func run(_ kind: BusinessFeatureKind, _ work: @escaping (FundRef) async throws -> Void) {
        guard let ref, busy == nil else { return }
        busy = kind
        error = nil
        Haptics.tap()
        Task {
            defer { busy = nil }
            do {
                try await work(ref)
                Haptics.success()
            } catch let e as BusinessError {
                if case .notEnabled(let m) = e { markOff(kind, m) }
                error = e.message
                Haptics.warning()
            } catch {
                self.error = BusinessError.unreachable.message
            }
        }
    }

    private func markOff(_ kind: BusinessFeatureKind, _ reason: String) {
        var features = capabilities?.features ?? [:]
        features[kind.rawValue] = BusinessFeature(enabled: false, reason: reason)
        capabilities = BusinessCapabilities(network: capabilities?.network, chainId: capabilities?.chainId,
                                            business: capabilities?.business, features: features)
    }

    func draftDeal(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        deal = nil
        run(.deals) { [client] ref in
            self.deal = try await client.draftDeal(fundId: ref.fundId, key: ref.key, text: String(t.prefix(1000)))
        }
    }

    func createInvoice(payer: String, amount: String, description: String) {
        run(.invoices) { [client] ref in
            self.invoice = try await client.createInvoice(fundId: ref.fundId, key: ref.key, payer: payer,
                                                          amount: amount, description: description)
        }
    }

    func refreshInvoice() {
        guard let id = invoice?.invoiceId else { return }
        run(.invoices) { [client] ref in
            self.invoice = try await client.invoice(fundId: ref.fundId, key: ref.key, invoiceId: id)
        }
    }

    func ask(_ question: String) {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        teamQuestion = q
        team = nil
        run(.team) { [client] ref in
            self.team = try await client.ask(fundId: ref.fundId, key: ref.key, text: String(q.prefix(500)))
        }
    }

    /// "Pay a contractor" asks the council first; the approval link appears only if the Kernel proposes one.
    func askToPay(_ vendor: BusinessVendor, amount: String) {
        ask("Should we pay \(vendor.name) \(amount) USDC?")
    }

    func loadTreasury() {
        run(.treasury) { [client] ref in
            self.treasury = try await client.treasury(fundId: ref.fundId, key: ref.key)
        }
    }

    func previewSplit(_ amount: String) {
        run(.splits) { [client] ref in
            self.split = try await client.previewSplit(fundId: ref.fundId, key: ref.key, amount: amount)
        }
    }

    func loadVendors() {
        run(.contractors) { [client] ref in
            self.vendors = try await client.vendors(fundId: ref.fundId, key: ref.key)
        }
    }

    /// Back from the Synq page: an invoice may now be issued.
    func refreshAfterBrowser() {
        if invoice?.status == "DRAFT" { refreshInvoice() }
    }
}
