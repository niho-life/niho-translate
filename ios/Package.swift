// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NIHOTranslate",
    platforms: [.iOS("15.5"), .macOS(.v13)],
    products: [
        .library(name: "NIHOTranslateCore", targets: ["NIHOTranslateCore"]),
        .library(name: "NIHOTranslate", targets: ["NIHOTranslate"]),
    ],
    targets: [
        .target(name: "NIHOTranslateCore"),
        .target(name: "NIHOTranslate", dependencies: ["NIHOTranslateCore"]),
        .testTarget(name: "NIHOTranslateCoreTests", dependencies: ["NIHOTranslateCore"]),
        .testTarget(name: "NIHOTranslateTests", dependencies: ["NIHOTranslate", "NIHOTranslateCore"]),
    ],
    swiftLanguageVersions: [.v5]
)
