import Foundation
import SynqContracts
@testable import SynqShared
import XCTest

/// Native session and app coordinator rules (synthetic stub server, in-memory
/// secret store; nothing touches the real Keychain or network).
@MainActor
final class SessionAndCoordinatorTests: XCTestCase {
    var server: StubServer!
    var secrets: MemorySecretStore!
    var defaults: UserDefaults!

    override func setUp() async throws {
        server = StubServer()
        secrets = MemorySecretStore()
        defaults = UserDefaults(suiteName: "synq.tests.\(UUID().uuidString)")!
        defaults.set(true, forKey: SynqAppModel.onboardedKey)
    }

    func api() -> SynqAPI {
        SynqAPI(host: server.host, store: SessionStore(host: server.host, secrets: secrets), transport: server.session)
    }

    func app(_ api: SynqAPI, privacy: SystemPrivacyPort? = nil) -> SynqAppModel {
        SynqAppModel(host: server.host, api: api, privacy: privacy, defaults: defaults)
    }

    func until(_ what: String, timeout: TimeInterval = 3, _ condition: @escaping () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !condition() && Date() < end { try? await Task.sleep(nanoseconds: 10_000_000) }
        let ok = condition()
        XCTAssertTrue(ok, "timed out waiting for \(what)")
    }

    // MARK: Meta gating

    func testPlannedRouteIsNeverCalled() async throws {
        server.meta(["me.contexts"])
        let api = api()
        try api.store.save(.device(try JSONDecoder().decode(DeviceSession.self,
                                                            from: Data(StubServer.deviceSession(access: "a1", refresh: "r1").utf8))))
        do {
            _ = try await api.call("personal.overview", as: PersonalOverview.self)
            XCTFail("a planned route must not be called")
        } catch let f as APIFailure {
            XCTAssertEqual(f, .notAvailable(routeId: "personal.overview"))
        }
        XCTAssertEqual(server.count("GET /api/v3/personal/overview"), 0)
    }

    func testServerWithoutV3TreatsEverythingAsNotYet() async {
        let api = api()  // no meta handler: 404
        let availability = await api.availability("me.contexts")
        XCTAssertEqual(availability, .notYet)
    }

    // MARK: Refresh

    func testExpiredAccessRefreshesOnceAndRotates() async throws {
        server.meta(["me.contexts", "auth.refresh"])
        let refreshes = Counter()
        server.on("POST /api/v3/auth/refresh") { r in
            refreshes.add()
            let body = String(data: r.httpBody ?? Data(), encoding: .utf8) ?? ""
            XCTAssertTrue(body.contains("\"refreshToken\":\"r1\""), body)
            return .init(status: 200, json: StubServer.deviceSession(access: "a2", refresh: "r2"))
        }
        server.on("GET /api/v3/me/contexts") { r in
            XCTAssertEqual(r.value(forHTTPHeaderField: "authorization"), "Bearer a2")
            return .init(status: 200, json: #"{"principalId":"p1","walletHint":"0x12…ab","contexts":[]}"#)
        }
        let api = api()
        try api.store.save(.device(try JSONDecoder().decode(DeviceSession.self, from: Data(
            StubServer.deviceSession(access: "a1", refresh: "r1", accessIn: 10).utf8))))
        async let one = api.call("me.contexts", as: Contexts.self)
        async let two = api.call("me.contexts", as: Contexts.self)
        _ = try await (one, two)
        XCTAssertEqual(refreshes.value, 1, "concurrent calls share one refresh")
        guard case .device(let stored)? = api.store.load() else { return XCTFail("session missing") }
        XCTAssertEqual(stored.refreshToken, "r2", "the used refresh token is replaced")
    }

    func testReusedRefreshTokenEndsTheSessionAsRevoked() async throws {
        server.meta(["me.contexts", "auth.refresh"])
        server.on("POST /api/v3/auth/refresh", status: 401, json: #"{"error":"REFRESH_REUSED","message":"reused"}"#)
        let api = api()
        try api.store.save(.device(try JSONDecoder().decode(DeviceSession.self, from: Data(
            StubServer.deviceSession(access: "a1", refresh: "old", accessIn: 5).utf8))))
        do {
            _ = try await api.call("me.contexts", as: Contexts.self)
            XCTFail("expected the session to end")
        } catch let f as APIFailure {
            XCTAssertEqual(f, .sessionEnded(revoked: true))
        }
        XCTAssertNil(api.store.load(), "tokens are deleted")
        XCTAssertTrue(secrets.accounts.allSatisfy { $0 == SessionStore.deviceAccount }, "only the device id remains")
    }

    func test401RefreshesOnceThenSignsOut() async throws {
        server.meta(["me.contexts", "auth.refresh"])
        server.on("GET /api/v3/me/contexts", status: 401, json: #"{"error":"UNAUTHORIZED","message":"no"}"#)
        server.on("POST /api/v3/auth/refresh", json: StubServer.deviceSession(access: "a2", refresh: "r2"))
        let api = api()
        try api.store.save(.device(try JSONDecoder().decode(DeviceSession.self, from: Data(
            StubServer.deviceSession(access: "a1", refresh: "r1").utf8))))
        do {
            _ = try await api.call("me.contexts", as: Contexts.self)
            XCTFail("expected sign-out")
        } catch let f as APIFailure {
            XCTAssertEqual(f, .sessionEnded(revoked: false))
        }
        XCTAssertEqual(server.count("GET /api/v3/me/contexts"), 2, "one retry after refresh, no loop")
        XCTAssertEqual(server.count("POST /api/v3/auth/refresh"), 1)
        XCTAssertNil(api.store.load())
    }

    // MARK: Coordinator

    func signedInApp(contexts: String) async throws -> SynqAppModel {
        server.meta(["me.contexts", "auth.deviceSessionFromCode", "auth.logout", "personal.overview"])
        server.on("POST /api/v3/auth/device-session/code", json: StubServer.deviceSession(access: "a1", refresh: "r1"))
        server.on("GET /api/v3/me/contexts", json: contexts)
        server.on("GET /api/v3/personal/overview", json: #"{"principalId":"p1","wallets":[],"circles":[],"vaults":[],"recent":[]}"#)
        server.on("POST /api/v3/auth/logout", json: #"{"ok":true}"#)
        let model = app(api())
        model.start()
        XCTAssertEqual(model.stateName, "signedOut")
        model.signIn(code: String(repeating: "a", count: 48))
        await until("contexts") { model.scope != nil && !model.contexts.isEmpty }
        return model
    }

    static let twoContexts = #"{"principalId":"p1","walletHint":"0x12…ab","contexts":[{"contextId":"personal","kind":"PERSONAL","displayName":"Personal","unreadCount":0},{"contextId":"w1","kind":"BUSINESS","workspaceId":"00000000-0000-4000-8000-000000000001","displayName":"Studio","role":"OWNER","workspaceStatus":"ACTIVE","unreadCount":3}]}"#

    func testSignInStoresTheSessionInTheSecretStoreOnly() async throws {
        let model = try await signedInApp(contexts: Self.twoContexts)
        XCTAssertEqual(model.stateName, "personal")
        XCTAssertNotNil(secrets.read(SessionStore.sessionAccount))
        let everything = defaults.dictionaryRepresentation().map { "\($0.key)=\($0.value)" }.joined(separator: ";")
        XCTAssertFalse(everything.contains("a1") || everything.contains("r1"), "no token in UserDefaults")
    }

    func testContextSwitchDropsEverythingReadForThePreviousContext() async throws {
        let model = try await signedInApp(contexts: Self.twoContexts)
        weak var old = model.scope
        old?.personalOverview.load()
        await until("overview") { old?.personalOverview.state.value != nil }
        XCTAssertEqual(old?.remoteCount, 1)
        model.paths[.circles] = [.circle(circleId: "c1")]
        let business = model.contexts.first { $0.isBusiness }!
        model.select(business)
        XCTAssertEqual(model.stateName, "business")
        XCTAssertEqual(model.scope?.remoteCount, 0, "the new context starts empty")
        XCTAssertTrue(model.paths.isEmpty, "navigation stacks start over")
        XCTAssertEqual(model.tab, .home)
        await until("previous scope released") { old == nil }
        XCTAssertNil(old, "the previous context's scope (and every record in it) is released")
    }

    func testSessionEndWipesAndAsksToSignInAgain() async throws {
        final class Privacy: SystemPrivacyPort { var cleared = 0; func clearDeliveredNotifications() { cleared += 1 } }
        server.meta(["me.contexts", "auth.deviceSessionFromCode"])
        server.on("POST /api/v3/auth/device-session/code", json: StubServer.deviceSession(access: "a1", refresh: "r1"))
        server.on("GET /api/v3/me/contexts", json: Self.twoContexts)
        let privacy = Privacy()
        let model = app(api(), privacy: privacy)
        model.start()
        model.signIn(code: String(repeating: "b", count: 48))
        await until("contexts") { !model.contexts.isEmpty }
        model.sessionEnded(revoked: false)
        XCTAssertEqual(model.stateName, "reauth")
        XCTAssertNil(model.scope)
        XCTAssertTrue(model.contexts.isEmpty)
        XCTAssertNil(model.api.store.load())
        XCTAssertEqual(privacy.cleared, 1, "lock-screen notifications cleared")
        model.sessionEnded(revoked: true)
        XCTAssertEqual(model.stateName, "revoked")
    }

    func testSignOutWipes() async throws {
        let model = try await signedInApp(contexts: Self.twoContexts)
        model.signOut()
        await until("signed out") { model.stateName == "signedOut" }
        XCTAssertNil(model.scope)
        XCTAssertNil(model.api.store.load())
        XCTAssertEqual(server.count("POST /api/v3/auth/logout"), 1)
    }

    func testLinkOpenedWhileSignedOutShowsNothingUntilSignIn() async throws {
        server.meta(["me.contexts", "auth.deviceSessionFromCode"])
        server.on("POST /api/v3/auth/device-session/code", json: StubServer.deviceSession(access: "a1", refresh: "r1"))
        server.on("GET /api/v3/me/contexts", json: Self.twoContexts)
        let model = app(api())
        model.start()
        model.open(url: URL(string: "https://\(server.host)/w/00000000-0000-4000-8000-000000000001/inbox/lead-9")!)
        XCTAssertNil(model.scope)
        XCTAssertEqual(model.pendingDestination, .lead(workspaceId: "00000000-0000-4000-8000-000000000001", leadId: "lead-9"))
        XCTAssertFalse(server.paths.contains { $0.contains("/leads/") }, "nothing is fetched before sign-in")
        model.signIn(code: String(repeating: "c", count: 48))
        await until("navigated") { model.tab == .inbox }
        XCTAssertEqual(model.activeContext?.workspaceId, "00000000-0000-4000-8000-000000000001")
        XCTAssertEqual(model.paths[.inbox], [.lead(workspaceId: "00000000-0000-4000-8000-000000000001", leadId: "lead-9")])
    }

    func testLinkToAWorkspaceYouAreNotInSaysNotFound() async throws {
        let model = try await signedInApp(contexts: Self.twoContexts)
        model.open(url: URL(string: "https://\(server.host)/w/other-tenant/inbox/lead-1")!)
        XCTAssertEqual(model.notice, APIFailure.notFound.message)
        XCTAssertEqual(model.stateName, "personal")
    }

    func testContextRevokedEventWipesAndOtherWorkspacesAreIgnored() async throws {
        let model = try await signedInApp(contexts: Self.twoContexts)
        model.select(model.contexts.first { $0.isBusiness }!)
        let scope = model.scope!
        func ev(_ type: StreamEvent.TypeValue, ws: String?) -> StreamEvent {
            StreamEvent(cursor: "c", eventId: UUID().uuidString, type: type, workspaceId: ws, observedAt: "2026-10-17T10:00:00Z")
        }
        scope.apply([ev(.contextRevoked, ws: "another-workspace")])
        XCTAssertEqual(model.stateName, "business", "another workspace's event changes nothing here")
        scope.apply([ev(.contextRevoked, ws: "00000000-0000-4000-8000-000000000001")])
        XCTAssertEqual(model.stateName, "revoked")
        XCTAssertNil(model.scope)
        XCTAssertNil(model.api.store.load())
    }

    func testCodeIsValidatedBeforeAnyRequest() async {
        let model = app(api())
        model.start()
        model.signIn(code: "not a code")
        XCTAssertNotNil(model.signInError)
        XCTAssertTrue(server.paths.isEmpty)
    }

    func testLockedAppNeedsUnlockAndUnlockApprovesNothing() async throws {
        server.meta(["me.contexts"])
        server.on("GET /api/v3/me/contexts", json: Self.twoContexts)
        let store = SessionStore(host: server.host, secrets: secrets)
        try store.save(.device(try JSONDecoder().decode(DeviceSession.self, from: Data(
            StubServer.deviceSession(access: "a1", refresh: "r1").utf8))))
        defaults.set(true, forKey: AppLock.key)
        let lock = AppLock(defaults: defaults, authenticator: { _ in true })
        let model = SynqAppModel(host: server.host, api: SynqAPI(host: server.host, store: store, transport: server.session),
                                 lock: lock, defaults: defaults)
        model.start()
        XCTAssertEqual(model.stateName, "locked")
        await model.unlock()
        XCTAssertEqual(model.phase, .ready)
        XCTAssertFalse(server.paths.contains { $0.contains("/approvals") }, "unlocking never touches approvals")
    }
}

final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    func add() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
}
