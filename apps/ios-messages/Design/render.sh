#!/bin/sh
# Renders the app icons into the asset catalog and design previews into $1.
set -eu
cd "$(dirname "$0")/.."
out="${1:-${TMPDIR:-/tmp}/synq-design}"
icons="SynqMessages/Assets.xcassets/iMessage App Icon.stickersiconset"
bin="${TMPDIR:-/tmp}/synq-render.$$"
xcrun swiftc -O -parse-as-library -target arm64-apple-macos14 \
  SynqMessagesExtension/Chrome.swift Design/render.swift -o "$bin"
"$bin" "$out" "$icons"
rm -f "$bin"
