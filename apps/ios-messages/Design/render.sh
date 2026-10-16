#!/bin/sh
# Renders design previews into $1 (screens, bubbles, cards, art) with theme $2
# (default: the app's default theme, which also rewrites the app icons in the
# asset catalog), from the extension's own SwiftUI views (everything except the
# Messages controller, which needs UIKit) plus Design/Samples.swift.
#   sh Design/render.sh <out-dir> [ascii|holo]
set -eu
cd "$(dirname "$0")/.."
out="${1:-${TMPDIR:-/tmp}/synq-design}"
theme="${2:-ascii}"
icons="SynqMessages/Assets.xcassets/iMessage App Icon.stickersiconset"
bin="${TMPDIR:-/tmp}/synq-render.$$"
xcrun swiftc -O -parse-as-library -target arm64-apple-macos14 \
  $(ls SynqMessagesExtension/*.swift | grep -v MessagesViewController.swift) \
  Design/Samples.swift Design/render.swift -o "$bin"
"$bin" "$out" "$icons" "$theme"
rm -f "$bin"
