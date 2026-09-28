// swift-tools-version: 5.9
import PackageDescription

// Tap to Pay on iPhone for Clarity Booking. Pulled into the staff app by
// `npx cap sync ios` from booking-app/ (see booking-app/package.json); the
// Player app never lists it, so it never ships there.
let package = Package(
    name: "ClarityTerminal",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "ClarityTerminal",
            targets: ["ClarityTerminalPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/stripe/stripe-terminal-ios-spm", from: "5.0.0")
    ],
    targets: [
        .target(
            name: "ClarityTerminalPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "StripeTerminal", package: "stripe-terminal-ios-spm")
            ],
            path: "ios/Sources/ClarityTerminalPlugin")
    ]
)
