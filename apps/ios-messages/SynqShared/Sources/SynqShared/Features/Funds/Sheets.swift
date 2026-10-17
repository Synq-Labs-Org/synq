import SwiftUI

// Send, Plan Trip and Gift sheets. Send only prepares the payment: the Synq page
// confirms it with a passkey and members approve it there.

/// Header, canvas and spacing shared by every sheet.
public struct SheetScaffold<Content: View>: View {
    public var title: String
    public var onCancel: () -> Void
    public var actions: [SynqHeaderAction] = []
    @ViewBuilder public var content: () -> Content
    @Environment(\.synqTheme) private var theme

    public var body: some View {
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

public struct SendSheet: View {
    public let view: FundView
    public let onContinue: (FundRecipient, String) -> Void
    public let onCancel: () -> Void
    @State private var recipient: FundRecipient?
    @State private var amount: String
    @Environment(\.synqTheme) private var theme

    public init(view: FundView, prefill: SendPrefill, onContinue: @escaping (FundRecipient, String) -> Void,
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

    public var body: some View {
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
                    VStack(alignment: .leading, spacing: theme.space.xxs) {
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

public struct PlanTripSheet: View {
    public let prefill: FlightDraft
    public let onSearch: (FlightPlan) -> Void
    public let onCancel: () -> Void

    public init(prefill: FlightDraft = FlightDraft(), onSearch: @escaping (FlightPlan) -> Void, onCancel: @escaping () -> Void) {
        self.prefill = prefill
        self.onSearch = onSearch
        self.onCancel = onCancel
    }

    public var body: some View {
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

public struct GiftSheet: View {
    public let prefill: GiftPrefill
    public let maxBudget: Int
    public let onSearch: (String, String) -> Void
    public let onCancel: () -> Void

    public var body: some View {
        SheetScaffold(title: "Find a gift", onCancel: onCancel) {
            SynqHeroArt(slot: .gift)
            SynqStack {
                GiftSearchForm(prefill: prefill, maxBudget: maxBudget, onSearch: onSearch)
            }
        }
    }
}
