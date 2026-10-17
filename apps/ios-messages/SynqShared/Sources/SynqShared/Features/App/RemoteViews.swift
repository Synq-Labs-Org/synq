import SwiftUI
import SynqContracts

/// Shows a remote read honestly: a spinner while loading, "not available yet"
/// when the server does not serve the route, the error with the last synced
/// copy when a refresh fails, and the content once loaded.
struct RemoteSection<Value, Content: View>: View {
    @ObservedObject var remote: Remote<Value>
    var what: String
    @ViewBuilder var content: (Value) -> Content
    @Environment(\.synqTheme) private var theme

    var body: some View {
        Group {
            switch remote.state {
            case .idle, .loading(nil, _):
                HStack(spacing: theme.space.s) {
                    SynqSpinner(ink: .secondary, size: 14)
                    Text("Loading \(what)…").synqType(.caption, .secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            case .notYet(let route):
                NotYetPanel(what: what, routeId: route)
            case .loaded(let v, _):
                content(v)
            case .loading(let v?, let at):
                content(v)
                SyncedNote(at: at, refreshing: true)
            case .failed(let f, let v, let at):
                if let v {
                    content(v)
                    SyncedNote(at: at, refreshing: false)
                }
                SynqNote(text: f.message, error: true)
                if v == nil, f != .notFound {
                    SynqButton(title: "Try again", icon: .refresh, kind: .compact) { remote.load(force: true) }
                }
            }
        }
        .onAppear { remote.load() }
    }
}

struct SyncedNote: View {
    let at: Date?
    let refreshing: Bool
    var body: some View {
        SynqNote(text: (refreshing ? "Refreshing · " : "Not refreshed · ")
                 + (at.map { "last synced \($0.formatted(.relative(presentation: .named)))" } ?? "never synced"))
    }
}

/// The honest empty state for a planned route.
struct NotYetPanel: View {
    let what: String
    let routeId: String
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqPanel(label: "Not available yet") {
            HStack(alignment: .top) {
                Text(what.capitalizedFirst).synqType(.bodyStrong).fixedSize(horizontal: false, vertical: true)
                Spacer()
                SynqBadge(kind: .neutral, text: "Planned")
            }
            Text("This Synq server does not serve \(what) yet, so nothing is shown here. Nothing is simulated.")
                .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
            Text("Route \(routeId)").synqType(.mono, .tertiary)
        }
    }
}

/// A capability that is not usable, with the server's reason.
struct CapabilityNote: View {
    let name: String
    let capability: Capability

    var body: some View {
        SynqRow(icon: capability.isUsable ? .check : .warning, title: SynqText.words(name), subtitle: capability.reason,
                trailing: .badge(capability.isUsable ? .approved : .neutral, capability.status.label))
    }
}

extension Capability {
    /// Only these statuses mean the feature can be used (API_CONTRACT_v3 rules).
    var isUsable: Bool { [.available, .onchainAuthenticated, .verifiedTestnet].contains(status) }
}

extension CapabilityStatus {
    var label: String {
        switch self {
        case .available: return "Available"
        case .blocked: return "Blocked"
        case .notConfigured: return "Not configured"
        case .unsupported: return "Unsupported"
        case .offchainOnly: return "Off-chain only"
        case .onchainAuthenticated: return "On-chain"
        case .verifiedTestnet: return "Verified testnet"
        case .unknown: return "Unknown"
        }
    }
}

extension ProofLevel {
    /// Shown exactly as the server says; never upgraded.
    var label: String {
        switch self {
        case .liveArcTestnet: return "LIVE_ARC_TESTNET"
        case .liveArcMainnet: return "LIVE_ARC_MAINNET"
        case .providerSandbox: return "PROVIDER_SANDBOX"
        case .localFixture: return "LOCAL_FIXTURE"
        case .notVerified: return "NOT_VERIFIED"
        case .blocked: return "BLOCKED"
        case .unknown: return "UNKNOWN"
        }
    }

    var badge: SynqBadgeKind {
        switch self {
        case .liveArcTestnet, .liveArcMainnet: return .approved
        case .blocked: return .danger
        default: return .neutral
        }
    }
}

extension Role {
    var label: String {
        switch self {
        case .owner: return "Owner"
        case .admin: return "Admin"
        case .member: return "Member"
        case .viewer: return "Viewer"
        case .unknown: return "Member"
        }
    }
}
