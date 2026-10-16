#!/bin/bash
set -euo pipefail
[[ ( $# == 2 || $# == 3 ) && -f "$1" && "$2" =~ ^[a-f0-9]{40}$ ]] || {
  echo 'Usage: verify-macos-download.sh ARCHIVE_OR_MANIFEST EXPECTED_SOURCE_COMMIT [EXPECTED_SOURCE_REF]' >&2
  exit 2
}
release_source_ref="${3:-refs/heads/main}"
[[ "$release_source_ref" == refs/heads/main || "$release_source_ref" == "refs/heads/releases/mac/$2" ]] || {
  echo 'Expected ref must be main or the release branch named for the exact source commit.' >&2
  exit 2
}
# The expected revision comes from a separately reviewed merged commit, not the download.
# Verify only: no extraction, execution, installation or update is performed.
gh attestation verify "$1" \
  --repo Bittrees-Technology/ai \
  --signer-workflow Bittrees-Technology/ai/.github/workflows/macos-download.yml \
  --source-ref "$release_source_ref" \
  --source-digest "$2" \
  --signer-digest "$2" \
  --deny-self-hosted-runners
