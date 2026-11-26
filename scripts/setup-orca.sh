#!/usr/bin/env bash
# CI: install the pinned Orca CLI as `orca` and generate .orca/types. Linux uses the server tarball plus the plugin
# resources from the same version's .deb; macOS uses the .dmg. Bump all four values together; take each sha256 from
# `gh release view v<version> --repo stablyai/orca --json assets`.
set -euo pipefail
ORCA_VERSION=1.4.272
SERVER_SHA256=7d6186b5ece0bf7cd3466e967f7f0b59ac54ccde5060d157b66218a468daf7df # orca-server-linux-x64.tar.gz
DEB_SHA256=1ad48841b67d25f754af2fa516351481709d2b4481c746086b334ca1ef069ce1    # orca-ide_<v>_amd64.deb
DMG_SHA256=74cafbc7d6b3c15d56aa89606d753ac31e2e51ffe44c13b6917a6ab5014cc7d1    # orca-macos-arm64.dmg

base="${RUNNER_TEMP:-$(mktemp -d)}/orca-$ORCA_VERSION"
bin_dir="${ORCA_BIN_DIR:-/usr/local/bin}"
mkdir -p "$base"
fetch() { # asset, destination, sha256
  curl -fsSL --retry 3 -o "$2" "https://github.com/stablyai/orca/releases/download/v$ORCA_VERSION/$1"
  echo "$3  $2" | if command -v sha256sum >/dev/null; then sha256sum -c -; else shasum -a 256 -c -; fi ||
    { echo "setup-orca.sh: sha256 mismatch for $2" >&2; rm -f "$2"; exit 1; }
}

case "$(uname -s)" in
  Linux)
    fetch orca-server-linux-x64.tar.gz "$base/server.tgz" "$SERVER_SHA256"
    mkdir -p "$base/orca" "$base/deb" "$base/resources/plugins"
    tar -xzf "$base/server.tgz" -C "$base/orca" --strip-components=1
    # The server CLI (orcad/out/cli/index.js) reads author typings and the orca/testing kit from
    # <four dirs above the CLI>/resources/plugins = $base/resources/plugins. The tarball lacks them; the .deb has them.
    fetch "orca-ide_${ORCA_VERSION}_amd64.deb" "$base/orca.deb" "$DEB_SHA256"
    dpkg-deb --fsys-tarfile "$base/orca.deb" | tar -x -C "$base/deb" \
      ./opt/Orca/resources/plugins/declarative ./opt/Orca/resources/plugins/types \
      ./opt/Orca/resources/app.asar.unpacked/resources/plugins/declarative
    cp -R "$base/deb/opt/Orca/resources/plugins/declarative" "$base/deb/opt/Orca/resources/plugins/types" "$base/resources/plugins/"
    cp "$base/deb/opt/Orca/resources/app.asar.unpacked/resources/plugins/declarative/"*.mjs "$base/resources/plugins/declarative/"
    cli="$base/orca/bin/orca-ide"
    ;;
  Darwin)
    fetch orca-macos-arm64.dmg "$base/orca.dmg" "$DMG_SHA256"
    mkdir -p "$base/mnt"
    hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$base/mnt" "$base/orca.dmg" >/dev/null
    app="$(find "$base/mnt" -maxdepth 1 -name '*.app' -print -quit)"
    [ -n "$app" ] || { echo "no .app in orca-macos-arm64.dmg" >&2; exit 1; }
    cli="$app/Contents/Resources/bin/orca"
    ;;
  *) echo "setup-orca.sh: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac

if [ -w "$bin_dir" ]; then ln -sf "$cli" "$bin_dir/orca"; else sudo ln -sf "$cli" "$bin_dir/orca"; fi
[ "$(orca --version)" = "$ORCA_VERSION" ] || { echo "orca --version is not $ORCA_VERSION" >&2; exit 1; }
orca plugin types .
