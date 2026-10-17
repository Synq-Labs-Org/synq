import Foundation
@testable import SynqShared

/// A tiny in-process HTTP stub for the v3 client (URLProtocol). Each test makes
/// its own server; responses are synthetic test data.
final class StubServer: @unchecked Sendable {
    struct Response {
        var status: Int
        var json: String
    }

    typealias Handler = (URLRequest) -> Response?
    private let lock = NSLock()
    private var handlers: [String: Handler] = [:]
    private(set) var requests: [URLRequest] = []
    let id = UUID().uuidString
    /// Requests are routed to this server by host.
    var host: String { "s\(id.prefix(8).lowercased()).synq.test" }

    static var servers: [String: StubServer] = [:]
    static let registry = NSLock()

    init() {
        Self.registry.lock()
        Self.servers[host] = self
        Self.registry.unlock()
    }

    /// `"GET /api/v3/meta"` → handler.
    func on(_ key: String, _ handler: @escaping Handler) {
        lock.lock(); handlers[key] = handler; lock.unlock()
    }

    func on(_ key: String, status: Int = 200, json: String) {
        on(key) { _ in Response(status: status, json: json) }
    }

    func count(_ key: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return requests.filter { "\($0.httpMethod ?? "GET") \($0.url?.path ?? "")" == key }.count
    }

    var paths: [String] {
        lock.lock(); defer { lock.unlock() }
        return requests.map { "\($0.httpMethod ?? "GET") \($0.url?.path ?? "")" }
    }

    func respond(_ r: URLRequest) -> Response {
        lock.lock()
        requests.append(r)
        let h = handlers["\(r.httpMethod ?? "GET") \(r.url?.path ?? "")"]
        lock.unlock()
        return h?(r) ?? Response(status: 404, json: #"{"error":"NOT_FOUND","message":"not found"}"#)
    }

    var session: URLSession {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: c)
    }

    /// Meta listing the given routes as implemented.
    func meta(_ live: [String]) {
        let routes = live.map { #"{"id":"\#($0)","status":"IMPLEMENTED"}"# }.joined(separator: ",")
        on("GET /api/v3/meta", json: #"{"contractVersion":"3.0.0","routes":[\#(routes)]}"#)
    }

    static func iso(_ offset: TimeInterval) -> String {
        let f = ISO8601DateFormatter()
        return f.string(from: Date().addingTimeInterval(offset))
    }

    static func deviceSession(access: String, refresh: String, principal: String = "p1",
                              accessIn: TimeInterval = 900) -> String {
        #"{"principalId":"\#(principal)","sessionId":"s1","accessToken":"\#(access)","accessExpiresAt":"\#(iso(accessIn))","refreshToken":"\#(refresh)","refreshExpiresAt":"\#(iso(86_400))"}"#
    }
}

final class StubProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var r = request
        // URLProtocol strips the body into a stream; read it back for handlers.
        if r.httpBody == nil, let stream = r.httpBodyStream {
            stream.open()
            var data = Data()
            let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(buf, maxLength: 4096)
                if n <= 0 { break }
                data.append(buf, count: n)
            }
            buf.deallocate()
            stream.close()
            r.httpBody = data
        }
        let id = r.url?.host ?? ""
        StubServer.registry.lock()
        let server = StubServer.servers[id]
        StubServer.registry.unlock()
        let response = server?.respond(r) ?? .init(status: 500, json: "{}")
        let http = HTTPURLResponse(url: r.url!, statusCode: response.status, httpVersion: "HTTP/1.1",
                                   headerFields: ["content-type": "application/json"])!
        client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(response.json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
