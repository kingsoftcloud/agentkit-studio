#!/usr/bin/env bash
set -euo pipefail

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  else
    echo 'A SHA-256 tool is required' >&2
    exit 2
  fi
}

# Configure the Ezone CI job to run this file for merge requests and master.
# The Ezone workers do not have reliable access to GitHub release assets. Use
# the pinned scanner from the worker image, GITLEAKS_BIN, or the worker-provided
# Linux archive; GitHub Actions may still download it through
# ci/install-gitleaks.sh. The Alpine worker also needs the pinned Node and
# pnpm versions for the repository gate, so bootstrap those archives before
# falling back to its configured package mirror.
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
        echo 'A SHA-256 tool is required to verify the worker-provided Gitleaks archive' >&2
        exit 2
      fi
      [[ "$archive_sha" == '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb' ]] || {
        echo 'Worker-provided Gitleaks archive checksum mismatch' >&2
        exit 1
      }
      mkdir -p "$scanner_dir"
      tar -xzf "$archive" -C "$scanner_dir" gitleaks
      chmod 700 "$scanner_dir/gitleaks"
      GITLEAKS_BIN="$scanner_dir/gitleaks"
    fi
  fi
  if [[ -z "$GITLEAKS_BIN" ]]; then
    echo 'Ezone CI requires Gitleaks 8.30.1 in the worker image, GITLEAKS_BIN, or the worker-provided scanner archive' >&2
    exit 2
  fi
  export GITLEAKS_BIN
fi
tool_dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agentkit-tools"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node_archive="$repo_root/.ci-tools/node-v22.19.0/node.tar.xz"
node_libs_archive="$repo_root/.ci-tools/node-v22.19.0/node-libs.tar.gz"
pnpm_archive="$repo_root/.ci-tools/pnpm-v10.33.2/pnpm.tgz"
node_ok=false
if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | awk -F'[v.]' '{print $2}')"
  [[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 22 )) && node_ok=true
fi
if [[ "$node_ok" != true ]]; then
  if [[ -f "$node_archive" ]]; then
    node_sha="$(sha256_file "$node_archive")"
    [[ "$node_sha" == 'b2eb68fe2dae8c7a7d27255a4fcff6292179a6089835879932b2641aad0bc9d9' ]] || {
      echo 'Worker-provided Node.js archive checksum mismatch' >&2
      exit 1
    }
    node_libs_sha="$(sha256_file "$node_libs_archive")"
    [[ "$node_libs_sha" == '127c4a3eab99ab5c48bea474f12d08c80c3590a63892d130e1c02f272b13cb02' ]] || {
      echo 'Worker-provided Node.js runtime libraries checksum mismatch' >&2
      exit 1
    }
    mkdir -p "$tool_dir/node" "$tool_dir/node-libs" "$tool_dir/bin"
    tar -xJf "$node_archive" -C "$tool_dir/node" --strip-components=1
    tar -xzf "$node_libs_archive" -C "$tool_dir/node-libs"
    if ! command -v patchelf >/dev/null 2>&1; then
      if command -v apk >/dev/null 2>&1; then
        apk add --no-cache patchelf
      else
        echo 'Ezone CI requires patchelf to run the pinned Node.js binary on Alpine 3.11' >&2
        exit 2
      fi
    fi
    patchelf --set-interpreter "$tool_dir/node-libs/ld-musl-x86_64.so.1" --set-rpath "$tool_dir/node-libs" "$tool_dir/node/bin/node"
    cat > "$tool_dir/bin/node" <<EOF
#!/usr/bin/env sh
exec "$tool_dir/node/bin/node" "\$@"
EOF
    chmod 700 "$tool_dir/bin/node"
    export PATH="$tool_dir/bin:$PATH"
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache nodejs-current npm
  else
    echo 'Ezone CI requires Node.js 22.19+ and this worker has no bootstrap archive or apk' >&2
    exit 2
  fi
fi
pnpm_ok=false
if command -v pnpm >/dev/null 2>&1 && [[ "$(pnpm --version 2>/dev/null || true)" == '10.33.2' ]]; then pnpm_ok=true; fi
if [[ "$pnpm_ok" != true ]]; then
  if [[ -f "$pnpm_archive" ]]; then
    pnpm_sha="$(sha256_file "$pnpm_archive")"
    [[ "$pnpm_sha" == '7a7bcf13d7f6ceb3946c03978373d99be9fde1cafc3000bdfed4c4f791167610' ]] || {
      echo 'Worker-provided pnpm archive checksum mismatch' >&2
      exit 1
    }
    mkdir -p "$tool_dir/pnpm" "$tool_dir/bin"
    tar -xzf "$pnpm_archive" -C "$tool_dir/pnpm" --strip-components=1
    cat > "$tool_dir/bin/pnpm" <<EOF
#!/usr/bin/env sh
    exec "$tool_dir/bin/node" "$tool_dir/pnpm/bin/pnpm.cjs" "\$@"
EOF
    chmod 700 "$tool_dir/bin/pnpm"
    export PATH="$tool_dir/bin:$PATH"
  elif command -v npm >/dev/null 2>&1; then
    npm install --global --no-audit --no-fund pnpm@10.33.2
  else
    echo 'Ezone CI requires pnpm 10.33.2 and no bootstrap archive or npm is available' >&2
    exit 2
  fi
fi
if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile --store-dir "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/agentkit-pnpm-store"
fi
make public-gate

if [[ "${RUN_REF_PARITY:-0}" == "1" ]]; then
  make ref-parity
fi
