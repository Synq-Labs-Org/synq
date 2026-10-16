import SwiftUI

// Synq's brand metal: the chrome S mark and the app icon. Cards themselves are
// holo trading cards (HoloCard.swift). Pure SwiftUI with no UIKit, so the same
// views render the app icon and design previews on macOS.

enum ChromeFinish: Equatable {
    case silver
    case titanium
}

enum Chrome {
    static func rgb(_ hex: UInt32, _ alpha: Double = 1) -> Color {
        Color(red: Double((hex >> 16) & 0xFF) / 255,
              green: Double((hex >> 8) & 0xFF) / 255,
              blue: Double(hex & 0xFF) / 255, opacity: alpha)
    }

    /// Banded chrome: bright and dark bands like polished metal reflecting a room.
    static func base(_ finish: ChromeFinish) -> LinearGradient {
        switch finish {
        case .silver:
            return LinearGradient(stops: [
                .init(color: rgb(0xF7F8FA), location: 0.00),
                .init(color: rgb(0xD3D7DC), location: 0.22),
                .init(color: rgb(0xF1F3F5), location: 0.38),
                .init(color: rgb(0xA9AEB5), location: 0.58),
                .init(color: rgb(0xE6E8EB), location: 0.78),
                .init(color: rgb(0xBFC3C9), location: 1.00),
            ], startPoint: .topLeading, endPoint: .bottomTrailing)
        case .titanium:
            return LinearGradient(stops: [
                .init(color: rgb(0x3A3D42), location: 0.00),
                .init(color: rgb(0x16181B), location: 0.30),
                .init(color: rgb(0x2E3136), location: 0.52),
                .init(color: rgb(0x0E0F11), location: 0.78),
                .init(color: rgb(0x25282C), location: 1.00),
            ], startPoint: .topLeading, endPoint: .bottomTrailing)
        }
    }

    /// Engraving ink and its highlight for text cut into the metal.
    static func ink(_ finish: ChromeFinish) -> Color {
        finish == .silver ? rgb(0x2A2D32) : rgb(0xDADDE2)
    }

    static func inkSoft(_ finish: ChromeFinish) -> Color {
        finish == .silver ? rgb(0x4A4E55, 0.85) : rgb(0xA8ACB3, 0.9)
    }

    /// Polished chrome for the logo stroke and edges.
    static let polish = LinearGradient(stops: [
        .init(color: rgb(0xFFFFFF), location: 0.00),
        .init(color: rgb(0xB9BEC6), location: 0.30),
        .init(color: rgb(0xF5F6F8), location: 0.50),
        .init(color: rgb(0x7C828B), location: 0.72),
        .init(color: rgb(0xE9EBEE), location: 1.00),
    ], startPoint: .topLeading, endPoint: .bottomTrailing)
}

// MARK: - Logo

/// The Synq mark: one continuous S (a payment going around the group and back)
/// inside an open orbit ring (the group, in sync). Drawn in a unit square.
struct SynqS: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: rect.minX + x * w, y: rect.minY + y * h) }
        var path = Path()
        path.move(to: p(0.665, 0.315))
        path.addCurve(to: p(0.335, 0.355), control1: p(0.60, 0.195), control2: p(0.33, 0.20))
        path.addCurve(to: p(0.665, 0.645), control1: p(0.34, 0.50), control2: p(0.66, 0.49))
        path.addCurve(to: p(0.335, 0.685), control1: p(0.67, 0.80), control2: p(0.40, 0.805))
        return path
    }
}

struct SynqOrbit: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let r = min(rect.width, rect.height) * 0.43
        // Two arcs with gaps (top right, bottom left) where the S leaves the ring.
        for (from, to) in [(-30.0, 125.0), (150.0, 305.0)] {
            let a = CGFloat(from) * .pi / 180
            path.move(to: CGPoint(x: c.x + r * cos(a), y: c.y + r * sin(a)))
            path.addArc(center: c, radius: r, startAngle: .degrees(from), endAngle: .degrees(to), clockwise: false)
        }
        return path
    }
}

/// Engraved chrome mark. `size` is the side of the square it occupies.
/// `engravedInk` cuts it dark into silver metal (small marks on silver cards).
struct SynqMark: View {
    var size: CGFloat
    var finish: ChromeFinish = .silver
    var showsOrbit = true
    var engravedInk = false

    var body: some View {
        if engravedInk { inked } else { polished }
    }

    private var inked: some View {
        SynqS()
            .stroke(style: StrokeStyle(lineWidth: size * 0.12, lineCap: .round, lineJoin: .round))
            .foregroundStyle(LinearGradient(colors: [Chrome.rgb(0x3A3E44), Chrome.rgb(0x1C1E22)],
                                            startPoint: .top, endPoint: .bottom))
            .shadow(color: .white.opacity(0.9), radius: 0, x: 0, y: 1)
            .frame(width: size, height: size)
    }

    private var polished: some View {
        let s = size
        return ZStack {
            if showsOrbit {
                SynqOrbit()
                    .stroke(style: StrokeStyle(lineWidth: s * 0.035, lineCap: .round))
                    .foregroundStyle(Chrome.polish)
                    .shadow(color: .black.opacity(finish == .silver ? 0.25 : 0.6), radius: s * 0.01, y: s * 0.012)
            }
            // Cut: a darker stroke offset down, then the polished stroke, then a hairline highlight.
            SynqS()
                .stroke(style: StrokeStyle(lineWidth: s * 0.115, lineCap: .round, lineJoin: .round))
                .foregroundStyle(Color.black.opacity(finish == .silver ? 0.35 : 0.7))
                .offset(y: s * 0.012)
                .blur(radius: s * 0.006)
            SynqS()
                .stroke(style: StrokeStyle(lineWidth: s * 0.105, lineCap: .round, lineJoin: .round))
                .foregroundStyle(Chrome.polish)
            SynqS()
                .stroke(style: StrokeStyle(lineWidth: s * 0.02, lineCap: .round))
                .foregroundStyle(Color.white.opacity(0.75))
                .offset(x: -s * 0.012, y: -s * 0.014)
                .blur(radius: s * 0.004)
                .mask(SynqS().stroke(style: StrokeStyle(lineWidth: s * 0.105, lineCap: .round)))
        }
        .frame(width: s, height: s)
    }
}

/// The app icon: the chrome mark on a black titanium tile.
struct SynqAppIcon: View {
    var size: CGFloat
    var aspect: CGFloat = 1   // width / height (Messages icons are 4:3)

    var body: some View {
        let h = size, w = size * aspect
        ZStack {
            Rectangle().fill(Chrome.base(.titanium))
            BrushedLines(opacity: 0.07, spacing: max(1, h / 220))
            RadialGradient(colors: [Color.white.opacity(0.16), .clear],
                           center: UnitPoint(x: 0.3, y: 0.2), startRadius: 0, endRadius: h * 0.8)
            SynqMark(size: h * 0.78, finish: .titanium)
        }
        .frame(width: w, height: h)
        .clipped()
    }
}

// MARK: - Metal surface

/// Fine horizontal brushing, deterministic so renders are stable.
struct BrushedLines: View {
    var opacity: Double = 0.08
    var spacing: CGFloat = 1.5

    var body: some View {
        Canvas { ctx, size in
            var seed: UInt64 = 0x5EED
            func rand() -> Double {
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                return Double(seed >> 33) / Double(1 << 31)
            }
            var y: CGFloat = 0
            while y < size.height {
                let light = rand() > 0.5
                var line = Path()
                line.move(to: CGPoint(x: 0, y: y))
                line.addLine(to: CGPoint(x: size.width, y: y))
                ctx.stroke(line, with: .color((light ? Color.white : Color.black).opacity(opacity * rand())),
                           lineWidth: 0.6)
                y += spacing
            }
        }
        .allowsHitTesting(false)
    }
}
