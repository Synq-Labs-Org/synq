import SwiftUI

// Components for the full-screen app. Same rule as Components.swift: they read
// the theme and screens compose them without styling anything themselves.

// MARK: - Tab shell

/// One tab of the app's root.
public struct SynqTabItem<ID: Hashable>: Identifiable {
    public let id: ID
    public let title: String
    public let icon: SynqIcon
    public let badge: Int
    public init(id: ID, title: String, icon: SynqIcon, badge: Int = 0) {
        self.id = id
        self.title = title
        self.icon = icon
        self.badge = badge
    }
}

/// The system tab bar (VoiceOver, Dynamic Type and large-content viewer for free),
/// tinted by the theme.
public struct SynqTabShell<ID: Hashable, Content: View>: View {
    @Environment(\.synqTheme) private var theme
    @Binding var selection: ID
    let items: [SynqTabItem<ID>]
    @ViewBuilder let content: (ID) -> Content

    public init(selection: Binding<ID>, items: [SynqTabItem<ID>], @ViewBuilder content: @escaping (ID) -> Content) {
        _selection = selection
        self.items = items
        self.content = content
    }

    public var body: some View {
        TabView(selection: $selection) {
            ForEach(items) { item in
                content(item.id)
                    .tabItem { Label(item.title, systemImage: theme.icons.name(item.icon)) }
                    .badge(item.badge)
                    .tag(item.id)
            }
        }
        .tint(theme.colors.inkPrimary)
    }
}

// MARK: - Context header

/// The app's top bar: the active context (tap to switch), its kind, and icon actions.
public struct SynqContextHeader: View {
    @Environment(\.synqTheme) private var theme
    @Environment(\.dynamicTypeSize) private var dynamicType
    let title: String
    let kind: String
    let network: String?
    let onSwitch: () -> Void
    let actions: [SynqHeaderAction]

    public init(title: String, kind: String, network: String? = nil, onSwitch: @escaping () -> Void,
                actions: [SynqHeaderAction] = []) {
        self.title = title
        self.kind = kind
        self.network = network
        self.onSwitch = onSwitch
        self.actions = actions
    }

    public var body: some View {
        if dynamicType.isAccessibilitySize {
            // Large type: the context gets the full width; network and actions go below.
            VStack(alignment: .leading, spacing: theme.space.s) {
                switchButton
                HStack(spacing: theme.space.s) {
                    if let network { Text(network).synqType(.caption, .secondary).accessibilityLabel("Network: \(network)") }
                    Spacer(minLength: 0)
                    actionButtons
                }
            }
            .padding(.horizontal, theme.space.gutter)
            .padding(.top, theme.space.s)
        } else {
            HStack(alignment: .center, spacing: theme.space.s) {
                switchButton
                Spacer(minLength: theme.space.s)
                if let network {
                    Text(network).synqType(.caption, .secondary).accessibilityLabel("Network: \(network)")
                }
                actionButtons
            }
            .padding(.horizontal, theme.space.gutter)
            .padding(.top, theme.space.s)
        }
    }

    private var actionButtons: some View {
        ForEach(Array(actions.enumerated()), id: \.offset) { _, a in
            SynqIconButton(icon: a.icon, label: a.label, action: a.action)
        }
    }

    private var switchButton: some View {
            Button {
                Haptics.tap()
                onSwitch()
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(kind).synqType(.sectionLabel, .secondary)
                    HStack(spacing: theme.space.xs) {
                        Text(title).synqType(.headline).lineLimit(dynamicType.isAccessibilitySize ? 3 : 1)
                            .minimumScaleFactor(dynamicType.isAccessibilitySize ? 1 : 0.7)
                        SynqIconView(icon: .forward, size: 12, ink: .secondary).rotationEffect(.degrees(90))
                    }
                }
                .frame(minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(SynqPressStyle())
            .accessibilityLabel("\(kind): \(title)")
            .accessibilityHint("Switch between Personal and your businesses")
    }
}

// MARK: - Rows and states

/// A label and an exact value (amounts, ids, hashes).
public struct SynqKeyValue: View {
    @Environment(\.synqTheme) private var theme
    @Environment(\.dynamicTypeSize) private var dynamicType
    let label: String
    let value: String
    let mono: Bool
    let ink: SynqInk

    public init(_ label: String, _ value: String, mono: Bool = false, ink: SynqInk = .primary) {
        self.label = label
        self.value = value
        self.mono = mono
        self.ink = ink
    }

    public var body: some View {
        let layout = dynamicType.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: theme.space.m))
        layout {
            Text(label).synqType(.caption, .secondary)
            if !dynamicType.isAccessibilitySize { Spacer(minLength: theme.space.s) }
            Text(value).synqType(mono ? .mono : .bodyStrong, ink)
                .multilineTextAlignment(dynamicType.isAccessibilitySize ? .leading : .trailing)
                .monospacedDigit().textSelection(.enabled)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The four availability buckets of one asset, never summed into one figure.
public struct SynqBalanceBreakdown: View {
    @Environment(\.synqTheme) private var theme
    @Environment(\.dynamicTypeSize) private var dynamicType
    let symbol: String
    let network: String
    let settled: String
    let reserved: String
    let pending: String
    let quarantined: String

    public init(symbol: String, network: String, settled: String, reserved: String, pending: String, quarantined: String) {
        self.symbol = symbol
        self.network = network
        self.settled = settled
        self.reserved = reserved
        self.pending = pending
        self.quarantined = quarantined
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: theme.space.s) {
            Text("Settled · spendable · \(network)").synqType(.caption, .secondary)
            SynqAmount(amount: settled, unit: symbol)
            SynqDivider()
            row("Reserved", reserved, "held for bills, deals or members")
            row("Pending", pending, "seen, not final")
            row("Quarantined", quarantined, "arrived without a matching authorisation")
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(symbol) on \(network). Settled and spendable \(settled). Reserved \(reserved). "
                            + "Pending \(pending), not final. Quarantined \(quarantined).")
    }

    private func row(_ title: String, _ value: String, _ note: String) -> some View {
        let layout = dynamicType.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: theme.space.s))
        return layout {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).synqType(.bodyStrong)
                Text(note).synqType(.caption, .tertiary)
            }
            if !dynamicType.isAccessibilitySize { Spacer(minLength: theme.space.s) }
            Text("\(value) \(symbol)").synqType(.body, .secondary).monospacedDigit()
        }
    }
}

/// A full-width notice strip (offline, last synced, preview data).
public struct SynqBanner: View {
    @Environment(\.synqTheme) private var theme
    let icon: SynqIcon
    let text: String
    let ink: SynqInk

    public init(icon: SynqIcon, text: String, ink: SynqInk = .secondary) {
        self.icon = icon
        self.text = text
        self.ink = ink
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.space.s) {
            SynqIconView(icon: icon, size: 12, ink: ink)
            Text(text).synqType(.caption, ink).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, theme.space.gutter)
        .padding(.vertical, theme.space.s)
        .background(theme.colors.panel)
        .overlay(alignment: .bottom) { SynqDivider() }
        .accessibilityElement(children: .combine)
    }
}

/// One step of a timeline with a rail joining it to the next.
public struct SynqTimelineRow<Trailing: View>: View {
    @Environment(\.synqTheme) private var theme
    let title: String
    let detail: String?
    let meta: String?
    let last: Bool
    let mark: SynqBadgeKind
    @ViewBuilder let trailing: () -> Trailing

    public init(title: String, detail: String? = nil, meta: String? = nil, mark: SynqBadgeKind = .neutral,
                last: Bool = false, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.title = title
        self.detail = detail
        self.meta = meta
        self.mark = mark
        self.last = last
        self.trailing = trailing
    }

    public var body: some View {
        HStack(alignment: .top, spacing: theme.space.m) {
            VStack(spacing: 0) {
                Circle()
                    .fill(mark == .approved ? theme.colors.approved : mark == .danger ? theme.colors.danger : theme.colors.inkPrimary)
                    .frame(width: 9, height: 9)
                    .padding(.top, 5)
                if !last {
                    Rectangle().fill(theme.colors.line).frame(width: theme.lines.hairline).frame(maxHeight: .infinity)
                }
            }
            .frame(width: 12)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).synqType(.bodyStrong).fixedSize(horizontal: false, vertical: true)
                if let detail { Text(detail).synqType(.caption, .secondary).fixedSize(horizontal: false, vertical: true) }
                if let meta { Text(meta).synqType(.caption, .tertiary) }
                trailing()
            }
            .padding(.bottom, last ? 0 : theme.space.l)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }
}

/// One message of a private lead conversation.
public struct SynqMessageBubble: View {
    @Environment(\.synqTheme) private var theme
    public enum Side { case theirs, ours, system }
    let author: String
    let text: String
    let time: String
    let side: Side

    public init(author: String, text: String, time: String, side: Side) {
        self.author = author
        self.text = text
        self.time = time
        self.side = side
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: theme.radius.panel, style: .continuous)
        HStack {
            if side == .ours { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: theme.space.s) {
                    Text(author).synqType(.sectionLabel, .secondary)
                    Text(time).synqType(.caption, .tertiary)
                }
                Text(text).synqType(side == .system ? .caption : .body, side == .system ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .padding(theme.space.m)
            .background(shape.fill(side == .ours ? theme.colors.panel : theme.colors.background))
            .overlay(shape.strokeBorder(theme.colors.line, lineWidth: theme.lines.hairline))
            if side != .ours { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Navigation

extension View {
    /// Detail screens: the system back button and an inline title (VoiceOver and
    /// swipe-back keep working), on the theme's canvas.
    public func synqDetail(_ title: String) -> some View { modifier(SynqDetailChrome(title: title)) }
}

struct SynqDetailChrome: ViewModifier {
    @Environment(\.synqTheme) private var theme
    let title: String

    func body(content: Content) -> some View {
        SynqScreen { content }
            .navigationTitle(title)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(theme.colors.background, for: .navigationBar)
        #endif
    }
}
