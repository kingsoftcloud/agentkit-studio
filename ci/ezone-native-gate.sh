#!/usr/bin/env bash
# Exact Ezone commit, real Chromium and an isolated process owner.
set -euo pipefail
expected="${SYS_BUILD_COMMIT:?Ezone must supply the immutable build commit}"
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid build commit' >&2; exit 2; }
actual="$(git rev-parse HEAD)"
[[ "$actual" == "$expected" ]] || { echo "Wrong checkout: expected $expected, got $actual" >&2; exit 2; }
printf 'Verified Ezone checkout: %s\n' "$actual"
[[ "$(id -u)" == 0 ]] || { echo 'Native CI requires its disposable root bootstrap' >&2; exit 2; }
workspace="$PWD"
scanner="${GITLEAKS_BIN:?Verified scanner required}"
node scripts/check-node-version.mjs
if [[ -f /etc/alpine-release ]]; then
  release="$(cat /etc/alpine-release)"
  major="${release%%.*}"; minor="${release#*.}"; minor="${minor%%.*}"
  (( major > 3 || major == 3 && minor >= 20 )) || { echo 'Chromium CI requires Alpine 3.20 or newer' >&2; exit 2; }
  apk add --no-cache chromium procps shadow su-exec unzip
elif [[ -f /etc/debian_version ]]; then
  apt-get update
  apt-get install -y --no-install-recommends procps
else
  echo 'Native CI requires a supported Chromium runner' >&2; exit 2
fi
private="$(mktemp -d)"
gate_user=agentkit-native-ci
original_uid="$(stat -c '%u' "$workspace")"
original_gid="$(stat -c '%g' "$workspace")"
cleanup() {
  chown -R "$original_uid:$original_gid" "$workspace"
  rm -rf "$private"
}
trap cleanup EXIT
useradd --system --no-create-home --user-group "$gate_user"
gate_home="$private/home"
mkdir -p "$gate_home" "$private/tmp" "$private/config" "$private/cache" "$private/browsers"
install -m 700 "$scanner" "$private/gitleaks"
export PLAYWRIGHT_BROWSERS_PATH="$private/browsers"
if [[ -f /etc/alpine-release ]]; then
  browser="$(command -v chromium || command -v chromium-browser)"
else
  pnpm exec playwright install --with-deps chromium
  browser="$(node --input-type=module -e 'import {chromium} from "playwright-core"; console.log(chromium.executablePath())')"
fi
test -x "$browser"
chown -R "$gate_user:$gate_user" "$workspace" "$private"
# Some workers need the verified pnpm wrapper supplied by the bootstrap.
if [[ -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agentkit-tools" ]]; then
  chown -R "$gate_user:$gate_user" "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agentkit-tools"
fi
as_gate() {
  if command -v su-exec >/dev/null 2>&1; then su-exec "$gate_user" "$@";
  else runuser -u "$gate_user" -- "$@"; fi
}
as_gate test -x "$workspace"
as_gate env -i PATH="$PATH" HOME="$gate_home" \
  TMPDIR="$private/tmp" XDG_CONFIG_HOME="$private/config" XDG_CACHE_HOME="$private/cache" \
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" AGENTKIT_NATIVE_TEST_CHROMIUM="$browser" \
  KSADK_BROWSER_EXECUTABLE_PATH="$browser" GITLEAKS_BIN="$private/gitleaks" \
  AGENTKIT_TEST_CONCURRENCY=1 make public-gate
