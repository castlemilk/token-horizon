#!/bin/bash
# Install the HTTP client independently of the desktop app or shell hooks.
set -euo pipefail
CLI_SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_HELPER_DIR="${TOKEN_HORIZON_CLI_DIR:-$HOME/.config/token-horizon/shell}"
CLI_BIN_DIR="${TOKEN_HORIZON_BIN_DIR:-$HOME/.local/bin}"

# Do not overwrite an unrelated executable or link.
for cli_name in token-horizon th; do
    cli_link="$CLI_BIN_DIR/$cli_name"
    if [ -e "$cli_link" ] || [ -L "$cli_link" ]; then
        if [ ! -L "$cli_link" ] || [ "$(readlink "$cli_link")" != "$CLI_HELPER_DIR/token-horizon" ]; then
            echo "Cannot install: $cli_link already exists and is not this CLI's link." >&2
            exit 1
        fi
    fi
done

mkdir -p "$CLI_HELPER_DIR" "$CLI_BIN_DIR"
CLI_INSTALL_STAGE="$(mktemp -d "$CLI_HELPER_DIR/.cli-install.XXXXXX")"
trap 'rm -rf "$CLI_INSTALL_STAGE"' EXIT
install -m 644 "$CLI_SOURCE_ROOT/shell/token-horizon.zsh" "$CLI_INSTALL_STAGE/token-horizon.zsh"
install -m 755 "$CLI_SOURCE_ROOT/shell/token-horizon" "$CLI_INSTALL_STAGE/token-horizon"
mv -f "$CLI_INSTALL_STAGE/token-horizon.zsh" "$CLI_HELPER_DIR/token-horizon.zsh"
mv -f "$CLI_INSTALL_STAGE/token-horizon" "$CLI_HELPER_DIR/token-horizon"
for cli_name in token-horizon th; do
    cli_link="$CLI_BIN_DIR/$cli_name"
    if [ ! -L "$cli_link" ]; then ln -s "$CLI_HELPER_DIR/token-horizon" "$cli_link"; fi
    echo "Installed $cli_link"
done
case ":$PATH:" in
    *":$CLI_BIN_DIR:"*) ;;
    *) echo "Add $CLI_BIN_DIR to PATH to use token-horizon and th." ;;
esac
