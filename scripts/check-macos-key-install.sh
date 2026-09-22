#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
key_test_directory="$(mktemp -d "${TMPDIR:-/tmp}/bittrees-key-install.XXXXXX")"
trap 'rm -rf "$key_test_directory"' EXIT
xcrun swiftc apps/macos/StorageKeyInstall.swift tests/macos-key-install.swift -o "$key_test_directory/check" -framework Security
"$key_test_directory/check"
xcrun swiftc -typecheck -target "$(uname -m)-apple-macosx13.0" apps/macos/StorageKeyInstall.swift apps/macos/KeyInstallMain.swift -framework Security

xcrun swiftc apps/macos/StorageKeyInstall.swift apps/macos/KeyInstallMain.swift -o "$key_test_directory/KeyInstall" -framework Security
node scripts/macos-key-install-check.mjs "$key_test_directory/KeyInstall"
