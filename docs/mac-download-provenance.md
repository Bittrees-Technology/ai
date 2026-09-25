# Verified Mac development downloads

The manually dispatched **Verified Mac download** workflow builds one exact main revision only after that revision's push `Checks` workflow succeeds. It uses disposable GitHub-hosted runners and pinned action revisions. It does not publish a release, install the app, enable connectors or change model runtimes.

The artifact contains the Apple Silicon development archive, `download.json` and `SHA256SUMS`. The manifest records the source commit, workflow/run, archive digest and size, minimum macOS version and development-distribution status. GitHub build attestations bind the archive and manifest to the workflow and revision. The workflow verifies those attestations before retaining the download.

This is still an ad-hoc-signed development app. Provenance does not establish Apple Developer ID signing, notarization, native/personal acceptance, general model quality or a trusted automatic updater. Those release requirements remain open. No Apple credentials are needed or accepted by this workflow.

## Prepare a download

After required checks succeed for the selected main revision, open GitHub Actions → Verified Mac download → Run workflow, selecting main. The workflow pins the revision at dispatch. It fails if run from another branch or if that exact revision lacks successful main checks. Download `Bittrees-AI-verified-development-download` from the successful run.

## Verify before considering installation

Use a trusted installed GitHub CLI and a separately reviewed repository checkout. Obtain the expected full source commit from the reviewed main commit, not from the downloaded manifest alone:

```sh
bash scripts/verify-macos-download.sh /path/to/Bittrees-AI-macOS-arm64-development.zip EXPECTED_FULL_COMMIT
bash scripts/verify-macos-download.sh /path/to/download.json EXPECTED_FULL_COMMIT
```

Verification enforces the repository, dedicated signer workflow, main source ref, expected source/signer revision and GitHub-hosted runner. An unavailable or failed attestation is a verification failure; a matching plain checksum is not a fallback. Do not treat successful provenance verification as permission to install or as protection against bugs in trusted source code.

The commands do not extract or launch the app. Keep personal data backups and follow the separate compatibility/rollback plan before any approved pilot update. Model weights remain outside the bundle; the Acer news service is unchanged.

References: [GitHub artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations), [Apple Developer ID distribution](https://developer.apple.com/developer-id/).
