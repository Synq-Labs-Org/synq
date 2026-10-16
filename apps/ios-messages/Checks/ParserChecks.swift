import Foundation

// Command-bar checks (macOS, Foundation only): the on-device flight/gift parser,
// the decision of what a command does, and backward-compatible decoding of the
// Ask Synq and trip payloads.

private var utc: Calendar {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
}

/// Friday 16 October 2026, fixed so relative dates are deterministic.
private let today = utc.date(from: DateComponents(year: 2026, month: 10, day: 16, hour: 9))!
private let todayString = "2026-10-16"

private struct FlightCase {
    let text: String
    let origin: String?
    let destination: String?
    let depart: String?
    let ret: String?
    let travelers: Int?
    /// Whether it should run with no extra tap (complete and valid).
    let runs: Bool
}

private let flightCases: [FlightCase] = [
    .init(text: "book a flight from Delhi to Goa Dec 1-5 for 3", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: "2026-12-05", travelers: 3, runs: true),
    .init(text: "book a flight from Delhi to Goa Dec 1–5 for 3", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: "2026-12-05", travelers: 3, runs: true),
    .init(text: "flights from Mumbai to Bangalore on 1st December", origin: "BOM", destination: "BLR", depart: "2026-12-01", ret: nil, travelers: nil, runs: true),
    .init(text: "fly DEL to GOI tomorrow for 2", origin: "DEL", destination: "GOI", depart: "2026-10-17", ret: nil, travelers: 2, runs: true),
    .init(text: "I want to fly from London to Paris next Friday", origin: "LHR", destination: "CDG", depart: "2026-10-23", ret: nil, travelers: nil, runs: true),
    .init(text: "flight from new york to san francisco december 12th to 18th for four people", origin: "JFK", destination: "SFO", depart: "2026-12-12", ret: "2026-12-18", travelers: 4, runs: true),
    .init(text: "book tickets delhi to goa 1st to 5th december for 3 adults", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: "2026-12-05", travelers: 3, runs: true),
    .init(text: "can you get us flights to Goa from Bangalore on Dec 20, returning Dec 27", origin: "BLR", destination: "GOI", depart: "2026-12-20", ret: "2026-12-27", travelers: nil, runs: true),
    .init(text: "flight from delhi to dubai dec 28 to jan 3 for 2", origin: "DEL", destination: "DXB", depart: "2026-12-28", ret: "2027-01-03", travelers: 2, runs: true),
    .init(text: "one way flight from chennai to kolkata on 2026-11-20 for 1", origin: "MAA", destination: "CCU", depart: "2026-11-20", ret: nil, travelers: 1, runs: true),
    .init(text: "fly from Bengaluru to Mumbai day after tomorrow", origin: "BLR", destination: "BOM", depart: "2026-10-18", ret: nil, travelers: nil, runs: true),
    .init(text: "flights to Singapore from Delhi on Jan 10 for a week", origin: "DEL", destination: "SIN", depart: "2027-01-10", ret: "2027-01-17", travelers: nil, runs: true),
    .init(text: "book a flight from Delhi to Goa on 5 Nov for me", origin: "DEL", destination: "GOI", depart: "2026-11-05", ret: nil, travelers: 1, runs: true),
    .init(text: "Delhi → Goa flight Dec 1 for 3", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: nil, travelers: 3, runs: true),
    .init(text: "flight from hyderabad to goa on friday", origin: "HYD", destination: "GOI", depart: "2026-10-23", ret: nil, travelers: nil, runs: true),
    .init(text: "fly from goa to delhi this saturday, back on sunday", origin: "GOI", destination: "DEL", depart: "2026-10-17", ret: "2026-10-18", travelers: nil, runs: true),
    .init(text: "flights from Pune to Jaipur 3rd of December for two", origin: "PNQ", destination: "JAI", depart: "2026-12-03", ret: nil, travelers: 2, runs: true),
    .init(text: "book flights from Kochi to Delhi on December 1st returning on the 8th for 2", origin: "COK", destination: "DEL", depart: "2026-12-01", ret: "2026-12-08", travelers: 2, runs: true),
    .init(text: "fly from Delhi to Goa in 3 days", origin: "DEL", destination: "GOI", depart: "2026-10-19", ret: nil, travelers: nil, runs: true),
    .init(text: "Please book a flight from BOM to DEL on Nov 2 for 3 travellers", origin: "BOM", destination: "DEL", depart: "2026-11-02", ret: nil, travelers: 3, runs: true),
    .init(text: "book flight Delhi to Goa between Dec 1 and Dec 5 for 3", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: "2026-12-05", travelers: 3, runs: true),
    .init(text: "flight from delhi to goa dec 1 business class for 2", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: nil, travelers: 2, runs: true),
    .init(text: "flights from Delhi to Goa December 1 2026 to December 5 2026", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: "2026-12-05", travelers: nil, runs: true),
    .init(text: "fly me and Priya from Delhi to Goa on Dec 1", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: nil, travelers: 2, runs: true),
    .init(text: "flight from Delhi to Goa Oct 10", origin: "DEL", destination: "GOI", depart: "2027-10-10", ret: nil, travelers: nil, runs: true),
    .init(text: "flights from Delhi to Goa for 4 nights from Dec 1", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: "2026-12-05", travelers: nil, runs: true),
    .init(text: "Flights LHR to JFK on the 3rd of January, family of four", origin: "LHR", destination: "JFK", depart: "2027-01-03", ret: nil, travelers: 4, runs: true),
    .init(text: "Delhi to Goa Dec 1-5 for 3", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: "2026-12-05", travelers: 3, runs: true),
    .init(text: "book a trip from Mumbai to Bali from 20th to 27th Dec for 2 of us", origin: "BOM", destination: "DPS", depart: "2026-12-20", ret: "2026-12-27", travelers: 2, runs: true),
    // Recognised but incomplete or invalid: open Plan Trip prefilled, never run.
    .init(text: "fly to goa dec 1", origin: nil, destination: "GOI", depart: "2026-12-01", ret: nil, travelers: nil, runs: false),
    .init(text: "book a flight from delhi to goa", origin: "DEL", destination: "GOI", depart: nil, ret: nil, travelers: nil, runs: false),
    .init(text: "flight from delhi to delhi dec 1", origin: "DEL", destination: "DEL", depart: "2026-12-01", ret: nil, travelers: nil, runs: false),
    .init(text: "flight from delhi to goa for 6 people dec 1", origin: "DEL", destination: "GOI", depart: "2026-12-01", ret: nil, travelers: 6, runs: false),
    .init(text: "flights from Delhi to Goa Feb 30", origin: "DEL", destination: "GOI", depart: nil, ret: nil, travelers: nil, runs: false),
    .init(text: "fly from Delhi to Goa today", origin: "DEL", destination: "GOI", depart: "2026-10-16", ret: nil, travelers: nil, runs: false),
]

private struct GiftCase {
    let text: String
    let query: String
    let maxPrice: String
    let specific: Bool
}

private let giftCases: [GiftCase] = [
    .init(text: "Find a gift for car lovers under $40", query: "gift for car lovers", maxPrice: "40", specific: true),
    .init(text: "buy a birthday present for Sam, budget 30 dollars", query: "birthday present for sam", maxPrice: "30", specific: true),
    .init(text: "get us a gift", query: "gift", maxPrice: "50", specific: false),
    .init(text: "christmas gifts for mom below 25", query: "christmas gifts for mom", maxPrice: "25", specific: true),
]

private let notCommands = ["what's our balance?", "send 5 to Priya", "who hasn't joined yet", "add test money",
                           "send 3 to Goa fund on Dec 1"]

/// The rows the report prints; also returned so failures are easy to read.
func runParserChecks(check: (Bool, String) -> Void) {
    print("\n| # | phrase | origin | dest | depart | return | pax | runs |")
    print("|---|---|---|---|---|---|---|---|")
    for (i, c) in flightCases.enumerated() {
        let parsed = QuickParser.parse(c.text, today: today, calendar: utc)
        guard case .flight(let d)? = parsed else {
            check(false, "flight phrase not recognised: \(c.text)")
            continue
        }
        let runs = d.plan(defaultTravelers: 2, today: todayString) != nil
        print("| \(i + 1) | \(c.text) | \(d.origin ?? "—") | \(d.destination ?? "—") | \(d.departureDate ?? "—") | \(d.returnDate ?? "—") | \(d.travelers.map(String.init) ?? "—") | \(runs ? "yes" : "no") |")
        let ok = d.origin == c.origin && d.destination == c.destination && d.departureDate == c.depart
            && d.returnDate == c.ret && d.travelers == c.travelers && runs == c.runs
        check(ok, "flight: \(c.text)" + (ok ? "" : "  got \(d)"))
    }
    for c in giftCases {
        guard case .gift(let g)? = QuickParser.parse(c.text, today: today, calendar: utc) else {
            check(false, "gift phrase not recognised: \(c.text)")
            continue
        }
        let ok = g.query == c.query && g.maxPrice == c.maxPrice && g.specific == c.specific
        check(ok, "gift: \(c.text)" + (ok ? "" : "  got \(g)"))
    }
    for t in notCommands {
        check(QuickParser.parse(t, today: today, calendar: utc) == nil, "not a search: \(t)")
    }
    check(QuickParser.parse("Dec 1 flight from Delhi to Goa", today: today, calendar: utc).map {
        if case .flight(let d) = $0 { return d.cabin == nil && d.departureDate == "2026-12-01" } else { return false }
    } ?? false, "date before the route")
    check(QuickParser.cabin(QuickParser.normalize("flight in Business class")) == "business", "cabin")

    // Wording
    check(TripFormat.range("2026-12-01", "2026-12-05") == "Dec 1–5", "range same month")
    check(TripFormat.range("2026-12-28", "2027-01-03") == "Dec 28 – Jan 3", "range across months")
    check(TripFormat.range("2026-12-01", nil) == "Dec 1", "one-way range")
    check(TripFormat.day("2026-12-01", weekday: true) == "Tue, Dec 1", "weekday")
    let plan = FlightPlan(origin: "DEL", destination: "GOI", departureDate: "2026-12-01", returnDate: "2026-12-05",
                          travelers: 3, originLabel: "Delhi", destinationLabel: "Goa", cabin: nil)
    check(TripFormat.summary(plan) == "DEL → GOI · Dec 1–5 · 3 travellers", "searching summary")

    // Decoding: older servers omit the new fields.
    let decoder = JSONDecoder()
    func reply(_ json: String) -> AskReply? { try? decoder.decode(AskReply.self, from: Data(json.utf8)) }
    let old = reply(#"{"reply":"Here are flights","action":{"kind":"FLIGHT_SEARCH","origin":"DEL","destination":"GOI","departureDate":"2026-12-01","travelers":3}}"#)
    if case .flightSearch(let f)?? = old?.action {
        check(!f.autoRun && f.returnDate == nil && f.originLabel == nil, "old FLIGHT_SEARCH decodes with autoRun false")
    } else { check(false, "old FLIGHT_SEARCH decodes") }
    let new = reply(#"{"reply":"Searching","action":{"kind":"FLIGHT_SEARCH","origin":"DEL","destination":"GOI","departureDate":"2026-12-01","returnDate":"2026-12-05","travelers":3,"originLabel":"Delhi","destinationLabel":"Goa","cabin":null,"autoRun":true}}"#)
    if case .flightSearch(let f)?? = new?.action {
        check(f.autoRun && f.returnDate == "2026-12-05" && f.destinationLabel == "Goa" && f.cabin == nil, "new FLIGHT_SEARCH fields")
    } else { check(false, "new FLIGHT_SEARCH decodes") }
    let nullReturn = reply(#"{"reply":"ok","action":{"kind":"FLIGHT_SEARCH","origin":"DEL","destination":"GOI","departureDate":"2026-12-01","returnDate":null,"travelers":1,"autoRun":false}}"#)
    if case .flightSearch(let f)?? = nullReturn?.action { check(f.returnDate == nil, "null returnDate") } else { check(false, "null returnDate decodes") }
    let gift = reply(#"{"reply":"ok","action":{"kind":"GIFT_SEARCH","query":"car gifts","maxPrice":"40","autoRun":true}}"#)
    check(gift?.action == .giftSearch(query: "car gifts", maxPrice: "40", autoRun: true), "GIFT_SEARCH autoRun")
    let oldGift = reply(#"{"reply":"ok","action":{"kind":"GIFT_SEARCH","query":"car gifts","maxPrice":"40"}}"#)
    check(oldGift?.action == .giftSearch(query: "car gifts", maxPrice: "40", autoRun: false), "old GIFT_SEARCH")
    check(reply(#"{"reply":"Hi","action":null}"#)?.action == nil, "null action")
    check(reply(#"{"reply":"ok","action":{"kind":"TEST_MONEY"}}"#)?.action == .testMoney, "TEST_MONEY")

    let tripJSON = #"{"tripId":"trp_0123456789abcdef","kind":"FLIGHT","title":"DEL → GOI","origin":"DEL","destination":"GOI","departureDate":"2026-12-01","returnDate":"2026-12-05","travelers":3,"state":"VOTING","options":[{"optionId":"a1","title":"Duffel Airways","detail":"DEL → GOI · nonstop","total":"254.30","currency":"USD","refundable":false,"votes":2,"legs":[{"origin":"DEL","destination":"GOI","departAt":"2026-12-01T07:10:00"},{"origin":"GOI","destination":"DEL","departAt":"2026-12-05T18:40:00","stops":1}]},{"optionId":"b2","title":"Duffel Airways","detail":"DEL → GOI","total":"301.00","currency":"USD","refundable":true,"votes":0,"legs":"unexpected"}],"voteCount":2,"leading":"a1","myVote":null,"chosen":null,"payment":null,"booking":null,"error":null,"label":"Duffel test mode","payTo":null}"#
    let trip = try? decoder.decode(TripView.self, from: Data(tripJSON.utf8))
    check(trip?.returnDate == "2026-12-05" && trip?.options.first?.legs?.count == 2, "trip with return legs decodes")
    check(trip?.options.last?.legs == nil, "malformed legs are ignored, not fatal")
    let oldTrip = tripJSON.replacingOccurrences(of: #""returnDate":"2026-12-05","#, with: "")
    check((try? decoder.decode(TripView.self, from: Data(oldTrip.utf8)))?.returnDate == nil, "trip without returnDate")

    // The trip request carries returnDate only when there is one.
    check(FundClient.tripBody(key: "k", plan: plan)["returnDate"] as? String == "2026-12-05", "trip body returnDate")
    var oneWay = plan
    oneWay.returnDate = nil
    check(FundClient.tripBody(key: "k", plan: oneWay)["returnDate"] == nil, "one-way body has no returnDate")

    // What a command does.
    let text = "book a flight from Delhi to Goa Dec 1-5 for 3"
    let local = QuickParser.parse(text, today: today, calendar: utc)
    func resolve(_ r: AskReply?, _ l: QuickIntent?) -> CommandOutcome {
        CommandResolver.resolve(reply: r, local: l, defaultTravelers: 2, today: todayString)
    }
    if case .runFlight(let p) = resolve(new, nil) {
        check(p.returnDate == "2026-12-05" && p.travelers == 3, "server autoRun runs the server's plan")
    } else { check(false, "server autoRun runs") }
    if case .runFlight(let p) = resolve(old, local) {
        check(p.returnDate == "2026-12-05", "old server + same local reading runs, with the local return date")
    } else { check(false, "old server + local agreement runs") }
    if case .suggestFlight = resolve(old, nil) { check(true, "old server alone suggests (one tap)") } else { check(false, "old server alone suggests") }
    if case .runFlight(let p) = resolve(reply(#"{"reply":"Sure","action":null}"#), local) {
        check(p.origin == "DEL" && p.destination == "GOI", "no server action: local parse runs")
    } else { check(false, "no server action: local parse runs") }
    if case .runFlight = resolve(nil, local) { check(true, "server unreachable: local parse runs") } else { check(false, "server unreachable: local parse runs") }
    if case .completeFlight(let d) = resolve(nil, QuickParser.parse("fly to goa dec 1", today: today, calendar: utc)) {
        check(d.destination == "GOI" && d.origin == nil, "incomplete flight opens Plan Trip prefilled")
    } else { check(false, "incomplete flight opens Plan Trip") }
    let past = reply(#"{"reply":"ok","action":{"kind":"FLIGHT_SEARCH","origin":"DEL","destination":"GOI","departureDate":"2026-01-01","travelers":3,"autoRun":true}}"#)
    if case .completeFlight = resolve(past, nil) { check(true, "invalid server date never auto-runs") } else { check(false, "invalid server date never auto-runs") }
    let send = reply(#"{"reply":"ok","action":{"kind":"SEND","recipientId":"r1","recipient":"Priya","amount":"5"}}"#)
    check(resolve(send, local) == .send(recipientId: "r1", recipient: "Priya", amount: "5"), "SEND never auto-runs")
    check(resolve(gift, nil) == .runGift(query: "car gifts", maxPrice: "40"), "gift autoRun")
    check(resolve(oldGift, nil) == .suggestGift(query: "car gifts", maxPrice: "40"), "old gift suggests")
    check(resolve(reply(#"{"reply":"Your balance is 12 AUSD","action":null}"#), nil) == .answer, "plain answer")

    // Business commands open their screen on the device; they never reach Ask Synq.
    check(BusinessParser.parse("invoice Priya 120 for the logo") == .invoice(payer: "Priya", amount: "120", description: "logo"),
          "invoice Priya 120 for the logo")
    check(BusinessParser.parse("Send an invoice to Priya for 120 USDC for the logo design")
          == .invoice(payer: "Priya", amount: "120", description: "logo design"), "send an invoice to … for … USDC")
    check(BusinessParser.parse("bill Arjun $45.50 for coffee beans") == .invoice(payer: "Arjun", amount: "45.50", description: "coffee beans"),
          "bill with dollar sign")
    check(BusinessParser.parse("invoice 300 to Kite Studio for the website") == .invoice(payer: "Kite Studio", amount: "300", description: "website"),
          "invoice amount first")
    check(BusinessParser.parse("split 1500") == .split(amount: "1500"), "split 1500")
    check(BusinessParser.parse("Split income of $1,500 USDC") == .split(amount: "1500"), "split income with comma")
    check(BusinessParser.parse("ask CFO and risk whether to pay Sarah") == .team(question: "ask CFO and risk whether to pay Sarah"),
          "ask CFO and risk")
    check(BusinessParser.parse("what does my finance team think about paying Bob 40?") != nil, "finance team question")
    check(BusinessParser.parse("draft a deal: logo for Sarah, 300 USDC total, 150 when concepts are delivered")
          == .deal(text: "logo for Sarah, 300 USDC total, 150 when concepts are delivered"), "draft a deal strips the command")
    check(BusinessParser.parse("Please set up a deal room with Sarah for the app") != nil, "set up a deal room")
    check(BusinessParser.parse("show treasury") == .treasury, "treasury")
    // Flights, gifts and payments still go the old way.
    for t in ["book a flight from Delhi to Goa Dec 1-5 for 3", "find a gift for car lovers under $40", "Send 5 to Priya",
              "split the cost of a gift", "flights to Split dec 3", "what's our balance?"] {
        check(BusinessParser.parse(t) == nil, "not a business command: \(t)")
    }
    check(QuickParser.parse("book a flight from Delhi to Goa Dec 1-5 for 3", today: today, calendar: utc) != nil, "flight still parses")

    // Business payloads decode, and failures stay honest.
    func biz<T: Decodable>(_ json: String, _ status: Int, _ t: T.Type) -> Result<T, BusinessError> {
        do { return .success(try BusinessClient.decode(Data(json.utf8), status: status, as: t)) }
        catch let e as BusinessError { return .failure(e) } catch { return .failure(.unreachable) }
    }
    if case .failure(.notEnabled(let m)) = biz("<html>", 404, BusinessCapabilities.self) {
        check(m == BusinessAvailability.notOnServer, "old server (404) reads as not enabled")
    } else { check(false, "404 is not enabled") }
    if case .failure(.notEnabled(let m)) = biz(#"{"error":"NOT_ENABLED","message":"Invoices need SYNQ_PAY_LINK_KEY on the server."}"#, 503, BusinessInvoice.self) {
        check(m.contains("SYNQ_PAY_LINK_KEY"), "503 NOT_ENABLED keeps the server's reason")
    } else { check(false, "503 is not enabled") }
    if case .failure(.api(let m)) = biz(#"{"error":"FORBIDDEN","message":"This link is not valid for the fund."}"#, 403, TeamResult.self) {
        check(m == "This link is not valid for the fund.", "403 message")
    } else { check(false, "403 is an api error") }
    let capsJSON = #"{"network":"Arc testnet","chainId":5042002,"business":"Synq demo business","features":{"deals":{"enabled":true,"reason":null},"invoices":{"enabled":false,"reason":"Invoices need SYNQ_PAY_LINK_KEY on the server."}}}"#
    if case .success(let caps) = biz(capsJSON, 200, BusinessCapabilities.self) {
        check(caps.feature(.deals)?.enabled == true && caps.feature(.invoices)?.enabled == false && caps.feature(.team) == nil,
              "capabilities decode per feature")
    } else { check(false, "capabilities decode") }
    let draftInvoice = #"{"invoiceId":"inv_1","number":"SYNQ-0F3A9C","status":"DRAFT","payer":"Priya","description":"Logo","total":"120.00","symbol":"USDC","dueDate":"2026-10-30","issuer":"Synq demo business","payTo":"0x4444444444444444444444444444444444444444","issueUrl":"https://synq.example/invoice/inv_1?t=abc","payUrl":"https://synq.example/pay/inv_1.1.1790000000.mac0123456789","network":"Arc testnet"}"#
    if case .success(let inv) = biz(draftInvoice, 200, BusinessInvoice.self) {
        check(inv.payURL == nil && inv.issueURL != nil, "a draft invoice never offers a checkout link")
        check(InvoiceLink.messageURL(for: inv, allowedHost: "synq.example") == nil, "a draft cannot be shared as a card")
    } else { check(false, "draft invoice decodes") }
    let issued = draftInvoice.replacingOccurrences(of: #""status":"DRAFT""#, with: #""status":"ISSUED""#)
    if case .success(let inv) = biz(issued, 200, BusinessInvoice.self),
       let url = InvoiceLink.messageURL(for: inv, allowedHost: "synq.example"),
       let link = InvoiceLink(url: url, allowedHost: "synq.example") {
        check(link.token == "inv_1.1.1790000000.mac0123456789" && link.amount == "120.00" && link.payer == "Priya",
              "issued invoice shares a checkout card with hints")
        check(link.checkoutURL.absoluteString == "https://synq.example/pay/inv_1.1.1790000000.mac0123456789",
              "checkout URL drops the hints")
        check(InvoiceLink(url: url, allowedHost: "evil.example") == nil, "invoice card for another host refused")
    } else { check(false, "issued invoice shares a card") }
    let teamJSON = #"{"status":"ANSWERED","runId":"r1","sections":[{"persona":"RISK","label":"Risk","stance":"VETO","text":"New wallet","evidence":["a"]},{"persona":"CFO","label":"CFO","stance":"PAY","text":"Cash is fine","evidence":[]},{"persona":"DECISION","label":"Decision (Kernel)","stance":"PAY","text":"Decision (Kernel): ALLOW","evidence":[]}],"decision":{"status":"NOT_SUBMITTED","outcome":null,"reasons":["no active mandate"]},"riskCase":null,"unavailable":[],"approvalUrl":null,"answer":"x","readOnly":true}"#
    if case .success(let team) = biz(teamJSON, 200, TeamResult.self) {
        check(team.specialists.map(\.persona) == ["CFO", "RISK"], "specialists in order, decision section excluded")
        check(team.decision.headline == "Not submitted to the Kernel", "decision headline from structured status only")
        check(team.approvalURL == nil, "no approval link unless the Kernel proposed one")
    } else { check(false, "team result decodes") }

    // Network labels stay truthful.
    check(SynqNetwork.label(chainId: 10143) == "Monad testnet", "Monad chain id")
    check(SynqNetwork.label(explorer: "https://testnet.monadexplorer.com/tx/0x1") == "Monad testnet", "Monad explorer")
}
