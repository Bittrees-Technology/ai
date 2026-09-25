# Mac resumed-task model acceptance

One fixed synthetic arithmetic task passed through reviewed private resume permission, an authenticated encrypted local HTTP request and the actual LocalWorker using the installed original Qwen3.5:9B. The result was `7`, persisted as an unreviewed draft. Replaying the exact encrypted request returned its retained duplicate receipt and caused no second generation.

The evaluator and live-clock disposable fixture were committed before execution at `42edb2696f6cc34912496077f723c08a7104423d`. [Retained result](evidence/mac-resume-model-2026-09-25.jsonl) records the pinned model digest, source commit, result and one generation. The observed check ran from 06:48:51.898 to 06:48:59.078 UTC on 25 September 2026; this single observation is not a speed benchmark.

Run on the authorized Mac with `npx tsx scripts/mac-resume-model.ts`. The script requires committed sources, macOS, the literal loopback runtime and the existing exact original-model digest. It creates temporary encrypted task databases and memory key slots, uses a live clock, and closes/removes its disposable endpoint state afterward. No model is downloaded and no saved model profile or runtime default is changed.

This closes the bounded local API-to-real-model completion check. Identity/peer service responses and key slots are synthetic; this does not prove browser-to-model distributed completion, installed native-shell operation, live relay behavior, personal-source permissions, broad model accuracy or a release-ready pilot. Acer services and personal data/Keychain are untouched.
