import Foundation
import SwiftUI
import SynqContracts

/// One server read as a screen sees it. A failed refresh keeps the last value
/// (shown with when it was synced) but never invents one.
public enum RemoteState<Value> {
    case idle
    case loading(previous: Value?, syncedAt: Date?)
    case loaded(Value, syncedAt: Date)
    /// The route is not implemented on this server yet.
    case notYet(routeId: String)
    case failed(APIFailure, previous: Value?, syncedAt: Date?)

    public var value: Value? {
        switch self {
        case .loaded(let v, _): return v
        case .loading(let v, _), .failed(_, let v, _): return v
        case .idle, .notYet: return nil
        }
    }

    public var syncedAt: Date? {
        switch self {
        case .loaded(_, let d): return d
        case .loading(_, let d), .failed(_, _, let d): return d
        case .idle, .notYet: return nil
        }
    }

    public var isLoading: Bool { if case .loading = self { return true } else { return false } }
    public var failure: APIFailure? { if case .failed(let f, _, _) = self { return f } else { return nil } }
}

/// Loads one value for the current context. Cancelled with its owner.
@MainActor
public final class Remote<Value>: ObservableObject {
    @Published public private(set) var state: RemoteState<Value> = .idle
    private var task: Task<Void, Never>?
    private let routeId: String
    private let work: () async throws -> Value
    /// Told when a load proves the session is over.
    var onSessionEnded: ((Bool) -> Void)?

    public init(routeId: String, _ work: @escaping () async throws -> Value) {
        self.routeId = routeId
        self.work = work
    }

    /// For previews and tests: a value already in hand (LOCAL_FIXTURE).
    public init(routeId: String, preset: RemoteState<Value>) {
        self.routeId = routeId
        work = { throw APIFailure.notAvailable(routeId: routeId) }
        state = preset
    }

    public func load(force: Bool = false) {
        if case .loading = state { return }
        if !force, case .loaded = state { return }
        let previous = state.value
        let synced = state.syncedAt
        state = .loading(previous: previous, syncedAt: synced)
        task = Task { [weak self] in
            guard let self else { return }
            do {
                let v = try await self.work()
                guard !Task.isCancelled else { return }
                self.state = .loaded(v, syncedAt: Date())
            } catch is CancellationError {
                return
            } catch let f as APIFailure {
                guard !Task.isCancelled else { return }
                if case .notAvailable(let id) = f {
                    self.state = .notYet(routeId: id)
                } else {
                    self.state = .failed(f, previous: previous, syncedAt: synced)
                }
                if case .sessionEnded(let revoked) = f { self.onSessionEnded?(revoked) }
            } catch {
                guard !Task.isCancelled else { return }
                self.state = .failed(.server(""), previous: previous, syncedAt: synced)
            }
        }
    }

    public func cancel() {
        task?.cancel()
        task = nil
    }

    deinit { task?.cancel() }
}
