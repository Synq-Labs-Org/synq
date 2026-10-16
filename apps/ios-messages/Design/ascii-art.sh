#!/bin/sh
# Regenerates SynqMessagesExtension/AsciiArtData.swift from the procedural scenes in
# Design/ascii-art.swift; with an argument, also writes a preview PNG per piece there.
set -eu
cd "$(dirname "$0")/.."
bin="${TMPDIR:-/tmp}/synq-ascii-art.$$"
xcrun swiftc -O Design/ascii-art.swift -o "$bin"
"$bin" "$@"
rm -f "$bin"
