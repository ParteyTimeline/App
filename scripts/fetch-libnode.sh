#!/usr/bin/env bash
# Downloads the prebuilt nodejs-mobile Android runtime (libnode.so per ABI +
# Node's C headers) and places it where android/app/CMakeLists.txt expects
# it. Not committed to git (large binaries) — run this once after cloning
# before opening android/ in Android Studio.
set -euo pipefail

VERSION="18.20.4"
URL="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${VERSION}/nodejs-mobile-v${VERSION}-android.zip"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/android/app/libnode"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading nodejs-mobile v$VERSION Android runtime (~55 MB)..."
curl -fL -o "$TMP/nodejs-mobile-android.zip" "$URL"

echo "Extracting to $DEST ..."
rm -rf "$DEST"
mkdir -p "$DEST"
unzip -q "$TMP/nodejs-mobile-android.zip" -d "$DEST"

echo "Done. Available ABIs:"
ls "$DEST/bin"
