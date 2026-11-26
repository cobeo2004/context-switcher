#!/usr/bin/env bash
# Security scans shared by CI (security.yml, one job per scan) and `npm run verify` (all). Same pinned tools, same flags.
# Usage: bash scripts/scan.sh zizmor|gitleaks|osv|all
# zizmor runs its online audits only when GH_TOKEN is set (CI sets it; locally: GH_TOKEN=$(gh auth token) npm run verify).
set -euo pipefail
ZIZMOR_VERSION=1.33.1
GITLEAKS_VERSION=8.30.1
OSV_VERSION=2.7.1
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)
    gl_asset=linux_x64 gl_sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    osv_asset=linux_amd64 osv_sha=fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8 ;;
  Darwin-arm64)
    gl_asset=darwin_arm64 gl_sha=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
    osv_asset=darwin_arm64 osv_sha=b22c02877a811c8f78956e8643efa554932b7378f590d13f8e97d4e9448a29f3 ;;
  Darwin-x86_64)
    gl_asset=darwin_x64 gl_sha=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709
    osv_asset=darwin_amd64 osv_sha=b8420d5485ba792626315f1bf9a5a2046e971d38eea75bf9090c38852dbc3b1b ;;
  *) echo "scan.sh: no pinned binaries for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
dir="${RUNNER_TEMP:-${XDG_CACHE_HOME:-$HOME/.cache}}/cs-scan" # user-owned, never a shared /tmp path
mkdir -p "$dir"
fetch() { # url, destination, sha256 (re-verified on every run, so a cached file cannot drift)
  [ -f "$2" ] || curl -fsSL --retry 3 -o "$2" "$1"
  echo "$3  $2" | if command -v sha256sum >/dev/null; then sha256sum -c --quiet -; else shasum -a 256 -c --quiet -; fi ||
    { echo "scan.sh: sha256 mismatch for $2" >&2; rm -f "$2"; exit 1; }
}

zizmor() { uvx --quiet "zizmor@$ZIZMOR_VERSION" --persona pedantic .github/; }
gitleaks() {
  fetch "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_$gl_asset.tar.gz" "$dir/gitleaks-$GITLEAKS_VERSION.tgz" "$gl_sha"
  tar -xzf "$dir/gitleaks-$GITLEAKS_VERSION.tgz" -C "$dir" gitleaks
  "$dir/gitleaks" git --redact --no-banner --exit-code 1 .
}
osv() {
  fetch "https://github.com/google/osv-scanner/releases/download/v$OSV_VERSION/osv-scanner_$osv_asset" "$dir/osv-scanner-$OSV_VERSION" "$osv_sha"
  chmod +x "$dir/osv-scanner-$OSV_VERSION"
  "$dir/osv-scanner-$OSV_VERSION" scan source --lockfile package-lock.json
}

case "${1:-}" in
  zizmor | gitleaks | osv) "$1" ;;
  all) zizmor; gitleaks; osv ;; # plain sequence: set -e is off inside functions run from an && list
  *) echo "usage: scan.sh zizmor|gitleaks|osv|all" >&2; exit 2 ;;
esac
