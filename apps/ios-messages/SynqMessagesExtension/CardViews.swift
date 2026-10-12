import SwiftUI

/// Transcript (live layout) rendering of a card.
struct TranscriptCardView: View {
    let link: CardLink
    let status: CardStatus?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Synq").font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                if let s = status {
                    Text("\(s.counted)/\(s.required)").font(.caption.monospacedDigit())
                }
            }
            Text(link.preview?.title ?? "Group proposal").font(.headline).lineLimit(2)
            ForEach(Array((link.preview?.lines ?? []).prefix(3).enumerated()), id: \.offset) { _, line in
                Text(line).font(.subheadline).lineLimit(1)
            }
            Text(status.map { "Current: \($0.state.lowercased())" } ?? "Unverified preview · tap to review")
                .font(.caption2).foregroundStyle(.secondary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Expanded view: current state plus a button that opens the authenticated approval page.
struct ExpandedCardView: View {
    let link: CardLink
    let status: CardStatus?
    let error: String?
    let onRefresh: () -> Void
    let onReview: () -> Void
    let onShareUpdate: (() -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(link.preview?.title ?? "Group proposal").font(.title3.bold())
                if let preview = link.preview {
                    ForEach(Array(preview.lines.enumerated()), id: \.offset) { _, line in
                        Text(line)
                    }
                    Text("Preview sent by a chat member. The Synq page shows the canonical details.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if let s = status {
                    Text("Current state: \(s.state.lowercased()), \(s.counted)/\(s.required) verified approvals")
                        .font(.callout.bold())
                }
                if let error { Text(error).font(.footnote).foregroundStyle(.red) }
                Button(action: onReview) {
                    Text("Review and approve securely").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button("Refresh status", action: onRefresh)
                if let onShareUpdate {
                    Button("Share updated status in this chat", action: onShareUpdate)
                }
                Text("Tapping a card never approves anything. You approve on the Synq page with your passkey.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}

/// Compact compose view: turn a Synq link from the clipboard into a card message.
struct ComposeView: View {
    let onPaste: () -> Void
    let message: String?

    var body: some View {
        VStack(spacing: 10) {
            Text("Share a Synq proposal").font(.headline)
            Text("Copy a Synq review link from the group, then tap below.")
                .font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
            Button("Paste Synq link", action: onPaste).buttonStyle(.borderedProminent)
            if let message { Text(message).font(.footnote).foregroundStyle(.secondary) }
        }
        .padding()
    }
}
