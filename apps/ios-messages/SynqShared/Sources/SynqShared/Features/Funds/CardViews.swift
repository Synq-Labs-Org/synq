import SwiftUI

// Group-bound review cards issued by other Synq channels (`/approve?p&g&n`).
// The embedded preview is an unverified hint; the Synq page is canonical.

extension CardLink {
    /// Art for the card's kind.
    public var artSlot: SynqArtSlot {
        switch preview?.type {
        case "GROUP_TREASURY": return .fund
        case "GROUP_GIFT": return .gift
        case "HOTEL_COMPARISON": return .deal
        case "DCA_MANDATE": return .agent
        case "EXECUTION_RECEIPT": return .receipt
        default: return .risk
        }
    }

    public func card(status: CardStatus?) -> SynqCardModel {
        let title = preview?.title ?? "Group proposal"
        let lines = preview?.lines ?? []
        return SynqCardModel(art: artSlot, eyebrow: "Review · \(preview?.groupLabel ?? "Synq")", title: title,
                             amount: nil, unit: "", detail: lines.first ?? "Unverified preview · tap to review",
                             badge: .pending, status: status.map { $0.state.capitalized } ?? "Review",
                             progress: status.map { ($0.counted, $0.required) },
                             network: preview?.executionMode ?? "Synq page",
                             accessibilityLabel: "Synq review card: \(title). "
                                 + (status.map { "\($0.counted) of \($0.required) verified approvals." } ?? "Unverified preview.")
                                 + " Tap to review.")
    }
}

/// Transcript (live layout) rendering of a card.
public struct TranscriptCardView: View {
    public init(link: CardLink, status: CardStatus?) {
        self.link = link
        self.status = status
    }

    public let link: CardLink
    public let status: CardStatus?

    public var body: some View { SynqCardBubble(model: link.card(status: status)) }
}

/// Expanded view: current state plus a button that opens the authenticated approval page.
public struct ExpandedCardView: View {
    public init(link: CardLink, status: CardStatus?, error: String?, onRefresh: @escaping () -> Void,
                onReview: @escaping () -> Void, onShareUpdate: (() -> Void)?) {
        self.link = link
        self.status = status
        self.error = error
        self.onRefresh = onRefresh
        self.onReview = onReview
        self.onShareUpdate = onShareUpdate
    }

    public let link: CardLink
    public let status: CardStatus?
    public let error: String?
    public let onRefresh: () -> Void
    public let onReview: () -> Void
    public let onShareUpdate: (() -> Void)?
    @Environment(\.synqTheme) private var theme

    public var body: some View {
        SynqScreen {
            VStack(alignment: .leading, spacing: theme.space.l) {
                SynqHeader(title: "Review", actions: [SynqHeaderAction(icon: .refresh, label: "Refresh status", action: onRefresh)])
                SynqHeroArt(slot: link.artSlot)
                SynqStack {
                    SynqPanel(label: link.preview?.groupLabel ?? "Group proposal") {
                        Text(link.preview?.title ?? "Group proposal").synqType(.headline).fixedSize(horizontal: false, vertical: true)
                        if let preview = link.preview {
                            ForEach(Array(preview.lines.enumerated()), id: \.offset) { _, line in
                                Text(line).synqType(.body, .secondary)
                            }
                        }
                        Text(link.preview == nil ? "No preview attached. The Synq page shows the details."
                                                 : "Preview sent by a chat member. The Synq page shows the canonical details.")
                            .synqType(.caption, .tertiary)
                    }
                    if let s = status {
                        SynqPanel(label: "Verified approvals") {
                            HStack {
                                SynqBadge(kind: .pending, text: s.state.capitalized)
                                Spacer()
                            }
                            SynqProgress(value: s.counted, total: s.required, label: "\(s.counted)/\(s.required)")
                        }
                    }
                    if let error { SynqNote(text: error, error: true) }
                    SynqButton(title: "Review and approve securely", icon: .passkey, trailingIcon: .forward, kind: .primary,
                               action: onReview)
                    if let onShareUpdate {
                        SynqButton(title: "Share update", icon: .share, action: onShareUpdate)
                    }
                    SynqNote(text: "Cards never approve anything. You approve on the Synq page with your passkey.")
                }
            }
            .padding(.vertical, theme.space.m)
            .synqScroll()
        }
    }
}

/// Compact compose view: turn a Synq link from the clipboard into a card message.
public struct ComposeView: View {
    public let onPaste: () -> Void
    public let message: String?
    @Environment(\.synqTheme) private var theme

    public var body: some View {
        SynqScreen {
            VStack(spacing: theme.space.m) {
                Text("Share a Synq proposal").synqType(.title)
                Text("Copy a Synq review link from the group, then tap below.").synqType(.caption, .secondary)
                    .multilineTextAlignment(.center)
                SynqButton(title: "Paste Synq link", icon: .copy, action: onPaste)
                if let message { SynqNote(text: message) }
            }
            .padding()
        }
    }
}
