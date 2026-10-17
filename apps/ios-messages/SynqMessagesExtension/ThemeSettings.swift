import SwiftUI

// Settings → Theme: every shipped theme, previewed in its own look. The choice is
// kept on this device and applies at once to every screen, sheet and bubble.

struct ThemeSheet: View {
    let onClose: () -> Void
    @AppStorage(SynqThemes.storageKey) private var themeId = SynqThemes.all[0].id

    var body: some View {
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
struct ThemeOption: View {
    let option: any SynqTheme
    let selected: Bool
    let onPick: () -> Void

    var body: some View {
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
