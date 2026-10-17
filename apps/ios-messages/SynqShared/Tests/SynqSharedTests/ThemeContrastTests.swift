import SwiftUI
@testable import SynqShared
import XCTest
#if canImport(AppKit)
import AppKit
#endif

/// Every theme's text inks meet WCAG 2.1 contrast on the surfaces they sit on:
/// 4.5:1 for body text (primary, secondary, status inks), 3:1 for tertiary
/// hints and controls' outlines are not text so are not checked.
final class ThemeContrastTests: XCTestCase {
    static func rgb(_ c: Color) -> (Double, Double, Double) {
        #if canImport(AppKit)
        let n = NSColor(c).usingColorSpace(.sRGB)!
        return (Double(n.redComponent), Double(n.greenComponent), Double(n.blueComponent))
        #else
        return (0, 0, 0)
        #endif
    }

    static func luminance(_ c: Color) -> Double {
        let (r, g, b) = rgb(c)
        func lin(_ v: Double) -> Double { v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    }

    static func ratio(_ a: Color, _ b: Color) -> Double {
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    func testTextInksMeetContrastOnEverySurface() {
        var report: [String] = []
        for theme in SynqThemes.all {
            let c = theme.colors
            for (surfaceName, surface) in [("background", c.background), ("panel", c.panel)] {
                for (inkName, ink, minimum) in [("primary", c.inkPrimary, 4.5), ("secondary", c.inkSecondary, 4.5),
                                                ("approved", c.approved, 4.5), ("pending", c.pending, 4.5),
                                                ("danger", c.danger, 4.5), ("tertiary", c.inkTertiary, 3.0)] {
                    let r = Self.ratio(ink, surface)
                    report.append("\(theme.id) \(inkName)/\(surfaceName) \(String(format: "%.2f", r))")
                    XCTAssertGreaterThanOrEqual(r, minimum, "\(theme.id): \(inkName) on \(surfaceName) is \(r)")
                }
            }
            let onAccent = Self.ratio(c.onAccent, c.accent)
            XCTAssertGreaterThanOrEqual(onAccent, 4.5, "\(theme.id): primary button text")
            let approvedBadge = Self.ratio(c.approved, c.approvedFill)
            XCTAssertGreaterThanOrEqual(approvedBadge, 4.5, "\(theme.id): approved badge text")
            report.append("\(theme.id) onAccent \(String(format: "%.2f", onAccent)) approvedBadge \(String(format: "%.2f", approvedBadge))")
        }
        print(report.joined(separator: "\n"))
    }
}
