# Homebrew Cask for Token Horizon.
#
# This file lives in-repo as the source of truth. The published tap is
#   https://github.com/castlemilk/homebrew-tap  (tap name: castlemilk/tap)
#
# Per release: bump `version` + `sha256` here (match
# dist/TokenHorizon-<ver>.sha256, or the release's .sha256 asset) and run
#   task brew-sync            # scripts/sync-homebrew-tap.sh
# to copy this file into the tap and push it.
#
# Users install with:
#   brew tap castlemilk/tap
#   brew install --cask token-horizon
cask "token-horizon" do
  version "0.3.1"
  sha256 "6162726bc74f5add353da78374a20b15f7127bce50734df27bab63dd7a245a29"

  url "https://github.com/castlemilk/token-horizon/releases/download/v#{version}/TokenHorizon-#{version}.zip"
  name "Token Horizon"
  desc "Native macOS notch dashboard for AI token usage, costs, and plan limits"
  homepage "https://token-horizon.dev/"

  auto_updates false
  depends_on macos: :sonoma
  depends_on arch: :arm64

  app "TokenHorizon.app"

  # The `app` artifact handles removal; only the LaunchAgent needs an explicit
  # cleanup (deleting /Applications/TokenHorizon.app here would nuke a
  # dev-installed copy on uninstall).
  uninstall launchctl: "local.benebsworth.token-horizon",
            delete:    "~/Library/LaunchAgents/local.benebsworth.token-horizon.plist"

  zap trash: [
    "~/.config/token-horizon",
    "~/Library/Logs/TokenHorizon.log",
  ]

  caveats <<~EOS
    Token Horizon is Developer ID signed and Apple-notarized.
    Crash auto-recovery is managed by the app itself:
      /Applications/TokenHorizon.app/Contents/MacOS/TokenHorizon --agent-status
  EOS
end
