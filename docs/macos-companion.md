# Mac companion development preview

The macOS app wraps the existing local dashboard and shared Node engine in a native WebKit window. The first build targets the build machine's architecture and macOS 13 or newer. Other desktop systems can reuse the engine/dashboard but require their own launcher and OS key-store support.

Build with Node 24 and Apple's Command Line Tools:

```sh
npm ci
bash scripts/package-macos.sh
```

Open `dist/macos/Bittrees AI.app`. On the pairing screen, choose **Bittrees AI → Copy pairing code**, paste it, and pair. The code is single-use and expires after ten minutes; restarting the app creates another. Keychain may ask for access. The app uses the existing personal data directory at `~/Library/Application Support/Bittrees AI`; it does not create a second copy of your tasks. Quit any development companion before opening the app because the loopback port is exclusive. Closing the last window quits the companion and gracefully stops its own engine; Ollama runs separately.

The bundle includes Node and production dependencies, so an installed Node is unnecessary to run it. Ollama and model weights are not bundled. The app uses the ordinary local Ollama endpoint, `127.0.0.1:11434`. Experimental comparisons on `127.0.0.1:11435` remain separate until an evaluated model/runtime is deliberately adopted. The Acer server and its news-briefing model are outside this app's lifecycle and remain unchanged.

## Boundaries

- Pairing, Host/Origin checks, encrypted storage, source permissions and exact review requirements stay in the shared engine.
- WebKit uses an ephemeral website store. No native JavaScript bridge or shell-command API is exposed.
- Only the companion loopback origin can navigate inside the app. HTTPS links open in the default browser. Local blob exports use a native save dialog.
- The child process receives a small environment, not inherited shell credentials or Node injection options. Closing the parent process's stdin pipe stops its child engine.
- The pairing code is copied only on explicit menu action. Pasting it exposes that short-lived code to the system clipboard.
- Downloads and model/runtime changes are not silently performed by the app.

## Verification and remaining release work

Initial build verification: Swift compilation, ad-hoc signature verification, bundled Node execution, actual SQLite/native-keyring module loading, TypeScript/dashboard build and 128 shared-engine tests. These do not prove native UI acceptance.

Still required: hands-on pairing, Keychain prompts, confirmation/download panels, native-window stop/restart and crash handling; signed Developer ID distribution and notarization; tested update integrity and recovery. Local browser automation was unavailable under the administrator policy, so this build must not be described as visually or interactively accepted.

This is an ad-hoc-signed local development build, not a notarized public installer. No updater is installed. For development updates, quit the app, rebuild and replace the bundle, retaining the Application Support directory and Keychain entries. Public automatic updates remain disabled until signed verification and rollback are implemented.
