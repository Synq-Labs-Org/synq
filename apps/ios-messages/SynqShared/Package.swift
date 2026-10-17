// swift-tools-version: 5.9
import PackageDescription

// Code shared by the Synq iOS app and its Messages extension: the design system
// (themes, components, fonts), domain models, API clients, the native session,
// service ports and every portable screen. The two Xcode targets are thin hosts:
// the extension owns MessagesViewController and MSMessage insertion, the app owns
// its @main entry, push registration and the platform port implementations.
//
// `SynqContracts` is the generated v3 API contract, copied verbatim from
// packages/contracts/generated/swift (check.sh fails if the copy drifts).
let package = Package(
    name: "SynqShared",
    defaultLocalization: "en",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "SynqShared", targets: ["SynqShared"]),
        .library(name: "SynqContracts", targets: ["SynqContracts"]),
    ],
    targets: [
        .target(name: "SynqContracts"),
        .target(
            name: "SynqShared",
            dependencies: ["SynqContracts"],
            resources: [.process("DesignSystem/Fonts")]
        ),
        .testTarget(name: "SynqSharedTests", dependencies: ["SynqShared", "SynqContracts"]),
    ]
)
