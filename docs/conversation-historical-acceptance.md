# Historical key and conversation acceptance

An authenticated ciphertext can be cryptographically valid while its recipient key has unknown earlier replay history. A database upgrade, fresh peer check, independently reviewed offer or reopened session must not grant that key generation provenance.

The regression scenarios use the actual version11 providers pinned by `scripts/prepare-legacy-browser-key-boundary.mjs`, including their original key generation, checks and consent stores. The current Mac prepares a real message or waiting-worker question for that browser. The fixture authenticates those exact bytes before upgrade. The current browser must preserve the key, recovery kit and replay/sequence records but deny conversation admission and outgoing preparation with no content effects. Fresh consent under the same key does not change that outcome. The waiting worker remains blocked for its answer.

These scenarios run only on disposable CI browsers. They do not prove complete historical-key release acceptance: authenticated host/relay composition, explicit replacement, native legacy material and restore/recovery still require their own evidence. No personal key, installed application, live relay, model runtime or Acer news configuration is changed.
