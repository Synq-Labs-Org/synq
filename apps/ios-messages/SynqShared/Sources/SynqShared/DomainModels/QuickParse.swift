import Foundation

// On-device understanding of plain instructions typed into the Synq command bar,
// e.g. "book a flight from Delhi to Goa Dec 1–5 for 3". The server's Ask Synq is
// the primary interpreter; this is the fallback when it returns no action (or is
// unreachable) so a clear flight or gift instruction still runs without extra taps.
// Foundation only: it is unit-tested on macOS by Checks/ParserChecks.swift.

/// A complete, valid flight search the group can run.
public struct FlightPlan: Codable, Equatable {
    public var origin: String
    public var destination: String
    public var departureDate: String
    public var returnDate: String?
    public var travelers: Int
    public var originLabel: String?
    public var destinationLabel: String?
    public var cabin: String?

    public static let iata = "^[A-Z]{3}$"
    public static let day = "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"

    /// The same rules the server applies to `POST /funds/:id/trips`.
    public func isValid(today: String) -> Bool {
        guard origin.range(of: Self.iata, options: .regularExpression) != nil,
              destination.range(of: Self.iata, options: .regularExpression) != nil,
              origin != destination,
              departureDate.range(of: Self.day, options: .regularExpression) != nil,
              departureDate > today,
              (1...4).contains(travelers)
        else { return false }
        if let r = returnDate {
            return r.range(of: Self.day, options: .regularExpression) != nil && r >= departureDate
        }
        return true
    }
}

/// What the parser understood; anything missing is nil.
public struct FlightDraft: Equatable {
    public var origin: String?
    public var destination: String?
    public var originLabel: String?
    public var destinationLabel: String?
    public var departureDate: String?
    public var returnDate: String?
    public var travelers: Int?
    public var cabin: String?

    public init(origin: String? = nil, destination: String? = nil, originLabel: String? = nil,
                destinationLabel: String? = nil, departureDate: String? = nil, returnDate: String? = nil,
                travelers: Int? = nil, cabin: String? = nil) {
        self.origin = origin
        self.destination = destination
        self.originLabel = originLabel
        self.destinationLabel = destinationLabel
        self.departureDate = departureDate
        self.returnDate = returnDate
        self.travelers = travelers
        self.cabin = cabin
    }

    public func plan(defaultTravelers: Int, today: String) -> FlightPlan? {
        guard let origin, let destination, let departureDate else { return nil }
        let p = FlightPlan(origin: origin, destination: destination, departureDate: departureDate,
                           returnDate: returnDate, travelers: travelers ?? max(1, min(4, defaultTravelers)),
                           originLabel: originLabel, destinationLabel: destinationLabel, cabin: cabin)
        return p.isValid(today: today) ? p : nil
    }
}

public struct GiftDraft: Equatable {
    public var query: String
    public var maxPrice: String
    /// True when the instruction names what to look for, not just "a gift".
    public var specific: Bool
}

public enum QuickIntent: Equatable {
    case flight(FlightDraft)
    case gift(GiftDraft)
}

// MARK: - Airports

/// A vetted city → airport table. Ambiguous English words (Nice, Split, Reading,
/// Male) are deliberately left out; three-letter codes are accepted directly.
public enum Airports {
    public static let cities: [String: String] = [
        // India
        "delhi": "DEL", "new delhi": "DEL", "mumbai": "BOM", "bombay": "BOM", "bangalore": "BLR",
        "bengaluru": "BLR", "chennai": "MAA", "madras": "MAA", "kolkata": "CCU", "calcutta": "CCU",
        "hyderabad": "HYD", "goa": "GOI", "pune": "PNQ", "ahmedabad": "AMD", "jaipur": "JAI",
        "kochi": "COK", "cochin": "COK", "lucknow": "LKO", "chandigarh": "IXC", "amritsar": "ATQ",
        "varanasi": "VNS", "srinagar": "SXR", "leh": "IXL", "udaipur": "UDR", "trivandrum": "TRV",
        "thiruvananthapuram": "TRV", "bhubaneswar": "BBI", "guwahati": "GAU", "indore": "IDR",
        "coimbatore": "CJB", "mangalore": "IXE", "mangaluru": "IXE", "port blair": "IXZ",
        "bagdogra": "IXB", "dehradun": "DED", "patna": "PAT", "nagpur": "NAG",
        "visakhapatnam": "VTZ", "vizag": "VTZ",
        // Asia and the Middle East
        "dubai": "DXB", "abu dhabi": "AUH", "doha": "DOH", "singapore": "SIN", "bangkok": "BKK",
        "phuket": "HKT", "bali": "DPS", "denpasar": "DPS", "kuala lumpur": "KUL", "hong kong": "HKG",
        "tokyo": "HND", "osaka": "KIX", "seoul": "ICN", "kathmandu": "KTM", "colombo": "CMB",
        "maldives": "MLE", "manila": "MNL", "jakarta": "CGK", "hanoi": "HAN",
        "ho chi minh city": "SGN", "saigon": "SGN", "taipei": "TPE", "shanghai": "PVG",
        "beijing": "PEK", "istanbul": "IST", "riyadh": "RUH", "muscat": "MCT",
        // Europe
        "london": "LHR", "paris": "CDG", "amsterdam": "AMS", "frankfurt": "FRA", "munich": "MUC",
        "berlin": "BER", "madrid": "MAD", "barcelona": "BCN", "rome": "FCO", "milan": "MXP",
        "lisbon": "LIS", "porto": "OPO", "zurich": "ZRH", "geneva": "GVA", "vienna": "VIE",
        "prague": "PRG", "athens": "ATH", "dublin": "DUB", "edinburgh": "EDI", "manchester": "MAN",
        "copenhagen": "CPH", "stockholm": "ARN", "oslo": "OSL", "helsinki": "HEL",
        "brussels": "BRU", "budapest": "BUD", "warsaw": "WAW", "reykjavik": "KEF",
        // Americas, Africa, Oceania
        "new york": "JFK", "nyc": "JFK", "los angeles": "LAX", "san francisco": "SFO",
        "chicago": "ORD", "boston": "BOS", "seattle": "SEA", "miami": "MIA", "las vegas": "LAS",
        "washington": "IAD", "austin": "AUS", "denver": "DEN", "atlanta": "ATL", "dallas": "DFW",
        "toronto": "YYZ", "vancouver": "YVR", "montreal": "YUL", "mexico city": "MEX",
        "cancun": "CUN", "sao paulo": "GRU", "rio de janeiro": "GIG", "buenos aires": "EZE",
        "cairo": "CAI", "cape town": "CPT", "johannesburg": "JNB", "nairobi": "NBO",
        "marrakech": "RAK", "sydney": "SYD", "melbourne": "MEL", "auckland": "AKL",
    ]

    public static let codes: Set<String> = Set(cities.values)

    /// A readable city for a code, e.g. GOI → Goa.
    public static func label(for code: String) -> String? {
        let preferred: [String: String] = ["DEL": "Delhi", "BOM": "Mumbai", "BLR": "Bengaluru",
                                           "MAA": "Chennai", "CCU": "Kolkata", "COK": "Kochi",
                                           "TRV": "Thiruvananthapuram", "IXE": "Mangaluru",
                                           "VTZ": "Visakhapatnam", "JFK": "New York", "DPS": "Bali",
                                           "SGN": "Ho Chi Minh City"]
        if let p = preferred[code] { return p }
        guard let name = cities.filter({ $0.value == code }).keys.sorted().first else { return nil }
        return name.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }
}

// MARK: - Parser

public enum QuickParser {
    private static let flightWords: Set<String> = ["flight", "flights", "fly", "flying", "plane", "airfare",
                                                   "airfares", "ticket", "tickets", "fare", "fares"]
    private static let giftWords: Set<String> = ["gift", "gifts", "present", "presents"]
    private static let numberWords: [String: Int] = ["a": 1, "an": 1, "one": 1, "two": 2, "three": 3,
                                                     "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
                                                     "nine": 9, "ten": 10]
    private static let months: [String: Int] = [
        "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
        "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
        "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
    ]
    private static let weekdays: [String: Int] = ["sunday": 1, "monday": 2, "tuesday": 3, "wednesday": 4,
                                                  "thursday": 5, "friday": 6, "saturday": 7]

    public static func parse(_ text: String, today: Date = Date(), calendar: Calendar = .current) -> QuickIntent? {
        let s = normalize(text)
        let words = s.split(separator: " ").map(String.init)
        guard !words.isEmpty else { return nil }
        let mentions = cityMentions(original: text, words: words)
        let hasFlightWord = words.contains { flightWords.contains($0) }
        let hasGiftWord = words.contains { giftWords.contains($0) }
        let routed = mentions.contains { $0.marker == "from" } && mentions.contains { $0.marker == "to" }
            || mentions.count >= 2 && (words.contains("to") || words.contains("-"))
        if hasGiftWord && !hasFlightWord {
            return .gift(gift(s))
        }
        var cal = calendar
        cal.locale = Locale(identifier: "en_US_POSIX")
        let (dep, ret) = dates(in: s, today: today, cal: cal)
        // A route between two known cities plus a date reads as a flight even without the word.
        guard hasFlightWord || (routed && (dep != nil || words.contains("book") || words.contains("trip")))
        else { return nil }
        var draft = FlightDraft()
        assignRoute(mentions, into: &draft)
        draft.departureDate = dep.map { day($0, cal) }
        draft.returnDate = ret.map { day($0, cal) }
        draft.travelers = travelers(s)
        draft.cabin = cabin(s)
        return .flight(draft)
    }

    /// "yyyy-MM-dd" for today in the given calendar (server compares day strings).
    public static func today(_ date: Date = Date(), calendar: Calendar = .current) -> String {
        day(date, calendar)
    }

    public static func day(_ date: Date, _ cal: Calendar) -> String {
        let c = cal.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Lowercase words; arrows become "to", dashes between things become " - ".
    public static func normalize(_ text: String) -> String {
        var s = text.lowercased()
        for arrow in ["→", "->", "⟶", "➝", "✈"] { s = s.replacingOccurrences(of: arrow, with: " to ") }
        for dash in ["–", "—", "‒", "-"] { s = s.replacingOccurrences(of: dash, with: " - ") }
        s = s.replacingOccurrences(of: "$", with: " $ ")
        s = s.replacingOccurrences(of: "’", with: "'").replacingOccurrences(of: "'s ", with: "s ")
        let kept = s.unicodeScalars.map { scalar -> Character in
            if CharacterSet.alphanumerics.contains(scalar) || scalar == "$" || scalar == "-" { return Character(scalar) }
            return " "
        }
        s = String(kept)
        // Re-join ISO dates the dash split apart: "2026 - 11 - 20" -> "2026-11-20".
        s = s.replacingOccurrences(of: "([0-9]{4}) - ([0-9]{2}) - ([0-9]{2})", with: "$1-$2-$3",
                                   options: .regularExpression)
        return s.split(separator: " ").joined(separator: " ")
    }

    // MARK: Route

    public struct Mention: Equatable {
        public let code: String
        public let label: String
        public let index: Int
        public let marker: String?   // "from" or "to" when introduced by one
    }

    public static func cityMentions(original: String, words: [String]) -> [Mention] {
        let upperCodes = Set(original.split(whereSeparator: { !$0.isLetter }).map(String.init)
            .filter { $0.count == 3 && $0 == $0.uppercased() })
        var out: [Mention] = []
        var i = 0
        while i < words.count {
            var matched = false
            for len in stride(from: 4, through: 1, by: -1) where i + len <= words.count {
                let phrase = words[i..<(i + len)].joined(separator: " ")
                if let code = Airports.cities[phrase] {
                    out.append(Mention(code: code, label: Airports.label(for: code) ?? phrase.capitalized,
                                       index: i, marker: marker(words, before: i)))
                    i += len
                    matched = true
                    break
                }
            }
            if matched { continue }
            let w = words[i]
            let m = marker(words, before: i)
            if w.count == 3, w.allSatisfy(\.isLetter),
               upperCodes.contains(w.uppercased()) || (m != nil && Airports.codes.contains(w.uppercased())) {
                let code = w.uppercased()
                out.append(Mention(code: code, label: Airports.label(for: code) ?? code, index: i, marker: m))
            }
            i += 1
        }
        return out
    }

    private static func marker(_ words: [String], before i: Int) -> String? {
        guard i > 0 else { return nil }
        switch words[i - 1] {
        case "from", "leaving", "departing", "ex": return "from"
        case "to", "into", "towards", "for", "-", "and": return "to"
        default: return nil
        }
    }

    private static func assignRoute(_ mentions: [Mention], into d: inout FlightDraft) {
        var origin = mentions.first { $0.marker == "from" }
        var destination = mentions.first { $0.marker == "to" && $0 != origin }
        if origin == nil, destination == nil, mentions.count >= 2 {
            origin = mentions[0]
            destination = mentions[1]
        } else if origin == nil, let dest = destination {
            // "Delhi to Goa": the city right before the destination is the origin.
            origin = mentions.last { $0.index < dest.index && $0 != dest }
        } else if destination == nil, let o = origin {
            destination = mentions.first { $0 != o && $0.index > o.index }
        }
        if mentions.count == 1, origin == nil, destination == nil { destination = mentions[0] }
        d.origin = origin?.code
        d.originLabel = origin?.label
        d.destination = destination?.code
        d.destinationLabel = destination?.label
    }

    // MARK: Dates

    private struct DateMention {
        let location: Int
        let end: Int
        let date: Date
        var rangeEnd: Date?
        var isReturn = false
    }

    private static let dayRx = "([0-9]{1,2})(?:st|nd|rd|th)?"
    private static let monthRx = "(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)"
    private static let joinRx = "(?:-|to|until|till|through|thru|and)"
    private static let yearRx = "(?: (20[0-9]{2}))?"

    private static func dates(in s: String, today: Date, cal: Calendar) -> (Date?, Date?) {
        let start = cal.startOfDay(for: today)
        var found: [DateMention] = []
        func claim(_ loc: Int, _ end: Int) -> Bool {
            !found.contains { $0.location < end && loc < $0.end }
        }
        func add(_ m: DateMention) { if claim(m.location, m.end) { found.append(m) } }

        for m in matches("\\b([0-9]{4})-([0-9]{2})-([0-9]{2})\\b", s) {
            if let d = make(Int(m.g[0]!), Int(m.g[1]!)!, Int(m.g[2]!)!, start, cal) {
                add(DateMention(location: m.loc, end: m.end, date: d))
            }
        }
        // "dec 1 - 5", "december 1st to jan 3rd", "dec 1 2026 to dec 5 2026"
        for m in matches("\\b\(monthRx) \(dayRx)\(yearRx) \(joinRx) (?:the )?(?:\(monthRx) )?\(dayRx)\(yearRx)\\b", s) {
            guard let m1 = months[m.g[0]!], let d1 = Int(m.g[1]!),
                  let from = make(m.g[2].flatMap { Int($0) }, m1, d1, start, cal) else { continue }
            let m2 = m.g[3].flatMap { months[$0] } ?? m1
            guard let d2 = Int(m.g[4]!), let to = make(m.g[5].flatMap { Int($0) }, m2, d2, from, cal) else { continue }
            add(DateMention(location: m.loc, end: m.end, date: from, rangeEnd: to))
        }
        // "1 - 5 dec", "1st to 5th december", "28 dec to 3 jan"
        for m in matches("\\b\(dayRx) (?:of )?(?:\(monthRx) )?\(joinRx) (?:the )?\(dayRx) (?:of )?\(monthRx)\(yearRx)\\b", s) {
            guard let d1 = Int(m.g[0]!), let d2 = Int(m.g[2]!), let m2 = months[m.g[3]!] else { continue }
            let m1 = m.g[1].flatMap { months[$0] } ?? m2
            let year = m.g[4].flatMap { Int($0) }
            guard let from = make(year, m1, d1, start, cal), let to = make(year, m2, d2, from, cal) else { continue }
            add(DateMention(location: m.loc, end: m.end, date: from, rangeEnd: to))
        }
        for m in matches("\\b\(monthRx) (?:the )?\(dayRx)\(yearRx)\\b", s) {
            guard let mo = months[m.g[0]!], let d = Int(m.g[1]!),
                  let date = make(m.g[2].flatMap { Int($0) }, mo, d, start, cal) else { continue }
            add(DateMention(location: m.loc, end: m.end, date: date))
        }
        for m in matches("\\b\(dayRx) (?:of )?\(monthRx)\(yearRx)\\b", s) {
            guard let d = Int(m.g[0]!), let mo = months[m.g[1]!],
                  let date = make(m.g[2].flatMap { Int($0) }, mo, d, start, cal) else { continue }
            add(DateMention(location: m.loc, end: m.end, date: date))
        }
        for (phrase, offset) in [("day after tomorrow", 2), ("tomorrow", 1), ("today", 0), ("tonight", 0)] {
            for m in matches("\\b\(phrase)\\b", s) {
                if let d = cal.date(byAdding: .day, value: offset, to: start) {
                    add(DateMention(location: m.loc, end: m.end, date: d))
                }
            }
        }
        for m in matches("\\bin (\\d{1,2}|a|one|two|three|four|five|six|seven|eight|nine|ten) (day|days|week|weeks)\\b", s) {
            let n = Int(m.g[0]!) ?? numberWords[m.g[0]!] ?? 0
            let days = m.g[1]!.hasPrefix("week") ? n * 7 : n
            if let d = cal.date(byAdding: .day, value: days, to: start) {
                add(DateMention(location: m.loc, end: m.end, date: d))
            }
        }
        for m in matches("\\b(?:(next|this|coming|on) )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\b", s) {
            guard let target = weekdays[m.g[1]!] else { continue }
            add(DateMention(location: m.loc, end: m.end, date: weekday(target, next: m.g[0] == "next", after: start, cal)))
        }
        found.sort { $0.location < $1.location }

        // Mark dates introduced by a return word.
        let ns = s as NSString
        for i in found.indices {
            let from = max(0, found[i].location - 22)
            let before = ns.substring(with: NSRange(location: from, length: found[i].location - from))
            if before.range(of: "\\b(return|returning|back|until|till|coming back|come back|fly back)\\b( on)?( the)? ?$",
                            options: .regularExpression) != nil {
                found[i].isReturn = true
            }
        }
        guard let depMention = found.first(where: { !$0.isReturn }) ?? found.first else { return (nil, nil) }
        let dep = depMention.date
        var ret = depMention.rangeEnd
        if ret == nil, let r = found.first(where: { $0.isReturn && $0.location > depMention.location }) {
            ret = r.date < dep ? cal.date(byAdding: .day, value: 7, to: r.date) : r.date
        }
        if ret == nil,
           let next = found.first(where: { $0.location > depMention.end }) {
            let gap = ns.substring(with: NSRange(location: depMention.end, length: next.location - depMention.end))
                .trimmingCharacters(in: .whitespaces)
            if ["-", "to", "until", "till", "through", "thru", "and"].contains(gap) {
                ret = next.date
            }
        }
        // "returning on the 8th": a bare day after the departure.
        if ret == nil, let m = matches("\\b(?:return|returning|back) (?:on )?(?:the )?([0-9]{1,2})(?:st|nd|rd|th)\\b", s).first,
           let d = Int(m.g[0]!) {
            let c = cal.dateComponents([.year, .month], from: dep)
            if var r = make(c.year, c.month ?? 1, d, start, cal) {
                if r < dep, let bumped = cal.date(byAdding: .month, value: 1, to: r) { r = bumped }
                ret = r
            }
        }
        // "for a week", "for 4 nights", "for 5 days"
        if ret == nil, let m = matches("\\bfor (\\d{1,2}|a|one|two|three|four|five|six|seven|eight|nine|ten) (night|nights|day|days|week|weeks)\\b", s).first {
            let n = Int(m.g[0]!) ?? numberWords[m.g[0]!] ?? 0
            let unit = m.g[1]!
            let days = unit.hasPrefix("week") ? n * 7 : unit.hasPrefix("night") ? n : max(1, n - 1)
            ret = cal.date(byAdding: .day, value: days, to: dep)
        }
        if s.range(of: "\\bone ?- ?way\\b", options: .regularExpression) != nil { ret = nil }
        if let r = ret, r < dep { ret = nil }
        return (dep, ret)
    }

    /// A calendar day; without a year it is the next such day on or after `notBefore`.
    private static func make(_ year: Int?, _ month: Int, _ day: Int, _ notBefore: Date, _ cal: Calendar) -> Date? {
        guard (1...12).contains(month), (1...31).contains(day) else { return nil }
        let baseYear = cal.component(.year, from: notBefore)
        for y in year.map({ [$0] }) ?? [baseYear, baseYear + 1] {
            guard let d = cal.date(from: DateComponents(year: y, month: month, day: day)),
                  cal.component(.day, from: d) == day, cal.component(.month, from: d) == month
            else { return nil }
            if year != nil || d >= cal.startOfDay(for: notBefore) { return d }
        }
        return nil
    }

    /// The coming `target` weekday, strictly after today. "next X" skips to the
    /// following week when the coming X still falls in the current week.
    private static func weekday(_ target: Int, next: Bool, after start: Date, _ cal: Calendar) -> Date {
        let current = cal.component(.weekday, from: start)
        var ahead = (target - current + 7) % 7
        if ahead == 0 { ahead = 7 }
        if next {
            // Days left in this Monday-to-Sunday week, counting today.
            let daysToSunday = (8 - current) % 7
            if ahead <= daysToSunday { ahead += 7 }
        }
        return cal.date(byAdding: .day, value: ahead, to: start) ?? start
    }

    // MARK: Travellers, cabin

    public static func travelers(_ s: String) -> Int? {
        let n = "(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)"
        let nouns = "(?:people|persons|person|travellers|travelers|traveller|traveler|adults|adult|passengers|passenger|pax|tickets|ticket|seats|seat|of us|friends|guys)"
        if let m = matches("\\b\(n) \(nouns)\\b", s).first { return count(m.g[0]!) }
        if let m = matches("\\bfamily of \(n)\\b", s).first { return count(m.g[0]!) }
        for m in matches("\\bfor \(n)\\b( [a-z]+)?", s) {
            let next = m.g[1]?.trimmingCharacters(in: .whitespaces) ?? ""
            let notPeople = ["day", "days", "night", "nights", "week", "weeks", "hour", "hours", "dollars",
                             "usd", "bucks", "rupees", "inr"]
            if notPeople.contains(next) || months[next] != nil { continue }
            return count(m.g[0]!)
        }
        if s.range(of: "\\b(both of us|two of us|the two of us|a couple|me and [a-z]+|[a-z]+ and me|me and my [a-z]+)\\b",
                   options: .regularExpression) != nil { return 2 }
        if s.range(of: "\\b(for me|just me|only me|myself|solo|alone)\\b", options: .regularExpression) != nil { return 1 }
        return nil
    }

    private static func count(_ w: String) -> Int? { Int(w) ?? numberWords[w] }

    public static func cabin(_ s: String) -> String? {
        if s.contains("premium economy") { return "premium_economy" }
        if s.range(of: "\\bbusiness\\b", options: .regularExpression) != nil { return "business" }
        if s.range(of: "\\bfirst class\\b", options: .regularExpression) != nil { return "first" }
        if s.range(of: "\\beconomy\\b", options: .regularExpression) != nil { return "economy" }
        return nil
    }

    // MARK: Gifts

    public static func gift(_ s: String) -> GiftDraft {
        var budget: String?
        var q = " " + s + " "
        let patterns = [
            "\\b(?:under|below|less than|max|maximum|up to|upto|within|around|about|budget(?: of| is)?)? ?\\$ ?([0-9]{1,4})\\b(?: dollars| usd| bucks)?",
            "\\b(?:under|below|less than|max|maximum|up to|upto|within|around|about|budget(?: of| is)?) ([0-9]{1,4})\\b(?: dollars| usd| bucks| \\$)?",
            "\\b([0-9]{1,4}) (?:dollars|usd|bucks)\\b",
        ]
        for p in patterns {
            if let m = matches(p, q).first {
                budget = m.g[0]
                q = (q as NSString).replacingCharacters(in: NSRange(location: m.loc, length: m.end - m.loc), with: " ")
                break
            }
        }
        q = q.replacingOccurrences(of: "\\b(budget|price|max)\\b", with: " ", options: .regularExpression)
        let lead = "^ *(?:(?:hey|hi|synq|please|can you|could you|let s|lets|we want to|we need to|i want to|i need to|help me|us|me) )*(?:find|buy|get|search for|search|look for|looking for|shop for|order|pick|choose|suggest|show)? *(?:me |us )?(?:a |an |some |the )?"
        q = q.replacingOccurrences(of: lead, with: "", options: .regularExpression)
        q = q.replacingOccurrences(of: "\\b(for the group|for us|please|thanks)\\b", with: " ", options: .regularExpression)
        q = q.split(separator: " ").joined(separator: " ")
        if q.count > 80 { q = String(q.prefix(80)) }
        let words = q.split(separator: " ")
        let specific = words.count >= 2 && words.contains { giftWords.contains(String($0)) }
        let price = budget.flatMap { Int($0) }.map { String(max(1, min(500, $0))) } ?? "50"
        return GiftDraft(query: q, maxPrice: price, specific: specific)
    }

    // MARK: Regex helper

    public struct Match {
        public let loc: Int
        public let end: Int
        public let g: [String?]
    }

    public static func matches(_ pattern: String, _ s: String) -> [Match] {
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return [] }
        let ns = s as NSString
        return re.matches(in: s, range: NSRange(location: 0, length: ns.length)).map { r in
            let groups: [String?] = (1..<max(1, r.numberOfRanges)).map { i in
                let range = r.range(at: i)
                return range.location == NSNotFound ? nil : ns.substring(with: range)
            }
            return Match(loc: r.range.location, end: r.range.location + r.range.length, g: groups)
        }
    }
}

// MARK: - Deciding what a command does

/// What one command-bar submission leads to. Only searches ever run on their own;
/// sending money always opens the Send sheet and then the passkey page.
public enum CommandOutcome: Equatable {
    case runFlight(FlightPlan)
    case runGift(query: String, maxPrice: String)
    /// Complete but not confirmed as an instruction: one tap to search.
    case suggestFlight(FlightPlan)
    /// Recognisably a flight but something is missing: open Plan Trip prefilled.
    case completeFlight(FlightDraft)
    case suggestGift(query: String, maxPrice: String)
    case send(recipientId: String, recipient: String, amount: String)
    case testMoney
    case answer
}

public enum CommandResolver {
    /// - Parameters:
    ///   - reply: the server's Ask Synq answer, nil when it could not be reached.
    ///   - local: what the on-device parser made of the same text.
    public static func resolve(reply: AskReply?, local: QuickIntent?, defaultTravelers: Int, today: String) -> CommandOutcome {
        switch reply?.action {
        case .flightSearch(let f)?:
            let server = FlightPlan(origin: f.origin.uppercased(), destination: f.destination.uppercased(),
                                    departureDate: f.departureDate, returnDate: f.returnDate,
                                    travelers: f.travelers, originLabel: f.originLabel,
                                    destinationLabel: f.destinationLabel, cabin: f.cabin)
            var merged = server
            var localPlan: FlightPlan?
            if case .flight(let d)? = local { localPlan = d.plan(defaultTravelers: defaultTravelers, today: today) }
            if let lp = localPlan, lp.origin == server.origin, lp.destination == server.destination {
                if merged.returnDate == nil { merged.returnDate = lp.returnDate }
                if merged.originLabel == nil { merged.originLabel = lp.originLabel }
                if merged.destinationLabel == nil { merged.destinationLabel = lp.destinationLabel }
            }
            if !merged.isValid(today: today) {
                if merged.returnDate != nil {
                    var oneWay = merged
                    oneWay.returnDate = nil
                    if oneWay.isValid(today: today) { return .suggestFlight(oneWay) }
                }
                return .completeFlight(FlightDraft(origin: server.origin, destination: server.destination,
                                                   originLabel: server.originLabel,
                                                   destinationLabel: server.destinationLabel,
                                                   departureDate: nil, returnDate: nil,
                                                   travelers: (1...4).contains(server.travelers) ? server.travelers : nil,
                                                   cabin: server.cabin))
            }
            // Older servers never say autoRun; a clear instruction the device read the same way still runs.
            if f.autoRun || (localPlan.map { $0.origin == server.origin && $0.destination == server.destination } ?? false) {
                return .runFlight(merged)
            }
            return .suggestFlight(merged)
        case .giftSearch(let query, let maxPrice, let autoRun)?:
            if autoRun { return .runGift(query: query, maxPrice: maxPrice) }
            if case .gift(let g)? = local, g.specific { return .runGift(query: query, maxPrice: maxPrice) }
            return .suggestGift(query: query, maxPrice: maxPrice)
        case .send(let id, let name, let amount)?:
            return .send(recipientId: id, recipient: name, amount: amount)
        case .testMoney?:
            return .testMoney
        case nil:
            switch local {
            case .flight(let d)?:
                if let plan = d.plan(defaultTravelers: defaultTravelers, today: today) { return .runFlight(plan) }
                return .completeFlight(d)
            case .gift(let g)?:
                return g.specific ? .runGift(query: g.query, maxPrice: g.maxPrice)
                    : .suggestGift(query: g.query, maxPrice: g.maxPrice)
            case nil:
                return .answer
            }
        }
    }
}

// MARK: - Trip wording

public enum TripFormat {
    private static func date(_ s: String) -> Date? {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: s)
    }

    private static func format(_ d: Date, _ pattern: String) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = pattern
        return f.string(from: d)
    }

    /// "Dec 1", "Tue, Dec 1".
    public static func day(_ s: String?, weekday: Bool = false) -> String {
        guard let s, let d = date(s) else { return s ?? "" }
        return format(d, weekday ? "EEE, MMM d" : "MMM d")
    }

    /// "Dec 1–5", "Dec 28 – Jan 3", "Dec 1".
    public static func range(_ from: String?, _ to: String?) -> String {
        guard let from, let a = date(from) else { return "" }
        guard let to, let b = date(to), to != from else { return format(a, "MMM d") }
        if format(a, "MMM") == format(b, "MMM") { return "\(format(a, "MMM d"))–\(format(b, "d"))" }
        return "\(format(a, "MMM d")) – \(format(b, "MMM d"))"
    }

    /// "Dec 12, 10:24" (UTC) for a Unix time in seconds.
    public static func stamp(_ seconds: Int) -> String {
        format(Date(timeIntervalSince1970: TimeInterval(seconds)), "MMM d, HH:mm")
    }

    public static func travellers(_ n: Int) -> String { n == 1 ? "1 traveller" : "\(n) travellers" }

    /// "DEL → GOI · Dec 1–5 · 3 travellers"
    public static func summary(_ p: FlightPlan) -> String {
        "\(p.origin) → \(p.destination) · \(range(p.departureDate, p.returnDate)) · \(travellers(p.travelers))"
    }
}
