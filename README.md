# Bittrees AI

Local AI execution for explicitly authorized Bittrees app data.

Status: foundation under development. No deployed dashboard, production connectors, model execution or remote encryption is available yet. Repository creation does not activate any app permissions.

## Development

Use Node.js 24 LTS. Run `npm ci`, `npm run check`, `npm test`, `npm run contracts`, and `npm run build`.

`modules/contracts` contains strict versioned JSON schemas and generated OpenAPI shapes. `modules/domain` contains a deny-by-default authority intersection. Source adapters must obtain current rights from the source; request fields never establish identity or authority. Contracts reserve API shapes and do not imply those endpoints are implemented.

The intended storage split is local SQLite and hosted PostgreSQL. Local inference will start with Ollama. Prompts, results and memory stay local unless explicitly published through a source-owned action or later encrypted remote mode. Remote status uses a strict metadata allowlist.

Product content is retained until the user deletes it, with export/deletion controls required before a personal-data pilot. Future encrypted remote access will use a user-held recovery key; Bittrees will not hold recovery secrets. None of these future capabilities is a current security guarantee.

Planning checklists remain local project guides and are not published in this repository. This repository contains implementation, interface contracts, tests and operational documentation only.

Licensed under MIT. Imported models retain their own licenses.
