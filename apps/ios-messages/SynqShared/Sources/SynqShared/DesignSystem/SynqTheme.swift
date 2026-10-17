import CoreText
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// The single source of truth for how Synq looks. A theme supplies colour, type,
// spacing, radius, line and motion tokens, the decorative glyphs and flavour copy,
// the art set, and the look of each component. Screens only use the themed
// components in Components.swift, so a new look is one new `SynqTheme` value set
// at the root (`.environment(\.synqTheme, …)`). See THEMING.md.

public protocol SynqTheme {
    var id: String { get }
    /// Name and one line shown in the theme picker.
    var name: String { get }
    var summary: String { get }
    /// Light or dark system chrome (keyboard, sheets) under this theme.
    var colorScheme: ColorScheme { get }
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

public struct SynqColors {
    public var background: Color
    public var panel: Color
    public var inkPrimary: Color
    public var inkSecondary: Color
    public var inkTertiary: Color
    public var line: Color
    /// Borders that should read as controls (outline buttons, focused fields).
    public var lineStrong: Color
    public var approved: Color
    public var approvedFill: Color
    public var approvedLine: Color
    public var pending: Color
    public var danger: Color
    /// Fill of the strong primary button and selected states.
    public var accent: Color
    /// Ink on top of `accent`.
    public var onAccent: Color
}

public enum SynqInk {
    case primary, secondary, tertiary, approved, pending, danger, onAccent
}

extension SynqColors {
    public func ink(_ i: SynqInk) -> Color {
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
public struct SynqFontSpec {
    public var family: String?
    public var size: CGFloat
    public var weight: Font.Weight = .regular
    public var fallback: Font.Design = .monospaced
    public var relativeTo: Font.TextStyle = .body
    public var tracking: CGFloat = 0
    public var uppercase = false
    /// Fixed size (no Dynamic Type) for dense layouts such as the keypad and tab bar.
    public var fixed = false

    public var font: Font { font(for: .large) }

    /// The font at a Dynamic Type size. Custom families scale with their text
    /// style; the system fallback is scaled here too, because a system font
    /// with an explicit point size would otherwise ignore Dynamic Type.
    public func font(for dynamicType: DynamicTypeSize) -> Font {
        if let family, SynqFonts.isAvailable(family) {
            return fixed ? .custom(family, fixedSize: size) : .custom(family, size: size, relativeTo: relativeTo)
        }
        return .system(size: fixed ? size : SynqDynamicType.scaled(size, style: relativeTo, at: dynamicType),
                       weight: weight, design: fallback)
    }
}

/// Scales a point size the way iOS scales a text style.
public enum SynqDynamicType {
    /// Body size (pt) at each Dynamic Type size, from Apple's typography tables.
    static let body: [DynamicTypeSize: CGFloat] = [
        .xSmall: 14, .small: 15, .medium: 16, .large: 17, .xLarge: 19, .xxLarge: 21, .xxxLarge: 23,
        .accessibility1: 28, .accessibility2: 33, .accessibility3: 40, .accessibility4: 47, .accessibility5: 53,
    ]

    public static func scaled(_ size: CGFloat, style: Font.TextStyle, at dynamicType: DynamicTypeSize) -> CGFloat {
        guard dynamicType != .large else { return size }
        #if canImport(UIKit) && !os(watchOS)
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicType))
        return UIFontMetrics(forTextStyle: UIFont.TextStyle(style)).scaledValue(for: size, compatibleWith: traits)
        #else
        return (size * (body[dynamicType] ?? 17) / 17).rounded()
        #endif
    }
}

#if canImport(UIKit) && !os(watchOS)
extension UIFont.TextStyle {
    init(_ s: Font.TextStyle) {
        switch s {
        case .largeTitle: self = .largeTitle
        case .title: self = .title1
        case .title2: self = .title2
        case .title3: self = .title3
        case .headline: self = .headline
        case .subheadline: self = .subheadline
        case .callout: self = .callout
        case .footnote: self = .footnote
        case .caption: self = .caption1
        case .caption2: self = .caption2
        default: self = .body
        }
    }
}
#endif

public enum SynqTypeRole: CaseIterable {
    case wordmark, wordmarkSub, title, headline, sectionLabel, amountLarge, amountMedium, amountUnit
    case body, bodyStrong, caption, mono, button, keypad, tab, tagline, display
}

public struct SynqTypography {
    public var roles: [SynqTypeRole: SynqFontSpec]
    /// Family used to draw character-grid art (glyph advance assumed 0.6 em).
    public var artFamily: String?

    public subscript(_ role: SynqTypeRole) -> SynqFontSpec { roles[role] ?? SynqFontSpec(size: 15) }
}

public struct SynqSpacing {
    public var xxs: CGFloat = 2
    public var xs: CGFloat = 4
    public var s: CGFloat = 8
    public var m: CGFloat = 12
    public var l: CGFloat = 16
    public var xl: CGFloat = 24
    public var xxl: CGFloat = 32
    /// Screen side margin.
    public var gutter: CGFloat = 16
}

public struct SynqRadii {
    public var panel: CGFloat
    public var control: CGFloat
    public var badge: CGFloat
    public var key: CGFloat
    public var bubble: CGFloat
}

public struct SynqLines {
    public var hairline: CGFloat = 1
    public var control: CGFloat = 1
    /// Dash pattern for section rules; empty for solid.
    public var ruleDash: [CGFloat] = []
}

public struct SynqMotion {
    public var spring: Animation = .spring(response: 0.42, dampingFraction: 0.86)
    public var quick: Animation = .easeOut(duration: 0.18)
    /// A blinking cursor in fields and the searching card.
    public var blinkingCursor = true
    /// Gentle shimmer while searching (skipped with Reduce Motion).
    public var shimmer = true
    public var pressScale: CGFloat = 0.98
}

/// Decorative glyphs the components draw around content (never functional text).
public struct SynqGlyphs {
    public var bracketOpen: String?
    public var bracketClose: String?
    public var strongOpen: String?
    public var strongClose: String?
    public var rowArrow: String?
    public var cursor: String?
    public var prompt: String
    /// Spinner frames drawn as text; empty draws an arc.
    public var spinner: [String] = []
}

/// Theme flavour copy: taglines and tab labels. Functional English copy stays in screens.
public struct SynqFlavor {
    public var wordmark: String
    public var wordmarkSub: String?
    public var taglines: [SynqArtSlot: String]
    public var tabs: [SynqTab: String]
    public var centreTab: String
    public var seeAll: String?
    public var flightsHeadline: String?
    /// Short place coordinates by airport code, shown beside hero art.
    public var places: [String: String]
}

extension SynqFlavor {
    /// Airport coordinates any theme may show beside hero art.
    public static let airportCoordinates: [String: String] = [
        "GOI": "15.3808°N\n73.8314°E", "DEL": "28.5562°N\n77.1000°E", "BOM": "19.0896°N\n72.8656°E",
        "BLR": "13.1986°N\n77.7066°E", "DXB": "25.2532°N\n55.3657°E", "SIN": "1.3644°N\n103.9915°E",
        "HND": "35.5494°N\n139.7798°E", "BKK": "13.6900°N\n100.7501°E", "DPS": "8.7482°S\n115.1672°E",
        "LHR": "51.4700°N\n0.4543°W", "JFK": "40.6413°N\n73.7781°W",
    ]
}

/// Semantic icon names, mapped by the theme to SF Symbols.
public enum SynqIcon: String, CaseIterable {
    case back, forward, close, more, settings, scan, copy, share, invite, plus, check, clock, warning, refresh
    case external, flight, flightLand, gift, send, grid, swap, pin, calendar, people, passkey
    case home, trips, group, ask, search, receipt, shield, vote, voted, money
    case deal, team, split, bank, contractor, theme, bell
}

public struct SynqIcons {
    public var symbols: [SynqIcon: String]
    public var weight: Font.Weight

    public func name(_ i: SynqIcon) -> String { symbols[i] ?? Self.standard[i] ?? "circle" }

    /// The plain SF Symbol for every icon; themes override what they want.
    public static let standard: [SynqIcon: String] = [
        .back: "arrow.left", .forward: "arrow.right", .close: "xmark", .more: "ellipsis", .settings: "gearshape", .scan: "viewfinder",
        .copy: "doc.on.doc", .share: "square.and.arrow.up", .invite: "plus", .plus: "plus", .check: "checkmark",
        .clock: "clock", .warning: "exclamationmark.triangle", .refresh: "arrow.clockwise",
        .external: "arrow.up.right.square", .flight: "airplane", .flightLand: "airplane.arrival", .gift: "gift",
        .send: "creditcard", .grid: "square.grid.2x2", .swap: "arrow.left.arrow.right", .pin: "mappin",
        .calendar: "calendar", .people: "person.2", .passkey: "key", .home: "house", .trips: "airplane",
        .group: "person.2", .ask: "sparkle", .search: "magnifyingglass", .receipt: "doc.text", .shield: "lock.shield",
        .vote: "hand.thumbsup", .voted: "hand.thumbsup.fill", .money: "dollarsign.circle",
        .deal: "signature", .team: "person.3", .split: "chart.pie", .bank: "building.columns",
        .contractor: "person.crop.circle.badge.checkmark", .theme: "paintpalette", .bell: "bell",
    ]
}

/// How the components draw themselves.
public struct SynqLooks {
    public enum PanelLabel { case notched, above }
    public enum Avatar { case pixel, initials }
    public enum Progress { case outlined, capsule }

    public var panelLabel: PanelLabel
    public var panelFilled: Bool
    public var avatar: Avatar
    public var progress: Progress
    public var uppercaseTitles: Bool
    /// Section labels followed by a hairline rule.
    public var ruledSections: Bool
}

public enum SynqArtSlot: String, CaseIterable {
    case home, flights, fund, send, gift, receipt, deal, risk, agent
}

public enum SynqArtVariant { case hero, strip }

public enum SynqTab: String, CaseIterable, Identifiable {
    case home, trips, ask, gifts, group
    public var id: String { rawValue }

    /// English name for VoiceOver, whatever the theme shows.
    public var spoken: String {
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
    static var defaultValue: any SynqTheme { SynqThemes.named(SynqThemes.defaultId) }
}

extension EnvironmentValues {
    public var synqTheme: any SynqTheme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

public enum SynqThemes {
    /// Every theme the app ships; the first is the default.
    public static let all: [any SynqTheme] = [AsciiTheme(), PaperTheme(), HoloTheme()]

    /// The theme used until the person picks one. The Messages extension keeps the
    /// first entry; the full-screen app sets its own before showing anything.
    public static var defaultId: String = all[0].id

    public static func named(_ id: String) -> any SynqTheme { all.first { $0.id == id } ?? all.first { $0.id == defaultId } ?? all[0] }

    /// The person's choice, kept on this device (Settings → Theme).
    public static let storageKey = "synq.theme"
    public static var current: any SynqTheme { named(UserDefaults.standard.string(forKey: storageKey) ?? defaultId) }
}

/// Applies the chosen theme to everything inside it and follows changes live.
public struct SynqThemeRoot<Content: View>: View {
    public init(@ViewBuilder content: @escaping () -> Content) {
        self.content = content
    }

    @AppStorage(SynqThemes.storageKey) private var themeId = SynqThemes.defaultId
    @ViewBuilder public var content: () -> Content

    public var body: some View {
        let theme = SynqThemes.named(themeId)
        content()
            .environment(\.synqTheme, theme)
            .preferredColorScheme(theme.colorScheme)
    }
}

// MARK: - Fonts

/// Registers the bundled fonts (shipped in the SynqShared resource bundle of
/// both the app and the extension) and reports which families loaded, so roles
/// fall back to system fonts when one is missing.
public enum SynqFonts {
    public static let files = ["JetBrainsMono-Regular.ttf", "JetBrainsMono-Medium.ttf", "JetBrainsMono-Bold.ttf",
                               "DepartureMono-Regular.otf", "NotoSansJP-Synq.ttf"]

    private final class Marker {}
    private static var registered = false

    /// The bundle holding the fonts: the package's resource bundle, or the code's
    /// own bundle when the sources are compiled directly (design previews).
    private static var bundle: Bundle {
        #if SWIFT_PACKAGE
        return Bundle.module
        #else
        return Bundle(for: Marker.self)
        #endif
    }

    /// Registers fonts found in `directory`, else in the SynqShared resource bundle.
    public static func register(from directory: URL? = nil) {
        guard !registered else { return }
        registered = true
        for file in files {
            let url = directory?.appendingPathComponent(file)
                ?? bundle.url(forResource: (file as NSString).deletingPathExtension,
                              withExtension: (file as NSString).pathExtension)
            guard let url else { continue }
            // Already registered is fine: the error is ignored.
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }

    private static var cache: [String: Bool] = [:]
    private static let lock = NSLock()

    public static func isAvailable(_ postScriptName: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let known = cache[postScriptName] { return known }
        let font = CTFontCreateWithName(postScriptName as CFString, 12, nil)
        let ok = (CTFontCopyPostScriptName(font) as String) == postScriptName
        cache[postScriptName] = ok
        return ok
    }
}
