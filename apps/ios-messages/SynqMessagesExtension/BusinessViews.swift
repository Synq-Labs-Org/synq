import SwiftUI

// The Arc business screens: the Home section and one sheet per feature (Deal
// Room, Get paid, the finance team, Split income, Treasury, Pay a contractor).
// Layout and functional English copy only; the look comes from the theme.
// Nothing here signs or moves money: drafts and proposals open the Synq page,
// where the right wallet signs.

// MARK: - Home section

struct BusinessTile {
    let kind: BusinessFeatureKind
    let icon: SynqIcon
    let title: String
    let subtitle: String

    static let all: [BusinessTile] = [
        BusinessTile(kind: .deals, icon: .deal, title: "Deal room", subtitle: "Agree, sign, escrow milestones"),
        BusinessTile(kind: .invoices, icon: .receipt, title: "Get paid", subtitle: "Invoice + checkout link"),
        BusinessTile(kind: .team, icon: .team, title: "Ask your finance team", subtitle: "CFO · Risk · Kernel decision"),
        BusinessTile(kind: .splits, icon: .split, title: "Split income", subtitle: "Tax, payables, floor, free cash"),
        BusinessTile(kind: .treasury, icon: .bank, title: "Treasury", subtitle: "Arc balances, Earn, USYC"),
        BusinessTile(kind: .contractors, icon: .contractor, title: "Pay a contractor", subtitle: "Verified vendors only"),
    ]

    static func of(_ kind: BusinessFeatureKind) -> BusinessTile { all.first { $0.kind == kind }! }
}

/// The headline list on Home: the Arc business features, labelled with their network.
struct BusinessSection: View {
    @ObservedObject var business: BusinessModel
    let actions: FundActions
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.s) {
            SynqSectionLabel(text: "Arc business", trailing: networkTitle(business.network))
            SynqGroup {
                ForEach(Array(BusinessTile.all.enumerated()), id: \.element.kind) { i, tile in
                    SynqRow(icon: tile.icon, title: tile.title, subtitle: tile.subtitle,
                            trailing: trailing(tile.kind), divider: i > 0) {
                        actions.expand()
                        business.open(tile.kind)
                    }
                    .accessibilityHint(business.availability(tile.kind).reason ?? "Opens \(tile.title)")
                }
            }
            if business.offServer != nil {
                SynqNote(text: "Business features now run in your own Arc workspace: a vault your owners sign for, with vendors, bills, invoices, deals and splits.")
                if let url = URL(string: "https://\(business.client.host)/workspaces") {
                    SynqButton(title: "Open my Arc workspace", trailingIcon: .forward, kind: .compact) { actions.open(url) }
                }
            }
        }
    }

    private func trailing(_ kind: BusinessFeatureKind) -> SynqRowTrailing {
        switch business.availability(kind) {
        case .enabled: return .arrow
        case .checking: return .text("…")
        case .off: return .badge(.neutral, "Off")
        }
    }
}

/// Compact-mode chips for the same features.
struct BusinessChips: View {
    @ObservedObject var business: BusinessModel
    let actions: FundActions

    var body: some View {
        ForEach(BusinessTile.all, id: \.kind) { tile in
            SynqChip(title: chipTitle(tile.kind), icon: tile.icon) {
                actions.expand()
                business.open(tile.kind)
            }
        }
    }

    private func chipTitle(_ kind: BusinessFeatureKind) -> String {
        switch kind {
        case .deals: return "Deal"
        case .invoices: return "Invoice"
        case .team: return "Ask CFO"
        case .splits: return "Split"
        case .treasury: return "Treasury"
        case .contractors: return "Contractor"
        }
    }
}

// MARK: - Sheet host

/// Presents the business sheet the model asks for.
struct BusinessSheetHost: ViewModifier {
    @ObservedObject var business: BusinessModel
    let actions: FundActions
    @Environment(\.synqTheme) private var theme

    func body(content: Content) -> some View {
        content.sheet(item: $business.sheet) { sheet in
            BusinessScreen(business: business, sheet: sheet, actions: actions) { business.sheet = nil }
                .environment(\.synqTheme, theme)
        }
    }
}

extension View {
    func businessSheets(_ business: BusinessModel, actions: FundActions) -> some View {
        modifier(BusinessSheetHost(business: business, actions: actions))
    }
}

/// One business screen, chosen by kind.
struct BusinessScreen: View {
    @ObservedObject var business: BusinessModel
    let sheet: BusinessSheet
    let actions: FundActions
    let onClose: () -> Void

    var body: some View {
        switch sheet.kind {
        case .deals: DealRoomSheet(business: business, sheet: sheet, actions: actions, onClose: onClose)
        case .invoices: GetPaidSheet(business: business, sheet: sheet, actions: actions, onClose: onClose)
        case .team: TeamSheet(business: business, sheet: sheet, actions: actions, onClose: onClose)
        case .splits: SplitSheet(business: business, sheet: sheet, onClose: onClose)
        case .treasury: TreasurySheet(business: business, actions: actions, onClose: onClose)
        case .contractors: ContractorSheet(business: business, sheet: sheet, actions: actions, onClose: onClose)
        }
    }
}

// MARK: - Shared pieces

/// Network and mode, always visible on a business screen.
struct BusinessModeLine: View {
    var network: String
    var mode: String
    @Environment(\.synqTheme) private var theme

    var body: some View {
        HStack(spacing: theme.space.s) {
            Text(networkTitle(network)).synqType(.caption, .secondary)
            Text("·").synqType(.caption, .tertiary)
            Text(mode).synqType(.caption, .tertiary)
            Spacer(minLength: 0)
            Text("Chain " + String(BusinessNetwork.chainId)).synqType(.caption, .tertiary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// Shows the feature's content when the server serves it, else the honest reason.
struct BusinessGate<Content: View>: View {
    @ObservedObject var business: BusinessModel
    let kind: BusinessFeatureKind
    @ViewBuilder var content: () -> Content
    @Environment(\.synqTheme) private var theme

    var body: some View {
        switch business.availability(kind) {
        case .enabled:
            content()
        case .checking:
            HStack(spacing: theme.space.s) {
                SynqSpinner(ink: .secondary, size: 14)
                Text("Checking what this Synq server offers…").synqType(.caption, .secondary)
            }
        case .off(let reason):
            SynqPanel(label: "Not enabled") {
                HStack {
                    Text(BusinessTile.of(kind).title).synqType(.headline).lineLimit(1)
                    Spacer()
                    SynqBadge(kind: .neutral, text: "Off")
                }
                Text(reason).synqType(.body, .secondary).fixedSize(horizontal: false, vertical: true)
                Text("Nothing was sent. This feature runs on \(networkTitle(BusinessNetwork.label)) once the Synq server is updated.")
                    .synqType(.caption, .tertiary).fixedSize(horizontal: false, vertical: true)
                SynqButton(title: "Check again", icon: .refresh, kind: .compact) { business.loadCapabilities() }
            }
        }
    }
}

/// "12.50 USDC" with the statement-style two decimals.
func usdc(_ amount: String, _ symbol: String = "USDC") -> String { "\(cardAmount(amount)) \(symbol)" }

extension SynqBadgeKind {
    static func stance(_ s: String) -> SynqBadgeKind {
        switch s {
        case "PAY", "CLEAR": return .approved
        case "HOLD", "REVIEW": return .pending
        case "VETO": return .danger
        default: return .neutral
        }
    }
}

private func stanceWord(_ s: String) -> String {
    switch s {
    case "PAY": return "Pay"
    case "HOLD": return "Hold"
    case "VETO": return "Veto"
    case "REVIEW": return "Review"
    case "CLEAR": return "Clear"
    case "UNAVAILABLE": return "Unavailable"
    default: return "Info"
    }
}

// MARK: - Deal Room

struct DealRoomSheet: View {
    @ObservedObject var business: BusinessModel
    let actions: FundActions
    let onClose: () -> Void
    @State private var text: String
    @Environment(\.synqTheme) private var theme

    init(business: BusinessModel, sheet: BusinessSheet, actions: FundActions, onClose: @escaping () -> Void) {
        self.business = business
        self.actions = actions
        self.onClose = onClose
        _text = State(initialValue: sheet.text)
    }

    private let prompt = "Describe the work, total USDC, milestones and deadlines"

    var body: some View {
        SheetScaffold(title: "Deal room", onCancel: onClose) {
            SynqHeroArt(slot: .deal)
            SynqStack(spacing: \.m) {
                BusinessModeLine(network: business.network, mode: "Escrow on Arc")
                BusinessGate(business: business, kind: .deals) {
                    if let deal = business.deal {
                        DealResultView(deal: deal, network: business.network, onReview: actions.open)
                        SynqButton(title: "Draft another", icon: .refresh, kind: .compact) { business.deal = nil }
                    } else {
                        form
                    }
                }
                if let error = business.error { SynqNote(text: error, error: true) }
                SynqNote(text: "Both parties sign the exact terms in their own wallets on the Synq page. Escrow is funded and released only from there.")
            }
        }
    }

    @ViewBuilder
    private var form: some View {
        SynqPanel(label: "New deal") {
            Text("Describe the work, the total and the milestones").synqType(.headline)
            Text("Synq drafts terms from your words only, then both sides review and sign.")
                .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
            SynqCommandField(text: $text, placeholder: prompt, busy: business.busy == .deals,
                             onSubmit: { business.draftDeal(text) }, onFocus: {})
        }
        SynqButton(title: business.busy == .deals ? "Drafting…" : "Draft the deal", icon: .deal, trailingIcon: .forward,
                   busy: business.busy == .deals) { business.draftDeal(text) }
            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || business.busy != nil)
    }
}

struct DealResultView: View {
    let deal: DealDraft
    let network: String
    let onReview: (URL) -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        if deal.drafted, let url = deal.reviewURL {
            SynqPanel(label: "Draft deal") {
                HStack(alignment: .top) {
                    Text(deal.title ?? "Deal").synqType(.headline).lineLimit(2)
                    Spacer()
                    SynqBadge(kind: .pending, text: "Unsigned")
                }
                Text("\(deal.client ?? "Client") pays \(deal.freelancer ?? "freelancer") · arbiter \(deal.arbiter ?? "none")")
                    .synqType(.caption, .secondary).lineLimit(2)
                if let total = deal.total { SynqAmount(amount: cardAmount(total), unit: deal.symbol ?? "USDC") }
            }
            if let ms = deal.milestones, !ms.isEmpty {
                SynqSectionLabel(text: "Milestones", trailing: "\(ms.count)")
                SynqGroup {
                    ForEach(Array(ms.enumerated()), id: \.element.id) { i, m in
                        SynqRow(icon: .clock, title: "\(i + 1). \(m.title)",
                                subtitle: m.due.map { "Due \(TripFormat.day($0))" },
                                trailing: .text(usdc(m.amount, deal.symbol ?? "USDC")), divider: i > 0)
                    }
                }
            }
            ForEach(deal.ambiguities ?? [], id: \.self) { a in SynqNote(text: "Check: \(a)") }
            SynqButton(title: "Review and sign", icon: .passkey, trailingIcon: .external, kind: .primary) { onReview(url) }
        } else {
            SynqPanel(label: "Not drafted") {
                Text(deal.reason ?? "Synq could not draft a deal from that.").synqType(.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

// MARK: - Get paid

struct GetPaidSheet: View {
    @ObservedObject var business: BusinessModel
    let actions: FundActions
    let onClose: () -> Void
    @State private var payer: String
    @State private var amount: String
    @State private var note: String
    @Environment(\.synqTheme) private var theme

    init(business: BusinessModel, sheet: BusinessSheet, actions: FundActions, onClose: @escaping () -> Void) {
        self.business = business
        self.actions = actions
        self.onClose = onClose
        _payer = State(initialValue: sheet.payer)
        _amount = State(initialValue: sheet.amount)
        _note = State(initialValue: sheet.note)
    }

    private var normalized: String? { normalizedAmount(amount, max: 10_000) }
    private var canCreate: Bool {
        normalized != nil && !payer.trimmingCharacters(in: .whitespaces).isEmpty
            && !note.trimmingCharacters(in: .whitespaces).isEmpty && business.busy == nil
    }

    var body: some View {
        SheetScaffold(title: "Get paid", onCancel: onClose) {
            SynqHeroArt(slot: .receipt)
            SynqStack(spacing: \.m) {
                BusinessModeLine(network: business.network, mode: "USDC checkout")
                BusinessGate(business: business, kind: .invoices) {
                    if let invoice = business.invoice {
                        InvoiceResultView(invoice: invoice, busy: business.busy == .invoices,
                                          onIssue: actions.open, onRefresh: business.refreshInvoice,
                                          onShare: { actions.insertInvoice(invoice) }, onCheckout: actions.open)
                        SynqButton(title: "New invoice", icon: .plus, kind: .compact) { business.invoice = nil }
                    } else {
                        form
                    }
                }
                if let error = business.error { SynqNote(text: error, error: true) }
            }
        }
    }

    @ViewBuilder
    private var form: some View {
        SynqGroup(emphasis: true) {
            SynqField(label: "Bill to", icon: .people, text: $payer, placeholder: "Customer name")
            SynqField(label: "Amount", icon: .money, text: $amount, placeholder: "120.00", detail: "USDC",
                      keyboard: .decimal, large: true, divider: true)
            SynqField(label: "For", icon: .receipt, text: $note, placeholder: "Logo design", divider: true)
        }
        Text("Paid in USDC on \(networkTitle(BusinessNetwork.label)) into the business vault · up to 10,000 per invoice")
            .synqType(.caption, .secondary)
        SynqButton(title: business.busy == .invoices ? "Creating…" : "Create invoice", icon: .receipt, trailingIcon: .forward,
                   busy: business.busy == .invoices) {
            if let n = normalized { business.createInvoice(payer: payer, amount: n, description: note) }
        }
        .disabled(!canCreate)
    }
}

struct InvoiceResultView: View {
    let invoice: BusinessInvoice
    let busy: Bool
    let onIssue: (URL) -> Void
    let onRefresh: () -> Void
    let onShare: () -> Void
    let onCheckout: (URL) -> Void
    @Environment(\.synqTheme) private var theme

    private var badge: SynqBadgeKind {
        switch invoice.status {
        case "PAID": return .approved
        case "OVERPAID", "VOID": return .danger
        case "DRAFT": return .neutral
        default: return .pending
        }
    }

    var body: some View {
        SynqPanel(label: "Invoice") {
            HStack(alignment: .top) {
                Text("Invoice \(invoice.number)").synqType(.headline).lineLimit(1).minimumScaleFactor(0.7)
                Spacer()
                SynqBadge(kind: badge, text: invoice.statusText)
            }
            Text(["to \(invoice.payer)", invoice.dueDate.map { "due \($0)" }].compactMap { $0 }.joined(separator: " · "))
                .synqType(.caption, .secondary).lineLimit(1)
            SynqAmount(amount: cardAmount(invoice.total), unit: invoice.symbol)
        }
        SynqGroup {
            if let d = invoice.description, !d.isEmpty {
                SynqRow(icon: .receipt, title: d, subtitle: "Line item", trailing: .text(usdc(invoice.total, invoice.symbol)))
            }
            SynqRow(icon: .bank, title: invoice.issuer ?? "Business", subtitle: invoice.payTo.map { "Pays into \(shortId($0))" },
                    trailing: .none, divider: invoice.description?.isEmpty == false)
        }
        if let pay = invoice.payURL {
            SynqButton(title: "Share checkout link", icon: .share, trailingIcon: .forward, kind: .primary, action: onShare)
            SynqButton(title: "Open checkout", trailingIcon: .external) { onCheckout(pay) }
            SynqNote(text: "The payer pays the exact amount in USDC on the Synq page. Synq marks it paid only from the Arc receipt.")
        } else if invoice.status == "DRAFT" {
            if let issue = invoice.issueURL {
                SynqButton(title: "Sign to issue", icon: .passkey, trailingIcon: .external, kind: .primary) { onIssue(issue) }
            }
            SynqButton(title: busy ? "Checking…" : "Refresh", icon: .refresh, kind: .compact, busy: busy, action: onRefresh)
            SynqNote(text: "Draft: the issuer's wallet signs the exact terms on the Synq page. The checkout link appears after that.")
        }
    }
}

/// The INVOICE card shown in the transcript for a shared checkout link.
func invoiceCard(number: String?, payer: String?, amount: String?, symbol: String?, status: String?) -> SynqCardModel {
    let word: String
    let badge: SynqBadgeKind
    switch status {
    case "PAID": (word, badge) = ("Paid", .approved)
    case "PARTIALLY_PAID": (word, badge) = ("Partial", .pending)
    case "OVERPAID": (word, badge) = ("Overpaid", .danger)
    case "VOID": (word, badge) = ("Void", .danger)
    case "ISSUED": (word, badge) = ("Due", .pending)
    default: (word, badge) = ("Pay", .pending)
    }
    let title = payer.map { "To \($0)" } ?? "Invoice"
    let label = "Synq invoice \(number ?? "") \(title). \(amount.map { "Amount \($0) \(symbol ?? "USDC"). " } ?? "")"
        + "Status \(word). Network Arc testnet."
    return SynqCardModel(art: .receipt, eyebrow: "Invoice \(number ?? "")", title: title,
                         amount: amount.map(cardAmount), unit: symbol ?? "USDC",
                         detail: status == "PAID" ? "Settled on chain" : "Pay with USDC on Synq",
                         badge: badge, status: word, progress: nil, network: "Arc Testnet", accessibilityLabel: label)
}

/// Transcript bubble for a shared invoice: live status once fetched, the sender's hint before.
struct InvoiceBubble: View {
    let link: InvoiceLink
    let status: CheckoutStatus?

    /// What is still due; a settled invoice shows its total.
    private var shownAmount: String? {
        guard let status else { return link.amount }
        if status.status == "PAID" || status.status == "OVERPAID" { return status.total }
        return status.amountDue ?? status.total
    }

    var body: some View {
        SynqCardBubble(model: invoiceCard(number: status?.number ?? link.number, payer: status?.payer ?? link.payer,
                                          amount: shownAmount,
                                          symbol: status?.asset?.symbol ?? link.symbol, status: status?.status))
    }
}

/// Expanded view of a shared invoice card: what is owed and the checkout page.
struct InvoiceLinkView: View {
    let link: InvoiceLink
    let status: CheckoutStatus?
    let error: String?
    let onCheckout: () -> Void
    let onRefresh: () -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqScreen {
            VStack(alignment: .leading, spacing: theme.space.l) {
                SynqHeader(title: "Invoice")
                SynqHeroArt(slot: .receipt)
                SynqStack(spacing: \.m) {
                    BusinessModeLine(network: BusinessNetwork.label, mode: status == nil ? "Checking…" : "Live testnet state")
                    SynqPanel(label: "Invoice") {
                        HStack(alignment: .top) {
                            Text("Invoice \(status?.number ?? link.number ?? "")").synqType(.headline).lineLimit(1)
                            Spacer()
                            SynqBadge(kind: invoiceCard(number: nil, payer: nil, amount: nil, symbol: nil, status: status?.status).badge,
                                      text: invoiceCard(number: nil, payer: nil, amount: nil, symbol: nil, status: status?.status).status)
                        }
                        if let payer = status?.payer ?? link.payer {
                            Text(["to \(payer)", status?.dueDate.map { "due \($0)" }].compactMap { $0 }.joined(separator: " · "))
                                .synqType(.caption, .secondary)
                        }
                        if let due = status?.amountDue ?? link.amount {
                            SynqAmount(amount: cardAmount(due), unit: status?.asset?.symbol ?? link.symbol ?? "USDC")
                        }
                    }
                    if status == nil {
                        SynqNote(text: "Amounts shown come from the shared card until Synq confirms them.")
                    }
                    if let error { SynqNote(text: error, error: true) }
                    SynqButton(title: "Pay invoice", icon: .passkey, trailingIcon: .forward, kind: .primary, action: onCheckout)
                    SynqButton(title: "Refresh", icon: .refresh, kind: .compact, action: onRefresh)
                    SynqNote(text: "Pay only through the Synq page: its Memo reference binds the payment to this invoice.")
                }
            }
            .padding(.vertical, theme.space.m)
            .synqScroll()
        }
    }
}

// MARK: - Finance team

struct TeamSheet: View {
    @ObservedObject var business: BusinessModel
    let sheet: BusinessSheet
    let actions: FundActions
    let onClose: () -> Void
    @State private var question: String
    @Environment(\.synqTheme) private var theme
    @Environment(\.synqRenderMode) private var mode

    init(business: BusinessModel, sheet: BusinessSheet, actions: FundActions, onClose: @escaping () -> Void) {
        self.business = business
        self.sheet = sheet
        self.actions = actions
        self.onClose = onClose
        _question = State(initialValue: sheet.autoRun ? "" : sheet.text)
    }

    private let ideas = ["Review open payment requests", "What is reserved in this workspace?",
                         "What can the finance team do right now?"]

    var body: some View {
        SheetScaffold(title: "Finance team", onCancel: onClose) {
            SynqHeroArt(slot: .agent)
            SynqStack(spacing: \.m) {
                BusinessModeLine(network: business.network, mode: "Read only")
                BusinessGate(business: business, kind: .team) {
                    SynqCommandField(text: $question, placeholder: "Ask your CFO and Risk Agent…", busy: business.busy == .team,
                                     onSubmit: submit, onFocus: {})
                    if business.busy == .team {
                        TeamThinking(question: business.teamQuestion ?? question)
                    } else if let result = business.team {
                        if let q = business.teamQuestion { SynqEcho(text: q) }
                        TeamResultView(result: result, onApprove: actions.open)
                    } else {
                        VStack(alignment: .leading, spacing: theme.space.s) {
                            SynqSectionLabel(text: "Try")
                            ForEach(ideas, id: \.self) { idea in SynqChip(title: idea, icon: .team) { question = idea } }
                        }
                    }
                }
                if let error = business.error { SynqNote(text: error, error: true) }
            }
        }
        .onAppear {
            if sheet.autoRun, !mode.isStill, business.team == nil || business.teamQuestion != sheet.text {
                business.ask(sheet.text)
            }
        }
    }

    private func submit() {
        let q = question
        question = ""
        business.ask(q)
    }
}

struct TeamThinking: View {
    let question: String
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqPanel(label: "Council") {
            SynqEcho(text: question)
            HStack(spacing: theme.space.s) {
                SynqSpinner(ink: .secondary, size: 14)
                Text("CFO and Risk are reading the live Arc snapshot…").synqType(.caption, .secondary)
            }
            SynqScanBar()
        }
    }
}

/// CFO and Risk in their own words; the Decision panel only from the Kernel's structured verdict.
struct TeamResultView: View {
    let result: TeamResult
    let onApprove: (URL) -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        if result.status != "ANSWERED", result.specialists.isEmpty {
            SynqPanel(label: result.status == "STOPPED" ? "Stopped" : "Needs detail") {
                Text(result.answer ?? "The team needs more detail.").synqType(.body).fixedSize(horizontal: false, vertical: true)
            }
        }
        ForEach(result.specialists) { s in
            SynqPanel(label: s.persona == "RISK" ? "Risk Agent" : s.label) {
                HStack {
                    Text(stanceHeadline(s)).synqType(.bodyStrong)
                    Spacer()
                    SynqBadge(kind: .stance(s.stance), text: stanceWord(s.stance))
                }
                Text(s.text).synqType(.body, .secondary).fixedSize(horizontal: false, vertical: true)
                if let e = s.evidence, !e.isEmpty {
                    Text(e.count == 1 ? "1 cited fact" : "\(e.count) cited facts").synqType(.caption, .tertiary)
                }
            }
        }
        if result.status == "ANSWERED" || result.decision.status != "NOT_SUBMITTED" || !result.decision.reasons.isEmpty {
            DecisionPanel(decision: result.decision, riskCase: result.riskCase)
        }
        if let approval = result.approvalURL {
            SynqButton(title: "Review and sign in your wallet", icon: .passkey, trailingIcon: .external, kind: .primary) {
                onApprove(approval)
            }
        }
        if let off = result.unavailable, !off.isEmpty {
            SynqNote(text: "Unavailable: \(off.joined(separator: "; ")).")
        }
        SynqNote(text: "Read only: the team advises; it cannot pay from here. Payouts need the owner's wallet signature.")
    }

    private func stanceHeadline(_ s: TeamSection) -> String {
        switch s.stance {
        case "PAY": return "Recommends paying"
        case "HOLD": return "Recommends holding"
        case "VETO": return "Vetoes this payment"
        case "REVIEW": return "Wants a review"
        case "CLEAR": return "No risk flags"
        case "UNAVAILABLE": return "Could not assess"
        default: return "Note"
        }
    }
}

struct DecisionPanel: View {
    let decision: TeamDecision
    let riskCase: TeamRiskCase?
    @Environment(\.synqTheme) private var theme

    private var badge: SynqBadgeKind {
        switch decision.tone {
        case "DANGER": return .danger
        case "APPROVED": return .approved
        default: return .pending
        }
    }

    var body: some View {
        SynqPanel(label: "Decision · Kernel") {
            HStack(alignment: .top) {
                Text(decision.headline).synqType(.headline).fixedSize(horizontal: false, vertical: true)
                Spacer()
                SynqBadge(kind: badge, text: decision.badge)
            }
            ForEach(decision.reasons.prefix(4), id: \.self) { r in
                Text("· \(r)").synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let c = riskCase {
                SynqDivider()
                HStack {
                    SynqIconView(icon: .shield, size: 14, ink: .secondary)
                    Text("Risk case \(shortId(c.caseId)) · \(c.outcome.lowercased().replacingOccurrences(of: "_", with: " "))\(c.froze ? " · payouts held" : "")")
                        .synqType(.caption, .secondary).lineLimit(2)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Split income

struct SplitSheet: View {
    @ObservedObject var business: BusinessModel
    let sheet: BusinessSheet
    let onClose: () -> Void
    @State private var amount: String
    @Environment(\.synqTheme) private var theme
    @Environment(\.synqRenderMode) private var mode

    init(business: BusinessModel, sheet: BusinessSheet, onClose: @escaping () -> Void) {
        self.business = business
        self.sheet = sheet
        self.onClose = onClose
        _amount = State(initialValue: sheet.amount)
    }

    private var normalized: String? { normalizedAmount(amount, max: 1_000_000) }

    var body: some View {
        SheetScaffold(title: "Split income", onCancel: onClose) {
            SynqHeroArt(slot: .fund)
            SynqStack(spacing: \.m) {
                BusinessModeLine(network: business.network, mode: "Preview only")
                BusinessGate(business: business, kind: .splits) {
                    SynqGroup(emphasis: true) {
                        SynqField(label: "If this payment lands", icon: .money, text: $amount, placeholder: "1500.00",
                                  detail: "USDC", keyboard: .decimal, large: true)
                    }
                    SynqButton(title: business.busy == .splits ? "Working it out…" : "Preview the split", icon: .split,
                               trailingIcon: .forward, busy: business.busy == .splits) {
                        if let n = normalized { business.previewSplit(n) }
                    }
                    .disabled(normalized == nil || business.busy != nil)
                    if let split = business.split { SplitResultView(split: split) }
                }
                if let error = business.error { SynqNote(text: error, error: true) }
            }
        }
        .onAppear {
            if sheet.autoRun, !mode.isStill, let n = normalized, business.split?.amount != n { business.previewSplit(n) }
        }
    }
}

struct SplitResultView: View {
    let split: SplitPreview
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqPanel(label: "Waterfall") {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: theme.space.xxs) {
                    Text("Gross receipt").synqType(.caption, .secondary)
                    SynqAmount(amount: cardAmount(split.amount), unit: split.symbol)
                }
                Spacer()
                SynqBadge(kind: .pending, text: split.label)
            }
            if let p = split.policy {
                Text(policyLine(p)).synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        SynqGroup {
            ForEach(Array(split.legs.enumerated()), id: \.element.id) { i, leg in
                SynqRow(icon: icon(leg), title: leg.label, subtitle: leg.basis.map { String($0.prefix(90)) },
                        trailing: .text(usdc(leg.amount, split.symbol)), divider: i > 0)
            }
        }
        if let f = split.forecast, !f.isEmpty {
            SynqSectionLabel(text: "Cash forecast")
            SynqGroup {
                ForEach(Array(f.enumerated()), id: \.element.id) { i, p in
                    SynqRow(icon: .calendar, title: "\(p.days) days",
                            subtitle: [p.expected.map { "expected \(cardAmount($0))" }, p.lowPoint.map { "low \(cardAmount($0))" }]
                                .compactMap { $0 }.joined(separator: " · "),
                            trailing: .text(usdc(p.committed, split.symbol)), divider: i > 0)
                }
            }
        }
        ForEach(split.notes ?? [], id: \.self) { SynqNote(text: $0) }
    }

    private func policyLine(_ p: SplitPolicyView) -> String {
        var parts: [String] = []
        if let t = p.taxReserveBps { parts.append("tax reserve " + (t % 100 == 0 ? String(t / 100) : String(Double(t) / 100)) + "%") }
        if let f = p.operatingFloor { parts.append("floor \(cardAmount(f))") }
        if let h = p.horizonDays { parts.append("bills due within \(h) days") }
        return "Demo policy: " + parts.joined(separator: " · ")
    }

    private func icon(_ leg: SplitLeg) -> SynqIcon {
        switch leg.purpose {
        case "TAX_ESTIMATE": return .receipt
        case "CONTRACTOR_PAYABLE", "PAYABLE_HELD": return .contractor
        case "UPCOMING_BILL": return .calendar
        case "OPERATING_FLOOR": return .shield
        case "DISTRIBUTION": return .people
        default: return .money
        }
    }
}

// MARK: - Treasury

struct TreasurySheet: View {
    @ObservedObject var business: BusinessModel
    let actions: FundActions
    let onClose: () -> Void
    @Environment(\.synqTheme) private var theme
    @Environment(\.synqRenderMode) private var mode

    var body: some View {
        SheetScaffold(title: "Treasury", onCancel: onClose,
                      actions: [SynqHeaderAction(icon: .refresh, label: "Refresh balances") { business.loadTreasury() }]) {
            SynqHeroArt(slot: .fund)
            SynqStack(spacing: \.m) {
                BusinessModeLine(network: business.network, mode: "Live testnet state")
                BusinessGate(business: business, kind: .treasury) {
                    if let t = business.treasury {
                        TreasuryContent(treasury: t, onExplorer: actions.open)
                    } else if business.busy == .treasury || business.error == nil {
                        HStack(spacing: theme.space.s) {
                            SynqSpinner(ink: .secondary, size: 14)
                            Text("Reading balances from Arc…").synqType(.caption, .secondary)
                        }
                    }
                }
                if let error = business.error { SynqNote(text: error, error: true) }
            }
        }
        .onAppear { if !mode.isStill, business.treasury == nil { business.loadTreasury() } }
    }
}

struct TreasuryContent: View {
    let treasury: TreasuryView
    let onExplorer: (URL) -> Void
    @Environment(\.synqTheme) private var theme

    var body: some View {
        if let vault = treasury.accounts.first {
            SynqPanel(label: vault.label) {
                Text(shortId(vault.address)).synqType(.caption, .secondary)
                SynqAmount(amount: vault.usdc.map(cardAmount) ?? "-", unit: "USDC")
                if let p = treasury.vaultPolicy {
                    HStack {
                        Text("Per payment \(cardAmount(p.perPaymentCap)) · 24h \(cardAmount(p.windowCap))").synqType(.caption, .secondary)
                        Spacer()
                        SynqBadge(kind: p.paused ? .danger : .live, text: p.paused ? "Paused" : "Guarded")
                    }
                    Text("\(cardAmount(p.remaining)) USDC left in today's window").synqType(.caption, .tertiary)
                }
            }
        }
        if treasury.accounts.count > 1 {
            SynqSectionLabel(text: "Accounts")
            SynqGroup {
                ForEach(Array(treasury.accounts.dropFirst().enumerated()), id: \.element.id) { i, a in
                    SynqRow(icon: .bank, title: a.label, subtitle: shortId(a.address),
                            trailing: .text(a.usdc.map { usdc($0) } ?? "-"), divider: i > 0) {
                        if let e = a.explorer.flatMap(BusinessLinks.https) { onExplorer(e) }
                    }
                }
            }
        }
        SynqSectionLabel(text: "Circle Earn", trailing: "\(treasury.earn.count)")
        SynqGroup {
            ForEach(Array(treasury.earn.enumerated()), id: \.element.id) { i, v in
                SynqRow(icon: .split, title: v.name,
                        subtitle: [v.apy.map { "APY \($0) · variable" }, v.totalAssets.map { "holds \(cardAmount($0)) USDC" }, v.note]
                            .compactMap { $0 }.first,
                        trailing: v.underlyingOk == false ? .badge(.danger, "Mismatch") : .badge(.neutral, "USDC"),
                        divider: i > 0)
            }
        }
        if let u = treasury.usyc {
            SynqPanel(label: "USYC") {
                HStack {
                    Text("Tokenized T-bill fund").synqType(.bodyStrong)
                    Spacer()
                    SynqBadge(kind: u.status == "ELIGIBLE" ? .approved : u.status == "INELIGIBLE" ? .danger : .neutral,
                              text: u.status == "ELIGIBLE" ? "Eligible" : u.status == "INELIGIBLE" ? "Not eligible" : "Unavailable")
                }
                Text(u.explanation).synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        if let b = treasury.blockNumber {
            Text("Read at block \(b) · amounts are exact").synqType(.caption, .tertiary)
        }
    }
}

// MARK: - Pay a contractor

struct ContractorSheet: View {
    @ObservedObject var business: BusinessModel
    let sheet: BusinessSheet
    let actions: FundActions
    let onClose: () -> Void
    @State private var vendor: BusinessVendor?
    @State private var amount: String
    @Environment(\.synqTheme) private var theme
    @Environment(\.synqRenderMode) private var mode

    init(business: BusinessModel, sheet: BusinessSheet, actions: FundActions, onClose: @escaping () -> Void,
         selected: BusinessVendor? = nil) {
        self.business = business
        self.sheet = sheet
        self.actions = actions
        self.onClose = onClose
        _amount = State(initialValue: sheet.amount)
        _vendor = State(initialValue: selected)
    }

    private var verified: [BusinessVendor] { (business.vendors ?? []).filter(\.verified) }
    private var normalized: String? { normalizedAmount(amount, max: 10_000) }

    var body: some View {
        SheetScaffold(title: "Pay a contractor", onCancel: onClose) {
            SynqHeroArt(slot: .risk)
            SynqStack(spacing: \.m) {
                BusinessModeLine(network: business.network, mode: "Governed vault")
                BusinessGate(business: business, kind: .contractors) {
                    if business.vendors == nil {
                        HStack(spacing: theme.space.s) {
                            SynqSpinner(ink: .secondary, size: 14)
                            Text("Loading verified vendors…").synqType(.caption, .secondary)
                        }
                    } else if verified.isEmpty {
                        SynqNote(text: "No verified vendors yet. A vendor is payable only after the vault's owners add its address.")
                    } else {
                        SynqSectionLabel(text: "Verified vendors", trailing: "\(verified.count)")
                        SynqGroup {
                            ForEach(Array(verified.enumerated()), id: \.element.id) { i, v in
                                SynqRow(icon: .contractor, title: v.name, subtitle: "\(shortId(v.address)) · \(v.source ?? "verified")",
                                        trailing: vendor == v ? .badge(.approved, "Chosen") : .arrow, divider: i > 0) {
                                    vendor = v
                                }
                            }
                        }
                        SynqGroup(emphasis: true) {
                            SynqField(label: "Amount", icon: .money, text: $amount, placeholder: "100.00", detail: "USDC",
                                      keyboard: .decimal, large: true)
                        }
                        SynqButton(title: business.busy == .team ? "Asking CFO and Risk…" : "Ask CFO and Risk first",
                                   icon: .team, trailingIcon: .forward, busy: business.busy == .team) {
                            if let v = vendor, let n = normalized { business.askToPay(v, amount: n) }
                        }
                        .disabled(vendor == nil || normalized == nil || business.busy != nil)
                        if business.busy == .team {
                            TeamThinking(question: business.teamQuestion ?? "")
                        } else if let result = business.team, business.teamQuestion?.hasPrefix("Should we pay") == true {
                            TeamResultView(result: result, onApprove: actions.open)
                            if result.approvalURL == nil {
                                SynqNote(text: "No approval page yet: the Kernel did not propose this payout. Nothing was sent.")
                            }
                        }
                    }
                }
                if let error = business.error { SynqNote(text: error, error: true) }
            }
        }
        .onAppear { if !mode.isStill, business.vendors == nil { business.loadVendors() } }
    }
}
