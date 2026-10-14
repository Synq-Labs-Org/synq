// Renders the Synq app icons and design previews from the same SwiftUI views the
// Messages extension uses (SynqMessagesExtension/Chrome.swift).
//
//   apps/ios-messages/Design/render.sh <out-dir>
//
// Writes the iMessage App Icon set into the asset catalog, plus card previews
// (PNG) and a sheen animation (GIF) into <out-dir>.
import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

@MainActor
func png(_ view: some View, width: CGFloat, height: CGFloat, scale: CGFloat, to url: URL) {
    let renderer = ImageRenderer(content: view.frame(width: width, height: height))
    renderer.scale = scale
    guard let cg = renderer.cgImage else { fatalError("render failed: \(url.lastPathComponent)") }
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, cg, nil)
    CGImageDestinationFinalize(dest)
}

@MainActor
func gif(frames: [some View], width: CGFloat, height: CGFloat, scale: CGFloat, delay: Double, to url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString, frames.count, nil)!
    CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
    for frame in frames {
        let renderer = ImageRenderer(content: frame.frame(width: width, height: height))
        renderer.scale = scale
        CGImageDestinationAddImage(dest, renderer.cgImage!,
                                   [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay]] as CFDictionary)
    }
    CGImageDestinationFinalize(dest)
}

/// A Messages-like transcript so the cards are judged in context.
struct Transcript<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        ZStack {
            Color(red: 0.97, green: 0.97, blue: 0.98)
            VStack(spacing: 18) { content() }.padding(22)
        }
    }
}

@main
struct Render {
    @MainActor
    static func main() {
        let args = CommandLine.arguments
        let out = URL(fileURLWithPath: args.count > 1 ? args[1] : "design-out")
        let icons = URL(fileURLWithPath: args.count > 2 ? args[2] : "icons")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: icons, withIntermediateDirectories: true)

        // iMessage App Icon set: (file, pixel width, pixel height)
        let slots: [(String, CGFloat, CGFloat)] = [
            ("icon-29@2x.png", 58, 58), ("icon-29@3x.png", 87, 87),
            ("icon-60x45@2x.png", 120, 90), ("icon-60x45@3x.png", 180, 135),
            ("icon-67x50@2x.png", 134, 100), ("icon-74x55@2x.png", 148, 110),
            ("icon-27x20@2x.png", 54, 40), ("icon-27x20@3x.png", 81, 60),
            ("icon-32x24@2x.png", 64, 48), ("icon-32x24@3x.png", 96, 72),
            ("icon-1024.png", 1024, 1024), ("icon-1024x768.png", 1024, 768),
        ]
        for (name, w, h) in slots {
            png(SynqAppIcon(size: h, aspect: w / h), width: w, height: h, scale: 1,
                to: icons.appendingPathComponent(name))
        }
        png(SynqAppIcon(size: 512), width: 512, height: 512, scale: 2, to: out.appendingPathComponent("logo.png"))

        let w: CGFloat = 340, h: CGFloat = 340 / 1.586
        let cards = Transcript {
            FundCardFace(name: "Christmas", balance: nil, symbol: "AUSD", status: "Join",
                         footnote: "2 members", finish: .silver, sheenPhase: 0.35)
                .frame(width: w, height: h)
            FundCardFace(name: "Christmas", balance: "255.00", symbol: "AUSD", status: "Live",
                         footnote: "2 of 2 approve", finish: .titanium, sheenPhase: 0.55)
                .frame(width: w, height: h)
            PaymentCardFace(fundName: "Christmas", amount: "26.99", symbol: "AUSD", recipient: "Synq Travel",
                            counted: 1, required: 2, status: "1 of 2", finish: .silver, sheenPhase: 0.3)
                .frame(width: w, height: h)
            PaymentCardFace(fundName: "Christmas", amount: "26.99", symbol: "AUSD", recipient: "Synq Travel",
                            counted: 2, required: 2, status: "Paid", finish: .titanium, sheenPhase: 0.6)
                .frame(width: w, height: h)
            PickCardFace(fundName: "Christmas", kind: "Gift", title: "Car lover's coffee mug",
                         subtitle: "3 options · vote", status: "Voting", finish: .silver, sheenPhase: 0.45)
                .frame(width: w, height: h)
        }
        png(cards, width: w + 44, height: (h + 18) * 5 + 26, scale: 2, to: out.appendingPathComponent("cards.png"))

        let frames = (0..<36).map { i in
            Transcript {
                FundCardFace(name: "Christmas", balance: "255.00", symbol: "AUSD", status: "Live",
                             footnote: "2 of 2 approve", finish: .titanium, sheenPhase: Double(i) / 30.0 - 0.1)
                    .frame(width: w, height: h)
                PaymentCardFace(fundName: "Christmas", amount: "26.99", symbol: "AUSD", recipient: "Synq Travel",
                                counted: 1, required: 2, status: "1 of 2", finish: .silver,
                                sheenPhase: Double(i) / 30.0 - 0.1)
                    .frame(width: w, height: h)
            }
        }
        gif(frames: frames, width: w + 44, height: (h + 18) * 2 + 26, scale: 1.5, delay: 0.05,
            to: out.appendingPathComponent("sheen.gif"))
        print("wrote \(out.path) and \(icons.path)")
    }
}
