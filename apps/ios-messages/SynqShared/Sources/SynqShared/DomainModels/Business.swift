import Foundation

// The Arc business features (Deal Room, invoices, the finance team, revenue
// splits, treasury and contractor payouts) as the extension sees them: the API
// models, the client and the command-bar routing. Foundation only, so the
// parser and decoding are checked on macOS (Checks/ParserChecks.swift).
//
// Every route is scoped by the chat's group fund (fund id + key). Nothing here
// signs or moves money: drafts open the Synq page, where wallets sign.

// MARK: - Features

public enum BusinessFeatureKind: String, CaseIterable, Identifiable {
    case deals, invoices, team, splits, treasury, contractors
    public var id: String { rawValue }
}

public struct BusinessFeature: Decodable, Equatable {
    public let enabled: Bool
    public let reason: String?
}

public struct BusinessCapabilities: Decodable, Equatable {
    public let network: String?
    public let chainId: Int?
    public let business: String?
    public let features: [String: BusinessFeature]

    public func feature(_ kind: BusinessFeatureKind) -> BusinessFeature? { features[kind.rawValue] }
}

/// Whether a feature can be used here, and if not, the honest reason why.
public enum BusinessAvailability: Equatable {
    case checking
    case enabled
    case off(String)

    public static let notOnServer = "Not enabled on this server yet."

    public var isEnabled: Bool { self == .enabled }
    public var reason: String? { if case .off(let r) = self { return r } else { return nil } }
}

public enum BusinessNetwork {
    /// The chain every business feature runs on.
    public static let label = "Arc testnet"
    public static let chainId = 5042002
}

// MARK: - Deal Room

public struct DealMilestone: Decodable, Equatable, Identifiable {
    public let title: String
    public let amount: String
    public let due: String?
    public var id: String { "\(title)|\(amount)|\(due ?? "")" }
}

public struct DealDraft: Decodable, Equatable {
    /// DRAFTED or REFUSED.
    public let status: String
    public let dealId: String?
    public let title: String?
    public let total: String?
    public let symbol: String?
    public let milestones: [DealMilestone]?
    public let client: String?
    public let freelancer: String?
    public let arbiter: String?
    public let ambiguities: [String]?
    public let reviewUrl: String?
    public let reason: String?
    public let network: String?

    public var drafted: Bool { status == "DRAFTED" && reviewURL != nil }
    public var reviewURL: URL? { reviewUrl.flatMap(BusinessLinks.https) }
}

// MARK: - Invoices

public struct BusinessInvoice: Decodable, Equatable {
    public let invoiceId: String
    public let number: String
    /// DRAFT, ISSUED, PARTIALLY_PAID, PAID, OVERPAID or VOID.
    public let status: String
    public let payer: String
    public let description: String?
    public let total: String
    public let symbol: String
    public let dueDate: String?
    public let issuer: String?
    public let payTo: String?
    public let issueUrl: String?
    public let payUrl: String?
    public let network: String?

    public var issueURL: URL? { issueUrl.flatMap(BusinessLinks.https) }
    /// A checkout link exists only once the issuer has signed (never for a draft).
    public var payURL: URL? { status == "DRAFT" || status == "VOID" ? nil : payUrl.flatMap(BusinessLinks.https) }

    public var statusText: String {
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

public struct TeamSection: Decodable, Equatable, Identifiable {
    public let persona: String
    public let label: String
    public let stance: String
    public let text: String
    public let evidence: [String]?
    public var id: String { "\(persona)|\(label)" }
}

public struct TeamDecision: Decodable, Equatable {
    public let status: String
    public let outcome: String?
    public let reasons: [String]

    /// The Kernel's verdict in words, from the structured fields only.
    public var headline: String {
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
    public var badge: String {
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

    public var tone: String {
        if outcome == "DENY" || status == "DENIED" || status == "REFUSED_STALE" { return "DANGER" }
        if outcome == "ALLOW" || status == "GRANTED" { return "APPROVED" }
        return "PENDING"
    }
}

public struct TeamRiskCase: Decodable, Equatable {
    public let caseId: String
    public let status: String
    public let outcome: String
    public let froze: Bool
}

public struct TeamResult: Decodable, Equatable {
    /// ANSWERED, NEEDS_CLARIFICATION or STOPPED.
    public let status: String
    public let runId: String?
    public let sections: [TeamSection]
    public let decision: TeamDecision
    public let riskCase: TeamRiskCase?
    public let unavailable: [String]?
    public let approvalUrl: String?
    public let answer: String?
    public let readOnly: Bool?
    public let network: String?

    /// Specialists in the order the member reads them; the Kernel's decision is separate.
    public var specialists: [TeamSection] {
        let order = ["CFO", "RISK", "PAYMENT", "AUDIT"]
        return sections.filter { $0.persona != "DECISION" }
            .sorted { (order.firstIndex(of: $0.persona) ?? 9) < (order.firstIndex(of: $1.persona) ?? 9) }
    }

    public var approvalURL: URL? { approvalUrl.flatMap(BusinessLinks.https) }
}

// MARK: - Treasury

public struct TreasuryAccount: Decodable, Equatable, Identifiable {
    public let label: String
    public let address: String
    public let usdc: String?
    public let explorer: String?
    public var id: String { address + label }
}

public struct VaultPolicyView: Decodable, Equatable {
    public let perPaymentCap: String
    public let windowCap: String
    public let remaining: String
    public let paused: Bool
}

public struct EarnVaultView: Decodable, Equatable, Identifiable {
    public let name: String
    public let address: String
    public let underlyingOk: Bool?
    public let totalAssets: String?
    public let apy: String?
    public let note: String?
    public var id: String { address }
}

public struct UsycEligibility: Decodable, Equatable {
    public let wallet: String?
    /// ELIGIBLE, INELIGIBLE or UNAVAILABLE.
    public let status: String
    public let explanation: String
}

public struct TreasuryView: Decodable, Equatable {
    public let network: String?
    public let blockNumber: String?
    public let observedAt: Int?
    public let accounts: [TreasuryAccount]
    public let vaultPolicy: VaultPolicyView?
    public let earn: [EarnVaultView]
    public let usyc: UsycEligibility?
}

// MARK: - Revenue split preview

public struct SplitLeg: Decodable, Equatable, Identifiable {
    public let purpose: String
    public let kind: String
    public let label: String
    public let amount: String
    public let basis: String?
    public var id: String { "\(purpose)|\(label)|\(amount)" }
}

public struct ForecastPoint: Decodable, Equatable, Identifiable {
    public let days: Int
    public let committed: String
    public let expected: String?
    public let lowPoint: String?
    public var id: Int { days }
}

public struct SplitPolicyView: Decodable, Equatable {
    public let taxReserveBps: Int?
    public let operatingFloor: String?
    public let horizonDays: Int?
}

public struct SplitPreview: Decodable, Equatable {
    public let label: String
    public let amount: String
    public let symbol: String
    public let headline: String?
    public let legs: [SplitLeg]
    public let summary: [String: String]?
    public let forecast: [ForecastPoint]?
    public let policy: SplitPolicyView?
    public let notes: [String]?
}

// MARK: - Vendors

public struct BusinessVendor: Decodable, Equatable, Identifiable, Hashable {
    public let vendorId: String
    public let name: String
    public let kind: String?
    public let address: String
    public let verified: Bool
    public let source: String?
    public var id: String { vendorId }
}

private struct VendorList: Decodable { let vendors: [BusinessVendor] }

// MARK: - Links

public enum BusinessLinks {
    /// Only https links are ever opened.
    public static func https(_ s: String) -> URL? {
        guard let u = URL(string: s), u.scheme == "https", u.host != nil else { return nil }
        return u
    }
}

/// A checkout link shared into the chat: `https://<host>/pay/<token>#n=&a=&s=&p=`.
/// The token is the server's HMAC pay link; the fragment is an unverified display
/// hint written by the sender (browsers never send it). Live status comes from
/// `GET /api/v1/pay/<token>`.
public struct InvoiceLink: Equatable {
    public let token: String
    public let number: String?
    public let amount: String?
    public let symbol: String?
    public let payer: String?
    public let url: URL
    public let checkoutURL: URL

    public static let tokenPattern = "^[A-Za-z0-9_.-]{10,200}$"

    public init?(url: URL, allowedHost: String) {
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
    public static func messageURL(for invoice: BusinessInvoice, allowedHost: String) -> URL? {
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
public struct CheckoutStatus: Decodable, Equatable {
    public let number: String
    public let status: String
    public let payer: String?
    public let total: String
    public let amountDue: String?
    public let dueDate: String?
    public let asset: Asset?

    public struct Asset: Decodable, Equatable { public let symbol: String }
}

// MARK: - Client

public enum BusinessError: Error, Equatable {
    /// The server has no business routes (404) or the feature is switched off (503).
    case notEnabled(String)
    case api(String)
    case unreachable

    public var message: String {
        switch self {
        case .notEnabled(let m): return m
        case .api(let m): return m
        case .unreachable: return "Could not reach Synq. Check your connection."
        }
    }
}

/// Talks to `https://<host>/api/v1/funds/<fundId>/business/…` with the fund key.
public struct BusinessClient {
    public let host: String
    public var session: URLSession = .shared

    public func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/api/v1\(path)"
        if !query.isEmpty { c.queryItems = query }
        return c.url!
    }

    public func get(_ path: String, key: String) -> URLRequest {
        var r = URLRequest(url: url(path, query: [URLQueryItem(name: "k", value: key)]),
                           cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        r.httpMethod = "GET"
        return r
    }

    public func post(_ path: String, body: [String: Any], timeout: TimeInterval = 30) -> URLRequest {
        var r = URLRequest(url: url(path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        r.setValue(UUID().uuidString, forHTTPHeaderField: "idempotency-key")
        r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        return r
    }

    /// Maps an HTTP status and body to a value or an honest error.
    public static func decode<T: Decodable>(_ data: Data, status: Int, as: T.Type) throws -> T {
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

    public func capabilities(fundId: String, key: String) async throws -> BusinessCapabilities {
        try await send(get("\(base(fundId))/capabilities", key: key), as: BusinessCapabilities.self)
    }

    public func draftDeal(fundId: String, key: String, text: String) async throws -> DealDraft {
        try await send(post("\(base(fundId))/deals", body: ["key": key, "text": text], timeout: 60), as: DealDraft.self)
    }

    public static func invoiceBody(key: String, payer: String, amount: String, description: String) -> [String: Any] {
        ["key": key, "payer": payer, "amount": amount, "description": description]
    }

    public func createInvoice(fundId: String, key: String, payer: String, amount: String, description: String) async throws -> BusinessInvoice {
        try await send(post("\(base(fundId))/invoices",
                            body: Self.invoiceBody(key: key, payer: payer, amount: amount, description: description)),
                       as: BusinessInvoice.self)
    }

    public func invoice(fundId: String, key: String, invoiceId: String) async throws -> BusinessInvoice {
        try await send(get("\(base(fundId))/invoices/\(invoiceId)", key: key), as: BusinessInvoice.self)
    }

    public func ask(fundId: String, key: String, text: String) async throws -> TeamResult {
        try await send(post("\(base(fundId))/team/ask", body: ["key": key, "text": text], timeout: 90), as: TeamResult.self)
    }

    public func treasury(fundId: String, key: String) async throws -> TreasuryView {
        try await send(get("\(base(fundId))/treasury", key: key), as: TreasuryView.self)
    }

    public func previewSplit(fundId: String, key: String, amount: String) async throws -> SplitPreview {
        try await send(post("\(base(fundId))/splits/preview", body: ["key": key, "amount": amount]), as: SplitPreview.self)
    }

    public func vendors(fundId: String, key: String) async throws -> [BusinessVendor] {
        try await send(get("\(base(fundId))/vendors", key: key), as: VendorList.self).vendors
    }

    /// Public checkout status for a shared invoice card (no fund key needed).
    public func checkout(token: String) async throws -> CheckoutStatus {
        var r = URLRequest(url: url("/pay/\(token)"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        r.httpMethod = "GET"
        return try await send(r, as: CheckoutStatus.self)
    }
}

// MARK: - Command bar routing

/// A business instruction the device recognised; it opens the matching screen
/// (pre-filled) instead of going to Ask Synq. Nothing runs that moves money.
public enum BusinessCommand: Equatable {
    case deal(text: String)
    case invoice(payer: String, amount: String, description: String)
    case team(question: String)
    case split(amount: String)
    case treasury

    public var feature: BusinessFeatureKind {
        switch self {
        case .deal: return .deals
        case .invoice: return .invoices
        case .team: return .team
        case .split: return .splits
        case .treasury: return .treasury
        }
    }
}

public enum BusinessParser {
    private static let amount = "\\$?([0-9]{1,6}(?:\\.[0-9]{1,6})?)(?: ?(?:usdc|usd|dollars|bucks))?"

    public static func parse(_ raw: String) -> BusinessCommand? {
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
