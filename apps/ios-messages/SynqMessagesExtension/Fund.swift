import Foundation
import Security

struct WorkspaceSession: Codable {
    let token: String
    let principalId: String
    let expiresAt: Double
}

enum WorkspaceKeychain {
    private static func query(_ host: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "synq.workspace.\(host)", kSecAttrAccount as String: "session"]
    }
    static func load(host: String) -> WorkspaceSession? {
        var q = query(host)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let session = try? JSONDecoder().decode(WorkspaceSession.self, from: data),
              session.expiresAt > Date().timeIntervalSince1970 else { return nil }
        return session
    }
    static func save(_ session: WorkspaceSession, host: String) throws {
        var q = query(host)
        SecItemDelete(q as CFDictionary)
        q[kSecValueData as String] = try JSONEncoder().encode(session)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else {
            throw FundAPIError(error: "KEYCHAIN_UNAVAILABLE", message: "Could not securely save sign-in. Try again after unlocking your phone.")
        }
    }
    static func clear(host: String) { SecItemDelete(query(host) as CFDictionary) }
}

struct WorkspaceSummary: Decodable, Equatable, Identifiable {
    let id: String
    let displayName: String
    let kind: String
    let chainId: Int
    let status: String
    let vault: String?
    let threshold: Int?
}

struct WorkspaceClient {
    let host: String
    var session: URLSession = .shared
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
            guard let stored = WorkspaceKeychain.load(host: host) else {
                throw FundAPIError(error: "SESSION_EXPIRED", message: "Sign in again with a new private code from the Synq page.")
            }
            request.setValue("Bearer \(stored.token)", forHTTPHeaderField: "authorization")
        }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if status == 401 && authenticated { WorkspaceKeychain.clear(host: host) }
            if let error = try? JSONDecoder().decode(FundAPIError.self, from: data) { throw error }
            throw FundAPIError(error: "WORKSPACE_UNAVAILABLE", message: "Workspace sign-in is not available on this server yet.")
        }
        return try JSONDecoder().decode(type, from: data)
    }
    func redeem(code: String) async throws {
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
    func list() async throws -> [WorkspaceSummary] {
        struct Response: Decodable { let workspaces: [WorkspaceSummary] }
        return try await call("/workspaces", as: Response.self).workspaces
    }
    func logout() async {
        struct Response: Decodable { let ok: Bool }
        _ = try? await call("/auth/logout", body: [:], as: Response.self)
        WorkspaceKeychain.clear(host: host)
    }
}

// MARK: - API models (mirror of apps/demo/src/fund-service.ts FundView)

struct FundMember: Codable, Equatable, Identifiable {
    let name: String
    let principalId: String
    let memberId: String?
    let activated: Bool
    let signedSetup: Bool
    var id: String { principalId }
}

struct FundTreasury: Codable, Equatable {
    let balance: String
    let symbol: String
}

struct FundSetup: Codable, Equatable {
    let signed: Int
    let required: Int
}

struct FundGroup: Codable, Equatable {
    let chainGroupId: String
    let account: String
}

struct FundRecipient: Codable, Equatable, Hashable, Identifiable {
    let name: String
    let recipientId: String
    var id: String { recipientId }
}

struct FundApprovals: Codable, Equatable {
    let counted: Int
    let required: Int
    let names: [String]
}

struct FundProposal: Codable, Equatable, Identifiable {
    let intentHash: String
    /// PENDING, EXECUTING, PAID or REJECTED.
    let state: String
    let amount: String
    let symbol: String
    let recipient: String
    let sender: String?
    let approvals: FundApprovals
    let transactionHash: String?
    let explorer: String?
    let createdAt: Int
    var id: String { intentHash }

    var title: String { "\(amount) \(symbol) to \(recipient)" }
    var statusText: String {
        switch state {
        case "PAID": return "Paid"
        case "EXECUTING": return "Sending…"
        case "REJECTED": return "Rejected"
        default: return "\(approvals.counted)/\(approvals.required) approvals"
        }
    }
}

struct FundView: Codable, Equatable {
    let fundId: String
    let name: String
    /// FORMING, LAUNCHING, SETUP, ACTIVE or FAILED.
    let state: String
    let error: String?
    let createdAt: Int
    let members: [FundMember]
    let minMembers: Int
    let maxMembers: Int
    let threshold: Int
    let group: FundGroup?
    let setup: FundSetup?
    let treasury: FundTreasury?
    let recipients: [FundRecipient]
    let proposals: [FundProposal]
    let canRequestTestFunds: Bool
    /// Largest single payment, as a decimal (absent from older servers).
    let maxPayment: String?
    /// Chain the group wallet lives on, when the server says (newer servers).
    let network: String?
    let chainId: Int?

    /// Truthful network label: what the server reports, else what a payment's
    /// explorer link shows, else the fund backend's chain (Monad testnet).
    var networkLabel: String {
        if let network, !network.isEmpty { return network }
        if let chainId, let known = SynqNetwork.label(chainId: chainId) { return known }
        for p in proposals {
            if let e = p.explorer, let known = SynqNetwork.label(explorer: e) { return known }
        }
        return SynqNetwork.fundBackend
    }

    var stateText: String {
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

    var memberSummary: String {
        members.count == 1 ? "1 member" : "\(members.count) members"
    }
}

enum SynqNetwork {
    /// The chain the fund backend (apps/demo fund service) runs group wallets on.
    static let fundBackend = "Monad testnet"

    static func label(chainId: Int) -> String? {
        switch chainId {
        case 10143: return "Monad testnet"
        case 5042002: return "Arc testnet"
        case 11155111: return "Sepolia"
        case 84532: return "Base Sepolia"
        case 31337: return "Local devnet"
        default: return nil
        }
    }

    static func label(explorer: String) -> String? {
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
struct AskFlight: Equatable {
    let origin: String
    let destination: String
    let departureDate: String
    let returnDate: String?
    let travelers: Int
    let originLabel: String?
    let destinationLabel: String?
    let cabin: String?
    let autoRun: Bool
}

/// One suggested next step from Ask Synq. Searches may run on their own when the
/// server says `autoRun`; a send only ever pre-fills the Send sheet.
enum AskAction: Decodable, Equatable {
    case send(recipientId: String, recipient: String, amount: String)
    case flightSearch(AskFlight)
    case giftSearch(query: String, maxPrice: String, autoRun: Bool)
    case testMoney

    private enum Keys: String, CodingKey {
        case kind, recipientId, recipient, amount, origin, destination, departureDate, returnDate, travelers
        case originLabel, destinationLabel, cabin, autoRun, query, maxPrice
    }

    init(from decoder: Decoder) throws {
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

struct AskReply: Decodable, Equatable {
    let reply: String
    let action: AskAction?
}

/// One flight leg of an option, when the server sends them (round trips).
/// Every field is optional so a richer or older server never breaks decoding.
struct TripLeg: Decodable, Equatable {
    let origin: String?
    let destination: String?
    let departAt: String?
    let arriveAt: String?
    let date: String?
    let flightNumber: String?
    let stops: Int?
    let duration: String?
}

struct TripOptionView: Decodable, Equatable, Identifiable {
    let optionId: String
    let title: String
    let detail: String
    let total: String
    let currency: String
    let refundable: Bool
    let votes: Int
    let legs: [TripLeg]?
    var id: String { optionId }

    private enum Keys: String, CodingKey {
        case optionId, title, detail, total, currency, refundable, votes, legs
    }

    init(optionId: String, title: String, detail: String, total: String, currency: String,
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

    init(from decoder: Decoder) throws {
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

struct TripPayment: Decodable, Equatable {
    let amount: String
    let intentHash: String?
}

struct TripBooking: Decodable, Equatable {
    let reference: String?
}

struct TripPayTo: Decodable, Equatable {
    let recipientId: String
    let label: String
}

struct TripView: Decodable, Equatable, Identifiable {
    let tripId: String
    /// FLIGHT or GIFT.
    let kind: String
    let title: String
    let origin: String?
    let destination: String?
    let departureDate: String?
    /// Present for return flights (newer servers).
    let returnDate: String?
    let travelers: Int?
    let query: String?
    let maxPrice: String?
    /// VOTING, AWAITING_PAYMENT, BOOKING, BOOKED or FAILED.
    let state: String
    let options: [TripOptionView]
    let voteCount: Int
    let leading: String?
    let myVote: String?
    let chosen: String?
    let payment: TripPayment?
    let booking: TripBooking?
    let error: String?
    let label: String
    let payTo: TripPayTo?
    var id: String { tripId }

    var isGift: Bool { kind == "GIFT" }
    var stateText: String {
        switch state {
        case "VOTING": return voteCount == 1 ? "1 vote" : "\(voteCount) votes"
        case "AWAITING_PAYMENT": return "Waiting for the group to pay"
        case "BOOKING": return isGift ? "Buying…" : "Booking…"
        case "BOOKED": return isGift ? "Bought ✓" : "Booked ✓"
        default: return "Could not book"
        }
    }
    var chosenOption: TripOptionView? { options.first { $0.optionId == chosen } }
}

private struct TripList: Decodable { let trips: [TripView] }

// MARK: - Links carried in MSMessage.url

/// `https://<host>/fund/<fundId>#k=<key>` (invite),
/// `https://<host>/fund/<fundId>/p/<intentHash>#k=<key>` (payment) or
/// `https://<host>/fund/<fundId>/t/<tripId>#k=<key>` (trip).
/// The key sits in the fragment so browsers never send it to the server.
enum FundLink: Equatable {
    case invite(fundId: String, key: String)
    case proposal(fundId: String, key: String, intentHash: String)
    case trip(fundId: String, key: String, tripId: String)

    var fundId: String {
        switch self {
        case .invite(let id, _), .proposal(let id, _, _), .trip(let id, _, _): return id
        }
    }

    var key: String {
        switch self {
        case .invite(_, let k), .proposal(_, let k, _), .trip(_, let k, _): return k
        }
    }

    static let tripPattern = "^trp_[0-9a-f]{16}$"

    static let fundIdPattern = "^fnd_[0-9a-f]{20}$"
    static let keyPattern = "^[A-Za-z0-9_-]{32}$"
    static let hashPattern = "^0x[0-9a-fA-F]{64}$"

    init?(url: URL, allowedHost: String) {
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

    func url(host: String) -> URL {
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

    static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }
}

// MARK: - API client

struct FundAPIError: Error, Decodable {
    let error: String
    let message: String
}

struct FundCreated: Decodable {
    let fundId: String
    let key: String
    let adminKey: String
}

/// Talks to `https://<host>/api/v1/funds`. It holds no credentials beyond the
/// fund key and, for the creator, the admin key; money only moves after members
/// approve with their passkeys on the Synq site.
struct FundClient {
    let host: String
    var session: URLSession = .shared

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

    func create(name: String) async throws -> FundCreated {
        try await send(request("/funds", method: "POST", body: ["name": name]), as: FundCreated.self)
    }

    func view(fundId: String, key: String) async throws -> FundView {
        var r = request("/funds/\(fundId)")
        var c = URLComponents(url: r.url!, resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "k", value: key)]
        r.url = c.url
        return try await send(r, as: FundView.self)
    }

    func launch(fundId: String, adminKey: String) async throws {
        struct Status: Decodable { let status: String }
        _ = try await send(request("/funds/\(fundId)/launch", method: "POST", body: ["adminKey": adminKey]), as: Status.self)
    }

    func ask(fundId: String, key: String, text: String) async throws -> AskReply {
        try await send(request("/funds/\(fundId)/ask", method: "POST", body: ["key": key, "text": text]),
                       as: AskReply.self)
    }

    /// Live provider searches can take most of a minute, so these wait longer.
    static let searchTimeout: TimeInterval = 100

    func startTrip(fundId: String, key: String, plan: FlightPlan) async throws -> TripView {
        try await send(request("/funds/\(fundId)/trips", method: "POST",
                               body: Self.tripBody(key: key, plan: plan), timeout: Self.searchTimeout),
                       as: TripView.self)
    }

    /// `returnDate` is sent only when present, so older servers see the same body as before.
    static func tripBody(key: String, plan: FlightPlan) -> [String: Any] {
        var body: [String: Any] = [
            "key": key, "origin": plan.origin, "destination": plan.destination,
            "departureDate": plan.departureDate, "travelers": plan.travelers,
        ]
        if let r = plan.returnDate { body["returnDate"] = r }
        return body
    }

    func startGift(fundId: String, key: String, query: String, maxPrice: String) async throws -> TripView {
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

    func trips(fundId: String, key: String, voter: String) async throws -> [TripView] {
        try await send(readRequest("/funds/\(fundId)/trips", key: key, voter: voter), as: TripList.self).trips
    }

    func trip(fundId: String, key: String, tripId: String, voter: String) async throws -> TripView {
        try await send(readRequest("/funds/\(fundId)/trips/\(tripId)", key: key, voter: voter), as: TripView.self)
    }

    func vote(fundId: String, key: String, tripId: String, voter: String, optionId: String) async throws -> TripView {
        try await send(request("/funds/\(fundId)/trips/\(tripId)/votes", method: "POST",
                               body: ["key": key, "voterId": voter, "optionId": optionId]), as: TripView.self)
    }

    func choose(fundId: String, key: String, tripId: String, optionId: String) async throws -> TripView {
        try await send(request("/funds/\(fundId)/trips/\(tripId)/choose", method: "POST",
                               body: ["key": key, "optionId": optionId]), as: TripView.self)
    }

    func requestTestFunds(fundId: String, key: String) async throws -> FundView {
        try await send(request("/funds/\(fundId)/test-funds", method: "POST", body: ["key": key]), as: FundView.self)
    }

    // Pages on the Synq site where the passkey ceremonies happen.

    func workspacePage() -> URL {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/workspaces"
        return c.url!
    }

    func fundPage(_ fundId: String, key: String) -> URL {
        FundLink.invite(fundId: fundId, key: key).url(host: host)
    }

    func sendPage(groupId: String, recipientId: String, amount: String) -> URL {
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

    func tripPaymentPage(groupId: String, payTo: TripPayTo, amount: String) -> URL {
        sendPage(groupId: groupId, recipientId: payTo.recipientId, amount: amount)
    }

    func approvalPage(_ intentHash: String) -> URL {
        URL(string: "https://\(host)/intents/\(intentHash)")!
    }
}

// MARK: - Funds this device knows about

struct FundRef: Codable, Equatable {
    let fundId: String
    let key: String
    var name: String
    /// Present only on the device that started the fund.
    var adminKey: String?
    var conversations: [String]
    var lastUsed: Date
    /// A flight typed on the Start screen, searched once the fund goes live.
    var pendingFlight: FlightPlan?
}

/// Local memory of which fund belongs to which conversation. The extension cannot
/// read the transcript, so it learns the link when someone starts a fund here or
/// taps one of its cards.
struct FundBook {
    var defaults: UserDefaults = .standard
    private let storageKey = "synq.funds.v1"

    func all() -> [FundRef] {
        guard let data = defaults.data(forKey: storageKey),
              let refs = try? JSONDecoder().decode([FundRef].self, from: data)
        else { return [] }
        return refs
    }

    private func save(_ refs: [FundRef]) {
        if let data = try? JSONEncoder().encode(refs) { defaults.set(data, forKey: storageKey) }
    }

    func fund(forConversation conversation: String) -> FundRef? {
        all().filter { $0.conversations.contains(conversation) }.max { $0.lastUsed < $1.lastUsed }
    }

    func ref(_ fundId: String) -> FundRef? { all().first { $0.fundId == fundId } }

    @discardableResult
    func remember(fundId: String, key: String, name: String?, adminKey: String? = nil, conversation: String?) -> FundRef {
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
    func setPendingFlight(_ plan: FlightPlan?, for fundId: String) -> FundRef? {
        var refs = all()
        guard let i = refs.firstIndex(where: { $0.fundId == fundId }) else { return nil }
        refs[i].pendingFlight = plan
        save(refs)
        return refs[i]
    }
}

/// One anonymous id per device for non-binding trip votes.
func deviceVoterId(_ defaults: UserDefaults = .standard) -> String {
    if let id = defaults.string(forKey: "synq.voter.v1") { return id }
    let id = UUID().uuidString.lowercased()
    defaults.set(id, forKey: "synq.voter.v1")
    return id
}

/// Decimal text a person typed, normalised to at most six places; nil when invalid.
func normalizedAmount(_ raw: String, max: Decimal) -> String? {
    let s = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
    guard s.range(of: "^[0-9]{1,6}(\\.[0-9]{1,6})?$", options: .regularExpression) != nil,
          let value = Decimal(string: s, locale: Locale(identifier: "en_US_POSIX")),
          value > 0, value <= max
    else { return nil }
    return s
}
