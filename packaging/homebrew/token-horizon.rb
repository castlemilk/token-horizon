# Homebrew Cask for Token Horizon.
#
# This file lives in-repo as the source of truth. To publish it, copy it into
# a tap repo (one time):
#
#   gh repo create castlemilk/homebrew-tap --public --description "Homebrew tap for Token Horizon"
#   mkdir -p homebrew-tap/Casks && cp packaging/homebrew/token-horizon.rb homebrew-tap/Casks/
#   cd homebrew-tap && git add . && git commit -m "token-horizon 0.2.0" && git push -u origin main
#
# Users then install with:
#   brew tap castlemilk/tap
#   brew install --cask token-horizon
#
# On each release, bump `version` + `sha256` below (match dist/TokenHorizon-<ver>.sha256).
cask "token-horizon" do
  version "0.3.0"
  sha256 "fb816ba5e8a537db6a0902ca8c126b6b7085d8306cdb4829af50c8b2ddcf348f"

  url "https://github.com/castlemilk/token-horizon/releases/download/v#{version}/TokenHorizon-#{version}.zip"
  name "Token Horizon"
  desc "Native macOS notch dashboard for AI token usage, costs, and plan limits"
  homepage "https://token-horizon.dev/"

  auto_updates false
  depends_on macos: ">= :sonoma"
  depends_on arch: :arm64

  app "TokenHorizon.app"

  uninstall launchctl: "local.benebsworth.token-horizon",
            delete:    "/Applications/TokenHorizon.app"

  zap trash: [
    "~/.config/token-horizon",
    "~/Library/Logs/TokenHorizon.log",
  ]

  caveats <<~EOS
    First launch: approve Token Horizon in Privacy & Security if macOS asks
    (preview builds carry an ad-hoc signature).
    Crash auto-recovery is managed by the app itself:
      /Applications/TokenHorizon.app/Contents/MacOS/TokenHorizon --agent-status
  EOS
end
