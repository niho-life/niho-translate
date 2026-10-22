// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NIHOTranslate",
    platforms: [
        .iOS("15.5"),
        .macOS(.v13),
    ],
    products: [
        .library(name: "NIHOTranslateCore", targets: ["NIHOTranslateCore"]),
        .library(name: "NIHOTranslate", targets: ["NIHOTranslate"]),
    ],
    targets: [
        .target(
            name: "NIHOTranslateCore",
            path: "ios/Sources/NIHOTranslateCore"
        ),
        .target(
            name: "NIHOTranslate",
            dependencies: ["NIHOTranslateCore"],
            path: "ios/Sources/NIHOTranslate"
        ),
        .testTarget(
            name: "NIHOTranslateCoreTests",
            dependencies: ["NIHOTranslateCore"],
            path: "ios/Tests/NIHOTranslateCoreTests"
        ),
        .testTarget(
            name: "NIHOTranslateTests",
            dependencies: ["NIHOTranslate", "NIHOTranslateCore"],
            path: "ios/Tests/NIHOTranslateTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
