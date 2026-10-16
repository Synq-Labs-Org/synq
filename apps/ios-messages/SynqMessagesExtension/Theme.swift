import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

// Theme-independent plumbing shared by every screen: the status vocabulary, the
// render mode (live on device, still for ImageRenderer previews), compact mode,
// the scroll container, haptics and keyboard hints. Looks live in SynqTheme.

// MARK: - Status

/// One vocabulary of states across cards, rows and badges.
enum SynqTone: Equatable {
    case waiting   // forming, pending approval, voting
    case live      // active fund
    case moving    // executing, booking, buying
    case done      // paid, booked, bought
    case failed
}

// MARK: - Render mode

/// Live on device; still (fixed frame, no platform controls) for ImageRenderer previews.
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

extension View {
    /// The screen's scroll container; a plain stack in still renders (ImageRenderer
    /// does not draw platform scroll views).
    func synqScroll() -> some View { modifier(SynqScroll()) }
}

struct SynqScroll: ViewModifier {
    @Environment(\.synqRenderMode) private var mode

    func body(content: Content) -> some View {
        if mode.isStill {
            content.fixedSize(horizontal: false, vertical: true)
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)
                .clipped()
        } else {
            ScrollView(showsIndicators: false) { content }
                .scrollDismissesKeyboard(.interactively)
        }
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
