#!/bin/sh
# Renders the app icons into the asset catalog and design previews into $1, from
# the extension's own SwiftUI views (everything except the Messages controller,
# which needs UIKit) plus Design/Samples.swift.
set -eu
cd "$(dirname "$0")/.."
out="${1:-${TMPDIR:-/tmp}/synq-design}"
icons="SynqMessages/Assets.xcassets/iMessage App Icon.stickersiconset"
bin="${TMPDIR:-/tmp}/synq-render.$$"
xcrun swiftc -O -parse-as-library -target arm64-apple-macos14 \
  $(ls SynqMessagesExtension/*.swift | grep -v MessagesViewController.swift) \
  Design/Samples.swift Design/render.swift -o "$bin"
"$bin" "$out" "$icons"
rm -f "$bin"
