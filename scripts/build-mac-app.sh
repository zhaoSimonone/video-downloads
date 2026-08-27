#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT_DIR/.build-mac-app"
APP_DIR="$ROOT_DIR/dist/ClipDock.app"
CONTENTS_DIR="$APP_DIR/Contents"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
MACOS_DIR="$CONTENTS_DIR/MacOS"

rm -rf "$BUILD_DIR" "$APP_DIR"
mkdir -p "$BUILD_DIR" "$RESOURCES_DIR/public" "$RESOURCES_DIR/bin" "$MACOS_DIR"

cp "$ROOT_DIR/server.js" "$RESOURCES_DIR/server.js"
cp "$ROOT_DIR/package.json" "$RESOURCES_DIR/package.json"
cp "$ROOT_DIR/bin/config.yaml" "$RESOURCES_DIR/bin/config.yaml"
cp "$ROOT_DIR/bin/wx_video_download" "$RESOURCES_DIR/bin/wx_video_download"
chmod +x "$RESOURCES_DIR/bin/wx_video_download"
cp "$ROOT_DIR/public/index.html" "$RESOURCES_DIR/public/index.html"
cp "$ROOT_DIR/public/app.js" "$RESOURCES_DIR/public/app.js"
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
