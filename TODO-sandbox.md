# TODO — public OpenCode sandbox (orchestrated; the pod does the work)

Owner rule: the public instance NEVER sees the MIRA ledger. It gets its own ephemeral, SHA-256-chained ledger.
Not tenant-based: one sandbox per live session; when the person leaves, it is wiped.

| # | Step | Who | Status |
|---|------|-----|--------|
| 0 | Chassis cloned (`anomalyco/opencode` dev@f914cac3d4) → private `mmasoomi-glitch/opencode-chassis`, Sophia endpoints baked into `opencode.json` | done | ✅ |
| 1 | `code.vualet.com` live behind the lab key (nginx `code.conf` → cloudflared); `code.c-ram.ai` needs the CNAME below | done | ✅ |
| 2 | Mitigation: public UI returned 503 while the sandbox was built | me | ✅ |
| 3 | `bin/sandbox-ledger.py` + `bin/sandbox-session.sh` + `bin/test-sandbox.sh` — two pod OpenCode jobs produced zero files (worktree permission reject, then ran out mid-plan); written by me at $5.3 balance, committed to pod-infra | me (pod jobs failed) | ✅ |
| 4 | Verified on pod: `:8093` prompt_tokens 380 (sandbox brief, 0 MIRA text), `:8092` 2412 (private), `:8000` 19 (raw); tamper → `BROKEN at n=1`; stop wipes dir + listeners | me | ✅ |
| 5 | nginx `code.conf` → `:3020`; standing session + `sbreap` (60 min idle → wipe + fresh session) | me | ✅ |
| 6 | boot.sh does not yet start the sandbox after a pod rebuild (add `sandbox-session.sh start` + `sbreap` to boot) | next | ⏳ |
| 7 | Ledger rows + release claim | me | ⏳ |

Owner-only:
- DNS for `code.c-ram.ai`: CNAME `code` → `42504b56-e07e-4588-8c33-53b5728df7cf.cfargotunnel.com` (proxied) in the c-ram.ai zone. Everything behind it is already in place.
- Delete the accidental record `code.c-ram.ai.vualet.com` in the vualet.com zone.
- Money: $5.62 at 06:05 UTC, floor $5 → ~30 min of pod.
