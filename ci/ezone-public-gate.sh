#!/usr/bin/env bash
set -euo pipefail

# Configure the Ezone CI job to run this file for merge requests and master.
# The Ezone workers do not have reliable access to GitHub release assets. Use
# the pinned scanner from the worker image, GITLEAKS_BIN, or the checked-in
# Linux archive; GitHub Actions may still download it through
# ci/install-gitleaks.sh. The Alpine worker also needs Node and pnpm for the
# repository gate, so install those from its configured package mirror when
# they are absent.
# RUN_REF_PARITY=1 is used only for the post-merge parity job, never as a
# reason to bypass the source and package gates.
if [[ -z "${GITLEAKS_BIN:-}" ]]; then
  GITLEAKS_BIN="$(command -v gitleaks 2>/dev/null || true)"
  if [[ -z "$GITLEAKS_BIN" ]]; then
    archive="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.ci-tools/gitleaks-v8.30.1/gitleaks.tar.gz"
    scanner_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agentkit-gitleaks"
    if [[ -f "$archive" ]]; then
      if command -v sha256sum >/dev/null 2>&1; then
        archive_sha="$(sha256sum "$archive" | awk '{print $1}')"
      elif command -v shasum >/dev/null 2>&1; then
        archive_sha="$(shasum -a 256 "$archive" | awk '{print $1}')"
      elif command -v openssl >/dev/null 2>&1; then
        archive_sha="$(openssl dgst -sha256 "$archive" | awk '{print $NF}')"
      else
        echo 'A SHA-256 tool is required to verify the checked-in Gitleaks archive' >&2
        exit 2
      fi
      [[ "$archive_sha" == '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' ]] || {
        echo 'Checked-in Gitleaks archive checksum mismatch' >&2
        exit 1
      }
      mkdir -p "$scanner_dir"
      tar -xzf "$archive" -C "$scanner_dir" gitleaks
      chmod 700 "$scanner_dir/gitleaks"
      GITLEAKS_BIN="$scanner_dir/gitleaks"
    fi
  fi
  if [[ -z "$GITLEAKS_BIN" ]]; then
    echo 'Ezone CI requires Gitleaks 8.30.1 in the worker image, GITLEAKS_BIN, or the checked-in scanner archive' >&2
    exit 2
  fi
  export GITLEAKS_BIN
fi
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs-current npm pnpm
  else
    echo 'Ezone CI requires Node.js and pnpm, and this worker has no apk package manager' >&2
    exit 2
  fi
fi
make public-gate

if [[ "${RUN_REF_PARITY:-0}" == "1" ]]; then
  make ref-parity
fi
