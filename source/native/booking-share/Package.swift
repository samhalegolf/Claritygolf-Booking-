// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "ClarityVideoShare",
    platforms: [.macOS(.v13), .iOS(.v15)],
    products: [
        .library(name: "ClarityVideoShare", targets: ["ClarityVideoShare"]),
        .executable(name: "ClarityBookingDesktop", targets: ["ClarityBookingDesktop"]),
    ],
    targets: [
        .target(name: "ClarityVideoShare"),
        .executableTarget(name: "ClarityBookingDesktop", dependencies: ["ClarityVideoShare"]),
        .testTarget(name: "ClarityVideoShareTests", dependencies: ["ClarityVideoShare"]),
    ]
)
