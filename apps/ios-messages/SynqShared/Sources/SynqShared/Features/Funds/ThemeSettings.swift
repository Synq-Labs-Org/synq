import SwiftUI

// Settings → Theme: every shipped theme, previewed in its own look. The choice is
// kept on this device and applies at once to every screen, sheet and bubble.

public struct ThemeSheet: View {
    public let onClose: () -> Void
    @AppStorage(SynqThemes.storageKey) private var themeId = SynqThemes.defaultId

    public var body: some View {
        SynqThemeRoot {
            SheetScaffold(title: "Theme", onCancel: onClose) {
                SynqStack(spacing: \.m) {
                    Text("Choose how Synq looks on this device. Amounts, networks and approvals read the same in every theme.")
                        .synqType(.body, .secondary)
                    ForEach(SynqThemes.all, id: \.id) { option in
                        ThemeOption(option: option, selected: option.id == SynqThemes.named(themeId).id) {
                            themeId = option.id
                        }
                    }
                }
            }
        }
    }
}

/// One theme, drawn with that theme's own tokens and art.
public struct ThemeOption: View {
    public let option: any SynqTheme
    public let selected: Bool
    public let onPick: () -> Void

    public var body: some View {
        SynqGroup(emphasis: selected) {
            SynqArtStrip(slot: .home)
            SynqRow(title: option.name, subtitle: option.summary,
                    trailing: selected ? .badge(.approved, "In use") : .arrow, divider: true, action: onPick)
        }
        .environment(\.synqTheme, option)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(option.name) theme. \(option.summary)")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
