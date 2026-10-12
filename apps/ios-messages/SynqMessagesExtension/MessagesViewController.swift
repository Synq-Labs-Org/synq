import Messages
import SwiftUI
import UIKit

/// Synq Messages extension. It renders `synq.card/v1` cards as MSMessageLiveLayout
/// bubbles and opens the secure approval URL. It never signs, stores keys or approves.
final class MessagesViewController: MSMessagesAppViewController {
    private let config = SynqConfig.fromBundle()
    private let client = CardStatusClient()
    private var hosted: UIViewController?
    private var link: CardLink?
    private var status: CardStatus?
    private var errorText: String?
    private var composeMessage: String?

    // MARK: Lifecycle

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        load(from: conversation)
        render()
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        load(from: conversation)
        render()
    }

    override func didTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.didTransition(to: presentationStyle)
        render()
    }

    /// Height of the live layout bubble in the transcript.
    override func contentSizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: min(160, size.height))
    }

    // MARK: State

    private func load(from conversation: MSConversation) {
        status = nil
        errorText = nil
        guard let url = conversation.selectedMessage?.url else {
            link = nil
            return
        }
        link = CardLink(url: url, allowedHost: config.webHost)
        if link == nil { errorText = "This card does not point at the configured Synq site." }
        refresh()
    }

    private func refresh() {
        guard let link else { return }
        Task { @MainActor in
            do {
                status = try await client.fetch(link)
                errorText = nil
            } catch {
                errorText = "Could not load the current state. The link may have expired."
            }
            render()
        }
    }

    // MARK: Rendering

    private func render() {
        let view: AnyView
        if let link {
            if presentationStyle == .transcript {
                view = AnyView(TranscriptCardView(link: link, status: status))
            } else {
                view = AnyView(ExpandedCardView(
                    link: link,
                    status: status,
                    error: errorText,
                    onRefresh: { [weak self] in self?.refresh() },
                    onReview: { [weak self] in self?.openSecurely(link.openURL) },
                    onShareUpdate: status == nil ? nil : { [weak self] in self?.insertCard(link) }
                ))
            }
        } else {
            view = AnyView(ComposeView(onPaste: { [weak self] in self?.pasteLink() },
                                       message: errorText ?? composeMessage))
        }
        let controller = UIHostingController(rootView: view)
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

    // MARK: Actions

    /// Hands off to Safari (or the Synq universal link) where the passkey lives.
    /// The approval ceremony happens there, never inside the extension.
    private func openSecurely(_ url: URL) {
        extensionContext?.open(url) { [weak self] opened in
            if !opened {
                Task { @MainActor in
                    self?.errorText = "Could not open the Synq page."
                    self?.render()
                }
            }
        }
    }

    private func pasteLink() {
        guard let text = UIPasteboard.general.string,
              let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let parsed = CardLink(url: url, allowedHost: config.webHost)
        else {
            composeMessage = "The clipboard does not hold a Synq review link for \(config.webHost)."
            render()
            return
        }
        insertCard(parsed)
    }

    /// Inserts a card into the conversation for the user to send. A live layout shows
    /// recipients who have the Synq extension; others see the template layout and the
    /// link opens in a browser. Reusing the session replaces the earlier bubble.
    private func insertCard(_ link: CardLink) {
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
        conversation.insert(message) { [weak self] error in
            if error != nil {
                Task { @MainActor in
                    self?.composeMessage = "Messages could not insert the card."
                    self?.render()
                }
            }
        }
        requestPresentationStyle(.compact)
    }
}
