#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build-mac-app"
APP_DIR="$ROOT_DIR/dist/ClipDock.app"
CONTENTS_DIR="$APP_DIR/Contents"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
MACOS_DIR="$CONTENTS_DIR/MacOS"
ICON_SOURCE="$ROOT_DIR/assets/ClipDock.svg"
ICONSET_DIR="$BUILD_DIR/ClipDock.iconset"

rm -rf "$BUILD_DIR" "$APP_DIR"
mkdir -p "$BUILD_DIR" "$RESOURCES_DIR/public" "$RESOURCES_DIR/bin" "$MACOS_DIR"

if ! command -v qlmanage >/dev/null 2>&1 || ! command -v iconutil >/dev/null 2>&1; then
  echo "需要 macOS 的 qlmanage 和 iconutil 生成应用图标" >&2
  exit 1
fi
mkdir -p "$ICONSET_DIR"
qlmanage -t -s 1024 -o "$BUILD_DIR" "$ICON_SOURCE" >/dev/null 2>&1
ICON_PNG="$BUILD_DIR/ClipDock.svg.png"
if [[ ! -f "$ICON_PNG" ]]; then
  echo "无法从 $ICON_SOURCE 生成图标预览" >&2
  exit 1
fi
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICON_PNG" --out "$ICONSET_DIR/icon_${size}x${size}.png" >/dev/null
  if [[ "$size" -lt 1024 ]]; then
    double=$((size * 2))
    sips -z "$double" "$double" "$ICON_PNG" --out "$ICONSET_DIR/icon_${size}x${size}@2x.png" >/dev/null
  fi
done
iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/ClipDock.icns"

cp "$ROOT_DIR/server.js" "$RESOURCES_DIR/server.js"
cp "$ROOT_DIR/package.json" "$RESOURCES_DIR/package.json"
cp "$ROOT_DIR/bin/config.yaml" "$RESOURCES_DIR/bin/config.yaml"
cp "$ROOT_DIR/bin/wx_video_download" "$RESOURCES_DIR/bin/wx_video_download"
chmod +x "$RESOURCES_DIR/bin/wx_video_download"
cp "$ROOT_DIR/public/index.html" "$RESOURCES_DIR/public/index.html"
cp "$ROOT_DIR/public/app.js" "$RESOURCES_DIR/public/app.js"
cp "$ROOT_DIR/public/compare-playback.js" "$RESOURCES_DIR/public/compare-playback.js"
cp "$ROOT_DIR/public/styles.css" "$RESOURCES_DIR/public/styles.css"

swiftc -O \
  -framework Cocoa \
  -framework WebKit \
  "$ROOT_DIR/macapp/Sources/ClipDockApp.swift" \
  -o "$MACOS_DIR/ClipDock"

cat > "$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>ClipDock</string>
  <key>CFBundleExecutable</key>
  <string>ClipDock</string>
  <key>CFBundleIdentifier</key>
  <string>local.clipdock.app</string>
  <key>CFBundleName</key>
  <string>ClipDock</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIconFile</key>
  <string>ClipDock</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.utilities</string>
</dict>
</plist>
PLIST

echo "Built $APP_DIR"
