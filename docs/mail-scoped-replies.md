# Scoped background replies

The existing Mail connection grants one selected message/version. The existing reviewed-send connector requires approval of an exact message. Neither is widened by this feature.

`apps/mail-replies/start.ts` is a dedicated private, opt-in generation service. It accepts only bounded message text and owner-approved facts/scope, calls a pinned local Ollama model, validates strict structured output, and performs a second scope/evidence check. It cannot read mail, send email, invoke tools or access the companion store. Model classification is not a guarantee; automatic replies are for low-risk factual requests, with draft review recommended first.

Mail owns the separate expiring policy, sender list, quotas, final authorization, audit and pause control at https://mail.bittrees.org/automations. The Acer worker owns source checks, independent DKIM verification, drafts, delivery and durable duplicate suppression. It reaches this loopback service through the existing Pi-routed private SSH tunnel. Mail content is not sent to the public AI website or a cloud model.

Build using `npm run build:mail-replies`, then run `node dist/mail-replies/service.cjs /absolute/path/to/runtime.json`. The mode-0600 config contains exactly `token` (fresh 64-hex) and `model` (an installed local Ollama model). The only listener is `127.0.0.1:43129`. `/health` and `/reply` both require the dedicated token; browsers with an Origin header are rejected. Do not reuse the full companion credential or expose the port publicly.

Runtime model profile: context 32768, output limit 1500 tokens, temperature zero, one concurrent request, 120-second generation deadline. Invalid, unsupported or uncertain output never grants sending. A disconnected Mac stops new processing; Acer does not substitute another model/provider. Installing this service does not create or enable a mailbox policy.
