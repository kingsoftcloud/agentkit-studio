#!/usr/bin/env bash
set -euo pipefail

# Configure the Ezone CI job to run this file for merge requests and master.
# RUN_REF_PARITY=1 is used only for the post-merge parity job, never as a
# reason to bypass the source and package gates.
make public-gate

GITLEAKS_BIN="${GITLEAKS_BIN:-gitleaks}"
if ! command -v "$GITLEAKS_BIN" >/dev/null 2>&1; then
  echo "gitleaks is required for the Ezone gate; refusing to continue without the secret scanner" >&2
  exit 2
fi
"$GITLEAKS_BIN" detect --source . --redact --no-banner

if [[ "${RUN_REF_PARITY:-0}" == "1" ]]; then
  make ref-parity
fi
