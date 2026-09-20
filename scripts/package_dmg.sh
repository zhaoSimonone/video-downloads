#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$PROJECT_DIR/dist"
APP_DIR="$DIST_DIR/ClipDock.app"
STAGING_DIR="$DIST_DIR/dmg-staging"
DMG_PATH="$DIST_DIR/ClipDock.dmg"
DEFAULT_SIGN_IDENTITY="Developer ID Application: Qrite Technology Limited (72LM77TJSN)"
SIGN_IDENTITY="${CLIPDOCK_CODESIGN_IDENTITY:-$DEFAULT_SIGN_IDENTITY}"

cd "$PROJECT_DIR"
bash "$PROJECT_DIR/scripts/package_app.sh"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
cp -R "$APP_DIR" "$STAGING_DIR/ClipDock.app"
cat > "$STAGING_DIR/安装说明.txt" <<'EOF'
ClipDock 安装说明

将 ClipDock.app 拖入 Applications 文件夹即可完成安装。
首次运行时，应用会在本机启动 ClipDock 服务和视频号代理。
EOF

APPLICATIONS_ALIAS="$STAGING_DIR/Applications"
if osascript \
  -e 'on run argv' \
  -e 'tell application "Finder" to make new alias file at POSIX file (item 1 of argv) to POSIX file "/Applications" with properties {name:"Applications"}' \
  -e 'end run' \
  "$STAGING_DIR" >/dev/null 2>&1; then
  echo "Created Finder alias to /Applications"
else
  echo "Finder alias creation failed; using symbolic link to /Applications"
  ln -s /Applications "$APPLICATIONS_ALIAS"
fi

rm -f "$DMG_PATH"
hdiutil create \
  -volname "ClipDock" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH"

if security find-identity -v -p codesigning | grep -Fq "$SIGN_IDENTITY"; then
  echo "Signing DMG with: $SIGN_IDENTITY"
  codesign --force --timestamp --sign "$SIGN_IDENTITY" "$DMG_PATH"
elif [[ "${CLIPDOCK_ALLOW_ADHOC:-0}" != "1" ]]; then
  echo "Signing identity not found: $SIGN_IDENTITY" >&2
  exit 1
fi

rm -rf "$STAGING_DIR"
if [[ "${CLIPDOCK_ALLOW_ADHOC:-0}" != "1" ]]; then
  codesign --verify --verbose=2 "$DMG_PATH"
fi
echo "Built signed $DMG_PATH"
