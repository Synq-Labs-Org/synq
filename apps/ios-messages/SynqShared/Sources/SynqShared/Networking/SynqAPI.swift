import Foundation
import SynqContracts

// The native client for the frozen v3 contract (API_CONTRACT_v3.md). Every
// route is looked up in `Route.all`; a route is called only once `GET /v3/meta`
// says the server implements it, so the app shows "not available yet" instead
// of guessing. Errors follow the contract: 401 refreshes once then signs out,
// 404 is "not found" (also for another tenant's ids), 409 refetch, 422 policy,
// 429 back off, 503 integration unavailable.

public enum APIFailure: Error, Equatable, Sendable {
    /// The server does not implement this route yet (or has no v3 at all).
    case notAvailable(routeId: String)
    case signedOut
    /// Refresh failed; `revoked` when the server says the session was revoked.
    case sessionEnded(revoked: Bool)
    case forbidden(String)
    case notFound
    case conflict(String)
    case policyBlocked(String)
    case rateLimited
    case unavailable(String)
    case offline
    case server(String)
    case unreadable

    public var message: String {
        switch self {
        case .notAvailable: return "Not available on this Synq server yet."
        case .signedOut: return "Sign in to see this."
        case .sessionEnded(let revoked):
            return revoked ? "This session was signed out from another device. Sign in again."
                           : "Your session ended. Sign in again."
        case .forbidden(let m): return m.isEmpty ? "You do not have access to this." : m
        case .notFound: return "Not found, or you do not have access to it."
        case .conflict(let m): return m.isEmpty ? "This changed in the meantime. Refreshed; check and try again." : m
        case .policyBlocked(let m): return m
        case .rateLimited: return "Too many requests. Try again in a moment."
        case .unavailable(let m): return m.isEmpty ? "This integration is unavailable right now." : m
        case .offline: return "You're offline. Showing what was last synced."
        case .server(let m): return m.isEmpty ? "Synq could not do that right now." : m
        case .unreadable: return "Synq sent a reply this version cannot read."
        }
    }
}

/// Whether a route can be called on the connected server.
public enum RouteAvailability: Equatable, Sendable {
    case live
    case notYet
    /// /v3/meta could not be read (offline or server error).
    case unknown
}

/// Reads `GET /v3/meta` and answers which routes are implemented.
public actor MetaCache {
    private let fetch: @Sendable () async throws -> Meta?
    private var routes: [String: MetaRoute.Status]?
    private var fetchedAt: Date?
    private var failed = false
    private let maxAge: TimeInterval

    public init(maxAge: TimeInterval = 300, fetch: @escaping @Sendable () async throws -> Meta?) {
        self.maxAge = maxAge
        self.fetch = fetch
    }

    public func availability(_ routeId: String) async -> RouteAvailability {
        await refreshIfNeeded()
        guard let routes else { return failed ? .unknown : .notYet }
        return routes[routeId] == .implemented ? .live : .notYet
    }

    public func refresh() async {
        fetchedAt = nil
        await refreshIfNeeded()
    }

    public var snapshot: [String: MetaRoute.Status]? { routes }

    private func refreshIfNeeded() async {
        if let fetchedAt, Date().timeIntervalSince(fetchedAt) < maxAge { return }
        do {
            if let meta = try await fetch() {
                routes = Dictionary(meta.routes.map { ($0.id, $0.status) }, uniquingKeysWith: { a, _ in a })
            } else {
                routes = [:]  // the server has no v3: every route is "not yet"
            }
            failed = false
            fetchedAt = Date()
        } catch {
            failed = true
        }
    }
}

/// What the session layer tells the app when a session dies.
public enum SessionEvent: Equatable, Sendable {
    case refreshed
    case ended(revoked: Bool)
}

/// Owns the access token: refreshes before expiry or after a 401, one refresh at
/// a time, and rotates the stored refresh token. A failed refresh wipes the
/// session; the app then wipes every cached workspace record.
public actor SessionManager {
    private let store: SessionStore
    private let refresher: @Sendable (RefreshRequest) async throws -> DeviceSession
    private var refreshing: Task<DeviceSession, Error>?
    private var onEvent: (@Sendable (SessionEvent) -> Void)?
    private let now: @Sendable () -> Date

    public init(store: SessionStore, now: @escaping @Sendable () -> Date = { Date() },
                refresher: @escaping @Sendable (RefreshRequest) async throws -> DeviceSession) {
        self.store = store
        self.refresher = refresher
        self.now = now
    }

    public func setEventHandler(_ handler: @escaping @Sendable (SessionEvent) -> Void) {
        onEvent = handler
    }

    /// A usable bearer token, refreshing a device session that expires within a minute.
    public func accessToken() async throws -> String {
        guard let session = store.load(now: now()) else { throw APIFailure.signedOut }
        switch session {
        case .legacy(let token, _, let expires):
            guard expires > now() else {
                store.clear()
                onEvent?(.ended(revoked: false))
                throw APIFailure.sessionEnded(revoked: false)
            }
            return token
        case .device(let d):
            if let expires = SynqTime.parse(d.accessExpiresAt), expires.timeIntervalSince(now()) > 60 {
                return d.accessToken
            }
            return try await refresh(from: d).accessToken
        }
    }

    /// After a 401: refresh once (device sessions); a legacy session simply ends.
    public func recoverFromUnauthorized(usedToken: String) async throws -> String {
        guard let session = store.load(now: now()) else { throw APIFailure.signedOut }
        switch session {
        case .legacy:
            store.clear()
            onEvent?(.ended(revoked: false))
            throw APIFailure.sessionEnded(revoked: false)
        case .device(let d):
            // Another call may already have rotated the token.
            if d.accessToken != usedToken, let e = SynqTime.parse(d.accessExpiresAt), e > now() { return d.accessToken }
            return try await refresh(from: d).accessToken
        }
    }

    private func refresh(from d: DeviceSession) async throws -> DeviceSession {
        if let refreshing { return try await refreshing.value }
        let request = RefreshRequest(deviceId: store.deviceId, refreshToken: d.refreshToken)
        let task = Task { try await refresher(request) }
        refreshing = task
        defer { refreshing = nil }
        do {
            let next = try await task.value
            try store.save(.device(next))
            onEvent?(.refreshed)
            return next
        } catch let failure as APIFailure {
            switch failure {
            case .offline, .rateLimited, .unavailable, .server:
                throw failure  // keep the session; try again later
            case .sessionEnded(let revoked):
                store.clear()
                onEvent?(.ended(revoked: revoked))
                throw failure
            default:
                store.clear()
                onEvent?(.ended(revoked: false))
                throw APIFailure.sessionEnded(revoked: false)
            }
        }
    }

    public func signOutLocally() {
        refreshing?.cancel()
        refreshing = nil
        store.clear()
    }
}

/// The v3 client. URLs are `https://<host>/api` + the route path.
public final class SynqAPI: @unchecked Sendable {
    public let host: String
    public let store: SessionStore
    public let sessions: SessionManager
    public let meta: MetaCache
    let transport: URLSession

    public init(host: String, store: SessionStore? = nil, transport: URLSession? = nil) {
        self.host = host
        let store = store ?? SessionStore(host: host)
        self.store = store
        // Ephemeral: no URL cache, cookies or credentials on disk.
        let transport = transport ?? URLSession(configuration: .ephemeral)
        self.transport = transport
        let base = Self.baseURL(host)
        sessions = SessionManager(store: store) { request in
            try await SynqAPI.unauthenticated(transport, base: base, route: "auth.refresh", body: request, as: DeviceSession.self)
        }
        meta = MetaCache {
            do {
                return try await SynqAPI.unauthenticated(transport, base: base, route: "meta", body: Optional<Ok>.none, as: Meta.self)
            } catch APIFailure.notFound {
                return nil
            }
        }
    }

    static func baseURL(_ host: String) -> URL {
        var c = URLComponents()
        c.scheme = "https"
        c.host = host
        c.path = "/api"
        return c.url ?? URL(string: "https://invalid.invalid/api")!
    }

    /// Fills `{name}` segments; values are percent-encoded and may not contain `/`.
    static func path(_ template: String, _ params: [String: String]) throws -> String {
        var out = template
        for (k, v) in params {
            guard !v.isEmpty, !v.contains("/"),
                  let enc = v.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { throw APIFailure.notFound }
            out = out.replacingOccurrences(of: "{\(k)}", with: enc)
        }
        guard !out.contains("{") else { throw APIFailure.notFound }
        return out
    }

    static func request(base: URL, route: Route, params: [String: String], query: [URLQueryItem],
                        body: Data?, token: String?, idempotencyKey: String?) throws -> URLRequest {
        var c = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        c.path = base.path + (try path(route.path, params))
        if !query.isEmpty { c.queryItems = query }
        guard let url = c.url else { throw APIFailure.notFound }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        r.httpMethod = route.method
        r.setValue("application/json", forHTTPHeaderField: "accept")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if route.mutation { r.setValue(idempotencyKey ?? UUID().uuidString, forHTTPHeaderField: "idempotency-key") }
        return r
    }

    /// Maps a non-2xx response to the contract's error meaning.
    static func failure(status: Int, data: Data) -> APIFailure {
        let e = try? JSONDecoder().decode(ApiError.self, from: data)
        let m = e?.message ?? ""
        switch status {
        case 401:
            let code = e?.error ?? ""
            return .sessionEnded(revoked: code.contains("REVOKED") || code.contains("REUSE"))
        case 403:
            if e?.error == "CONTEXT_REVOKED" { return .sessionEnded(revoked: true) }
            return .forbidden(m)
        case 404: return .notFound
        case 409: return .conflict(m)
        case 422: return .policyBlocked(m.isEmpty ? "Blocked by policy." : m)
        case 429: return .rateLimited
        case 503: return .unavailable(m)
        default: return .server(m)
        }
    }

    static func send(_ transport: URLSession, _ r: URLRequest) async throws -> (Data, Int) {
        do {
            let (data, response) = try await transport.data(for: r)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch let e as URLError where [.notConnectedToInternet, .networkConnectionLost, .timedOut,
                                         .cannotFindHost, .cannotConnectToHost, .dataNotAllowed].contains(e.code) {
            throw APIFailure.offline
        } catch is CancellationError {
            throw CancellationError()
        } catch let e as URLError where e.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIFailure.offline
        }
    }

    static func unauthenticated<B: Encodable, T: Decodable>(_ transport: URLSession, base: URL, route id: String,
                                                           body: B?, as: T.Type) async throws -> T {
        guard let route = Route.named(id) else { throw APIFailure.notAvailable(routeId: id) }
        let data = try body.map { try JSONEncoder().encode($0) }
        let r = try request(base: base, route: route, params: [:], query: [], body: data, token: nil, idempotencyKey: nil)
        let (bytes, status) = try await send(transport, r)
        guard (200..<300).contains(status) else { throw failure(status: status, data: bytes) }
        do { return try JSONDecoder().decode(T.self, from: bytes) } catch { throw APIFailure.unreadable }
    }

    // MARK: Calls

    public func availability(_ routeId: String) async -> RouteAvailability {
        await meta.availability(routeId)
    }

    /// Calls a route and returns the raw body (used where bytes must reach a
    /// wallet unmodified). Session routes refresh once after a 401.
    public func data(_ routeId: String, params: [String: String] = [:], query: [URLQueryItem] = [],
                     body: Data? = nil, idempotencyKey: String? = nil, authenticated: Bool = true) async throws -> Data {
        guard let route = Route.named(routeId) else { throw APIFailure.notAvailable(routeId: routeId) }
        guard await meta.availability(routeId) == .live else { throw APIFailure.notAvailable(routeId: routeId) }
        let base = Self.baseURL(host)
        var token = authenticated ? try await sessions.accessToken() : nil
        let key = idempotencyKey ?? (route.mutation ? UUID().uuidString : nil)
        for attempt in 0..<2 {
            try Task.checkCancellation()
            let r = try Self.request(base: base, route: route, params: params, query: query, body: body,
                                     token: token, idempotencyKey: key)
            let (bytes, status) = try await Self.send(transport, r)
            if (200..<300).contains(status) { return bytes }
            if status == 401, authenticated, attempt == 0, let used = token {
                token = try await sessions.recoverFromUnauthorized(usedToken: used)
                continue
            }
            let f = Self.failure(status: status, data: bytes)
            if case .sessionEnded(let revoked) = f, authenticated {
                await sessions.signOutLocally()
                throw APIFailure.sessionEnded(revoked: revoked)
            }
            throw f
        }
        throw APIFailure.sessionEnded(revoked: false)
    }

    public func call<T: Decodable>(_ routeId: String, params: [String: String] = [:], query: [URLQueryItem] = [],
                                   idempotencyKey: String? = nil, as type: T.Type) async throws -> T {
        let bytes = try await data(routeId, params: params, query: query, idempotencyKey: idempotencyKey)
        do { return try JSONDecoder().decode(T.self, from: bytes) } catch { throw APIFailure.unreadable }
    }

    public func call<B: Encodable, T: Decodable>(_ routeId: String, params: [String: String] = [:], body: B,
                                                 idempotencyKey: String? = nil, authenticated: Bool = true,
                                                 as type: T.Type) async throws -> T {
        let encoded = try JSONEncoder().encode(body)
        let bytes = try await data(routeId, params: params, body: encoded, idempotencyKey: idempotencyKey,
                                   authenticated: authenticated)
        do { return try JSONDecoder().decode(T.self, from: bytes) } catch { throw APIFailure.unreadable }
    }
}
