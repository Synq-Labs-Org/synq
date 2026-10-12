#!/bin/sh
# Syntax-checks every Swift file and runs the Foundation-only model checks on macOS.
# Building the extension itself needs full Xcode and the iOS SDK (see docs/runbooks/ios-messages-device.md).
set -eu
cd "$(dirname "$0")"
swiftc -parse SynqMessagesExtension/*.swift Checks/main.swift
out="${TMPDIR:-/tmp}/synq-native-card-check.$$"
swiftc -O SynqMessagesExtension/SynqCard.swift SynqMessagesExtension/CardLink.swift Checks/main.swift -o "$out"
"$out" Checks/native-card-fixture.json
rm -f "$out"
plutil -lint SynqMessages/Info.plist SynqMessagesExtension/Info.plist SynqMessages.xcodeproj/project.pbxproj
