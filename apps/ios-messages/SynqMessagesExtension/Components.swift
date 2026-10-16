import SwiftUI

// Themed semantic components. Each reads the theme from the environment and asks
// it for colours, type, radii, line widths, glyphs, icons and art; screens compose
// these and never style anything themselves.

// MARK: - Type and ink

struct SynqTypeModifier: ViewModifier {
    @Environment(\.synqTheme) private var theme
    let role: SynqTypeRole
    let ink: SynqInk

    func body(content: Content) -> some View {
        let spec = theme.type[role]
        content
            .font(spec.font)
            .tracking(spec.tracking)
            .textCase(spec.uppercase ? .uppercase : nil)
            .foregroundStyle(theme.colors.ink(ink))
    }
}

extension View {
    /// Applies a typography role and an ink from the current theme.
    func synqType(_ role: SynqTypeRole, _ ink: SynqInk = .primary) -> some View {
        modifier(SynqTypeModifier(role: role, ink: ink))
    }
}

/// An icon from the theme's icon set.
struct SynqIconView: View {
    @Environment(\.synqTheme) private var theme
    let icon: SynqIcon
    var size: CGFloat = 18
    var ink: SynqInk = .primary

    var body: some View {
        Image(systemName: theme.icons.name(icon))
            .font(.system(size: size, weight: theme.icons.weight))
            .foregroundStyle(theme.colors.ink(ink))
            .accessibilityHidden(true)
    }
}

// MARK: - Screen

/// The themed canvas every screen sits on.
struct SynqScreen<Content: View>: View {
    @Environment(\.synqTheme) private var theme
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack {
            theme.colors.background.ignoresSafeArea()
            content()
        }
        .preferredColorScheme(.dark)
        .tint(theme.colors.inkPrimary)
    }
}

/// Spacing and gutters from the theme, for screens that lay out stacks.
struct SynqStack<Content: View>: View {
    @Environment(\.synqTheme) private var theme
    var spacing: KeyPath<SynqSpacing, CGFloat> = \.l
    var gutter = true
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space[keyPath: spacing]) { content() }
            .padding(.horizontal, gutter ? theme.space.gutter : 0)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Header

struct SynqHeaderAction {
    var icon: SynqIcon
    var label: String
    var action: () -> Void
}

/// Back arrow, an all-caps title and trailing icon buttons.
struct SynqHeader: View {
    @Environment(\.synqTheme) private var theme
    let title: String
    var onBack: (() -> Void)? = nil
    var backLabel = "Back"
    var actions: [SynqHeaderAction] = []

    var body: some View {
        HStack(spacing: theme.space.m) {
            if let onBack {
                Button {
                    Haptics.tap()
                    onBack()
                } label: {
                    SynqIconView(icon: .back, size: 19).frame(width: 30, height: 36, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(backLabel)
            }
            Text(title).synqType(.title).lineLimit(1).minimumScaleFactor(0.7)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: theme.space.s)
            ForEach(Array(actions.enumerated()), id: \.offset) { _, a in
                Button {
                    Haptics.tap()
                    a.action()
                } label: {
                    SynqIconView(icon: a.icon, size: 18).frame(width: 34, height: 36)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(a.label)
            }
        }
        .padding(.horizontal, theme.space.gutter)
        .frame(minHeight: 44)
    }
}

/// The home header: wordmark, the theme's sub-mark, the network label and one action.
struct SynqWordmarkBar: View {
    @Environment(\.synqTheme) private var theme
    let network: String
    var action: SynqHeaderAction? = nil
    var compact = false

    var body: some View {
        HStack(alignment: .top, spacing: theme.space.s) {
            VStack(alignment: .leading, spacing: 0) {
                Text(theme.copy.wordmark).synqType(.wordmark)
                    .scaleEffect(compact ? 0.62 : 1, anchor: .topLeading)
                    .frame(height: compact ? 26 : nil, alignment: .topLeading)
                if let sub = theme.copy.wordmarkSub, !compact {
                    Text(sub).synqType(.wordmarkSub, .secondary).padding(.leading, 2).accessibilityHidden(true)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Synq")
            Spacer(minLength: theme.space.s)
            Text(network).synqType(.caption, .secondary).padding(.top, compact ? 4 : 12)
                .accessibilityLabel("Network: \(network)")
            if let action {
                SynqIconButton(icon: action.icon, label: action.label, action: action.action).padding(.top, compact ? -2 : 4)
            }
        }
        .padding(.horizontal, theme.space.gutter)
    }
}

/// A small icon button framed by the theme's brackets (or a plain circle).
struct SynqIconButton: View {
    @Environment(\.synqTheme) private var theme
    let icon: SynqIcon
    let label: String
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            HStack(spacing: 2) {
                if let open = theme.glyphs.bracketOpen { Text(open).synqType(.bodyStrong, .secondary) }
                SynqIconView(icon: icon, size: 15)
                if let close = theme.glyphs.bracketClose { Text(close).synqType(.bodyStrong, .secondary) }
            }
            .frame(minWidth: 36, minHeight: 34)
            .background {
                if theme.glyphs.bracketOpen == nil {
                    Circle().fill(theme.colors.panel)
                }
            }
        }
        .buttonStyle(SynqPressStyle())
        .accessibilityLabel(label)
    }
}

// MARK: - Art

/// Full-bleed hero art from the theme's art set, with optional place coordinates.
struct SynqHeroArt: View {
    @Environment(\.synqTheme) private var theme
    let slot: SynqArtSlot
    var place: String? = nil

    var body: some View {
        theme.art(slot, .hero)
            .frame(maxWidth: .infinity)
            .overlay(alignment: .topTrailing) {
                if let place, let coords = theme.copy.places[place] {
                    Text(coords).synqType(.caption, .secondary).multilineTextAlignment(.trailing)
                        .padding(.trailing, theme.space.gutter).padding(.top, 2)
                        .accessibilityHidden(true)
                }
            }
            .accessibilityHidden(true)
    }
}

/// The theme's short art strip for cards and compact rows.
struct SynqArtStrip: View {
    @Environment(\.synqTheme) private var theme
    let slot: SynqArtSlot

    var body: some View { theme.art(slot, .strip).accessibilityHidden(true) }
}

/// The theme's large flavour headline for flights (e.g. "Where to?"), with an English line under it.
struct SynqDisplay: View {
    @Environment(\.synqTheme) private var theme
    let line: String

    var body: some View {
        VStack(alignment: .leading, spacing: theme.space.xs) {
            if let flavour = theme.copy.flightsHeadline {
                Text(flavour).synqType(.display).accessibilityHidden(true)
            }
            Text(line).synqType(.body, .secondary)
        }
    }
}

// MARK: - Panel and sections

/// An outlined (or filled) panel with its label notched into the top border.
struct SynqPanel<Content: View>: View {
    @Environment(\.synqTheme) private var theme
    var label: String? = nil
    var padding = true
    @ViewBuilder var content: () -> Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: theme.radius.panel, style: .continuous)
        let notched = theme.looks.panelLabel == .notched
        VStack(alignment: .leading, spacing: theme.space.s) {
            if let label, !notched {
                Text(label).synqType(.sectionLabel, .secondary).accessibilityAddTraits(.isHeader)
            }
            VStack(alignment: .leading, spacing: theme.space.m) { content() }
                .padding(.horizontal, padding ? theme.space.l : 0)
                .padding(.top, padding ? (label != nil && notched ? theme.space.l + 2 : theme.space.l) : 0)
                .padding(.bottom, padding ? theme.space.l : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(shape.fill(theme.looks.panelFilled ? theme.colors.panel : theme.colors.background))
                .overlay(shape.strokeBorder(theme.colors.line, lineWidth: theme.lines.hairline))
                .overlay(alignment: .topLeading) {
                    if let label, notched {
                        Text(label).synqType(.sectionLabel, .secondary)
                            .padding(.horizontal, 6)
                            .background(theme.colors.background)
                            .padding(.leading, 12)
                            .alignmentGuide(.top) { d in d[VerticalAlignment.center] }
                            .accessibilityAddTraits(.isHeader)
                    }
                }
                .padding(.top, label != nil && notched ? 8 : 0)
        }
    }
}

/// A section label followed by a rule, with optional trailing flavour or action.
struct SynqSectionLabel: View {
    @Environment(\.synqTheme) private var theme
    let text: String
    var trailing: String? = nil
    /// Shows the theme's "see all" flavour as the trailing text.
    var seeAll = false
    var action: (() -> Void)? = nil

    var body: some View {
        let trailing = seeAll ? theme.copy.seeAll : self.trailing
        HStack(spacing: theme.space.s) {
            Text(text).synqType(.sectionLabel, .secondary).accessibilityAddTraits(.isHeader)
            if theme.looks.ruledSections { SynqRule().frame(maxWidth: .infinity) } else { Spacer() }
            if let trailing {
                if let action {
                    Button(action: action) { Text(trailing).synqType(.caption, .secondary) }.buttonStyle(.plain)
                } else {
                    Text(trailing).synqType(.caption, .secondary)
                }
            }
        }
        .padding(.top, theme.space.xs)
    }
}

/// A dashed (or solid) hairline rule.
struct SynqRule: View {
    @Environment(\.synqTheme) private var theme

    var body: some View {
        GeometryReader { geo in
            Path { p in
                p.move(to: CGPoint(x: 0, y: 0.5))
                p.addLine(to: CGPoint(x: geo.size.width, y: 0.5))
            }
            .stroke(theme.colors.line, style: StrokeStyle(lineWidth: theme.lines.hairline, dash: theme.lines.ruleDash))
        }
        .frame(height: 1)
        .accessibilityHidden(true)
    }
}

struct SynqDivider: View {
    @Environment(\.synqTheme) private var theme
    var vertical = false

    var body: some View {
        Rectangle().fill(theme.colors.line)
            .frame(width: vertical ? theme.lines.hairline : nil, height: vertical ? nil : theme.lines.hairline)
            .accessibilityHidden(true)
    }
}

/// Small explanatory text, with a warning mark for errors.
struct SynqNote: View {
    @Environment(\.synqTheme) private var theme
    let text: String
    var error = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.space.s) {
            if error { SynqIconView(icon: .warning, size: 12, ink: .danger) }
            Text(text).synqType(.caption, error ? .danger : .tertiary).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Buttons

enum SynqButtonKind {
    /// Filled, strongest action (passkey hand-offs).
    case primary
    /// Outlined with the theme's brackets.
    case secondary
    /// A small outlined chip.
    case compact
}

struct SynqButton: View {
    @Environment(\.synqTheme) private var theme
    @Environment(\.isEnabled) private var enabled
    let title: String
    var icon: SynqIcon? = nil
    var trailingIcon: SynqIcon? = nil
    var kind: SynqButtonKind = .secondary
    var busy = false
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            label
        }
        .buttonStyle(SynqPressStyle())
        .opacity(enabled ? 1 : 0.4)
        .accessibilityLabel(busy ? "\(title), working" : title)
    }

    @ViewBuilder
    private var label: some View {
        let shape = RoundedRectangle(cornerRadius: theme.radius.control, style: .continuous)
        switch kind {
        case .primary:
            HStack(spacing: theme.space.m) {
                if let open = theme.glyphs.strongOpen { Text(open).synqType(.body, .tertiary) }
                Spacer(minLength: 0)
                if let icon { iconView(icon, .onAccent) }
                Text(title).synqType(.button, .onAccent).lineLimit(1).minimumScaleFactor(0.75)
                if let trailingIcon { iconView(trailingIcon, .onAccent) }
                Spacer(minLength: 0)
                if let close = theme.glyphs.strongClose { Text(close).synqType(.body, .tertiary) }
            }
            .padding(.horizontal, theme.space.s)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(shape.fill(theme.colors.accent))
        case .secondary:
            HStack(spacing: theme.space.m) {
                if let open = theme.glyphs.bracketOpen { Text(open).synqType(.button) }
                if let icon { iconView(icon, .primary) }
                Text(title).synqType(.button).lineLimit(1).minimumScaleFactor(0.75)
                if let trailingIcon { iconView(trailingIcon, .primary) }
                if let close = theme.glyphs.bracketClose { Text(close).synqType(.button) }
            }
            .padding(.horizontal, theme.space.m)
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(shape.fill(theme.looks.panelFilled ? theme.colors.panel : theme.colors.background))
            .overlay(shape.strokeBorder(theme.colors.lineStrong, lineWidth: theme.lines.control))
        case .compact:
            HStack(spacing: theme.space.xs) {
                if let icon { iconView(icon, .primary, size: 12) }
                Text(title).synqType(.caption).lineLimit(1)
            }
            .padding(.horizontal, theme.space.m)
            .frame(minHeight: 32)
            .background(shape.fill(theme.looks.panelFilled ? theme.colors.panel : theme.colors.background))
            .overlay(shape.strokeBorder(theme.colors.line, lineWidth: theme.lines.control))
        }
    }

    @ViewBuilder
    private func iconView(_ i: SynqIcon, _ ink: SynqInk, size: CGFloat = 15) -> some View {
        if busy && (i == trailingIcon || trailingIcon == nil) {
            SynqSpinner(ink: ink, size: size)
        } else {
            SynqIconView(icon: i, size: size, ink: ink)
        }
    }
}

/// A selectable chip (examples, suggestions, options).
struct SynqChip: View {
    @Environment(\.synqTheme) private var theme
    let title: String
    var icon: SynqIcon? = nil
    var selected = false
    let action: () -> Void

    var body: some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            HStack(spacing: theme.space.xs) {
                if let icon { SynqIconView(icon: icon, size: 12, ink: selected ? .onAccent : .secondary) }
                Text(title).synqType(.caption, selected ? .onAccent : .primary).lineLimit(1)
            }
            .padding(.horizontal, theme.space.m)
            .frame(minHeight: 32)
            .background(RoundedRectangle(cornerRadius: theme.radius.badge + 2, style: .continuous)
                .fill(selected ? theme.colors.accent : theme.colors.background))
            .overlay(RoundedRectangle(cornerRadius: theme.radius.badge + 2, style: .continuous)
                .strokeBorder(selected ? theme.colors.accent : theme.colors.line, lineWidth: theme.lines.hairline))
        }
        .buttonStyle(SynqPressStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct SynqPressStyle: ButtonStyle {
    @Environment(\.synqTheme) private var theme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .contentShape(Rectangle())
            .scaleEffect(configuration.isPressed ? theme.motion.pressScale : 1)
            .opacity(configuration.isPressed ? 0.7 : 1)
            .animation(theme.motion.quick, value: configuration.isPressed)
    }
}

// MARK: - Rows and groups

enum SynqRowTrailing {
    case arrow
    case chevron
    case badge(SynqBadgeKind, String)
    case text(String)
    case none
}

/// One outlined group holding rows separated by hairlines.
struct SynqGroup<Content: View>: View {
    @Environment(\.synqTheme) private var theme
    /// Draws the border in the strong line (a highlighted option).
    var emphasis = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: theme.radius.panel, style: .continuous)
        VStack(spacing: 0) { content() }
            .background(shape.fill(theme.looks.panelFilled ? theme.colors.panel : theme.colors.background))
            .overlay(shape.strokeBorder(emphasis ? theme.colors.lineStrong : theme.colors.line, lineWidth: theme.lines.hairline))
            .clipShape(shape)
    }
}

/// An icon, a title and a subtitle, with a trailing arrow, chevron, badge or text.
struct SynqRow: View {
    @Environment(\.synqTheme) private var theme
    var icon: SynqIcon? = nil
    let title: String
    var subtitle: String? = nil
    var detail: String? = nil
    var trailing: SynqRowTrailing = .arrow
    var divider = false
    var action: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 0) {
            if divider { SynqDivider() }
            if let action {
                Button {
                    Haptics.tap()
                    action()
                } label: { content }
                .buttonStyle(SynqPressStyle())
            } else {
                content
            }
        }
    }

    private var content: some View {
        HStack(spacing: theme.space.m) {
            if let icon { SynqIconView(icon: icon, size: 22).frame(width: 30) }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).synqType(.bodyStrong).lineLimit(2)
                if let subtitle { Text(subtitle).synqType(.caption, .secondary).lineLimit(2) }
                if let detail { Text(detail).synqType(.caption, .tertiary).lineLimit(1) }
            }
            Spacer(minLength: theme.space.s)
            trailingView
        }
        .padding(.horizontal, theme.space.l)
        .padding(.vertical, theme.space.m + 2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var trailingView: some View {
        switch trailing {
        case .arrow:
            if let arrow = theme.glyphs.rowArrow {
                Text(arrow).synqType(.body, .secondary).accessibilityHidden(true)
            } else {
                SynqIconView(icon: .back, size: 14, ink: .tertiary).rotationEffect(.degrees(180))
            }
        case .chevron:
            Image(systemName: "chevron.right").font(.system(size: 13, weight: theme.icons.weight))
                .foregroundStyle(theme.colors.inkSecondary).accessibilityHidden(true)
        case .badge(let kind, let text):
            SynqBadge(kind: kind, text: text)
        case .text(let t):
            Text(t).synqType(.caption, .secondary)
        case .none:
            EmptyView()
        }
    }
}

// MARK: - Fields

/// One field in a stacked field group: label, value (or editor), trailing icon cell.
struct SynqField: View {
    @Environment(\.synqTheme) private var theme
    @Environment(\.synqRenderMode) private var mode
    let label: String
    var icon: SynqIcon? = nil
    var text: Binding<String>? = nil
    var value: String = ""
    var placeholder = ""
    var detail: String? = nil
    var keyboard: SynqKeyboard? = nil
    var large = false
    var trailingIcon: SynqIcon? = nil
    var trailingLabel = ""
    var trailingAction: (() -> Void)? = nil
    var divider = false

    private var shown: String { text?.wrappedValue ?? value }

    var body: some View {
        VStack(spacing: 0) {
            if divider { SynqDivider() }
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(label).synqType(.sectionLabel, .secondary).accessibilityHidden(true)
                    HStack(spacing: theme.space.m) {
                        if let icon { SynqIconView(icon: icon, size: 11, ink: .tertiary) }
                        editor
                        if let detail, !detail.isEmpty {
                            Text(detail).synqType(.body, .secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                }
                .padding(.horizontal, theme.space.l)
                .padding(.vertical, theme.space.m)
                if let trailingIcon {
                    SynqDivider(vertical: true)
                    Button {
                        Haptics.tap()
                        trailingAction?()
                    } label: {
                        SynqIconView(icon: trailingIcon, size: 17, ink: .secondary).frame(width: 52)
                            .frame(maxHeight: .infinity)
                    }
                    .buttonStyle(.plain)
                    .disabled(trailingAction == nil)
                    .accessibilityLabel(trailingLabel)
                    .accessibilityHidden(trailingAction == nil)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var editor: some View {
        let role: SynqTypeRole = large ? .amountLarge : .bodyStrong
        if let text, !mode.isStill {
            let field = TextField("", text: text, prompt: Text(placeholder).foregroundColor(theme.colors.inkTertiary))
                .synqType(role)
                .accessibilityLabel(label)
            if let keyboard { field.synqKeyboard(keyboard) } else { field }
        } else {
            Text(shown.isEmpty ? placeholder : shown)
                .synqType(role, shown.isEmpty ? .tertiary : .primary)
                .lineLimit(1)
                .accessibilityLabel("\(label): \(shown)")
        }
    }
}

/// The "Ask or tell Synq…" input with the theme's prompt glyph and a send key.
struct SynqCommandField: View {
    @Environment(\.synqTheme) private var theme
    @Environment(\.synqRenderMode) private var mode
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var text: String
    var placeholder: String
    var busy: Bool
    var onSubmit: () -> Void
    var onFocus: () -> Void
    @FocusState private var focused: Bool

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: theme.radius.control, style: .continuous)
        HStack(alignment: .center, spacing: theme.space.s) {
            if !theme.glyphs.prompt.isEmpty {
                Text(theme.glyphs.prompt).synqType(.bodyStrong, .secondary).accessibilityHidden(true)
            } else {
                SynqIconView(icon: .ask, size: 16, ink: .secondary)
            }
            field
            Button(action: submit) {
                Group {
                    if busy { SynqSpinner(ink: .primary, size: 14) } else { SynqIconView(icon: .back, size: 14).rotationEffect(.degrees(90)) }
                }
                .frame(width: 34, height: 34)
                .overlay(RoundedRectangle(cornerRadius: theme.radius.badge, style: .continuous)
                    .strokeBorder(empty ? theme.colors.line : theme.colors.lineStrong, lineWidth: theme.lines.control))
                .opacity(empty && !busy ? 0.5 : 1)
            }
            .buttonStyle(.plain)
            .disabled(empty || busy)
            .accessibilityLabel("Send to Synq")
        }
        .padding(.leading, theme.space.m)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .background(shape.fill(theme.looks.panelFilled ? theme.colors.panel : theme.colors.background))
        .overlay(shape.strokeBorder(focused ? theme.colors.lineStrong : theme.colors.line, lineWidth: theme.lines.control))
    }

    @ViewBuilder
    private var field: some View {
        if mode.isStill {
            HStack(spacing: 0) {
                Text(text.isEmpty ? placeholder : text).synqType(.body, text.isEmpty ? .tertiary : .primary).lineLimit(2)
                if !text.isEmpty, let cursor = theme.glyphs.cursor { Text(cursor).synqType(.body, .secondary) }
            }
            .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
        } else {
            TextField("", text: $text, prompt: Text(placeholder).foregroundColor(theme.colors.inkTertiary), axis: .vertical)
                .synqType(.body)
                .lineLimit(1...4)
                .submitLabel(.send)
                .focused($focused)
                .frame(minHeight: 34)
                .onSubmit(submit)
                .onChange(of: text) { _, new in
                    // Return in a multi-line field inserts a newline; treat it as send.
                    if new.contains("\n") {
                        text = new.replacingOccurrences(of: "\n", with: "")
                        submit()
                    }
                }
                .onChange(of: focused) { _, isFocused in if isFocused { onFocus() } }
                .accessibilityLabel("Ask or tell Synq")
        }
    }

    private func submit() {
        guard !empty, !busy else { return }
        focused = false
        onSubmit()
    }
}

// MARK: - Badges, progress, amounts

enum SynqBadgeKind: Equatable {
    case approved, pending, neutral, live, danger
}

extension SynqTone {
    var badge: SynqBadgeKind {
        switch self {
        case .waiting, .moving: return .pending
        case .live: return .live
        case .done: return .approved
        case .failed: return .danger
        }
    }
}

struct SynqBadge: View {
    @Environment(\.synqTheme) private var theme
    let kind: SynqBadgeKind
    let text: String

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: theme.radius.badge, style: .continuous)
        let c = theme.colors
        let (ink, fill, line): (SynqInk, Color, Color) = {
            switch kind {
            case .approved: return (.approved, c.approvedFill, c.approvedLine)
            case .pending: return (.pending, c.background, c.line)
            case .neutral: return (.secondary, c.background, c.line)
            case .live: return (.primary, c.background, c.line)
            case .danger: return (.danger, c.background, c.danger.opacity(0.6))
            }
        }()
        HStack(spacing: 4) {
            switch kind {
            case .approved: SynqIconView(icon: .check, size: 10, ink: ink)
            case .pending: SynqIconView(icon: .clock, size: 10, ink: ink)
            case .danger: SynqIconView(icon: .warning, size: 10, ink: ink)
            case .live: Circle().fill(c.inkPrimary).frame(width: 5, height: 5)
            case .neutral: EmptyView()
            }
            Text(text).synqType(.caption, ink).lineLimit(1)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(shape.fill(fill))
        .overlay(shape.strokeBorder(line, lineWidth: theme.lines.hairline))
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(text)
    }
}

/// A thin outlined bar with a white fill and a dithered edge, plus a count.
struct SynqProgress: View {
    @Environment(\.synqTheme) private var theme
    let value: Int
    let total: Int
    var label: String? = nil

    var body: some View {
        HStack(spacing: theme.space.m) {
            GeometryReader { geo in
                let frac = total > 0 ? min(1, CGFloat(value) / CGFloat(total)) : 0
                let outlined = theme.looks.progress == .outlined
                let shape = RoundedRectangle(cornerRadius: outlined ? 2 : 4, style: .continuous)
                ZStack(alignment: .leading) {
                    if outlined {
                        shape.strokeBorder(theme.colors.line, lineWidth: theme.lines.hairline)
                    } else {
                        shape.fill(theme.colors.line)
                    }
                    Canvas { ctx, size in
                        let inset: CGFloat = outlined ? 2 : 0
                        let w = (size.width - inset * 2) * frac
                        ctx.fill(Path(CGRect(x: inset, y: inset, width: w, height: size.height - inset * 2)),
                                 with: .color(theme.colors.inkPrimary))
                        guard outlined, frac > 0, frac < 1 else { return }
                        // Ordered-dither fade past the fill.
                        let cell: CGFloat = 1.5
                        var x = inset + w
                        var col = 0
                        while x < min(size.width - inset, inset + w + 12) {
                            var y = inset, row = 0
                            while y < size.height - inset {
                                if (col + row) % (col < 3 ? 2 : (col < 6 ? 3 : 4)) == 0 {
                                    ctx.fill(Path(CGRect(x: x, y: y, width: cell, height: cell)), with: .color(theme.colors.inkPrimary))
                                }
                                y += cell; row += 1
                            }
                            x += cell; col += 1
                        }
                    }
                    .clipShape(shape)
                }
            }
            .frame(height: 8)
            if let label { Text(label).synqType(.caption, .secondary).fixedSize() }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label ?? "\(value) of \(total)")
        .accessibilityValue("\(value) of \(total)")
    }
}

/// An exact amount with its unit.
struct SynqAmount: View {
    @Environment(\.synqTheme) private var theme
    let amount: String
    let unit: String
    var large = true

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: theme.space.s) {
            Text(amount).synqType(large ? .amountLarge : .amountMedium).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.6)
            Text(unit).synqType(large ? .amountUnit : .caption, large ? .primary : .secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(amount) \(unit)")
    }
}

/// A rotating spinner: the theme's glyph frames or an arc.
struct SynqSpinner: View {
    @Environment(\.synqTheme) private var theme
    @Environment(\.synqRenderMode) private var mode
    var ink: SynqInk = .primary
    var size: CGFloat = 18

    var body: some View {
        Group {
            if let phase = mode.phase {
                frame(phase)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 12)) { tl in
                    frame((tl.date.timeIntervalSinceReferenceDate / 0.8).truncatingRemainder(dividingBy: 1))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Loading")
    }

    @ViewBuilder
    private func frame(_ t: Double) -> some View {
        let frames = theme.glyphs.spinner
        if !frames.isEmpty {
            Text(frames[Int(t * Double(frames.count)) % frames.count]).font(theme.type[.bodyStrong].font).foregroundStyle(theme.colors.ink(ink))
        } else {
            Circle().trim(from: 0.1, to: 0.75)
                .stroke(theme.colors.ink(ink), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(t * 360))
        }
    }
}

/// A scanning activity bar (searching): a bright segment sweeping across dots.
struct SynqScanBar: View {
    @Environment(\.synqTheme) private var theme
    @Environment(\.synqRenderMode) private var mode
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let phase = mode.phase {
                bar(phase)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 20, paused: reduceMotion || !theme.motion.shimmer)) { tl in
                    bar(reduceMotion ? 0.5 : (tl.date.timeIntervalSinceReferenceDate / 1.8).truncatingRemainder(dividingBy: 1))
                }
            }
        }
        .frame(height: 6)
        .accessibilityHidden(true)
    }

    private func bar(_ t: Double) -> some View {
        Canvas { ctx, size in
            let step: CGFloat = 5
            var x: CGFloat = 0
            while x < size.width {
                let d = abs(Double(x / size.width) - t)
                let on = d < 0.12
                let r: CGFloat = on ? 1.6 : 0.8
                ctx.fill(Path(ellipseIn: CGRect(x: x, y: size.height / 2 - r, width: r * 2, height: r * 2)),
                         with: .color(on ? theme.colors.inkPrimary : theme.colors.inkTertiary))
                x += step
            }
        }
    }
}

// MARK: - Avatars

enum SynqAvatarStatus { case none, approved, pending }

/// A member medallion: a deterministic pixel face (or initials) with a status mark.
struct SynqAvatar: View {
    @Environment(\.synqTheme) private var theme
    let id: String
    let name: String
    var status: SynqAvatarStatus = .none
    var size: CGFloat = 44

    var body: some View {
        ZStack {
            Circle().fill(theme.colors.background)
            if theme.looks.avatar == .pixel {
                PixelFace(seed: id.hashValueStable, ink: theme.colors.inkPrimary, dim: theme.colors.inkSecondary)
                    .padding(size * 0.06)
                    .clipShape(Circle())
            } else {
                Text(String(name.prefix(1)).uppercased()).font(.system(size: size * 0.4, weight: .bold, design: .rounded))
                    .foregroundStyle(theme.colors.inkPrimary)
            }
            Circle().strokeBorder(theme.colors.inkSecondary, lineWidth: theme.lines.hairline)
        }
        .frame(width: size, height: size)
        .overlay(alignment: .topTrailing) {
            switch status {
            case .approved: mark(.check)
            case .pending: mark(.clock)
            case .none: EmptyView()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(name + (status == .approved ? ", approved" : status == .pending ? ", pending" : ""))
    }

    private func mark(_ icon: SynqIcon) -> some View {
        let d = max(14, size * 0.36)
        return ZStack {
            Circle().fill(icon == .check ? theme.colors.accent : theme.colors.background)
            Circle().strokeBorder(theme.colors.inkPrimary, lineWidth: theme.lines.hairline)
            SynqIconView(icon: icon, size: d * 0.55, ink: icon == .check ? .onAccent : .primary)
        }
        .frame(width: d, height: d)
        .offset(x: d * 0.2, y: -d * 0.15)
    }
}

/// A 1-bit pixel portrait generated from a seed: head, hair, eyes, mouth, shoulders.
struct PixelFace: View {
    let seed: Int
    let ink: Color
    let dim: Color

    static let n = 24

    /// 0 empty, 1 ink, 2 dim (dither).
    static func grid(_ seed: Int) -> [[UInt8]] {
        var s = UInt64(truncatingIfNeeded: seed) &* 0x9E3779B97F4A7C15 | 1
        func r(_ k: Int) -> Int {
            s = s &* 6364136223846793005 &+ 1442695040888963407
            return Int((s >> 33) % UInt64(k))
        }
        let n = Self.n
        var g = [[UInt8]](repeating: [UInt8](repeating: 0, count: n), count: n)
        let hair = r(6), glasses = r(4) == 0, beard = r(5) == 0, smile = r(3), brows = r(2) == 0
        let cx = 11.5, cy = 10.5, rx = 4.6 + Double(r(3)) * 0.35, ry = 5.8
        func inHead(_ x: Double, _ y: Double, grow: Double = 0) -> Bool {
            let dx = (x - cx) / (rx + grow), dy = (y - cy) / (ry + grow)
            return dx * dx + dy * dy <= 1
        }
        func set(_ x: Int, _ y: Int, _ v: UInt8) { if x >= 0 && x < n && y >= 0 && y < n { g[y][x] = v } }
        for y in 0..<n {
            for x in 0..<n {
                let fx = Double(x) + 0.5, fy = Double(y) + 0.5
                // Shoulders with a V collar, dithered shirt.
                if fy > 18.6 {
                    let half = 6.5 + (fy - 18.6) * 1.6
                    if abs(fx - cx) < half {
                        let edge = abs(fx - cx) > half - 1 || fy < 19.6
                        let collar = abs(fx - cx) < (fy - 17.8) * 0.7 && fy < 22
                        g[y][x] = collar ? (abs(abs(fx - cx) - (fy - 17.8) * 0.7) < 0.9 ? 1 : 0) : (edge ? 1 : ((x + y) % 2 == 0 ? 2 : 0))
                    }
                }
                // Neck.
                if fy > 15.5 && fy < 19 && abs(fx - cx) < 2.2 && abs(fx - cx) > 1.2 { g[y][x] = 1 }
                // Head outline.
                if inHead(fx, fy) && (!inHead(fx - 1, fy) || !inHead(fx + 1, fy) || !inHead(fx, fy - 1) || !inHead(fx, fy + 1)) {
                    g[y][x] = 1
                }
                // Hair.
                let top = inHead(fx, fy, grow: 1.0) && fy < cy - ry * 0.32 + (hair == 1 ? (fx - cx) * 0.35 : 0)
                switch hair {
                case 0, 1: if top { g[y][x] = 1 }
                case 2:    // long
                    if top || (inHead(fx, fy, grow: 1.6) && !inHead(fx, fy) && fy < 17.5) { g[y][x] = 1 }
                case 3:    // bun
                    if top || hypot(fx - cx, fy - 2.6) < 2.1 { g[y][x] = 1 }
                case 4:    // curly
                    if inHead(fx, fy, grow: 1.7) && fy < cy - ry * 0.2 && (inHead(fx, fy, grow: 0.6) ? fy < cy - ry * 0.4 : true) {
                        g[y][x] = (x + 2 * y) % 3 == 0 ? 0 : 1
                    }
                default:   // cropped
                    if top { g[y][x] = (x + y) % 2 == 0 ? 1 : 2 }
                }
            }
        }
        let ey = Int(cy + 0.5), el = Int(cx - 2.2), er = Int(cx + 2.8)
        for e in [el, er] { set(e, ey, 1) }
        if brows { for e in [el, er] { set(e - 1, ey - 2, 1); set(e, ey - 2, 1) } }
        if glasses {
            for e in [el, er] {
                for x in (e - 1)...(e + 1) { set(x, ey - 1, 1); set(x, ey + 1, 1) }
                set(e - 1, ey, 1); set(e + 1, ey, 1)
            }
            set(Int(cx), ey, 1); set(Int(cx) + 1, ey, 1)
        }
        set(Int(cx + 0.5), ey + 2, 2)
        let my = ey + 4
        for x in (Int(cx) - 1)...(Int(cx) + 2) { set(x, my, 1) }
        if smile == 0 { set(Int(cx) - 2, my - 1, 1); set(Int(cx) + 3, my - 1, 1) }
        if beard {
            for y in (my - 1)...(my + 2) {
                for x in (Int(cx) - 3)...(Int(cx) + 4) where g[y][x] == 0 && inHead(Double(x) + 0.5, Double(y) + 0.5) && (x + y) % 2 == 0 {
                    g[y][x] = 2
                }
            }
        }
        // Ears.
        set(Int(cx - rx - 0.5), Int(cy + 0.5), 1); set(Int(cx + rx + 0.5), Int(cy + 0.5), 1)
        return g
    }

    var body: some View {
        Canvas { ctx, size in
            let g = Self.grid(seed)
            let p = size.width / CGFloat(Self.n)
            for y in 0..<Self.n {
                for x in 0..<Self.n where g[y][x] != 0 {
                    ctx.fill(Path(CGRect(x: CGFloat(x) * p, y: CGFloat(y) * p, width: p * 0.9, height: p * 0.9)),
                             with: .color(g[y][x] == 1 ? ink : dim))
                }
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}

/// Overlapping avatars for a row.
struct SynqAvatarStack: View {
    struct Person: Identifiable {
        let id: String
        let name: String
    }

    let people: [Person]
    var size: CGFloat = 34
    var limit = 4

    var body: some View {
        HStack(spacing: -size * 0.18) {
            ForEach(Array(people.prefix(limit))) { p in SynqAvatar(id: p.id, name: p.name, size: size) }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(people.map(\.name).joined(separator: ", "))
    }
}

// MARK: - Keypad

/// A 3×4 keypad editing a decimal amount (up to six decimals).
struct SynqKeypad: View {
    @Environment(\.synqTheme) private var theme
    @Binding var text: String

    private let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: theme.space.s), count: 3), spacing: theme.space.s) {
            ForEach(keys, id: \.self) { k in
                Button {
                    Haptics.tap()
                    press(k)
                } label: {
                    Group {
                        if k == "⌫" { SynqIconView(icon: .back, size: 20) } else { Text(k).synqType(.keypad) }
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(RoundedRectangle(cornerRadius: theme.radius.key, style: .continuous)
                        .fill(theme.looks.panelFilled ? theme.colors.panel : theme.colors.background))
                    .overlay(RoundedRectangle(cornerRadius: theme.radius.key, style: .continuous)
                        .strokeBorder(theme.colors.line, lineWidth: theme.lines.hairline))
                }
                .buttonStyle(SynqPressStyle())
                .accessibilityLabel(k == "⌫" ? "Delete" : k == "." ? "Decimal point" : k)
            }
        }
    }

    private func press(_ k: String) {
        switch k {
        case "⌫": if !text.isEmpty { text.removeLast() }
        case ".": if !text.contains(".") { text = (text.isEmpty ? "0" : text) + "." }
        default:
            if let dot = text.firstIndex(of: "."), text.distance(from: dot, to: text.endIndex) > 6 { return }
            if text.filter({ $0 != "." }).count >= 12 { return }
            text = text == "0" ? k : text + k
        }
    }
}

// MARK: - Tab bar

struct SynqTabBar: View {
    @Environment(\.synqTheme) private var theme
    let selected: SynqTab
    let onSelect: (SynqTab) -> Void

    var body: some View {
        VStack(spacing: 0) {
            SynqDivider()
            HStack(alignment: .center, spacing: 0) {
                ForEach(SynqTab.allCases) { tab in
                    Button {
                        Haptics.tap()
                        onSelect(tab)
                    } label: { item(tab) }
                    .buttonStyle(SynqPressStyle())
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(tab.spoken)
                    .accessibilityAddTraits(selected == tab ? .isSelected : [])
                }
            }
            .padding(.top, theme.space.s)
            .padding(.bottom, theme.space.xs)
        }
        .background(theme.colors.background)
    }

    @ViewBuilder
    private func item(_ tab: SynqTab) -> some View {
        let on = selected == tab
        if tab == .ask {
            Text(theme.copy.centreTab).synqType(.headline, on ? .onAccent : .primary)
                .frame(width: 48, height: 46)
                .background(RoundedRectangle(cornerRadius: theme.radius.control, style: .continuous)
                    .fill(on ? theme.colors.accent : theme.colors.background))
                .overlay(RoundedRectangle(cornerRadius: theme.radius.control, style: .continuous)
                    .strokeBorder(theme.colors.lineStrong, lineWidth: theme.lines.control))
        } else {
            VStack(spacing: 4) {
                SynqIconView(icon: icon(tab), size: 18, ink: on ? .primary : .tertiary)
                Text(theme.copy.tabs[tab] ?? tab.spoken).synqType(.tab, on ? .primary : .tertiary)
            }
            .frame(height: 46)
        }
    }

    private func icon(_ t: SynqTab) -> SynqIcon {
        switch t {
        case .home: return .home
        case .trips: return .trips
        case .ask: return .ask
        case .gifts: return .gift
        case .group: return .group
        }
    }
}

// MARK: - Card bubble (transcript)

/// What a transcript card shows; built by the screens from fund, payment and trip views.
struct SynqCardModel: Equatable {
    var art: SynqArtSlot
    var eyebrow: String
    var title: String
    var amount: String?
    var unit: String
    var detail: String
    var badge: SynqBadgeKind
    var status: String
    var progress: (Int, Int)?
    var network: String
    var accessibilityLabel: String

    static func == (a: SynqCardModel, b: SynqCardModel) -> Bool {
        a.title == b.title && a.amount == b.amount && a.status == b.status && a.detail == b.detail
            && a.progress?.0 == b.progress?.0 && a.progress?.1 == b.progress?.1 && a.network == b.network
    }
}

/// A live-layout transcript bubble: art strip, label, title, amount, status, network.
struct SynqCardBubble: View {
    @Environment(\.synqTheme) private var theme
    let model: SynqCardModel

    /// Bubble height for a width (MSMessagesAppViewController.contentSizeThatFits).
    static func height(forWidth w: CGFloat) -> CGFloat { min(250, (w - 24) / 120 * 1.8 * 12 + 148) }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: theme.radius.bubble, style: .continuous)
        VStack(alignment: .leading, spacing: 6) {
            SynqArtStrip(slot: model.art)
                .frame(maxWidth: .infinity)
                .padding(.bottom, 2)
            HStack(spacing: theme.space.s) {
                Text(model.eyebrow).synqType(.sectionLabel, .secondary).lineLimit(1)
                Spacer(minLength: 4)
                SynqBadge(kind: model.badge, text: model.status)
            }
            Text(model.title).synqType(.bodyStrong).lineLimit(1).minimumScaleFactor(0.7)
            if let amount = model.amount {
                SynqAmount(amount: amount, unit: model.unit, large: false)
            } else {
                Text(model.detail).synqType(.caption, .secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            HStack(spacing: theme.space.m) {
                if let p = model.progress {
                    SynqProgress(value: p.0, total: p.1, label: "\(p.0)/\(p.1)").frame(maxWidth: 140)
                } else if model.amount != nil {
                    Text(model.detail).synqType(.caption, .secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                Text(model.network.uppercased()).synqType(.caption, .tertiary).lineLimit(1)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(shape.fill(theme.colors.background))
        .overlay(shape.strokeBorder(theme.colors.line, lineWidth: theme.lines.hairline))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(model.accessibilityLabel)
    }
}

// Secure input cannot be captured by macOS ImageRenderer; previews show only its placeholder.
struct SynqPrivateCodeField: View {
    @Binding var text: String
    var body: some View {
#if os(iOS)
        SecureField("Private sign-in code from the web page", text: $text).synqType(.body).synqKeyboard(.codes)
#else
        Text("Private sign-in code from the web page").synqType(.body, .secondary)
#endif
    }
}
