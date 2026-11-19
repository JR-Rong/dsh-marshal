// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MarshalStream",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "MarshalStream",
            targets: ["MarshalStreamPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "MarshalStreamPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/MarshalStreamPlugin")
    ]
)
