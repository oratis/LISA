// swift-tools-version:5.9
import PackageDescription

// Warnings are errors (review T-11): the Mac shell shipped several releases with
// the same handful of warnings, and Swift 6 strict concurrency turns that class
// of warning into hard errors anyway — so keep the count pinned at zero here.
// `unsafeFlags` is acceptable because this package is only ever built as the
// root package (`swift build`, build.sh, scripts/build-mac-apps.sh), never
// consumed as a dependency.
let strict: [SwiftSetting] = [.unsafeFlags(["-warnings-as-errors"])]

let package = Package(
    name: "Lisa",
    platforms: [.macOS(.v13)],
    targets: [
        // Pure, AppKit-free logic (the backend install wizard's decisions,
        // probe/install scripts, failure classification) — unit-tested with
        // `swift test` without booting the app.
        .target(
            name: "LisaSetup",
            path: "Sources/LisaSetup",
            swiftSettings: strict
        ),
        .executableTarget(
            name: "Lisa",
            dependencies: ["LisaSetup"],
            path: "Sources/Lisa",
            swiftSettings: strict
        ),
        .testTarget(
            name: "LisaSetupTests",
            dependencies: ["LisaSetup"],
            path: "Tests/LisaSetupTests",
            swiftSettings: strict
        ),
    ]
)
