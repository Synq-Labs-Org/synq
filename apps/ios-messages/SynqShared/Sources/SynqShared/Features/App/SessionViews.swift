import SwiftUI
import SynqContracts

// First launch, sign-in (also shown when a session expired or was revoked),
// App Lock, and the account sheet. Sign-in proves who you are; it never
// approves a payment. Each screen says so where it matters.

struct OnboardingView: View {
    let onDone: () -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqScreen {
            VStack(alignment: .leading, spacing: theme.space.l) {
                SynqWordmarkBar(network: "Testnet")
                SynqHeroArt(slot: .home)
                SynqStack(spacing: \.m) {
                    Text("Your money, your circles and your business in one place.").synqType(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    SynqGroup {
                        SynqRow(icon: .people, title: "Personal", subtitle: "Circles you belong to, contributions and refunds", trailing: .none)
                        SynqRow(icon: .bank, title: "Business", subtitle: "Enquiries, deals, agent activity and money", trailing: .none, divider: true)
                        SynqRow(icon: .passkey, title: "You approve", subtitle: "Your wallet signs each payment on its exact terms. Sign-in and Face ID never approve.", trailing: .none, divider: true)
                    }
                    SynqNote(text: "Synq runs on test networks. Amounts are test tokens, not real money.")
                    SynqButton(title: "Continue", trailingIcon: .forward, kind: .primary, action: onDone)
                }
            }
            .padding(.vertical, theme.space.m)
            .synqScroll()
        }
    }
}

struct SignInView: View {
    @ObservedObject var model: SynqAppModel
    let reason: SynqAppModel.SignedOutReason
    @State private var code = ""
    @Environment(\.synqTheme) private var theme

    private var headline: String {
        switch reason {
        case .fresh: return "Sign in"
        case .signedOut: return "Signed out"
        case .expired: return "Sign in again"
        case .revoked: return "This session was ended"
        }
    }

    private var explanation: String {
        switch reason {
        case .fresh: return "Sign in with your wallet, or with a one-time code from the Synq page on a computer where you are signed in."
        case .signedOut: return "You signed out. Nothing from your workspaces is kept on this iPhone."
        case .expired: return "Your session ended. What this iPhone had loaded was cleared. Sign in again to continue."
        case .revoked: return "This device was signed out from another device or by the server. Everything loaded here was cleared."
        }
    }

    var body: some View {
        SynqScreen {
            VStack(alignment: .leading, spacing: theme.space.l) {
                SynqWordmarkBar(network: "Testnet")
                SynqHeroArt(slot: .risk)
                SynqStack(spacing: \.m) {
                    Text(headline).synqType(.headline).accessibilityAddTraits(.isHeader)
                    Text(explanation).synqType(.body, .secondary).fixedSize(horizontal: false, vertical: true)
                    SynqPanel(label: "One-time code") {
                        Text("On the Synq page choose \"Sign in on iPhone\", then paste the code here. It works once, for two minutes.")
                            .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
                        SynqPrivateCodeField(text: $code)
                        SynqButton(title: model.busy ? "Signing in…" : "Sign in with code", icon: .passkey, kind: .primary,
                                   busy: model.busy) {
                            let c = code
                            code = ""
                            model.signIn(code: c)
                        }
                        .disabled(model.busy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        SynqButton(title: "Open the Synq page", trailingIcon: .external, kind: .compact) {
                            if let url = URL(string: "https://\(model.host)/workspaces") { model.links.openSecurely(url) }
                        }
                    }
                    SynqPanel(label: "Wallet") {
                        let cap = model.walletLogin.availability
                        HStack(alignment: .top) {
                            Text("Sign in with your wallet").synqType(.bodyStrong)
                            Spacer()
                            SynqBadge(kind: cap.isUsable ? .live : .neutral, text: cap.status.label)
                        }
                        Text(cap.isUsable ? "Your wallet signs a sign-in message that names this app. It cannot move money."
                                          : cap.reason)
                            .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
                        SynqButton(title: "Sign in with wallet", icon: .passkey, busy: model.busy, action: model.signInWithWallet)
                            .disabled(!cap.isUsable || model.busy)
                    }
                    if let e = model.signInError { SynqNote(text: e, error: true) }
                    if model.pendingDestination != nil {
                        SynqNote(text: "A Synq link is waiting. It opens after you sign in, if your account can see it.")
                    }
                    SynqNote(text: "Signing in never approves a payment. Approvals are signed by your wallet on the exact terms.")
                }
            }
            .padding(.vertical, theme.space.m)
            .synqScroll()
        }
    }
}

struct LockedView: View {
    @ObservedObject var model: SynqAppModel
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqScreen {
            VStack(spacing: theme.space.l) {
                Spacer()
                SynqIconView(icon: .shield, size: 40, ink: .secondary)
                Text("Synq is locked").synqType(.headline).accessibilityAddTraits(.isHeader)
                Text("Unlocking shows the app again. It does not approve or sign anything.")
                    .synqType(.caption, .secondary).multilineTextAlignment(.center)
                SynqButton(title: "Unlock with \(AppLock.biometryName)", icon: .passkey, kind: .primary) {
                    Task { await model.unlock() }
                }
                .padding(.horizontal, theme.space.xxl)
                Spacer()
            }
            .padding(theme.space.gutter)
        }
        .task { await model.unlock() }
    }
}

struct AccountSheet: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @ObservedObject private var lock: AppLock
    @ObservedObject private var push: PushCenter
    @State private var confirmRevoke = false
    @State private var choosingTheme = false
    @Environment(\.synqTheme) private var theme

    init(model: SynqAppModel, scope: ContextScope) {
        self.model = model
        self.scope = scope
        _lock = ObservedObject(wrappedValue: model.lock)
        _push = ObservedObject(wrappedValue: model.push)
    }

    private var pushLine: String {
        switch push.status {
        case .off: return push.optedIn ? "On for this iPhone" : "Off. Alerts show only the kind of event, never names or amounts."
        case .asking: return "Asking iOS…"
        case .registered: return "On. Alerts show only the kind of event, never names or amounts."
        case .serverNotReady: return "Allowed on this iPhone, but this Synq server cannot send notifications yet."
        case .denied: return "Turned off in iOS Settings."
        case .failed(let m): return m
        }
    }

    var body: some View {
        SheetScaffold(title: "Account", onCancel: { model.sheet = nil }) {
            SynqStack(spacing: \.m) {
                SynqPanel(label: "Signed in") {
                    if let hint = model.walletHint { SynqKeyValue("Wallet", hint, mono: true) }
                    if let p = model.principalId { SynqKeyValue("Account", shortId(p), mono: true) }
                    SynqKeyValue("Session", model.sessionIsLegacy ? "15-minute code session" : "Device session, renews while you use it")
                    SynqKeyValue("This iPhone", shortId(model.api.store.deviceId), mono: true)
                }
                SynqSectionLabel(text: "Devices signed in")
                RemoteSection(remote: scope.sessions, what: "your signed-in devices") { list in
                    SynqGroup {
                        ForEach(Array(list.sessions.enumerated()), id: \.element.sessionId) { i, s in
                            SynqRow(icon: s.platform == .ios ? .people : .external, title: s.deviceName,
                                    subtitle: "Last seen \(SynqTime.short(s.lastSeenAt))",
                                    trailing: s.current ? .badge(.approved, "This device") : .none, divider: i > 0)
                        }
                    }
                }
                SynqSectionLabel(text: "Security")
                SynqGroup {
                    SynqRow(icon: .shield, title: lock.isEnabled ? "App Lock is on" : "App Lock is off",
                            subtitle: "Ask for \(AppLock.biometryName) when you come back to Synq. It only hides the app; it never approves.",
                            trailing: .text(lock.isEnabled ? "Turn off" : "Turn on")) {
                        Task { await lock.setEnabled(!lock.isEnabled) }
                    }
                    SynqRow(icon: .bell, title: "Notifications", subtitle: pushLine,
                            trailing: .text(push.optedIn ? "Turn off" : "Turn on"), divider: true) {
                        Task { if push.optedIn { await push.disable() } else { await push.enable() } }
                    }
                    SynqRow(icon: .theme, title: "Theme", subtitle: SynqThemes.current.name, trailing: .chevron, divider: true) {
                        choosingTheme = true
                    }
                }
                SynqButton(title: model.busy ? "Signing out…" : "Sign out of this iPhone", icon: .close, busy: model.busy,
                           action: model.signOut)
                    .disabled(model.busy)
                if confirmRevoke {
                    SynqPanel(label: "Sign out everywhere") {
                        Text("Every device signed in to this account, including this one, is signed out. You sign in again on each.")
                            .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
                        SynqButton(title: "Sign out every device", icon: .warning, kind: .primary, busy: model.busy,
                                   action: model.revokeAll)
                        SynqButton(title: "Keep them signed in", kind: .compact) { confirmRevoke = false }
                    }
                } else {
                    SynqButton(title: "Sign out every device…", kind: .compact) { confirmRevoke = true }
                }
                if let n = model.notice { SynqNote(text: n, error: true) }
                SynqNote(text: "Signing out deletes this iPhone's session and everything it loaded, and clears Synq notifications from the lock screen.")
            }
        }
        .sheet(isPresented: $choosingTheme) { ThemeSheet { choosingTheme = false } }
    }
}
