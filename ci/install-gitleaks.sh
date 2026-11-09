#!/usr/bin/env bash
set -euo pipefail

# Install the exact scanner binary used on both forges. Validate its archive
# before extracting or executing it; no system installation is performed.
dest="${1:?usage: bash ci/install-gitleaks.sh <output-directory>}"
version=8.30.1
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    asset="gitleaks_${version}_linux_x64.tar.gz"
    digest=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    ;;
  Darwin/arm64)
    asset="gitleaks_${version}_darwin_arm64.tar.gz"
    digest=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
    ;;
  *) echo 'Unsupported runner platform for the pinned scanner' >&2; exit 2 ;;
esac
mkdir -p "$dest"
archive="$dest/$asset"
partial="$archive.part"

# GitHub's release CDN intermittently answers 504 for release assets (the same
# failure #106 handles for the Electron checksum manifest). Retry the official
# URL with exponential backoff, then fall back to mirror prefixes that proxy
# the same GitHub release bytes. The digest pinned above still decides whether
# an archive may be extracted, so a broken or rewriting mirror can only cause
# another fallback, never a different binary.
release="https://github.com/gitleaks/gitleaks/releases/download/v${version}/${asset}"
# GITLEAKS_RELEASE_URL redirects only the primary download (for an internal
# copy of the same asset); the fallback prefixes always resolve the public
# GitHub release, and the digest above still has to match either way.
official="${GITLEAKS_RELEASE_URL:-$release}"
sources=(
  "official|$official"
  "ghfast.top|https://ghfast.top/$release"
  "gh-proxy.com|https://gh-proxy.com/$release"
)
attempts=3

log="$(mktemp "${TMPDIR:-/tmp}/gitleaks-curl.XXXXXX")"
trap 'rm -f "$partial" "$log"' EXIT

sha256_tool=''
for candidate in sha256sum shasum openssl; do
  if command -v "$candidate" >/dev/null 2>&1; then sha256_tool="$candidate"; break; fi
done
if [[ -z "$sha256_tool" ]]; then
  echo 'A SHA-256 tool (sha256sum, shasum, or openssl) is required' >&2
  exit 2
fi
sha256_of() {
  if [[ "$sha256_tool" == openssl ]]; then
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  elif [[ "$sha256_tool" == shasum ]]; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

last_code=000
last_note=''
download_from() {
  local label="$1" url="$2" attempt=1 delay=2 status code actual
  while (( attempt <= attempts )); do
    status=0
    code="$(curl --silent --show-error --location --connect-timeout 15 --max-time 120 \
      --output "$partial" --write-out '%{http_code}' "$url" 2>"$log")" || status=$?
    code="${code:-000}"
    last_code="$code"
    last_note="last HTTP $code"
    printf 'gitleaks: %s attempt %d/%d -> HTTP %s\n' "$label" "$attempt" "$attempts" "$code" >&2
    if [[ $status -ne 0 || "$code" != 200 ]]; then
      if [[ -s "$log" ]]; then sed 's/^/gitleaks:   /' "$log" >&2; fi
      rm -f "$partial"
      if (( attempt < attempts )); then
        sleep "$delay"
        delay=$(( delay * 2 ))
      fi
      attempt=$(( attempt + 1 ))
      continue
    fi
    actual="$(sha256_of "$partial")"
    if [[ "$actual" != "$digest" ]]; then
      printf 'gitleaks: %s archive sha256 mismatch (expected %s, got %s)\n' "$label" "$digest" "$actual" >&2
      last_note="HTTP $code, sha256 mismatch"
      rm -f "$partial"
      return 1
    fi
    printf 'gitleaks: %s archive sha256 verified\n' "$label" >&2
    return 0
  done
  return 1
}

ok=0
index=0
tried=()
for entry in "${sources[@]}"; do
  label="${entry%%|*}"
  url="${entry#*|}"
  if download_from "$label" "$url"; then
    if (( index == 0 )); then
      echo 'gitleaks mirror fallback: disabled' >&2
    else
      printf 'gitleaks download source: %s\n' "$label" >&2
    fi
    ok=1
    break
  fi
  tried+=("$label $url (${last_note:-last HTTP $last_code})")
  index=$(( index + 1 ))
  if (( index == 1 )); then
    echo 'gitleaks mirror fallback: enabled' >&2
  fi
done

if (( ok == 0 )); then
  {
    echo "gitleaks ${version}: could not download ${asset}"
    echo '  sources tried:'
    for item in "${tried[@]}"; do printf '    - %s\n' "$item"; done
    echo "  pinned sha256: $digest"
    echo '  Retry the job, or set GITLEAKS_RELEASE_URL to an internal copy of the release asset.'
  } >&2
  exit 1
fi

mv -f "$partial" "$archive"
tar -xzf "$archive" -C "$dest" gitleaks
chmod 700 "$dest/gitleaks"
"$dest/gitleaks" version
