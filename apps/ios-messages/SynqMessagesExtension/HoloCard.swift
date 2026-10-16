import SwiftUI

// Synq's collectible "holo cards": every fund, payment, trip and gift is a card
// with a foil frame, generated art, a headline number (like a trading card's HP),
// up to three "moves" (the key facts) and a set line. Rarity follows state:
// forming/pending are common, live/approved are rare, paid/booked are holo rare
// with a stronger foil. Pure SwiftUI (no UIKit) so previews render on macOS.

// MARK: - Model

enum HoloKind: String, Equatable {
    case fund, payment, trip, gift

    var accent: Color {
        switch self {
        case .fund: return Theme.violet
        case .payment: return Theme.blue
        case .trip: return Theme.teal
        case .gift: return Theme.pink
        }
    }

    var accentHi: Color {
        switch self {
        case .fund: return Theme.violetHi
        case .payment: return Theme.blueHi
        case .trip: return Theme.tealHi
        case .gift: return Theme.pinkHi
        }
    }

    /// Darkest tone of the card body.
    var deep: Color {
        switch self {
        case .fund: return Theme.rgb(0x1A1036)
        case .payment: return Theme.rgb(0x0B1A3A)
        case .trip: return Theme.rgb(0x062A2A)
        case .gift: return Theme.rgb(0x33102A)
        }
    }

    var symbol: String {
        switch self {
        case .fund: return "building.columns.fill"
        case .payment: return "bolt.fill"
        case .trip: return "airplane"
        case .gift: return "gift.fill"
        }
    }

    /// The card's "type", spoken by VoiceOver and shown on the energy badge.
    var typeName: String {
        switch self {
        case .fund: return "Vault"
        case .payment: return "Energy"
        case .trip: return "Flight"
        case .gift: return "Gift"
        }
    }
}

enum HoloRarity: Int, Equatable, Comparable {
    case common, rare, holoRare

    static func < (a: HoloRarity, b: HoloRarity) -> Bool { a.rawValue < b.rawValue }

    var symbol: String {
        switch self {
        case .common: return "circle.fill"
        case .rare: return "diamond.fill"
        case .holoRare: return "star.fill"
        }
    }

    var name: String {
        switch self {
        case .common: return "Common"
        case .rare: return "Rare"
        case .holoRare: return "Holo rare"
        }
    }
}

struct HoloMove: Equatable {
    var symbol: String
    var name: String
    var detail: String? = nil
    var value: String? = nil
    /// Approvals as pips: (counted, required).
    var pips: Pips? = nil

    struct Pips: Equatable {
        var on: Int
        var total: Int
    }
}

/// A tiny stat on the card's bottom strip (like a trading card's weakness/retreat row).
struct HoloStat: Equatable {
    var label: String
    var value: String
}

struct HoloArtSpec: Equatable {
    var from: String? = nil
    var to: String? = nil
    var roundTrip = false
    /// Members (fund orbits) or options (gift confetti).
    var count = 3
}

struct HoloCardModel: Equatable {
    var kind: HoloKind
    var rarity: HoloRarity
    var stage: String
    var name: String
    var headline: String?
    var unit: String
    var status: String
    var tone: SynqTone
    var flavor: String
    var moves: [HoloMove]
    var setCode: String
    var network: String
    var art = HoloArtSpec()
    var stats: [HoloStat] = []
    var accessibilityLabel: String
}

/// Where the light hits the card: x/y in unit space, plus the foil phase.
struct HoloLight: Equatable {
    var x: Double = 0.32
    var y: Double = 0.22
    var phase: Double = 0.35
}

// MARK: - Foil

enum Foil {
    static let rainbow: [Color] = [
        Theme.rgb(0xFF7AD9), Theme.rgb(0xFFE27A), Theme.rgb(0x7CFFB2),
        Theme.rgb(0x6FD6FF), Theme.rgb(0xA98BFF), Theme.rgb(0xFF7AD9),
    ]

    static func angular(_ phase: Double) -> AngularGradient {
        AngularGradient(colors: rainbow, center: .center, angle: .degrees(phase * 360))
    }

    /// Diagonal rainbow bands that slide with the light.
    static func bands(_ light: HoloLight) -> LinearGradient {
        let shift = light.x * 0.6 + light.phase * 0.8
        var stops: [Gradient.Stop] = []
        for i in 0..<14 {
            let loc = Double(i) / 13
            let c = rainbow[(i + Int(shift * 10)) % (rainbow.count - 1)]
            stops.append(.init(color: c, location: loc))
        }
        return LinearGradient(stops: stops,
                              startPoint: UnitPoint(x: -0.2 + shift * 0.3, y: 0),
                              endPoint: UnitPoint(x: 1.2 + shift * 0.3, y: 1))
    }

    /// Metallic edge for common cards.
    static func metal(_ kind: HoloKind) -> LinearGradient {
        LinearGradient(colors: [Color.white.opacity(0.75), kind.accentHi.opacity(0.55), Color.white.opacity(0.18),
                                kind.accent.opacity(0.6), Color.white.opacity(0.55)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// Light catching the foil: rainbow bands, a glare spot and a moving highlight band.
struct HoloSheen: View {
    var light: HoloLight
    var rarity: HoloRarity
    var cornerRadius: CGFloat

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            let band = rarity == .holoRare ? 0.2 : rarity == .rare ? 0.12 : 0.05
            ZStack {
                Rectangle().fill(Foil.bands(light)).opacity(band).blendMode(.overlay)
                Rectangle().fill(Foil.bands(light)).opacity(band * 0.3).blendMode(.colorDodge)
                RadialGradient(colors: [Color.white.opacity(rarity == .common ? 0.16 : 0.28), .clear],
                               center: UnitPoint(x: light.x, y: light.y), startRadius: 0, endRadius: max(w, h) * 0.7)
                    .blendMode(.screen)
                LinearGradient(stops: [
                    .init(color: .clear, location: 0),
                    .init(color: Color.white.opacity(0.10), location: 0.45),
                    .init(color: Color.white.opacity(rarity == .common ? 0.12 : 0.22), location: 0.5),
                    .init(color: Color.white.opacity(0.10), location: 0.55),
                    .init(color: .clear, location: 1),
                ], startPoint: .leading, endPoint: .trailing)
                .frame(width: w * 0.6, height: h * 2)
                .rotationEffect(.degrees(24))
                .offset(x: -w * 0.8 + w * 1.6 * light.phase, y: 0)
                .blendMode(.screen)
            }
            .frame(width: w, height: h)
        }
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .allowsHitTesting(false)
    }
}

/// Deterministic star sparkles for holo-rare foil.
struct Sparkles: View, Equatable {
    var count = 46
    var seed: UInt64 = 0x51A2

    var body: some View {
        Canvas { ctx, size in
            var s = seed
            func rand() -> Double {
                s = s &* 6364136223846793005 &+ 1442695040888963407
                return Double(s >> 33) / Double(1 << 31)
            }
            for _ in 0..<count {
                let x = rand() * size.width, y = rand() * size.height
                let r = 0.6 + rand() * 2.2
                var star = Path()
                star.move(to: CGPoint(x: x, y: y - r * 2.2))
                star.addQuadCurve(to: CGPoint(x: x + r * 2.2, y: y), control: CGPoint(x: x, y: y))
                star.addQuadCurve(to: CGPoint(x: x, y: y + r * 2.2), control: CGPoint(x: x, y: y))
                star.addQuadCurve(to: CGPoint(x: x - r * 2.2, y: y), control: CGPoint(x: x, y: y))
                star.addQuadCurve(to: CGPoint(x: x, y: y - r * 2.2), control: CGPoint(x: x, y: y))
                ctx.fill(star, with: .color(Color.white.opacity(0.35 + rand() * 0.6)))
            }
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Art

/// Generated abstract art per kind. Equatable so tilt frames do not redraw it.
struct HoloArt: View, Equatable {
    var kind: HoloKind
    var spec: HoloArtSpec

    var body: some View {
        Canvas { ctx, size in
            switch kind {
            case .fund: HoloArt.fund(&ctx, size, spec)
            case .payment: HoloArt.payment(&ctx, size)
            case .trip: HoloArt.trip(&ctx, size, spec)
            case .gift: HoloArt.gift(&ctx, size, spec)
            }
        }
        .overlay {
            if kind == .fund {
                GeometryReader { geo in
                    let d = min(geo.size.width, geo.size.height) * 0.42
                    SynqMark(size: d, finish: .titanium, showsOrbit: false)
                        .position(x: geo.size.width / 2, y: geo.size.height * 0.52)
                }
            }
        }
        .accessibilityHidden(true)
    }

    private static func stars(_ ctx: inout GraphicsContext, _ size: CGSize, seed: UInt64, count: Int, tint: Color) {
        var s = seed
        func rand() -> Double {
            s = s &* 6364136223846793005 &+ 1442695040888963407
            return Double(s >> 33) / Double(1 << 31)
        }
        for _ in 0..<count {
            let r = 0.4 + rand() * 1.3
            let rect = CGRect(x: rand() * size.width, y: rand() * size.height, width: r * 2, height: r * 2)
            ctx.fill(Path(ellipseIn: rect), with: .color((rand() > 0.7 ? tint : Color.white).opacity(0.25 + rand() * 0.6)))
        }
    }

    private static func background(_ ctx: inout GraphicsContext, _ size: CGSize, _ colors: [Color], center: CGPoint) {
        let rect = CGRect(origin: .zero, size: size)
        ctx.fill(Path(rect), with: .color(colors.last ?? .black))
        ctx.fill(Path(rect), with: .radialGradient(Gradient(colors: colors), center: center, startRadius: 0,
                                                   endRadius: max(size.width, size.height) * 0.85))
    }

    // Fund: a vault door at the centre of orbiting members.
    static func fund(_ ctx: inout GraphicsContext, _ size: CGSize, _ spec: HoloArtSpec) {
        let w = size.width, h = size.height
        let c = CGPoint(x: w / 2, y: h * 0.52)
        background(&ctx, size, [Theme.rgb(0x6A4BFF), Theme.rgb(0x2A1670), Theme.rgb(0x0E0826), Theme.rgb(0x05030F)], center: c)
        stars(&ctx, size, seed: 0xF00D, count: 70, tint: Theme.violetHi)
        // Orbits, tilted, with a planet per member.
        let planets = max(2, min(8, spec.count))
        for (i, rx) in [w * 0.46, w * 0.36, w * 0.27].enumerated() {
            var orbit = ctx
            orbit.translateBy(x: c.x, y: c.y)
            orbit.rotate(by: .degrees(-16))
            let ry = rx * 0.36
            let ellipse = Path(ellipseIn: CGRect(x: -rx, y: -ry, width: rx * 2, height: ry * 2))
            orbit.stroke(ellipse, with: .color(Theme.violetHi.opacity(0.22 + Double(i) * 0.08)), lineWidth: 1)
            for p in 0..<planets where p % 3 == i {
                let a = CGFloat(Double(p) / Double(planets) * 2 * .pi + Double(i) * 0.9)
                let pt = CGPoint(x: rx * cos(a), y: ry * sin(a))
                let r = h * 0.024
                var glow = orbit
                glow.addFilter(.blur(radius: r * 1.6))
                glow.fill(Path(ellipseIn: CGRect(x: pt.x - r * 2, y: pt.y - r * 2, width: r * 4, height: r * 4)),
                          with: .color(Theme.violetHi.opacity(0.8)))
                orbit.fill(Path(ellipseIn: CGRect(x: pt.x - r, y: pt.y - r, width: r * 2, height: r * 2)),
                           with: .color(.white))
            }
        }
        // Vault door.
        let R = min(w, h) * 0.30
        var halo = ctx
        halo.addFilter(.blur(radius: R * 0.35))
        halo.fill(Path(ellipseIn: CGRect(x: c.x - R * 1.1, y: c.y - R * 1.1, width: R * 2.2, height: R * 2.2)),
                  with: .color(Theme.violet.opacity(0.75)))
        let door = Path(ellipseIn: CGRect(x: c.x - R, y: c.y - R, width: R * 2, height: R * 2))
        ctx.fill(door, with: .radialGradient(Gradient(colors: [Theme.rgb(0x3A2A78), Theme.rgb(0x150C33)]),
                                             center: CGPoint(x: c.x - R * 0.3, y: c.y - R * 0.4),
                                             startRadius: 0, endRadius: R * 1.4))
        ctx.stroke(door, with: .linearGradient(Gradient(colors: [.white, Theme.violetHi, Theme.rgb(0x6C5BB0), .white]),
                                               startPoint: CGPoint(x: c.x - R, y: c.y - R),
                                               endPoint: CGPoint(x: c.x + R, y: c.y + R)), lineWidth: R * 0.07)
        let inner = R * 0.78
        ctx.stroke(Path(ellipseIn: CGRect(x: c.x - inner, y: c.y - inner, width: inner * 2, height: inner * 2)),
                   with: .color(Color.white.opacity(0.22)), style: StrokeStyle(lineWidth: R * 0.025, dash: [R * 0.06, R * 0.05]))
        for k in 0..<12 {
            let a = CGFloat(Double(k) / 12 * 2 * .pi)
            let p = CGPoint(x: c.x + R * 0.89 * cos(a), y: c.y + R * 0.89 * sin(a))
            let b = R * 0.045
            ctx.fill(Path(ellipseIn: CGRect(x: p.x - b, y: p.y - b, width: b * 2, height: b * 2)),
                     with: .color(Theme.violetHi.opacity(0.9)))
        }
    }

    // Payment: energy converging into a bolt.
    static func payment(_ ctx: inout GraphicsContext, _ size: CGSize) {
        let w = size.width, h = size.height
        let c = CGPoint(x: w * 0.56, y: h * 0.5)
        background(&ctx, size, [Theme.rgb(0x4FA8FF), Theme.rgb(0x1C4FB8), Theme.rgb(0x0A1A45), Theme.rgb(0x030816)], center: c)
        stars(&ctx, size, seed: 0xB01, count: 50, tint: Theme.blueHi)
        for i in 0..<7 {
            let t = Double(i) / 6
            let y0 = h * (0.12 + 0.76 * t)
            var wave = Path()
            wave.move(to: CGPoint(x: -4, y: y0))
            wave.addCurve(to: c,
                          control1: CGPoint(x: w * 0.25, y: y0 + (t - 0.5) * h * 0.5),
                          control2: CGPoint(x: w * 0.38, y: c.y + (t - 0.5) * h * 0.1))
            var glow = ctx
            glow.addFilter(.blur(radius: 3))
            glow.stroke(wave, with: .color(Theme.blueHi.opacity(0.5)), lineWidth: 2.4)
            ctx.stroke(wave, with: .linearGradient(Gradient(colors: [.clear, Theme.blueHi.opacity(0.9), .white]),
                                                   startPoint: CGPoint(x: 0, y: y0), endPoint: c), lineWidth: 0.9)
        }
        // Burst behind the bolt.
        var burst = ctx
        burst.addFilter(.blur(radius: h * 0.10))
        burst.fill(Path(ellipseIn: CGRect(x: c.x - h * 0.3, y: c.y - h * 0.3, width: h * 0.6, height: h * 0.6)),
                   with: .color(Theme.blueHi.opacity(0.8)))
        for k in 0..<16 {
            let a = CGFloat(Double(k) / 16 * 2 * .pi)
            let r1 = h * 0.2, r2 = h * (k % 2 == 0 ? 0.46 : 0.34)
            var ray = Path()
            ray.move(to: CGPoint(x: c.x + r1 * cos(a), y: c.y + r1 * sin(a)))
            ray.addLine(to: CGPoint(x: c.x + r2 * cos(a), y: c.y + r2 * sin(a)))
            ctx.stroke(ray, with: .color(Color.white.opacity(0.18)), lineWidth: 1)
        }
        // The bolt.
        let s = h * 0.36
        var bolt = Path()
        bolt.move(to: CGPoint(x: c.x + s * 0.10, y: c.y - s))
        bolt.addLine(to: CGPoint(x: c.x - s * 0.42, y: c.y + s * 0.12))
        bolt.addLine(to: CGPoint(x: c.x - s * 0.02, y: c.y + s * 0.12))
        bolt.addLine(to: CGPoint(x: c.x - s * 0.16, y: c.y + s))
        bolt.addLine(to: CGPoint(x: c.x + s * 0.42, y: c.y - s * 0.16))
        bolt.addLine(to: CGPoint(x: c.x + s * 0.02, y: c.y - s * 0.16))
        bolt.closeSubpath()
        var boltGlow = ctx
        boltGlow.addFilter(.blur(radius: s * 0.12))
        boltGlow.fill(bolt, with: .color(Theme.blueHi))
        ctx.fill(bolt, with: .linearGradient(Gradient(colors: [.white, Theme.rgb(0xCFE8FF), Theme.blueHi]),
                                             startPoint: CGPoint(x: c.x, y: c.y - s), endPoint: CGPoint(x: c.x, y: c.y + s)))
        ctx.stroke(bolt, with: .color(Color.white.opacity(0.9)), lineWidth: 0.8)
    }

    // Trip: a flight path over the curve of the earth.
    static func trip(_ ctx: inout GraphicsContext, _ size: CGSize, _ spec: HoloArtSpec) {
        let w = size.width, h = size.height
        background(&ctx, size, [Theme.rgb(0x2EE6C8), Theme.rgb(0x0B6B66), Theme.rgb(0x05282B), Theme.rgb(0x020B0D)],
                   center: CGPoint(x: w * 0.5, y: h * 0.15))
        stars(&ctx, size, seed: 0x7121, count: 45, tint: Theme.tealHi)
        // Globe.
        let gc = CGPoint(x: w * 0.5, y: h * 1.55)
        let gr = h * 1.1
        let globe = Path(ellipseIn: CGRect(x: gc.x - gr, y: gc.y - gr, width: gr * 2, height: gr * 2))
        var atmosphere = ctx
        atmosphere.addFilter(.blur(radius: h * 0.05))
        atmosphere.stroke(globe, with: .color(Theme.tealHi.opacity(0.7)), lineWidth: h * 0.03)
        ctx.fill(globe, with: .linearGradient(Gradient(colors: [Theme.rgb(0x0D4D4A), Theme.rgb(0x031A1B)]),
                                              startPoint: CGPoint(x: gc.x, y: gc.y - gr), endPoint: CGPoint(x: gc.x, y: gc.y)))
        var grid = ctx
        grid.clip(to: globe)
        for i in 1...5 {
            let rx = gr * Double(i) / 5.5
            grid.stroke(Path(ellipseIn: CGRect(x: gc.x - rx, y: gc.y - gr, width: rx * 2, height: gr * 2)),
                        with: .color(Theme.tealHi.opacity(0.16)), lineWidth: 0.7)
        }
        for i in 1...4 {
            let y = gc.y - gr + gr * 0.12 * Double(i)
            let half = sqrt(max(0, gr * gr - (gc.y - y) * (gc.y - y)))
            var lat = Path()
            lat.move(to: CGPoint(x: gc.x - half, y: y))
            lat.addLine(to: CGPoint(x: gc.x + half, y: y))
            grid.stroke(lat, with: .color(Theme.tealHi.opacity(0.14)), lineWidth: 0.7)
        }
        ctx.stroke(globe, with: .color(Theme.tealHi.opacity(0.65)), lineWidth: 1)
        // Route.
        let inset = max(w * 0.17, min(w, h) * 0.2)
        let a = CGPoint(x: inset, y: h * 0.66)
        let b = CGPoint(x: w - inset, y: h * 0.66)
        let ctrl = CGPoint(x: w * 0.5, y: h * 0.02)
        var arc = Path()
        arc.move(to: a)
        arc.addQuadCurve(to: b, control: ctrl)
        var arcGlow = ctx
        arcGlow.addFilter(.blur(radius: 4))
        arcGlow.stroke(arc, with: .color(Theme.tealHi.opacity(0.8)), lineWidth: 3)
        ctx.stroke(arc, with: .color(.white), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, dash: [5, 5]))
        if spec.roundTrip {
            var back = Path()
            back.move(to: b)
            back.addQuadCurve(to: a, control: CGPoint(x: w * 0.5, y: h * 0.40))
            ctx.stroke(back, with: .color(Theme.tealHi.opacity(0.7)),
                       style: StrokeStyle(lineWidth: 1.1, lineCap: .round, dash: [2, 4]))
        }
        for p in [a, b] {
            let r = h * 0.035
            var ring = ctx
            ring.addFilter(.blur(radius: r))
            ring.fill(Path(ellipseIn: CGRect(x: p.x - r * 2, y: p.y - r * 2, width: r * 4, height: r * 4)),
                      with: .color(Theme.tealHi))
            ctx.fill(Path(ellipseIn: CGRect(x: p.x - r, y: p.y - r, width: r * 2, height: r * 2)), with: .color(.white))
        }
        let font = Font.system(size: min(h * 0.105, w * 0.13), weight: .heavy, design: .rounded)
        if let from = spec.from {
            ctx.draw(Text(from).font(font).foregroundColor(.white), at: CGPoint(x: a.x, y: a.y + h * 0.12))
        }
        if let to = spec.to {
            ctx.draw(Text(to).font(font).foregroundColor(.white), at: CGPoint(x: b.x, y: b.y + h * 0.12))
        }
        // The plane at the top of the arc, nose along the route.
        let apex = CGPoint(x: w * 0.5, y: h * 0.34)
        var plane = ctx
        plane.translateBy(x: apex.x, y: apex.y)
        var planeGlow = plane
        planeGlow.addFilter(.blur(radius: h * 0.05))
        planeGlow.fill(Path(ellipseIn: CGRect(x: -h * 0.09, y: -h * 0.09, width: h * 0.18, height: h * 0.18)),
                       with: .color(Theme.tealHi.opacity(0.9)))
        plane.draw(Text(Image(systemName: "airplane")).font(.system(size: h * 0.16, weight: .bold)).foregroundColor(.white),
                   at: .zero)
    }

    // Gift: ribbons and a wrapped box.
    static func gift(_ ctx: inout GraphicsContext, _ size: CGSize, _ spec: HoloArtSpec) {
        let w = size.width, h = size.height
        background(&ctx, size, [Theme.rgb(0xFF6FB5), Theme.rgb(0x9A1B63), Theme.rgb(0x3A0A27), Theme.rgb(0x12030C)],
                   center: CGPoint(x: w * 0.5, y: h * 0.45))
        // Ribbons sweeping across.
        for i in 0..<3 {
            let y = h * (0.2 + Double(i) * 0.28)
            var band = Path()
            band.move(to: CGPoint(x: -10, y: y + h * 0.1))
            band.addCurve(to: CGPoint(x: w + 10, y: y - h * 0.05),
                          control1: CGPoint(x: w * 0.3, y: y - h * 0.35),
                          control2: CGPoint(x: w * 0.6, y: y + h * 0.35))
            var soft = ctx
            soft.addFilter(.blur(radius: 6))
            soft.stroke(band, with: .color(Theme.pinkHi.opacity(0.25)), lineWidth: h * 0.12)
            ctx.stroke(band, with: .linearGradient(Gradient(colors: [Theme.pinkHi.opacity(0.0), Theme.pinkHi.opacity(0.75),
                                                                     Theme.rgb(0xFFD6EA).opacity(0.4), .clear]),
                                                   startPoint: CGPoint(x: 0, y: y), endPoint: CGPoint(x: w, y: y)),
                       lineWidth: h * 0.035)
        }
        // Confetti.
        var s: UInt64 = 0x6157 &+ UInt64(spec.count)
        func rand() -> Double {
            s = s &* 6364136223846793005 &+ 1442695040888963407
            return Double(s >> 33) / Double(1 << 31)
        }
        for _ in 0..<38 {
            var piece = ctx
            piece.translateBy(x: rand() * w, y: rand() * h)
            piece.rotate(by: .degrees(rand() * 180))
            let color = Foil.rainbow[Int(rand() * 5)]
            piece.fill(Path(CGRect(x: -2.5, y: -1, width: 5, height: 2)), with: .color(color.opacity(0.85)))
        }
        // Box with ribbon and bow.
        let bw = min(w * 0.38, h * 0.52), bh = bw * 0.72
        let box = CGRect(x: w / 2 - bw / 2, y: h * 0.86 - bh, width: bw, height: bh)
        var boxGlow = ctx
        boxGlow.addFilter(.blur(radius: bw * 0.18))
        boxGlow.fill(Path(roundedRect: box.insetBy(dx: -6, dy: -6), cornerRadius: 10), with: .color(Theme.pink.opacity(0.7)))
        ctx.fill(Path(roundedRect: box, cornerRadius: bw * 0.06),
                 with: .linearGradient(Gradient(colors: [Theme.rgb(0xE23A8C), Theme.rgb(0x7A1048)]),
                                       startPoint: CGPoint(x: box.minX, y: box.minY), endPoint: CGPoint(x: box.maxX, y: box.maxY)))
        let lid = CGRect(x: box.minX - bw * 0.05, y: box.minY - bh * 0.08, width: bw * 1.1, height: bh * 0.24)
        ctx.fill(Path(roundedRect: lid, cornerRadius: bw * 0.05),
                 with: .linearGradient(Gradient(colors: [Theme.rgb(0xFF7DBA), Theme.rgb(0xC21F72)]),
                                       startPoint: CGPoint(x: lid.minX, y: lid.minY), endPoint: CGPoint(x: lid.minX, y: lid.maxY)))
        let stripe = CGRect(x: w / 2 - bw * 0.07, y: lid.minY, width: bw * 0.14, height: box.maxY - lid.minY)
        ctx.fill(Path(stripe), with: .linearGradient(Gradient(colors: [.white, Theme.rgb(0xFFE3F1)]),
                                                     startPoint: CGPoint(x: stripe.minX, y: 0), endPoint: CGPoint(x: stripe.maxX, y: 0)))
        for side in [-1.0, 1.0] {
            var loop = ctx
            loop.translateBy(x: w / 2 + side * bw * 0.17, y: lid.minY - bh * 0.13)
            loop.rotate(by: .degrees(side * 28))
            let r = CGRect(x: -bw * 0.17, y: -bh * 0.13, width: bw * 0.34, height: bh * 0.26)
            loop.fill(Path(ellipseIn: r), with: .color(Color.white.opacity(0.95)))
            loop.stroke(Path(ellipseIn: r.insetBy(dx: bw * 0.04, dy: bh * 0.04)), with: .color(Theme.pink.opacity(0.6)),
                        lineWidth: 1.2)
        }
        let knot = bw * 0.07
        ctx.fill(Path(ellipseIn: CGRect(x: w / 2 - knot, y: lid.minY - knot * 1.4, width: knot * 2, height: knot * 2)),
                 with: .color(Theme.rgb(0xFFE3F1)))
    }
}

// MARK: - Pieces

/// The card's type, like a trading card's energy symbol.
struct EnergyBadge: View {
    var kind: HoloKind
    var size: CGFloat

    var body: some View {
        Image(systemName: kind.symbol)
            .font(.system(size: size * 0.5, weight: .bold))
            .foregroundStyle(Color.white)
            .frame(width: size, height: size)
            .background(Circle().fill(RadialGradient(colors: [kind.accentHi, kind.accent, kind.deep],
                                                     center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: size * 0.7)))
            .overlay(Circle().strokeBorder(LinearGradient(colors: [.white, Color.white.opacity(0.2)],
                                                          startPoint: .top, endPoint: .bottom), lineWidth: max(0.75, size * 0.06)))
            .shadow(color: kind.accent.opacity(0.8), radius: size * 0.25)
    }
}

struct HoloPips: View {
    var pips: HoloMove.Pips
    var color: Color
    var size: CGFloat

    var body: some View {
        HStack(spacing: size * 0.45) {
            ForEach(0..<max(1, pips.total), id: \.self) { i in
                let on = i < pips.on
                Circle()
                    .fill(on ? AnyShapeStyle(LinearGradient(colors: [.white, color], startPoint: .top, endPoint: .bottom))
                             : AnyShapeStyle(Color.white.opacity(0.06)))
                    .overlay(Circle().strokeBorder(on ? Color.white.opacity(0.8) : Color.white.opacity(0.35), lineWidth: 0.8))
                    .frame(width: size, height: size)
                    .shadow(color: on ? color : .clear, radius: size * 0.5)
            }
        }
    }
}

/// Foil frame + dark inner panel, shared by every face.
struct HoloFrame<Content: View>: View {
    var kind: HoloKind
    var rarity: HoloRarity
    var light: HoloLight
    var cornerRadius: CGFloat
    var border: CGFloat
    @ViewBuilder var content: () -> Content

    var body: some View {
        let outer = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let inner = RoundedRectangle(cornerRadius: max(2, cornerRadius - border * 0.8), style: .continuous)
        ZStack {
            // Frame band: graphite for common, foil for rare and up.
            outer.fill(LinearGradient(colors: [Theme.rgb(0x2A2A33), Theme.rgb(0x0D0D12), Theme.rgb(0x22222B)],
                                      startPoint: .topLeading, endPoint: .bottomTrailing))
            outer.fill(Foil.angular(light.phase + light.x * 0.3))
                .opacity(rarity == .holoRare ? 0.85 : rarity == .rare ? 0.55 : 0.16)
                .blendMode(.screen)
            outer.fill(Foil.metal(kind)).opacity(rarity == .common ? 0.35 : 0.18).blendMode(.overlay)
            // Body.
            ZStack {
                inner.fill(LinearGradient(colors: [kind.deep, Theme.rgb(0x0A0910), Theme.rgb(0x060509)],
                                          startPoint: .top, endPoint: .bottom))
                inner.fill(RadialGradient(colors: [kind.accent.opacity(0.28), .clear], center: .top,
                                          startRadius: 0, endRadius: 320))
                FineLines().opacity(0.5).clipShape(inner)
                content()
            }
            .clipShape(inner)
            .overlay(inner.strokeBorder(Color.black.opacity(0.7), lineWidth: 1))
            .padding(border)
            HoloSheen(light: light, rarity: rarity, cornerRadius: cornerRadius)
            if rarity == .holoRare {
                Sparkles(count: 34).opacity(0.2 + 0.45 * light.x).blendMode(.plusLighter)
                    .clipShape(outer)
            }
        }
        .overlay(outer.strokeBorder(rarity == .common ? AnyShapeStyle(Foil.metal(kind))
                                                      : AnyShapeStyle(Foil.angular(light.phase * 1.3)),
                                    lineWidth: rarity == .holoRare ? 1.6 : 1))
        .compositingGroup()
    }
}

/// Faint diagonal engraving on the card body.
struct FineLines: View, Equatable {
    var body: some View {
        Canvas { ctx, size in
            var x: CGFloat = -size.height
            while x < size.width {
                var p = Path()
                p.move(to: CGPoint(x: x, y: size.height))
                p.addLine(to: CGPoint(x: x + size.height, y: 0))
                ctx.stroke(p, with: .color(Color.white.opacity(0.035)), lineWidth: 0.6)
                x += 5
            }
        }
        .allowsHitTesting(false)
    }
}

/// Soft coloured glow behind a card; brighter and iridescent as rarity rises.
struct HoloHalo: View {
    var kind: HoloKind
    var rarity: HoloRarity
    var cornerRadius: CGFloat
    var spread: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(LinearGradient(colors: [kind.accentHi, kind.accent], startPoint: .top, endPoint: .bottom))
                .blur(radius: spread * 0.55)
                .opacity(rarity == .common ? 0.38 : rarity == .rare ? 0.55 : 0.6)
            if rarity == .holoRare {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Foil.angular(0.1))
                    .blur(radius: spread * 0.8)
                    .opacity(0.5)
                    .padding(-spread * 0.2)
            }
            Ellipse()
                .fill(kind.accent)
                .blur(radius: spread * 1.4)
                .opacity(0.35)
                .padding(-spread * 0.6)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Faces

/// Portrait 5:7 face, the hero inside the expanded app.
struct HoloCardFace: View {
    var model: HoloCardModel
    var light = HoloLight()
    var showsHalo = true

    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width / 300
            face(s)
                .background {
                    if showsHalo {
                        HoloHalo(kind: model.kind, rarity: model.rarity, cornerRadius: 18 * s, spread: 34 * s)
                    }
                }
                .shadow(color: .black.opacity(0.55), radius: 16 * s, y: 10 * s)
        }
        .aspectRatio(5.0 / 7.0, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
    }

    private func face(_ s: CGFloat) -> some View {
        HoloFrame(kind: model.kind, rarity: model.rarity, light: light, cornerRadius: 18 * s, border: 9 * s) {
            HoloPortraitContent(model: model, s: s, light: light)
        }
    }
}

private struct HoloPortraitContent: View {
    var model: HoloCardModel
    var s: CGFloat
    var light: HoloLight

    var body: some View {
        VStack(spacing: 0) {
            titleRow
                .frame(height: 38 * s)
            artWindow
                .frame(height: 160 * s)
                .padding(.top, 6 * s)
            flavorStrip
                .offset(y: -7 * s)
                .padding(.bottom, -3 * s)
            VStack(spacing: 0) {
                ForEach(Array(model.moves.prefix(3).enumerated()), id: \.offset) { i, move in
                    if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.75) }
                    HoloMoveRow(move: move, kind: model.kind, s: s)
                        .frame(height: 37 * s)
                }
            }
            Spacer(minLength: 2 * s)
            if !model.stats.isEmpty {
                statStrip.padding(.bottom, 7 * s)
            }
            footer
        }
        .padding(.horizontal, 10 * s)
        .padding(.top, 8 * s)
        .padding(.bottom, 7 * s)
    }

    private var titleRow: some View {
        HStack(alignment: .center, spacing: 6 * s) {
            VStack(alignment: .leading, spacing: 1 * s) {
                Text(model.stage.uppercased())
                    .font(.system(size: 7.5 * s, weight: .heavy, design: .rounded))
                    .tracking(1.4 * s)
                    .foregroundStyle(model.kind.accentHi)
                    .lineLimit(1)
                Text(model.name)
                    .font(.system(size: 18 * s, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.55)
            }
            Spacer(minLength: 2 * s)
            if let headline = model.headline {
                HStack(alignment: .firstTextBaseline, spacing: 2.5 * s) {
                    Text(model.unit)
                        .font(.system(size: 8 * s, weight: .heavy, design: .rounded))
                        .foregroundStyle(Theme.text2)
                    Text(headline)
                        .font(.system(size: 22 * s, weight: .heavy, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(LinearGradient(colors: [.white, model.kind.accentHi],
                                                        startPoint: .top, endPoint: .bottom))
                        .contentTransition(.numericText())
                }
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .layoutPriority(1)
            }
            EnergyBadge(kind: model.kind, size: 22 * s)
        }
    }

    private var artWindow: some View {
        let shape = RoundedRectangle(cornerRadius: 8 * s, style: .continuous)
        return ZStack(alignment: .topLeading) {
            HoloArt(kind: model.kind, spec: model.art).equatable()
            if model.rarity >= .rare {
                Rectangle().fill(Foil.bands(light))
                    .opacity(model.rarity == .holoRare ? 0.32 : 0.18)
                    .blendMode(.overlay)
            }
            if model.rarity == .holoRare {
                Sparkles(count: 30, seed: 0xA27).opacity(0.5 + 0.4 * light.y).blendMode(.plusLighter)
            }
            HoloStatusRibbon(text: model.status, tone: model.tone, s: s)
                .padding(7 * s)
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(model.rarity == .common ? AnyShapeStyle(Foil.metal(model.kind))
                                                            : AnyShapeStyle(Foil.angular(light.phase + 0.25)),
                                    lineWidth: 1.6 * s))
        .shadow(color: .black.opacity(0.6), radius: 4 * s, y: 2 * s)
    }

    private var statStrip: some View {
        HStack(spacing: 0) {
            ForEach(Array(model.stats.prefix(3).enumerated()), id: \.offset) { i, stat in
                if i > 0 { Rectangle().fill(Color.white.opacity(0.1)).frame(width: 0.75, height: 18 * s) }
                VStack(spacing: 1.5 * s) {
                    Text(stat.label.uppercased())
                        .font(.system(size: 6.2 * s, weight: .heavy, design: .rounded))
                        .tracking(0.9 * s)
                        .foregroundStyle(Theme.text3)
                    Text(stat.value)
                        .font(.system(size: 10 * s, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundStyle(Theme.text)
                        .minimumScaleFactor(0.6)
                }
                .lineLimit(1)
                .frame(maxWidth: .infinity)
            }
        }
        .padding(.vertical, 5 * s)
        .background(RoundedRectangle(cornerRadius: 6 * s, style: .continuous).fill(Color.white.opacity(0.045)))
        .overlay(RoundedRectangle(cornerRadius: 6 * s, style: .continuous).strokeBorder(Color.white.opacity(0.07), lineWidth: 0.75))
    }

    private var flavorStrip: some View {
        Text(model.flavor)
            .font(.system(size: 8 * s, weight: .semibold, design: .rounded).italic())
            .foregroundStyle(Theme.text)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .padding(.horizontal, 10 * s)
            .padding(.vertical, 3.5 * s)
            .background(Capsule().fill(LinearGradient(colors: [Theme.rgb(0x2B2B36), Theme.rgb(0x15151C)],
                                                      startPoint: .top, endPoint: .bottom)))
            .overlay(Capsule().strokeBorder(model.rarity == .common ? AnyShapeStyle(Foil.metal(model.kind))
                                                                    : AnyShapeStyle(Foil.angular(light.phase)),
                                            lineWidth: 0.9 * s))
            .padding(.horizontal, 18 * s)
    }

    private var footer: some View {
        HStack(spacing: 4 * s) {
            Text(model.setCode)
                .font(.system(size: 7 * s, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.text3)
            Spacer(minLength: 2 * s)
            Text(model.network.uppercased())
                .font(.system(size: 6.8 * s, weight: .bold, design: .rounded))
                .tracking(0.8 * s)
                .foregroundStyle(Theme.text2)
            Spacer(minLength: 2 * s)
            HoloRarityMark(rarity: model.rarity, kind: model.kind, s: s, light: light)
        }
        .lineLimit(1)
    }
}

struct HoloRarityMark: View {
    var rarity: HoloRarity
    var kind: HoloKind
    var s: CGFloat
    var light: HoloLight

    var body: some View {
        HStack(spacing: 2.5 * s) {
            Image(systemName: rarity.symbol)
                .font(.system(size: 7 * s, weight: .black))
                .foregroundStyle(rarity == .common ? AnyShapeStyle(Theme.text2)
                                                   : AnyShapeStyle(Foil.angular(light.phase)))
            Text("SYNQ")
                .font(.system(size: 7 * s, weight: .heavy, design: .rounded))
                .tracking(1 * s)
                .foregroundStyle(Theme.text2)
        }
    }
}

struct HoloStatusRibbon: View {
    var text: String
    var tone: SynqTone
    var s: CGFloat

    var body: some View {
        HStack(spacing: 3.5 * s) {
            Circle().fill(tone.color).frame(width: 5 * s, height: 5 * s)
                .shadow(color: tone.color, radius: 2.5 * s)
            Text(text.uppercased())
                .font(.system(size: 7.5 * s, weight: .heavy, design: .rounded))
                .tracking(0.9 * s)
                .foregroundStyle(Color.white)
                .lineLimit(1)
        }
        .padding(.horizontal, 7 * s)
        .padding(.vertical, 3.5 * s)
        .background(Capsule().fill(Color.black.opacity(0.55)))
        .overlay(Capsule().strokeBorder(tone.color.opacity(0.6), lineWidth: 0.8 * s))
    }
}

struct HoloMoveRow: View {
    var move: HoloMove
    var kind: HoloKind
    var s: CGFloat
    var compact = false

    var body: some View {
        HStack(spacing: 7 * s) {
            Image(systemName: move.symbol)
                .font(.system(size: (compact ? 7.5 : 8.5) * s, weight: .bold))
                .foregroundStyle(Color.white)
                .frame(width: (compact ? 14 : 17) * s, height: (compact ? 14 : 17) * s)
                .background(Circle().fill(LinearGradient(colors: [kind.accentHi.opacity(0.9), kind.accent.opacity(0.7)],
                                                         startPoint: .top, endPoint: .bottom)))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.4), lineWidth: 0.6 * s))
            VStack(alignment: .leading, spacing: 0.5 * s) {
                Text(move.name)
                    .font(.system(size: (compact ? 10 : 12) * s, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let detail = move.detail, !compact {
                    Text(detail)
                        .font(.system(size: 8 * s, weight: .medium, design: .rounded))
                        .foregroundStyle(Theme.text2)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
            }
            Spacer(minLength: 3 * s)
            if let pips = move.pips {
                HoloPips(pips: pips, color: kind.accentHi, size: (compact ? 6.5 : 8) * s)
            }
            if let value = move.value {
                Text(value)
                    .font(.system(size: (compact ? 11 : 14) * s, weight: .heavy, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
            }
        }
    }
}

/// Short landscape face for transcript bubbles and compact mode.
struct HoloBubbleFace: View {
    var model: HoloCardModel
    var light = HoloLight()

    static let aspect: CGFloat = 1.62

    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width / 300
            HoloFrame(kind: model.kind, rarity: model.rarity, light: light, cornerRadius: 16 * s, border: 7 * s) {
                content(s)
            }
            .shadow(color: .black.opacity(0.5), radius: 10 * s, y: 6 * s)
        }
        .aspectRatio(Self.aspect, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
    }

    private func content(_ s: CGFloat) -> some View {
        HStack(spacing: 9 * s) {
            ZStack(alignment: .topLeading) {
                HoloArt(kind: model.kind, spec: model.art).equatable()
                if model.rarity >= .rare {
                    Rectangle().fill(Foil.bands(light)).opacity(model.rarity == .holoRare ? 0.3 : 0.16).blendMode(.overlay)
                }
                if model.rarity == .holoRare {
                    Sparkles(count: 18, seed: 0xB0B).opacity(0.7).blendMode(.plusLighter)
                }
                EnergyBadge(kind: model.kind, size: 20 * s).padding(6 * s)
            }
            .frame(width: 104 * s)
            .clipShape(RoundedRectangle(cornerRadius: 8 * s, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8 * s, style: .continuous)
                .strokeBorder(model.rarity == .common ? AnyShapeStyle(Foil.metal(model.kind))
                                                      : AnyShapeStyle(Foil.angular(light.phase + 0.25)),
                              lineWidth: 1.4 * s))

            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 4 * s) {
                    Text(model.stage.uppercased())
                        .font(.system(size: 7 * s, weight: .heavy, design: .rounded))
                        .tracking(1.2 * s)
                        .foregroundStyle(model.kind.accentHi)
                    Spacer(minLength: 2 * s)
                    HoloStatusRibbon(text: model.status, tone: model.tone, s: s * 0.92)
                }
                Text(model.name)
                    .font(.system(size: 15 * s, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                    .padding(.top, 3 * s)
                if let headline = model.headline {
                    HStack(alignment: .firstTextBaseline, spacing: 3 * s) {
                        Text(headline)
                            .font(.system(size: 25 * s, weight: .heavy, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(LinearGradient(colors: [.white, model.kind.accentHi],
                                                            startPoint: .top, endPoint: .bottom))
                        Text(model.unit)
                            .font(.system(size: 8.5 * s, weight: .heavy, design: .rounded))
                            .foregroundStyle(Theme.text2)
                    }
                    .lineLimit(1)
                    .minimumScaleFactor(0.6)
                }
                Spacer(minLength: 2 * s)
                VStack(spacing: 0) {
                    ForEach(Array(model.moves.prefix(2).enumerated()), id: \.offset) { i, move in
                        if i > 0 { Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.75) }
                        HoloMoveRow(move: move, kind: model.kind, s: s, compact: true)
                            .frame(height: 21 * s)
                    }
                }
                Spacer(minLength: 2 * s)
                HStack(spacing: 4 * s) {
                    Text(model.setCode)
                        .font(.system(size: 6.5 * s, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Theme.text3)
                    Spacer(minLength: 2 * s)
                    Text(model.network.uppercased())
                        .font(.system(size: 6.5 * s, weight: .bold, design: .rounded))
                        .tracking(0.6 * s)
                        .foregroundStyle(Theme.text2)
                    HoloRarityMark(rarity: model.rarity, kind: model.kind, s: s * 0.95, light: light)
                }
                .lineLimit(1)
            }
        }
        .padding(8 * s)
    }
}

/// A small portrait thumbnail for list rows and compact mode.
struct HoloThumb: View {
    var model: HoloCardModel
    var light = HoloLight()

    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width / 60
            HoloFrame(kind: model.kind, rarity: model.rarity, light: light, cornerRadius: 6 * s, border: 3 * s) {
                ZStack(alignment: .bottom) {
                    HoloArt(kind: model.kind, spec: model.art).equatable()
                    LinearGradient(colors: [.clear, Color.black.opacity(0.8)], startPoint: .center, endPoint: .bottom)
                    if let h = model.headline {
                        Text(h)
                            .font(.system(size: 9 * s, weight: .heavy, design: .rounded))
                            .monospacedDigit()
                            .foregroundStyle(Color.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                            .padding(.horizontal, 3 * s)
                            .padding(.bottom, 4 * s)
                    }
                }
            }
            .background(HoloHalo(kind: model.kind, rarity: model.rarity, cornerRadius: 6 * s, spread: 10 * s))
        }
        .aspectRatio(5.0 / 7.0, contentMode: .fit)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
    }
}

// MARK: - Stage (tilt + light)

/// Presents a card that tilts toward your finger while the foil light follows it,
/// with a slow idle shimmer. Reduce Motion stops the shimmer and the 3D tilt.
/// Still renders use a fixed light from the environment.
struct HoloStage<Content: View>: View {
    var interactive = true
    @ViewBuilder var content: (HoloLight) -> Content
    @State private var drag: CGSize = .zero
    @State private var dragging = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.synqRenderMode) private var mode

    var body: some View {
        if let phase = mode.phase {
            content(HoloLight(x: 0.28 + phase * 0.3, y: 0.2, phase: phase))
        } else {
            // Transcript bubbles shimmer at a lower rate than the interactive hero.
            TimelineView(.animation(minimumInterval: interactive ? 1.0 / 30 : 1.0 / 12,
                                    paused: reduceMotion && !dragging)) { tl in
                let t = tl.date.timeIntervalSinceReferenceDate
                let idle = reduceMotion ? 0.35 : (t / 9).truncatingRemainder(dividingBy: 1)
                let sway = reduceMotion ? 0 : sin(t / 2.2) * 0.12
                let light = HoloLight(x: max(0, min(1, 0.4 + sway + Double(drag.width) / 260)),
                                      y: max(0, min(1, 0.25 + Double(drag.height) / 300)),
                                      phase: idle + Double(drag.width) / 600)
                content(light)
                    .rotation3DEffect(.degrees(reduceMotion ? 0 : Double(drag.height) / 16),
                                      axis: (x: -1, y: 0, z: 0), perspective: 0.5)
                    .rotation3DEffect(.degrees(reduceMotion ? 0 : Double(drag.width) / 16),
                                      axis: (x: 0, y: 1, z: 0), perspective: 0.5)
            }
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { v in
                    if !dragging { Haptics.soft() }
                    dragging = true
                    drag = CGSize(width: max(-140, min(140, v.translation.width)),
                                  height: max(-110, min(110, v.translation.height)))
                }
                .onEnded { _ in
                    dragging = false
                    withAnimation(.spring(response: 0.55, dampingFraction: 0.6)) { drag = .zero }
                }, including: interactive ? .all : .subviews)
        }
    }
}

/// Dark scene for a transcript bubble: the card floats in its own halo.
struct HoloBubbleScene: View {
    var model: HoloCardModel

    /// Bubble height for a given width (MSMessagesAppViewController.contentSizeThatFits).
    static func height(forWidth w: CGFloat) -> CGFloat {
        min(250, (w - 2 * inset) / HoloBubbleFace.aspect + 2 * inset)
    }

    static let inset: CGFloat = 14

    var body: some View {
        ZStack {
            Theme.ink
            RadialGradient(colors: [model.kind.accent.opacity(0.45), model.kind.deep.opacity(0.4), .clear],
                           center: .center, startRadius: 0, endRadius: 260)
            Grain(opacity: 0.05)
            HoloStage(interactive: false) { light in
                HoloBubbleFace(model: model, light: light)
                    .background(HoloHalo(kind: model.kind, rarity: model.rarity, cornerRadius: 16, spread: 16))
            }
            .padding(Self.inset)
        }
    }
}
