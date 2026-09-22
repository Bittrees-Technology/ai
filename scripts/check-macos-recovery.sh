#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
recovery_test_directory="$(mktemp -d "${TMPDIR:-/tmp}/bittrees-native-recovery.XXXXXX")"
trap 'rm -rf "$recovery_test_directory"' EXIT
xcrun swiftc apps/macos/RecoveryLifecycle.swift tests/macos-recovery.swift -o "$recovery_test_directory/check"
"$recovery_test_directory/check"
xcrun swiftc -typecheck -target "$(uname -m)-apple-macosx13.0" apps/macos/Companion.swift apps/macos/RecoveryLifecycle.swift apps/macos/RecoverySetup.swift apps/macos/RecoverySetupUI.swift apps/macos/KitRecovery.swift apps/macos/KitRecoveryUI.swift -framework Cocoa -framework WebKit

xcrun swiftc apps/macos/RecoverySetup.swift tests/macos-recovery-setup.swift -o "$recovery_test_directory/setup-check"
"$recovery_test_directory/setup-check"
xcrun swiftc apps/macos/KitRecovery.swift tests/macos-kit-recovery.swift -o "$recovery_test_directory/kit-recovery-check"
"$recovery_test_directory/kit-recovery-check"
