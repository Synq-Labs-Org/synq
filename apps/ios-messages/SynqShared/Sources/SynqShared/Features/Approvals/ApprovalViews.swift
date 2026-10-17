import SwiftUI
import SynqContracts

// Approvals: requests waiting for this person's wallet signature. The screen
// shows what the signature does (purpose), the exact amount, recipient, expiry,
// who enforces it and the typed data itself. Only a wallet produces the
// signature, and only after a tap on this screen while the app is in front.
// Sign-in, Face ID, App Lock and notification taps are never approvals.

struct ApprovalsView: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    @Environment(\.synqTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.l) {
            SynqStack(spacing: \.m) {
                Text("Approvals").synqType(.headline).accessibilityAddTraits(.isHeader)
                Text("Requests waiting for your wallet's signature, across your circles and businesses.")
                    .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
                RemoteSection(remote: scope.approvals, what: "approval requests") { page in
                    ApprovalRows(items: page.items) { model.navigate(to: .approval(requestId: $0)) }
                }
                SynqNote(text: "Nothing here signs by itself. Each request opens its terms; your wallet signs only what you tap to sign.")
            }
        }
        .padding(.vertical, theme.space.m)
        .synqScroll()
    }
}

struct ApprovalRows: View {
    let items: [ApprovalItem]
    let onOpen: (String) -> Void

    var body: some View {
        if items.isEmpty {
            SynqNote(text: "Nothing waiting for your signature.")
        } else {
            SynqGroup {
                ForEach(Array(items.enumerated()), id: \.element.requestId) { i, a in
                    SynqRow(icon: a.purpose.movesMoney ? .send : .passkey, title: a.purpose.label,
                            subtitle: [a.amount?.text, a.workspaceName].compactMap { $0 }.joined(separator: " · "),
                            detail: "\(a.approvals) of \(a.threshold) signed\(a.expiresAt.map { " · expires \(SynqTime.short($0))" } ?? "")",
                            trailing: .badge(.pending, "Review"), divider: i > 0) { onOpen(a.requestId) }
                }
            }
        }
    }
}

/// One request, loaded fresh from the server each time it opens.
struct ApprovalSheet: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope
    let requestId: String
    @State private var state: LoadState = .loading
    @State private var signing = false
    @State private var result: SignatureResult?
    @State private var error: String?
    @State private var submitKey = UUID().uuidString
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.synqTheme) private var theme

    enum LoadState {
        case loading
        case notYet
        case failed(String)
        case ready(SigningRequest, TypedDataGuard.Prepared)
    }

    var body: some View {
        SheetScaffold(title: "Approval", onCancel: { model.sheet = nil }) {
            SynqStack(spacing: \.m) {
                switch state {
                case .loading:
                    HStack(spacing: theme.space.s) {
                        SynqSpinner(ink: .secondary, size: 14)
                        Text("Loading the exact terms…").synqType(.caption, .secondary)
                    }
                case .notYet:
                    NotYetPanel(what: "in-app approvals", routeId: "approvals.get")
                    webHandOff
                case .failed(let m):
                    SynqNote(text: m, error: true)
                    webHandOff
                case .ready(let request, let prepared):
                    ApprovalTerms(request: request)
                    signArea(request, prepared)
                }
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func signArea(_ request: SigningRequest, _ prepared: TypedDataGuard.Prepared) -> some View {
        if let result {
            SynqPanel(label: "Signature") {
                Text(resultWord(result.status)).synqType(.bodyStrong)
                Text("\(result.approvals) of \(result.threshold) signatures recorded. The payment is final only when the chain confirms it.")
                    .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
            }
        } else {
            ForEach(prepared.problems, id: \.self) { SynqNote(text: "Cannot sign: \($0)", error: true) }
            let cap = model.wallet.availability
            if cap.isUsable {
                SynqButton(title: signing ? "Waiting for your wallet…" : "Sign in your wallet", icon: .passkey, kind: .primary,
                           busy: signing) { sign(request, prepared) }
                    .disabled(signing || !prepared.canSign || model.offline)
                Text("Your wallet shows these exact terms again before it signs.").synqType(.caption, .tertiary)
            } else {
                SynqNote(text: cap.reason)
            }
            webHandOff
        }
        if let error { SynqNote(text: error, error: true) }
    }

    /// The external hand-off: the Synq page, where the person's own browser wallet signs.
    private var webHandOff: some View {
        Group {
            if let url = URL(string: "https://\(model.host)/approve/\(requestId)") {
                SynqButton(title: "Review and sign on the Synq page", icon: .external, trailingIcon: .forward) {
                    model.links.openSecurely(url)
                }
            }
            SynqNote(text: "Face ID, App Lock and signing in never approve a payment.")
        }
    }

    private func resultWord(_ s: SignatureResult.Status) -> String {
        switch s {
        case .recorded: return "Your signature was recorded"
        case .ready: return "Enough signatures: ready to submit"
        case .submitted: return "Submitted to the chain"
        case .rejected: return "The server rejected this signature"
        case .unknown: return "Signature status unknown"
        }
    }

    private func load() async {
        guard await scope.api.availability("approvals.get") == .live else {
            state = .notYet
            return
        }
        do {
            let body = try await scope.api.data("approvals.get", params: ["requestId": requestId])
            let request = try JSONDecoder().decode(SigningRequest.self, from: body)
            state = .ready(request, TypedDataGuard.prepare(responseBody: body, request: request))
        } catch let f as APIFailure {
            state = .failed(f.message)
            if case .sessionEnded(let revoked) = f { model.sessionEnded(revoked: revoked) }
        } catch {
            state = .failed(APIFailure.unreadable.message)
        }
    }

    private func sign(_ request: SigningRequest, _ prepared: TypedDataGuard.Prepared) {
        // Only from a tap, only while Synq is on screen, only for typed data that passed the checks.
        guard scenePhase == .active, prepared.canSign, !signing else { return }
        signing = true
        error = nil
        let gesture = UserApprovalGesture(requestId: requestId)
        Task {
            defer { signing = false }
            do {
                // Every step, in the server's order, each from the same tap; nothing is sent until all are signed.
                var signatures: [String] = []
                for (i, step) in prepared.steps.enumerated() {
                    signatures.append(try await model.wallet.sign(request, step: i, typedDataJSON: step.json, gesture: gesture))
                }
                result = try await scope.api.call("approvals.sign", params: ["requestId": requestId],
                                                  body: SignatureSubmit(signatures: signatures), idempotencyKey: submitKey,
                                                  as: SignatureResult.self)
                scope.approvals.load(force: true)
            } catch let e as WalletApprovalError {
                error = e.message
            } catch let f as APIFailure {
                error = f == .forbidden("") ? "This wallet is not the signer for this request." : f.message
            } catch {
                self.error = "Not signed. Nothing was sent."
            }
        }
    }
}

/// The terms of one request, exactly as the server sent them.
struct ApprovalTerms: View {
    let request: SigningRequest
    @Environment(\.synqTheme) private var theme

    var body: some View {
        let r = request.request
        SynqPanel(label: r.purpose.label) {
            Text(r.summary).synqType(.bodyStrong).fixedSize(horizontal: false, vertical: true)
            if let a = r.amount {
                SynqAmount(amount: a.amountText, unit: a.symbol)
                Text("on \(a.network) · \(a.units) base units").synqType(.caption, .tertiary)
            }
            SynqKeyValue("Workspace", r.workspaceName)
            if let to = r.recipientHint { SynqKeyValue("Recipient", to, mono: true) }
            SynqKeyValue("Signatures", "\(r.approvals) of \(r.threshold)")
            if let e = r.expiresAt { SynqKeyValue("Expires", SynqTime.short(e)) }
            SynqKeyValue("Signing wallet", request.signerAddress, mono: true)
            SynqKeyValue("Enforced by", request.enforcedBy)
            Text(r.purpose.movesMoney ? "Requires your signature: this authorises money to move under the terms below."
                                      : "Requires your signature: this changes terms or settings; it does not move money by itself.")
                .synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true)
        }
        SynqSectionLabel(text: request.steps.count == 1 ? "What your wallet signs" : "What your wallet signs, in order",
                         trailing: request.steps.count == 1 ? nil : "\(request.steps.count) signatures")
        ForEach(Array(request.steps.enumerated()), id: \.offset) { n, step in
            Text(request.steps.count == 1 ? step.label : "\(n + 1). \(step.label)").synqType(.bodyStrong)
            SynqGroup {
                let lines = TypedDataGuard.lines(step.typedData)
                ForEach(Array(lines.enumerated()), id: \.offset) { i, l in
                    VStack(spacing: 0) {
                        if i > 0 { SynqDivider() }
                        SynqKeyValue(l.0, l.1, mono: true).padding(theme.space.m)
                    }
                }
            }
        }
    }
}

// MARK: - Notifications

struct NotificationsSheet: View {
    @ObservedObject var model: SynqAppModel
    @ObservedObject var scope: ContextScope

    var body: some View {
        SheetScaffold(title: "Notifications", onCancel: { model.sheet = nil }) {
            SynqStack(spacing: \.m) {
                RemoteSection(remote: scope.notifications, what: "notifications") { page in
                    if page.items.isEmpty { SynqNote(text: "No notifications.") }
                    SynqGroup {
                        ForEach(Array(page.items.enumerated()), id: \.element.notificationId) { i, n in
                            SynqRow(icon: NotificationWords.icon(n.category), title: n.title,
                                    subtitle: "\(NotificationWords.category(n.category)) · \(SynqTime.relative(n.createdAt))",
                                    trailing: n.readAt == nil ? .badge(.live, "New") : .arrow, divider: i > 0) {
                                open(n)
                            }
                        }
                    }
                }
                SynqNote(text: "Notifications say only what kind of thing happened. Details load after you sign in and only if you can see them.")
            }
        }
    }

    private func open(_ n: AppNotification) {
        Task {
            _ = try? await scope.api.call("notifications.read", body: MarkRead(notificationIds: [n.notificationId]), as: Ok.self)
        }
        model.sheet = nil
        if let url = URL(string: "https://\(model.host)\(n.deepLink.hasPrefix("/") ? n.deepLink : "/" + n.deepLink)") {
            model.open(url: url)
        }
    }
}

public enum NotificationWords {
    public static func category(_ c: NotificationCategory) -> String {
        switch c {
        case .newLead: return "New enquiry"
        case .offerAccepted: return "Offer accepted"
        case .clientDepositFinalized: return "Client deposit final"
        case .agentPaymentFinalized: return "Agent payment final"
        case .paymentBlocked: return "Payment blocked"
        case .riskReview: return "Risk review"
        case .escrowDisputed: return "Escrow disputed"
        case .circleContributionReceived: return "Contribution received"
        case .fundProposal: return "Circle proposal"
        case .approvalRequested: return "Approval requested"
        case .leaseExpiring: return "Lease expiring"
        case .securityPause: return "Security pause"
        case .unknown: return "Update"
        }
    }

    static func icon(_ c: NotificationCategory) -> SynqIcon {
        switch c {
        case .newLead: return .invite
        case .offerAccepted: return .deal
        case .clientDepositFinalized, .agentPaymentFinalized, .circleContributionReceived: return .money
        case .paymentBlocked, .riskReview, .escrowDisputed, .securityPause: return .warning
        case .fundProposal, .approvalRequested: return .passkey
        case .leaseExpiring: return .clock
        case .unknown: return .bell
        }
    }
}
