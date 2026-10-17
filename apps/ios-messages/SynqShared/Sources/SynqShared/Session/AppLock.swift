import Foundation
import LocalAuthentication

/// Optional App Lock: after the app has been in the background, Face ID (or the
/// passcode) is needed to see it again. It hides the screen; it is not a
/// session, not a sign-in and never an approval.
@MainActor
public final class AppLock: ObservableObject {
    static let key = "synq.app.lock.v1"
    private let defaults: UserDefaults
    private let authenticator: (String) async -> Bool
    private var backgroundedAt: Date?

    @Published public private(set) var isEnabled: Bool

    public init(defaults: UserDefaults = .standard, authenticator: ((String) async -> Bool)? = nil) {
        self.defaults = defaults
        isEnabled = defaults.bool(forKey: Self.key)
        self.authenticator = authenticator ?? AppLock.deviceOwnerAuthentication
    }

    /// Turning it on requires one successful check, so it cannot lock someone out.
    public func setEnabled(_ on: Bool) async {
        if on, !(await authenticator("Turn on App Lock")) { return }
        isEnabled = on
        defaults.set(on, forKey: Self.key)
    }

    func noteBackground(at date: Date = Date()) { backgroundedAt = date }

    func shouldLock() -> Bool {
        defer { backgroundedAt = nil }
        return isEnabled && backgroundedAt != nil
    }

    func authenticate(reason: String) async -> Bool { await authenticator(reason) }

    public static var biometryName: String {
        let c = LAContext()
        _ = c.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch c.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return "your passcode"
        }
    }

    static func deviceOwnerAuthentication(_ reason: String) async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
        return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
}
