import Foundation

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

// MARK: - Links carried in MSMessage.url

/// `https://<host>/fund/<fundId>#k=<key>` (invite) or
/// `https://<host>/fund/<fundId>/p/<intentHash>#k=<key>` (payment).
/// The key sits in the fragment so browsers never send it to the server.
enum FundLink: Equatable {
    case invite(fundId: String, key: String)
    case proposal(fundId: String, key: String, intentHash: String)

    var fundId: String {
        switch self {
        case .invite(let id, _), .proposal(let id, _, _): return id
        }
    }

    var key: String {
        switch self {
        case .invite(_, let k), .proposal(_, let k, _): return k
        }
    }

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

    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) -> URLRequest {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/api/v1\(path)"
        var r = URLRequest(url: c.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
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

    func requestTestFunds(fundId: String, key: String) async throws -> FundView {
        try await send(request("/funds/\(fundId)/test-funds", method: "POST", body: ["key": key]), as: FundView.self)
    }

    // Pages on the Synq site where the passkey ceremonies happen.

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
