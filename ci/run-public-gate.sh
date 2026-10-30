#!/usr/bin/env bash
set -euo pipefail

# RLIMIT_NPROC is per UID on Linux. A shared Actions user cannot represent an
# isolated execution owner: concurrent Node workers consume each other's quota.
# Keep Native's limits intact and run the release gate with a dedicated owner.
workspace="${GITHUB_WORKSPACE:?GitHub workspace is required}"
scanner="${GITLEAKS_BIN:?Verified Gitleaks path is required}"
original_uid="$(id -u)"
original_gid="$(id -g)"
gate_user=agentkit-ci
private_root="$(mktemp -d)"
cleanup() {
  sudo chown -R "$original_uid:$original_gid" "$workspace"
  sudo rm -rf "$private_root"
}
trap cleanup EXIT
sudo useradd --system --create-home --user-group "$gate_user"
sudo chown "$gate_user:$gate_user" "$private_root"
sudo chmod 700 "$private_root"
sudo install -m 700 -o "$gate_user" -g "$gate_user" "$scanner" "$private_root/gitleaks"
sudo install -d -m 700 -o "$gate_user" -g "$gate_user" "$private_root/tmp"
sudo chown -R "$gate_user:$gate_user" "$workspace"
sudo -H -u "$gate_user" env PATH="$PATH" TMPDIR="$private_root/tmp" \
  GITLEAKS_BIN="$private_root/gitleaks" AGENTKIT_TEST_CONCURRENCY=1 make public-gate
