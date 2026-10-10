#!/usr/bin/env bash
set -euo pipefail

# Install the exact scanner binary used on both forges. Validate its archive
# before extracting or executing it; no system installation is performed.
dest="${1:?usage: bash ci/install-gitleaks.sh <output-directory>}"
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    asset=gitleaks_8.30.1_linux_x64.tar.gz
    digest=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  Darwin/arm64)
    asset=gitleaks_8.30.1_darwin_arm64.tar.gz
    digest=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
    ;;
  *) echo 'Unsupported runner platform for the pinned scanner' >&2; exit 2 ;;
esac
mkdir -p "$dest"
curl --fail --silent --show-error --location --max-time 120 \
  "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/$asset" -o "$dest/$asset"
node --input-type=module - "$dest/$asset" "$digest" <<'NODE'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if (createHash('sha256').update(readFileSync(process.argv[2])).digest('hex') !== process.argv[3]) {
  console.error('Gitleaks archive checksum mismatch'); process.exit(1);
}
NODE
tar -xzf "$dest/$asset" -C "$dest" gitleaks
chmod 700 "$dest/gitleaks"
"$dest/gitleaks" version
