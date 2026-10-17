import Foundation
import SynqContracts

// The four seams between portable code and a host. Screens never reach for
// Messages, Safari, UIApplication or a wallet SDK directly; a host hands them an
// implementation. Each port has a safe default that does nothing and says so.

// MARK: - Navigation

/// An in-app place, the same for a tab tap, a universal link and a notification.
/// Ids come from untrusted links: opening one only asks the server, which checks
/// the session and membership before showing anything.
public enum SynqDestination: Equatable, Hashable, Sendable {
    case personalHome
    case circle(circleId: String)
    case inbox(workspaceId: String)
    case lead(workspaceId: String, leadId: String)
    case deal(workspaceId: String, dealId: String)
    case agentRun(workspaceId: String, runId: String)
    case approval(requestId: String)
    case approvals
    case notifications
}

/// Moves the full-screen app to a destination. The Messages extension has no
/// such navigation and uses `NoNavigation`.
@MainActor
public protocol NavigationPort: AnyObject {
    func navigate(to destination: SynqDestination)
}

@MainActor
public final class NoNavigation: NavigationPort {
    public init() {}
    public func navigate(to destination: SynqDestination) {}
}

// MARK: - Links out

/// Opens a Synq web page (https, the configured host only) where a passkey or
/// wallet ceremony happens. The extension shows it in Safari's in-app browser;
/// the app hands it to the system.
@MainActor
public protocol DeepLinkPort: AnyObject {
    func openSecurely(_ url: URL)
}

@MainActor
public final class NoDeepLinks: DeepLinkPort {
    public init() {}
    public func openSecurely(_ url: URL) {}
}

// MARK: - Messages cards

/// Inserts Synq cards into the current conversation. Only the Messages extension
/// can do this; everywhere else `canInsert` is false and the screens hide the
/// "share in this chat" actions.
@MainActor
public protocol MessagesCardPort: AnyObject {
    var canInsert: Bool { get }
    func insertInvite(_ ref: FundRef, view: FundView?)
    func insertProposal(_ ref: FundRef, _ proposal: FundProposal)
    func insertTrip(_ ref: FundRef, _ trip: TripView)
    func insertInvoice(_ invoice: BusinessInvoice)
}

@MainActor
public final class NoMessagesCards: MessagesCardPort {
    public init() {}
    public var canInsert: Bool { false }
    public func insertInvite(_ ref: FundRef, view: FundView?) {}
    public func insertProposal(_ ref: FundRef, _ proposal: FundProposal) {}
    public func insertTrip(_ ref: FundRef, _ trip: TripView) {}
    public func insertInvoice(_ invoice: BusinessInvoice) {}
}

// MARK: - Wallet approvals

/// Proof that a person pressed the sign button on the approval screen just now.
/// Only the approval screen in this module can make one, so background code,
/// push handlers and deep links cannot ask a wallet to sign.
public struct UserApprovalGesture: Sendable {
    public let requestId: String
    public let at: Date
    init(requestId: String, at: Date = Date()) {
        self.requestId = requestId
        self.at = at
    }
}

public enum WalletApprovalError: Error, Equatable, Sendable {
    /// No user-controlled signer is set up in this build.
    case notConfigured(String)
    case cancelled
    case refused(String)

    public var message: String {
        switch self {
        case .notConfigured(let m): return m
        case .cancelled: return "Signing was cancelled. Nothing was sent."
        case .refused(let m): return m
        }
    }
}

/// Signs the exact typed data of one approval request with a user-controlled
/// wallet (an external wallet hand-off or a supported user-controlled wallet
/// SDK). Sign-in, Face ID and notification taps are never approvals; the wallet
/// is the only thing that produces a signature, and it shows the person the
/// typed data itself.
@MainActor
public protocol WalletApprovalPort: AnyObject {
    /// Whether this build can sign at all, with the honest reason when it cannot.
    var availability: Capability { get }
    /// - Parameter typedDataJSON: the server's `typedData` bytes, passed on unmodified.
    func sign(_ request: SigningRequest, typedDataJSON: Data, gesture: UserApprovalGesture) async throws -> String
}

@MainActor
public final class NoWalletSigner: WalletApprovalPort {
    public init() {}
    public var availability: Capability {
        Capability(status: .notConfigured,
                   reason: "No wallet is connected to this app yet. Approve on the Synq page with your wallet.")
    }
    public func sign(_ request: SigningRequest, typedDataJSON: Data, gesture: UserApprovalGesture) async throws -> String {
        throw WalletApprovalError.notConfigured(availability.reason)
    }
}
