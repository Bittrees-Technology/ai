# News connection: reading by default

Connections → News accepts an existing key from the user's News AI-connection page. It uses the existing `https://news.bittrees.org/api/mcp` endpoint. It neither creates a second MCP service nor obtains a broader grant.

1. Paste an existing key and select **Review key**. The companion negotiates the supported MCP protocol and reads the authenticated credential metadata. It shows expiry and the source key's actual scopes; it does not save the key yet or load articles.
2. Explicitly confirm read-only use. After checking the same source identity/scopes again, the companion stores the key in the separate `org.bittrees.ai.connector.news` Keychain entry for this local profile. A two-minute review window, existing-entry checks, verified save and fixed setup ID handle stale review and lost-response retry.
3. **Load my News articles** makes an explicit read. This reading flow calls only `get_connection` and `list_articles`; source instructions or advertised tools cannot select another method. A separate [reviewed curation flow](news-reviewed-curation.md) can read an existing preview and save one explicitly reviewed story edit when the key includes curation permission. Publication, subscriptions and sending are not implemented.

[News PR2](https://github.com/Bittrees-Technology/news/pull/2) supplies the versioned `news-mcp-connection-v1` metadata projection: the authenticated account ID, credential ID, expiry and scopes. Caller-provided account/scope fields confer no authority. Keys, hashes, email and wallet addresses are excluded. The companion pins the metadata to the local owner and credential, rechecks it before and after each article read, and discards content after expiry, revocation, scope/account change, local credential replacement or removal during a read. Read operations initialize a fresh stateless MCP exchange, including after application restart.

## Content and key boundaries

Requests go only to the fixed News HTTPS endpoint, with redirects disabled and a 25-second transport timeout. A response must have the expected JSON-RPC ID, JSON content type and one text result. Article responses are bounded to 8 MiB/100 articles, with unique IDs, bounded fields and HTTPS links without embedded credentials. The UI receives only allowlisted article fields; it does not fetch source URLs, execute content, load remote media, or pass the key or source text to a model. Article summaries/excerpts remain unverified source material.

Article snapshots are transient. Changing focus, leaving Connections, refreshing, denial or clearing the connection removes the visible content and suppresses late responses. The UI shows when access was checked; it is not a live revocation subscription. No articles, keys or connection payloads enter task/memory exports or encrypted task backups. The Keychain entry is separate from the companion content-recovery key; reconnect using a News-managed credential after device/key loss.

**Remove from this Mac** removes the local credential and interrupts a pending read. It does not revoke a reused key in News or other clients. Use **Manage keys and permissions in News** to revoke the source credential; subsequent reads fail. The panel distinguishes stored versus expired credentials, and every content read checks the source again. Confirmation does not enable automatic article polling.

No task/source adapter, local News summarization, saved memory, public publication, delivery or schedule control is supplied by this reading step. The separate reviewed curation flow is described above. Those remain separate checklist work. Acer-server's model, runtime and news jobs remain independent and unchanged.

## Verification

- Seven engine/controller/authenticated HTTP suites cover explicit review/save, idempotent uncertain retry, fixed methods, filtering, wrong owners, expiry/revocation, changed metadata, RPC identity/errors, unsafe URLs, bounds, in-flight removal/replacement, export omission and focus-loss clearing.
- Historical read-only [integration receipt](evidence/news-read-only-integration-2026-09-23.json) uses the real News MCP handler at merged `41d7f2c9849d4d09e5b3fd56255154ccee465c24`, disposable PostgreSQL accounts and in-memory credentials. It verifies disjoint private article reads, owner isolation, source expiry/revocation, only the two read tools, and unchanged curation/newspaper/subscription/delivery/processing tables. The later curation integration pins News PR3, preserves these reading checks and repeats them on PostgreSQL17.
- Browser tests drive the real Mac dashboard in disposable GitHub CI: explicit key review/confirmation, manual reads, denied-source clearing, local removal, focus-loss and late-response suppression, desktop/narrow review/read layouts.

No personal News key, native Keychain prompt, real-user pilot or installed-app replacement has been exercised. Task21/memory2/browser1/import1 schemas and model defaults are unchanged.
