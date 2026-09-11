import AppKit

// Self-management CLI (portable crash-recovery + identity, no repo scripts):
// the installed bundle maintains its own LaunchAgent wherever it lives.
if CommandLine.arguments.contains("--install-launch-agent") { exit(LaunchAgentCtl.install()) }
if CommandLine.arguments.contains("--uninstall-launch-agent") { exit(LaunchAgentCtl.uninstall()) }
if CommandLine.arguments.contains("--agent-status") { exit(LaunchAgentCtl.status()) }

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
