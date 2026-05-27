// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Lisa",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Lisa",
            path: "Sources/Lisa"
        )
    ]
)
