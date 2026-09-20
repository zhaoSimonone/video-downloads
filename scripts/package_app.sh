#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$PROJECT_DIR/dist/ClipDock.app"
DEFAULT_SIGN_IDENTITY="Developer ID Application: Qrite Technology Limited (72LM77TJSN)"
SIGN_IDENTITY="${CLIPDOCK_CODESIGN_IDENTITY:-$DEFAULT_SIGN_IDENTITY}"

cd "$PROJECT_DIR"

bash "$PROJECT_DIR/scripts/build-mac-app.sh"

if ! security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"; then
  if [[ "${CLIPDOCK_ALLOW_ADHOC:-0}" == "1" ]]; then
    echo "Signing identity not found; falling back to ad-hoc signing."
    codesign --force --deep --sign - "$APP_DIR"
  else
    echo "Signing identity not found: $SIGN_IDENTITY" >&2
    echo "Set CLIPDOCK_CODESIGN_IDENTITY or CLIPDOCK_ALLOW_ADHOC=1 to override." >&2
    exit 1
  fi
else
  echo "Signing helper with: $SIGN_IDENTITY"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" \
    "$APP_DIR/Contents/Resources/bin/wx_video_download"
  echo "Signing app with: $SIGN_IDENTITY"
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP_DIR"
fi

codesign --verify --deep --strict --verbose=2 "$APP_DIR"
echo "Built and signed $APP_DIR"
