import SwiftUI

/// Which business screen is open, and what it was opened with.
public struct BusinessSheet: Identifiable, Equatable {
    public var id = UUID()
    public var kind: BusinessFeatureKind
    public var text = ""
    public var payer = ""
    public var amount = ""
    public var note = ""
    /// Run straight away (a clear command-bar instruction), never for money.
    public var autoRun = false
}

/// State of the Arc business features for the chat's fund. Every call is a read,
/// a draft or a proposal; signing happens on the Synq page in the owner's wallet.
@MainActor
public final class BusinessModel: ObservableObject {
    @Published public var capabilities: BusinessCapabilities?
    /// Set when the server has no business routes at all (an older deployment).
    @Published public var offServer: String?
    @Published public var checked = false
    @Published public var sheet: BusinessSheet?
    @Published public var busy: BusinessFeatureKind?
    @Published public var error: String?
    @Published public var deal: DealDraft?
    @Published public var invoice: BusinessInvoice?
    @Published public var team: TeamResult?
    @Published public var teamQuestion: String?
    @Published public var treasury: TreasuryView?
    @Published public var split: SplitPreview?
    @Published public var vendors: [BusinessVendor]?

    public let client: BusinessClient
    /// The fund these features are scoped by (id + capability key), never a conversation.
    private(set) var fund: FundContext?

    public init(client: BusinessClient) {
        self.client = client
    }

    public var businessName: String { capabilities?.business ?? "Arc business" }
    public var network: String { capabilities?.network ?? BusinessNetwork.label }

    public func availability(_ kind: BusinessFeatureKind) -> BusinessAvailability {
        if let offServer { return .off(offServer) }
        guard let caps = capabilities else { return checked ? .off(BusinessAvailability.notOnServer) : .checking }
        guard let f = caps.feature(kind) else { return .off(BusinessAvailability.notOnServer) }
        return f.enabled ? .enabled : .off(f.reason ?? BusinessAvailability.notOnServer)
    }

    public func show(_ ref: FundRef?) {
        let fund = ref.map(FundContext.init)
        if fund?.fundId != self.fund?.fundId {
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
        self.fund = fund
        loadCapabilities()
    }

    public func loadCapabilities() {
        guard let ref = fund else { return }
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
    public func route(_ command: BusinessCommand) {
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

    private func run(_ kind: BusinessFeatureKind, _ work: @escaping (FundContext) async throws -> Void) {
        guard let ref = fund, busy == nil else { return }
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

    public func draftDeal(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        deal = nil
        run(.deals) { [client] ref in
            self.deal = try await client.draftDeal(fundId: ref.fundId, key: ref.key, text: String(t.prefix(1000)))
        }
    }

    public func createInvoice(payer: String, amount: String, description: String) {
        run(.invoices) { [client] ref in
            self.invoice = try await client.createInvoice(fundId: ref.fundId, key: ref.key, payer: payer,
                                                          amount: amount, description: description)
        }
    }

    public func refreshInvoice() {
        guard let id = invoice?.invoiceId else { return }
        run(.invoices) { [client] ref in
            self.invoice = try await client.invoice(fundId: ref.fundId, key: ref.key, invoiceId: id)
        }
    }

    public func ask(_ question: String) {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        teamQuestion = q
        team = nil
        run(.team) { [client] ref in
            self.team = try await client.ask(fundId: ref.fundId, key: ref.key, text: String(q.prefix(500)))
        }
    }

    /// "Pay a contractor" asks the council first; the approval link appears only if the Kernel proposes one.
    public func askToPay(_ vendor: BusinessVendor, amount: String) {
        ask("Should we pay \(vendor.name) \(amount) USDC?")
    }

    public func loadTreasury() {
        run(.treasury) { [client] ref in
            self.treasury = try await client.treasury(fundId: ref.fundId, key: ref.key)
        }
    }

    public func previewSplit(_ amount: String) {
        run(.splits) { [client] ref in
            self.split = try await client.previewSplit(fundId: ref.fundId, key: ref.key, amount: amount)
        }
    }

    public func loadVendors() {
        run(.contractors) { [client] ref in
            self.vendors = try await client.vendors(fundId: ref.fundId, key: ref.key)
        }
    }

    /// Back from the Synq page: an invoice may now be issued.
    public func refreshAfterBrowser() {
        if invoice?.status == "DRAFT" { refreshInvoice() }
    }
}
