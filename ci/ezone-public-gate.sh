#!/usr/bin/env bash
set -euo pipefail

# Configure the Ezone CI job to run this file for merge requests and master.
# The Ezone workers do not have reliable access to GitHub release assets, so
# they must provide the pinned scanner through the image or GITLEAKS_BIN. The
# GitHub Actions workflow may still use ci/install-gitleaks.sh because its
# runner has the required external network access.
# RUN_REF_PARITY=1 is used only for the post-merge parity job, never as a
# reason to bypass the source and package gates.
if [[ -z "${GITLEAKS_BIN:-}" ]]; then
  GITLEAKS_BIN="$(command -v gitleaks 2>/dev/null || true)"
  if [[ -z "$GITLEAKS_BIN" ]]; then
    echo 'Ezone CI requires Gitleaks 8.30.1 in the worker image or GITLEAKS_BIN; refusing an external download' >&2
    exit 2
  fi
  export GITLEAKS_BIN
fi
make public-gate

if [[ "${RUN_REF_PARITY:-0}" == "1" ]]; then
  make ref-parity
fi
