import SwiftUI
import SynqContracts

// Agent runs: what an agent did, step by step, from typed events. Each step
// says who decided (model suggestion, deterministic check, person, chain) and
// its proof level exactly as the server reports it. Summaries are redacted
// explanations, never model reasoning. A payment reads "final" only with a
// final chain receipt, and "reconciled" only with a ledger entry.

struct AgentRunsView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                Text("Agents").synqType(.headline).accessibilityAddTraits(.isHeader)
                Text("What your agents proposed, what was checked, what was signed and what settled.")
                    .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
                RemoteSection(remote: scope.agentRuns, what: "agent runs") { page in
                    if page.items.isEmpty {
                        SynqNote(text: "No agent runs in this workspace yet.")
                    } else {
                        AgentRunRows(runs: page.items) { id in
                            if let ws = scope.workspaceId { model.navigate(to: .agentRun(workspaceId: ws, runId: id)) }
                        }
                    }
                }
                SynqSectionLabel(text: "Mandates")
                RemoteSection(remote: scope.mandates, what: "agent mandates") { m in MandatesContent(mandates: m) }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

struct AgentRunRows: View {
    let runs: [AgentRunSummary]
    let onOpen: (String) -> Void

    var body: some View {
        SynqGroup {
            ForEach(Array(runs.enumerated()), id: \.element.runId) { i, r in
                SynqRow(icon: .team, title: r.title,
                        subtitle: [r.amount?.text, AgentTimeline.statusWord(r.status)].compactMap { $0 }.joined(separator: " · "),
                        detail: "\(SynqTime.relative(r.updatedAt)) · \(r.proofLevel.label)",
                        trailing: .badge(RunBadge.of(r.status), AgentTimeline.statusWord(r.status)), divider: i > 0) { onOpen(r.runId) }
            }
        }
    }
}

enum RunBadge {
    static func of(_ s: RunStatus) -> SynqBadgeKind {
        switch s {
        case .reconciled, .finalized: return .approved
        case .blocked, .rejected, .timedOut, .revoked, .quarantined: return .danger
        case .unknown: return .neutral
        default: return .pending
        }
    }
}

struct AgentRunDetailView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    let runId: String
    @Environment(\.synqTheme) private var theme

    var body: some View {
        let remote = scope.agentRun(runId)
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                RemoteSection(remote: remote, what: "this run") { d in
                    AgentRunDetailContent(detail: d, workspaceId: scope.workspaceId ?? "", onOpen: { model.links.openSecurely($0) })
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
        .synqDetail("Agent run")
    }
}

struct AgentRunDetailContent: View {
    let detail: AgentRunDetail
    let workspaceId: String
    let onOpen: (URL) -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        let run = detail.run
        let events = AgentTimeline.merge([], detail.events, workspaceId: workspaceId)
        SynqPanel(label: "Run") {
            Text(run.title).synqType(.headline).fixedSize(horizontal: false, vertical: true)
            if let a = run.amount { SynqAmount(amount: a.amountText, unit: a.symbol, large: false) }
            HStack {
                SynqBadge(kind: RunBadge.of(run.status), text: AgentTimeline.statusWord(run.status))
                SynqBadge(kind: run.proofLevel.badge, text: run.proofLevel.label)
                Spacer()
            }
            Text("Started \(SynqTime.short(run.startedAt)) · updated \(SynqTime.short(run.updatedAt))").synqType(.caption, .secondary)
        }
        SynqSectionLabel(text: "Steps", trailing: "\(events.count)")
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(events.enumerated()), id: \.element.eventId) { i, e in
                let settlement = AgentTimeline.settlement(e, receipts: detail.receipts)
                SynqTimelineRow(title: e.summary,
                                detail: [AgentTimeline.actorWord(e.actor), AgentTimeline.statusWord(e.status),
                                         e.amount?.text, e.recipientHint.map { "to \($0)" }].compactMap { $0 }.joined(separator: " · "),
                                meta: "#\(e.sequence) · \(SynqTime.short(e.observedAt)) · \(e.proofLevel.label)",
                                mark: mark(e, settlement), last: i == events.count - 1) {
                    if let line = settlementLine(settlement) { Text(line).synqType(.caption, settlementInk(settlement)) }
                }
            }
        }
        if !detail.receipts.isEmpty {
            SynqSectionLabel(text: "Receipts")
            ForEach(detail.receipts, id: \.txHash) { r in ReceiptPanel(receipt: r, onOpen: onOpen) }
        }
        SynqNote(text: "Model suggestions are explanations, not decisions: money moves only after deterministic checks and the enforcing contract allow it.")
    }

    private func mark(_ e: AgentEconomicEvent, _ s: AgentTimeline.Settlement) -> SynqBadgeKind {
        if case .final = s { return .approved }
        return RunBadge.of(e.status) == .danger ? .danger : .neutral
    }

    private func settlementLine(_ s: AgentTimeline.Settlement) -> String? {
        switch s {
        case .notAPayment: return nil
        case .pending: return "Not final: no final chain receipt yet."
        case .final(let reconciled): return reconciled ? "Final on chain · reconciled in the ledger" : "Final on chain · not reconciled yet"
        case .reorged: return "Reorganised: the transaction is no longer final."
        }
    }

    private func settlementInk(_ s: AgentTimeline.Settlement) -> SynqInk {
        switch s {
        case .final(true): return .approved
        case .reorged: return .danger
        default: return .pending
        }
    }
}

/// One chain receipt: the chain it belongs to, the hash, finality and the
/// ledger entry; the explorer link only when it is that chain's explorer.
struct ReceiptPanel: View {
    let receipt: Receipt
    let onOpen: (URL) -> Void

    var body: some View {
        let explorer = SynqChains.explorerURL(receipt.explorerUrl, chainId: receipt.chainId, txHash: receipt.txHash)
        SynqPanel(label: SynqChains.name(receipt.chainId)) {
            SynqKeyValue("Transaction", shortId(receipt.txHash), mono: true)
            if let b = receipt.blockNumber { SynqKeyValue("Block", b, mono: true) }
            SynqKeyValue("Finality", finality, ink: receipt.finality == .finalized ? .approved : .pending)
            SynqKeyValue("Ledger", receipt.ledgerEntryId.map(shortId) ?? "Not reconciled", mono: receipt.ledgerEntryId != nil)
            if let explorer {
                SynqButton(title: "View on the explorer", trailingIcon: .external, kind: .compact) { onOpen(explorer) }
            } else if receipt.explorerUrl != nil {
                SynqNote(text: "Explorer link withheld: it does not point to this chain's explorer.")
            }
        }
    }

    private var finality: String {
        switch receipt.finality {
        case .finalized: return "Final"
        case .pending: return "Pending"
        case .reorged: return "Reorganised"
        case .unknown: return "Unknown"
        }
    }
}

struct MandatesContent: View {
    let mandates: Mandates

    var body: some View {
        if !mandates.capability.isUsable {
            CapabilityNote(name: "Agent mandates", capability: mandates.capability)
        }
        if mandates.leases.isEmpty {
            SynqNote(text: "No agent leases.")
        }
        ForEach(mandates.leases, id: \.leaseId) { l in LeasePanel(lease: l) }
    }
}

struct LeasePanel: View {
    let lease: AgentLease

    /// Revocation counts only when the chain confirmed it.
    private var revocation: String? {
        guard let at = lease.revokedAt else { return nil }
        let confirmed = lease.proofLevel == .liveArcTestnet || lease.proofLevel == .liveArcMainnet
        return confirmed ? "Revoked on chain \(SynqTime.short(at))" : "Revocation recorded \(SynqTime.short(at)), not yet confirmed on chain"
    }

    var body: some View {
        SynqPanel(label: "Lease \(shortId(lease.leaseId))") {
            HStack {
                SynqBadge(kind: lease.revokedAt == nil ? .live : .danger, text: lease.revokedAt == nil ? "Active" : "Revoked")
                SynqBadge(kind: lease.proofLevel.badge, text: lease.proofLevel.label)
                Spacer()
            }
            if let r = revocation { Text(r).synqType(.caption, .secondary) }
            // Leases carry base units without decimals: shown as base units, never guessed.
            SynqKeyValue("Per action", "\(lease.perActionUnits) base units", mono: true)
            SynqKeyValue("Left in budget", "\(lease.availableUnits) base units", mono: true)
            SynqKeyValue("Assets", lease.assetIds.joined(separator: ", "), mono: true)
            SynqKeyValue("Actions", lease.actions.joined(separator: ", "))
            SynqKeyValue("Recipients", "\(lease.recipients.count) allowlisted")
            SynqKeyValue("Expires", SynqTime.short(lease.expiresAt))
            SynqKeyValue("Enforced by", "\(shortId(lease.enforcingContract)) on \(SynqChains.name(lease.chainId))", mono: true)
            Text("Pausing or revoking a lease is a signed on-chain action from the owner's wallet; this screen cannot do it by itself.")
                .synqType(.caption, .tertiary).fixedSize(horizontal: false, vertical: true)
        }
    }
}
