# Standalone remote service

`apps/api` supplies an explicit direct-TLS entry point for the existing Express/PostgreSQL remote application. Building it starts nothing. The public Vercel configuration continues to deploy only `dist/site`; this launcher does not alter ai.bittrees.org, the Mac companion, Ollama or Acer.

## Prepare a deployment

Use Node24 and run `npm ci` followed by `npm run build` from the repository root. Keep that directory as the service working directory: the launcher serves only the built `dist/remote-web` assets. No inference runtime, local task database or model weights are mounted.

Copy `docs/remote-service.example.json` to a private configuration file outside the checkout. Replace every example deployment value deliberately: HTTPS origin, numeric bind address, port, SIWE chain, session/device lifetimes, TLS paths, rate budget and quotas. The example hostname cannot serve a real deployment. The origin must exactly match the externally used HTTPS origin; the bind port may differ only with explicit TCP/TLS passthrough routing. No reverse-proxy headers are trusted and an HTTP-terminating proxy is unsupported. Use valid certificates for that origin; TLS1.2 or newer is required. Certificate changes require an operator-managed restart.

Provision a separate PostgreSQL database/schema and apply migrations001 through013 in order using the existing migration SQL and an appropriate migration role. The runtime role should have only the required read/write access. The launcher never runs migrations. It checks database connectivity and the migration013 history-index marker before listening; this marker is a readiness check, not a schema integrity audit or replacement for applying all migrations correctly. Configure database TLS verification for remote connections through the PostgreSQL connection settings; do not disable certificate verification.

Supply `REMOTE_DATABASE_URL` securely through the service manager, then run:

```sh
npm run start:remote -- --config /absolute/path/to/remote-service.json
```

There is no default database or listener. Configuration is strict and bounded to16KiB. Missing/invalid configuration, assets, certificates or database readiness fails startup without logging configuration values. The pool is capped at five connections with connection/query timeouts. Requests, headers, keep-alive and simultaneous sockets are bounded. SIGINT/SIGTERM stop new connections and drain the service; a ten-second deadline terminates lingering work. Unhandled pool/listener failures stop the service with an unsuccessful exit. Use an external service manager for restart policy; no scheduler is installed.

## Optional capabilities and retention

Omitting `privateRelay` keeps private-relay routes disabled. To enable them in an approved deployment, explicitly add `privateRelay` with validated `maxMessagesPerOwner` and `maxBytesPerOwner` quotas. The launcher fixes the confirmed policy: delete ciphertext after authenticated destination receipt, keep undelivered ciphertext until receipt or explicit deletion, and retain operational metadata for90 days. It does not grant endpoint permissions. Those remain separately controlled by each user/device.

Omitting `mcpClientCredentialHash` disables confidential MCP routes. Enabling them requires the separately provisioned client's SHA256 credential hash plus the existing owner/device delegation flow. Never place the plaintext credential in this JSON, page content or logs.

Schedule the existing `remote-cleanup` command separately with bounded batches and `--history-retention-days 90`, as described in `approved-remote-retention.md`. Provision host-log and backup expiry under the approved90-day policy. Starting this server alone does not establish scheduled cleanup or those retention guarantees. The launcher emits readiness/failure notices only, without request bodies, credentials or configuration values; infrastructure logging must preserve that boundary.

## Validation and remaining acceptance

The existing isolated PostgreSQL/HTTPS journey uses the same server constructor for its authenticated workflows and starts the actual CLI with temporary certificates and the isolated database schema. It verifies the built settings response, optional capabilities remaining off and graceful process shutdown. No personal browser, wallet, Mac storage or hosted service is used.

Production deployment, live sign-in/device pairing, distributed real-model acceptance and independent cryptographic review remain separate gates. This document provides a runnable deployment entry point, not a claim that those gates passed.
