import Foundation
import SynqContracts
import UserNotifications

/// APNs on the app side. Registration happens only after the person turns
/// notifications on, and only reaches the server when `POST /v3/devices` is live.
/// A push carries a generic category, an opaque event id and a path; its tap
/// only navigates, and the destination loads after the session and membership
/// checks. The token is held in memory; it is never a credential.
@MainActor
public final class PushCenter: ObservableObject {
    public enum Status: Equatable {
        case off
        case asking
        case registered
        /// The person said yes but this server cannot register devices yet.
        case serverNotReady
        case denied
        case failed(String)
    }

    @Published public private(set) var status: Status = .off
    /// Set by the app host: asks the system for an APNs token.
    public var requestRegistration: (() -> Void)?
    weak var app: SynqAppModel?
    private let defaults: UserDefaults
    private var token: String?
    private var registrationKey = UUID().uuidString
    static let optInKey = "synq.app.push.v1"

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public var optedIn: Bool { defaults.bool(forKey: Self.optInKey) }

    /// From the account screen only.
    public func enable() async {
        status = .asking
        let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])) ?? false
        guard granted else {
            status = .denied
            return
        }
        defaults.set(true, forKey: Self.optInKey)
        requestRegistration?()
    }

    /// Re-registers on launch when the person opted in earlier (tokens can change).
    func resume() {
        if optedIn { requestRegistration?() }
    }

    public func disable() async {
        defaults.set(false, forKey: Self.optInKey)
        await unregisterOnServer()
        status = .off
    }

    public func didRegister(token data: Data) {
        token = data.map { String(format: "%02x", $0) }.joined()
        Task { await register() }
    }

    public func didFailToRegister(_ message: String) {
        status = .failed("Notifications could not be set up: \(message)")
    }

    func register() async {
        guard let app, let token, app.api.store.load() != nil else { return }
        guard await app.api.availability("devices.register") == .live else {
            status = .serverNotReady
            return
        }
        #if DEBUG
        let environment = DeviceRegistration.Environment.sandbox
        #else
        let environment = DeviceRegistration.Environment.production
        #endif
        let body = DeviceRegistration(deviceId: app.api.store.deviceId, apnsToken: token, environment: environment,
                                      locale: Locale.current.identifier, mutedCategories: [], quietHours: nil)
        do {
            _ = try await app.api.call("devices.register", body: body, idempotencyKey: registrationKey, as: DeviceRegistered.self)
            status = .registered
        } catch let f as APIFailure {
            status = .failed(f.message)
        } catch {
            status = .failed("Notifications could not be set up.")
        }
    }

    /// Before sign-out: the server stops sending to this device.
    func unregisterOnServer() async {
        guard let app, app.api.store.load() != nil,
              await app.api.availability("devices.revoke") == .live else { return }
        _ = try? await app.api.call("devices.revoke", params: ["deviceId": app.api.store.deviceId], body: Ok(ok: true), as: Ok.self)
        token = nil
        registrationKey = UUID().uuidString
    }

    /// A notification tap. Only a path on the Synq host is followed.
    public func didOpen(userInfo: [AnyHashable: Any]) {
        guard let app, let path = Self.path(from: userInfo),
              let url = URL(string: "https://\(app.host)\(path)") else { return }
        app.open(url: url)
    }

    /// `link` must be a site-relative path (no scheme, host or `//`).
    nonisolated static func path(from userInfo: [AnyHashable: Any]) -> String? {
        guard let link = userInfo["link"] as? String, link.hasPrefix("/"), !link.hasPrefix("//"),
              !link.contains("://"), link.count <= 512 else { return nil }
        return link
    }
}
