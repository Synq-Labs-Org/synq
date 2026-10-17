import Foundation
import SynqContracts

/// A signed-in native session.
public enum NativeSession: Codable, Equatable, Sendable {
    /// v3 device session: 15-minute access token, rotating 30-day refresh token.
    case device(DeviceSession)
    /// The existing /v2 one-time-code session: a 15-minute bearer, no refresh.
    /// Used only while the server does not serve v3 device sessions yet.
    case legacy(token: String, principalId: String, expiresAt: Date)

    public var principalId: String {
        switch self {
        case .device(let s): return s.principalId
        case .legacy(_, let p, _): return p
        }
    }

    public var isLegacy: Bool { if case .legacy = self { return true } else { return false } }
}

/// Keeps the session and this install's device id in the Keychain. The device id
/// survives sign-out (it names this install to the server); everything else is
/// deleted by `clear()`.
public final class SessionStore: @unchecked Sendable {
    private let secrets: SecretStore
    /// The /v2 bearer lives where the existing workspace client reads it.
    private let host: String
    private let legacyEnabled: Bool
    private let lock = NSLock()

    static let sessionAccount = "session"
    static let deviceAccount = "device-id"

    public init(host: String, secrets: SecretStore? = nil) {
        self.host = host
        self.secrets = secrets ?? KeychainSecretStore(service: "synq.app.\(host)")
        legacyEnabled = secrets == nil
    }

    public var deviceId: String {
        lock.lock(); defer { lock.unlock() }
        if let data = secrets.read(Self.deviceAccount), let id = String(data: data, encoding: .utf8), !id.isEmpty { return id }
        let id = UUID().uuidString.lowercased()
        try? secrets.write(Data(id.utf8), Self.deviceAccount)
        return id
    }

    public func load(now: Date = Date()) -> NativeSession? {
        lock.lock(); defer { lock.unlock() }
        if let data = secrets.read(Self.sessionAccount),
           let session = try? JSONDecoder().decode(NativeSession.self, from: data) {
            if case .device(let d) = session, let refreshEnd = SynqTime.parse(d.refreshExpiresAt), refreshEnd <= now {
                return nil
            }
            return session
        }
        if legacyEnabled, let legacy = WorkspaceKeychain.load(host: host) {
            return .legacy(token: legacy.token, principalId: legacy.principalId,
                           expiresAt: Date(timeIntervalSince1970: legacy.expiresAt))
        }
        return nil
    }

    public func save(_ session: NativeSession) throws {
        lock.lock(); defer { lock.unlock() }
        switch session {
        case .device:
            try secrets.write(try JSONEncoder().encode(session), Self.sessionAccount)
            if legacyEnabled { WorkspaceKeychain.clear(host: host) }
        case .legacy(let token, let principal, let expires):
            if legacyEnabled {
                try WorkspaceKeychain.save(WorkspaceSession(token: token, principalId: principal,
                                                            expiresAt: expires.timeIntervalSince1970), host: host)
            } else {
                try secrets.write(try JSONEncoder().encode(session), Self.sessionAccount)
            }
        }
    }

    /// Deletes every token. The caller also drops every cached workspace record.
    public func clear() {
        lock.lock(); defer { lock.unlock() }
        secrets.delete(Self.sessionAccount)
        if legacyEnabled { WorkspaceKeychain.clear(host: host) }
    }
}

/// UTC ISO-8601 parsing for contract timestamps (with or without fractions).
public enum SynqTime {
    public static func parse(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    /// "Oct 17, 14:05" in the reader's time zone, or the raw string if unreadable.
    public static func short(_ s: String) -> String {
        guard let d = parse(s) else { return s }
        return d.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    /// "3 min ago" style, for freshness lines.
    public static func relative(_ s: String, now: Date = Date()) -> String {
        guard let d = parse(s) else { return s }
        return d.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}
