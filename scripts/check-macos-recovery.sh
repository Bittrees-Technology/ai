#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
recovery_test_directory="$(mktemp -d "${TMPDIR:-/tmp}/bittrees-native-recovery.XXXXXX")"
trap 'rm -rf "$recovery_test_directory"' EXIT
xcrun swiftc apps/macos/RecoveryLifecycle.swift tests/macos-recovery.swift -o "$recovery_test_directory/check"
"$recovery_test_directory/check"
xcrun swiftc -typecheck -target "$(uname -m)-apple-macosx13.0" apps/macos/Companion.swift apps/macos/EnrollmentUI.swift apps/macos/WorkflowSetupUI.swift apps/macos/WalletOnboardingUI.swift apps/macos/InitialPairingReview.swift apps/macos/InitialPairingUI.swift apps/macos/EnrollmentReview.swift apps/macos/CentralReview.swift apps/macos/CentralUI.swift apps/macos/RecoveryLifecycle.swift apps/macos/RecoverySetup.swift apps/macos/RecoverySetupUI.swift apps/macos/KitRecovery.swift apps/macos/KitRecoveryUI.swift -framework Cocoa -framework WebKit

xcrun swiftc apps/macos/RecoverySetup.swift tests/macos-recovery-setup.swift -o "$recovery_test_directory/setup-check"
"$recovery_test_directory/setup-check"
xcrun swiftc apps/macos/KitRecovery.swift tests/macos-kit-recovery.swift -o "$recovery_test_directory/kit-recovery-check"
"$recovery_test_directory/kit-recovery-check"

node --import tsx scripts/enrollment-review-fixture.ts > "$recovery_test_directory/enrollment-review.json"
xcrun swiftc apps/macos/EnrollmentReview.swift tests/macos-enrollment-review.swift -o "$recovery_test_directory/enrollment-review-check"
"$recovery_test_directory/enrollment-review-check" "$recovery_test_directory/enrollment-review.json"

node --import tsx scripts/central-review-fixture.ts > "$recovery_test_directory/central-review.json"
xcrun swiftc apps/macos/CentralReview.swift tests/macos-central-review.swift -o "$recovery_test_directory/central-review-check"
"$recovery_test_directory/central-review-check" "$recovery_test_directory/central-review.json"

node --import tsx scripts/initial-pairing-review-fixture.ts > "$recovery_test_directory/initial-pairing-review.json"
xcrun swiftc apps/macos/InitialPairingReview.swift tests/macos-initial-pairing-review.swift -o "$recovery_test_directory/initial-pairing-review-check"
"$recovery_test_directory/initial-pairing-review-check" "$recovery_test_directory/initial-pairing-review.json"
