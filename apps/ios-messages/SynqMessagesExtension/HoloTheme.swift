import SwiftUI

// A minimal theme (the earlier dark "holo" look: violet glass, rounded
// system type, no brackets, symbol art). It exists to prove a theme swap needs no
// screen changes: `render.sh <out> holo` renders every screen with it.

struct HoloTheme: SynqTheme {
    let id = "holo"
    let name = "Holo"
    let summary = "Violet glass, rounded type, symbol art"
    let colorScheme = ColorScheme.dark

    static func hex(_ v: UInt32, _ a: Double = 1) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255,
              blue: Double(v & 0xFF) / 255, opacity: a)
    }

    let colors = SynqColors(
        background: hex(0x07060D), panel: hex(0x16142A),
        inkPrimary: hex(0xF5F4FA), inkSecondary: hex(0xA9A6BF), inkTertiary: hex(0x6E6A88),
        line: hex(0x2C2945), lineStrong: hex(0x8B6BFF),
        approved: hex(0x4FE6A6), approvedFill: hex(0x0F2A22), approvedLine: hex(0x1F6B50),
        pending: hex(0xFFC15C), danger: hex(0xFF6B6B),
        accent: hex(0x8B6BFF), onAccent: hex(0xFFFFFF))

    private static func r(_ size: CGFloat, _ w: Font.Weight = .regular, _ style: Font.TextStyle = .body,
                          tracking: CGFloat = 0, upper: Bool = false, fixed: Bool = false) -> SynqFontSpec {
        SynqFontSpec(family: nil, size: size, weight: w, fallback: .rounded, relativeTo: style, tracking: tracking,
                     uppercase: upper, fixed: fixed)
    }

    let type = SynqTypography(roles: [
        .wordmark: r(30, .bold, .largeTitle, fixed: true), .wordmarkSub: r(11, .medium, .caption, fixed: true),
        .title: r(18, .bold, .headline), .headline: r(22, .bold, .title2),
        .sectionLabel: r(13, .semibold, .footnote, tracking: 0.4, upper: true),
        .amountLarge: r(38, .heavy, .largeTitle), .amountMedium: r(20, .bold, .title3), .amountUnit: r(15, .bold, .headline),
        .body: r(15), .bodyStrong: r(15, .semibold), .caption: r(12, .regular, .caption),
        .mono: SynqFontSpec(family: nil, size: 12, fallback: .monospaced, relativeTo: .caption),
        .button: r(16, .semibold), .keypad: r(24, .semibold, .title2, fixed: true), .tab: r(10, .medium, .caption2, fixed: true),
        .tagline: r(13, .medium, .caption, fixed: true), .display: r(26, .bold, .title),
    ], artFamily: nil)

    let space = SynqSpacing()
    let radius = SynqRadii(panel: 20, control: 26, badge: 10, key: 14, bubble: 18)
    let lines = SynqLines(hairline: 0.75, control: 0.75, ruleDash: [])
    let motion = SynqMotion(blinkingCursor: false)
    let glyphs = SynqGlyphs(bracketOpen: nil, bracketClose: nil, strongOpen: nil, strongClose: nil, rowArrow: nil,
                            cursor: nil, prompt: "")
    let copy = SynqFlavor(wordmark: "Synq", wordmarkSub: nil, taglines: [:],
                          tabs: [.home: "Home", .trips: "Flights", .gifts: "Gifts", .group: "Group", .ask: "S"],
                          centreTab: "S", seeAll: "See all", flightsHeadline: "Where to?", places: [:])
    let icons = SynqIcons(symbols: SynqIcons.standard.merging([
        .flight: "airplane", .gift: "gift.fill", .send: "arrow.up.right", .home: "house.fill",
        .group: "person.2.fill", .people: "person.2.fill", .passkey: "faceid", .ask: "sparkles",
    ]) { _, new in new }, weight: .semibold)
    let looks = SynqLooks(panelLabel: .above, panelFilled: true, avatar: .initials, progress: .capsule,
                          uppercaseTitles: false, ruledSections: false)

    func art(_ slot: SynqArtSlot, _ variant: SynqArtVariant) -> AnyView {
        let symbol: String
        switch slot {
        case .home: symbol = "mountain.2.fill"
        case .flights: symbol = "airplane"
        case .fund: symbol = "beach.umbrella.fill"
        case .send: symbol = "arrow.up.right.circle.fill"
        case .gift: symbol = "gift.fill"
        case .receipt: symbol = "doc.text.fill"
        case .deal: symbol = "building.columns.fill"
        case .risk: symbol = "lock.shield.fill"
        case .agent: symbol = "point.3.connected.trianglepath.dotted"
        }
        let accent = colors.accent
        return AnyView(
            ZStack {
                LinearGradient(colors: [accent.opacity(0.55), Self.hex(0x3D8BFF, 0.25), .clear],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                Image(systemName: symbol)
                    .font(.system(size: variant == .hero ? 64 : 26, weight: .bold))
                    .foregroundStyle(Color.white.opacity(0.92))
            }
            .aspectRatio(variant == .hero ? 2.2 : 5.5, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: variant == .hero ? 0 : 12, style: .continuous))
            .accessibilityHidden(true))
    }
}
