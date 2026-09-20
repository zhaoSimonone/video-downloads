#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"
APP_DIR="$DIST_DIR/ClipDock.app"
ZIP_PATH="$DIST_DIR/ClipDock.zip"

cd "$PROJECT_DIR"
if [[ "${CLIPDOCK_SKIP_APP_BUILD:-0}" != "1" ]]; then
  bash "$PROJECT_DIR/scripts/package_app.sh"
fi

rm -f "$ZIP_PATH"
ditto -c -k --sequesterRsrc --keepParent --zlibCompressionLevel 9 "$APP_DIR" "$ZIP_PATH"
echo "Built $ZIP_PATH"
