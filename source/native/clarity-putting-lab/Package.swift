// swift-tools-version: 5.9
import PackageDescription

// Clarity Putting Lab for the Clarity Booking staff app. Pulled in by
// `npx cap sync ios` from booking-app/ (see booking-app/package.json).
//
// Two targets on purpose:
//   - PuttingLabCore: the measurement engine. Foundation only, no Apple
//     frameworks, so every calibration, tracking and analysis rule is unit
//     tested on any machine with `swift test` (see README.md).
//   - ClarityPuttingLabPlugin: the iOS shell. AVFoundation capture, Core
//     Motion, the live screen and the Capacitor bridge. It feeds frames to the
//     core and draws what the core says; it measures nothing itself.
//
// The Capacitor product only exists on Apple platforms, so a Linux or CI
// `swift test` never has to resolve the Capacitor binary frameworks.

var products: [Product] = [
    .library(name: "PuttingLabCore", targets: ["PuttingLabCore"])
]
var dependencies: [Package.Dependency] = []
var targets: [Target] = [
    .target(name: "PuttingLabCore", path: "ios/Sources/PuttingLabCore"),
    .testTarget(
        name: "PuttingLabCoreTests",
        dependencies: ["PuttingLabCore"],
        path: "ios/Tests/PuttingLabCoreTests")
]

#if !os(Linux)
products.append(
    .library(name: "ClaritygolfCapacitorPuttingLab", targets: ["ClarityPuttingLabPlugin"]))
dependencies.append(
    .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"))
targets.append(
    .target(
        name: "ClarityPuttingLabPlugin",
        dependencies: [
            "PuttingLabCore",
            .product(name: "Capacitor", package: "capacitor-swift-pm"),
            .product(name: "Cordova", package: "capacitor-swift-pm")
        ],
        path: "ios/Sources/ClarityPuttingLabPlugin"))
#endif

let package = Package(
    name: "ClaritygolfCapacitorPuttingLab",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: products,
    dependencies: dependencies,
    targets: targets
)
