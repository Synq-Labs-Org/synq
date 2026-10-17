import Foundation
import SwiftUI
import SynqContracts

// The full-screen app's coordinator: which state the app is in (launching,
// onboarding, signed out / re-authenticate / revoked, locked, ready in a
// Personal or Business context, offline overlay), which context is active, and
// navigation. Everything read for a context lives in its `ContextScope`;
// switching context or signing out drops the scope, so no record of the previous
// workspace survives in memory, and nothing is cached on disk.

public enum AppTab: String, CaseIterable, Identifiable, Sendable {
    case home, circles, activity, money, approvals
    case inbox, deals, agents, finance
    public var id: String { rawValue }

    public static func tabs(for kind: WorkspaceContext.Kind) -> [AppTab] {
        switch kind {
        case .personal: return [.home, .circles, .activity, .money, .approvals]
        case .business: return [.home, .inbox, .deals, .agents, .finance]
        }
    }

    public var title: String {
        switch self {
        case .home: return "Home"
        case .circles: return "Circles"
        case .activity: return "Activity"
        case .money: return "Money"
        case .approvals: return "Approvals"
        case .inbox: return "Inbox"
        case .deals: return "Deals"
        case .agents: return "Agents"
        case .finance: return "Money"
        }
    }

    public var icon: SynqIcon {
        switch self {
        case .home: return .home
        case .circles: return .people
        case .activity: return .clock
        case .money, .finance: return .money
        case .approvals: return .passkey
        case .inbox: return .invite
        case .deals: return .deal
        case .agents: return .team
        }
    }
}

public enum AppSheet: Identifiable, Equatable {
    case account
    case contexts
    case notifications
    case approval(requestId: String)

    public var id: String {
        switch self {
        case .account: return "account"
        case .contexts: return "contexts"
        case .notifications: return "notifications"
        case .approval(let r): return "approval:\(r)"
        }
    }
}

/// Clears what the system holds for the app (delivered notifications, badge)
/// when the session ends. The app host supplies it; elsewhere it does nothing.
@MainActor
public protocol SystemPrivacyPort: AnyObject {
    func clearDeliveredNotifications()
}

@MainActor
public final class NoSystemPrivacy: SystemPrivacyPort {
    public init() {}
    public func clearDeliveredNotifications() {}
}

@MainActor
public final class SynqAppModel: ObservableObject, NavigationPort {
    public enum SignedOutReason: Equatable, Sendable {
        case fresh, signedOut, expired, revoked
    }

    public enum Phase: Equatable, Sendable {
        case launching
        case onboarding
        case signedOut(SignedOutReason)
        case locked
        case ready
    }

    /// The eight named states of the coordinator (offline is an overlay on any of them).
    public var stateName: String {
        switch phase {
        case .launching: return "launching"
        case .onboarding: return "onboarding"
        case .signedOut(.expired): return "reauth"
        case .signedOut(.revoked): return "revoked"
        case .signedOut: return "signedOut"
        case .locked: return "locked"
        case .ready: return scope?.context.isBusiness == true ? "business" : "personal"
        }
    }

    @Published public private(set) var phase: Phase = .launching
    @Published public private(set) var contexts: [WorkspaceContext] = []
    @Published public private(set) var scope: ContextScope?
    @Published public private(set) var walletHint: String?
    @Published public private(set) var sessionIsLegacy = false
    @Published public var tab: AppTab = .home
    @Published public var paths: [AppTab: [SynqDestination]] = [:]
    @Published public var sheet: AppSheet?
    @Published public var offline = false
    @Published public var notice: String?
    @Published public private(set) var busy = false
    @Published public private(set) var signInError: String?
    @Published public private(set) var contextsError: String?
    /// A link opened before sign-in; followed once signed in and only if allowed.
    @Published public private(set) var pendingDestination: SynqDestination?

    public let api: SynqAPI
    public let links: DeepLinkPort
    public let wallet: WalletApprovalPort
    public let walletLogin: WalletLoginPort
    public let privacy: SystemPrivacyPort
    public let lock: AppLock
    public let push: PushCenter
    let defaults: UserDefaults
    /// Funds opened on this iPhone from fund links (the app's own list).
    public let funds: FundBook
    public let deviceName: String

    static let onboardedKey = "synq.app.onboarded.v1"

    public init(host: String, api: SynqAPI? = nil, links: DeepLinkPort? = nil,
                wallet: WalletApprovalPort? = nil, walletLogin: WalletLoginPort? = nil,
                privacy: SystemPrivacyPort? = nil, lock: AppLock? = nil,
                defaults: UserDefaults = .standard, deviceName: String = "iPhone") {
        self.api = api ?? SynqAPI(host: host)
        self.links = links ?? NoDeepLinks()
        self.wallet = wallet ?? NoWalletSigner()
        self.walletLogin = walletLogin ?? NoWalletLogin()
        self.privacy = privacy ?? NoSystemPrivacy()
        self.defaults = defaults
        self.lock = lock ?? AppLock(defaults: defaults)
        self.deviceName = deviceName
        funds = FundBook(defaults: defaults)
        push = PushCenter(defaults: defaults)
        push.app = self
        let sessions = self.api.sessions
        let box = WeakModel(self)
        Task {
            await sessions.setEventHandler { event in
                Task { @MainActor in box.model?.sessionEvent(event) }
            }
        }
    }

    public var host: String { api.host }
    public var principalId: String? { scope?.context.principalId ?? api.store.load()?.principalId }
    public var activeContext: WorkspaceContext? { scope?.context }
    public var tabs: [AppTab] { AppTab.tabs(for: scope?.context.kind ?? .personal) }

    // MARK: Lifecycle

    public func start() {
        guard phase == .launching else { return }
        if !defaults.bool(forKey: Self.onboardedKey) {
            phase = .onboarding
            return
        }
        resumeSession()
    }

    public func finishOnboarding() {
        defaults.set(true, forKey: Self.onboardedKey)
        resumeSession()
    }

    private func resumeSession() {
        if let session = api.store.load() {
            sessionIsLegacy = session.isLegacy
            phase = lock.isEnabled ? .locked : .ready
            loadContexts(principalId: session.principalId)
            push.resume()
        } else {
            phase = .signedOut(.fresh)
        }
    }

    /// The app went to the background: sensitive screens lock when the person
    /// turned on App Lock. Unlocking only shows the app again; it approves nothing.
    public func didEnterBackground() {
        lock.noteBackground()
        scope?.stopSync()
    }

    public func willEnterForeground() {
        if phase == .ready, lock.shouldLock() { phase = .locked }
        Task {
            await api.meta.refresh()
            scope?.startSync()
        }
    }

    public func unlock() async {
        guard phase == .locked else { return }
        if await lock.authenticate(reason: "Unlock Synq") {
            phase = api.store.load() == nil ? .signedOut(.expired) : .ready
        }
    }

    // MARK: Sign-in

    /// The one-time code from the Synq page. A v3 device session when the server
    /// offers it; otherwise the existing 15-minute /v2 session.
    public func signIn(code raw: String) {
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !busy else { return }
        guard code.range(of: "^[0-9a-f]{48}$", options: .regularExpression) != nil else {
            signInError = "Paste the private sign-in code from the Synq page (48 characters)."
            return
        }
        busy = true
        signInError = nil
        Task {
            defer { busy = false }
            do {
                let session: NativeSession
                if await api.availability("auth.deviceSessionFromCode") == .live {
                    let device = Device(deviceId: api.store.deviceId, name: deviceName, platform: .ios)
                    let s = try await api.call("auth.deviceSessionFromCode", body: DeviceCodeSessionRequest(code: code, device: device),
                                               authenticated: false, as: DeviceSession.self)
                    session = .device(s)
                } else {
                    try await WorkspaceClient(host: api.host).redeem(code: code)
                    guard let legacy = WorkspaceKeychain.load(host: api.host) else { throw APIFailure.signedOut }
                    session = .legacy(token: legacy.token, principalId: legacy.principalId,
                                      expiresAt: Date(timeIntervalSince1970: legacy.expiresAt))
                }
                try api.store.save(session)
                signedIn(session)
            } catch let e as APIFailure {
                signInError = e.message
            } catch let e as FundAPIError {
                signInError = e.message
            } catch let e as KeychainError {
                signInError = e.message
            } catch {
                signInError = "Could not sign in. Get a new code from the Synq page and try again."
            }
        }
    }

    /// Wallet sign-in: the wallet signs the server's EIP-712 `WorkspaceLogin`
    /// (audience "native"). The signature proves who you are; it approves nothing.
    public func signInWithWallet() {
        guard !busy else { return }
        busy = true
        signInError = nil
        Task {
            defer { busy = false }
            do {
                guard await api.availability("auth.deviceSession") == .live else {
                    throw APIFailure.notAvailable(routeId: "auth.deviceSession")
                }
                let challenge = try await walletLogin.signLoginChallenge(host: api.host)
                let device = Device(deviceId: api.store.deviceId, name: deviceName, platform: .ios)
                let s = try await api.call("auth.deviceSession",
                                           body: DeviceSessionRequest(challengeId: challenge.challengeId,
                                                                      signature: challenge.signature, device: device),
                                           authenticated: false, as: DeviceSession.self)
                try api.store.save(.device(s))
                signedIn(.device(s))
            } catch let e as APIFailure {
                signInError = e == .notAvailable(routeId: "auth.deviceSession")
                    ? "Wallet sign-in is not available on this Synq server yet. Use a code from the Synq page."
                    : e.message
            } catch let e as WalletApprovalError {
                signInError = e.message
            } catch {
                signInError = "Wallet sign-in did not finish. Nothing was signed in."
            }
        }
    }

    private func signedIn(_ session: NativeSession) {
        sessionIsLegacy = session.isLegacy
        phase = .ready
        loadContexts(principalId: session.principalId)
        push.resume()
    }

    // MARK: Contexts

    public func loadContexts(principalId: String) {
        contextsError = nil
        Task {
            do {
                let list: [WorkspaceContext]
                var hint: String?
                if await api.availability("me.contexts") == .live {
                    let c = try await api.call("me.contexts", as: Contexts.self)
                    list = c.contexts.compactMap { WorkspaceContext($0, principalId: c.principalId) }
                    hint = c.walletHint
                } else {
                    // Until v3 serves contexts: Personal plus every non-group /v2 workspace.
                    let workspaces = try await WorkspaceClient(host: api.host, token: tokenProvider).list()
                    list = [.personal(principalId: principalId)] + workspaces.filter { $0.kind != "GROUP" }.map {
                        WorkspaceContext(principalId: principalId, contextId: $0.id, kind: .business, workspaceId: $0.id,
                                         displayName: $0.displayName, role: nil,
                                         status: WorkspaceStatus(rawValue: $0.status) ?? .unknown, unreadCount: 0)
                    }
                }
                guard api.store.load() != nil else { return }
                contexts = list.contains { $0.kind == .personal } ? list : [.personal(principalId: principalId)] + list
                walletHint = hint
                offline = false
                if scope == nil || !contexts.contains(where: { $0.contextId == scope?.context.contextId }) {
                    select(contexts.first { $0.kind == .personal } ?? contexts[0])
                }
                if let pending = pendingDestination {
                    pendingDestination = nil
                    navigate(to: pending)
                }
            } catch let e as APIFailure {
                handle(e)
                if scope == nil { select(.personal(principalId: principalId)) }
            } catch let e as FundAPIError {
                contextsError = e.message
                if WorkspaceKeychain.load(host: api.host) == nil, api.store.load() == nil { sessionEnded(revoked: false) }
                else if scope == nil { select(.personal(principalId: principalId)) }
            } catch {
                contextsError = "Could not load your workspaces."
                if scope == nil { select(.personal(principalId: principalId)) }
            }
        }
    }

    /// Switches context. The previous scope (and every record it read) is dropped
    /// before the new one exists; navigation stacks start over.
    public func select(_ context: WorkspaceContext) {
        scope?.cancelAll()
        scope = nil
        paths = [:]
        sheet = nil
        tab = .home
        let next = ContextScope(context: context, api: api, token: tokenProvider)
        next.onSessionEnded = { [weak self] revoked in self?.sessionEnded(revoked: revoked) }
        scope = next
        next.startSync()
    }

    var tokenProvider: @Sendable () async throws -> String {
        let sessions = api.sessions
        return { try await sessions.accessToken() }
    }

    // MARK: Sign-out

    public func signOut() {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            await push.unregisterOnServer()
            if await api.availability("auth.logout") == .live {
                _ = try? await api.call("auth.logout", body: Ok(ok: true), as: Ok.self)
            } else if sessionIsLegacy {
                await WorkspaceClient(host: api.host).logout()
            }
            await api.sessions.signOutLocally()
            wipe()
            phase = .signedOut(.signedOut)
        }
    }

    /// Signs out every device of this account (server side), then this one.
    public func revokeAll() {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                _ = try await api.call("auth.revokeAll", body: Ok(ok: true), as: RevokeAll.self)
                await api.sessions.signOutLocally()
                wipe()
                phase = .signedOut(.revoked)
            } catch let e as APIFailure {
                notice = e == .notAvailable(routeId: "auth.revokeAll")
                    ? "Signing out other devices is not available on this server yet. Nothing changed."
                    : e.message
            } catch {
                notice = "Could not sign out other devices. Nothing changed."
            }
        }
    }

    private func sessionEvent(_ event: SessionEvent) {
        if case .ended(let revoked) = event { sessionEnded(revoked: revoked) }
    }

    /// The server ended the session (expired, revoked, context revoked): wipe
    /// everything and ask to sign in again.
    public func sessionEnded(revoked: Bool) {
        guard phase != .signedOut(revoked ? .revoked : .expired) else { return }
        api.store.clear()
        wipe()
        phase = .signedOut(revoked ? .revoked : .expired)
    }

    func handle(_ failure: APIFailure) {
        switch failure {
        case .sessionEnded(let revoked): sessionEnded(revoked: revoked)
        case .offline: offline = true
        case .signedOut: sessionEnded(revoked: false)
        default: contextsError = failure.message
        }
    }

    /// Drops every context, scope, navigation stack, sheet and system notification.
    func wipe() {
        scope?.cancelAll()
        scope = nil
        contexts = []
        walletHint = nil
        paths = [:]
        sheet = nil
        pendingDestination = nil
        notice = nil
        sessionIsLegacy = false
        privacy.clearDeliveredNotifications()
    }

    // MARK: Navigation

    public func navigate(to destination: SynqDestination) {
        guard phase == .ready || phase == .locked, api.store.load() != nil else {
            // Not signed in: remember it, show nothing.
            pendingDestination = destination
            return
        }
        guard !contexts.isEmpty else {
            pendingDestination = destination
            return
        }
        func business(_ workspaceId: String, _ tab: AppTab, _ path: [SynqDestination]) {
            guard let ctx = contexts.first(where: { $0.workspaceId == workspaceId }) else {
                notice = APIFailure.notFound.message
                return
            }
            if scope?.context.contextId != ctx.contextId { select(ctx) }
            self.tab = tab
            paths[tab] = path
        }
        func personal(_ tab: AppTab, _ path: [SynqDestination]) {
            if scope?.context.kind != .personal, let p = contexts.first(where: { $0.kind == .personal }) { select(p) }
            self.tab = tab
            paths[tab] = path
        }
        switch destination {
        case .personalHome: personal(.home, [])
        case .circle: personal(.circles, [destination])
        case .inbox(let ws): business(ws, .inbox, [])
        case .lead(let ws, _): business(ws, .inbox, [destination])
        case .deal(let ws, _): business(ws, .deals, [destination])
        case .agentRun(let ws, _): business(ws, .agents, [destination])
        case .approval(let id): sheet = .approval(requestId: id)
        case .approvals: personal(.approvals, [])
        case .notifications: sheet = .notifications
        }
    }

    /// A universal link or custom link opened the app.
    public func open(url: URL) {
        switch SynqLinkRouter.route(url, host: api.host) {
        case .destination(let d): navigate(to: d)
        case .fund(let link):
            let ref = funds.remember(fundId: link.fundId, key: link.key, name: nil, conversation: nil)
            navigate(to: .personalHome)
            scope?.openFund(ref)
        case .web(let u): links.openSecurely(u)
        case .rejected: notice = "That link is not a Synq link for \(api.host)."
        }
    }
}

/// Lets the session actor reach the model without keeping it alive.
private final class WeakModel: @unchecked Sendable {
    weak var model: SynqAppModel?
    init(_ model: SynqAppModel) { self.model = model }
}
