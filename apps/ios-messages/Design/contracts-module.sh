#!/bin/sh
# Builds the generated SynqContracts module for macOS into $1 so the design
# previews and checks can compile the SynqShared sources directly with swiftc
# (they `import SynqContracts`). Prints nothing; callers pass -I/-L $1.
set -eu
dir="$1"
mkdir -p "$dir"
xcrun swiftc -parse-as-library -target arm64-apple-macos14 -module-name SynqContracts \
  -emit-library -static -emit-module -emit-module-path "$dir/SynqContracts.swiftmodule" \
  SynqShared/Sources/SynqContracts/SynqContracts.swift -o "$dir/libSynqContracts.a"
