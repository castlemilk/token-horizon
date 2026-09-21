// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "token-horizon",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/open-telemetry/opentelemetry-swift-core.git", exact: "2.3.0"),
        .package(url: "https://github.com/open-telemetry/opentelemetry-swift.git", exact: "2.3.0")
    ],
    targets: [
        .executableTarget(
            name: "TokenHorizon",
            dependencies: [
                .product(name: "OpenTelemetryApi", package: "opentelemetry-swift-core"),
                .product(name: "OpenTelemetrySdk", package: "opentelemetry-swift-core"),
                .product(name: "PrometheusExporter", package: "opentelemetry-swift"),
                .product(name: "OpenTelemetryProtocolExporterHTTP", package: "opentelemetry-swift")
            ],
            path: "Sources/TokenHorizon"
        ),
        .testTarget(
            name: "TokenHorizonPerfTests",
            dependencies: ["TokenHorizon"],
            path: "Tests/TokenHorizonPerfTests",
            resources: [.copy("Fixtures")]
        )
    ]
)
