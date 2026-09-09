// swift-tools-version:5.9
import PackageDescription

// Token Horizon is split into:
//   TokenHorizonCore        — portable server-side engine (all platforms)
//   TokenHorizon            — macOS app (AppKit/SwiftUI UI, Network.framework server)
//   token-horizon-headless  — cross-platform daemon serving the :8765 loopback API
//   CSQLite                 — system SQLite3 shim where Swift lacks a SQLite3 module

var products: [Product] = [
    .library(name: "TokenHorizonCore", targets: ["TokenHorizonCore"]),
]
var targets: [Target] = []
var coreDeps: [Target.Dependency] = []
var packageDeps: [Package.Dependency] = []

#if !os(macOS)
// macOS provides `import SQLite3` from the SDK; Linux/Windows use this shim
// (requires sqlite3 development headers, e.g. `apt install libsqlite3-dev`).
targets.append(.systemLibrary(name: "CSQLite", path: "Sources/CSQLite"))
coreDeps.append("CSQLite")
#endif

#if os(macOS)
// OpenTelemetry SDK is currently validated on macOS only; TokenHorizonCore
// compiles a no-op TokenHorizonTelemetry elsewhere (see TelemetryMetrics.swift).
packageDeps += [
    .package(url: "https://github.com/open-telemetry/opentelemetry-swift-core.git", exact: "2.3.0"),
    .package(url: "https://github.com/open-telemetry/opentelemetry-swift.git", exact: "2.3.0"),
]
coreDeps += [
    .product(name: "OpenTelemetryApi", package: "opentelemetry-swift-core"),
    .product(name: "OpenTelemetrySdk", package: "opentelemetry-swift-core"),
    .product(name: "PrometheusExporter", package: "opentelemetry-swift"),
    .product(name: "OpenTelemetryProtocolExporterHTTP", package: "opentelemetry-swift"),
]
#endif

targets.append(.target(
    name: "TokenHorizonCore",
    dependencies: coreDeps,
    path: "Sources/TokenHorizonCore"
))

#if !os(Windows)
// Headless daemon: same loopback API as the macOS app, no UI.
products.append(.executable(name: "token-horizon-headless", targets: ["token-horizon-headless"]))
targets.append(.executableTarget(
    name: "token-horizon-headless",
    dependencies: ["TokenHorizonCore"],
    path: "Sources/token-horizon-headless"
))
#endif

#if os(macOS)
products.append(.executable(name: "TokenHorizon", targets: ["TokenHorizon"]))
targets.append(.executableTarget(
    name: "TokenHorizon",
    dependencies: ["TokenHorizonCore"],
    path: "Sources/TokenHorizon"
))
targets.append(.testTarget(
    name: "TokenHorizonPerfTests",
    dependencies: ["TokenHorizon", "TokenHorizonCore"],
    path: "Tests/TokenHorizonPerfTests",
    resources: [.copy("Fixtures")]
))
#endif

let package = Package(
    name: "token-horizon",
    platforms: [.macOS(.v13)],
    products: products,
    dependencies: packageDeps,
    targets: targets
)
