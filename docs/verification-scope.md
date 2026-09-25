# Feature verification scope

Pull requests run the existing engine/type/build/contracts and authenticated integration checks, storage upgrades, disposable macOS package checks, and focused browser flows in Chromium, Firefox and WebKit. These include the complete resume request/receipt flow, conversation delivery review/cancellation, Mac resume permission controls, retained request/replay behavior, browser consent/migration and permission controls. Failures still fail the job; retries and timeouts are unchanged.

The complete browser matrix runs on main-branch pushes and manual workflow dispatch. Its previews and report uploads use the same event condition, so PRs do not fail because an intentionally unproduced full-matrix artifact is absent. Full-matrix results remain visible and must be considered for release acceptance. Relevant additional focused coverage is required when a feature changes outside the selected flows.

The retained-delivery filename selector is anchored to avoid also matching the separately executed production resume flow. No test files or assertions are removed. This policy reduces repetitive feature-PR work; it does not relabel historical failed runs or make the personal/live release complete. Existing in-progress runs are not cancelled or altered.
