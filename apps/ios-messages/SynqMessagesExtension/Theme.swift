import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// Synq's dark theme for the Messages extension: near-black scene, glass panels,
// a spacing scale, rounded type and glowing controls. Pure SwiftUI so the same
// views render the design previews on macOS (Design/render.swift); the few
// iOS-only touches (haptics, keyboard types) sit behind `#if os(iOS)`.

enum Theme {
    static func rgb(_ hex: UInt32, _ alpha: Double = 1) -> Color { Chrome.rgb(hex, alpha) }

    // Surfaces
    static let ink = rgb(0x050509)
    static let ink2 = rgb(0x0C0B14)
    static let panel = Color.white.opacity(0.055)
    static let panelHi = Color.white.opacity(0.09)
    static let hairline = Color.white.opacity(0.10)

    // Text
    static let text = rgb(0xF5F4FA)
    static let text2 = Color.white.opacity(0.64)
    static let text3 = Color.white.opacity(0.42)

    // Accents (one per card kind)
    static let violet = rgb(0x8B6BFF)
    static let violetHi = rgb(0xC9B8FF)
    static let blue = rgb(0x3D8BFF)
    static let blueHi = rgb(0x9AD4FF)
    static let teal = rgb(0x16D1B5)
    static let tealHi = rgb(0x8BF5E1)
    static let pink = rgb(0xFF5FA8)
    static let pinkHi = rgb(0xFFB3D6)

    // Status
    static let amber = rgb(0xFFC15C)
    static let mint = rgb(0x4FE6A6)
    static let sky = rgb(0x6CB8FF)
    static let coral = rgb(0xFF6B6B)

    // Spacing scale
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s8: CGFloat = 32

    static let radius: CGFloat = 20
    static let radiusSmall: CGFloat = 14
}

// MARK: - Type

extension Font {
    /// Rounded display/text styles that scale with Dynamic Type.
    static func synq(_ style: Font.TextStyle, _ weight: Font.Weight = .regular) -> Font {
        .system(style, design: .rounded, weight: weight)
    }
}

// MARK: - Status

/// One vocabulary of states across cards, rows and pills.
enum SynqTone: Equatable {
    case waiting   // forming, pending approval, voting
    case live      // active fund
    case moving    // executing, booking, buying
    case done      // paid, booked, bought
    case failed

    var color: Color {
        switch self {
        case .waiting: return Theme.amber
        case .live: return Theme.mint
        case .moving: return Theme.sky
        case .done: return Theme.mint
        case .failed: return Theme.coral
        }
    }

    var symbol: String {
        switch self {
        case .waiting: return "hourglass"
        case .live: return "dot.radiowaves.left.and.right"
        case .moving: return "arrow.triangle.2.circlepath"
        case .done: return "checkmark.seal.fill"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }
}

struct StatusPill: View {
    var text: String
    var tone: SynqTone
    var compact = false

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(tone.color).frame(width: 6, height: 6)
                .shadow(color: tone.color.opacity(0.9), radius: 3)
            Text(text)
                .font(compact ? .synq(.caption2, .semibold) : .synq(.caption, .semibold))
                .foregroundStyle(tone.color)
                .lineLimit(1)
        }
        .padding(.horizontal, compact ? 8 : 10)
        .padding(.vertical, compact ? 4 : 5)
        .background(Capsule().fill(tone.color.opacity(0.12)))
        .overlay(Capsule().strokeBorder(tone.color.opacity(0.28), lineWidth: 0.75))
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Render mode

/// Live on device; still (fixed light, no platform controls) for ImageRenderer previews.
enum SynqRenderMode: Equatable {
    case live
    case still(phase: Double)

    var isStill: Bool { if case .still = self { return true } else { return false } }
    var phase: Double? { if case .still(let p) = self { return p } else { return nil } }
}

private struct RenderModeKey: EnvironmentKey {
    static let defaultValue: SynqRenderMode = .live
}

private struct CompactKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var synqRenderMode: SynqRenderMode {
        get { self[RenderModeKey.self] }
        set { self[RenderModeKey.self] = newValue }
    }

    /// True while Messages shows the extension in its compact (keyboard-height) panel.
    var synqCompact: Bool {
        get { self[CompactKey.self] }
        set { self[CompactKey.self] = newValue }
    }
}

// MARK: - Backdrop

/// Deep near-black scene with a coloured glow and a little grain.
struct SynqBackdrop: View {
    var accent: Color = Theme.violet
    var secondary: Color = Theme.blue

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                LinearGradient(colors: [Theme.ink2, Theme.ink, Theme.ink], startPoint: .top, endPoint: .bottom)
                RadialGradient(colors: [accent.opacity(0.34), accent.opacity(0.08), .clear],
                               center: UnitPoint(x: 0.5, y: 0.0), startRadius: 0, endRadius: max(w, 1) * 0.95)
                RadialGradient(colors: [secondary.opacity(0.16), .clear],
                               center: UnitPoint(x: 1.0, y: 0.62), startRadius: 0, endRadius: max(w, 1) * 0.8)
                RadialGradient(colors: [accent.opacity(0.10), .clear],
                               center: UnitPoint(x: 0.0, y: 0.95), startRadius: 0, endRadius: max(h, 1) * 0.5)
                Grain(opacity: 0.05)
            }
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

/// Deterministic film grain so renders are stable.
struct Grain: View {
    var opacity: Double = 0.05
    var density: Double = 0.0016

    var body: some View {
        Canvas { ctx, size in
            var seed: UInt64 = 0xA11CE
            func rand() -> Double {
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                return Double(seed >> 33) / Double(1 << 31)
            }
            let count = Int(Double(size.width * size.height) * density)
            for _ in 0..<count {
                let x = rand() * size.width, y = rand() * size.height
                let light = rand() > 0.5
                ctx.fill(Path(CGRect(x: x, y: y, width: 1, height: 1)),
                         with: .color((light ? Color.white : Color.black).opacity(opacity * (0.4 + rand()))))
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Glass

struct GlassBackground: View {
    var radius: CGFloat = Theme.radius
    var tint: Color? = nil
    var strong = false
    @Environment(\.synqRenderMode) private var mode

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        ZStack {
            if mode.isStill {
                shape.fill(Color(white: 0.11).opacity(strong ? 0.92 : 0.78))
            } else {
                shape.fill(.ultraThinMaterial).environment(\.colorScheme, .dark)
                shape.fill(Color.black.opacity(0.25))
            }
            shape.fill(LinearGradient(colors: [Color.white.opacity(strong ? 0.10 : 0.06), Color.white.opacity(0.015)],
                                      startPoint: .top, endPoint: .bottom))
            if let tint {
                shape.fill(RadialGradient(colors: [tint.opacity(0.22), .clear], center: .topLeading,
                                          startRadius: 0, endRadius: 260))
            }
        }
        .overlay(shape.strokeBorder(LinearGradient(colors: [Color.white.opacity(0.18), Color.white.opacity(0.04)],
                                                   startPoint: .top, endPoint: .bottom), lineWidth: 0.75))
    }
}

extension View {
    func glass(radius: CGFloat = Theme.radius, tint: Color? = nil, strong: Bool = false) -> some View {
        background(GlassBackground(radius: radius, tint: tint, strong: strong))
    }

    /// The screen's scroll container; a plain stack in still renders (ImageRenderer
    /// does not draw platform scroll views).
    func synqScroll() -> some View { modifier(SynqScroll()) }
}

struct SynqScroll: ViewModifier {
    @Environment(\.synqRenderMode) private var mode

    func body(content: Content) -> some View {
        if mode.isStill {
            // Ideal height, clipped at the bottom like a screen that scrolls on.
            content.fixedSize(horizontal: false, vertical: true)
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)
                .clipped()
        } else {
            ScrollView(showsIndicators: false) { content }
                .scrollDismissesKeyboard(.interactively)
        }
    }
}

// MARK: - Buttons

/// Primary action: a glowing gradient pill.
struct GlowButtonStyle: ButtonStyle {
    var accent: Color = Theme.violet
    var accentHi: Color = Theme.violetHi
    var fill = true
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed
        return configuration.label
            .font(.synq(.headline, .semibold))
            .foregroundStyle(Color.white)
            .shadow(color: .black.opacity(0.25), radius: 1, y: 1)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.vertical, 15).padding(.horizontal, 22)
            .frame(maxWidth: fill ? .infinity : nil)
            .background(
                ZStack {
                    Capsule().fill(accent)
                    Capsule().fill(LinearGradient(colors: [accentHi.opacity(0.55), .clear],
                                                  startPoint: .topLeading, endPoint: .center))
                    Capsule().fill(LinearGradient(colors: [.clear, Color.black.opacity(0.22)],
                                                  startPoint: .center, endPoint: .bottom))
                    Capsule().fill(LinearGradient(colors: [Color.white.opacity(0.28), .clear],
                                                  startPoint: .top, endPoint: .center))
                        .padding(1.5)
                        .blendMode(.screen)
                }
            )
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.35), lineWidth: 0.75))
            .shadow(color: accent.opacity(enabled ? (pressed ? 0.35 : 0.6) : 0), radius: pressed ? 8 : 18, y: 6)
            .opacity(enabled ? 1 : 0.4)
            .saturation(enabled ? 1 : 0.2)
            .scaleEffect(pressed ? 0.97 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.7), value: pressed)
    }
}

/// Secondary action: a glass pill.
struct GlassButtonStyle: ButtonStyle {
    var fill = true
    var tint: Color = Theme.text
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.synq(.subheadline, .semibold))
            .foregroundStyle(tint)
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .padding(.vertical, 12).padding(.horizontal, 16)
            .frame(maxWidth: fill ? .infinity : nil)
            .background(GlassBackground(radius: 100))
            .opacity(enabled ? (configuration.isPressed ? 0.7 : 1) : 0.4)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// Small selectable chip (vote, suggestions, filters).
struct ChipButtonStyle: ButtonStyle {
    var selected = false
    var accent: Color = Theme.violet

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.synq(.footnote, .semibold))
            .foregroundStyle(selected ? Color.white : Theme.text2)
            .lineLimit(1)
            .padding(.vertical, 7).padding(.horizontal, 12)
            .background(
                Capsule().fill(selected ? AnyShapeStyle(LinearGradient(colors: [accent, accent.opacity(0.7)],
                                                                       startPoint: .top, endPoint: .bottom))
                                        : AnyShapeStyle(Color.white.opacity(0.07)))
            )
            .overlay(Capsule().strokeBorder(selected ? Color.white.opacity(0.3) : Theme.hairline, lineWidth: 0.75))
            .shadow(color: selected ? accent.opacity(0.55) : .clear, radius: 8)
            .scaleEffect(configuration.isPressed ? 0.95 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == GlowButtonStyle {
    static var glow: GlowButtonStyle { GlowButtonStyle() }
    static func glow(_ accent: Color, _ hi: Color) -> GlowButtonStyle { GlowButtonStyle(accent: accent, accentHi: hi) }
}

extension ButtonStyle where Self == GlassButtonStyle {
    static var glass: GlassButtonStyle { GlassButtonStyle() }
    static var glassCompact: GlassButtonStyle { GlassButtonStyle(fill: false) }
}

extension ButtonStyle where Self == ChipButtonStyle {
    static var chip: ChipButtonStyle { ChipButtonStyle() }
}

// MARK: - Furniture

struct SectionHeader: View {
    var title: String
    var trailing: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.synq(.title3, .bold))
                .foregroundStyle(Theme.text)
            Spacer()
            if let trailing {
                Text(trailing).font(.synq(.footnote, .medium)).foregroundStyle(Theme.text3)
            }
        }
        .padding(.top, Theme.s2)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Brand row at the top of every screen: chrome mark, wordmark, network.
struct BrandBar<Trailing: View>: View {
    var network: String
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: Theme.s2) {
            SynqMark(size: 26, finish: .titanium, showsOrbit: true)
            Text("Synq")
                .font(.synq(.headline, .bold))
                .foregroundStyle(Theme.text)
            Text(network)
                .font(.synq(.caption2, .semibold))
                .foregroundStyle(Theme.text2)
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Capsule().fill(Color.white.opacity(0.07)))
                .overlay(Capsule().strokeBorder(Theme.hairline, lineWidth: 0.5))
                .accessibilityLabel("Network: \(network)")
            Spacer(minLength: 0)
            trailing()
        }
    }
}

extension BrandBar where Trailing == EmptyView {
    init(network: String) {
        self.network = network
        self.trailing = { EmptyView() }
    }
}

/// Member avatars, overlapping, with a check badge for activated members.
struct AvatarStack: View {
    struct Person: Identifiable, Equatable {
        let id: String
        let name: String
        let active: Bool
    }

    var people: [Person]
    var size: CGFloat = 34
    var limit = 6

    private static let hues: [Color] = [Theme.violet, Theme.teal, Theme.pink, Theme.blue, Theme.amber, Theme.mint]

    var body: some View {
        HStack(spacing: -size * 0.3) {
            ForEach(Array(people.prefix(limit).enumerated()), id: \.element.id) { i, p in
                avatar(p, hue: Self.hues[abs(p.name.hashValueStable) % Self.hues.count])
                    .zIndex(Double(limit - i))
            }
            if people.count > limit {
                Text("+\(people.count - limit)")
                    .font(.synq(.caption, .bold))
                    .foregroundStyle(Theme.text)
                    .frame(width: size, height: size)
                    .background(Circle().fill(Color(white: 0.16)))
                    .overlay(Circle().strokeBorder(Theme.ink, lineWidth: 2))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(people.map { "\($0.name)\($0.active ? ", active" : "")" }.joined(separator: "; "))
    }

    private func avatar(_ p: Person, hue: Color) -> some View {
        let initials = p.name.split(separator: " ").prefix(2).compactMap { $0.first }.map(String.init).joined()
        return Text(initials.isEmpty ? "?" : initials.uppercased())
            .font(.system(size: size * 0.38, weight: .bold, design: .rounded))
            .foregroundStyle(Color.white)
            .frame(width: size, height: size)
            .background(Circle().fill(LinearGradient(colors: [hue, hue.opacity(0.55)],
                                                     startPoint: .topLeading, endPoint: .bottomTrailing)))
            .overlay(Circle().strokeBorder(Theme.ink, lineWidth: 2))
            .overlay(alignment: .bottomTrailing) {
                if p.active {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: size * 0.34, weight: .bold))
                        .foregroundStyle(Theme.mint, Theme.ink)
                        .background(Circle().fill(Theme.ink).padding(1))
                        .offset(x: 2, y: 2)
                }
            }
            .opacity(p.active ? 1 : 0.75)
    }
}

extension String {
    /// A hash that is stable across launches (Swift's `hashValue` is seeded).
    var hashValueStable: Int {
        var h: UInt32 = 2166136261
        for b in utf8 { h = (h ^ UInt32(b)) &* 16777619 }
        return Int(h & 0x7FFFFFFF)
    }
}

/// Synq's avatar in conversations with the command bar.
struct SynqAvatar: View {
    var size: CGFloat = 28

    var body: some View {
        SynqMark(size: size * 0.82, finish: .titanium, showsOrbit: false)
            .frame(width: size, height: size)
            .background(Circle().fill(LinearGradient(colors: [Theme.rgb(0x3B2A86), Theme.rgb(0x14102E)],
                                                     startPoint: .topLeading, endPoint: .bottomTrailing)))
            .overlay(Circle().strokeBorder(LinearGradient(colors: [Theme.violetHi.opacity(0.8), Theme.violet.opacity(0.2)],
                                                          startPoint: .top, endPoint: .bottom), lineWidth: 1))
            .shadow(color: Theme.violet.opacity(0.5), radius: 6)
            .accessibilityHidden(true)
    }
}

/// A round icon tile tinted by kind.
struct IconTile: View {
    var symbol: String
    var color: Color
    var size: CGFloat = 40

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(Color.white)
            .frame(width: size, height: size)
            .background(
                RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                    .fill(LinearGradient(colors: [color, color.opacity(0.45)], startPoint: .topLeading, endPoint: .bottomTrailing))
            )
            .overlay(RoundedRectangle(cornerRadius: size * 0.32, style: .continuous)
                .strokeBorder(Color.white.opacity(0.25), lineWidth: 0.75))
            .shadow(color: color.opacity(0.45), radius: 8, y: 3)
            .accessibilityHidden(true)
    }
}

/// Inline note for errors and caveats.
struct NoteText: View {
    var text: String
    var tone: SynqTone? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let tone {
                Image(systemName: tone.symbol).foregroundStyle(tone.color).font(.synq(.footnote, .semibold))
            }
            Text(text)
                .font(.synq(.footnote))
                .foregroundStyle(tone == .failed ? Theme.coral : Theme.text3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Haptics

enum Haptics {
    static func tap() {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        #endif
    }

    static func soft() {
        #if os(iOS)
        UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        #endif
    }

    static func success() {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        #endif
    }

    static func warning() {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        #endif
    }
}

// MARK: - Platform shims

enum SynqKeyboard {
    case decimal
    case number
    case codes
}

extension View {
    /// Keyboard and capitalisation hints; no-ops on macOS.
    @ViewBuilder
    func synqKeyboard(_ k: SynqKeyboard) -> some View {
        #if os(iOS)
        switch k {
        case .decimal: self.keyboardType(.decimalPad)
        case .number: self.keyboardType(.numberPad)
        case .codes: self.textInputAutocapitalization(.characters).autocorrectionDisabled()
        }
        #else
        self
        #endif
    }
}
