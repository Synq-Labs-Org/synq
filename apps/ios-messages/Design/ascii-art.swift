// Generates the ASCII theme's art. Every scene is drawn procedurally from
// CoreGraphics shapes (no source images) into two grey layers:
//   - a line layer: thin outlines and contour hatching, mapped per cell to the
//     stroke glyph that follows the line (- _ | / \) or a light dot glyph;
//   - a tone layer: soft shading (moon, water, sand, shadow), mapped per cell to
//     ordered-dither dots (. :) on a 4x4 Bayer matrix.
// Most of the canvas stays empty black, like 1-bit line and dot art.
//
//   sh Design/ascii-art.sh [preview-dir]
//
// Writes SynqMessagesExtension/AsciiArtData.swift (the committed art) and, with
// a preview directory, one PNG per piece.
import AppKit
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let cellW = 10, cellH = 18          // the app draws glyphs in cells of this aspect (1.8)
/// Glyphs drawn in the secondary ink on screen (mirrors AsciiArtView; used for previews).
let dimChars: Set<Character> = [".", ",", "'", "`", ":", "·"]

// MARK: - Seeded randomness

struct RNG {
    var s: UInt64
    init(_ seed: UInt64) { s = seed &* 0x9E3779B97F4A7C15 | 1 }
    mutating func next() -> Double {
        s = s &* 6364136223846793005 &+ 1442695040888963407
        return Double(s >> 11) / Double(1 << 53)
    }
    mutating func range(_ a: Double, _ b: Double) -> Double { a + (b - a) * next() }
}

typealias P = (Double, Double)

// MARK: - Pen: world-space drawing on the line and tone layers (y grows down)

final class Pen {
    let line: CGContext
    let tone: CGContext
    var rng: RNG
    /// Default stroke width in world units (about a third of a cell).
    var lw = 2.2

    init(line: CGContext, tone: CGContext, seed: UInt64) { self.line = line; self.tone = tone; rng = RNG(seed) }

    func g(_ v: Double) -> CGColor { CGColor(gray: v, alpha: 1) }

    func path(_ pts: [P], close: Bool = false) -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: pts[0].0, y: pts[0].1))
        for q in pts.dropFirst() { p.addLine(to: CGPoint(x: q.0, y: q.1)) }
        if close { p.closeSubpath() }
        return p
    }

    func ellipse(_ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double) -> CGPath {
        CGPath(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry), transform: nil)
    }

    func rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double) -> CGPath {
        CGPath(rect: CGRect(x: x, y: y, width: w, height: h), transform: nil)
    }

    func curve(_ a: P, _ c: P, _ b: P) -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: a.0, y: a.1))
        p.addQuadCurve(to: CGPoint(x: b.0, y: b.1), control: CGPoint(x: c.0, y: c.1))
        return p
    }

    /// Outline on the line layer.
    func stroke(_ p: CGPath, _ v: Double = 1, _ w: Double? = nil) {
        line.addPath(p); line.setStrokeColor(g(v)); line.setLineWidth(w ?? lw)
        line.setLineCap(.round); line.setLineJoin(.round); line.strokePath()
    }

    func seg(_ a: P, _ b: P, _ v: Double = 1, _ w: Double? = nil) { stroke(path([a, b]), v, w) }

    /// Small solid marks on the line layer (windows, blossoms, stars).
    func mark(_ p: CGPath, _ v: Double = 1) { line.addPath(p); line.setFillColor(g(v)); line.fillPath() }

    /// Clears both layers inside the path, so what is in front hides what is behind.
    func occlude(_ p: CGPath) {
        for c in [line, tone] { c.addPath(p); c.setFillColor(g(0)); c.fillPath() }
    }

    /// Soft shading on the tone layer; `level` maps a world point to 0...1.
    func shade(_ p: CGPath, _ level: @escaping (Double, Double) -> Double) {
        let b = p.boundingBoxOfPath
        tone.saveGState(); tone.addPath(p); tone.clip()
        let step = 3.0
        var y = b.minY
        while y < b.maxY {
            var x = b.minX
            while x < b.maxX {
                tone.setFillColor(g(max(0, min(1, level(x, y)))))
                tone.fill(CGRect(x: x, y: y, width: step + 0.5, height: step + 0.5))
                x += step
            }
            y += step
        }
        tone.restoreGState()
    }

    func shade(_ p: CGPath, _ v: Double) { shade(p) { _, _ in v } }

    /// Parallel contour lines across the path at `angle` degrees, clipped to it.
    func hatch(_ p: CGPath, angle: Double, spacing: Double, _ v: Double = 0.8, dash: [CGFloat]? = nil) {
        let b = p.boundingBoxOfPath.insetBy(dx: -4, dy: -4)
        let r = hypot(b.width, b.height)
        let a = angle * .pi / 180
        let (dx, dy) = (cos(a), sin(a)), (nx, ny) = (-sin(a), cos(a))
        line.saveGState(); line.addPath(p); line.clip()
        if let dash { line.setLineDash(phase: 0, lengths: dash) }
        var t = -r / 2
        while t < r / 2 {
            let cx = b.midX + nx * t, cy = b.midY + ny * t
            seg((cx - dx * r, cy - dy * r), (cx + dx * r, cy + dy * r), v)
            t += spacing
        }
        line.restoreGState()
    }

    /// Sparse single-dot stars on the line layer, avoiding rects.
    func stars(_ r: CGRect, count: Int, avoid: [CGRect] = []) {
        var n = 0, tries = 0
        while n < count && tries < count * 40 {
            tries += 1
            let x = rng.range(r.minX, r.maxX), y = rng.range(r.minY, r.maxY)
            if avoid.contains(where: { $0.contains(CGPoint(x: x, y: y)) }) { continue }
            mark(ellipse(x, y, 1.6, 1.6), rng.range(0.7, 1))
            n += 1
        }
    }

    /// Short horizontal strokes, like light on water.
    func ripples(_ r: CGRect, rowStep: Double, minLen: Double, maxLen: Double, gap: Double, _ v: Double = 0.85,
                 density: ((Double, Double) -> Double)? = nil) {
        var y = r.minY
        while y < r.maxY {
            var x = r.minX + rng.range(0, gap)
            while x < r.maxX {
                let len = rng.range(minLen, maxLen)
                if rng.next() < (density?(x, y) ?? 1) { seg((x, y), (min(r.maxX, x + len), y), v) }
                x += len + rng.range(gap * 0.5, gap * 1.5)
            }
            y += rowStep
        }
    }

    func quad(_ a: P, _ c: P, _ b: P, _ t: Double) -> P {
        let u = 1 - t
        return (u * u * a.0 + 2 * u * t * c.0 + t * t * b.0, u * u * a.1 + 2 * u * t * c.1 + t * t * b.1)
    }

    func with(_ tx: Double, _ ty: Double, rotate: Double = 0, scale: Double = 1, _ body: () -> Void) {
        for c in [line, tone] {
            c.saveGState(); c.translateBy(x: tx, y: ty); c.rotate(by: rotate * .pi / 180); c.scaleBy(x: scale, y: scale)
        }
        body()
        for c in [line, tone] { c.restoreGState() }
    }
}

// MARK: - Motifs

/// A torii gate in line art: upturned kasagi, shimaki, a double nuki and two leaning pillars.
func torii(_ pen: Pen, cx: Double, top: Double, base: Double, w: Double) {
    let s = w / 200, h = base - top
    let nuki = top + 28 * s + h * 0.14
    let pillars: [(P, P, P, P)] = [-1.0, 1.0].map { side in
        let x0 = cx + side * w * 0.3
        return ((x0 - 8 * s, top + 20 * s), (x0 - 10 * s + side * 6 * s, base),
                (x0 + 8 * s, top + 20 * s), (x0 + 10 * s + side * 6 * s, base))
    }
    var shadow: [CGPath] = [pen.path([(cx - w * 0.56, top - 12 * s), (cx + w * 0.56, top - 12 * s),
                                      (cx + w * 0.52, top + 22 * s), (cx - w * 0.52, top + 22 * s)], close: true),
                            pen.rect(cx - w * 0.46, nuki, w * 0.92, 11 * s)]
    for p in pillars { shadow.append(pen.path([p.0, p.2, p.3, p.1], close: true)) }
    for p in shadow { pen.occlude(p) }
    pen.stroke(pen.curve((cx - w * 0.56, top - 12 * s), (cx, top + 12 * s), (cx + w * 0.56, top - 12 * s)), 1, 2.6)
    pen.stroke(pen.curve((cx - w * 0.52, top + 4 * s), (cx, top + 24 * s), (cx + w * 0.52, top + 4 * s)))
    pen.seg((cx - w * 0.56, top - 12 * s), (cx - w * 0.52, top + 4 * s))
    pen.seg((cx + w * 0.56, top - 12 * s), (cx + w * 0.52, top + 4 * s))
    pen.seg((cx - w * 0.42, top + 20 * s), (cx + w * 0.42, top + 20 * s), 0.9)
    pen.seg((cx - w * 0.46, nuki), (cx + w * 0.46, nuki))
    pen.seg((cx - w * 0.46, nuki + 11 * s), (cx + w * 0.46, nuki + 11 * s))
    pen.seg((cx, top + 20 * s), (cx, nuki), 0.8)
    for p in pillars {
        pen.seg(p.0, p.1); pen.seg(p.2, p.3)
        pen.seg((p.1.0 - 2 * s, base - 10 * s), (p.3.0 + 2 * s, base - 10 * s), 0.7, 1.4)
    }
}

func pagoda(_ pen: Pen, cx: Double, base: Double, tiers: Int, w: Double) {
    var y = base
    for i in 0..<tiers {
        let tw = w * (1 - Double(i) * 0.16)
        let body = pen.rect(cx - tw * 0.28, y - 22, tw * 0.56, 22)
        pen.occlude(body); pen.stroke(body, 0.85)
        let ry = y - 22
        let roof = CGMutablePath()
        roof.move(to: CGPoint(x: cx - tw / 2 - 14, y: ry - 12))
        roof.addQuadCurve(to: CGPoint(x: cx - tw / 2 + 6, y: ry), control: CGPoint(x: cx - tw / 2 - 4, y: ry - 2))
        roof.addLine(to: CGPoint(x: cx + tw / 2 - 6, y: ry))
        roof.addQuadCurve(to: CGPoint(x: cx + tw / 2 + 14, y: ry - 12), control: CGPoint(x: cx + tw / 2 + 4, y: ry - 2))
        roof.addLine(to: CGPoint(x: cx + tw * 0.2, y: ry - 22))
        roof.addLine(to: CGPoint(x: cx - tw * 0.2, y: ry - 22))
        roof.closeSubpath()
        pen.occlude(roof); pen.stroke(roof)
        y = ry - 22
    }
    pen.seg((cx, y), (cx, y - 42))
    for k in 0..<4 { pen.seg((cx - 5, y - 10 - Double(k) * 8), (cx + 5, y - 10 - Double(k) * 8), 0.9) }
}

/// A rounded, scalloped canopy (pine cloud) in outline with stippled shade.
func canopy(_ pen: Pen, _ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double) {
    let p = CGMutablePath()
    let n = 48
    for i in 0...n {
        let a = Double(i) / Double(n) * 2 * .pi
        let bump = 1 + 0.1 * abs(sin(a * 4.5 + cx * 0.1))
        let flat = sin(a) > 0 ? 0.55 : 1.0     // flat underside
        let pt = CGPoint(x: cx + cos(a) * rx * bump, y: cy + sin(a) * ry * bump * flat)
        if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
    }
    p.closeSubpath()
    pen.occlude(p)
    pen.shade(p) { _, y in y < cy ? 0.55 : 0.3 }
    pen.stroke(p)
}

func blossom(_ pen: Pen, _ x: Double, _ y: Double, _ r: Double) {
    for k in 0..<5 {
        let a = Double(k) / 5 * 2 * .pi + x
        pen.mark(pen.ellipse(x + cos(a) * r, y + sin(a) * r, 1.5, 1.5))
    }
    pen.mark(pen.ellipse(x, y, 1.3, 1.3), 0.7)
}

func moon(_ pen: Pen, _ cx: Double, _ cy: Double, _ r: Double, lit: Double = -1) {
    let disc = pen.ellipse(cx, cy, r, r)
    pen.shade(disc) { x, y in
        let d = ((x - cx) * lit - (y - cy) * 0.5) / r
        return 0.55 + 0.4 * d
    }
}

func sparkle(_ pen: Pen, _ x: Double, _ y: Double, _ r: Double) {
    pen.seg((x - r, y), (x + r, y))
    pen.seg((x, y - r * 1.4), (x, y + r * 1.4))
}

// MARK: - Scenes

struct Scene {
    let name: String
    let size: CGSize                 // world
    let seed: UInt64
    let draw: (Pen) -> Void
}

let home = Scene(name: "home", size: CGSize(width: 1000, height: 540), seed: 11) { pen in
    pen.stars(CGRect(x: 0, y: 0, width: 1000, height: 260), count: 26,
              avoid: [CGRect(x: 860, y: 0, width: 140, height: 300), CGRect(x: 560, y: 50, width: 170, height: 150),
                      CGRect(x: 200, y: 80, width: 300, height: 200)])
    moon(pen, 640, 120, 46)
    // Far ridge, right.
    let ridgeLine: [P] = [(560, 402), (640, 360), (710, 348), (790, 368), (880, 336), (1000, 356)]
    let ridge = pen.path(ridgeLine + [(1000, 470), (560, 470)], close: true)
    pen.shade(ridge) { _, y in 0.22 - (y - 340) / 1200 }
    pen.stroke(pen.path(ridgeLine), 0.8)
    // Fuji.
    let fuji = CGMutablePath()
    fuji.move(to: CGPoint(x: 0, y: 470))
    fuji.addQuadCurve(to: CGPoint(x: 300, y: 112), control: CGPoint(x: 220, y: 330))
    fuji.addLine(to: CGPoint(x: 348, y: 106))
    fuji.addLine(to: CGPoint(x: 382, y: 114))
    fuji.addQuadCurve(to: CGPoint(x: 780, y: 470), control: CGPoint(x: 470, y: 330))
    fuji.closeSubpath()
    pen.occlude(fuji)
    pen.shade(fuji) { x, _ in x < 340 ? 0.2 : 0.08 }
    pen.stroke(fuji)
    // Snow cap with a jagged hem, and ridges running down from it.
    let hem: [P] = [(234, 206), (252, 236), (268, 212), (284, 252), (302, 222), (320, 272), (338, 214), (356, 254),
                    (376, 216), (396, 264), (414, 208), (432, 240), (452, 214)]
    pen.stroke(pen.path(hem))
    let cap = pen.path([(234, 206), (300, 112), (348, 106), (382, 114), (452, 214)] + hem.reversed(), close: true)
    pen.shade(cap) { x, y in 0.95 - (y - 106) / 600 - (x > 340 ? 0.25 : 0) }
    pen.tone.saveGState()
    for (a, b) in [((318.0, 126.0), (300.0, 230.0)), ((344, 120), (352, 246)), ((366, 126), (394, 230))] {
        pen.tone.move(to: CGPoint(x: a.0, y: a.1)); pen.tone.addLine(to: CGPoint(x: b.0, y: b.1))
    }
    pen.tone.setStrokeColor(CGColor(gray: 0, alpha: 1)); pen.tone.setLineWidth(7); pen.tone.strokePath()
    pen.tone.restoreGState()
    for (a, c, b) in [((320.0, 272.0), (300.0, 340.0), (250.0, 420.0)), ((356, 254), (370, 340), (420, 440)),
                      ((396, 264), (430, 330), (500, 400)), ((284, 252), (250, 310), (170, 380)),
                      ((338, 214), (334, 320), (330, 460))] {
        pen.stroke(pen.curve(a, c, b), 0.6)
    }
    pagoda(pen, cx: 236, base: 470, tiers: 3, w: 96)
    // Pines, left foreground.
    for (a, c, b) in [((96.0, 480.0), (110.0, 380.0), (96.0, 300.0)), ((100, 400), (130, 340), (160, 336)),
                      ((96, 330), (120, 280), (130, 248))] {
        pen.stroke(pen.curve(a, c, b), 0.9, 6)
    }
    for (cx, cy, rx, ry) in [(132.0, 244.0, 50.0, 18.0), (60, 300, 58, 20), (150, 352, 52, 18), (78, 420, 76, 22)] {
        canopy(pen, cx, cy, rx, ry)
    }
    // Water.
    let water = pen.rect(0, 470, 1000, 70)
    pen.occlude(water)
    pen.seg((0, 471), (1000, 471), 0.85)
    pen.ripples(CGRect(x: 0, y: 486, width: 1000, height: 54), rowStep: 12, minLen: 8, maxLen: 36, gap: 34, 0.7) { x, _ in
        x > 740 && x < 920 ? 0.9 : 0.4
    }
    pen.shade(pen.rect(0, 476, 1000, 64)) { x, _ in abs(x - 640) < 60 ? 0.4 : 0.05 }
    torii(pen, cx: 830, top: 292, base: 484, w: 190)
}

let flights = Scene(name: "flights", size: CGSize(width: 1000, height: 360), seed: 23) { pen in
    pen.stars(CGRect(x: 0, y: 0, width: 1000, height: 360), count: 16, avoid: [CGRect(x: 150, y: 20, width: 740, height: 300)])
    // Thin dotted cloud banks at the corners.
    for (cx, cy, rx, ry) in [(890.0, 64.0, 100.0, 22.0), (150, 306, 130, 22)] {
        pen.shade(pen.ellipse(cx, cy, rx, ry)) { x, y in 0.5 - hypot((x - cx) / rx, (y - cy) / ry) * 0.45 }
    }
    // An airliner in side profile, nose right, climbing gently.
    pen.with(530, 176, rotate: -7) {
        for (y, len) in [(54.0, 420.0), (86, 300)] {       // contrails
            pen.shade(pen.rect(-60 - len, y - 3, len, 6)) { x, _ in max(0, 0.8 - (-60 - x) / Double(len) * 0.8) }
        }
        let fin = pen.path([(-196, -24), (-282, -124), (-250, -126), (-146, -24)], close: true)
        pen.occlude(fin); pen.stroke(fin)
        pen.seg((-250, -100), (-226, -100), 0.6, 1.4)
        let body = CGMutablePath()
        body.move(to: CGPoint(x: -204, y: -26))
        body.addLine(to: CGPoint(x: 206, y: -26))
        body.addQuadCurve(to: CGPoint(x: 300, y: 8), control: CGPoint(x: 288, y: -24))
        body.addQuadCurve(to: CGPoint(x: 222, y: 28), control: CGPoint(x: 290, y: 28))
        body.addLine(to: CGPoint(x: -170, y: 28))
        body.addQuadCurve(to: CGPoint(x: -322, y: -20), control: CGPoint(x: -262, y: 26))
        body.addQuadCurve(to: CGPoint(x: -204, y: -26), control: CGPoint(x: -262, y: -27))
        body.closeSubpath()
        pen.occlude(body); pen.stroke(body)
        var x = -164.0
        while x < 214 { if abs(x - 186) > 10 && abs(x + 130) > 10 { pen.mark(pen.ellipse(x, -8, 1.6, 2.2)) }; x += 12 }
        for dx in [186.0, -130] { pen.stroke(pen.rect(dx - 6, -20, 12, 34), 0.8, 1.4) }
        pen.stroke(pen.path([(248, -15), (270, -13), (280, -4)]), 1, 1.8)
        let stab = pen.path([(-226, 6), (-304, 30), (-284, 34), (-196, 12)], close: true)
        pen.occlude(stab); pen.stroke(stab, 0.9)
        let wing = pen.path([(-46, 20), (64, 22), (-62, 96), (-116, 96)], close: true)
        pen.occlude(wing); pen.stroke(wing)
        pen.seg((20, 34), (24, 40), 0.9)
        let pod = CGMutablePath()
        pod.addRoundedRect(in: CGRect(x: -38, y: 38, width: 96, height: 28), cornerWidth: 14, cornerHeight: 14)
        pen.occlude(pod); pen.stroke(pod)
        pen.stroke(pen.ellipse(56, 52, 5, 12), 1, 1.6)
        pen.seg((-20, 66), (40, 66), 0.5, 1.2)
    }
}

let fund = Scene(name: "fund", size: CGSize(width: 1000, height: 540), seed: 37) { pen in
    pen.stars(CGRect(x: 260, y: 0, width: 640, height: 270), count: 22,
              avoid: [CGRect(x: 600, y: 30, width: 200, height: 180), CGRect(x: 820, y: 0, width: 180, height: 90)])
    moon(pen, 700, 124, 56)
    // Headland and horizon.
    let headLine: [P] = [(720, 300), (790, 268), (850, 262), (912, 240), (960, 252), (1000, 246)]
    pen.shade(pen.path(headLine + [(1000, 300)], close: true), 0.2)
    pen.stroke(pen.path(headLine), 0.85)
    pen.seg((270, 300), (1000, 300), 0.85)
    // Sea, with a moonlit path.
    pen.ripples(CGRect(x: 270, y: 314, width: 640, height: 112), rowStep: 12, minLen: 8, maxLen: 40, gap: 30, 0.75) { x, y in
        abs(x - 700) < 64 - (y - 312) * 0.12 ? 1 : 0.32
    }
    pen.shade(pen.rect(630, 304, 140, 120)) { x, y in 0.5 - abs(x - 700) / 160 - (y - 304) / 500 }
    // Shore, sand, lounger.
    let shore = CGMutablePath()
    shore.move(to: CGPoint(x: 250, y: 432))
    shore.addCurve(to: CGPoint(x: 1000, y: 446), control1: CGPoint(x: 500, y: 418), control2: CGPoint(x: 760, y: 462))
    pen.stroke(shore)
    pen.shade(pen.rect(0, 446, 1000, 94)) { x, y in 0.1 + (y - 446) / 900 }
    pen.stroke(pen.path([(562, 434), (594, 494), (692, 494)]), 1)
    pen.stroke(pen.path([(572, 434), (602, 488), (692, 488)]), 0.7, 1.4)
    for x in [602.0, 682] { pen.seg((x, 494), (x, 514)) }
    // Hut on stilts.
    let walls = pen.rect(38, 262, 126, 68)
    pen.occlude(walls); pen.shade(walls, 0.28); pen.stroke(walls)
    let door = pen.rect(86, 284, 28, 46)
    pen.occlude(door); pen.stroke(door, 0.9)
    let roof = pen.path([(14, 262), (98, 200), (188, 264)], close: true)
    pen.occlude(roof); pen.shade(roof, 0.6); pen.stroke(roof)
    for x in [46.0, 92, 154] { pen.seg((x, 330), (x, 396), 0.9) }
    pen.seg((22, 340), (182, 340), 0.8)
    // Palms: outlined trunks with ring marks, fronds as ribs with leaflets.
    func palm(_ base: P, _ ctrl: P, _ top: P, fronds: [Double], len: Double) {
        let n = 26
        var left: [P] = [], right: [P] = []
        for i in 0...n {
            let t = Double(i) / Double(n)
            let p = pen.quad(base, ctrl, top, t), q = pen.quad(base, ctrl, top, min(1, t + 0.01))
            let (dx, dy) = (q.0 - p.0, q.1 - p.1), l = max(0.001, hypot(dx, dy))
            let w = 9 - 4.5 * t
            left.append((p.0 - dy / l * w, p.1 + dx / l * w)); right.append((p.0 + dy / l * w, p.1 - dx / l * w))
            if i % 2 == 1 && i < n - 1 { pen.seg(left[i], right[i], 0.75, 1.6) }
        }
        pen.occlude(pen.path(left + right.reversed(), close: true))
        for i in 0..<n where i % 2 == 1 && i < n - 1 { pen.seg(left[i], right[i], 0.7, 1.6) }
        pen.stroke(pen.path(left)); pen.stroke(pen.path(right))
        for a in fronds {
            let r = a * .pi / 180
            let end = (top.0 + cos(r) * len, top.1 + sin(r) * len * 0.7 + len * 0.3)
            let mid = (top.0 + cos(r) * len * 0.55, top.1 + sin(r) * len * 0.5 - len * 0.16)
            pen.stroke(pen.curve(top, mid, end), 1, 2.2)
            for k in stride(from: 3, to: 15, by: 2) {
                let t = Double(k) / 15
                let p = pen.quad(top, mid, end, t)
                let l = (1 - t) * 22 + 8
                pen.seg(p, (p.0 + cos(r) * l * 0.35, p.1 + l), 0.8, 1.3)
            }
        }
        pen.stroke(pen.ellipse(top.0, top.1 + 6, 9, 8), 1, 1.8)
    }
    palm((232, 540), (200, 300), (334, 98), fronds: [-170, -138, -100, -62, -24, 12, 160], len: 150)
    palm((150, 540), (162, 380), (196, 214), fronds: [-160, -118, -72, -30, 8, 178], len: 104)
}

let send = Scene(name: "send", size: CGSize(width: 1000, height: 510), seed: 41) { pen in
    pen.stars(CGRect(x: 300, y: 160, width: 700, height: 140), count: 10)
    // Distant mountain, ground and water.
    let mt = CGMutablePath()
    mt.move(to: CGPoint(x: 450, y: 452))
    mt.addQuadCurve(to: CGPoint(x: 642, y: 290), control: CGPoint(x: 594, y: 380))
    mt.addLine(to: CGPoint(x: 668, y: 288))
    mt.addQuadCurve(to: CGPoint(x: 900, y: 452), control: CGPoint(x: 716, y: 380))
    mt.closeSubpath()
    pen.occlude(mt)
    pen.shade(mt) { x, _ in x < 655 ? 0.2 : 0.08 }
    pen.stroke(mt, 0.85)
    pen.stroke(pen.path([(616, 320), (634, 334), (650, 314), (666, 336), (684, 318), (700, 326)]), 0.9)
    pen.seg((290, 452), (1000, 452), 0.8)
    pen.ripples(CGRect(x: 300, y: 464, width: 700, height: 46), rowStep: 12, minLen: 6, maxLen: 26, gap: 28, 0.65)
    torii(pen, cx: 812, top: 330, base: 460, w: 150)
    // Stone lantern.
    let lantern: [CGPath] = [pen.rect(946, 418, 16, 40), pen.path([(930, 418), (978, 418), (966, 404), (942, 404)], close: true),
                             pen.rect(940, 390, 28, 14), pen.path([(926, 390), (982, 390), (954, 368)], close: true)]
    for p in lantern { pen.occlude(p); pen.stroke(p, 0.95, 1.8) }
    // A blossoming branch from the top right, petals drifting down.
    let a: P = (1000, 24), c: P = (760, 34), b: P = (430, 150)
    let twigs: [(P, P, P)] = [(a, c, b), ((820, 46), (760, 116), (700, 206)), ((620, 94), (560, 66), (500, 58)),
                              ((930, 34), (896, 116), (926, 214)), ((540, 120), (500, 160), (470, 210))]
    for (i, t) in twigs.enumerated() { pen.stroke(pen.curve(t.0, t.1, t.2), 0.9, i == 0 ? 5 : 3) }
    var rng = RNG(7)
    for i in 0..<70 {
        let t = twigs[i % twigs.count]
        let p = pen.quad(t.0, t.1, t.2, rng.range(0.15, 1))
        blossom(pen, p.0 + rng.range(-34, 34), p.1 + rng.range(-26, 26), rng.range(4, 6))
    }
    for _ in 0..<36 {
        let x = rng.range(300, 1000), y = rng.range(200, 440)
        pen.with(x, y, rotate: rng.range(0, 180)) { pen.mark(pen.ellipse(0, 0, 4, 2), 0.9) }
    }
}

let gift = Scene(name: "gift", size: CGSize(width: 1000, height: 450), seed: 53) { pen in
    pen.stars(CGRect(x: 0, y: 0, width: 900, height: 450), count: 22, avoid: [CGRect(x: 330, y: 100, width: 420, height: 330)])
    for (x, y, r) in [(250.0, 120.0, 14.0), (780, 96, 18), (190, 270, 9), (850, 250, 11), (330, 62, 8), (640, 44, 10)] {
        sparkle(pen, x, y, r)
    }
    pen.seg((150, 410), (880, 410), 0.8)
    pen.shade(pen.ellipse(530, 418, 230, 14), 0.45)
    // Box: front, side and lid in outline; ribbon and bow on top.
    let front = pen.rect(380, 228, 220, 182)
    let side = pen.path([(600, 228), (676, 188), (676, 370), (600, 410)], close: true)
    let lidFront = pen.rect(366, 194, 248, 34)
    let lidTop = pen.path([(366, 194), (614, 194), (694, 152), (446, 152)], close: true)
    let lidSide = pen.path([(614, 194), (694, 152), (694, 184), (614, 228)], close: true)
    for p in [front, side, lidFront, lidTop, lidSide] { pen.occlude(p) }
    pen.shade(side, 0.45)
    pen.shade(front, 0.12)
    pen.shade(lidSide, 0.5)
    for p in [front, side, lidFront, lidTop, lidSide] { pen.stroke(p) }
    for x in [474.0, 506] { pen.seg((x, 194), (x, 410)) }
    pen.stroke(pen.path([(474, 194), (554, 152)]))
    pen.stroke(pen.path([(506, 194), (586, 152)]))
    for x in [628.0, 648] { pen.seg((x, 214 + (x - 628) * -0.5), (x, 398 + (x - 628) * -0.5)) }
    for (ang, dx) in [(-26.0, -42.0), (26, 42)] {
        pen.with(520 + dx, 148, rotate: ang) {
            pen.stroke(pen.ellipse(0, 0, 42, 20), 1, 2.4)
            pen.stroke(pen.ellipse(0, 0, 26, 9), 0.6, 1.4)
        }
    }
    pen.stroke(pen.ellipse(520, 154, 12, 10), 1, 2.4)
    pen.stroke(pen.curve((512, 164), (490, 200), (466, 214)), 1, 2.2)
    pen.stroke(pen.curve((528, 164), (556, 196), (584, 204)), 1, 2.2)
    // A small box to the right.
    let small = pen.rect(744, 336, 88, 74)
    let smallLid = pen.rect(736, 322, 104, 16)
    for p in [small, smallLid] { pen.occlude(p); pen.stroke(p) }
    for x in [780.0, 796] { pen.seg((x, 322), (x, 410), 0.9) }
}

let receipt = Scene(name: "receipt", size: CGSize(width: 1000, height: 450), seed: 61) { pen in
    pen.stars(CGRect(x: 0, y: 0, width: 900, height: 450), count: 20, avoid: [CGRect(x: 300, y: 0, width: 440, height: 450)])
    for (i, y) in [404.0, 388, 372, 356].enumerated() {
        let x = 196 + Double(i % 2) * 6
        let c = pen.ellipse(x, y, 66, 16)
        pen.occlude(c); pen.stroke(c)
        pen.stroke(pen.ellipse(x, y, 46, 10), 0.5, 1.4)
    }
    pen.seg((110, 420), (890, 420), 0.75)
    pen.with(500, 222, rotate: -2, scale: 0.86) {
        let p = CGMutablePath()
        let w = 150.0, top = -196.0, bot = 196.0
        p.move(to: CGPoint(x: -w, y: top))
        var x = -w
        var up = true
        while x < w { x = min(w, x + 15); p.addLine(to: CGPoint(x: x, y: top + (up ? 9 : 0))); up.toggle() }
        p.addLine(to: CGPoint(x: w, y: bot))
        while x > -w { x = max(-w, x - 15); p.addLine(to: CGPoint(x: x, y: bot - (up ? 9 : 0))); up.toggle() }
        p.closeSubpath()
        pen.occlude(p); pen.stroke(p)
        pen.stroke(pen.rect(-58, -164, 116, 22), 1)
        pen.hatch(pen.rect(-58, -164, 116, 22), angle: 0, spacing: 7)
        pen.stroke(pen.path([(-120, -124), (120, -124)]), 0.6, 1.4)
        var rng = RNG(5)
        var y = -98.0
        for row in 0..<6 {
            pen.seg((-120, y), (-120 + rng.range(60, 140), y), 0.8)
            pen.seg((120 - rng.range(34, 56), y), (120, y), 0.95)
            y += 22
            if row == 3 { pen.seg((-120, y - 7), (120, y - 7), 0.5, 1.2); y += 6 }
        }
        pen.seg((-120, y + 4), (120, y + 4), 1)
        pen.seg((-120, y + 26), (-40, y + 26), 1, 3)
        pen.seg((50, y + 26), (120, y + 26), 1, 3)
        var bx = -110.0
        while bx < 110 { pen.seg((bx, 138), (bx, 176), 1, rng.range(1.2, 3.4)); bx += rng.range(5, 10) }
    }
    pen.with(640, 300, rotate: 14, scale: 0.85) {
        let ring = pen.ellipse(0, 0, 64, 64)
        pen.occlude(ring)
        pen.stroke(ring, 1, 2.6)
        pen.stroke(pen.ellipse(0, 0, 52, 52), 0.8, 1.6)
        pen.shade(pen.ellipse(0, 0, 48, 48), 0.3)
        pen.stroke(pen.path([(-26, 2), (-8, 22), (30, -22)]), 1, 4)
    }
}

let deal = Scene(name: "deal", size: CGSize(width: 1000, height: 450), seed: 71) { pen in
    pen.stars(CGRect(x: 0, y: 0, width: 880, height: 200), count: 20)
    moon(pen, 200, 96, 40, lit: 1)
    let backLine: [P] = [(0, 330), (140, 222), (260, 290), (420, 152), (560, 262), (700, 192), (860, 300), (1000, 242)]
    pen.shade(pen.path(backLine + [(1000, 450), (0, 450)], close: true)) { _, y in 0.22 - (y - 150) / 1400 }
    pen.stroke(pen.path(backLine), 0.9)
    for (a, b) in [((420.0, 152.0), (380.0, 300.0)), ((420, 152), (470, 320)), ((140, 222), (120, 320)), ((700, 192), (740, 330))] {
        pen.stroke(pen.curve(a, ((a.0 + b.0) / 2 + 10, (a.1 + b.1) / 2), b), 0.55, 1.6)
    }
    let frontLine: [P] = [(0, 400), (180, 344), (330, 382), (520, 334), (700, 392), (860, 352), (1000, 384)]
    pen.occlude(pen.path(frontLine + [(1000, 450), (0, 450)], close: true))
    pen.stroke(pen.path(frontLine), 0.9)
    pen.shade(pen.path(frontLine + [(1000, 450), (0, 450)], close: true), 0.12)
    pagoda(pen, cx: 640, base: 384, tiers: 5, w: 120)
    pen.ripples(CGRect(x: 0, y: 296, width: 600, height: 40), rowStep: 14, minLen: 30, maxLen: 80, gap: 60, 0.45)
}

let risk = Scene(name: "risk", size: CGSize(width: 1000, height: 450), seed: 83) { pen in
    for r in stride(from: 130.0, through: 290, by: 40) {
        let ring = pen.ellipse(500, 225, r, r * 0.8).copy(strokingWithWidth: 3, lineCap: .round, lineJoin: .round, miterLimit: 1)
        pen.shade(ring, 0.6 - (r - 130) / 400)
    }
    pen.stars(CGRect(x: 0, y: 0, width: 900, height: 450), count: 18, avoid: [CGRect(x: 180, y: 0, width: 640, height: 450)])
    let shield = CGMutablePath()
    shield.move(to: CGPoint(x: 500, y: 54))
    shield.addQuadCurve(to: CGPoint(x: 626, y: 102), control: CGPoint(x: 568, y: 98))
    shield.addQuadCurve(to: CGPoint(x: 500, y: 404), control: CGPoint(x: 636, y: 316))
    shield.addQuadCurve(to: CGPoint(x: 374, y: 102), control: CGPoint(x: 364, y: 316))
    shield.addQuadCurve(to: CGPoint(x: 500, y: 54), control: CGPoint(x: 432, y: 98))
    shield.closeSubpath()
    pen.occlude(shield); pen.stroke(shield, 1, 2.6)
    pen.with(500, 228, scale: 0.8) { pen.with(-500, -228) { pen.stroke(shield, 0.75, 2) } }
    pen.shade(shield) { x, _ in x < 500 ? 0.18 : 0.06 }
    pen.stroke(pen.path([(446, 232), (488, 276), (562, 176)]), 1, 7)
}

let agent = Scene(name: "agent", size: CGSize(width: 1000, height: 450), seed: 97) { pen in
    pen.stars(CGRect(x: 0, y: 0, width: 900, height: 450), count: 22, avoid: [CGRect(x: 200, y: 40, width: 600, height: 380)])
    let c: P = (500, 225)
    pen.stroke(pen.ellipse(c.0, c.1, 290, 150), 0.45, 1.4)
    var nodes: [P] = []
    for k in 0..<5 {
        let a = -Double.pi / 2 + Double(k) / 5 * 2 * .pi
        nodes.append((c.0 + cos(a) * 250, c.1 + sin(a) * 150))
    }
    for (i, n) in nodes.enumerated() {
        pen.seg(n, c, 0.7)
        pen.seg(n, nodes[(i + 1) % 5], 0.45, 1.6)
    }
    for n in nodes {
        let e = pen.ellipse(n.0, n.1, 36, 36)
        pen.occlude(e); pen.shade(e, 0.45); pen.stroke(e)
    }
    let core = pen.ellipse(c.0, c.1, 58, 58)
    pen.occlude(core); pen.stroke(core, 1, 2.6)
    pen.stroke(pen.ellipse(c.0, c.1, 40, 40), 0.7, 1.6)
    pen.shade(pen.ellipse(c.0, c.1, 36, 36), 0.65)
}

// MARK: - Pieces (scene + grid + viewport)

struct Piece {
    let name: String
    let scene: Scene
    let cols: Int
    let rows: Int
    /// Top-left of the viewport in world units and its width; the height follows the grid.
    let origin: CGPoint
    let width: Double
}

func hero(_ s: Scene, cols: Int = 168) -> Piece {
    let rows = Int((s.size.height / s.size.width * Double(cols * cellW) / Double(cellH)).rounded())
    return Piece(name: s.name, scene: s, cols: cols, rows: rows, origin: .zero, width: s.size.width)
}

func strip(_ s: Scene, x: Double, y: Double, w: Double) -> Piece {
    Piece(name: s.name + "Strip", scene: s, cols: 120, rows: 12, origin: CGPoint(x: x, y: y), width: w)
}

let pieces: [Piece] = [
    hero(home), hero(flights), hero(fund), hero(send), hero(gift), hero(receipt), hero(deal), hero(risk), hero(agent),
    strip(home, x: 0, y: 140, w: 1000),
    strip(flights, x: 0, y: 95, w: 1000),
    strip(fund, x: 0, y: 200, w: 1000),
    strip(send, x: 140, y: 300, w: 860),
    strip(gift, x: 0, y: 140, w: 1000),
    strip(receipt, x: 0, y: 40, w: 1000),
    strip(deal, x: 0, y: 150, w: 1000),
    strip(risk, x: 0, y: 130, w: 1000),
    strip(agent, x: 0, y: 130, w: 1000),
]

// MARK: - Rasterise and map to glyphs

func gray(width: Int, height: Int) -> CGContext {
    let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width,
                      space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)!
    c.setFillColor(CGColor(gray: 0, alpha: 1)); c.fill(CGRect(x: 0, y: 0, width: width, height: height))
    return c
}

func pixels(_ ctx: CGContext) -> [Double] {
    let p = ctx.data!.assumingMemoryBound(to: UInt8.self)
    return (0..<(ctx.width * ctx.height)).map { Double(p[$0]) / 255 }
}

let bayer: [[Double]] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map { $0.map { ($0 + 0.5) / 16 } }

func convert(_ piece: Piece) -> [String] {
    let pw = piece.cols * cellW, ph = piece.rows * cellH
    let line = gray(width: pw, height: ph), tone = gray(width: pw, height: ph)
    let scale = Double(pw) / piece.width
    for c in [line, tone] {
        c.translateBy(x: 0, y: CGFloat(ph)); c.scaleBy(x: 1, y: -1)
        c.scaleBy(x: scale, y: scale); c.translateBy(x: -piece.origin.x, y: -piece.origin.y)
    }
    piece.scene.draw(Pen(line: line, tone: tone, seed: piece.scene.seed))
    let lp = pixels(line), tp = pixels(tone)
    func at(_ x: Int, _ y: Int) -> Double { lp[max(0, min(ph - 1, y)) * pw + max(0, min(pw - 1, x))] }
    var grid = [[Character]](repeating: [Character](repeating: " ", count: piece.cols), count: piece.rows)
    var strength = [[Double]](repeating: [Double](repeating: 0, count: piece.cols), count: piece.rows)
    for r in 0..<piece.rows {
        for c in 0..<piece.cols {
            let x0 = c * cellW, y0 = r * cellH
            var sum = 0.0, toneSum = 0.0, sxx = 0.0, syy = 0.0, sxy = 0.0, wy = 0.0
            for j in 0..<cellH {
                for i in 0..<cellW {
                    let x = x0 + i, y = y0 + j
                    let v = at(x, y)
                    sum += v; wy += v * Double(j)
                    toneSum += tp[y * pw + x]
                    let gx = at(x + 1, y) - at(x - 1, y), gy = at(x, y + 1) - at(x, y - 1)
                    sxx += gx * gx; syy += gy * gy; sxy += gx * gy
                }
            }
            let n = Double(cellW * cellH)
            let mean = sum / n, t = toneSum / n
            let energy = (sxx + syy) / n
            let coherence = sqrt((sxx - syy) * (sxx - syy) + 4 * sxy * sxy) / (sxx + syy + 1e-9)
            var ch: Character = " "
            if mean >= 0.045 {
                if energy > 0.02 && coherence > 0.55 && mean < 0.5 {
                    let gAxis = atan2(2 * sxy, sxx - syy) / 2
                    var a = (gAxis + .pi / 2) * 180 / .pi
                    a = a.truncatingRemainder(dividingBy: 180); if a < 0 { a += 180 }
                    let cy = (wy / sum) / Double(cellH)
                    if a < 24 || a >= 156 { ch = cy > 0.62 ? "_" : (cy < 0.3 ? "`" : "-") }
                    else if a < 66 { ch = "\\" }
                    else if a < 114 { ch = "|" }
                    else { ch = "/" }
                } else if mean < 0.11 { ch = "." }
                else if mean < 0.2 { ch = ":" }
                else if mean < 0.34 { ch = "+" }
                else if mean < 0.5 { ch = "*" }
                else { ch = "#" }
            } else if t > 0.02 {
                let b = bayer[r % 4][c % 4]
                let level = t * 2
                ch = level > 1 + b ? ":" : (level > b ? "." : " ")
            }
            grid[r][c] = ch
            strength[r][c] = mean
        }
    }
    // Thin strokes to one glyph: steep strokes keep the strongest cell across a row,
    // flat strokes the strongest cell down a column.
    let steep: Set<Character> = ["/", "\\", "|"], flat: Set<Character> = ["-", "_", "`"]
    var thinned = grid
    for r in 0..<piece.rows {
        for c in 0..<piece.cols {
            let ch = grid[r][c], m = strength[r][c]
            if steep.contains(ch) {
                for dc in [-1, 1] where c + dc >= 0 && c + dc < piece.cols {
                    if steep.contains(grid[r][c + dc]) && strength[r][c + dc] > m * 1.15 { thinned[r][c] = " " }
                }
            } else if flat.contains(ch) {
                for dr in [-1, 1] where r + dr >= 0 && r + dr < piece.rows {
                    if flat.contains(grid[r + dr][c]) && strength[r + dr][c] > m * 1.15 { thinned[r][c] = " " }
                }
            }
        }
    }
    return thinned.map { row in
        var s = String(row)
        while s.last == " " { s.removeLast() }
        return s
    }
}

// MARK: - Previews

let fontURL = URL(fileURLWithPath: "SynqMessagesExtension/Fonts/JetBrainsMono-Regular.ttf")
let fontDesc = (CTFontManagerCreateFontDescriptorsFromURL(fontURL as CFURL) as! [CTFontDescriptor])[0]
let font = CTFontCreateWithFontDescriptor(fontDesc, CGFloat(cellW) / 0.6, nil)

func drawGlyph(_ c: Character, in ctx: CGContext, x: CGFloat, y: CGFloat, gray v: CGFloat) {
    let attr = NSAttributedString(string: String(c), attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: v, alpha: 1),
    ])
    let ascent = CTFontGetAscent(font), descent = CTFontGetDescent(font)
    ctx.textPosition = CGPoint(x: x, y: y + (CGFloat(cellH) - ascent - descent) / 2 + descent)
    CTLineDraw(CTLineCreateWithAttributedString(attr), ctx)
}

func preview(_ rows: [String], cols: Int, to url: URL) {
    let w = cols * cellW, h = rows.count * cellH
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(gray: 0, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    for (r, row) in rows.enumerated() {
        for (c, ch) in row.enumerated() where ch != " " {
            drawGlyph(ch, in: ctx, x: CGFloat(c * cellW), y: CGFloat(h - (r + 1) * cellH),
                      gray: dimChars.contains(ch) ? 0.63 : 0.95)
        }
    }
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
}

// MARK: - Main

let args = CommandLine.arguments
let previewDir = args.count > 1 ? URL(fileURLWithPath: args[1]) : nil
if let previewDir { try? FileManager.default.createDirectory(at: previewDir, withIntermediateDirectories: true) }

var swift = """
// Generated by Design/ascii-art.swift from procedural scenes (no source images).
// Do not edit by hand: change a scene and run `sh Design/ascii-art.sh`.

extension AsciiArtwork {

"""
for piece in pieces {
    let rows = convert(piece)
    if let previewDir { preview(rows, cols: piece.cols, to: previewDir.appendingPathComponent("\(piece.name).png")) }
    swift += "    static let \(piece.name) = AsciiArtwork(cols: \(piece.cols), rows: [\n"
    for row in rows { swift += "        \"\(row.replacingOccurrences(of: "\\", with: "\\\\"))\",\n" }
    swift += "    ])\n\n"
    print("\(piece.name): \(piece.cols)×\(rows.count)")
}
swift += "}\n"
try! swift.write(toFile: "SynqMessagesExtension/AsciiArtData.swift", atomically: true, encoding: .utf8)
