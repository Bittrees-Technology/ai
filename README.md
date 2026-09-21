# Bittrees AI

Local AI execution for explicitly authorized Bittrees app data.

Status: local foundation under development. Contracts, an encrypted SQLite task queue and an authenticated Express API factory are implemented and tested. No packaged launcher, deployed dashboard, production connectors, model execution or remote encryption is available yet. Repository creation does not activate any app permissions.

## Development

Use Node.js 24 LTS. Run `npm ci`, `npm run check`, `npm test`, `npm run contracts`, and `npm run build`.

`modules/contracts` contains strict versioned JSON schemas and generated OpenAPI shapes. `modules/domain` contains a deny-by-default authority intersection. Source adapters must obtain current rights from the source; request fields never establish identity or authority. Contracts reserve API shapes and do not imply those endpoints are implemented.

The intended storage split is local SQLite and hosted PostgreSQL. Local inference will start with Ollama. Prompts, results and memory stay local unless explicitly published through a source-owned action or later encrypted remote mode. Remote status uses a strict metadata allowlist.

Product content is retained until the user deletes it, with export/deletion controls required before a personal-data pilot. Future encrypted remote access will use a user-held recovery key; Bittrees will not hold recovery secrets. None of these future capabilities is a current security guarantee.

Planning checklists remain local project guides and are not published in this repository. This repository contains implementation, interface contracts, tests and operational documentation only.

Licensed under MIT. Imported models retain their own licenses.

## Local task foundation

`Store` provides owner-scoped tasks, serial conversation claims, explicit dependencies, fencing generations, heartbeat leases, bounded transient retries, cancellation, event/outbox transactions, export and deletion. Inference and network actions must run outside its synchronous transactions. `localApi` authenticates every route, rejects untrusted Host/Origin headers and currently rejects all source references. Worker claims are internal and are not exposed as user HTTP routes.

Prompts and results use AES-256-GCM with record-bound authenticated data. Input fingerprints use a keyed HMAC. IDs, status and timing metadata remain visible in SQLite; this is not full database encryption. The caller currently supplies the storage key in memory: an OS-key-store launcher is still required before using personal content. SQLite online backups retain encrypted content but are not yet whole-file encrypted, and an older backup can retain deleted content.

A task blocked on a failed prerequisite remains queued until cancelled; automatic dependency-failure propagation and configurable capacity are pending. Message/inbox persistence is pending even though the v1 message schema exists. No source-app side effects are attempted or retried by this foundation.
