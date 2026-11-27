#!/usr/bin/env bash
set -euo pipefail

export PLAYWRIGHT_BROWSERS_PATH="$RUNNER_TEMP/studio-native-browsers"
printf 'PLAYWRIGHT_BROWSERS_PATH=%s\n' "$PLAYWRIGHT_BROWSERS_PATH" >> "$GITHUB_ENV"

# Playwright installs Chromium's dependencies through sudo. Scope apt to the
# Ubuntu sources for this step, including inside Playwright's elevated shell.
ubuntu_sources=/etc/apt/sources.list.d/ubuntu.sources
apt_config=/etc/apt/apt.conf.d/99-agentkit-studio-playwright
test -r "$ubuntu_sources"
sudo tee "$apt_config" >/dev/null <<APT
Dir::Etc::sourcelist "$ubuntu_sources";
Dir::Etc::sourceparts "-";
APT
trap 'sudo unlink "$apt_config"' EXIT

if [[ "${1:-}" == true ]]; then
  pnpm exec playwright install-deps chromium
else
  pnpm exec playwright install --with-deps chromium
fi
