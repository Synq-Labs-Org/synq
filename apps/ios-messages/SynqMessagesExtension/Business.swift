import Foundation

// The Arc business features (Deal Room, invoices, the finance team, revenue
// splits, treasury and contractor payouts) as the extension sees them: the API
// models, the client and the command-bar routing. Foundation only, so the
// parser and decoding are checked on macOS (Checks/ParserChecks.swift).
//
// Every route is scoped by the chat's group fund (fund id + key). Nothing here
// signs or moves money: drafts open the Synq page, where wallets sign.

// MARK: - Features

enum BusinessFeatureKind: String, CaseIterable, Identifiable {
    case deals, invoices, team, splits, treasury, contractors
    var id: String { rawValue }
}

struct BusinessFeature: Decodable, Equatable {
    let enabled: Bool
    let reason: String?
}

struct BusinessCapabilities: Decodable, Equatable {
    let network: String?
    let chainId: Int?
    let business: String?
    let features: [String: BusinessFeature]

    func feature(_ kind: BusinessFeatureKind) -> BusinessFeature? { features[kind.rawValue] }
}

/// Whether a feature can be used here, and if not, the honest reason why.
enum BusinessAvailability: Equatable {
    case checking
    case enabled
    case off(String)

    static let notOnServer = "Not enabled on this server yet."

    var isEnabled: Bool { self == .enabled }
    var reason: String? { if case .off(let r) = self { return r } else { return nil } }
}

enum BusinessNetwork {
    /// The chain every business feature runs on.
    static let label = "Arc testnet"
    static let chainId = 5042002
}

// MARK: - Deal Room

struct DealMilestone: Decodable, Equatable, Identifiable {
    let title: String
    let amount: String
    let due: String?
    var id: String { "\(title)|\(amount)|\(due ?? "")" }
}

struct DealDraft: Decodable, Equatable {
    /// DRAFTED or REFUSED.
    let status: String
    let dealId: String?
    let title: String?
    let total: String?
    let symbol: String?
    let milestones: [DealMilestone]?
    let client: String?
    let freelancer: String?
    let arbiter: String?
    let ambiguities: [String]?
    let reviewUrl: String?
    let reason: String?
    let network: String?

    var drafted: Bool { status == "DRAFTED" && reviewURL != nil }
    var reviewURL: URL? { reviewUrl.flatMap(BusinessLinks.https) }
}

// MARK: - Invoices

struct BusinessInvoice: Decodable, Equatable {
    let invoiceId: String
    let number: String
    /// DRAFT, ISSUED, PARTIALLY_PAID, PAID, OVERPAID or VOID.
    let status: String
    let payer: String
    let description: String?
    let total: String
    let symbol: String
    let dueDate: String?
    let issuer: String?
    let payTo: String?
    let issueUrl: String?
    let payUrl: String?
    let network: String?

    var issueURL: URL? { issueUrl.flatMap(BusinessLinks.https) }
    /// A checkout link exists only once the issuer has signed (never for a draft).
    var payURL: URL? { status == "DRAFT" || status == "VOID" ? nil : payUrl.flatMap(BusinessLinks.https) }

    var statusText: String {
        switch status {
        case "DRAFT": return "Draft"
        case "ISSUED": return "Issued"
        case "PARTIALLY_PAID": return "Partial"
        case "PAID": return "Paid"
        case "OVERPAID": return "Overpaid"
        case "VOID": return "Void"
        default: return status.capitalized
        }
    }
}

// MARK: - Finance team

struct TeamSection: Decodable, Equatable, Identifiable {
    let persona: String
    let label: String
    let stance: String
    let text: String
    let evidence: [String]?
    var id: String { "\(persona)|\(label)" }
}

struct TeamDecision: Decodable, Equatable {
    let status: String
    let outcome: String?
    let reasons: [String]

    /// The Kernel's verdict in words, from the structured fields only.
    var headline: String {
        switch outcome {
        case "ALLOW": return "Allowed by the Kernel"
        case "REQUIRE_OWNER_APPROVAL": return "Needs the owner's signature"
        case "DENY": return "Denied by the Kernel"
        default: break
        }
        switch status {
        case "NOT_SUBMITTED": return "Not submitted to the Kernel"
        case "REFUSED_STALE": return "Refused: the data was too old"
        case "PROPOSED": return "Proposed: waiting for the owner"
        case "GRANTED": return "Granted by the Kernel"
        case "DENIED": return "Denied by the Kernel"
        default: return status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// A short badge word, from the structured fields only.
    var badge: String {
        switch outcome {
        case "ALLOW": return "Allow"
        case "REQUIRE_OWNER_APPROVAL": return "Owner signs"
        case "DENY": return "Deny"
        default: break
        }
        switch status {
        case "NOT_SUBMITTED": return "Not sent"
        case "REFUSED_STALE": return "Stale"
        case "PROPOSED": return "Proposed"
        case "GRANTED": return "Granted"
        case "DENIED": return "Denied"
        default: return status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var tone: String {
        if outcome == "DENY" || status == "DENIED" || status == "REFUSED_STALE" { return "DANGER" }
        if outcome == "ALLOW" || status == "GRANTED" { return "APPROVED" }
        return "PENDING"
    }
}

struct TeamRiskCase: Decodable, Equatable {
    let caseId: String
    let status: String
    let outcome: String
    let froze: Bool
}

struct TeamResult: Decodable, Equatable {
    /// ANSWERED, NEEDS_CLARIFICATION or STOPPED.
    let status: String
    let runId: String?
    let sections: [TeamSection]
    let decision: TeamDecision
    let riskCase: TeamRiskCase?
    let unavailable: [String]?
    let approvalUrl: String?
    let answer: String?
    let readOnly: Bool?
    let network: String?

    /// Specialists in the order the member reads them; the Kernel's decision is separate.
    var specialists: [TeamSection] {
        let order = ["CFO", "RISK", "PAYMENT", "AUDIT"]
        return sections.filter { $0.persona != "DECISION" }
            .sorted { (order.firstIndex(of: $0.persona) ?? 9) < (order.firstIndex(of: $1.persona) ?? 9) }
    }

    var approvalURL: URL? { approvalUrl.flatMap(BusinessLinks.https) }
}

// MARK: - Treasury

struct TreasuryAccount: Decodable, Equatable, Identifiable {
    let label: String
    let address: String
    let usdc: String?
    let explorer: String?
    var id: String { address + label }
}

struct VaultPolicyView: Decodable, Equatable {
    let perPaymentCap: String
    let windowCap: String
    let remaining: String
    let paused: Bool
}

struct EarnVaultView: Decodable, Equatable, Identifiable {
    let name: String
    let address: String
    let underlyingOk: Bool?
    let totalAssets: String?
    let apy: String?
    let note: String?
    var id: String { address }
}

struct UsycEligibility: Decodable, Equatable {
    let wallet: String?
    /// ELIGIBLE, INELIGIBLE or UNAVAILABLE.
    let status: String
    let explanation: String
}

struct TreasuryView: Decodable, Equatable {
    let network: String?
    let blockNumber: String?
    let observedAt: Int?
    let accounts: [TreasuryAccount]
    let vaultPolicy: VaultPolicyView?
    let earn: [EarnVaultView]
    let usyc: UsycEligibility?
}

// MARK: - Revenue split preview

struct SplitLeg: Decodable, Equatable, Identifiable {
    let purpose: String
    let kind: String
    let label: String
    let amount: String
    let basis: String?
    var id: String { "\(purpose)|\(label)|\(amount)" }
}

struct ForecastPoint: Decodable, Equatable, Identifiable {
    let days: Int
    let committed: String
    let expected: String?
    let lowPoint: String?
    var id: Int { days }
}

struct SplitPolicyView: Decodable, Equatable {
    let taxReserveBps: Int?
    let operatingFloor: String?
    let horizonDays: Int?
}

struct SplitPreview: Decodable, Equatable {
    let label: String
    let amount: String
    let symbol: String
    let headline: String?
    let legs: [SplitLeg]
    let summary: [String: String]?
    let forecast: [ForecastPoint]?
    let policy: SplitPolicyView?
    let notes: [String]?
}

// MARK: - Vendors

struct BusinessVendor: Decodable, Equatable, Identifiable, Hashable {
    let vendorId: String
    let name: String
    let kind: String?
    let address: String
    let verified: Bool
    let source: String?
    var id: String { vendorId }
}

private struct VendorList: Decodable { let vendors: [BusinessVendor] }

// MARK: - Links

enum BusinessLinks {
    /// Only https links are ever opened.
    static func https(_ s: String) -> URL? {
        guard let u = URL(string: s), u.scheme == "https", u.host != nil else { return nil }
        return u
    }
}

/// A checkout link shared into the chat: `https://<host>/pay/<token>#n=&a=&s=&p=`.
/// The token is the server's HMAC pay link; the fragment is an unverified display
/// hint written by the sender (browsers never send it). Live status comes from
/// `GET /api/v1/pay/<token>`.
struct InvoiceLink: Equatable {
    let token: String
    let number: String?
    let amount: String?
    let symbol: String?
    let payer: String?
    let url: URL
    let checkoutURL: URL

    static let tokenPattern = "^[A-Za-z0-9_.-]{10,200}$"

    init?(url: URL, allowedHost: String) {
        guard url.scheme == "https", let host = url.host, host.lowercased() == allowedHost.lowercased()
        else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count == 2, parts[0] == "pay",
              parts[1].range(of: Self.tokenPattern, options: .regularExpression) != nil
        else { return nil }
        let items = URLComponents(string: "?\(url.fragment ?? "")")?.queryItems ?? []
        func hint(_ k: String, _ max: Int) -> String? {
            guard let v = items.first(where: { $0.name == k })?.value, !v.isEmpty else { return nil }
            return String(v.prefix(max))
        }
        token = parts[1]
        number = hint("n", 40)
        amount = hint("a", 24).flatMap { $0.range(of: "^[0-9]{1,12}(\\.[0-9]{1,6})?$", options: .regularExpression) != nil ? $0 : nil }
        symbol = hint("s", 8)
        payer = hint("p", 80)
        self.url = url
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/pay/\(parts[1])"
        guard let checkout = c.url else { return nil }
        checkoutURL = checkout
    }

    /// The message URL for an issued invoice's checkout link, with display hints.
    static func messageURL(for invoice: BusinessInvoice, allowedHost: String) -> URL? {
        guard let pay = invoice.payURL, pay.host?.lowercased() == allowedHost.lowercased(),
              var c = URLComponents(url: pay, resolvingAgainstBaseURL: false)
        else { return nil }
        var hints = URLComponents()
        hints.queryItems = [URLQueryItem(name: "n", value: invoice.number),
                            URLQueryItem(name: "a", value: invoice.total),
                            URLQueryItem(name: "s", value: invoice.symbol),
                            URLQueryItem(name: "p", value: String(invoice.payer.prefix(80)))]
        c.query = nil
        c.fragment = hints.percentEncodedQuery
        guard let url = c.url, InvoiceLink(url: url, allowedHost: allowedHost) != nil else { return nil }
        return url
    }
}

/// The public checkout view (`GET /api/v1/pay/<token>`), as far as the bubble needs it.
struct CheckoutStatus: Decodable, Equatable {
    let number: String
    let status: String
    let payer: String?
    let total: String
    let amountDue: String?
    let dueDate: String?
    let asset: Asset?

    struct Asset: Decodable, Equatable { let symbol: String }
}

// MARK: - Client

enum BusinessError: Error, Equatable {
    /// The server has no business routes (404) or the feature is switched off (503).
    case notEnabled(String)
    case api(String)
    case unreachable

    var message: String {
        switch self {
        case .notEnabled(let m): return m
        case .api(let m): return m
        case .unreachable: return "Could not reach Synq. Check your connection."
        }
    }
}

/// Talks to `https://<host>/api/v1/funds/<fundId>/business/…` with the fund key.
struct BusinessClient {
    let host: String
    var session: URLSession = .shared

    func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/api/v1\(path)"
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }

    func get(_ path: String, key: String) -> URLRequest {
        var r = URLRequest(url: url(path, query: [URLQueryItem(name: "k", value: key)]),
                           cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        r.httpMethod = "GET"
        return r
    }

    func post(_ path: String, body: [String: Any], timeout: TimeInterval = 30) -> URLRequest {
        var r = URLRequest(url: url(path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.setValue(UUID().uuidString, forHTTPHeaderField: "idempotency-key")
        r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return r
    }

    /// Maps an HTTP status and body to a value or an honest error.
    static func decode<T: Decodable>(_ data: Data, status: Int, as: T.Type) throws -> T {
        if status == 404 { throw BusinessError.notEnabled(BusinessAvailability.notOnServer) }
        let apiError = try? JSONDecoder().decode(FundAPIError.self, from: data)
        if status == 503 || apiError?.error == "NOT_ENABLED" {
            throw BusinessError.notEnabled(apiError?.message ?? BusinessAvailability.notOnServer)
        }
        guard (200..<300).contains(status) else {
            throw BusinessError.api(apiError?.message ?? "Synq could not do that right now.")
        }
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            throw BusinessError.api("Synq sent a reply this version cannot read.")
        }
    }

    private func send<T: Decodable>(_ r: URLRequest, as type: T.Type) async throws -> T {
        let data: Data, response: URLResponse
        do { (data, response) = try await session.data(for: r) } catch { throw BusinessError.unreachable }
        return try Self.decode(data, status: (response as? HTTPURLResponse)?.statusCode ?? 0, as: type)
    }

    private func base(_ fundId: String) -> String { "/funds/\(fundId)/business" }

    func capabilities(fundId: String, key: String) async throws -> BusinessCapabilities {
        try await send(get("\(base(fundId))/capabilities", key: key), as: BusinessCapabilities.self)
    }

    func draftDeal(fundId: String, key: String, text: String) async throws -> DealDraft {
        try await send(post("\(base(fundId))/deals", body: ["key": key, "text": text], timeout: 60), as: DealDraft.self)
    }

    static func invoiceBody(key: String, payer: String, amount: String, description: String) -> [String: Any] {
        ["key": key, "payer": payer, "amount": amount, "description": description]
    }

    func createInvoice(fundId: String, key: String, payer: String, amount: String, description: String) async throws -> BusinessInvoice {
        try await send(post("\(base(fundId))/invoices",
                            body: Self.invoiceBody(key: key, payer: payer, amount: amount, description: description)),
                       as: BusinessInvoice.self)
    }

    func invoice(fundId: String, key: String, invoiceId: String) async throws -> BusinessInvoice {
        try await send(get("\(base(fundId))/invoices/\(invoiceId)", key: key), as: BusinessInvoice.self)
    }

    func ask(fundId: String, key: String, text: String) async throws -> TeamResult {
        try await send(post("\(base(fundId))/team/ask", body: ["key": key, "text": text], timeout: 90), as: TeamResult.self)
    }

    func treasury(fundId: String, key: String) async throws -> TreasuryView {
        try await send(get("\(base(fundId))/treasury", key: key), as: TreasuryView.self)
    }

    func previewSplit(fundId: String, key: String, amount: String) async throws -> SplitPreview {
        try await send(post("\(base(fundId))/splits/preview", body: ["key": key, "amount": amount]), as: SplitPreview.self)
    }

    func vendors(fundId: String, key: String) async throws -> [BusinessVendor] {
        try await send(get("\(base(fundId))/vendors", key: key), as: VendorList.self).vendors
    }

    /// Public checkout status for a shared invoice card (no fund key needed).
    func checkout(token: String) async throws -> CheckoutStatus {
        var r = URLRequest(url: url("/pay/\(token)"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        r.httpMethod = "GET"
        return try await send(r, as: CheckoutStatus.self)
    }
}

// MARK: - Command bar routing

/// A business instruction the device recognised; it opens the matching screen
/// (pre-filled) instead of going to Ask Synq. Nothing runs that moves money.
enum BusinessCommand: Equatable {
    case deal(text: String)
    case invoice(payer: String, amount: String, description: String)
    case team(question: String)
    case split(amount: String)
    case treasury

    var feature: BusinessFeatureKind {
        switch self {
        case .deal: return .deals
        case .invoice: return .invoices
        case .team: return .team
        case .split: return .splits
        case .treasury: return .treasury
        }
    }
}

enum BusinessParser {
    private static let amount = "\\$?([0-9]{1,6}(?:\\.[0-9]{1,6})?)(?: ?(?:usdc|usd|dollars|bucks))?"

    static func parse(_ raw: String) -> BusinessCommand? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let s = text.lowercased().replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        let lead = "^(?:(?:hey|hi|ok|synq|please|can you|could you|let's|lets|we need to|i need to|i want to|help me)[ ,]+)*"

        // "split 1500", "split income of $1,500", "preview a split of 1500 usdc"
        let plain = s.replacingOccurrences(of: "(?<=[0-9]),(?=[0-9]{3})", with: "", options: .regularExpression)
        if let m = QuickParser.matches(lead + "(?:preview (?:a |the )?)?split(?: (?:my |our |the |this )?(?:income|revenue|payment|receipt|invoice))?(?: of| for)? \(amount)$", plain).first,
           let a = m.g[0], let n = normalizedAmount(a, max: 1_000_000) {
            return .split(amount: n)
        }

        // "invoice a customer 120 for the logo", "send an invoice to a customer for 120 usdc for the logo", "bill a customer $120 logo"
        let invoiceHead = lead + "(?:(?:send|create|make|raise|draft|issue) )?(?:an |a )?(?:invoice|bill)(?: to| for)? "
        let named = "([a-z][a-z .'-]{0,40}?)"
        let patterns = [
            invoiceHead + named + "(?: for)? \(amount)(?:(?: for| on| re:?)? (.+))?$",
            invoiceHead + "\(amount)(?: to| for) " + named + "(?:(?: for| on| re:?) (.+))?$",
        ]
        for (i, p) in patterns.enumerated() {
            if let m = QuickParser.matches(p, plain).first {
                let nameGroup = i == 0 ? m.g[0] : m.g[1]
                let amountGroup = i == 0 ? m.g[1] : m.g[0]
                guard let rawName = nameGroup, let a = amountGroup, let n = normalizedAmount(a, max: 10_000) else { continue }
                let name = original(rawName, in: text)
                let what = (m.g[2] ?? "").replacingOccurrences(of: "^(?:the |a |an )", with: "", options: .regularExpression)
                return .invoice(payer: name, amount: n, description: original(what, in: text))
            }
        }

        // "ask CFO and risk whether to pay a supplier", "what does my finance team think…"
        if s.range(of: "\\b(cfo|risk agent|finance team|council)\\b", options: .regularExpression) != nil
            || s.range(of: lead + "ask (?:the |my |our )?(?:team|risk)\\b", options: .regularExpression) != nil {
            return .team(question: text)
        }

        // "draft a deal: …", "set up a deal room with a supplier", "create an escrow deal"
        if s.range(of: lead + "(?:draft|create|make|start|open|set up|setup|write up|propose)(?: up)? (?:a |an |the |new )*(?:escrow )?deal\\b", options: .regularExpression) != nil
            || s.range(of: "^deal room\\b", options: .regularExpression) != nil {
            let body = text.replacingOccurrences(
                of: "^(?i)(?:(?:hey|hi|ok|synq|please|can you|could you|let's|lets|we need to|i need to|i want to|help me)[ ,]+)*(?:draft|create|make|start|open|set up|setup|write up|propose)(?: up)? (?:a |an |the |new )*(?:escrow )?deal(?: room)?[ :,-]*",
                with: "", options: .regularExpression)
            return .deal(text: body.isEmpty ? text : body)
        }

        if s.range(of: lead + "(?:show |open |check )?(?:the |my |our )?(?:treasury|arc balances?|earn vaults?|usyc)\\b", options: .regularExpression) != nil {
            return .treasury
        }
        return nil
    }

    /// The same span in the user's own capitalisation.
    private static func original(_ lowered: String, in text: String) -> String {
        let t = lowered.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, let r = text.range(of: t, options: .caseInsensitive) else { return t }
        return String(text[r])
    }
}
