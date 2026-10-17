import SwiftUI
import SynqContracts

// Business context: the workspace overview, the private enquiries inbox with
// owner takeover, deals and money. Data is the workspace's, read with the
// person's own session; the server checks membership on every read, and an id
// from another workspace reads as "not found".

// MARK: - Home

struct BusinessHomeView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                RemoteSection(remote: scope.overview, what: "this workspace's overview") { o in
                    WorkspaceOverviewContent(overview: o,
                                             onInbox: { model.tab = .inbox },
                                             onApprovals: { model.navigate(to: .approvals) },
                                             onRun: { model.navigate(to: .agentRun(workspaceId: o.workspaceId, runId: $0)) })
                }
                if case .notYet = scope.overview.state {
                    LegacyTreasuryPanel(scope: scope)
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

struct WorkspaceOverviewContent: View {
    let overview: WorkspaceOverview
    let onInbox: () -> Void
    let onApprovals: () -> Void
    let onRun: (String) -> Void
    @Environment(\.synqTheme) private var theme

    private var asset: Balance? { overview.balances.first }

    var body: some View {
        if let b = asset {
            SynqPanel(label: "Treasury") {
                SynqBalanceBreakdown(symbol: b.symbol, network: b.network, settled: b.amount(b.settled), reserved: b.amount(b.reserved),
                                     pending: b.amount(b.pending), quarantined: b.amount(b.quarantined))
                FreshnessLine(freshness: overview.freshness)
            }
        } else {
            SynqPanel(label: "Treasury") {
                Text("No balance observed for this workspace.").synqType(.body, .secondary)
                FreshnessLine(freshness: overview.freshness)
            }
        }
        SynqGroup {
            SynqRow(icon: .invite, title: "Enquiries", subtitle: "\(overview.leads.open) open · \(overview.leads.needsOwner) need you",
                    trailing: overview.leads.needsOwner > 0 ? .badge(.pending, "\(overview.leads.needsOwner)") : .arrow, action: onInbox)
            SynqRow(icon: .passkey, title: "Waiting for your signature", subtitle: overview.pendingApprovals == 1 ? "1 approval request" : "\(overview.pendingApprovals) approval requests",
                    trailing: overview.pendingApprovals > 0 ? .badge(.pending, "\(overview.pendingApprovals)") : .arrow, divider: true,
                    action: onApprovals)
            SynqRow(icon: .receipt, title: "Receivables", subtitle: "\(overview.receivables.open) open · \(units(overview.receivables.units))",
                    trailing: .none, divider: true)
            SynqRow(icon: .calendar, title: "Payables", subtitle: "\(overview.payables.open) open · \(units(overview.payables.units))",
                    trailing: .none, divider: true)
        }
        if !overview.agentHighlights.isEmpty {
            SynqSectionLabel(text: "Agent activity")
            AgentRunRows(runs: overview.agentHighlights, onOpen: onRun)
        }
        let caps = overview.capabilities.sorted { $0.key < $1.key }
        if !caps.isEmpty {
            SynqSectionLabel(text: "Integrations")
            SynqGroup {
                ForEach(Array(caps.enumerated()), id: \.offset) { _, e in CapabilityNote(name: e.key, capability: e.value) }
            }
        }
    }

    private func units(_ u: String) -> String {
        guard let b = asset else { return "amount unknown" }
        return b.text(u)
    }
}

/// /v2 treasury snapshot (live today) while v3 overview is planned.
struct LegacyTreasuryPanel: View {
    @ObservedObject var scope: ContextScope

    var body: some View {
        SynqSectionLabel(text: "Treasury (workspace API)")
        RemoteSection(remote: scope.legacySnapshot, what: "the treasury snapshot") { s in
            SynqPanel(label: "Observed balances") {
                let balances = s.world.treasury.balances
                if balances.value.isEmpty { Text("Balance unknown.").synqType(.body, .secondary) }
                ForEach(Array(balances.value.enumerated()), id: \.offset) { _, b in
                    SynqKeyValue("\(b.asset) · \(b.chain)", workspaceAmount(b.baseUnits, symbol: b.asset))
                }
                if let observed = balances.meta.observedAt {
                    Text("Observed \(Date(timeIntervalSince1970: observed).formatted()) · \(balances.meta.freshness)").synqType(.caption, .secondary)
                }
                Text(s.world.decision.decisionGrade ? "Sources were fresh at the last read."
                                                    : "Sources incomplete: this is not a spending allowance.")
                    .synqType(.caption, .secondary)
                Text("\(s.riskCases.count) risk cases").synqType(.caption, .tertiary)
            }
        }
    }
}

// MARK: - Inbox

struct InboxView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @State private var filter: InboxFilter = .all
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                Text("Enquiries").synqType(.headline).accessibilityAddTraits(.isHeader)
                Text("Private conversations with prospects. Only you and your team see them; they are never posted to a group.")
                    .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
                ChipScroller {
                    ForEach(InboxFilter.allCases) { f in
                        SynqChip(title: f.title, selected: filter == f) { filter = f }
                    }
                }
                InboxList(remote: scope.inbox(filter: filter)) { lead in
                    guard let ws = scope.workspaceId else { return }
                    model.navigate(to: .lead(workspaceId: ws, leadId: lead))
                }
                .id(filter)
                InviteLeadPanel(scope: scope)
                SynqNote(text: "Guest Mode and Telegram links appear only when this workspace's integrations say they are available.")
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

struct InboxList: View {
    @ObservedObject var remote: Remote<InboxPage>
    let onOpen: (String) -> Void

    var body: some View {
        RemoteSection(remote: remote, what: "enquiries") { page in
            if page.items.isEmpty {
                SynqNote(text: "No enquiries here.")
            } else {
                LeadRows(leads: page.items, onOpen: onOpen)
                if page.nextCursor != nil {
                    SynqNote(text: "Showing the newest \(page.items.count). Older enquiries are on the Synq page.")
                }
            }
        }
    }
}

struct LeadRows: View {
    let leads: [LeadSummary]
    let onOpen: (String) -> Void

    var body: some View {
        SynqGroup {
            ForEach(Array(leads.enumerated()), id: \.element.leadId) { i, l in
                SynqRow(icon: l.source == .telegram ? .send : .invite, title: l.label,
                        subtitle: "\(LeadWords.stage(l.stage)) · \(LeadWords.handling(l.handling))",
                        detail: "\(LeadWords.source(l.source)) · \(SynqTime.relative(l.lastActivityAt))",
                        trailing: l.needsOwner ? .badge(.pending, "Needs you") : (l.unread > 0 ? .badge(.live, "\(l.unread) new") : .arrow),
                        divider: i > 0) { onOpen(l.leadId) }
            }
        }
    }
}

enum LeadWords {
    static func stage(_ s: LeadStage) -> String {
        switch s {
        case .leadOpen: return "New"
        case .discovery: return "Discovery"
        case .qualified: return "Qualified"
        case .offerDrafted: return "Offer drafted"
        case .offerValidated: return "Offer checked"
        case .offerSent: return "Offer sent"
        case .negotiating: return "Negotiating"
        case .agreedPendingSignatures: return "Agreed · awaiting signatures"
        case .signed: return "Signed"
        case .fundingPending: return "Awaiting deposit"
        case .funded: return "Funded"
        case .active: return "In progress"
        case .delivered: return "Delivered"
        case .acceptancePending: return "Awaiting acceptance"
        case .released: return "Released"
        case .refunded: return "Refunded"
        case .disputed: return "Disputed"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown stage"
        }
    }

    static func handling(_ h: LeadHandling) -> String {
        switch h {
        case .agent: return "Agent replying"
        case .human: return "You took over"
        case .frozen: return "Offers frozen"
        case .unknown: return "Unknown"
        }
    }

    static func source(_ s: LeadSource) -> String {
        switch s {
        case .telegram: return "Telegram"
        case .web: return "Web"
        case .imessage: return "iMessage"
        case .unknown: return "Unknown source"
        }
    }
}

/// Creates a single-use invite link for a prospect (server-generated, opaque).
struct InviteLeadPanel: View {
    @ObservedObject var scope: ContextScope
    @State private var invite: LeadInvite?
    @State private var error: String?
    @State private var busy = false
    @State private var key = UUID().uuidString

    var body: some View {
        SynqPanel(label: "Invite a prospect") {
            Text("A private link that works once and expires. It carries no prices or messages.")
                .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
            if let invite {
                SynqKeyValue("Web link", invite.webUrl, mono: true)
                if let t = invite.telegramUrl { SynqKeyValue("Telegram", t, mono: true) }
                SynqKeyValue("Expires", SynqTime.short(invite.expiresAt))
            }
            SynqButton(title: busy ? "Creating…" : "Create invite link", icon: .invite, kind: .compact, busy: busy) { create() }
                .disabled(busy)
            if let error { SynqNote(text: error, error: true) }
        }
    }

    private func create() {
        guard let ws = scope.workspaceId else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                invite = try await scope.api.call("workspace.leadInvite", params: ["workspaceId": ws],
                                                  body: LeadInviteRequest(source: .web, expiresInSeconds: 86_400),
                                                  idempotencyKey: key, as: LeadInvite.self)
                key = UUID().uuidString
            } catch let f as APIFailure {
                error = f.message
            } catch {
                self.error = "Could not create the invite."
            }
        }
    }
}

// MARK: - Lead detail

struct LeadDetailView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    let leadId: String
    @Environment(\.synqTheme) private var theme

    var body: some View {
        let remote = scope.lead(leadId)
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                RemoteSection(remote: remote, what: "this enquiry") { d in
                    LeadDetailContent(detail: d, scope: scope, onChanged: { remote.load(force: true) })
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
        .synqDetail("Enquiry")
    }
}

struct LeadDetailContent: View {
    let detail: LeadDetail
    let scope: ContextScope
    let onChanged: () -> Void
    @State private var reply = ""
    @State private var busy = false
    @State private var error: String?
    @State private var replyKey = UUID().uuidString
    @Environment(\.synqTheme) private var theme

    private var canAct: Bool { scope.context.role == .owner || scope.context.role == .admin }

    var body: some View {
        let lead = detail.lead
        SynqPanel(label: LeadWords.source(lead.source)) {
            HStack(alignment: .top) {
                Text(lead.label).synqType(.headline).lineLimit(2)
                Spacer()
                SynqBadge(kind: lead.handling == .human ? .live : lead.handling == .frozen ? .danger : .neutral,
                          text: LeadWords.handling(lead.handling))
            }
            Text(LeadWords.stage(lead.stage)).synqType(.caption, .secondary)
            Text(detail.consent.granted
                 ? "Consent recorded\(detail.consent.grantedAt.map { " \(SynqTime.short($0))" } ?? ""): “\(detail.consent.scope)”"
                 : "No consent recorded: the conversation is not shown.")
                .synqType(.caption, .tertiary).fixedSize(horizontal: false, vertical: true)
        }
        TakeoverControls(detail: detail, scope: scope, canAct: canAct, onChanged: onChanged)
        if !detail.offers.isEmpty {
            SynqSectionLabel(text: "Offer versions", trailing: "\(detail.offers.count)")
            ForEach(detail.offers.sorted { $0.version > $1.version }, id: \.termsHash) { o in OfferPanel(offer: o) }
        }
        SynqSectionLabel(text: "Conversation")
        if detail.consent.granted {
            if detail.messages.isEmpty { SynqNote(text: "No messages yet.") }
            ForEach(detail.messages, id: \.messageId) { m in
                SynqMessageBubble(author: author(m.author), text: m.text, time: SynqTime.short(m.createdAt),
                                  side: m.author == .staff ? .ours : m.author == .system ? .system : .theirs)
            }
            if detail.olderMessagesCursor != nil { SynqNote(text: "Older messages are on the Synq page.") }
            if lead.handling == .human && canAct {
                SynqField(label: "Reply as yourself", text: $reply, placeholder: "Write to the prospect")
                SynqButton(title: busy ? "Sending…" : "Send", icon: .send, busy: busy) { send() }
                    .disabled(busy || reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || reply.count > 4000)
            } else if lead.handling == .agent {
                SynqNote(text: "The agent is replying. Take over to write yourself; the agent then sends no new offers until you hand back.")
            }
        }
        if let error { SynqNote(text: error, error: true) }
        SynqNote(text: "Messages here never move money. Offers are binding only when both sides sign the exact version.")
    }

    private func author(_ a: LeadMessage.Author) -> String {
        switch a {
        case .lead: return "Prospect"
        case .agent: return "Sales agent"
        case .staff: return "You"
        case .system: return "Synq"
        case .unknown: return "Unknown"
        }
    }

    private func send() {
        guard let ws = scope.workspaceId else { return }
        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                _ = try await scope.api.call("workspace.leadMessage", params: ["workspaceId": ws, "leadId": detail.lead.leadId],
                                             body: LeadMessageRequest(text: text), idempotencyKey: replyKey, as: LeadMessage.self)
                reply = ""
                replyKey = UUID().uuidString
                onChanged()
            } catch let f as APIFailure {
                error = f.message
            } catch {
                self.error = "Not sent. Try again; the same message will not be sent twice."
            }
        }
    }
}

/// Owner/admin controls. The server enforces them with a version check; the app
/// shows the new state only after the server confirms it.
struct TakeoverControls: View {
    let detail: LeadDetail
    let scope: ContextScope
    let canAct: Bool
    let onChanged: () -> Void
    @State private var busy: TakeoverRequest.Action?
    @State private var error: String?

    var body: some View {
        if canAct {
            SynqGroup {
                switch detail.lead.handling {
                case .agent, .unknown:
                    SynqRow(icon: .people, title: "Take over", subtitle: "You reply; the agent stops sending offers", trailing: .arrow) { act(.humanTakeover) }
                    SynqRow(icon: .shield, title: "Freeze offers", subtitle: "No new offers until you unfreeze", trailing: .arrow, divider: true) { act(.freezeOffers) }
                case .human:
                    SynqRow(icon: .team, title: "Hand back to the agent", subtitle: "Its offers stay inside your sales policy", trailing: .arrow) { act(.handBackToAgent) }
                    SynqRow(icon: .shield, title: "Freeze offers", subtitle: "No new offers until you unfreeze", trailing: .arrow, divider: true) { act(.freezeOffers) }
                case .frozen:
                    SynqRow(icon: .people, title: "Take over", subtitle: "You reply; offers stay frozen for the agent", trailing: .arrow) { act(.humanTakeover) }
                    SynqRow(icon: .team, title: "Hand back to the agent", subtitle: "Unfreezes agent offers", trailing: .arrow, divider: true) { act(.handBackToAgent) }
                }
                SynqRow(icon: .warning, title: "Escalate to the owner", trailing: .arrow, divider: true) { act(.escalateToOwner) }
            }
            .disabled(busy != nil)
            if busy != nil { SynqNote(text: "Waiting for the server to confirm…") }
            if let error { SynqNote(text: error, error: true) }
        } else {
            SynqNote(text: "Only an owner or admin can take over or freeze this conversation.")
        }
    }

    private func act(_ action: TakeoverRequest.Action) {
        guard let ws = scope.workspaceId else { return }
        busy = action
        error = nil
        Task {
            defer { busy = nil }
            do {
                _ = try await scope.api.call("workspace.leadTakeover", params: ["workspaceId": ws, "leadId": detail.lead.leadId],
                                             body: TakeoverRequest(action: action, expectedVersion: detail.handlingVersion),
                                             as: TakeoverResult.self)
                onChanged()
            } catch APIFailure.conflict {
                error = "Someone changed this conversation a moment ago. Reloaded; check and try again."
                onChanged()
            } catch let f as APIFailure {
                error = f.message
            } catch {
                self.error = "Nothing changed. Try again."
            }
        }
    }
}

struct OfferPanel: View {
    let offer: OfferVersion
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqPanel(label: "Version \(offer.version)") {
            HStack(alignment: .firstTextBaseline) {
                SynqAmount(amount: offer.total.amountText, unit: offer.total.symbol, large: false)
                Spacer()
                SynqBadge(kind: badge, text: word)
            }
            ForEach(Array(offer.lines.enumerated()), id: \.offset) { _, l in
                SynqKeyValue("\(l.quantity) × \(l.description)", SynqMoney.text(l.totalUnits, decimals: offer.total.decimals, symbol: offer.total.symbol))
            }
            ForEach(Array(offer.milestones.enumerated()), id: \.offset) { i, m in
                SynqKeyValue("\(i + 1). \(m.label)\(m.dueAt.map { " · due \(SynqTime.short($0))" } ?? "")",
                             SynqMoney.text(m.units, decimals: offer.total.decimals, symbol: offer.total.symbol))
            }
            Text("By \(offer.createdBy == .agent ? "the sales agent" : "your team") · policy v\(offer.policyVersion) · expires \(SynqTime.short(offer.expiresAt))")
                .synqType(.caption, .secondary)
            Text("Terms \(shortId(offer.termsHash))\(offer.previousTermsHash.map { " · replaces \(shortId($0))" } ?? "")")
                .synqType(.mono, .tertiary)
        }
    }

    private var word: String {
        switch offer.status {
        case .drafted: return "Draft"
        case .validated: return "Checked"
        case .sent: return "Sent"
        case .accepted: return "Accepted"
        case .rejected: return "Rejected"
        case .countered: return "Countered"
        case .expired: return "Expired"
        case .withdrawn: return "Withdrawn"
        case .unknown: return "Unknown"
        }
    }

    private var badge: SynqBadgeKind {
        switch offer.status {
        case .accepted: return .approved
        case .rejected, .withdrawn, .expired: return .neutral
        default: return .pending
        }
    }
}

// MARK: - Deals and money (/v2 today)

struct DealsView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                Text("Deals").synqType(.headline).accessibilityAddTraits(.isHeader)
                RemoteSection(remote: scope.legacyDeals, what: "deals") { deals in
                    if deals.isEmpty {
                        SynqNote(text: "No deals involving your wallet in this workspace.")
                    } else {
                        SynqGroup {
                            ForEach(Array(deals.enumerated()), id: \.element.id) { i, d in
                                SynqRow(icon: .deal, title: d.title, subtitle: "\(workspaceUSDC(d.total)) · \(d.milestones.count) milestones",
                                        trailing: .badge(d.status == "RELEASED" ? .approved : .pending, d.status.replacingOccurrences(of: "_", with: " ").capitalized),
                                        divider: i > 0) {
                                    if let ws = scope.workspaceId { model.navigate(to: .deal(workspaceId: ws, dealId: d.id)) }
                                }
                            }
                        }
                    }
                }
                SynqNote(text: "Signing terms, funding escrow and releasing milestones happen in your wallet on the Synq page.")
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

struct DealDetailView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    let dealId: String
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                RemoteSection(remote: scope.legacyDeals, what: "this deal") { deals in
                    if let d = deals.first(where: { $0.id == dealId }) {
                        SynqPanel(label: "Deal") {
                            Text(d.title).synqType(.headline)
                            SynqAmount(amount: SynqMoney.decimal(d.total, decimals: 6).map(SynqMoney.grouped) ?? "—", unit: "USDC")
                            Text(d.escrow.map { "\(d.status) · escrow \(shortId($0.escrowDealId))" } ?? d.status).synqType(.caption, .secondary)
                        }
                        SynqGroup {
                            ForEach(Array(d.milestones.enumerated()), id: \.offset) { i, m in
                                SynqRow(icon: .clock, title: "\(m.index + 1). \(m.title)", subtitle: workspaceUSDC(m.amount),
                                        trailing: .badge(m.status == "RELEASED" ? .approved : .pending, m.status.capitalized), divider: i > 0)
                            }
                        }
                        if let ws = scope.workspaceId, let url = URL(string: "https://\(model.host)/workspaces?workspace=\(ws)") {
                            SynqButton(title: "Fund, release or dispute in your wallet", icon: .passkey, trailingIcon: .external) {
                                model.links.openSecurely(url)
                            }
                        }
                    } else {
                        SynqNote(text: APIFailure.notFound.message, error: true)
                    }
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
        .synqDetail("Deal")
    }
}

struct BusinessMoneyView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                Text("Money").synqType(.headline).accessibilityAddTraits(.isHeader)
                RemoteSection(remote: scope.overview, what: "balances") { o in
                    ForEach(Array(o.balances.enumerated()), id: \.offset) { _, b in
                        SynqPanel(label: "\(b.symbol) · \(b.network)") {
                            SynqBalanceBreakdown(symbol: b.symbol, network: b.network, settled: b.amount(b.settled), reserved: b.amount(b.reserved),
                                                 pending: b.amount(b.pending), quarantined: b.amount(b.quarantined))
                        }
                    }
                    FreshnessLine(freshness: o.freshness)
                }
                if case .notYet = scope.overview.state { LegacyTreasuryPanel(scope: scope) }
                SynqSectionLabel(text: "Invoices")
                RemoteSection(remote: scope.legacyInvoices, what: "invoices") { invoices in
                    if invoices.isEmpty { SynqNote(text: "No invoices.") }
                    SynqGroup {
                        ForEach(Array(invoices.enumerated()), id: \.element.id) { i, v in
                            SynqRow(icon: .receipt, title: "Invoice \(v.number)", subtitle: "\(workspaceUSDC(v.total)) · \(workspaceUSDC(v.amountDue)) due",
                                    detail: v.reconciliation.replacingOccurrences(of: "_", with: " ").lowercased(),
                                    trailing: .badge(v.status == "PAID" ? .approved : .pending, v.status.capitalized), divider: i > 0)
                        }
                    }
                }
                SynqSectionLabel(text: "Payment requests")
                RemoteSection(remote: scope.legacyPayouts, what: "payment requests") { payouts in
                    if payouts.isEmpty { SynqNote(text: "No payment requests.") }
                    SynqGroup {
                        ForEach(Array(payouts.enumerated()), id: \.element.id) { i, p in
                            SynqRow(icon: .send, title: workspaceUSDC(p.data.amount), subtitle: p.data.purpose,
                                    detail: p.txHash.map { "Tx \(shortId($0))" } ?? p.reason,
                                    trailing: .badge(p.state == "EXECUTED" ? .approved : .pending, p.state.capitalized), divider: i > 0)
                        }
                    }
                }
                SynqSectionLabel(text: "Bills")
                RemoteSection(remote: scope.legacyBooks, what: "bills and payables") { books in
                    let open = books.payables.filter { $0.status == "OPEN" }
                    if open.isEmpty && books.bills.isEmpty { SynqNote(text: "No bills recorded.") }
                    SynqGroup {
                        ForEach(Array(open.enumerated()), id: \.element.id) { i, p in
                            SynqRow(icon: .calendar, title: p.number, subtitle: "\(workspaceUSDC(p.amount)) · due \(p.dueOn)", trailing: .none, divider: i > 0)
                        }
                        ForEach(Array(books.bills.enumerated()), id: \.element.id) { i, b in
                            SynqRow(icon: .clock, title: b.label, subtitle: "\(workspaceUSDC(b.amount)) every \(b.cadenceDays) days",
                                    trailing: .none, divider: i > 0 || !open.isEmpty)
                        }
                    }
                }
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}
