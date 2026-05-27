// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "LisaIsland",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "LisaIsland",
            path: "Sources/LisaIsland"
        )
    ]
)
