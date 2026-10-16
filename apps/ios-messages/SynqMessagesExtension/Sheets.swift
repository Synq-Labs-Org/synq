import SwiftUI

// Send, Plan Trip and Gift sheets in the dark theme. Send only prepares the
// payment: the Synq page confirms it with Face ID and members approve it there.

/// Header, backdrop and spacing shared by every sheet.
struct SheetScaffold<Content: View>: View {
    var title: String
    var symbol: String
    var accent: Color
    var onCancel: () -> Void
    @ViewBuilder var content: () -> Content

    var body: some View {
        SynqScreen(accent: accent, secondary: Theme.violet) {
            VStack(alignment: .leading, spacing: Theme.s4) {
                HStack(spacing: Theme.s3) {
                    IconTile(symbol: symbol, color: accent, size: 36)
                    Text(title).font(.synq(.title2, .bold)).foregroundStyle(Theme.text)
                    Spacer()
                    Button("Cancel", action: onCancel).buttonStyle(.glassCompact)
                }
                .padding(.top, Theme.s2)
                content()
            }
            .padding(Theme.s5)
            .synqScroll()
        }
        .presentationDetents([.large])
        .presentationBackground(Theme.ink)
    }
}

/// A labelled glass text field.
struct GlassField: View {
    var label: String
    @Binding var text: String
    var placeholder: String
    var keyboard: SynqKeyboard? = nil
    var trailing: String? = nil
    var large = false
    @Environment(\.synqRenderMode) private var mode

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label.uppercased())
                .font(.synq(.caption2, .bold))
                .tracking(0.8)
                .foregroundStyle(Theme.text3)
            HStack {
                if mode.isStill {
                    Text(text.isEmpty ? placeholder : text)
                        .foregroundStyle(text.isEmpty ? Theme.text3 : Theme.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    field
                }
                if let trailing {
                    Text(trailing).font(.synq(.subheadline, .semibold)).foregroundStyle(Theme.text2)
                }
            }
            .font(large ? .synq(.largeTitle, .bold) : .synq(.body))
            .padding(.horizontal, 14)
            .padding(.vertical, large ? 10 : 12)
            .glass(radius: 14)
        }
    }

    @ViewBuilder
    private var field: some View {
        let f = TextField("", text: $text, prompt: Text(placeholder).foregroundColor(Theme.text3))
            .foregroundStyle(Theme.text)
            .accessibilityLabel(label)
        if let keyboard { f.synqKeyboard(keyboard) } else { f }
    }
}

// MARK: - Send

struct SendSheet: View {
    let view: FundView
    let onContinue: (FundRecipient, String) -> Void
    let onCancel: () -> Void
    @State private var recipient: FundRecipient?
    @State private var amount: String

    init(view: FundView, prefill: SendPrefill, onContinue: @escaping (FundRecipient, String) -> Void,
         onCancel: @escaping () -> Void) {
        self.view = view
        self.onContinue = onContinue
        self.onCancel = onCancel
        _recipient = State(initialValue: view.recipients.first { $0.recipientId == prefill.recipientId })
        _amount = State(initialValue: prefill.amount)
    }

    private var maxAmount: Decimal { Decimal(string: view.maxPayment ?? "5") ?? 5 }
    private var normalized: String? { normalizedAmount(amount, max: maxAmount) }

    var body: some View {
        SheetScaffold(title: "Send from \(view.name)", symbol: "arrow.up.right", accent: Theme.blue, onCancel: onCancel) {
            Text("TO").font(.synq(.caption2, .bold)).tracking(0.8).foregroundStyle(Theme.text3)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: Theme.s2)], spacing: Theme.s2) {
                ForEach(view.recipients) { r in
                    Button {
                        Haptics.tap()
                        recipient = r
                    } label: {
                        HStack(spacing: Theme.s2) {
                            AvatarStack(people: [.init(id: r.recipientId, name: r.name, active: false)], size: 28)
                            Text(r.name).lineLimit(1)
                            Spacer(minLength: 0)
                            if recipient == r { Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.blueHi) }
                        }
                    }
                    .buttonStyle(ChipButtonStyle(selected: recipient == r, accent: Theme.blue))
                }
            }
            GlassField(label: "Amount", text: $amount, placeholder: "0.00", keyboard: .decimal,
                       trailing: view.treasury?.symbol ?? "AUSD", large: true)
            NoteText(text: "Up to \(view.maxPayment ?? "5") per payment. You confirm on the Synq page with Face ID, then \(view.threshold) members approve.")
            Button {
                if let recipient, let normalized {
                    Haptics.tap()
                    onContinue(recipient, normalized)
                }
            } label: {
                Label("Continue with Face ID", systemImage: "faceid")
            }
            .buttonStyle(.glow(Theme.blue, Theme.blueHi))
            .disabled(recipient == nil || normalized == nil)
        }
    }
}

// MARK: - Plan a trip

struct PlanTripSheet: View {
    let onSearch: (FlightPlan) -> Void
    let onCancel: () -> Void
    @State private var origin: String
    @State private var destination: String
    @State private var date: Date
    @State private var returning: Bool
    @State private var returnDate: Date
    @State private var travelers: Int

    init(prefill: FlightDraft = FlightDraft(), onSearch: @escaping (FlightPlan) -> Void, onCancel: @escaping () -> Void) {
        self.onSearch = onSearch
        self.onCancel = onCancel
        let cal = Calendar(identifier: .gregorian)
        let fallback = cal.date(byAdding: .day, value: 30, to: Date()) ?? Date()
        let dep = prefill.departureDate.flatMap { Self.date($0) } ?? fallback
        _origin = State(initialValue: prefill.origin ?? "")
        _destination = State(initialValue: prefill.destination ?? "")
        _date = State(initialValue: dep)
        _returning = State(initialValue: prefill.returnDate != nil)
        _returnDate = State(initialValue: prefill.returnDate.flatMap { Self.date($0) }
            ?? cal.date(byAdding: .day, value: 4, to: dep) ?? dep)
        _travelers = State(initialValue: max(1, min(4, prefill.travelers ?? 2)))
    }

    private static func date(_ s: String) -> Date? {
        let p = s.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return Calendar(identifier: .gregorian).date(from: DateComponents(year: p[0], month: p[1], day: p[2]))
    }

    private static func day(_ d: Date) -> String {
        QuickParser.day(d, Calendar(identifier: .gregorian))
    }

    /// A typed code or a known city name.
    private static func code(_ s: String) -> String? {
        let t = s.trimmingCharacters(in: .whitespaces)
        if let c = Airports.cities[t.lowercased()] { return c }
        let u = t.uppercased()
        return u.range(of: FlightPlan.iata, options: .regularExpression) != nil ? u : nil
    }

    private var plan: FlightPlan? {
        guard let o = Self.code(origin), let d = Self.code(destination) else { return nil }
        let p = FlightPlan(origin: o, destination: d, departureDate: Self.day(date),
                           returnDate: returning ? Self.day(returnDate) : nil, travelers: travelers,
                           originLabel: Airports.label(for: o), destinationLabel: Airports.label(for: d), cabin: nil)
        return p.isValid(today: QuickParser.today()) ? p : nil
    }

    var body: some View {
        SheetScaffold(title: "Plan a trip", symbol: "airplane", accent: Theme.teal, onCancel: onCancel) {
            HStack(spacing: Theme.s2) {
                GlassField(label: "From", text: $origin, placeholder: "Delhi or DEL", keyboard: .codes,
                           trailing: Self.code(origin).flatMap { $0 == origin.uppercased() ? nil : $0 })
                GlassField(label: "To", text: $destination, placeholder: "Goa or GOI", keyboard: .codes,
                           trailing: Self.code(destination).flatMap { $0 == destination.uppercased() ? nil : $0 })
            }
            HStack(spacing: Theme.s2) {
                ForEach([false, true], id: \.self) { r in
                    Button(r ? "Return" : "One way") {
                        Haptics.tap()
                        withAnimation(.snappy) { returning = r }
                    }
                    .buttonStyle(ChipButtonStyle(selected: returning == r, accent: Theme.teal))
                }
            }
            dateRow("Departure", $date, from: Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date())
            if returning {
                dateRow("Return", $returnDate, from: date)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
            HStack {
                Text("Travellers").font(.synq(.body, .semibold)).foregroundStyle(Theme.text)
                Spacer()
                stepper
            }
            .padding(14)
            .glass(radius: 14)
            NoteText(text: "Duffel test mode: you'll see Duffel Airways test flights. Booking needs the group to approve the payment; no real ticket is issued.")
            Button {
                if let plan {
                    Haptics.tap()
                    onSearch(plan)
                }
            } label: {
                Label(plan.map { "Search \(TripFormat.summary($0))" } ?? "Search flights", systemImage: "magnifyingglass")
            }
            .buttonStyle(.glow(Theme.teal, Theme.tealHi))
            .disabled(plan == nil)
        }
    }

    private func dateRow(_ title: String, _ value: Binding<Date>, from: Date) -> some View {
        HStack {
            Text(title).font(.synq(.body, .semibold)).foregroundStyle(Theme.text)
            Spacer()
            DatePicker(title, selection: value, in: from..., displayedComponents: .date)
                .labelsHidden()
                .colorScheme(.dark)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .glass(radius: 14)
    }

    private var stepper: some View {
        HStack(spacing: Theme.s3) {
            stepButton("minus", enabled: travelers > 1) { travelers -= 1 }
            Text("\(travelers)").font(.synq(.title3, .bold)).monospacedDigit().foregroundStyle(Theme.text).frame(minWidth: 22)
            stepButton("plus", enabled: travelers < 4) { travelers += 1 }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Travellers")
        .accessibilityValue("\(travelers)")
        .accessibilityAdjustableAction { dir in
            switch dir {
            case .increment: if travelers < 4 { travelers += 1 }
            case .decrement: if travelers > 1 { travelers -= 1 }
            @unknown default: break
            }
        }
    }

    private func stepButton(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            Image(systemName: symbol).font(.system(size: 13, weight: .bold)).frame(width: 32, height: 32)
        }
        .buttonStyle(ChipButtonStyle())
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.4)
    }
}

// MARK: - Gift

struct GiftSheet: View {
    let maxBudget: Int
    let onSearch: (String, String) -> Void
    let onCancel: () -> Void
    @State private var query: String
    @State private var budget: String

    init(prefill: GiftPrefill, maxBudget: Int, onSearch: @escaping (String, String) -> Void, onCancel: @escaping () -> Void) {
        self.maxBudget = max(1, min(500, maxBudget))
        self.onSearch = onSearch
        self.onCancel = onCancel
        _query = State(initialValue: prefill.query)
        _budget = State(initialValue: prefill.maxPrice)
    }

    private var valid: Bool {
        !query.trimmingCharacters(in: .whitespaces).isEmpty
            && budget.range(of: "^[0-9]{1,3}$", options: .regularExpression) != nil
            && (Int(budget) ?? 0) >= 1 && (Int(budget) ?? 0) <= maxBudget
    }

    var body: some View {
        SheetScaffold(title: "Find a gift", symbol: "gift.fill", accent: Theme.pink, onCancel: onCancel) {
            GlassField(label: "Looking for", text: $query, placeholder: "e.g. gifts for car lovers")
            GlassField(label: "Budget", text: $budget, placeholder: "50", keyboard: .number, trailing: "USD")
            HStack(spacing: Theme.s2) {
                ForEach(["25", "50", "100"], id: \.self) { b in
                    Button("$\(b)") {
                        Haptics.tap()
                        budget = b
                    }
                    .buttonStyle(ChipButtonStyle(selected: budget == b, accent: Theme.pink))
                }
            }
            NoteText(text: "Live prices from online stores. The group votes, approves the payment with Face ID, and Synq buys it with a sandbox card (no real order).")
            Button {
                Haptics.tap()
                onSearch(query.trimmingCharacters(in: .whitespaces), budget)
            } label: {
                Label("Search gifts", systemImage: "magnifyingglass")
            }
            .buttonStyle(.glow(Theme.pink, Theme.pinkHi))
            .disabled(!valid)
        }
    }
}
