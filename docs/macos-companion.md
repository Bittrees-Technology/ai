# Mac companion development preview

The macOS app wraps the existing local dashboard and shared Node engine in a native WebKit window. The first build targets the build machine's architecture and macOS 13 or newer. Other desktop systems can reuse the engine/dashboard but require their own launcher and OS key-store support.

Build with Node 24 and Apple's Command Line Tools:

```sh
npm ci
bash scripts/package-macos.sh
```

If Node comes from a custom distribution without a discoverable `LICENSE`, provide its matching file through `NODE_LICENSE_FILE`; packaging fails rather than omit the runtime notices.

Open `dist/macos/Bittrees AI.app`. On the pairing screen, choose **Bittrees AI → Copy pairing code** in the macOS menu bar at the top of your screen, paste it into **Pairing code**, and click **Open workspace**. The code is single-use and expires after ten minutes; restarting the app creates another. Keychain may ask for access. The app uses the existing personal data directory at `~/Library/Application Support/Bittrees AI`; it does not create a second copy of your tasks. Quit any development companion before opening the app because the loopback port is exclusive. Closing the last window quits the companion and gracefully stops its own engine; Ollama runs separately.

The bundle includes Node, its full distribution license notices, and production dependencies, so an installed Node is unnecessary to run it. Ollama and model weights are not bundled. The app uses the ordinary local Ollama endpoint, `127.0.0.1:11434`. The installed pilot now uses verified Ollama 0.17.7 from `~/Applications/Ollama.app` through its existing user startup service. A temporary comparison runtime must use both a separate loopback port and a separate model store; two download managers must not share one store. See [model comparison](mac-model-comparison.md) for the measured candidates and remaining acceptance limits. The Acer server and its news-briefing model are outside this app's lifecycle and remain unchanged.

## Boundaries

- Pairing, Host/Origin checks, encrypted storage, source permissions and exact review requirements stay in the shared engine.
- WebKit uses an ephemeral website store. No native JavaScript bridge or shell-command API is exposed.
- Only the companion loopback origin can navigate inside the app. HTTPS links open in the default browser. Local blob exports use a native save dialog.
- The child process receives a small environment, not inherited shell credentials or Node injection options. Closing the parent process's stdin pipe stops its child engine.
- The pairing code is copied only on explicit menu action. Pasting it exposes that short-lived code to the system clipboard.
- Downloads and model/runtime changes are not silently performed by the app.

## Verification and remaining release work

Initial build verification: Swift compilation, ad-hoc signature verification, bundled Node execution, actual SQLite/native-keyring module loading, TypeScript/dashboard build and 130 shared-engine/process tests. Process tests exercise actual child-process exit on parent-pipe closure and on repeated quit signals with the parent pipe still open. Rebuild checks seed obsolete outputs and verify that neither compiled nor bundled stale files survive. These do not prove native UI acceptance.

Still required: hands-on pairing, Keychain prompts, confirmation/download panels, native-window stop/restart and crash handling; signed Developer ID distribution and notarization; tested update integrity and recovery. Local browser automation was unavailable under the administrator policy, so this build must not be described as visually or interactively accepted.

This is an ad-hoc-signed local development build, not a notarized public installer. No updater is installed. For development updates, quit the app, rebuild and replace the bundle, retaining the Application Support directory and Keychain entries. Public automatic updates remain disabled until signed verification and rollback are implemented.


## Identifying a development build

New packages include `Contents/Resources/build-info.json` inside the signed bundle. It records the exact source revision, whether the source tree had local changes, build time, architecture, bundled Node version and dependency-lock checksum. **Bittrees AI → About Bittrees AI** displays the source revision and local-change label. Packaging verifies the manifest against the bundled runtime and lockfile before reporting success. No user data, machine paths, environment values or credentials are recorded.

For a reviewable clean development archive, build from a clean merged checkout, archive with `ditto -c -k --sequesterRsrc --keepParent`, and record its SHA-256 alongside the source revision. A checksum identifies that archive; it is not an authenticated update channel or a substitute for Developer ID/notarization. Build metadata is provenance, not proof that the application passed native interaction acceptance. The currently installed app must be checked separately from newly prepared archives.


## Download provenance

The manual [verified development download workflow](mac-download-provenance.md) adds GitHub attestations and a source-bound download manifest after successful checks for an exact main revision. It does not change the ad-hoc development signature, install an updater, publish a release or complete the remaining native/signing acceptance.
