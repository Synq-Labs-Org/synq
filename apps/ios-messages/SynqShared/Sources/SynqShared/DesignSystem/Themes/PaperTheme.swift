import SwiftUI

// The paper theme: a light, warm print look. Off-white stock, near-black ink,
// serif headlines, filled panels with labels above, and risograph-style art
// (overprinted sun, hills and halftone dots) drawn procedurally per slot.

public struct PaperTheme: SynqTheme {
    public let id = "paper"
    public let name = "Paper"
    public let summary = "Light print look, serif type, riso art"
    public let colorScheme = ColorScheme.light

    public static func hex(_ v: UInt32, _ a: Double = 1) -> Color {
        Color(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255,
              blue: Double(v & 0xFF) / 255, opacity: a)
    }

    /// Print inks for the art.
    public static let vermilion = hex(0xD2492A)
    public static let ochre = hex(0xE3A63B)
    public static let indigo = hex(0x2C4A7C)
    public static let teal = hex(0x2F7A6D)

    public let colors = SynqColors(
        background: hex(0xF4EFE6), panel: hex(0xFBF8F2),
        inkPrimary: hex(0x1C1A17), inkSecondary: hex(0x57514A), inkTertiary: hex(0x7A7366),
        line: hex(0xDCD3C4), lineStrong: hex(0x1C1A17),
        approved: hex(0x2F6B3A), approvedFill: hex(0xE4EEDD), approvedLine: hex(0x9CC09F),
        pending: hex(0x9A5A12), danger: hex(0xB3261E),
        accent: hex(0x1C1A17), onAccent: hex(0xFBF8F2))

    private static func serif(_ size: CGFloat, _ w: Font.Weight = .regular, _ style: Font.TextStyle,
                              tracking: CGFloat = 0, fixed: Bool = false) -> SynqFontSpec {
        SynqFontSpec(family: nil, size: size, weight: w, fallback: .serif, relativeTo: style, tracking: tracking, fixed: fixed)
    }

    private static func sans(_ size: CGFloat, _ w: Font.Weight = .regular, _ style: Font.TextStyle = .body,
                             tracking: CGFloat = 0, upper: Bool = false, fixed: Bool = false) -> SynqFontSpec {
        SynqFontSpec(family: nil, size: size, weight: w, fallback: .default, relativeTo: style, tracking: tracking,
                     uppercase: upper, fixed: fixed)
    }

    public let type = SynqTypography(roles: [
        .wordmark: serif(32, .semibold, .largeTitle, tracking: -0.5, fixed: true),
        .wordmarkSub: sans(11, .medium, .caption, tracking: 1.2, upper: true, fixed: true),
        .title: serif(19, .semibold, .headline), .headline: serif(23, .semibold, .title2),
        .sectionLabel: sans(11.5, .semibold, .caption, tracking: 1.1, upper: true),
        .amountLarge: serif(40, .medium, .largeTitle, tracking: -0.5), .amountMedium: serif(21, .medium, .title3),
        .amountUnit: sans(14, .semibold, .headline, tracking: 0.4),
        .body: sans(15), .bodyStrong: sans(15, .semibold), .caption: sans(12, .regular, .caption),
        .mono: SynqFontSpec(family: nil, size: 12, fallback: .monospaced, relativeTo: .caption),
        .button: sans(15.5, .semibold), .keypad: serif(24, .medium, .title2, fixed: true),
        .tab: sans(10, .medium, .caption2, fixed: true),
        .tagline: serif(20, .semibold, .title3, tracking: -0.2, fixed: true),
        .display: serif(27, .semibold, .title, tracking: -0.3),
    ], artFamily: nil)

    public let space = SynqSpacing()
    public let radius = SynqRadii(panel: 14, control: 12, badge: 6, key: 10, bubble: 16)
    public let lines = SynqLines(hairline: 1, control: 1, ruleDash: [])
    public let motion = SynqMotion(blinkingCursor: false)
    public let glyphs = SynqGlyphs(bracketOpen: nil, bracketClose: nil, strongOpen: nil, strongClose: nil, rowArrow: "→",
                            cursor: nil, prompt: "")
    public let copy = SynqFlavor(
        wordmark: "Synq", wordmarkSub: "pay together",
        taglines: [.home: "Go further,\ntogether", .fund: "One pot,\nmany hands", .send: "Small payments,\nbig memories",
                   .gift: "Give as one", .receipt: "Every cent,\naccounted for", .deal: "Agreed,\nin writing",
                   .risk: "Safe by\ndesign", .agent: "Think it\nthrough"],
        tabs: [.home: "Home", .trips: "Flights", .gifts: "Gifts", .group: "Group", .ask: "S"],
        centreTab: "S", seeAll: "See all", flightsHeadline: "Where to next?", places: SynqFlavor.airportCoordinates)
    public let icons = SynqIcons(symbols: [.ask: "sparkles", .home: "house", .send: "arrow.up.right"], weight: .regular)
    public let looks = SynqLooks(panelLabel: .above, panelFilled: true, avatar: .initials, progress: .capsule,
                          uppercaseTitles: false, ruledSections: true)

    public func art(_ slot: SynqArtSlot, _ variant: SynqArtVariant) -> AnyView {
        AnyView(PaperPrint(slot: slot, hero: variant == .hero, tagline: variant == .hero ? copy.taglines[slot] : nil,
                           paper: Self.hex(0xEDE4D3), ink: colors.inkPrimary, taglineFont: type[.tagline]))
    }
}

// MARK: - Riso print art

/// A two- or three-ink print: halftone sky, a sun, overprinted hills and a stamp
/// with the slot's symbol. Layout and inks come from the slot, so it is stable.
public struct PaperPrint: View {
    public let slot: SynqArtSlot
    public let hero: Bool
    public let tagline: String?
    public let paper: Color
    public let ink: Color
    public let taglineFont: SynqFontSpec

    private struct Recipe {
        var sun: Color
        var hills: [Color]
        var sunX: CGFloat
        var symbol: String
    }

    private var recipe: Recipe {
        switch slot {
        case .home: return Recipe(sun: PaperTheme.vermilion, hills: [PaperTheme.ochre, PaperTheme.indigo], sunX: 0.72, symbol: "mountain.2")
        case .flights: return Recipe(sun: PaperTheme.ochre, hills: [PaperTheme.teal, PaperTheme.indigo], sunX: 0.28, symbol: "airplane")
        case .fund: return Recipe(sun: PaperTheme.vermilion, hills: [PaperTheme.teal, PaperTheme.ochre], sunX: 0.62, symbol: "beach.umbrella")
        case .send: return Recipe(sun: PaperTheme.ochre, hills: [PaperTheme.vermilion, PaperTheme.indigo], sunX: 0.8, symbol: "arrow.up.right")
        case .gift: return Recipe(sun: PaperTheme.vermilion, hills: [PaperTheme.ochre, PaperTheme.teal], sunX: 0.35, symbol: "gift")
        case .receipt: return Recipe(sun: PaperTheme.teal, hills: [PaperTheme.ochre, PaperTheme.indigo], sunX: 0.7, symbol: "doc.text")
        case .deal: return Recipe(sun: PaperTheme.indigo, hills: [PaperTheme.ochre, PaperTheme.vermilion], sunX: 0.3, symbol: "signature")
        case .risk: return Recipe(sun: PaperTheme.teal, hills: [PaperTheme.indigo, PaperTheme.ochre], sunX: 0.66, symbol: "lock.shield")
        case .agent: return Recipe(sun: PaperTheme.ochre, hills: [PaperTheme.indigo, PaperTheme.vermilion], sunX: 0.4, symbol: "sparkles")
        }
    }

    private var seed: Double { Double(SynqArtSlot.allCases.firstIndex(of: slot) ?? 0) }

    public var body: some View {
        let r = recipe
        ZStack(alignment: .topLeading) {
            Canvas { ctx, size in
                ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(paper))
                // Halftone sky: dots shrink towards the horizon.
                let step: CGFloat = hero ? 9 : 7
                let rows = Int(size.height * 0.55 / step)
                for row in 0..<rows {
                    let rad = step * 0.32 * (1 - CGFloat(row) / CGFloat(max(rows, 1)))
                    guard rad > 0.4 else { continue }
                    var x = (row % 2 == 0 ? 0 : step / 2)
                    while x < size.width {
                        let y = CGFloat(row) * step + step / 2
                        ctx.fill(Path(ellipseIn: CGRect(x: x - rad, y: y - rad, width: rad * 2, height: rad * 2)),
                                 with: .color(r.hills[1].opacity(0.22)))
                        x += step
                    }
                }
                ctx.blendMode = .multiply
                let sunR = size.height * (hero ? 0.26 : 0.34)
                let sunC = CGPoint(x: size.width * r.sunX, y: size.height * 0.46)
                ctx.fill(Path(ellipseIn: CGRect(x: sunC.x - sunR, y: sunC.y - sunR, width: sunR * 2, height: sunR * 2)),
                         with: .color(r.sun.opacity(0.88)))
                for (i, colour) in r.hills.enumerated() {
                    let base = size.height * (0.62 + 0.14 * CGFloat(i))
                    let amp = size.height * (0.12 - 0.03 * CGFloat(i))
                    let phase = seed * 1.7 + Double(i) * 2.1
                    var p = Path()
                    p.move(to: CGPoint(x: 0, y: size.height))
                    var x: CGFloat = 0
                    while x <= size.width {
                        let t = Double(x / size.width)
                        let y = base - amp * CGFloat(sin(t * .pi * (1.6 + Double(i)) + phase) * 0.7
                            + sin(t * .pi * 4.3 + phase * 0.5) * 0.3)
                        p.addLine(to: CGPoint(x: x, y: y))
                        x += 4
                    }
                    p.addLine(to: CGPoint(x: size.width, y: size.height))
                    p.closeSubpath()
                    // A slight misregistration, as in a real two-pass print.
                    ctx.fill(p.offsetBy(dx: CGFloat(i) * 1.5, dy: 0), with: .color(colour.opacity(0.82)))
                }
            }
            if let tagline {
                Text(tagline).font(taglineFont.font).tracking(taglineFont.tracking).foregroundStyle(ink)
                    .lineSpacing(1).padding(.leading, 18).padding(.top, 16)
            }
        }
        .overlay(alignment: hero ? .bottomTrailing : .trailing) {
            Image(systemName: r.symbol)
                .font(.system(size: hero ? 20 : 13, weight: .semibold))
                .foregroundStyle(paper)
                .frame(width: hero ? 46 : 28, height: hero ? 46 : 28)
                .background(Circle().fill(ink))
                .padding(hero ? 16 : 8)
        }
        .aspectRatio(hero ? 2.2 : 5.5, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: hero ? 0 : 12, style: .continuous))
        .accessibilityHidden(true)
    }
}
