import SwiftUI
import SynqContracts

/// The full-screen app. The app target only creates the model and hands it here.
public struct SynqAppRoot: View {
    @ObservedObject var model: SynqAppModel
    @Environment(\.scenePhase) private var scenePhase

    public init(model: SynqAppModel) {
        _model = ObservedObject(wrappedValue: model)
    }

    public var body: some View {
        SynqThemeRoot {
            ZStack {
                switch model.phase {
                case .launching:
                    SynqScreen { SynqSpinner(size: 22) }
                case .onboarding:
                    OnboardingView(onDone: model.finishOnboarding)
                case .signedOut(let reason):
                    SignInView(model: model, reason: reason)
                case .locked:
                    LockedView(model: model)
                case .ready:
                    if let scope = model.scope {
                        ContextShell(model: model, scope: scope)
                            .id(scope.context.contextId)
                    } else {
                        SynqScreen { SynqSpinner(size: 22) }
                    }
                }
            }
            .onAppear { model.start() }
            .onOpenURL { model.open(url: $0) }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                if let url = activity.webpageURL { model.open(url: url) }
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .background: model.didEnterBackground()
                case .active: model.willEnterForeground()
                default: break
                }
            }
        }
    }
}

/// One context: header, five tabs, each with its own navigation stack.
struct ContextShell: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    private var items: [SynqTabItem<AppTab>] {
        model.tabs.map { SynqTabItem(id: $0, title: $0.title, icon: $0.icon) }
    }

    var body: some View {
        SynqTabShell(selection: $model.tab, items: items) { tab in
            NavigationStack(path: Binding(get: { model.paths[tab] ?? [] }, set: { model.paths[tab] = $0 })) {
                SynqScreen {
                    VStack(spacing: 0) {
                        header
                        if model.offline {
                            SynqBanner(icon: .warning, text: "Offline. Showing what was last synced; nothing can be approved or sent.")
                        }
                        if model.sessionIsLegacy {
                            SynqBanner(icon: .clock, text: "Signed in with a 15-minute code session. This server does not issue device sessions yet, so you will sign in again after that.")
                        }
                        if let notice = model.notice {
                            SynqBanner(icon: .warning, text: notice)
                                .onTapGesture { model.notice = nil }
                        }
                        TabRoot(model: model, scope: scope, tab: tab)
                    }
                }
                .navigationDestination(for: SynqDestination.self) { d in
                    DestinationView(model: model, scope: scope, destination: d)
                }
                #if os(iOS)
                .toolbar(.hidden, for: .navigationBar)
                #endif
            }
        }
        .sheet(item: $model.sheet) { sheet in
            SynqThemeRoot {
                switch sheet {
                case .account: AccountSheet(model: model, scope: scope)
                case .contexts: ContextSwitcherSheet(model: model)
                case .notifications: NotificationsSheet(model: model, scope: scope)
                case .approval(let id): ApprovalSheet(model: model, scope: scope, requestId: id)
                }
            }
        }
    }

    private var header: some View {
        SynqContextHeader(
            title: scope.context.displayName,
            kind: scope.context.isBusiness ? "Business · \(scope.context.role?.label ?? "Member")" : "Personal",
            network: "Testnet",
            onSwitch: { model.sheet = .contexts },
            actions: [
                SynqHeaderAction(icon: .bell, label: "Notifications") { model.sheet = .notifications },
                SynqHeaderAction(icon: .settings, label: "Account and settings") { model.sheet = .account },
            ])
    }
}

/// The root screen of a tab in the current context.
struct TabRoot: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    let tab: AppTab

    var body: some View {
        switch tab {
        case .home: if scope.context.isBusiness { BusinessHomeView(model: model, scope: scope) } else { PersonalHomeView(model: model, scope: scope) }
        case .circles: CirclesView(model: model, scope: scope)
        case .activity: ActivityView(model: model, scope: scope)
        case .money: PersonalMoneyView(model: model, scope: scope)
        case .approvals: ApprovalsView(model: model, scope: scope)
        case .inbox: InboxView(model: model, scope: scope)
        case .deals: DealsView(model: model, scope: scope)
        case .agents: AgentRunsView(model: model, scope: scope)
        case .finance: BusinessMoneyView(model: model, scope: scope)
        }
    }
}

/// Where a pushed destination leads.
struct DestinationView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    let destination: SynqDestination

    var body: some View {
        switch destination {
        case .circle(let id): CircleDetailView(model: model, scope: scope, circleId: id)
        case .lead(_, let id): LeadDetailView(model: model, scope: scope, leadId: id)
        case .deal(_, let id): DealDetailView(model: model, scope: scope, dealId: id)
        case .agentRun(_, let id): AgentRunDetailView(model: model, scope: scope, runId: id)
        case .personalHome, .inbox, .approvals, .notifications, .approval:
            EmptyView()
        }
    }
}

// MARK: - Context switcher

struct ContextSwitcherSheet: View {
    @ObservedObject var model: SynqAppModel
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SheetScaffold(title: "Switch", onCancel: { model.sheet = nil }) {
            SynqStack(spacing: \.m) {
                Text("Switching clears what this iPhone loaded for the current context. It never changes which wallet signs.")
                    .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
                SynqGroup {
                    ForEach(Array(model.contexts.enumerated()), id: \.element.id) { i, c in
                        SynqRow(icon: c.isBusiness ? .bank : .people, title: c.displayName,
                                subtitle: c.isBusiness ? "Business · \(c.role?.label ?? "Member")" : "Personal · your circles and money",
                                trailing: c.contextId == model.activeContext?.contextId ? .badge(.approved, "Open")
                                    : (c.unreadCount > 0 ? .badge(.pending, "\(c.unreadCount)") : .arrow),
                                divider: i > 0) {
                            model.select(c)
                        }
                    }
                }
                if let e = model.contextsError { SynqNote(text: e, error: true) }
                if model.contexts.count <= 1 {
                    SynqNote(text: "No business workspaces yet. Create one or accept an invite on the Synq page.")
                    SynqButton(title: "Open the Synq page", trailingIcon: .external, kind: .compact) {
                        if let url = URL(string: "https://\(model.host)/workspaces") { model.links.openSecurely(url) }
                    }
                }
            }
        }
    }
}
