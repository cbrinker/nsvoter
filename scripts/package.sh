#!/usr/bin/env bash
# Package the extension into a versioned, distributable zip for a GitHub Release.
#
# Usage:  ./scripts/package.sh
# Output: dist/voter-v<version>.zip  (version read from extension/manifest.json)
#
# Players download this zip, unzip it, and "Load unpacked" the resulting folder.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extension"
DIST="$ROOT/dist"

if [[ ! -f "$EXT/manifest.json" ]]; then
  echo "error: $EXT/manifest.json not found" >&2
  exit 1
fi

# Read "version" from manifest.json (no jq dependency).
VERSION="$(grep -m1 '"version"' "$EXT/manifest.json" | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')"
if [[ -z "$VERSION" ]]; then
  echo "error: could not read version from manifest.json" >&2
  exit 1
fi

# Warn if the update-check repo hasn't been configured yet.
if grep -q 'OWNER/REPO' "$EXT/update.js"; then
  echo "warning: extension/update.js still has GITHUB_REPO=\"OWNER/REPO\" — set it before releasing, or the update checker stays disabled." >&2
fi

mkdir -p "$DIST"
OUT="$DIST/voter-v$VERSION.zip"
rm -f "$OUT"

# Zip the CONTENTS of extension/ so unzipping yields the loadable folder.
# Exclude cruft that shouldn't ship.
( cd "$EXT" && zip -r -X "$OUT" . \
    -x '*.DS_Store' -x '__MACOSX/*' -x '*/.*' )

echo "built: $OUT"
echo "version: $VERSION"
echo
echo "Next: create a GitHub Release tagged v$VERSION and attach this zip."
