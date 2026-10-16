#!/bin/sh
# Syntax-checks every Swift file, type-checks the SwiftUI code for macOS (the same
# views render the design previews), and runs the Foundation-only model and
# command-parser checks. Building the extension itself needs Xcode and the iOS SDK.
set -eu
cd "$(dirname "$0")"
swiftc -parse SynqMessagesExtension/*.swift Checks/*.swift
# Everything except the Messages controller (UIKit/Messages only) must compile for macOS.
views=$(ls SynqMessagesExtension/*.swift | grep -v MessagesViewController.swift)
xcrun swiftc -typecheck -parse-as-library -target arm64-apple-macos14 $views Design/Samples.swift Design/render.swift
out="${TMPDIR:-/tmp}/synq-native-card-check.$$"
swiftc -O SynqMessagesExtension/SynqCard.swift SynqMessagesExtension/CardLink.swift \
  SynqMessagesExtension/Fund.swift SynqMessagesExtension/QuickParse.swift \
  Checks/main.swift Checks/ParserChecks.swift -o "$out"
"$out" Checks/native-card-fixture.json
rm -f "$out"
# Screens style only through the themed components (see THEMING.md): no colours,
# fonts, radii, raw symbols, bracket glyphs or art outside the theme layer.
screens="SynqMessagesExtension/FundViews.swift SynqMessagesExtension/DetailViews.swift SynqMessagesExtension/Sheets.swift SynqMessagesExtension/CardViews.swift SynqMessagesExtension/FundCards.swift"
if grep -nE 'Color[.(]|\.font\(|cornerRadius|RoundedRectangle|Capsule\(|Image\(systemName|\.foregroundStyle\(|\.system\(|AsciiArt|"\[|\]"|"\{|\}"' $screens; then
  echo "theming: screens must use SynqTheme components, not raw styling" >&2
  exit 1
fi
plutil -lint SynqMessages/Info.plist SynqMessagesExtension/Info.plist SynqMessages.xcodeproj/project.pbxproj
