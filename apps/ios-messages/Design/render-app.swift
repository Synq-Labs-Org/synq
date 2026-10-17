import AppKit
import SwiftUI
import SynqContracts

// Design previews of the full-screen app, rendered from the app's own SwiftUI
// screens with the contract's generated fixtures (packages/contracts/generated/
// fixtures: synthetic LOCAL_FIXTURE data, never shipped). Every image carries a
// "Preview · LOCAL_FIXTURE" strip so it can't be mistaken for live data.

let fixtureDir = URL(fileURLWithPath: "../../packages/contracts/generated/fixtures")

@MainActor
func fixture<T: Decodable>(_ name: String, _ type: T.Type) -> T {
    let data = try! Data(contentsOf: fixtureDir.appendingPathComponent("\(name).json"))
    return try! JSONDecoder().decode(T.self, from: data)
}

/// Status bar, the screen, and a drawn tab strip (ImageRenderer cannot draw the system tab bar).
struct AppPhone<Content: View>: View {
    @Environment(\.synqTheme) private var theme
    var tabs: [SynqTabItem<AppTab>] = []
    var selected: AppTab? = nil
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack(alignment: .top) {
            theme.colors.background
            VStack(spacing: 0) {
                StatusBar().frame(height: 54)
                Text("Preview · LOCAL_FIXTURE data")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(theme.colors.inkTertiary)
                    .frame(maxWidth: .infinity).padding(.vertical, 2)
                    .background(theme.colors.panel)
                content().frame(maxHeight: .infinity, alignment: .top).clipped()
                if !tabs.isEmpty {
                    VStack(spacing: 0) {
                        Rectangle().fill(theme.colors.line).frame(height: 0.5)
                        HStack {
                            ForEach(tabs) { t in
                                VStack(spacing: 3) {
                                    Image(systemName: theme.icons.name(t.icon)).font(.system(size: 19))
                                    Text(t.title).font(.system(size: 10, weight: .medium))
                                }
                                .foregroundStyle(t.id == selected ? theme.colors.inkPrimary : theme.colors.inkTertiary)
                                .frame(maxWidth: .infinity)
                            }
                        }
                        .padding(.top, 7).padding(.bottom, 26)
                    }
                    .background(theme.colors.panel)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 54, style: .continuous))
    }
}

@MainActor
func previewApp(phase: SynqAppModel.Phase? = nil) -> SynqAppModel {
    let host = "synq.example"
    let defaults = UserDefaults(suiteName: "synq.design.app")!
    let api = SynqAPI(host: host, store: SessionStore(host: host, secrets: MemorySecretStore()))
    return SynqAppModel(host: host, api: api, defaults: defaults)
}

/// The theme's semantic tokens as JSON (colours as sRGB hex), so the web hub can
/// check its CSS custom properties against the same values.
@MainActor
func writeTokens(_ t: any SynqTheme, to url: URL) {
    func hex(_ c: Color) -> String {
        let n = NSColor(c).usingColorSpace(.sRGB)!
        return String(format: "#%02X%02X%02X", Int(round(n.redComponent * 255)), Int(round(n.greenComponent * 255)),
                      Int(round(n.blueComponent * 255)))
    }
    let c = t.colors
    let colors: [String: String] = [
        "background": hex(c.background), "panel": hex(c.panel), "inkPrimary": hex(c.inkPrimary),
        "inkSecondary": hex(c.inkSecondary), "inkTertiary": hex(c.inkTertiary), "line": hex(c.line),
        "lineStrong": hex(c.lineStrong), "approved": hex(c.approved), "approvedFill": hex(c.approvedFill),
        "approvedLine": hex(c.approvedLine), "pending": hex(c.pending), "danger": hex(c.danger),
        "accent": hex(c.accent), "onAccent": hex(c.onAccent),
    ]
    var type: [String: [String: Any]] = [:]
    for role in SynqTypeRole.allCases {
        let spec = t.type[role]
        type["\(role)"] = ["family": spec.family ?? "system-\(spec.fallback)", "size": spec.size,
                           "tracking": spec.tracking, "uppercase": spec.uppercase, "fixed": spec.fixed]
    }
    let doc: [String: Any] = [
        "theme": t.id, "colorScheme": t.colorScheme == .dark ? "dark" : "light", "colors": colors, "type": type,
        "space": ["xxs": t.space.xxs, "xs": t.space.xs, "s": t.space.s, "m": t.space.m, "l": t.space.l,
                  "xl": t.space.xl, "xxl": t.space.xxl, "gutter": t.space.gutter],
        "radius": ["panel": t.radius.panel, "control": t.radius.control, "badge": t.radius.badge, "key": t.radius.key,
                   "bubble": t.radius.bubble],
        "lines": ["hairline": t.lines.hairline, "control": t.lines.control, "ruleDash": t.lines.ruleDash],
    ]
    let data = try! JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys])
    try! data.write(to: url)
}

@MainActor
func renderAppScreens(_ out: URL) {
    let dir = out.appendingPathComponent("4 App screens")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let personalTabs = AppTab.tabs(for: .personal).map { SynqTabItem(id: $0, title: $0.title, icon: $0.icon) }
    let businessTabs = AppTab.tabs(for: .business).map { SynqTabItem(id: $0, title: $0.title, icon: $0.icon) }

    func shot(_ name: String, height: CGFloat = phone.height, scale: CGFloat = 3, tabs: [SynqTabItem<AppTab>] = [],
              selected: AppTab? = nil, _ view: some View) {
        png(AppPhone(tabs: tabs, selected: selected) { view }, width: phone.width, height: height, scale: scale,
            to: dir.appendingPathComponent(name))
    }

    for t in SynqThemes.all { writeTokens(t, to: out.appendingPathComponent("tokens-\(t.id).json")) }

    let app = previewApp()
    let contexts = fixture("Contexts", Contexts.self)
    let personalCtx = WorkspaceContext(contexts.contexts[0], principalId: contexts.principalId)!
    let businessCtx = contexts.contexts.compactMap { WorkspaceContext($0, principalId: contexts.principalId) }.first { $0.isBusiness }
        ?? WorkspaceContext(principalId: "p", contextId: "w", kind: .business, workspaceId: "00000000-0000-4000-8000-000000000001",
                            displayName: "Example Studio", role: .owner, status: .active, unreadCount: 2)
    let now = Date()

    func header(_ ctx: WorkspaceContext) -> some View {
        SynqContextHeader(title: ctx.displayName,
                          kind: ctx.isBusiness ? "Business · \(ctx.role.map { $0.rawValue.capitalized } ?? "Member")" : "Personal",
                          network: "Testnet", onSwitch: {},
                          actions: [SynqHeaderAction(icon: .bell, label: "Notifications") {},
                                    SynqHeaderAction(icon: .settings, label: "Account") {}])
    }

    // Session states.
    shot("app-onboarding.png", OnboardingView(onDone: {}))
    shot("app-sign-in.png", SignInView(model: app, reason: .fresh))
    shot("app-sign-in-full.png", height: 1500, scale: 2, SignInView(model: app, reason: .fresh))
    shot("app-reauth.png", SignInView(model: app, reason: .expired))
    shot("app-revoked.png", SignInView(model: app, reason: .revoked))
    shot("app-locked.png", LockedView(model: app))

    // Personal.
    let overview = fixture("PersonalOverview", PersonalOverview.self)
    let personal = ContextScope.preview(personalCtx)
    personal.preset("personal.overview", route: "personal.overview", RemoteState<PersonalOverview>.loaded(overview, syncedAt: now))
    personal.preset("personal.circles", route: "personal.circles",
                    RemoteState<CirclePage>.loaded(CirclePage(items: overview.circles), syncedAt: now))
    shot("app-personal-home.png", tabs: personalTabs, selected: .home,
         VStack(spacing: 0) { header(personalCtx); PersonalHomeView(model: app, scope: personal) })
    shot("app-personal-home-full.png", height: 2100, scale: 2, tabs: personalTabs, selected: .home,
         VStack(spacing: 0) { header(personalCtx); PersonalHomeView(model: app, scope: personal) })
    shot("app-circles.png", tabs: personalTabs, selected: .circles,
         VStack(spacing: 0) { header(personalCtx); CirclesView(model: app, scope: personal) })
    shot("app-activity.png", tabs: personalTabs, selected: .activity,
         VStack(spacing: 0) { header(personalCtx); ActivityView(model: app, scope: personal) })
    shot("app-money.png", height: 1300, scale: 2, tabs: personalTabs, selected: .money,
         VStack(spacing: 0) { header(personalCtx); PersonalMoneyView(model: app, scope: personal) })
    if let c = overview.circles.first {
        let usdc = c.held
        let detail = CircleDetail(
            circle: c,
            members: [CircleMember(principalId: "p1", walletHint: "0x12ab…9f3c", role: .owner, contributed: "25000000", refunded: "0"),
                      CircleMember(principalId: "p2", walletHint: "0x77cd…01aa", role: .member, contributed: "25000000", refunded: "5000000")],
            contributions: [CircleContribution(contributionId: "k1", payerHint: "0x12ab…9f3c",
                                               amount: Money(assetId: usdc?.assetId ?? "arc-testnet:USDC", symbol: "USDC", chainId: 5042002, decimals: 6, units: "25000000"),
                                               status: .credited, txHash: "0x" + String(repeating: "a1", count: 32), observedAt: "2026-10-16T09:00:00Z"),
                            CircleContribution(contributionId: "k2", payerHint: "0x77cd…01aa",
                                               amount: Money(assetId: "arc-testnet:USDC", symbol: "USDC", chainId: 5042002, decimals: 6, units: "10000000"),
                                               status: .pending, observedAt: "2026-10-17T09:00:00Z")],
            proposals: [CircleProposal(proposalId: "pr1", kind: .payment, title: "Villa deposit",
                                       amount: Money(assetId: "arc-testnet:USDC", symbol: "USDC", chainId: 5042002, decimals: 6, units: "30000000"),
                                       recipientHint: "0x3333…3333", approvals: 1, threshold: c.threshold ?? 2, status: .review),
                        CircleProposal(proposalId: "pr2", kind: .refund, title: "Refund to 0x77cd…01aa",
                                       amount: Money(assetId: "arc-testnet:USDC", symbol: "USDC", chainId: 5042002, decimals: 6, units: "5000000"),
                                       approvals: 2, threshold: c.threshold ?? 2, status: .confirmed, txHash: "0x" + String(repeating: "b2", count: 32))],
            capabilities: ["refunds": Capability(status: .available, reason: "Refunds pay back the wallet that contributed."),
                           "bookings": Capability(status: .notConfigured, reason: "Travel booking is not set up for this circle.")])
        personal.preset("personal.circle:\(c.circleId)", route: "personal.circle", RemoteState<CircleDetail>.loaded(detail, syncedAt: now))
        shot("app-circle-detail-full.png", height: 2100, scale: 2,
             CircleDetailView(model: app, scope: personal, circleId: c.circleId))
    }
    // A planned route: honest "not available yet".
    let planned = ContextScope.preview(personalCtx)
    planned.preset("personal.overview", route: "personal.overview", RemoteState<PersonalOverview>.notYet(routeId: "personal.overview"))
    planned.preset("v2.groups", route: "v2.workspaces", RemoteState<[WorkspaceSummary]>.failed(.offline, previous: nil, syncedAt: nil))
    shot("app-personal-not-yet.png", tabs: personalTabs, selected: .home,
         VStack(spacing: 0) { header(personalCtx); SynqBanner(icon: .warning, text: "Offline. Showing what was last synced; nothing can be approved or sent."); PersonalHomeView(model: app, scope: planned) })

    // Approvals.
    let approvals = fixture("ApprovalPage", ApprovalPage.self)
    personal.preset("approvals.list", route: "approvals.list", RemoteState<ApprovalPage>.loaded(approvals, syncedAt: now))
    shot("app-approvals.png", tabs: personalTabs, selected: .approvals,
         VStack(spacing: 0) { header(personalCtx); ApprovalsView(model: app, scope: personal) })
    let signing = fixture("SigningRequest", SigningRequest.self)
    shot("app-approval-terms-full.png", height: 1700, scale: 2,
         SheetScaffold(title: "Approval", onCancel: {}) {
             SynqStack(spacing: \.m) {
                 ApprovalTerms(request: signing)
                 SynqNote(text: NoWalletSigner().availability.reason)
                 SynqButton(title: "Review and sign on the Synq page", icon: .external, trailingIcon: .forward) {}
                 SynqNote(text: "Face ID, App Lock and signing in never approve a payment.")
             }
         })

    // Business.
    let business = ContextScope.preview(businessCtx)
    business.preset("workspace.overview", route: "workspace.overview",
                    RemoteState<WorkspaceOverview>.loaded(fixture("WorkspaceOverview", WorkspaceOverview.self), syncedAt: now))
    business.preset("workspace.inbox:all", route: "workspace.inbox",
                    RemoteState<InboxPage>.loaded(fixture("InboxPage", InboxPage.self), syncedAt: now))
    let run = fixture("AgentRunDetail", AgentRunDetail.self)
    business.preset("workspace.agentRuns", route: "workspace.agentRuns",
                    RemoteState<AgentRunPage>.loaded(AgentRunPage(items: [run.run]), syncedAt: now))
    business.preset("workspace.mandates", route: "workspace.mandates",
                    RemoteState<Mandates>.loaded(fixture("Mandates", Mandates.self), syncedAt: now))
    business.preset("workspace.agentRun:\(run.run.runId)", route: "workspace.agentRun", RemoteState<AgentRunDetail>.loaded(run, syncedAt: now))
    let lead = fixture("LeadDetail", LeadDetail.self)
    business.preset("workspace.lead:\(lead.lead.leadId)", route: "workspace.lead", RemoteState<LeadDetail>.loaded(lead, syncedAt: now))
    business.preset("v2.deals", route: "v2.deals", RemoteState<[WorkspaceDeal]>.notYet(routeId: "v2.deals"))
    shot("app-business-home.png", tabs: businessTabs, selected: .home,
         VStack(spacing: 0) { header(businessCtx); BusinessHomeView(model: app, scope: business) })
    shot("app-business-home-full.png", height: 1800, scale: 2, tabs: businessTabs, selected: .home,
         VStack(spacing: 0) { header(businessCtx); BusinessHomeView(model: app, scope: business) })
    shot("app-inbox.png", tabs: businessTabs, selected: .inbox,
         VStack(spacing: 0) { header(businessCtx); InboxView(model: app, scope: business) })
    shot("app-lead-detail-full.png", height: 2300, scale: 2, LeadDetailView(model: app, scope: business, leadId: lead.lead.leadId))
    shot("app-agents.png", tabs: businessTabs, selected: .agents,
         VStack(spacing: 0) { header(businessCtx); AgentRunsView(model: app, scope: business) })
    shot("app-agent-run-full.png", height: 2400, scale: 2, AgentRunDetailView(model: app, scope: business, runId: run.run.runId))

    // Sheets.
    let notifications = fixture("NotificationPage", NotificationPage.self)
    personal.preset("notifications.list", route: "notifications.list", RemoteState<NotificationPage>.loaded(notifications, syncedAt: now))
    shot("app-notifications.png", NotificationsSheet(model: app, scope: personal))
    personal.preset("auth.sessions", route: "auth.sessions", RemoteState<SessionList>.notYet(routeId: "auth.sessions"))
    shot("app-account-full.png", height: 1500, scale: 2, AccountSheet(model: app, scope: personal))

    // Accessibility: the smallest and largest iPhone widths, large and accessibility Dynamic Type.
    let a11y = out.appendingPathComponent("5 App accessibility")
    try? FileManager.default.createDirectory(at: a11y, withIntermediateDirectories: true)
    for (w, label) in [(CGFloat(320), "320"), (375, "375"), (430, "430")] {
        for (size, sizeName) in [(DynamicTypeSize.large, "default"), (.xxxLarge, "xxxl"), (.accessibility3, "ax3")] {
            func a(_ name: String, height: CGFloat = 1900, _ view: some View) {
                png(AppPhone(tabs: name.hasPrefix("business") ? businessTabs : personalTabs) { view }
                        .environment(\.dynamicTypeSize, size),
                    width: w, height: height, scale: 2, to: a11y.appendingPathComponent("\(name)-\(label)-\(sizeName).png"))
            }
            a("personal-home", VStack(spacing: 0) { header(personalCtx); PersonalHomeView(model: app, scope: personal) })
            a("business-home", VStack(spacing: 0) { header(businessCtx); BusinessHomeView(model: app, scope: business) })
            a("sign-in", height: 2400, SignInView(model: app, reason: .fresh))
            a("approval", height: 2400, SheetScaffold(title: "Approval", onCancel: {}) {
                SynqStack(spacing: \.m) { ApprovalTerms(request: signing) }
            })
        }
    }
}
