import CoreText
import SwiftUI

// The single source of truth for how Synq looks. A theme supplies colour, type,
// spacing, radius, line and motion tokens, the decorative glyphs and flavour copy,
// the art set, and the look of each component. Screens only use the themed
// components in Components.swift, so a new look is one new `SynqTheme` value set
// at the root (`.environment(\.synqTheme, …)`). See THEMING.md.

protocol SynqTheme {
    var id: String { get }
    var colors: SynqColors { get }
    var type: SynqTypography { get }
    var space: SynqSpacing { get }
    var radius: SynqRadii { get }
    var lines: SynqLines { get }
    var motion: SynqMotion { get }
    var glyphs: SynqGlyphs { get }
    var copy: SynqFlavor { get }
    var icons: SynqIcons { get }
    var looks: SynqLooks { get }

    /// Art for a semantic slot: a full-bleed hero band or a short strip for cards.
    func art(_ slot: SynqArtSlot, _ variant: SynqArtVariant) -> AnyView
}

// MARK: - Tokens

struct SynqColors {
    var background: Color
    var panel: Color
    var inkPrimary: Color
    var inkSecondary: Color
    var inkTertiary: Color
    var line: Color
    /// Borders that should read as controls (outline buttons, focused fields).
    var lineStrong: Color
    var approved: Color
    var approvedFill: Color
    var approvedLine: Color
    var pending: Color
    var danger: Color
    /// Fill of the strong primary button and selected states.
    var accent: Color
    /// Ink on top of `accent`.
    var onAccent: Color
}

enum SynqInk {
    case primary, secondary, tertiary, approved, pending, danger, onAccent
}

extension SynqColors {
    func ink(_ i: SynqInk) -> Color {
        switch i {
        case .primary: return inkPrimary
        case .secondary: return inkSecondary
        case .tertiary: return inkTertiary
        case .approved: return approved
        case .pending: return pending
        case .danger: return danger
        case .onAccent: return onAccent
        }
    }
}

/// A font role resolved by the theme. `family` is a PostScript name; when it is
/// not registered the system font with `fallback` design is used instead.
struct SynqFontSpec {
    var family: String?
    var size: CGFloat
    var weight: Font.Weight = .regular
    var fallback: Font.Design = .monospaced
    var relativeTo: Font.TextStyle = .body
    var tracking: CGFloat = 0
    var uppercase = false
    /// Fixed size (no Dynamic Type) for dense layouts such as the keypad and tab bar.
    var fixed = false

    var font: Font {
        if let family, SynqFonts.isAvailable(family) {
            return fixed ? .custom(family, fixedSize: size) : .custom(family, size: size, relativeTo: relativeTo)
        }
        return .system(size: size, weight: weight, design: fallback)
    }
}

enum SynqTypeRole: CaseIterable {
    case wordmark, wordmarkSub, title, headline, sectionLabel, amountLarge, amountMedium, amountUnit
    case body, bodyStrong, caption, mono, button, keypad, tab, tagline, display
}

struct SynqTypography {
    var roles: [SynqTypeRole: SynqFontSpec]
    /// Family used to draw character-grid art (glyph advance assumed 0.6 em).
    var artFamily: String?

    subscript(_ role: SynqTypeRole) -> SynqFontSpec { roles[role] ?? SynqFontSpec(size: 15) }
}

struct SynqSpacing {
    var xxs: CGFloat = 2
    var xs: CGFloat = 4
    var s: CGFloat = 8
    var m: CGFloat = 12
    var l: CGFloat = 16
    var xl: CGFloat = 24
    var xxl: CGFloat = 32
    /// Screen side margin.
    var gutter: CGFloat = 16
}

struct SynqRadii {
    var panel: CGFloat
    var control: CGFloat
    var badge: CGFloat
    var key: CGFloat
    var bubble: CGFloat
}

struct SynqLines {
    var hairline: CGFloat = 1
    var control: CGFloat = 1
    /// Dash pattern for section rules; empty for solid.
    var ruleDash: [CGFloat] = []
}

struct SynqMotion {
    var spring: Animation = .spring(response: 0.42, dampingFraction: 0.86)
    var quick: Animation = .easeOut(duration: 0.18)
    /// A blinking cursor in fields and the searching card.
    var blinkingCursor = true
    /// Gentle shimmer while searching (skipped with Reduce Motion).
    var shimmer = true
    var pressScale: CGFloat = 0.98
}

/// Decorative glyphs the components draw around content (never functional text).
struct SynqGlyphs {
    var bracketOpen: String?
    var bracketClose: String?
    var strongOpen: String?
    var strongClose: String?
    var rowArrow: String?
    var cursor: String?
    var prompt: String
    /// Spinner frames drawn as text; empty draws an arc.
    var spinner: [String] = []
}

/// Theme flavour copy: taglines and tab labels. Functional English copy stays in screens.
struct SynqFlavor {
    var wordmark: String
    var wordmarkSub: String?
    var taglines: [SynqArtSlot: String]
    var tabs: [SynqTab: String]
    var centreTab: String
    var seeAll: String?
    var flightsHeadline: String?
    /// Short place coordinates by airport code, shown beside hero art.
    var places: [String: String]
}

/// Semantic icon names, mapped by the theme to SF Symbols.
enum SynqIcon: String, CaseIterable {
    case back, forward, close, more, settings, scan, copy, share, invite, plus, check, clock, warning, refresh
    case external, flight, flightLand, gift, send, grid, swap, pin, calendar, people, passkey
    case home, trips, group, ask, search, receipt, shield, vote, voted, money
    case deal, team, split, bank, contractor
}

struct SynqIcons {
    var symbols: [SynqIcon: String]
    var weight: Font.Weight

    func name(_ i: SynqIcon) -> String { symbols[i] ?? "circle" }
}

/// How the components draw themselves.
struct SynqLooks {
    enum PanelLabel { case notched, above }
    enum Avatar { case pixel, initials }
    enum Progress { case outlined, capsule }

    var panelLabel: PanelLabel
    var panelFilled: Bool
    var avatar: Avatar
    var progress: Progress
    var uppercaseTitles: Bool
    /// Section labels followed by a hairline rule.
    var ruledSections: Bool
}

enum SynqArtSlot: String, CaseIterable {
    case home, flights, fund, send, gift, receipt, deal, risk, agent
}

enum SynqArtVariant { case hero, strip }

enum SynqTab: String, CaseIterable, Identifiable {
    case home, trips, ask, gifts, group
    var id: String { rawValue }

    /// English name for VoiceOver, whatever the theme shows.
    var spoken: String {
        switch self {
        case .home: return "Home"
        case .trips: return "Flights"
        case .ask: return "Ask Synq"
        case .gifts: return "Gifts"
        case .group: return "Group"
        }
    }
}

// MARK: - Environment

private struct ThemeKey: EnvironmentKey {
    static let defaultValue: any SynqTheme = AsciiTheme()
}

extension EnvironmentValues {
    var synqTheme: any SynqTheme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

enum SynqThemes {
    /// Every theme the app ships; the first is the default.
    static let all: [any SynqTheme] = [AsciiTheme(), HoloTheme()]

    static func named(_ id: String) -> any SynqTheme { all.first { $0.id == id } ?? all[0] }
}

// MARK: - Fonts

/// Registers the bundled fonts (also listed under UIAppFonts) and reports which
/// families loaded, so roles fall back to system fonts when one is missing.
enum SynqFonts {
    static let files = ["JetBrainsMono-Regular.ttf", "JetBrainsMono-Medium.ttf", "JetBrainsMono-Bold.ttf",
                        "DepartureMono-Regular.otf", "NotoSansJP-Synq.ttf"]

    private final class Marker {}
    private static var registered = false

    /// Registers fonts found in `directory`, else in the extension bundle.
    static func register(from directory: URL? = nil) {
        guard !registered else { return }
        registered = true
        for file in files {
            let url = directory?.appendingPathComponent(file)
                ?? Bundle(for: Marker.self).url(forResource: (file as NSString).deletingPathExtension,
                                                withExtension: (file as NSString).pathExtension)
            guard let url else { continue }
            // Already registered through UIAppFonts is fine: the error is ignored.
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    private static var cache: [String: Bool] = [:]
    private static let lock = NSLock()

    static func isAvailable(_ postScriptName: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let known = cache[postScriptName] { return known }
        let font = CTFontCreateWithName(postScriptName as CFString, 12, nil)
        let ok = (CTFontCopyPostScriptName(font) as String) == postScriptName
        cache[postScriptName] = ok
        return ok
    }
}
