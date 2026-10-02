// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "LashKirjaCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "LashKirjaCore", targets: ["LashKirjaCore"])],
    targets: [
        .target(name: "LashKirjaCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "LashKirjaCoreTests", dependencies: ["LashKirjaCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
