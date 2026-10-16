// Renders the Synq app icons and design previews from the same SwiftUI views the
// Messages extension uses, with sample data (Design/Samples.swift).
//
//   apps/ios-messages/Design/render.sh <out-dir> [theme]     (theme: ascii | holo)
//
// Writes into <out-dir>: every screen and state as an iPhone mock (393×852 @3x),
// transcript bubbles in a dark Messages-like transcript, the card bubbles, the art
// set and avatars. With the default theme it also writes the iMessage App Icon set.
import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

@MainActor var theme: any SynqTheme = SynqThemes.all[0]

@MainActor
func png(_ view: some View, width: CGFloat, height: CGFloat, scale: CGFloat, to url: URL, phase: Double = 0.35) {
    let renderer = ImageRenderer(content: view
        .frame(width: width, height: height)
        .environment(\.synqRenderMode, .still(phase: phase))
        .environment(\.synqTheme, theme)
        .environment(\.colorScheme, .dark))
    renderer.scale = scale
    guard let cg = renderer.cgImage else { fatalError("render failed: \(url.lastPathComponent)") }
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, cg, nil)
    CGImageDestinationFinalize(dest)
}

// MARK: - Device chrome

let phone = CGSize(width: 393, height: 852)

/// Status bar and the Messages app-panel grabber above an expanded extension.
struct ExpandedPhone<Content: View>: View {
    @Environment(\.synqTheme) private var theme
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack(alignment: .top) {
            theme.colors.background
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
                    HStack(spacing: -8) {
                        ForEach(Samples.members.prefix(3)) { m in SynqAvatar(id: m.principalId, name: m.name, size: 26) }
                    }
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
            .frame(width: width, height: SynqCardBubble.height(forWidth: width))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
    }
}

/// The app icon: the centre-tab "S" key on black, over a strip of dot art.
struct SynqAppIcon: View {
    var size: CGFloat
    var aspect: CGFloat = 1

    var body: some View {
        let h = size, w = size * aspect
        let ascii = AsciiTheme()
        ZStack {
            Color.black
            RoundedRectangle(cornerRadius: h * 0.12, style: .continuous)
                .fill(Color.black)
                .frame(width: h * 0.52, height: h * 0.52)
                .overlay(RoundedRectangle(cornerRadius: h * 0.12, style: .continuous)
                    .strokeBorder(ascii.colors.inkPrimary, lineWidth: max(1, h * 0.018)))
            Text("S").font(.custom(AsciiTheme.pixel, fixedSize: h * 0.4)).foregroundStyle(ascii.colors.inkPrimary)
                .offset(y: -h * 0.01)
        }
        .frame(width: w, height: h)
        .clipped()
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

@MainActor
func cardRow(_ title: String, _ cards: [SynqCardModel]) -> some View {
    VStack(alignment: .leading, spacing: 18) {
        Text(title).synqType(.sectionLabel, .secondary)
        HStack(alignment: .top, spacing: 36) {
            ForEach(Array(cards.enumerated()), id: \.offset) { _, c in
                VStack(spacing: 10) {
                    SynqCardBubble(model: c).frame(width: 300, height: SynqCardBubble.height(forWidth: 300))
                    Text(c.status).synqType(.caption, .tertiary)
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
        theme = SynqThemes.named(args.count > 3 ? args[3] : SynqThemes.all[0].id)
        SynqFonts.register(from: URL(fileURLWithPath: "SynqMessagesExtension/Fonts"))
        for f in [AsciiTheme.mono, AsciiTheme.pixel, AsciiTheme.japanese] where !SynqFonts.isAvailable(f) {
            print("warning: font \(f) not registered; falling back to system fonts")
        }
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let screens = out.appendingPathComponent("1 iMessage app screens")
        let bubbles = out.appendingPathComponent("2 iMessage chat bubbles")
        let cards = out.appendingPathComponent("3 iMessage cards")
        for d in [screens, bubbles, cards] { try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
        func screen(_ name: String) -> URL { screens.appendingPathComponent(name) }
        func bubble(_ name: String) -> URL { bubbles.appendingPathComponent(name) }
        func card(_ name: String) -> URL { cards.appendingPathComponent(name) }

        if theme.id == SynqThemes.all[0].id {
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
                png(SynqAppIcon(size: h, aspect: w / h), width: w, height: h, scale: 1, to: icons.appendingPathComponent(name))
            }
            png(SynqAppIcon(size: 512), width: 512, height: 512, scale: 2, to: card("logo.png"))
        }

        // Card bubbles in each state.
        let net = "Monad testnet"
        let funds = [Samples.fund("FORMING").card, Samples.fund("SETUP").card, Samples.activeFund.card]
        let payments = [Samples.proposal("PENDING", counted: 1).card(fundName: "Goa crew", network: net),
                        Samples.proposal("EXECUTING", counted: 2).card(fundName: "Goa crew", network: net),
                        Samples.proposal("PAID", counted: 2).card(fundName: "Goa crew", network: net)]
        let flights = [Samples.trip("VOTING").card(fundName: "Goa crew"), Samples.trip("BOOKING").card(fundName: "Goa crew"),
                       Samples.trip("BOOKED").card(fundName: "Goa crew")]
        let gifts = [Samples.gift("VOTING").card(fundName: "Goa crew"), Samples.gift("BOOKING").card(fundName: "Goa crew"),
                     Samples.gift("BOOKED").card(fundName: "Goa crew")]
        for (name, row, title) in [("cards-fund.png", funds, "Fund · forming / activating / live"),
                                   ("cards-payment.png", payments, "Payment · pending / sending / paid"),
                                   ("cards-flight.png", flights, "Return flight · voting / booking / booked"),
                                   ("cards-gift.png", gifts, "Gift · voting / buying / bought")] {
            png(ZStack { theme.colors.background; cardRow(title, row) }, width: 1100, height: 330, scale: 2, to: card(name))
        }
        png(ZStack {
            theme.colors.background
            VStack(alignment: .leading, spacing: 30) {
                cardRow("Fund", funds); cardRow("Payment", payments); cardRow("Flight", flights); cardRow("Gift", gifts)
            }
        }, width: 1100, height: 1300, scale: 1.5, to: card("cards-all.png"))

        // The art set (hero bands and card strips) and the avatars.
        png(ZStack {
            theme.colors.background
            LazyVGrid(columns: [GridItem(.fixed(520)), GridItem(.fixed(520))], spacing: 28) {
                ForEach(SynqArtSlot.allCases, id: \.self) { slot in
                    VStack(alignment: .leading, spacing: 8) {
                        theme.art(slot, .hero).frame(width: 520)
                        Text(slot.rawValue).synqType(.caption, .tertiary)
                    }
                }
            }
        }, width: 1120, height: 1800, scale: 2, to: card("art-heroes.png"))
        png(ZStack {
            theme.colors.background
            VStack(alignment: .leading, spacing: 18) {
                ForEach(SynqArtSlot.allCases, id: \.self) { slot in
                    HStack(spacing: 16) {
                        theme.art(slot, .strip).frame(width: 300)
                        Text(slot.rawValue).synqType(.caption, .tertiary)
                    }
                }
            }
        }, width: 420, height: 720, scale: 3, to: card("art-strips.png"))
        png(ZStack {
            theme.colors.background
            VStack(spacing: 20) {
                ForEach(0..<3) { row in
                    HStack(spacing: 20) {
                        ForEach(0..<6) { i in
                            let n = row * 6 + i
                            SynqAvatar(id: "member-\(n)", name: "Member \(n)",
                                       status: n % 3 == 0 ? .approved : n % 3 == 1 ? .pending : .none, size: 64)
                        }
                    }
                }
            }
        }, width: 560, height: 300, scale: 3, to: card("avatars.png"))

        // Transcript bubbles.
        png(Transcript {
            TextBubble(text: "Goa in December? I'll set up a fund", mine: true)
            LiveBubble(mine: true) { FundInviteBubble(fallbackName: "Goa crew", view: Samples.activeFund) }
            TextBubble(text: "Booked the flights, approve pls 🙏", sender: "Priya")
            LiveBubble { FundProposalBubble(proposal: Samples.proposal("PENDING", counted: 1, amount: "254.30"), fundName: "Goa crew") }
            LiveBubble(mine: true) { FundTripBubble(trip: Samples.trip("BOOKED"), fundName: "Goa crew") }
            LiveBubble { FundProposalBubble(proposal: Samples.proposal("PAID", counted: 2), fundName: "Goa crew") }
        }, width: phone.width, height: 1260, scale: 3, to: bubble("transcript.png"))
        png(Transcript {
            LiveBubble { FundInviteBubble(fallbackName: "Goa crew", view: Samples.fund("FORMING")) }
            LiveBubble(mine: true) { FundTripBubble(trip: Samples.trip("VOTING"), fundName: "Goa crew") }
            LiveBubble { FundTripBubble(trip: Samples.gift("VOTING"), fundName: "Goa crew") }
            LiveBubble(mine: true) { FundProposalBubble(proposal: Samples.proposal("EXECUTING", counted: 2), fundName: "Goa crew") }
        }, width: phone.width, height: 1000, scale: 3, to: bubble("transcript-states.png"))

        // Screens (expanded, iPhone 393×852 @3x).
        func shot(_ name: String, height: CGFloat = phone.height, scale: CGFloat = 3, _ view: some View) {
            png(ExpandedPhone { view }, width: phone.width, height: height, scale: scale, to: screen(name))
        }
        func fund(_ model: FundModel, _ tab: SynqTab = .home) -> some View {
            FundScreen(model: model, actions: .none, tab: tab)
        }

        shot("screen-start.png", StartFundView(model: sampleModel(nil), actions: .none, onPasteLink: {},
                                               text: "Flights from Delhi to Goa Dec 1–5 for 3"))
        shot("screen-start-empty.png", StartFundView(model: sampleModel(nil), actions: .none, onPasteLink: {}))

        let home = sampleModel(Samples.activeFund, trips: [Samples.trip("VOTING"), Samples.gift("BOOKED")])
        shot("screen-home.png", fund(home))
        shot("screen-home-full.png", height: 1900, scale: 2, fund(home))
        shot("screen-flights.png", fund(home, .trips))
        shot("screen-gifts.png", fund(home, .gifts))
        shot("screen-group.png", fund(home, .group))
        shot("screen-group-full.png", height: 1700, scale: 2, fund(home, .group))
        shot("screen-ask.png", fund(sampleModel(Samples.activeFund), .ask))

        let searching = sampleModel(Samples.activeFund, trips: [Samples.gift("VOTING")])
        searching.searching = .flight(Samples.plan)
        shot("screen-home-searching.png", fund(searching))
        shot("screen-home-searching-full.png", height: 1700, scale: 2, fund(searching))
        shot("screen-flights-searching.png", fund(searching, .trips))

        let replied = sampleModel(Samples.activeFund, trips: [Samples.trip("VOTING")])
        replied.note = CommandNote(prompt: "fly to goa dec 1", reply: "Where are you flying from? Add it and I'll search.",
                                   outcome: .completeFlight(FlightDraft(destination: "GOI", destinationLabel: "Goa",
                                                                        departureDate: "2026-12-01")))
        shot("screen-home-reply.png", fund(replied, .ask))

        let forming = sampleModel(Samples.fund("FORMING"), admin: true)
        forming.ref?.pendingFlight = Samples.plan
        shot("screen-home-forming.png", fund(forming))
        for state in ["SETUP", "LAUNCHING", "FAILED"] {
            shot("screen-home-\(state.lowercased()).png", fund(sampleModel(Samples.fund(state), admin: true)))
        }

        let tripModel = sampleModel(Samples.activeFund, trips: [Samples.trip("VOTING")])
        shot("screen-trip.png", TripDetailView(model: tripModel, trip: Samples.trip("VOTING"), actions: .none))
        shot("screen-trip-full.png", height: 1850, scale: 2, TripDetailView(model: tripModel, trip: Samples.trip("VOTING"), actions: .none))
        shot("screen-gift.png", TripDetailView(model: tripModel, trip: Samples.gift("VOTING"), actions: .none))
        for state in ["AWAITING_PAYMENT", "BOOKING", "BOOKED", "FAILED"] {
            let m = sampleModel(Samples.activeFund, trips: [Samples.trip(state)])
            shot("screen-trip-\(state.lowercased()).png", TripDetailView(model: m, trip: Samples.trip(state), actions: .none))
        }
        for state in ["BOOKING", "BOOKED"] {
            let m = sampleModel(Samples.activeFund, trips: [Samples.gift(state)])
            shot("screen-gift-\(state.lowercased()).png", TripDetailView(model: m, trip: Samples.gift(state), actions: .none))
        }
        for (state, counted) in [("PENDING", 1), ("EXECUTING", 2), ("PAID", 2), ("REJECTED", 1)] {
            let proposal = Samples.proposal(state, counted: counted, amount: "254.30")
            shot(state == "PENDING" ? "screen-payment.png" : "screen-payment-\(state.lowercased()).png",
                 ProposalDetailView(proposal: proposal, fundName: "Goa crew", network: net, onApprove: {},
                                    onExplorer: { _ in }, onShare: {}, onBack: {}))
        }

        shot("sheet-send.png", SendSheet(view: Samples.activeFund, prefill: SendPrefill(recipientId: "r1", amount: "26.99"),
                                         onContinue: { _, _ in }, onCancel: {}))
        shot("sheet-gift.png", GiftSheet(prefill: GiftPrefill(query: "gifts for car lovers", maxPrice: "50"), maxBudget: 500,
                                         onSearch: { _, _ in }, onCancel: {}))
        shot("sheet-plan-trip.png", PlanTripSheet(prefill: FlightDraft(origin: "DEL", destination: "GOI", originLabel: "Delhi",
                                                                       destinationLabel: "Goa", departureDate: "2026-12-01",
                                                                       returnDate: "2026-12-05", travelers: 3),
                                                  onSearch: { _ in }, onCancel: {}))

        // Compact: the conversation above, the Synq panel at keyboard height below.
        func compact(_ name: String, _ panel: some View) {
            png(VStack(spacing: 0) {
                Transcript {
                    TextBubble(text: "Who's in for Goa?", sender: "Arjun")
                    TextBubble(text: "Me! Let's book it", mine: true)
                }
                .frame(height: phone.height - 300)
                panel.environment(\.synqCompact, true).frame(height: 300).clipped()
            }, width: phone.width, height: phone.height, scale: 3, to: screen(name))
        }
        compact("screen-compact-home.png", FundScreen(model: home, actions: .none,
                                                      command: "book a flight from Delhi to Goa Dec 1-5 for 3"))
        compact("screen-compact-start.png", StartFundView(model: sampleModel(nil), actions: .none, onPasteLink: {}, text: "Goa trip"))
        compact("screen-compact-searching.png", FundScreen(model: searching, actions: .none))
        compact("screen-compact-forming.png", FundScreen(model: forming, actions: .none))

        if let link = CardLink(url: URL(string: "https://synq.example/approve?p=0x"
                                            + String(repeating: "11", count: 32) + "&g=0x"
                                            + String(repeating: "a1", count: 32)
                                            + "&n=v1.r.tsk2ou.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB")!,
                               allowedHost: "synq.example") {
            let status = CardStatus(status: "PENDING", state: "PENDING", counted: 1, required: 2)
            shot("screen-review-card.png", ExpandedCardView(link: link, status: status, error: nil, onRefresh: {}, onReview: {},
                                                            onShareUpdate: {}))
            png(Transcript { LiveBubble { TranscriptCardView(link: link, status: status) } },
                width: phone.width, height: 420, scale: 3, to: bubble("transcript-review-card.png"))
        }
        print("wrote \(out.path) with theme \(theme.id)")
    }
}
