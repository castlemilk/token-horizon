import AppKit
import TokenHorizonCore

// A cancelled client mid-stream must never SIGPIPE the app.
ignoreSIGPIPE()

// Self-management CLI (portable crash-recovery + identity, no repo scripts):
// the installed bundle maintains its own LaunchAgent wherever it lives.
if CommandLine.arguments.contains("--install-launch-agent") { exit(LaunchAgentCtl.install()) }
if CommandLine.arguments.contains("--uninstall-launch-agent") { exit(LaunchAgentCtl.uninstall()) }
if CommandLine.arguments.contains("--agent-status") { exit(LaunchAgentCtl.status()) }

// Headless catalog export for the web model explorer (`task models-refresh`).
if let idx = CommandLine.arguments.firstIndex(of: "--export-model-catalog") {
    let next = CommandLine.arguments.indices.contains(idx + 1) ? CommandLine.arguments[idx + 1] : ""
    let path = next.isEmpty || next.hasPrefix("--") ? "models-catalog.json" : next
    exit(ModelCatalogExport.runCLI(path: path, refresh: CommandLine.arguments.contains("--refresh")))
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
