import SwiftUI

// Group-bound review cards issued by other Synq channels (`/approve?p&g&n`).
// The embedded preview is an unverified hint; the Synq page is canonical.

/// Transcript (live layout) rendering of a card.
struct TranscriptCardView: View {
    let link: CardLink
    let status: CardStatus?

    var body: some View {
        ZStack {
            Theme.ink
            RadialGradient(colors: [Theme.blue.opacity(0.35), .clear], center: .topLeading, startRadius: 0, endRadius: 260)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    SynqMark(size: 18, finish: .titanium, showsOrbit: false)
                    Text("SYNQ · REVIEW").font(.system(size: 10, weight: .heavy, design: .rounded)).tracking(1.2)
                        .foregroundStyle(Theme.blueHi)
                    Spacer()
                    if let s = status {
                        HoloPips(pips: .init(on: s.counted, total: s.required), color: Theme.blueHi, size: 7)
                        Text("\(s.counted)/\(s.required)").font(.synq(.caption, .bold)).monospacedDigit()
                            .foregroundStyle(Theme.text)
                    }
                }
                Text(link.preview?.title ?? "Group proposal").font(.synq(.headline, .bold)).foregroundStyle(Theme.text).lineLimit(2)
                ForEach(Array((link.preview?.lines ?? []).prefix(2).enumerated()), id: \.offset) { _, line in
                    Text(line).font(.synq(.subheadline)).foregroundStyle(Theme.text2).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(status.map { "Current: \($0.state.lowercased())" } ?? "Unverified preview · tap to review")
                    .font(.synq(.caption2)).foregroundStyle(Theme.text3)
            }
            .padding(14)
        }
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
        SynqScreen(accent: Theme.blue, secondary: Theme.violet) {
            VStack(alignment: .leading, spacing: Theme.s4) {
                BrandBar(network: "Review")
                VStack(alignment: .leading, spacing: Theme.s2) {
                    Text(link.preview?.title ?? "Group proposal").font(.synq(.title2, .bold)).foregroundStyle(Theme.text)
                    if let preview = link.preview {
                        ForEach(Array(preview.lines.enumerated()), id: \.offset) { _, line in
                            Text(line).font(.synq(.body)).foregroundStyle(Theme.text2)
                        }
                        NoteText(text: "Preview sent by a chat member. The Synq page shows the canonical details.")
                    }
                }
                .padding(Theme.s4)
                .glass(tint: Theme.blue)
                if let s = status {
                    HStack(spacing: Theme.s2) {
                        StatusPill(text: s.state.capitalized, tone: .waiting)
                        HoloPips(pips: .init(on: s.counted, total: s.required), color: Theme.blueHi, size: 9)
                        Text("\(s.counted)/\(s.required) verified approvals").font(.synq(.subheadline, .semibold))
                            .foregroundStyle(Theme.text)
                    }
                }
                if let error { NoteText(text: error, tone: .failed) }
                Button(action: onReview) { Label("Review and approve securely", systemImage: "faceid") }
                    .buttonStyle(.glow(Theme.blue, Theme.blueHi))
                HStack {
                    Button("Refresh status", action: onRefresh).buttonStyle(.glassCompact)
                    if let onShareUpdate {
                        Button("Share update", action: onShareUpdate).buttonStyle(.glassCompact)
                    }
                }
                NoteText(text: "Tapping a card never approves anything. You approve on the Synq page with your passkey.")
            }
            .padding(Theme.s5)
            .synqScroll()
        }
    }
}

/// Compact compose view: turn a Synq link from the clipboard into a card message.
struct ComposeView: View {
    let onPaste: () -> Void
    let message: String?

    var body: some View {
        SynqScreen {
            VStack(spacing: 10) {
                Text("Share a Synq proposal").font(.synq(.headline, .bold)).foregroundStyle(Theme.text)
                Text("Copy a Synq review link from the group, then tap below.")
                    .font(.synq(.footnote)).multilineTextAlignment(.center).foregroundStyle(Theme.text2)
                Button("Paste Synq link", action: onPaste).buttonStyle(.glow)
                if let message { NoteText(text: message) }
            }
            .padding()
        }
    }
}
