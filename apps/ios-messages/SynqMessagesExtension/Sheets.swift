import SwiftUI

// Send, Plan Trip and Gift sheets. Send only prepares the payment: the Synq page
// confirms it with a passkey and members approve it there.

/// Header, canvas and spacing shared by every sheet.
struct SheetScaffold<Content: View>: View {
    var title: String
    var onCancel: () -> Void
    var actions: [SynqHeaderAction] = []
    @ViewBuilder var content: () -> Content
    @Environment(\.synqTheme) private var theme

    var body: some View {
        SynqScreen {
            VStack(alignment: .leading, spacing: theme.space.l) {
                SynqHeader(title: title, onBack: onCancel, backLabel: "Cancel", actions: actions)
                content()
            }
            .padding(.vertical, theme.space.m)
            .synqScroll()
        }
        .presentationDetents([.large])
        .presentationBackground(theme.colors.background)
    }
}

// MARK: - Send

struct SendSheet: View {
    let view: FundView
    let onContinue: (FundRecipient, String) -> Void
    let onCancel: () -> Void
    @State private var recipient: FundRecipient?
    @State private var amount: String
    @Environment(\.synqTheme) private var theme

    init(view: FundView, prefill: SendPrefill, onContinue: @escaping (FundRecipient, String) -> Void,
         onCancel: @escaping () -> Void) {
        self.view = view
        self.onContinue = onContinue
        self.onCancel = onCancel
        _recipient = State(initialValue: view.recipients.first { $0.recipientId == prefill.recipientId } ?? view.recipients.first)
        _amount = State(initialValue: prefill.amount)
    }

    private var maxAmount: Decimal { Decimal(string: view.maxPayment ?? "5") ?? 5 }
    private var normalized: String? { normalizedAmount(amount, max: maxAmount) }
    private var symbol: String { view.treasury?.symbol ?? "AUSD" }

    var body: some View {
        SheetScaffold(title: "Send payment", onCancel: onCancel) {
            SynqStack(spacing: \.m) {
                recipientPanel
                if view.recipients.count > 1 {
                    ChipScroller {
                        ForEach(view.recipients) { r in
                            SynqChip(title: r.name, selected: recipient == r) { recipient = r }
                        }
                    }
                }
                HStack {
                    Text("Amount").synqType(.sectionLabel, .secondary)
                    Spacer()
                    Text(symbol).synqType(.sectionLabel, .secondary)
                }
                .padding(.top, theme.space.xs)
                SynqGroup(emphasis: true) {
                    HStack {
                        Text(amount.isEmpty ? "0.00" : amount).synqType(.amountLarge, amount.isEmpty ? .tertiary : .primary)
                            .monospacedDigit().lineLimit(1).minimumScaleFactor(0.5)
                        Spacer()
                    }
                    .padding(.horizontal, theme.space.l)
                    .padding(.vertical, theme.space.m)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Amount: \(amount.isEmpty ? "none" : amount) \(symbol)")
                Text("Testnet \(symbol) on \(networkTitle(view.networkLabel)) · up to \(view.maxPayment ?? "5") per payment")
                    .synqType(.caption, .secondary)
                SynqKeypad(text: $amount)
                SynqButton(title: "Confirm with passkey", icon: .passkey, trailingIcon: .forward, kind: .primary) {
                    if let recipient, let normalized { onContinue(recipient, normalized) }
                }
                .disabled(recipient == nil || normalized == nil)
                SynqNote(text: "You confirm on the Synq page with your passkey, then \(view.threshold) members approve.")
            }
            SynqHeroArt(slot: .send)
        }
    }

    private var recipientPanel: some View {
        SynqPanel {
            HStack(spacing: theme.space.l) {
                if let r = recipient {
                    SynqAvatar(id: r.recipientId, name: r.name, size: 54)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("To").synqType(.caption, .secondary)
                        Text(r.name).synqType(.headline).lineLimit(1)
                        Text("Fund recipient · \(shortId(r.recipientId))").synqType(.mono, .tertiary).lineLimit(1)
                    }
                } else {
                    Text("This fund has no recipients yet.").synqType(.body, .secondary)
                }
                Spacer(minLength: 0)
            }
        }
    }
}

// MARK: - Plan a trip

struct PlanTripSheet: View {
    let prefill: FlightDraft
    let onSearch: (FlightPlan) -> Void
    let onCancel: () -> Void

    init(prefill: FlightDraft = FlightDraft(), onSearch: @escaping (FlightPlan) -> Void, onCancel: @escaping () -> Void) {
        self.prefill = prefill
        self.onSearch = onSearch
        self.onCancel = onCancel
    }

    var body: some View {
        SheetScaffold(title: "Plan a trip", onCancel: onCancel) {
            SynqHeroArt(slot: .flights)
            SynqStack {
                SynqDisplay(line: "Add the missing details and Synq searches.")
                FlightSearchForm(prefill: prefill, onSearch: onSearch)
                SynqNote(text: "Duffel test mode: you'll see Duffel Airways test flights. Booking needs the group to approve the payment; no real ticket is issued.")
            }
        }
    }
}

// MARK: - Gift

struct GiftSheet: View {
    let prefill: GiftPrefill
    let maxBudget: Int
    let onSearch: (String, String) -> Void
    let onCancel: () -> Void

    var body: some View {
        SheetScaffold(title: "Find a gift", onCancel: onCancel) {
            SynqHeroArt(slot: .gift)
            SynqStack {
                GiftSearchForm(prefill: prefill, maxBudget: maxBudget, onSearch: onSearch)
            }
        }
    }
}
