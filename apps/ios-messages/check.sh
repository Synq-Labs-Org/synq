#!/bin/sh
# Syntax-checks every Swift file, builds and tests the SynqShared package for
# macOS (the same views render the design previews), type-checks the previews,
# runs the Foundation-only model and command-parser checks, checks the copied
# API contract against the generated one, and lints theming. Building the app
# and the extension needs Xcode and the iOS SDK (see THEMING.md).
set -eu
cd "$(dirname "$0")"
shared=$(find SynqShared/Sources/SynqShared -name '*.swift')
swiftc -parse SynqShared/Sources/SynqContracts/*.swift $shared SynqMessagesExtension/*.swift $(find SynqApp -name '*.swift' 2>/dev/null) Checks/*.swift

# The contract is generated in packages/contracts and copied verbatim.
cmp -s SynqShared/Sources/SynqContracts/SynqContracts.swift ../../packages/contracts/generated/swift/SynqContracts.swift || {
  echo "contract: SynqShared/Sources/SynqContracts/SynqContracts.swift differs from packages/contracts/generated/swift; copy it again (never edit it)" >&2
  exit 1
}

work="${TMPDIR:-/tmp}/synq-check.$$"
trap 'rm -rf "$work"' EXIT
# Package build and unit tests (macOS).
(cd SynqShared && swift build --scratch-path "$work/spm" -q && swift test --scratch-path "$work/spm" -q)
# Preview sources compile in one module with the shared code.
sh Design/contracts-module.sh "$work/contracts"
xcrun swiftc -typecheck -parse-as-library -target arm64-apple-macos14 -I "$work/contracts" $shared Design/Samples.swift Design/render.swift Design/render-app.swift

m=SynqShared/Sources/SynqShared/DomainModels
swiftc -O $m/SynqCard.swift $m/CardLink.swift $m/Fund.swift $m/QuickParse.swift $m/Business.swift \
  Checks/main.swift Checks/ParserChecks.swift -o "$work/native-card-check"
"$work/native-card-check" Checks/native-card-fixture.json

# Screens style only through the themed components (see THEMING.md): no colours,
# fonts, radii, raw symbols, bracket glyphs or art outside the theme layer.
screens=$(find SynqShared/Sources/SynqShared/Features -name '*.swift')
if grep -nE 'Color[.(]|\.font\(|cornerRadius|RoundedRectangle|Capsule\(|Image\(systemName|\.foregroundStyle\(|\.system\(|AsciiArt|"\[|\]"|"\{|\}"' $screens; then
  echo "theming: screens must use SynqTheme components, not raw styling" >&2
  exit 1
fi
# No signing material in app code: private keys, seed phrases, wallet/provider
# secrets or live API keys never ship in the app or the extension.
app_code="SynqShared/Sources SynqMessagesExtension"; [ -d SynqApp ] && app_code="$app_code SynqApp"
if grep -rniE 'BEGIN (EC |RSA )?PRIVATE KEY|mnemonic|seed ?phrase|entity ?secret|private ?key *[:=]|sk_live_|api[_-]?key *[:=] *"' $app_code; then
  echo "secrets: signing material or live keys found in app sources" >&2
  exit 1
fi
plutil -lint SynqMessages/Info.plist SynqMessagesExtension/Info.plist SynqMessages.xcodeproj/project.pbxproj $(ls SynqApp/*.plist SynqApp/*.entitlements 2>/dev/null)
