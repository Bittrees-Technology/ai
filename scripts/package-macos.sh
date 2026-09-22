#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo 'Build on macOS.' >&2; exit 1; }
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo 'Node 24 is required.' >&2; exit 1; }
# Output is disposable; never put user data in this bundle.
bundle="$PWD/dist/macos/Bittrees AI.app"
resources="$bundle/Contents/Resources"
# Clean only generated package inputs so deleted code/assets cannot survive a rebuild.
rm -rf "$PWD/dist/apps" "$PWD/dist/modules" "$PWD/dist/dashboard" "$PWD/dist/macos"
npm run build
mkdir -p "$resources/engine/dist" "$bundle/Contents/MacOS"
cp -R dist/apps dist/modules "$resources/engine/dist/"
cp -R dist/dashboard "$resources/engine/dist/"
cp package.json package-lock.json LICENSE "$resources/engine/"
node_binary="$(node -p 'process.execPath')"
node_prefix="$(dirname "$(dirname "$node_binary")")"
node_license="${NODE_LICENSE_FILE:-}"
if [[ -z "$node_license" ]]; then
  for candidate in "$node_prefix/LICENSE" "$node_prefix/node_modules/node-bin-darwin-$(node -p 'process.arch')/LICENSE" "$node_prefix/node_modules/node-darwin-$(node -p 'process.arch')/LICENSE"; do
    if [[ -s "$candidate" ]]; then node_license="$candidate"; break; fi
  done
fi
[[ -n "$node_license" && -s "$node_license" ]] || { echo 'Set NODE_LICENSE_FILE to the matching Node distribution LICENSE.' >&2; exit 1; }
cp "$node_binary" "$resources/node"
cp "$node_license" "$resources/Node-LICENSE.txt"
(cd "$resources/engine" && npm ci --omit=dev --no-audit --no-fund)
xcrun swiftc -O -target "$(uname -m)-apple-macosx13.0" apps/macos/Companion.swift -o "$bundle/Contents/MacOS/BittreesAI" -framework Cocoa -framework WebKit
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>org.bittrees.ai.companion</string>
<key>CFBundleName</key><string>Bittrees AI</string>
<key>CFBundleExecutable</key><string>BittreesAI</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST
# Development identity only: this is not Developer ID signing or notarization.
codesign --force --deep --sign - "$bundle"
codesign --verify --deep --strict "$bundle"
"$resources/node" --version
(cd "$resources/engine" && "$resources/node" --input-type=module -e 'import Database from "better-sqlite3"; import {AsyncEntry} from "@napi-rs/keyring"; const db=new Database(":memory:"); db.prepare("select 1").get(); db.close(); if(typeof AsyncEntry!=="function")process.exit(1);')
printf 'Built local development app: %s\n' "$bundle"
