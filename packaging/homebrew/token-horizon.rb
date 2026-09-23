# Homebrew Cask for Token Horizon.
#
# This file lives in-repo as the source of truth. The published tap is
#   https://github.com/castlemilk/homebrew-tap  (tap name: castlemilk/tap)
#
# Per release: `scripts/release.sh` (task release) bumps `version` at tag
# time; the release workflow fills in `sha256` from the built zip and pushes
# this file to the tap automatically (manual fallback: task brew-sync).
#
# Users install with:
#   brew tap castlemilk/tap
#   brew install --cask token-horizon
cask "token-horizon" do
  version "0.3.9"
  sha256 "82c523d0f8721a825e2ce86cf24e3d96e00dd86e8727982ad05fcba5f7464dfb"

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
  # dev-installed copy on uninstall). Done as a user-level script on purpose:
  # Homebrew 7's `uninstall launchctl:`/`delete:` stanzas always probe the
  # system launchd domain and remove files under sudo, which turns every
  # upgrade into a password prompt. `launchctl bootout` in the user domain
  # plus the plist removal is all that's needed and needs no root.
  uninstall script: {
              executable: "/bin/sh",
              args:       ["-c", "launchctl bootout gui/$(id -u)/local.benebsworth.token-horizon 2>/dev/null; rm -f \"$HOME/Library/LaunchAgents/local.benebsworth.token-horizon.plist\"; exit 0"],
            }

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
