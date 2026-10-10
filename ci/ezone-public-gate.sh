#!/usr/bin/env bash
set -euo pipefail

# Configure the Ezone CI job to run this file for merge requests and master.
# RUN_REF_PARITY=1 is used only for the post-merge parity job, never as a
# reason to bypass the source and package gates.
if [[ -z "${GITLEAKS_BIN:-}" ]]; then
  scanner_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agentkit-gitleaks"
  bash ci/install-gitleaks.sh "$scanner_dir"
  export GITLEAKS_BIN="$scanner_dir/gitleaks"
fi
make public-gate

if [[ "${RUN_REF_PARITY:-0}" == "1" ]]; then
  make ref-parity
fi
