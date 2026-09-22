# Browser interoperability for private tasks

The private task, receipt and accepted-response schemas now live in `modules/remote/private-task-contracts.ts`, which uses only portable schemas and the existing WebCrypto envelope contract. The Node receiver, receipt store and durable companion sender import the same definitions and retain compatibility re-exports. Browser code no longer has to import SQLite, Vault, `node:crypto` or companion storage to validate a task or acceptance receipt. No schema15 migration or wire-format change is introduced.

This is a prerequisite for a browser sender, not completed browser persistence or a deployed browser-to-Mac feature. The remote dashboard still has no enabled private task form, saved endpoint keys, outbox, live relay path or reciprocal pairing UI. The installed Mac app, prepared archive, model settings and Acer news processing remain unchanged.

## Real browser test boundary

The `browser-private-protocol` GitHub job installs the pinned Playwright **1.63.0** engines and runs the production-built synthetic fixture in Chromium, Firefox and WebKit. The test command is guarded to run on disposable GitHub runners. It does not automate the user's local browser or native app. The test fixture and compiled output are separate from the production remote dashboard; the generated fixture is ignored by Git.

Each engine generates a real nonextractable P-256 private key with WebCrypto, verifies that private export is denied and compares the full invitation/key fingerprints with the Node implementation. Synthetic reciprocal pin approval is performed by the fixture; it is not evidence of human fingerprint comparison or actual account authentication.

The tests then exercise:

- Browser HPKE task encryption → the real companion `PrivateTaskReceiver` → the ordinary SQLite task queue → a synthetic local worker, with exact retry creating and executing one task.
- Node HPKE receipt encryption → browser decryption and strict receipt validation, with the original receipt identity preserved.
- Browser denial of altered ciphertext, wrong sender key, mismatched expected header, expiry and plaintext substitution.
- Companion denial of wrong account routing and revoked browser keys.
- Unicode payload preservation, extra authority-field rejection and the encoded plaintext size limit.

The browser communicates with the test driver through the automation harness; this is cryptographic/application interoperability, **not** the production HTTP relay, sign-in, browser persistence or permission UI. The model is synthetic; model quality and performance are not measured. The four scenarios run independently in each of the three engines. The JSON report is retained as a seven-day GitHub artifact on both success and failure. A passing job supports these scenarios only.

The built bundle includes the HPKE library's optional Node `crypto` fallback as Vite's browser-external stub. It is not polyfilled or used to make tests pass: real browser `globalThis.crypto.subtle` must provide the selected suite. Testing the built bundle, rather than only Node WebCrypto or Vite development modules, covers that branch boundary. Browser-specific algorithm/runtime failures must be fixed or reported; no plaintext or weaker-suite fallback is allowed.

## Sources and remaining work

The CI setup follows [Playwright's CI documentation](https://playwright.dev/docs/ci). Its [browser documentation](https://playwright.dev/docs/browsers) distinguishes the test engines from branded browser releases. The implementation relies on browser [WebCrypto ECDH support](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveBits). The existing [private-envelope protocol](private-remote-envelopes.md) records the HPKE/RFC/dependency choices and limits.

WebKit CI is not personal Safari or native WKWebView acceptance. This test step does not implement IndexedDB storage, endpoint-key recovery, protected browser update delivery, a browser outbox, a durable receipt producer or live network authentication. Those remain explicit requirements before private remote access can be enabled. Browser persistence will also need quota/eviction/version-change/multi-tab failure handling and user export/delete/recovery controls; [IndexedDB's documented transaction and storage model](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) is a separate integration concern. Independent protocol review remains open.
