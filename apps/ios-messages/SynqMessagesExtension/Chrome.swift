import SwiftUI

// Synq's card language: brushed chrome for anything still in motion (forming,
// pending approval, voting) and black titanium once money has moved. Pure SwiftUI
// with no UIKit, so the same views render the app icon and design previews on macOS.

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
            let a = from * .pi / 180
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

/// Light catching the metal: a soft diagonal band. `phase` 0...1 runs it across.
struct Sheen: View {
    var phase: Double
    var strength: Double = 0.55

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            LinearGradient(stops: [
                .init(color: .white.opacity(0), location: 0.0),
                .init(color: .white.opacity(strength * 0.35), location: 0.42),
                .init(color: .white.opacity(strength), location: 0.5),
                .init(color: .white.opacity(strength * 0.35), location: 0.58),
                .init(color: .white.opacity(0), location: 1.0),
            ], startPoint: .leading, endPoint: .trailing)
            .frame(width: w * 0.55, height: geo.size.height * 2.2)
            .rotationEffect(.degrees(22))
            .offset(x: -w * 0.7 + (w * 1.9) * phase, y: -geo.size.height * 0.6)
            .blendMode(.screen)
        }
        .allowsHitTesting(false)
    }
}

/// The EMV-style chip, in brushed steel to match the card.
struct CardChip: View {
    var finish: ChromeFinish

    var body: some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(LinearGradient(colors: finish == .silver
                                 ? [Chrome.rgb(0xE9E2CF), Chrome.rgb(0xB7AC8F), Chrome.rgb(0xDDD4BC)]
                                 : [Chrome.rgb(0x8E8A80), Chrome.rgb(0x55524B), Chrome.rgb(0x7D796F)],
                                 startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay {
                Canvas { ctx, size in
                    var p = Path()
                    let w = size.width, h = size.height
                    p.move(to: CGPoint(x: w * 0.33, y: 0)); p.addLine(to: CGPoint(x: w * 0.33, y: h))
                    p.move(to: CGPoint(x: w * 0.67, y: 0)); p.addLine(to: CGPoint(x: w * 0.67, y: h))
                    p.move(to: CGPoint(x: 0, y: h * 0.5)); p.addLine(to: CGPoint(x: w * 0.33, y: h * 0.5))
                    p.move(to: CGPoint(x: w * 0.67, y: h * 0.5)); p.addLine(to: CGPoint(x: w, y: h * 0.5))
                    p.addRoundedRect(in: CGRect(x: w * 0.33, y: h * 0.28, width: w * 0.34, height: h * 0.44),
                                     cornerSize: CGSize(width: 3, height: 3))
                    ctx.stroke(p, with: .color(.black.opacity(0.28)), lineWidth: 0.8)
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous)
                .stroke(Color.black.opacity(0.25), lineWidth: 0.6))
            .frame(width: 34, height: 26)
    }
}

/// Text cut into the metal: ink with a light lip below and a shadow above.
struct Engraved: ViewModifier {
    var finish: ChromeFinish
    var soft = false

    func body(content: Content) -> some View {
        content
            .foregroundStyle(soft ? Chrome.inkSoft(finish) : Chrome.ink(finish))
            .shadow(color: finish == .silver ? .white.opacity(0.85) : .black.opacity(0.8), radius: 0, x: 0, y: 1)
            .shadow(color: finish == .silver ? .black.opacity(0.18) : .white.opacity(0.08), radius: 0, x: 0, y: -0.5)
    }
}

extension View {
    func engraved(_ finish: ChromeFinish, soft: Bool = false) -> some View {
        modifier(Engraved(finish: finish, soft: soft))
    }
}

/// Card body: banded metal, brushing, bevelled edge and a moving sheen.
/// Pass `sheenPhase` to freeze the light (renders); nil animates it.
struct ChromeCard<Content: View>: View {
    var finish: ChromeFinish
    var sheenPhase: Double?
    var cornerRadius: CGFloat = 18
    @ViewBuilder var content: () -> Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        ZStack {
            shape.fill(Chrome.base(finish))
            BrushedLines(opacity: finish == .silver ? 0.10 : 0.06).clipShape(shape)
            Group {
                if let sheenPhase {
                    Sheen(phase: sheenPhase, strength: finish == .silver ? 0.6 : 0.22)
                } else {
                    TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
                        // One slow pass every 5 s, resting off-card in between.
                        let t = context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 5) / 5
                        Sheen(phase: min(1, t * 1.6), strength: finish == .silver ? 0.6 : 0.22)
                    }
                }
            }
            .clipShape(shape)
            content()
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .overlay(shape.strokeBorder(LinearGradient(colors: finish == .silver
                                                   ? [.white, Chrome.rgb(0x8B9098), .white.opacity(0.9)]
                                                   : [Chrome.rgb(0x6B6F76), .black, Chrome.rgb(0x4A4D52)],
                                                   startPoint: .topLeading, endPoint: .bottomTrailing),
                                    lineWidth: 1.2))
        .compositingGroup()
        .shadow(color: .black.opacity(finish == .silver ? 0.18 : 0.35), radius: 10, y: 6)
    }
}

// MARK: - Card faces

/// Common card furniture: mark + wordmark top-left, status top-right.
struct CardHeader: View {
    var finish: ChromeFinish
    var label: String
    var status: String?

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            SynqMark(size: 26, finish: finish, showsOrbit: false, engravedInk: finish == .silver)
            Text("SYNQ")
                .font(.system(size: 13, weight: .heavy).width(.expanded))
                .tracking(3)
                .engraved(finish)
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold).width(.expanded))
                .tracking(1.5)
                .engraved(finish, soft: true)
            Spacer(minLength: 4)
            if let status {
                Text(status.uppercased())
                    .font(.system(size: 9, weight: .bold).width(.expanded))
                    .tracking(1.2)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background(Capsule().fill(finish == .silver ? Color.black.opacity(0.07) : Color.white.opacity(0.08)))
                    .overlay(Capsule().stroke(finish == .silver ? Color.white.opacity(0.8) : Color.white.opacity(0.12), lineWidth: 0.6))
                    .engraved(finish)
            }
        }
    }
}

/// Approvals as engraved pips: filled for each signature counted.
struct ApprovalPips: View {
    var counted: Int
    var required: Int
    var finish: ChromeFinish

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<max(required, 1), id: \.self) { i in
                Pip(on: i < counted, finish: finish)
                    .animation(.spring(response: 0.4, dampingFraction: 0.5).delay(Double(i) * 0.08), value: counted)
            }
        }
    }
}

private struct Pip: View {
    var on: Bool
    var finish: ChromeFinish

    var body: some View {
        let fill: AnyShapeStyle = on ? AnyShapeStyle(Chrome.polish) : AnyShapeStyle(Color.clear)
        return Circle()
            .fill(fill)
            .overlay(Circle().stroke(Chrome.inkSoft(finish), lineWidth: 1))
            .frame(width: 9, height: 9)
            .scaleEffect(on ? 1 : 0.85)
            .shadow(color: .black.opacity(on ? 0.3 : 0), radius: 1, y: 1)
    }
}

/// The fund itself: balance as embossed digits, name like the cardholder line.
struct FundCardFace: View {
    var name: String
    var balance: String?
    var symbol: String
    var status: String
    var footnote: String
    var finish: ChromeFinish
    var sheenPhase: Double?

    var body: some View {
        ChromeCard(finish: finish, sheenPhase: sheenPhase) {
            VStack(alignment: .leading, spacing: 0) {
                CardHeader(finish: finish, label: "Group fund", status: status)
                Spacer(minLength: 10)
                HStack(alignment: .center, spacing: 12) {
                    CardChip(finish: finish)
                    Image(systemName: "wave.3.right")
                        .font(.system(size: 15, weight: .semibold))
                        .engraved(finish, soft: true)
                }
                Spacer(minLength: 10)
                if let balance {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(balance)
                            .font(.system(size: 28, weight: .semibold, design: .monospaced))
                            .monospacedDigit()
                            .contentTransition(.numericText())
                            .engraved(finish)
                        Text(symbol)
                            .font(.system(size: 11, weight: .bold).width(.expanded))
                            .tracking(1.5)
                            .engraved(finish, soft: true)
                    }
                    .lineLimit(1).minimumScaleFactor(0.6)
                }
                HStack(alignment: .lastTextBaseline) {
                    Text(name.uppercased())
                        .font(.system(size: 13, weight: .semibold).width(.expanded))
                        .tracking(2)
                        .lineLimit(1).minimumScaleFactor(0.7)
                        .engraved(finish)
                    Spacer(minLength: 8)
                    Text(footnote.uppercased())
                        .font(.system(size: 9, weight: .semibold).width(.expanded))
                        .tracking(1.2)
                        .engraved(finish, soft: true)
                }
                .padding(.top, 4)
            }
        }
        .aspectRatio(1.586, contentMode: .fit)
    }
}

/// A payment: the amount is the hero, approvals are pips.
struct PaymentCardFace: View {
    var fundName: String
    var amount: String
    var symbol: String
    var recipient: String
    var counted: Int
    var required: Int
    var status: String
    var finish: ChromeFinish
    var sheenPhase: Double?

    var body: some View {
        ChromeCard(finish: finish, sheenPhase: sheenPhase) {
            VStack(alignment: .leading, spacing: 0) {
                CardHeader(finish: finish, label: "Payment", status: status)
                Spacer(minLength: 8)
                Text("TO \(recipient.uppercased())")
                    .font(.system(size: 10, weight: .semibold).width(.expanded))
                    .tracking(1.8)
                    .engraved(finish, soft: true)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(amount)
                        .font(.system(size: 34, weight: .semibold, design: .monospaced))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .engraved(finish)
                    Text(symbol)
                        .font(.system(size: 11, weight: .bold).width(.expanded))
                        .tracking(1.5)
                        .engraved(finish, soft: true)
                }
                .lineLimit(1).minimumScaleFactor(0.6)
                Spacer(minLength: 8)
                HStack(alignment: .center) {
                    Text(fundName.uppercased())
                        .font(.system(size: 12, weight: .semibold).width(.expanded))
                        .tracking(2)
                        .lineLimit(1).minimumScaleFactor(0.7)
                        .engraved(finish)
                    Spacer(minLength: 8)
                    ApprovalPips(counted: counted, required: required, finish: finish)
                }
            }
        }
        .aspectRatio(1.586, contentMode: .fit)
    }
}

/// A trip or gift the group is choosing.
struct PickCardFace: View {
    var fundName: String
    var kind: String          // "Trip" or "Gift"
    var title: String
    var subtitle: String
    var status: String
    var finish: ChromeFinish
    var sheenPhase: Double?

    var body: some View {
        ChromeCard(finish: finish, sheenPhase: sheenPhase) {
            VStack(alignment: .leading, spacing: 0) {
                CardHeader(finish: finish, label: kind, status: status)
                Spacer(minLength: 8)
                HStack(spacing: 10) {
                    Image(systemName: kind.lowercased() == "gift" ? "gift" : "airplane")
                        .font(.system(size: 22, weight: .semibold))
                        .engraved(finish)
                    Text(title)
                        .font(.system(size: 20, weight: .semibold).width(.expanded))
                        .lineLimit(2).minimumScaleFactor(0.6)
                        .engraved(finish)
                }
                Spacer(minLength: 8)
                HStack {
                    Text(fundName.uppercased())
                        .font(.system(size: 12, weight: .semibold).width(.expanded))
                        .tracking(2)
                        .lineLimit(1)
                        .engraved(finish)
                    Spacer(minLength: 8)
                    Text(subtitle.uppercased())
                        .font(.system(size: 9, weight: .semibold).width(.expanded))
                        .tracking(1.2)
                        .lineLimit(1)
                        .engraved(finish, soft: true)
                }
            }
        }
        .aspectRatio(1.586, contentMode: .fit)
    }
}

// MARK: - Controls

/// Graphite pill with a chrome lip; replaces stock blue buttons.
struct ChromeButtonStyle: ButtonStyle {
    var prominent = true
    var compact = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: compact ? 12 : 15, weight: .semibold).width(.expanded))
            .tracking(compact ? 0.3 : 0.6)
            .padding(.vertical, compact ? 7 : 13).padding(.horizontal, compact ? 12 : 18)
            .frame(maxWidth: compact ? nil : .infinity)
            .foregroundStyle(prominent ? Chrome.rgb(0xEDEFF2) : Chrome.rgb(0x2A2D32))
            .background(
                Capsule().fill(prominent ? AnyShapeStyle(Chrome.base(.titanium)) : AnyShapeStyle(Chrome.base(.silver)))
            )
            .overlay(Capsule().strokeBorder(prominent
                                            ? LinearGradient(colors: [Chrome.rgb(0x8A8F97), .black], startPoint: .top, endPoint: .bottom)
                                            : LinearGradient(colors: [.white, Chrome.rgb(0x9A9FA6)], startPoint: .top, endPoint: .bottom),
                                            lineWidth: 1))
            .shadow(color: .black.opacity(configuration.isPressed ? 0.1 : 0.22), radius: configuration.isPressed ? 2 : 6, y: configuration.isPressed ? 1 : 4)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == ChromeButtonStyle {
    static var chrome: ChromeButtonStyle { ChromeButtonStyle() }
    static var chromeQuiet: ChromeButtonStyle { ChromeButtonStyle(prominent: false) }
    static var chromeChip: ChromeButtonStyle { ChromeButtonStyle(prominent: false, compact: true) }
}

/// Hero presentation for the expanded panel: the card tilts toward your finger
/// and the light follows it; it springs back when released.
struct TiltingCard<Content: View>: View {
    @ViewBuilder var content: () -> Content
    @State private var tilt: CGSize = .zero

    var body: some View {
        content()
            .rotation3DEffect(.degrees(Double(tilt.height) / 14), axis: (x: 1, y: 0, z: 0), perspective: 0.6)
            .rotation3DEffect(.degrees(Double(-tilt.width) / 14), axis: (x: 0, y: 1, z: 0), perspective: 0.6)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        tilt = CGSize(width: max(-120, min(120, v.translation.width)),
                                      height: max(-90, min(90, v.translation.height)))
                    }
                    .onEnded { _ in
                        withAnimation(.spring(response: 0.5, dampingFraction: 0.55)) { tilt = .zero }
                    }
            )
    }
}
