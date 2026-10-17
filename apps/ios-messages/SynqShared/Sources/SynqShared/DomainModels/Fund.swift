import Foundation
import Security

public struct WorkspaceSession: Codable {
    public let token: String
    public let principalId: String
    public let expiresAt: Double
}

public enum WorkspaceKeychain {
    private static func query(_ host: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "synq.workspace.\(host)", kSecAttrAccount as String: "session"]
    }
    public static func load(host: String) -> WorkspaceSession? {
        var q = query(host)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let session = try? JSONDecoder().decode(WorkspaceSession.self, from: data),
              session.expiresAt > Date().timeIntervalSince1970 else { return nil }
        return session
    }
    public static func save(_ session: WorkspaceSession, host: String) throws {
        var q = query(host)
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = try JSONEncoder().encode(session)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else {
            throw FundAPIError(error: "KEYCHAIN_UNAVAILABLE", message: "Could not securely save sign-in. Try again after unlocking your phone.")
        }
    }
    public static func clear(host: String) { SecItemDelete(query(host) as CFDictionary) }
}

public struct WorkspaceSummary: Decodable, Equatable, Identifiable {
    public let id: String
    public let displayName: String
    public let kind: String
    public let chainId: Int
    public let status: String
    public let vault: String?
    public let threshold: Int?
}

public struct WorkspaceInvoice: Decodable, Identifiable {
    public let invoiceId: String
    public let number: String
    public let status: String
    public let reconciliation: String
    public let total: String
    public let amountDue: String
    public var id: String { invoiceId }
}
public struct WorkspacePayout: Decodable, Identifiable {
    public struct Data: Decodable { public let id: String; public let amount: String; public let purpose: String }
    public let data: Data
    public let state: String
    public let reason: String?
    public let txHash: String?
    public var id: String { data.id }
}
public struct WorkspaceVendor: Decodable, Identifiable {
    public let id: String
    public let name: String
    public let address: String
    public let status: String
    public let eligibleAt: Double
}
public struct WorkspaceFinanceView: Decodable { public let vendors: [WorkspaceVendor] }
public struct WorkspaceBooks: Decodable {
    public struct Payable: Decodable, Identifiable { public let id: String; public let number: String; public let amount: String; public let dueOn: String; public let status: String }
    public struct Bill: Decodable, Identifiable { public let id: String; public let label: String; public let billKind: String; public let amount: String; public let nextDueOn: String; public let cadenceDays: Int }
    public let payables: [Payable]
    public let bills: [Bill]
}
public struct WorkspaceDeal: Decodable, Identifiable {
    public struct Escrow: Decodable { public let escrowDealId: String }
    public struct Milestone: Decodable { public let index: Int; public let title: String; public let amount: String; public let status: String }
    public let id: String
    public let title: String
    public let total: String
    public let status: String
    public let escrow: Escrow?
    public let milestones: [Milestone]
}
public struct WorkspaceSplit: Decodable, Identifiable {
    public struct Leg: Decodable { public let kind: String; public let purpose: String; public let amount: String; public let state: String }
    public let id: String
    public let state: String
    public let received: String
    public let legs: [Leg]
}
public struct WorkspaceSwap: Decodable, Identifiable {
    public struct Terms: Decodable { public let from: String; public let to: String; public let amountIn: String; public let minOut: String }
    public struct Evidence: Decodable { public let received: String? }
    public let id: String
    public let state: String
    public let data: Terms
    public let evidence: Evidence?
}
public struct WorkspaceGroup: Decodable {
    public struct Contribution: Decodable, Identifiable { public let id: String; public let mine: Bool; public let member: String; public let amount: String; public let state: String }
    public struct Share: Decodable { public let member: String; public let mine: Bool; public let amount: String }
    public struct Refund: Decodable, Identifiable { public let id: String; public let mine: Bool; public let amount: String; public let state: String }
    public let contributions: [Contribution]
    public let balances: [Share]
    public let refunds: [Refund]
}
public struct WorkspaceTeamReply: Decodable {
    public struct Citation: Decodable { public let path: String; public let source: String; public let freshness: String }
    public struct World: Decodable { public let builtAt: Double; public let decisionGrade: Bool }
    public let answer: String
    public let status: String
    public let citations: [Citation]
    public let world: World?
    public let payoutId: String?
}
public func workspaceUSDC(_ baseUnits: String) -> String { workspaceAmount(baseUnits, symbol: "USDC") }
/// Exact six-decimal token amount (USDC or EURC) from integer base units.
public func workspaceAmount(_ baseUnits: String, symbol: String) -> String {
    guard !baseUnits.isEmpty, baseUnits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return "Unknown amount" }
    let padded = String(repeating: "0", count: max(0, 7 - baseUnits.count)) + baseUnits
    let boundary = padded.index(padded.endIndex, offsetBy: -6)
    let whole = String(padded[..<boundary]).drop(while: { $0 == "0" })
    var fraction = String(padded[boundary...])
    while fraction.last == "0" { fraction.removeLast() }
    return "\(whole.isEmpty ? "0" : String(whole))\(fraction.isEmpty ? "" : "." + fraction) \(symbol)"
}

public struct WorkspaceObserved<Value: Decodable>: Decodable {
    public struct Meta: Decodable { public let freshness: String; public let source: String; public let observedAt: Double? }
    public let value: Value
    public let meta: Meta
}
public struct WorkspaceSnapshot: Decodable {
    public struct Record: Decodable, Identifiable { public let id: String; public let state: String }
    public struct World: Decodable {
        public struct Balance: Decodable { public let chain: String; public let asset: String; public let account: String; public let baseUnits: String }
        public struct Treasury: Decodable { public let balances: WorkspaceObserved<[Balance]>; public let availableToSpend: WorkspaceObserved<String?> }
        public struct Decision: Decodable { public let decisionGrade: Bool; public let reasons: [String] }
        public let builtAt: Double
        public let treasury: Treasury
        public let decision: Decision
    }
    public let world: World
    public let riskCases: [Record]
    public let deals: [Record]?
}
public struct WorkspaceCapabilities: Decodable {
    public struct Capability: Decodable { public let status: String; public let reason: String }
    public let circleWallets: Capability
    public let gasStation: Capability
    public let usyc: Capability
    public let earn: Capability
    public let swap: Capability
    public let duffel: Capability
    public let lithic: Capability
    public let cctp: Capability
    public let gateway: Capability
    public var entries: [(String, Capability)] {
        [("Circle Wallets", circleWallets), ("Gas Station", gasStation), ("USYC eligibility", usyc), ("Earn", earn), ("Swap", swap), ("Duffel", duffel), ("Lithic", lithic), ("CCTP", cctp), ("Gateway", gateway)]
    }
}

public struct WorkspaceClient {
    public let host: String
    public var session: URLSession = .shared
    /// Bearer source for the full-screen app (its device session). Without one the
    /// client uses the extension's Keychain session, as before.
    public var token: (@Sendable () async throws -> String)? = nil

    public init(host: String, session: URLSession = .shared, token: (@Sendable () async throws -> String)? = nil) {
        self.host = host
        self.session = session
        self.token = token
    }

    private func call<T: Decodable>(_ path: String, body: [String: String]? = nil, authenticated: Bool = true, as type: T.Type) async throws -> T {
        var c = URLComponents(); c.scheme = "https"; c.host = host; c.path = "/api/v2\(path)"
        guard let url = c.url else { throw FundAPIError(error: "INVALID_HOST", message: "Synq's host is not configured.") }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        if authenticated {
            if let token {
                request.setValue("Bearer \(try await token())", forHTTPHeaderField: "authorization")
            } else {
                guard let stored = WorkspaceKeychain.load(host: host) else {
                    throw FundAPIError(error: "SESSION_EXPIRED", message: "Sign in again with a new private code from the Synq page.")
                }
                request.setValue("Bearer \(stored.token)", forHTTPHeaderField: "authorization")
            }
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401 && authenticated && token == nil { WorkspaceKeychain.clear(host: host) }
            if status == 401 && authenticated && token != nil {
                throw FundAPIError(error: "SESSION_EXPIRED", message: "Your session ended. Sign in again.")
            }
            if let error = try? JSONDecoder().decode(FundAPIError.self, from: data) { throw error }
            throw FundAPIError(error: "WORKSPACE_UNAVAILABLE", message: "Workspace sign-in is not available on this server yet.")
        }
        return try JSONDecoder().decode(type, from: data)
    }
    public func redeem(code: String) async throws {
        let normalized = code.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard normalized.range(of: "^[0-9a-f]{48}$", options: .regularExpression) != nil else {
            throw FundAPIError(error: "INVALID_CODE", message: "Paste the private sign-in code from the Synq page.")
        }
        let received = try await call("/auth/native-session", body: ["code": normalized], authenticated: false, as: WorkspaceSession.self)
        guard received.token.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              received.expiresAt > Date().timeIntervalSince1970 else {
            throw FundAPIError(error: "INVALID_SESSION", message: "The sign-in response was not valid.")
        }
        try WorkspaceKeychain.save(received, host: host)
    }
    public func list() async throws -> [WorkspaceSummary] {
        struct Response: Decodable { let workspaces: [WorkspaceSummary] }
        return try await call("/workspaces", as: Response.self).workspaces
    }
    private func workspacePath(_ workspace: String, _ suffix: String) throws -> String {
        guard UUID(uuidString: workspace) != nil else { throw FundAPIError(error: "INVALID_WORKSPACE", message: "Choose a valid workspace.") }
        return "/workspaces/\(workspace)\(suffix)"
    }
    public func invoices(_ workspace: String) async throws -> [WorkspaceInvoice] {
        struct Response: Decodable { let invoices: [WorkspaceInvoice] }
        return try await call(workspacePath(workspace, "/invoices"), as: Response.self).invoices
    }
    public func payouts(_ workspace: String) async throws -> [WorkspacePayout] {
        struct Response: Decodable { let payouts: [WorkspacePayout] }
        return try await call(workspacePath(workspace, "/payouts"), as: Response.self).payouts
    }
    public func finance(_ workspace: String) async throws -> WorkspaceFinanceView {
        try await call(workspacePath(workspace, "/finance"), as: WorkspaceFinanceView.self)
    }
    public func ask(_ workspace: String, message: String, requestId: String) async throws -> WorkspaceTeamReply {
        try await call(workspacePath(workspace, "/team/ask"), body: ["message": message, "idempotencyKey": requestId], as: WorkspaceTeamReply.self)
    }
    public func snapshot(_ workspace: String) async throws -> WorkspaceSnapshot {
        try await call(workspacePath(workspace, "/team/snapshot"), as: WorkspaceSnapshot.self)
    }
    public func books(_ workspace: String) async throws -> WorkspaceBooks {
        try await call(workspacePath(workspace, "/books"), as: WorkspaceBooks.self)
    }
    public func deals(_ workspace: String) async throws -> [WorkspaceDeal] {
        struct Response: Decodable { let deals: [WorkspaceDeal] }
        return try await call(workspacePath(workspace, "/deals"), as: Response.self).deals
    }
    public func splits(_ workspace: String) async throws -> [WorkspaceSplit] {
        struct Response: Decodable { let allocations: [WorkspaceSplit] }
        return try await call(workspacePath(workspace, "/allocations"), as: Response.self).allocations
    }
    public func swaps(_ workspace: String) async throws -> [WorkspaceSwap] {
        struct Response: Decodable { let ops: [WorkspaceSwap] }
        return try await call(workspacePath(workspace, "/treasury/ops"), as: Response.self).ops
    }
    public func group(_ workspace: String) async throws -> WorkspaceGroup {
        try await call(workspacePath(workspace, "/contributions"), as: WorkspaceGroup.self)
    }
    public func capabilities() async throws -> WorkspaceCapabilities {
        try await call("/capabilities", as: WorkspaceCapabilities.self)
    }
    public func logout() async {
        struct Response: Decodable { let ok: Bool }
        _ = try? await call("/auth/logout", body: [:], as: Response.self)
        WorkspaceKeychain.clear(host: host)
    }
}

// MARK: - API models (mirror of apps/demo/src/fund-service.ts FundView)

public struct FundMember: Codable, Equatable, Identifiable {
    public let name: String
    public let principalId: String
    public let memberId: String?
    public let activated: Bool
    public let signedSetup: Bool
    public var id: String { principalId }
}

public struct FundTreasury: Codable, Equatable {
    public let balance: String
    public let symbol: String
}

public struct FundSetup: Codable, Equatable {
    public let signed: Int
    public let required: Int
}

public struct FundGroup: Codable, Equatable {
    public let chainGroupId: String
    public let account: String
}

public struct FundRecipient: Codable, Equatable, Hashable, Identifiable {
    public let name: String
    public let recipientId: String
    public var id: String { recipientId }
}

public struct FundApprovals: Codable, Equatable {
    public let counted: Int
    public let required: Int
    public let names: [String]
}

public struct FundProposal: Codable, Equatable, Identifiable {
    public let intentHash: String
    /// PENDING, EXECUTING, PAID or REJECTED.
    public let state: String
    public let amount: String
    public let symbol: String
    public let recipient: String
    public let sender: String?
    public let approvals: FundApprovals
    public let transactionHash: String?
    public let explorer: String?
    public let createdAt: Int
    public var id: String { intentHash }

    public var title: String { "\(amount) \(symbol) to \(recipient)" }
    public var statusText: String {
        switch state {
        case "PAID": return "Paid"
        case "EXECUTING": return "Sending…"
        case "REJECTED": return "Rejected"
        default: return "\(approvals.counted)/\(approvals.required) approvals"
        }
    }
}

public struct FundView: Codable, Equatable {
    public let fundId: String
    public let name: String
    /// FORMING, LAUNCHING, SETUP, ACTIVE or FAILED.
    public let state: String
    public let error: String?
    public let createdAt: Int
    public let members: [FundMember]
    public let minMembers: Int
    public let maxMembers: Int
    public let threshold: Int
    public let group: FundGroup?
    public let setup: FundSetup?
    public let treasury: FundTreasury?
    public let recipients: [FundRecipient]
    public let proposals: [FundProposal]
    public let canRequestTestFunds: Bool
    /// Largest single payment, as a decimal (absent from older servers).
    public let maxPayment: String?
    /// Chain the group wallet lives on, when the server says (newer servers).
    public let network: String?
    public let chainId: Int?

    /// Truthful network label: what the server reports, else what a payment's
    /// explorer link shows, else the fund backend's chain (Monad testnet).
    public var networkLabel: String {
        if let network, !network.isEmpty { return network }
        if let chainId, let known = SynqNetwork.label(chainId: chainId) { return known }
        for p in proposals {
            if let e = p.explorer, let known = SynqNetwork.label(explorer: e) { return known }
        }
        return SynqNetwork.fundBackend
    }

    public var stateText: String {
        switch state {
        case "FORMING": return "Gathering members"
        case "LAUNCHING": return "Creating the group wallet…"
        case "SETUP":
            if let s = setup { return "Activating · \(s.signed)/\(s.required) signed" }
            return "Activating"
        case "ACTIVE": return "Live"
        default: return "Setup failed"
        }
    }

    public var memberSummary: String {
        members.count == 1 ? "1 member" : "\(members.count) members"
    }
}

public enum SynqNetwork {
    /// The chain the fund backend (apps/demo fund service) runs group wallets on.
    public static let fundBackend = "Monad testnet"

    public static func label(chainId: Int) -> String? {
        switch chainId {
        case 10143: return "Monad testnet"
        case 5042002: return "Arc testnet"
        case 11155111: return "Sepolia"
        case 84532: return "Base Sepolia"
        case 31337: return "Local devnet"
        default: return nil
        }
    }

    public static func label(explorer: String) -> String? {
        let host = URL(string: explorer)?.host?.lowercased() ?? ""
        if host.contains("monad") { return "Monad testnet" }
        if host.contains("arc") { return "Arc testnet" }
        if host.contains("sepolia") { return host.contains("base") ? "Base Sepolia" : "Sepolia" }
        return nil
    }
}

// MARK: - Ask Synq and trips

/// A flight search Ask Synq understood. Fields added later decode as absent on
/// older servers: no return date, no labels, and never auto-run.
public struct AskFlight: Equatable {
    public let origin: String
    public let destination: String
    public let departureDate: String
    public let returnDate: String?
    public let travelers: Int
    public let originLabel: String?
    public let destinationLabel: String?
    public let cabin: String?
    public let autoRun: Bool
}

/// One suggested next step from Ask Synq. Searches may run on their own when the
/// server says `autoRun`; a send only ever pre-fills the Send sheet.
public enum AskAction: Decodable, Equatable {
    case send(recipientId: String, recipient: String, amount: String)
    case flightSearch(AskFlight)
    case giftSearch(query: String, maxPrice: String, autoRun: Bool)
    case testMoney

    private enum Keys: String, CodingKey {
        case kind, recipientId, recipient, amount, origin, destination, departureDate, returnDate, travelers
        case originLabel, destinationLabel, cabin, autoRun, query, maxPrice
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let autoRun = (try? c.decodeIfPresent(Bool.self, forKey: .autoRun)) ?? false
        switch try c.decode(String.self, forKey: .kind) {
        case "SEND":
            self = .send(recipientId: try c.decode(String.self, forKey: .recipientId),
                         recipient: try c.decode(String.self, forKey: .recipient),
                         amount: try c.decode(String.self, forKey: .amount))
        case "FLIGHT_SEARCH":
            self = .flightSearch(AskFlight(
                origin: try c.decode(String.self, forKey: .origin),
                destination: try c.decode(String.self, forKey: .destination),
                departureDate: try c.decode(String.self, forKey: .departureDate),
                returnDate: (try? c.decodeIfPresent(String.self, forKey: .returnDate)) ?? nil,
                travelers: try c.decode(Int.self, forKey: .travelers),
                originLabel: (try? c.decodeIfPresent(String.self, forKey: .originLabel)) ?? nil,
                destinationLabel: (try? c.decodeIfPresent(String.self, forKey: .destinationLabel)) ?? nil,
                cabin: (try? c.decodeIfPresent(String.self, forKey: .cabin)) ?? nil,
                autoRun: autoRun))
        case "GIFT_SEARCH":
            self = .giftSearch(query: try c.decode(String.self, forKey: .query),
                               maxPrice: try c.decode(String.self, forKey: .maxPrice),
                               autoRun: autoRun)
        default:
            self = .testMoney
        }
    }
}

public struct AskReply: Decodable, Equatable {
    public let reply: String
    public let action: AskAction?
}

/// One flight leg of an option, when the server sends them (round trips).
/// Every field is optional so a richer or older server never breaks decoding.
public struct TripLeg: Decodable, Equatable {
    public let origin: String?
    public let destination: String?
    public let departAt: String?
    public let arriveAt: String?
    public let date: String?
    public let flightNumber: String?
    public let stops: Int?
    public let duration: String?
}

public struct TripOptionView: Decodable, Equatable, Identifiable {
    public let optionId: String
    public let title: String
    public let detail: String
    public let total: String
    public let currency: String
    public let refundable: Bool
    public let votes: Int
    public let legs: [TripLeg]?
    public var id: String { optionId }

    private enum Keys: String, CodingKey {
        case optionId, title, detail, total, currency, refundable, votes, legs
    }

    public init(optionId: String, title: String, detail: String, total: String, currency: String,
         refundable: Bool, votes: Int, legs: [TripLeg]? = nil) {
        self.optionId = optionId
        self.title = title
        self.detail = detail
        self.total = total
        self.currency = currency
        self.refundable = refundable
        self.votes = votes
        self.legs = legs
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        optionId = try c.decode(String.self, forKey: .optionId)
        title = try c.decode(String.self, forKey: .title)
        detail = try c.decode(String.self, forKey: .detail)
        total = try c.decode(String.self, forKey: .total)
        currency = try c.decode(String.self, forKey: .currency)
        refundable = try c.decode(Bool.self, forKey: .refundable)
        votes = try c.decode(Int.self, forKey: .votes)
        legs = (try? c.decodeIfPresent([TripLeg].self, forKey: .legs)) ?? nil
    }
}

public struct TripPayment: Decodable, Equatable {
    public let amount: String
    public let intentHash: String?
}

public struct TripBooking: Decodable, Equatable {
    public let reference: String?
}

public struct TripPayTo: Decodable, Equatable {
    public let recipientId: String
    public let label: String
}

public struct TripView: Decodable, Equatable, Identifiable {
    public let tripId: String
    /// FLIGHT or GIFT.
    public let kind: String
    public let title: String
    public let origin: String?
    public let destination: String?
    public let departureDate: String?
    /// Present for return flights (newer servers).
    public let returnDate: String?
    public let travelers: Int?
    public let query: String?
    public let maxPrice: String?
    /// VOTING, AWAITING_PAYMENT, BOOKING, BOOKED or FAILED.
    public let state: String
    public let options: [TripOptionView]
    public let voteCount: Int
    public let leading: String?
    public let myVote: String?
    public let chosen: String?
    public let payment: TripPayment?
    public let booking: TripBooking?
    public let error: String?
    public let label: String
    public let payTo: TripPayTo?
    public var id: String { tripId }

    public var isGift: Bool { kind == "GIFT" }
    public var stateText: String {
        switch state {
        case "VOTING": return voteCount == 1 ? "1 vote" : "\(voteCount) votes"
        case "AWAITING_PAYMENT": return "Waiting for the group to pay"
        case "BOOKING": return isGift ? "Buying…" : "Booking…"
        case "BOOKED": return isGift ? "Bought ✓" : "Booked ✓"
        default: return "Could not book"
        }
    }
    public var chosenOption: TripOptionView? { options.first { $0.optionId == chosen } }
}

private struct TripList: Decodable { let trips: [TripView] }

// MARK: - Links carried in MSMessage.url

/// `https://<host>/fund/<fundId>#k=<key>` (invite),
/// `https://<host>/fund/<fundId>/p/<intentHash>#k=<key>` (payment) or
/// `https://<host>/fund/<fundId>/t/<tripId>#k=<key>` (trip).
/// The key sits in the fragment so browsers never send it to the server.
public enum FundLink: Equatable {
    case invite(fundId: String, key: String)
    case proposal(fundId: String, key: String, intentHash: String)
    case trip(fundId: String, key: String, tripId: String)

    public var fundId: String {
        switch self {
        case .invite(let id, _), .proposal(let id, _, _), .trip(let id, _, _): return id
        }
    }

    public var key: String {
        switch self {
        case .invite(_, let k), .proposal(_, let k, _), .trip(_, let k, _): return k
        }
    }

    public static let tripPattern = "^trp_[0-9a-f]{16}$"

    public static let fundIdPattern = "^fnd_[0-9a-f]{20}$"
    public static let keyPattern = "^[A-Za-z0-9_-]{32}$"
    public static let hashPattern = "^0x[0-9a-fA-F]{64}$"

    public init?(url: URL, allowedHost: String) {
        guard url.scheme == "https",
              let host = url.host, host.lowercased() == allowedHost.lowercased()
        else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        let fragment = URLComponents(string: "?\(url.fragment ?? "")")?.queryItems
        guard let key = fragment?.first(where: { $0.name == "k" })?.value,
              FundLink.matches(key, FundLink.keyPattern),
              parts.count >= 2, parts[0] == "fund",
              FundLink.matches(parts[1], FundLink.fundIdPattern)
        else { return nil }
        if parts.count == 2 {
            self = .invite(fundId: parts[1], key: key)
        } else if parts.count == 4, parts[2] == "p", FundLink.matches(parts[3], FundLink.hashPattern) {
            self = .proposal(fundId: parts[1], key: key, intentHash: parts[3])
        } else if parts.count == 4, parts[2] == "t", FundLink.matches(parts[3], FundLink.tripPattern) {
            self = .trip(fundId: parts[1], key: key, tripId: parts[3])
        } else {
            return nil
        }
    }

    public func url(host: String) -> URL {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        switch self {
        case .invite(let id, _): c.path = "/fund/\(id)"
        case .proposal(let id, _, let hash): c.path = "/fund/\(id)/p/\(hash)"
        case .trip(let id, _, let trip): c.path = "/fund/\(id)/t/\(trip)"
        }
        c.fragment = "k=\(key)"
        return c.url!
    }

    public static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }
}

// MARK: - API client

public struct FundAPIError: Error, Decodable {
    public let error: String
    public let message: String
}

public struct FundCreated: Decodable {
    public let fundId: String
    public let key: String
    public let adminKey: String
}

/// Talks to `https://<host>/api/v1/funds`. It holds no credentials beyond the
/// fund key and, for the creator, the admin key; money only moves after members
/// approve with their passkeys on the Synq site.
public struct FundClient {
    public let host: String
    public var session: URLSession = .shared

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                         timeout: TimeInterval = 15) -> URLRequest {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/api/v1\(path)"
        var r = URLRequest(url: c.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpMethod = method
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "content-type")
            r.setValue(UUID().uuidString, forHTTPHeaderField: "idempotency-key")
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private func send<T: Decodable>(_ r: URLRequest, as: T.Type) async throws -> T {
        let (data, response) = try await session.data(for: r)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let e = try? JSONDecoder().decode(FundAPIError.self, from: data) { throw e }
            throw FundAPIError(error: "HTTP_\(status)", message: "Synq is unreachable right now.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    public func create(name: String) async throws -> FundCreated {
        try await send(request("/funds", method: "POST", body: ["name": name]), as: FundCreated.self)
    }

    public func view(fundId: String, key: String) async throws -> FundView {
        var r = request("/funds/\(fundId)")
        var c = URLComponents(url: r.url!, resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "k", value: key)]
        r.url = c.url
        return try await send(r, as: FundView.self)
    }

    public func launch(fundId: String, adminKey: String) async throws {
        struct Status: Decodable { let status: String }
        _ = try await send(request("/funds/\(fundId)/launch", method: "POST", body: ["adminKey": adminKey]), as: Status.self)
    }

    public func ask(fundId: String, key: String, text: String) async throws -> AskReply {
        try await send(request("/funds/\(fundId)/ask", method: "POST", body: ["key": key, "text": text]),
                       as: AskReply.self)
    }

    /// Live provider searches can take most of a minute, so these wait longer.
    public static let searchTimeout: TimeInterval = 100

    public func startTrip(fundId: String, key: String, plan: FlightPlan) async throws -> TripView {
        try await send(request("/funds/\(fundId)/trips", method: "POST",
                               body: Self.tripBody(key: key, plan: plan), timeout: Self.searchTimeout),
                       as: TripView.self)
    }

    /// `returnDate` is sent only when present, so older servers see the same body as before.
    public static func tripBody(key: String, plan: FlightPlan) -> [String: Any] {
        var body: [String: Any] = [
            "key": key, "origin": plan.origin, "destination": plan.destination,
            "departureDate": plan.departureDate, "travelers": plan.travelers,
        ]
        if let r = plan.returnDate { body["returnDate"] = r }
        return body
    }

    public func startGift(fundId: String, key: String, query: String, maxPrice: String) async throws -> TripView {
        try await send(request("/funds/\(fundId)/gifts", method: "POST",
                               body: ["key": key, "query": query, "maxPrice": maxPrice],
                               timeout: Self.searchTimeout), as: TripView.self)
    }

    private func readRequest(_ path: String, key: String, voter: String) -> URLRequest {
        var r = request(path)
        var c = URLComponents(url: r.url!, resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "k", value: key), URLQueryItem(name: "v", value: voter)]
        r.url = c.url
        return r
    }

    public func trips(fundId: String, key: String, voter: String) async throws -> [TripView] {
        try await send(readRequest("/funds/\(fundId)/trips", key: key, voter: voter), as: TripList.self).trips
    }

    public func trip(fundId: String, key: String, tripId: String, voter: String) async throws -> TripView {
        try await send(readRequest("/funds/\(fundId)/trips/\(tripId)", key: key, voter: voter), as: TripView.self)
    }

    public func vote(fundId: String, key: String, tripId: String, voter: String, optionId: String) async throws -> TripView {
        try await send(request("/funds/\(fundId)/trips/\(tripId)/votes", method: "POST",
                               body: ["key": key, "voterId": voter, "optionId": optionId]), as: TripView.self)
    }

    public func choose(fundId: String, key: String, tripId: String, optionId: String) async throws -> TripView {
        try await send(request("/funds/\(fundId)/trips/\(tripId)/choose", method: "POST",
                               body: ["key": key, "optionId": optionId]), as: TripView.self)
    }

    public func requestTestFunds(fundId: String, key: String) async throws -> FundView {
        try await send(request("/funds/\(fundId)/test-funds", method: "POST", body: ["key": key]), as: FundView.self)
    }

    // Pages on the Synq site where the passkey ceremonies happen.

    public func workspacePage(workspace: String? = nil, payout: String? = nil) -> URL {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/workspaces"
        var items: [URLQueryItem] = []
        if let workspace { items.append(URLQueryItem(name: "workspace", value: workspace)) }
        if let payout { items.append(URLQueryItem(name: "payout", value: payout)) }
        if !items.isEmpty { c.queryItems = items }
        return c.url!
    }

    public func fundPage(_ fundId: String, key: String) -> URL {
        FundLink.invite(fundId: fundId, key: key).url(host: host)
    }

    public func sendPage(groupId: String, recipientId: String, amount: String) -> URL {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/send"
        c.queryItems = [
            URLQueryItem(name: "groupId", value: groupId),
            URLQueryItem(name: "recipientId", value: recipientId),
            URLQueryItem(name: "amount", value: amount),
        ]
        return c.url!
    }

    public func tripPaymentPage(groupId: String, payTo: TripPayTo, amount: String) -> URL {
        sendPage(groupId: groupId, recipientId: payTo.recipientId, amount: amount)
    }

    public func approvalPage(_ intentHash: String) -> URL {
        URL(string: "https://\(host)/intents/\(intentHash)")!
    }
}

// MARK: - Funds this device knows about

public struct FundRef: Codable, Equatable {
    public let fundId: String
    public let key: String
    public var name: String
    /// Present only on the device that started the fund.
    public var adminKey: String?
    public var conversations: [String]
    public var lastUsed: Date
    /// A flight typed on the Start screen, searched once the fund goes live.
    public var pendingFlight: FlightPlan?
}

/// Local memory of which fund belongs to which conversation. The extension cannot
/// read the transcript, so it learns the link when someone starts a fund here or
/// taps one of its cards.
public struct FundBook {
    public var defaults: UserDefaults = .standard
    private let storageKey = "synq.funds.v1"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func all() -> [FundRef] {
        guard let data = defaults.data(forKey: storageKey),
              let refs = try? JSONDecoder().decode([FundRef].self, from: data)
        else { return [] }
        return refs
    }

    private func save(_ refs: [FundRef]) {
        if let data = try? JSONEncoder().encode(refs) { defaults.set(data, forKey: storageKey) }
    }

    public func fund(forConversation conversation: String) -> FundRef? {
        all().filter { $0.conversations.contains(conversation) }.max { $0.lastUsed < $1.lastUsed }
    }

    public func ref(_ fundId: String) -> FundRef? { all().first { $0.fundId == fundId } }

    @discardableResult
    public func remember(fundId: String, key: String, name: String?, adminKey: String? = nil, conversation: String?) -> FundRef {
        var refs = all()
        var ref = refs.first { $0.fundId == fundId }
            ?? FundRef(fundId: fundId, key: key, name: name ?? "Synq fund", adminKey: nil, conversations: [], lastUsed: Date())
        if let name { ref.name = name }
        if let adminKey { ref.adminKey = adminKey }
        if let conversation, !ref.conversations.contains(conversation) { ref.conversations.append(conversation) }
        ref.lastUsed = Date()
        refs.removeAll { $0.fundId == fundId }
        refs.append(ref)
        save(refs)
        return ref
    }

    @discardableResult
    public func setPendingFlight(_ plan: FlightPlan?, for fundId: String) -> FundRef? {
        var refs = all()
        guard let i = refs.firstIndex(where: { $0.fundId == fundId }) else { return nil }
        refs[i].pendingFlight = plan
        save(refs)
        return refs[i]
    }
}

/// One anonymous id per device for non-binding trip votes.
public func deviceVoterId(_ defaults: UserDefaults = .standard) -> String {
    if let id = defaults.string(forKey: "synq.voter.v1") { return id }
    let id = UUID().uuidString.lowercased()
    defaults.set(id, forKey: "synq.voter.v1")
    return id
}

/// Decimal text a person typed, normalised to at most six places; nil when invalid.
public func normalizedAmount(_ raw: String, max: Decimal) -> String? {
    let s = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
    guard s.range(of: "^[0-9]{1,6}(\\.[0-9]{1,6})?$", options: .regularExpression) != nil,
          let value = Decimal(string: s, locale: Locale(identifier: "en_US_POSIX")),
          value > 0, value <= max
    else { return nil }
    return s
}
