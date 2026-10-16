import Messages
import SafariServices
import SwiftUI
import UIKit

/// Synq Messages extension. A group fund starts, gathers members and pays out from
/// here: the extension shows the fund, inserts invite and payment cards, and hands
/// off to the Synq site whenever a passkey ceremony is needed (join, activate,
/// confirm a payment, approve). It never signs, stores keys or approves.
///
/// It also still renders the group-bound review cards (`/approve?p&g&n`) that
/// other Synq channels issue.
final class MessagesViewController: MSMessagesAppViewController, SFSafariViewControllerDelegate {
    private enum Mode {
        case start
        case fund
        case legacy
    }

    /// The one place the look is chosen: every screen and card reads it from the environment.
    private let theme: any SynqTheme = SynqThemes.all[0]
    private let config = SynqConfig.fromBundle()
    private lazy var model = FundModel(client: FundClient(host: config.webHost))
    private let book = FundBook()
    private let client = CardStatusClient()
    private var mode: Mode = .start
    private var hosted: UIViewController?
    private var link: CardLink?
    private var status: CardStatus?
    private var errorText: String?

    // MARK: Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        SynqFonts.register()
    }

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        route(conversation)
        render()
        if presentationStyle != .transcript { model.startPolling() }
    }

    override func didResignActive(with conversation: MSConversation) {
        super.didResignActive(with: conversation)
        model.stopPolling()
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        route(conversation)
        render()
    }

    override func didTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.didTransition(to: presentationStyle)
        render()
    }

    /// Height of the live layout bubble in the transcript: the card with its art
    /// strip, capped so a bubble never dominates the conversation.
    override func contentSizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: min(SynqCardBubble.height(forWidth: size.width), size.height))
    }

    /// Stable per-device identifier for a conversation; the extension cannot read
    /// the transcript, so funds are remembered against it.
    private static func conversationKey(_ c: MSConversation) -> String {
        ([c.localParticipantIdentifier] + c.remoteParticipantIdentifiers)
            .map(\.uuidString).sorted().joined(separator: ",")
    }

    // MARK: Routing

    private func route(_ conversation: MSConversation) {
        let key = Self.conversationKey(conversation)
        model.conversation = key
        status = nil
        errorText = nil
        link = nil
        if let url = conversation.selectedMessage?.url {
            if let fund = FundLink(url: url, allowedHost: config.webHost) {
                let ref = book.remember(fundId: fund.fundId, key: fund.key,
                                        name: book.ref(fund.fundId)?.name, conversation: key)
                mode = .fund
                switch fund {
                case .proposal(_, _, let hash): model.show(ref, proposal: hash)
                case .trip(_, _, let tripId):
                    model.show(ref, trip: tripId)
                    model.loadTrip(tripId)
                case .invite: model.show(ref)
                }
                return
            }
            if let card = CardLink(url: url, allowedHost: config.webHost) {
                mode = .legacy
                link = card
                refreshLegacy()
                return
            }
        }
        if let ref = book.fund(forConversation: key) {
            mode = .fund
            if model.ref?.fundId != ref.fundId || model.view == nil { model.show(ref) } else { model.refresh() }
        } else {
            mode = .start
            model.show(nil)
        }
    }

    // MARK: Rendering

    private var actions: FundActions {
        FundActions(
            insertInvite: { [weak self] ref, view in self?.insertInvite(ref, view: view) },
            insertProposal: { [weak self] ref, proposal in self?.insertProposal(ref, proposal) },
            insertTrip: { [weak self] ref, trip in self?.insertTrip(ref, trip) },
            open: { [weak self] url in self?.openSecurely(url) },
            expand: { [weak self] in
                if self?.presentationStyle == .compact { self?.requestPresentationStyle(.expanded) }
            }
        )
    }

    private func render() {
        var view: AnyView
        switch mode {
        case .legacy:
            view = legacyView()
        case .start:
            view = AnyView(StartFundView(model: model, actions: actions,
                                         onPasteLink: { [weak self] in self?.pasteLink() }))
        case .fund:
            if presentationStyle == .transcript {
                view = AnyView(FundBubble(model: model))
            } else {
                view = AnyView(FundScreen(model: model, actions: actions))
            }
        }
        if presentationStyle == .transcript {
            // A live bubble receives its own taps; open this card expanded. Tapping
            // never approves anything: approvals happen on the Synq page.
            view = AnyView(view
                .contentShape(Rectangle())
                .onTapGesture { [weak self] in
                    Haptics.tap()
                    self?.requestPresentationStyle(.expanded)
                })
        }
        view = AnyView(view
            .environment(\.synqCompact, presentationStyle == .compact)
            .environment(\.synqTheme, theme)
            .preferredColorScheme(.dark))
        let controller = UIHostingController(rootView: view)
        controller.view.backgroundColor = UIColor(theme.colors.background)
        hosted?.willMove(toParent: nil)
        hosted?.view.removeFromSuperview()
        hosted?.removeFromParent()
        addChild(controller)
        controller.view.frame = self.view.bounds
        controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        self.view.addSubview(controller.view)
        controller.didMove(toParent: self)
        hosted = controller
    }

    // MARK: Cards

    private func insertInvite(_ ref: FundRef, view: FundView?) {
        guard let conversation = activeConversation else { return }
        let name = view?.name ?? ref.name
        let template = MSMessageTemplateLayout()
        template.caption = "Join “\(name)” on Synq"
        template.subcaption = "Group fund · join with Face ID"
        template.trailingSubcaption = view?.memberSummary
        let message = MSMessage(session: MSSession())
        message.layout = MSMessageLiveLayout(alternateLayout: template)
        message.url = FundLink.invite(fundId: ref.fundId, key: ref.key).url(host: config.webHost)
        message.summaryText = "Synq fund: \(name)"
        insert(message, into: conversation)
    }

    private func insertProposal(_ ref: FundRef, _ proposal: FundProposal) {
        guard let conversation = activeConversation else { return }
        let url = FundLink.proposal(fundId: ref.fundId, key: ref.key, intentHash: proposal.intentHash)
            .url(host: config.webHost)
        let template = MSMessageTemplateLayout()
        template.caption = proposal.title
        template.subcaption = "\(model.view?.name ?? ref.name) · Synq"
        template.trailingCaption = proposal.state == "PAID" ? "Paid" : "\(proposal.approvals.counted)/\(proposal.approvals.required)"
        template.trailingSubcaption = proposal.state == "PAID" ? nil : "approvals"
        // Re-sharing the selected payment card replaces it instead of adding another.
        let session = conversation.selectedMessage?.url == url
            ? (conversation.selectedMessage?.session ?? MSSession()) : MSSession()
        let message = MSMessage(session: session)
        message.layout = MSMessageLiveLayout(alternateLayout: template)
        message.url = url
        message.summaryText = "Synq: \(proposal.title)"
        insert(message, into: conversation)
    }

    private func insertTrip(_ ref: FundRef, _ trip: TripView) {
        guard let conversation = activeConversation else { return }
        let url = FundLink.trip(fundId: ref.fundId, key: ref.key, tripId: trip.tripId).url(host: config.webHost)
        let template = MSMessageTemplateLayout()
        template.caption = trip.isGift ? trip.title : "Trip: \(trip.title)"
        template.subcaption = "\(model.view?.name ?? ref.name) · vote on Synq"
        template.trailingCaption = trip.stateText
        let session = conversation.selectedMessage?.url == url
            ? (conversation.selectedMessage?.session ?? MSSession()) : MSSession()
        let message = MSMessage(session: session)
        message.layout = MSMessageLiveLayout(alternateLayout: template)
        message.url = url
        message.summaryText = "Synq: \(trip.title)"
        insert(message, into: conversation)
    }

    private func insert(_ message: MSMessage, into conversation: MSConversation) {
        conversation.insert(message) { [weak self] error in
            if error != nil {
                Task { @MainActor in self?.model.error = "Messages could not insert the card." }
            }
        }
        requestPresentationStyle(.compact)
    }

    // MARK: Safari hand-off

    /// Shows the Synq site in Safari's in-app browser, where the passkey lives; the
    /// ceremony (Face ID) happens there, never in the extension. Messages extensions
    /// cannot hand a web link to Safari itself, so the page opens inside the panel.
    private func openSecurely(_ url: URL) {
        guard url.scheme == "https" else { return }
        if presentationStyle != .expanded { requestPresentationStyle(.expanded) }
        let browser = SFSafariViewController(url: url)
        browser.dismissButtonStyle = .done
        browser.delegate = self
        browser.modalPresentationStyle = .pageSheet
        (presentedViewController ?? self).present(browser, animated: true)
    }

    /// Back from the Synq page: show what changed (joined, activated, sent, approved).
    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        model.refresh()
        if mode == .legacy { refreshLegacy() }
    }

    private func pasteLink() {
        guard let text = UIPasteboard.general.string,
              let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines))
        else {
            model.error = "The clipboard does not hold a Synq link for \(config.webHost)."
            return
        }
        if let fund = FundLink(url: url, allowedHost: config.webHost) {
            let ref = book.remember(fundId: fund.fundId, key: fund.key, name: nil, conversation: model.conversation)
            mode = .fund
            model.show(ref)
            render()
        } else if let card = CardLink(url: url, allowedHost: config.webHost) {
            insertLegacyCard(card)
        } else {
            model.error = "The clipboard does not hold a Synq link for \(config.webHost)."
        }
    }

    // MARK: Review cards from other Synq channels

    private func refreshLegacy() {
        guard let link else { return }
        Task { @MainActor in
            do {
                status = try await client.fetch(link)
                errorText = nil
            } catch {
                errorText = "Could not load the current state. The link may have expired."
            }
            if mode == .legacy { render() }
        }
    }

    private func legacyView() -> AnyView {
        guard let link else { return AnyView(EmptyView()) }
        if presentationStyle == .transcript {
            return AnyView(TranscriptCardView(link: link, status: status))
        }
        return AnyView(ExpandedCardView(
            link: link,
            status: status,
            error: errorText,
            onRefresh: { [weak self] in self?.refreshLegacy() },
            onReview: { [weak self] in self?.openSecurely(link.openURL) },
            onShareUpdate: status == nil ? nil : { [weak self] in self?.insertLegacyCard(link) }
        ))
    }

    /// A live layout shows recipients who have the Synq extension; others see the
    /// template layout and the link opens in a browser.
    private func insertLegacyCard(_ link: CardLink) {
        guard let conversation = activeConversation else { return }
        let template = MSMessageTemplateLayout()
        template.caption = link.preview?.title ?? "Synq proposal"
        template.subcaption = link.preview?.lines.first
        if let s = status {
            template.trailingCaption = "\(s.counted)/\(s.required)"
            template.trailingSubcaption = "approvals"
        }
        template.imageTitle = link.preview?.groupLabel
        template.imageSubtitle = "Synq"
        let message = MSMessage(session: conversation.selectedMessage?.session ?? MSSession())
        message.layout = MSMessageLiveLayout(alternateLayout: template)
        message.url = link.messageURL
        message.summaryText = "Synq: \(template.caption ?? "proposal")"
        insert(message, into: conversation)
    }
}
