import SafariServices
import SwiftUI
import SynqShared
import UIKit
import UserNotifications

/// The full-screen Synq app. Everything it shows lives in SynqShared; this
/// target only starts it, connects the platform (Safari, notifications) and
/// embeds the Messages extension.
@main
struct SynqApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            SynqAppRoot(model: delegate.model)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model: SynqAppModel

    override init() {
        SynqFonts.register()
        // The app's own default look; the Messages extension keeps its own choice.
        SynqThemes.defaultId = "paper"
        let host = SynqConfig.fromBundle().webHost
        // The person's own wallet through WalletConnect, when this build has a project id.
        let wallet = WalletConnectSigner(projectId: Bundle.main.object(forInfoDictionaryKey: "ReownProjectId") as? String,
                                         host: host)
        model = SynqAppModel(host: host, links: SafariLinks(host: host), wallet: wallet, walletLogin: wallet,
                             privacy: SystemNotifications(), deviceName: UIDevice.current.model)
        super.init()
    }

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        model.push.requestRegistration = { application.registerForRemoteNotifications() }
        return true
    }

    // MARK: Push (registration only after the person turns notifications on)

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        model.push.didRegister(token: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        model.push.didFailToRegister(error.localizedDescription)
    }

    /// A tap on a notification only navigates; the destination loads after the
    /// session and membership checks, and nothing is approved by the tap.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        await MainActor.run { model.push.didOpen(userInfo: info) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list]
    }
}

/// Opens Synq pages (passkey and wallet ceremonies) in Safari's in-app browser.
@MainActor
final class SafariLinks: DeepLinkPort {
    let host: String
    init(host: String) { self.host = host }

    func openSecurely(_ url: URL) {
        guard url.scheme == "https" else { return }
        guard let top = Self.topController() else {
            UIApplication.shared.open(url)
            return
        }
        top.present(SafariSheet.controller(url), animated: true)
    }

    static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var top = scene?.keyWindow?.rootViewController
        while let next = top?.presentedViewController { top = next }
        return top
    }
}

/// Clears Synq notifications from the lock screen and the badge when a session ends.
@MainActor
final class SystemNotifications: SystemPrivacyPort {
    func clearDeliveredNotifications() {
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
        center.setBadgeCount(0)
    }
}

enum SafariSheet {
    static func controller(_ url: URL) -> UIViewController {
        let c = SFSafariViewController(url: url)
        c.dismissButtonStyle = .done
        c.modalPresentationStyle = .pageSheet
        return c
    }
}
