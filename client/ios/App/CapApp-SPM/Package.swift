// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.0"),
        .package(name: "CapacitorAppLauncher", path: "../../../node_modules/@capacitor/app-launcher"),
        .package(name: "CapacitorDevice", path: "../../../node_modules/@capacitor/device"),
        .package(name: "CapacitorDialog", path: "../../../node_modules/@capacitor/dialog"),
        .package(name: "CapacitorFileTransfer", path: "../../../node_modules/@capacitor/file-transfer"),
        .package(name: "CapacitorFilesystem", path: "../../../node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorNetwork", path: "../../../node_modules/@capacitor/network"),
        .package(name: "CapacitorPreferences", path: "../../../node_modules/@capacitor/preferences"),
        .package(name: "CapawesomeCapacitorTorch", path: "../../../node_modules/@capawesome/capacitor-torch"),
        .package(name: "CapgoCapacitorPermissions", path: "../../../node_modules/@capgo/capacitor-permissions"),
        .package(name: "CapgoCapacitorSpeechSynthesis", path: "../../../node_modules/@capgo/capacitor-speech-synthesis"),
        .package(name: "PinecallIonic", path: "../../../node_modules/@pinecall/ionic"),
        .package(name: "CapacitorLancedb", path: "../../../node_modules/capacitor-lancedb"),
        .package(name: "CapacitorMobilecron", path: "../../../node_modules/capacitor-mobilecron"),
        .package(name: "CapacitorNativeAgent", path: "../../../node_modules/capacitor-native-agent"),
        .package(name: "LlamaCppCapacitor", path: "../../../node_modules/llama-cpp-capacitor")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapacitorAppLauncher", package: "CapacitorAppLauncher"),
                .product(name: "CapacitorDevice", package: "CapacitorDevice"),
                .product(name: "CapacitorDialog", package: "CapacitorDialog"),
                .product(name: "CapacitorFileTransfer", package: "CapacitorFileTransfer"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorNetwork", package: "CapacitorNetwork"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences"),
                .product(name: "CapawesomeCapacitorTorch", package: "CapawesomeCapacitorTorch"),
                .product(name: "CapgoCapacitorPermissions", package: "CapgoCapacitorPermissions"),
                .product(name: "CapgoCapacitorSpeechSynthesis", package: "CapgoCapacitorSpeechSynthesis"),
                .product(name: "PinecallIonic", package: "PinecallIonic"),
                .product(name: "CapacitorLancedb", package: "CapacitorLancedb"),
                .product(name: "CapacitorMobilecron", package: "CapacitorMobilecron"),
                .product(name: "CapacitorNativeAgent", package: "CapacitorNativeAgent"),
                .product(name: "LlamaCppCapacitor", package: "LlamaCppCapacitor")
            ]
        )
    ]
)
