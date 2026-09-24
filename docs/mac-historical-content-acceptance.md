# Historical Mac key acceptance

The authenticated companion API must not accept conversation content merely because an older key can decrypt it. This regression builds the actual schema31 source at `d3ee4a9e5f82533509fde131e2e284906ed2d9fe`, verifies its source archive and compiled key/storage hashes, creates temporary stores with its real endpoint fixture, and opens those stores with the current writer.

It proves that valid historical ciphertext remains decryptable with preserved synthetic key material but is denied by the current authenticated API without changing messages, replay records or the content journal. A newly reviewed conversation permission does not change that outcome. After explicit key replacement, peer verification and independent conversation consent, fresh content is accepted once, outgoing content can be prepared and encrypted, and duplicate delivery remains one Inbox outcome after reopening the store.

An encrypted backup retains messages and content history. Its restored copy remains locked against incoming content and outgoing preparation, even with the same synthetic device credentials and key slots available. The old writer refuses the upgraded store; the historical key bytes remain unchanged.

Run after installing dependencies and building the current project:

```sh
git fetch --no-tags --depth=1 origin d3ee4a9e5f82533509fde131e2e284906ed2d9fe
node scripts/prepare-legacy-mac-key-boundary.mjs
node scripts/check-mac-historical-content.mjs
```

The Checks workflow executes this path on push and pull request and retains `mac-historical-content-acceptance`. Identity responses and key storage are synthetic and in memory; the HTTP API binds to an ephemeral literal-loopback port. This does not touch personal Keychain, an installed app, an inference model, or Acer. It does not establish remote relay acceptance, unknown historical ID uniqueness, or personal-device release readiness.
