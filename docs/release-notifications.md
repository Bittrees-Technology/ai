# Mac release notices

The paired local workspace checks published releases in Bittrees-Technology/ai on opening and periodically while open. Successful checks are cached for six hours; unavailable checks retry after fifteen minutes. Concurrent requests share one check. No Keychain read, GitHub token, automatic installation, restart or workflow pause is required.

Eligible releases (including development prereleases) must contain the existing arm64 Mac archive and download.json manifest from the verified Mac download workflow. The release source must be ahead of the installed source; an exact merged PR head can resolve to its squash merge for comparison. All five required GitHub Actions checks must succeed on the release source. Drafts, incomplete assets, failed checks, older sources and divergent sources are not offered. Publish the verified archive and manifest together through the existing release process. Ordinary branch pushes are not downloadable app releases.

An available release appears as an in-app notice with installed/available revisions, a GitHub release link, and Later. Later dismisses that tag for the current workspace session. The notice is not a macOS system notification while the workspace is closed or locked. Downloading is user initiated; this does not implement an installer or bypass signing, backup, source permissions or data retention.

No source content or workflow data is sent to GitHub; only public repository/revision queries are made. Offline/rate-limited checks report unavailable internally and do not falsely claim the app is current. Locally modified builds do not receive upgrade offers. The checker is a release notification, not archive attestation verification; retain the documented archive/provenance verification for installation.
