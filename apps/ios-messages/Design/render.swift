// Renders the Synq app icons and design previews from the same SwiftUI views the
// Messages extension uses, with sample data (Design/Samples.swift).
//
//   apps/ios-messages/Design/render.sh <out-dir>
//
// Writes the iMessage App Icon set into the asset catalog, plus into <out-dir>:
// every holo card face in each rarity, transcript bubbles in a dark Messages-like
// transcript, full-screen iPhone mocks (393×852 @3x) and a foil animation (GIF).
import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

@MainActor
func png(_ view: some View, width: CGFloat, height: CGFloat, scale: CGFloat, to url: URL, phase: Double = 0.35) {
    let renderer = ImageRenderer(content: view
        .frame(width: width, height: height)
        .environment(\.synqRenderMode, .still(phase: phase))
        .environment(\.colorScheme, .dark))
    renderer.scale = scale
    guard let cg = renderer.cgImage else { fatalError("render failed: \(url.lastPathComponent)") }
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, cg, nil)
    CGImageDestinationFinalize(dest)
}

@MainActor
func gif(frames: [(view: AnyView, phase: Double)], width: CGFloat, height: CGFloat, scale: CGFloat, delay: Double, to url: URL) {
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.gif.identifier as CFString, frames.count, nil)!
    CGImageDestinationSetProperties(dest, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
    for frame in frames {
        let renderer = ImageRenderer(content: frame.view
            .frame(width: width, height: height)
            .environment(\.synqRenderMode, .still(phase: frame.phase))
            .environment(\.colorScheme, .dark))
        renderer.scale = scale
        CGImageDestinationAddImage(dest, renderer.cgImage!,
                                   [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay]] as CFDictionary)
    }
    CGImageDestinationFinalize(dest)
}

// MARK: - Device chrome

let phone = CGSize(width: 393, height: 852)

/// Status bar and the Messages app-panel grabber above an expanded extension.
struct ExpandedPhone<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack(alignment: .top) {
            Theme.ink
            VStack(spacing: 0) {
                StatusBar().frame(height: 54)
                ZStack {
                    Capsule().fill(Color.white.opacity(0.28)).frame(width: 36, height: 5)
                    HStack {
                        Spacer()
                        Image(systemName: "xmark.circle.fill").font(.system(size: 22)).foregroundStyle(Color.white.opacity(0.3))
                    }
                    .padding(.horizontal, 16)
                }
                .frame(height: 30)
                content().frame(maxHeight: .infinity, alignment: .top).clipped()
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 54, style: .continuous))
    }
}

struct StatusBar: View {
    var body: some View {
        HStack {
            Text("9:41").font(.system(size: 17, weight: .semibold))
            Spacer()
            HStack(spacing: 6) {
                Image(systemName: "cellularbars")
                Image(systemName: "wifi")
                Image(systemName: "battery.100")
            }
            .font(.system(size: 15, weight: .semibold))
        }
        .foregroundStyle(Color.white)
        .padding(.horizontal, 32)
        .padding(.top, 14)
    }
}

/// A dark Messages-like transcript so bubbles are judged in context.
struct Transcript<Content: View>: View {
    var title = "Goa crew"
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack(alignment: .top) {
            Color.black
            VStack(spacing: 0) {
                StatusBar().frame(height: 54)
                VStack(spacing: 4) {
                    AvatarStack(people: Samples.members.map { .init(id: $0.principalId, name: $0.name, active: false) }, size: 26, limit: 3)
                    Text(title).font(.system(size: 12, weight: .medium)).foregroundStyle(Color.white.opacity(0.8))
                }
                .padding(.bottom, 10)
                Rectangle().fill(Color.white.opacity(0.08)).frame(height: 0.5)
                VStack(spacing: 10) { content() }
                    .padding(.horizontal, 12)
                    .padding(.top, 14)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
    }
}

struct TextBubble: View {
    var text: String
    var mine = false
    var sender: String? = nil

    var body: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
            if let sender { Text(sender).font(.system(size: 11)).foregroundStyle(Color.white.opacity(0.5)).padding(.leading, 12) }
            Text(text)
                .font(.system(size: 17))
                .foregroundStyle(Color.white)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(mine ? Color(red: 0.04, green: 0.52, blue: 1) : Color(white: 0.15)))
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }
}

/// A live-layout bubble at the width Messages gives it.
struct LiveBubble<Content: View>: View {
    var mine = false
    var width: CGFloat = 300
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .frame(width: width, height: HoloBubbleScene.height(forWidth: width))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }
}

// MARK: - Sample models

@MainActor
func sampleModel(_ view: FundView?, trips: [TripView] = [], admin: Bool = false) -> FundModel {
    let defaults = UserDefaults(suiteName: "synq.design.preview")!
    let model = FundModel(client: FundClient(host: "synq.example"), book: FundBook(defaults: defaults))
    model.ref = FundRef(fundId: Samples.activeFund.fundId, key: String(repeating: "k", count: 32), name: "Goa crew",
                        adminKey: admin ? "admin" : nil, conversations: [], lastUsed: Date())
    model.view = view
    model.trips = trips
    return model
}

func cardRow(_ title: String, _ cards: [HoloCardModel]) -> some View {
    VStack(alignment: .leading, spacing: 18) {
        Text(title).font(.system(size: 22, weight: .bold, design: .rounded)).foregroundStyle(Theme.text2)
        HStack(spacing: 44) {
            ForEach(Array(cards.enumerated()), id: \.offset) { _, c in
                VStack(spacing: 14) {
                    HoloCardFace(model: c).frame(width: 300)
                    Text(c.rarity.name).font(.system(size: 15, weight: .semibold, design: .rounded)).foregroundStyle(Theme.text3)
                }
            }
        }
    }
}

// MARK: - Main

@main
struct Render {
    @MainActor
    static func main() {
        let args = CommandLine.arguments
        let out = URL(fileURLWithPath: args.count > 1 ? args[1] : "design-out")
        let icons = URL(fileURLWithPath: args.count > 2 ? args[2] : "icons")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: icons, withIntermediateDirectories: true)
        func file(_ name: String) -> URL { out.appendingPathComponent(name) }

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
            png(SynqAppIcon(size: h, aspect: w / h), width: w, height: h, scale: 1, to: icons.appendingPathComponent(name))
        }
        png(SynqAppIcon(size: 512), width: 512, height: 512, scale: 2, to: file("logo.png"))

        // Every face in each rarity.
        let net = "Monad testnet"
        let funds = [Samples.fund("FORMING").holo, Samples.fund("SETUP").holo, Samples.activeFund.holo]
        let payments = [Samples.proposal("PENDING", counted: 1).holo(fundName: "Goa crew", network: net),
                        Samples.proposal("EXECUTING", counted: 2).holo(fundName: "Goa crew", network: net),
                        Samples.proposal("PAID", counted: 2).holo(fundName: "Goa crew", network: net)]
        let flights = [Samples.trip("VOTING").holo(fundName: "Goa crew"), Samples.trip("BOOKING").holo(fundName: "Goa crew"),
                       Samples.trip("BOOKED").holo(fundName: "Goa crew")]
        let gifts = [Samples.gift("VOTING").holo(fundName: "Goa crew"), Samples.gift("BOOKING").holo(fundName: "Goa crew"),
                     Samples.gift("BOOKED").holo(fundName: "Goa crew")]
        for (name, row, title) in [("cards-fund.png", funds, "Fund · forming / activating / live"),
                                   ("cards-payment.png", payments, "Payment · pending / sending / paid"),
                                   ("cards-flight.png", flights, "Return flight · voting / booking / booked"),
                                   ("cards-gift.png", gifts, "Gift · voting / buying / bought")] {
            png(ZStack { Theme.ink; cardRow(title, row) }, width: 1100, height: 560, scale: 2, to: file(name))
        }
        png(ZStack {
            Theme.ink
            VStack(alignment: .leading, spacing: 30) {
                cardRow("Fund", funds); cardRow("Payment", payments); cardRow("Flight", flights); cardRow("Gift", gifts)
            }
        }, width: 1100, height: 2280, scale: 1, to: file("cards-all.png"))

        // Transcript bubbles.
        let transcript = Transcript {
            TextBubble(text: "Goa in December? I'll set up a fund", mine: true)
            LiveBubble(mine: true) { FundInviteBubble(fallbackName: "Goa crew", view: Samples.activeFund) }
            TextBubble(text: "Booked the flights, approve pls 🙏", sender: "Priya")
            LiveBubble { FundProposalBubble(proposal: Samples.proposal("PENDING", counted: 1, amount: "254.30"), fundName: "Goa crew") }
            LiveBubble(mine: true) { FundTripBubble(trip: Samples.trip("BOOKED"), fundName: "Goa crew") }
            LiveBubble { FundProposalBubble(proposal: Samples.proposal("PAID", counted: 2), fundName: "Goa crew") }
        }
        png(transcript, width: phone.width, height: 1300, scale: 3, to: file("transcript.png"))
        png(Transcript {
            LiveBubble { FundInviteBubble(fallbackName: "Goa crew", view: Samples.fund("FORMING")) }
            LiveBubble(mine: true) { FundTripBubble(trip: Samples.trip("VOTING"), fundName: "Goa crew") }
            LiveBubble { FundTripBubble(trip: Samples.gift("VOTING"), fundName: "Goa crew") }
            LiveBubble(mine: true) { FundProposalBubble(proposal: Samples.proposal("EXECUTING", counted: 2), fundName: "Goa crew") }
        }, width: phone.width, height: 1040, scale: 3, to: file("transcript-states.png"))

        // Screens (expanded, iPhone 393×852 @3x).
        let start = StartFundView(model: sampleModel(nil), actions: .none, onPasteLink: {},
                                  text: "Flights from Delhi to Goa Dec 1–5 for 3")
        png(ExpandedPhone { start }, width: phone.width, height: phone.height, scale: 3, to: file("screen-start.png"))
        png(ExpandedPhone { StartFundView(model: sampleModel(nil), actions: .none, onPasteLink: {}) },
            width: phone.width, height: phone.height, scale: 3, to: file("screen-start-empty.png"))

        let searching = sampleModel(Samples.activeFund, trips: [Samples.gift("VOTING")])
        searching.searching = .flight(Samples.plan)
        png(ExpandedPhone { FundHomeView(model: searching, actions: .none) },
            width: phone.width, height: phone.height, scale: 3, to: file("screen-home-searching.png"))
        png(ExpandedPhone { FundHomeView(model: searching, actions: .none) },
            width: phone.width, height: 1700, scale: 2, to: file("screen-home-searching-full.png"))

        let home = sampleModel(Samples.activeFund, trips: [Samples.trip("VOTING"), Samples.gift("BOOKED")])
        png(ExpandedPhone { FundHomeView(model: home, actions: .none) },
            width: phone.width, height: phone.height, scale: 3, to: file("screen-home.png"))
        png(ExpandedPhone { FundHomeView(model: home, actions: .none) },
            width: phone.width, height: 1900, scale: 2, to: file("screen-home-full.png"))

        let replied = sampleModel(Samples.activeFund, trips: [Samples.trip("VOTING")])
        replied.note = CommandNote(prompt: "fly to goa dec 1", reply: "Where are you flying from? Add it and I'll search.",
                                   outcome: .completeFlight(FlightDraft(destination: "GOI", destinationLabel: "Goa",
                                                                        departureDate: "2026-12-01")))
        png(ExpandedPhone { FundHomeView(model: replied, actions: .none) },
            width: phone.width, height: phone.height, scale: 3, to: file("screen-home-reply.png"))

        let forming = sampleModel(Samples.fund("FORMING"), admin: true)
        forming.ref?.pendingFlight = Samples.plan
        png(ExpandedPhone { FundHomeView(model: forming, actions: .none) },
            width: phone.width, height: phone.height, scale: 3, to: file("screen-home-forming.png"))

        let tripModel = sampleModel(Samples.activeFund, trips: [Samples.trip("VOTING")])
        png(ExpandedPhone { TripDetailView(model: tripModel, trip: Samples.trip("VOTING"), actions: .none) },
            width: phone.width, height: phone.height, scale: 3, to: file("screen-trip.png"))
        png(ExpandedPhone { TripDetailView(model: tripModel, trip: Samples.trip("VOTING"), actions: .none) },
            width: phone.width, height: 1750, scale: 2, to: file("screen-trip-full.png"))
        png(ExpandedPhone { TripDetailView(model: tripModel, trip: Samples.gift("VOTING"), actions: .none) },
            width: phone.width, height: phone.height, scale: 3, to: file("screen-gift.png"))

        let p = Samples.proposal("PENDING", counted: 1, amount: "254.30")
        png(ExpandedPhone {
            ProposalDetailView(proposal: p, fundName: "Goa crew", network: net, onApprove: {}, onExplorer: { _ in },
                               onShare: {}, onBack: {})
        }, width: phone.width, height: phone.height, scale: 3, to: file("screen-payment.png"))

        png(ExpandedPhone {
            SendSheet(view: Samples.activeFund, prefill: SendPrefill(recipientId: "r1", amount: "5"),
                      onContinue: { _, _ in }, onCancel: {})
        }, width: phone.width, height: phone.height, scale: 3, to: file("sheet-send.png"))
        png(ExpandedPhone {
            GiftSheet(prefill: GiftPrefill(query: "gifts for car lovers", maxPrice: "50"), maxBudget: 500,
                      onSearch: { _, _ in }, onCancel: {})
        }, width: phone.width, height: phone.height, scale: 3, to: file("sheet-gift.png"))

        // Compact: the conversation above, the Synq panel at keyboard height below.
        func compact(_ panel: some View) -> some View {
            VStack(spacing: 0) {
                Transcript {
                    TextBubble(text: "Who's in for Goa?", sender: "Arjun")
                    TextBubble(text: "Me! Let's book it", mine: true)
                }
                .frame(height: phone.height - 300)
                panel.environment(\.synqCompact, true).frame(height: 300).clipped()
            }
        }
        png(compact(FundHomeView(model: home, actions: .none, command: "book a flight from Delhi to Goa Dec 1-5 for 3")),
            width: phone.width, height: phone.height, scale: 3, to: file("screen-compact-home.png"))
        png(compact(StartFundView(model: sampleModel(nil), actions: .none, onPasteLink: {}, text: "Goa trip")),
            width: phone.width, height: phone.height, scale: 3, to: file("screen-compact-start.png"))
        png(compact(FundHomeView(model: searching, actions: .none)),
            width: phone.width, height: phone.height, scale: 3, to: file("screen-compact-searching.png"))

        // Foil animation: light sweeping across a holo-rare and a rare card.
        let frames: [(view: AnyView, phase: Double)] = (0..<40).map { i in
            let phase = Double(i) / 40
            let view = AnyView(ZStack {
                Theme.ink
                HStack(spacing: 36) {
                    HoloCardFace(model: payments[2], light: HoloLight(x: 0.15 + 0.7 * phase, y: 0.25, phase: phase)).frame(width: 260)
                    HoloCardFace(model: funds[2], light: HoloLight(x: 0.15 + 0.7 * phase, y: 0.25, phase: phase)).frame(width: 260)
                }
            })
            return (view, phase)
        }
        gif(frames: frames, width: 660, height: 470, scale: 1, delay: 0.06, to: file("foil.gif"))
        print("wrote \(out.path) and \(icons.path)")
    }
}
