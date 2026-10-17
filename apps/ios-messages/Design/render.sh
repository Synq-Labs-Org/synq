#!/bin/sh
# Renders design previews into $1 (screens, bubbles, cards, art) with theme $2
# (default: the app's default theme, which also rewrites the app icons in the
# asset catalog), from the shared SwiftUI views in the SynqShared package plus
# Design/Samples.swift. Everything is compiled as one macOS module so the
# previews can use the views' memberwise initialisers.
#   sh Design/render.sh <out-dir> [ascii|paper|holo]
set -eu
cd "$(dirname "$0")/.."
out="${1:-${TMPDIR:-/tmp}/synq-design}"
theme="${2:-ascii}"
icons="SynqMessages/Assets.xcassets/iMessage App Icon.stickersiconset"
work="${TMPDIR:-/tmp}/synq-render.$$"
sh Design/contracts-module.sh "$work"
xcrun swiftc -O -parse-as-library -target arm64-apple-macos14 -I "$work" -L "$work" -lSynqContracts \
  $(find SynqShared/Sources/SynqShared -name '*.swift') \
  Design/Samples.swift Design/render.swift Design/render-app.swift -o "$work/render"
"$work/render" "$out" "$icons" "$theme"
rm -rf "$work"
