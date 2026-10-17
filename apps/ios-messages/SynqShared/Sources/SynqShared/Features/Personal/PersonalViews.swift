import SwiftUI
import SynqContracts

// Personal context: your own wallets, the circles you are a verified member of,
// their contributions, proposals and refunds, and your activity. Rules kept on
// every screen: only `settled` is spendable; reserved, pending and quarantined
// are shown apart; a circle's money is never added to your own; a refund or a
// payment is final only with a chain receipt.

// MARK: - Home

struct PersonalHomeView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                RemoteSection(remote: scope.personalOverview, what: "your overview") { o in
                    PersonalOverviewContent(overview: o, onCircle: { model.navigate(to: .circle(circleId: $0)) })
                }
                if case .notYet = scope.personalOverview.state {
                    LegacyGroupsSection(model: model, scope: scope)
                }
                DeviceFundsSection(model: model, scope: scope)
                SynqNote(text: "Synq never adds a circle's money to yours. Only settled amounts can be spent.")
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

/// The personal overview from the server (also rendered in previews).
struct PersonalOverviewContent: View {
    let overview: PersonalOverview
    let onCircle: (String) -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqSectionLabel(text: "Your wallets", trailing: "\(overview.wallets.count)")
        if overview.wallets.isEmpty {
            SynqNote(text: "No wallet linked to this account yet.")
        }
        ForEach(overview.wallets, id: \.address) { w in
            WalletPanel(wallet: w)
        }
        SynqSectionLabel(text: "Circles", trailing: "\(overview.circles.count)")
        if overview.circles.isEmpty {
            SynqNote(text: "You are not a member of any circle yet. Join one from an invite link.")
        } else {
            CircleRows(circles: Array(overview.circles.prefix(4)), onOpen: onCircle)
        }
        if !overview.recent.isEmpty {
            SynqSectionLabel(text: "Recent")
            ActivityRows(items: Array(overview.recent.prefix(5)))
        }
    }
}

struct WalletPanel: View {
    let wallet: WalletBalance
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqPanel(label: wallet.label) {
            Text(shortId(wallet.address)).synqType(.mono, .secondary).accessibilityLabel("Wallet \(shortId(wallet.address))")
            if wallet.balances.isEmpty { Text("No balance observed.").synqType(.caption, .secondary) }
            ForEach(Array(wallet.balances.enumerated()), id: \.offset) { _, b in
                SynqBalanceBreakdown(symbol: b.symbol, network: b.network, settled: b.amount(b.settled),
                                     reserved: b.amount(b.reserved), pending: b.amount(b.pending),
                                     quarantined: b.amount(b.quarantined))
            }
            FreshnessLine(freshness: wallet.freshness)
        }
    }
}

struct FreshnessLine: View {
    let freshness: Freshness
    var body: some View {
        let source: String = {
            switch freshness.source {
            case .chain: return "read from the chain"
            case .provider: return "from the provider"
            case .ledger: return "from the Synq ledger"
            case .cache: return "from a cache"
            case .unknown: return "source unknown"
            }
        }()
        if freshness.stale {
            SynqNote(text: "Stale: \(source), observed \(SynqTime.short(freshness.observedAt)). It may have changed.", error: true)
        } else {
            SynqNote(text: "Observed \(SynqTime.relative(freshness.observedAt)), \(source).")
        }
    }
}

struct CircleRows: View {
    let circles: [CircleSummary]
    let onOpen: (String) -> Void

    var body: some View {
        SynqGroup {
            ForEach(Array(circles.enumerated()), id: \.element.circleId) { i, c in
                SynqRow(icon: .people, title: c.displayName,
                        subtitle: subtitle(c),
                        detail: c.myContribution.map { "You contributed \($0.text)" },
                        trailing: c.openProposals > 0 ? .badge(.pending, "\(c.openProposals) open") : .arrow,
                        divider: i > 0) { onOpen(c.circleId) }
            }
        }
    }

    private func subtitle(_ c: CircleSummary) -> String {
        var parts = ["\(c.memberCount) members", c.role.label]
        if let t = c.threshold { parts.append("\(t) approve") }
        if let h = c.held { parts.append("holds \(h.text(h.settled))") }
        return parts.joined(separator: " · ")
    }
}

struct ActivityRows: View {
    let items: [ActivityItem]

    var body: some View {
        SynqGroup {
            ForEach(Array(items.enumerated()), id: \.element.activityId) { i, a in
                SynqRow(icon: icon(a.kind), title: a.title,
                        subtitle: [a.amount?.text, SynqTime.short(a.occurredAt)].compactMap { $0 }.joined(separator: " · "),
                        detail: a.txHash.map { "Tx \(shortId($0))" },
                        trailing: .badge(badge(a.status), word(a.status)), divider: i > 0)
            }
        }
    }

    private func icon(_ k: ActivityItem.Kind) -> SynqIcon {
        switch k {
        case .contribution: return .plus
        case .refund: return .refresh
        case .payment: return .send
        case .proposal: return .vote
        case .invoicePaid: return .receipt
        case .deal: return .deal
        case .other, .unknown: return .clock
        }
    }

    /// "Final" only when the server says the chain receipt is final.
    func word(_ s: ActivityItem.Status) -> String {
        switch s {
        case .pending: return "Pending"
        case .final: return "Final"
        case .failed: return "Failed"
        case .refunded: return "Refunded"
        case .unknown: return "Unknown"
        }
    }

    func badge(_ s: ActivityItem.Status) -> SynqBadgeKind {
        switch s {
        case .final: return .approved
        case .failed: return .danger
        case .pending: return .pending
        case .refunded, .unknown: return .neutral
        }
    }
}

/// /v2 group workspaces, shown while the server does not serve v3 circles.
struct LegacyGroupsSection: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope

    var body: some View {
        SynqSectionLabel(text: "Group workspaces")
        RemoteSection(remote: scope.legacyGroups, what: "your group workspaces") { groups in
            if groups.isEmpty {
                SynqNote(text: "No group workspaces on this account.")
            } else {
                SynqGroup {
                    ForEach(Array(groups.enumerated()), id: \.element.id) { i, g in
                        SynqRow(icon: .people, title: g.displayName,
                                subtitle: "\(SynqChains.name(g.chainId)) · \(g.status.capitalized)\(g.threshold.map { " · \($0) approve" } ?? "")",
                                trailing: .arrow, divider: i > 0) {
                            model.navigate(to: .circle(circleId: g.id))
                        }
                    }
                }
            }
        }
    }
}

/// Group funds opened on this iPhone from fund links (the iMessage fund screens).
struct DeviceFundsSection: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @State private var refs: [FundRef] = []

    var body: some View {
        Group {
            if !refs.isEmpty {
                SynqSectionLabel(text: "Group funds on this iPhone", trailing: "\(refs.count)")
                SynqGroup {
                    ForEach(Array(refs.enumerated()), id: \.element.fundId) { i, r in
                        SynqRow(icon: .group, title: r.name, subtitle: "Opened from a fund link", trailing: .arrow, divider: i > 0) {
                            scope.openFund(r)
                        }
                    }
                }
            }
        }
        .onAppear { refs = model.funds.all().sorted { $0.lastUsed > $1.lastUsed } }
        .onChange(of: scope.openedFund) { _, _ in refs = model.funds.all().sorted { $0.lastUsed > $1.lastUsed } }
        .sheet(item: Binding(get: { scope.openedFund.map(OpenedFund.init) }, set: { if $0 == nil { scope.openedFund = nil } })) { f in
            FundSheet(model: model, ref: f.ref)
        }
    }
}

struct OpenedFund: Identifiable {
    let ref: FundRef
    var id: String { ref.fundId }
}

/// The existing fund screens, outside Messages: no "share in this chat" actions.
struct FundSheet: View {
    @ObservedObject var app: SynqAppModel
    @StateObject private var fund: FundModel
    let ref: FundRef

    init(model: SynqAppModel, ref: FundRef) {
        app = model
        self.ref = ref
        _fund = StateObject(wrappedValue: FundModel(client: FundClient(host: model.host), book: model.funds))
    }

    var body: some View {
        SynqThemeRoot {
            FundScreen(model: fund, actions: FundActions(cards: NoMessagesCards(), links: app.links))
                .onAppear { fund.show(ref); fund.startPolling() }
                .onDisappear { fund.stopPolling() }
        }
    }
}

// MARK: - Circles

struct CirclesView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                Text("Circles").synqType(.headline).accessibilityAddTraits(.isHeader)
                Text("Group funds you are a verified member of. Each circle's money stays the circle's.")
                    .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
                RemoteSection(remote: scope.circles, what: "your circles") { page in
                    if page.items.isEmpty {
                        SynqNote(text: "No circles yet. Open an invite link from a friend to join one.")
                    } else {
                        CircleRows(circles: page.items) { model.navigate(to: .circle(circleId: $0)) }
                    }
                }
                if case .notYet = scope.circles.state { LegacyGroupsSection(model: model, scope: scope) }
                SynqButton(title: "Start a circle on the Synq page", icon: .plus, trailingIcon: .external, kind: .compact) {
                    if let url = URL(string: "https://\(model.host)/workspaces") { model.links.openSecurely(url) }
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

struct CircleDetailView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    let circleId: String
    @Environment(\.synqTheme) private var theme

    var body: some View {
        let remote = scope.circle(circleId)
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                RemoteSection(remote: remote, what: "this circle") { d in
                    CircleDetailContent(detail: d, onOpen: { model.links.openSecurely($0) }, host: model.host)
                }
                if case .notYet = remote.state {
                    LegacyCircleSection(scope: scope, workspaceId: circleId, onOpen: { model.links.openSecurely($0) }, host: model.host)
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
        .synqDetail("Circle")
    }
}

/// One circle: what it holds, members' contributions and refunds, proposals with
/// their real approval threshold.
struct CircleDetailContent: View {
    let detail: CircleDetail
    let onOpen: (URL) -> Void
    let host: String
    @Environment(\.synqTheme) private var theme

    var body: some View {
        let c = detail.circle
        SynqPanel(label: "Circle") {
            Text(c.displayName).synqType(.headline)
            Text("\(c.memberCount) members · you are \(c.role.label.lowercased())\(c.threshold.map { " · \($0) of \(c.memberCount) approve each payment" } ?? "")")
                .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
            if let h = c.held {
                SynqBalanceBreakdown(symbol: h.symbol, network: h.network, settled: h.amount(h.settled), reserved: h.amount(h.reserved),
                                     pending: h.amount(h.pending), quarantined: h.amount(h.quarantined))
            } else {
                Text("Balance not observed.").synqType(.caption, .secondary)
            }
            if let vault = c.vault { SynqKeyValue("Vault", shortId(vault), mono: true) }
            FreshnessLine(freshness: c.freshness)
        }
        let open = detail.proposals.filter { [.review, .ready, .submitted].contains($0.status) }
        SynqSectionLabel(text: "Proposals", trailing: "\(open.count) open")
        if detail.proposals.isEmpty { SynqNote(text: "No proposals.") }
        SynqGroup {
            ForEach(Array(detail.proposals.enumerated()), id: \.element.proposalId) { i, p in
                SynqRow(icon: p.kind == .refund ? .refresh : .vote, title: p.title,
                        subtitle: [p.amount?.text, p.recipientHint.map { "to \($0)" }, "\(p.approvals) of \(p.threshold) approvals"]
                            .compactMap { $0 }.joined(separator: " · "),
                        detail: p.txHash.map { "Tx \(shortId($0))" },
                        trailing: .badge(proposalBadge(p.status), proposalWord(p)), divider: i > 0)
            }
        }
        SynqSectionLabel(text: "Members")
        SynqGroup {
            ForEach(Array(detail.members.enumerated()), id: \.element.principalId) { i, m in
                let asset = c.held
                SynqRow(icon: .people, title: m.walletHint, subtitle: m.role.label,
                        detail: asset.map { "Contributed \($0.text(m.contributed)) · refunded \($0.text(m.refunded))" },
                        trailing: .none, divider: i > 0)
            }
        }
        SynqSectionLabel(text: "Contributions", trailing: "\(detail.contributions.count)")
        if detail.contributions.isEmpty { SynqNote(text: "No contributions yet.") }
        SynqGroup {
            ForEach(Array(detail.contributions.enumerated()), id: \.element.contributionId) { i, k in
                SynqRow(icon: .plus, title: k.amount.text, subtitle: "From \(k.payerHint) · \(SynqTime.short(k.observedAt))",
                        detail: k.txHash.map { "Tx \(shortId($0))" },
                        trailing: .badge(contributionBadge(k.status), contributionWord(k.status)), divider: i > 0)
            }
        }
        let caps = detail.capabilities.sorted { $0.key < $1.key }
        if !caps.isEmpty {
            SynqSectionLabel(text: "What this circle can do")
            SynqGroup {
                ForEach(Array(caps.enumerated()), id: \.offset) { _, entry in
                    CapabilityNote(name: entry.key, capability: entry.value)
                }
            }
        }
        SynqNote(text: "Contributions count only for the wallet that paid, once the chain confirms them. Approving and contributing happen in your wallet.")
        if let url = URL(string: "https://\(host)/workspaces?workspace=\(c.circleId)") {
            SynqButton(title: "Contribute or approve on the Synq page", icon: .passkey, trailingIcon: .external, kind: .compact) { onOpen(url) }
        }
    }

    func proposalWord(_ p: CircleProposal) -> String {
        switch p.status {
        case .review: return "Voting"
        case .ready: return "Ready"
        case .submitted: return "Submitted"
        case .confirmed: return p.txHash == nil ? "Confirmed" : "Final"
        case .failed: return "Failed"
        case .needsReview: return "Needs review"
        case .cancelled: return "Cancelled"
        case .expired: return "Expired"
        case .unknown: return "Unknown"
        }
    }

    func proposalBadge(_ s: CircleProposal.Status) -> SynqBadgeKind {
        switch s {
        case .confirmed: return .approved
        case .failed: return .danger
        case .review, .ready, .submitted: return .pending
        default: return .neutral
        }
    }

    func contributionWord(_ s: CircleContribution.Status) -> String {
        switch s {
        case .requested: return "Requested"
        case .pending: return "Not final"
        case .credited: return "Credited"
        case .refunded: return "Refunded"
        case .expired: return "Expired"
        case .unknown: return "Unknown"
        }
    }

    func contributionBadge(_ s: CircleContribution.Status) -> SynqBadgeKind {
        switch s {
        case .credited: return .approved
        case .requested, .pending: return .pending
        default: return .neutral
        }
    }
}

/// /v2 contributions for a group workspace (real reads), while v3 circles are planned.
struct LegacyCircleSection: View {
    @ObservedObject var scope: ContextScope
    let workspaceId: String
    let onOpen: (URL) -> Void
    let host: String

    var body: some View {
        SynqSectionLabel(text: "Group fund (workspace API)")
        RemoteSection(remote: scope.legacyGroup(workspaceId), what: "this group's contributions") { g in
            SynqGroup {
                if g.balances.isEmpty { SynqRow(title: "No contributions credited yet", trailing: .none) }
                ForEach(Array(g.balances.enumerated()), id: \.offset) { i, s in
                    SynqRow(icon: .people, title: s.mine ? "You" : s.member, subtitle: "Credited \(workspaceUSDC(s.amount))",
                            trailing: .none, divider: i > 0)
                }
            }
            let mine = g.contributions.filter { $0.mine && $0.state == "OPEN" }
            if !mine.isEmpty {
                SynqNote(text: "\(mine.count) of your contributions are waiting for the payment to settle; they are not counted yet.")
            }
            ForEach(g.refunds) { r in
                SynqNote(text: "Refund \(r.mine ? "to you" : "to a member") · \(workspaceUSDC(r.amount)) · \(r.state.capitalized)")
            }
        }
        if let url = URL(string: "https://\(host)/workspaces?workspace=\(workspaceId)") {
            SynqButton(title: "Contribute on the Synq page", icon: .passkey, trailingIcon: .external, kind: .compact) { onOpen(url) }
        }
    }
}

// MARK: - Activity and money

struct ActivityView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                Text("Activity").synqType(.headline).accessibilityAddTraits(.isHeader)
                RemoteSection(remote: scope.personalOverview, what: "your activity") { o in
                    if o.recent.isEmpty { SynqNote(text: "Nothing yet.") } else { ActivityRows(items: o.recent) }
                }
                SynqButton(title: "Notifications", icon: .bell, trailingIcon: .forward, kind: .compact) { model.sheet = .notifications }
                SynqNote(text: "\"Final\" appears only after the chain confirms a payment, contribution or refund.")
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

struct PersonalMoneyView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                Text("Money").synqType(.headline).accessibilityAddTraits(.isHeader)
                RemoteSection(remote: scope.personalOverview, what: "your balances") { o in
                    SynqSectionLabel(text: "Your wallets")
                    ForEach(o.wallets, id: \.address) { WalletPanel(wallet: $0) }
                    if !o.vaults.isEmpty {
                        SynqSectionLabel(text: "Vaults you control")
                        ForEach(o.vaults, id: \.workspaceId) { v in
                            SynqPanel(label: v.displayName) {
                                if let vault = v.vault { Text(shortId(vault)).synqType(.mono, .secondary) }
                                ForEach(Array(v.balances.enumerated()), id: \.offset) { _, b in
                                    SynqBalanceBreakdown(symbol: b.symbol, network: b.network, settled: b.amount(b.settled),
                                                         reserved: b.amount(b.reserved), pending: b.amount(b.pending),
                                                         quarantined: b.amount(b.quarantined))
                                }
                            }
                        }
                    }
                    SynqNote(text: "Balances are shown per asset and chain. Different assets are never added together.")
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}
