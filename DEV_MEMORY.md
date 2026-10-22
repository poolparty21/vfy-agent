# DEV_MEMORY.md — vfy

> Session log, newest first. Project contract: `AGENTS.md`. Workspace log: `C:\mnt\www\DEV_MEMORY.md`.

---

## 2026-10-22 — Agent built, deployed and verified live

**Status:** Proof Gatekeeper agent is built, tested (53/53), deployed and
verified working against the live platform endpoint.

### Deployed

- Worker `vfy-agent` → **https://vfy-agent.hallo-alexa.workers.dev**
- Agent path: `POST /agent` (full path — the dashboard requires it)
- D1 `vfy-agent` / `3e45bef3-3b81-4f44-8e61-b3961fae49b4`, schema applied (4 tables)
- A **temporary** HMAC secret is set in the Worker right now. It MUST be
  replaced with the real one from the dashboard's "Rotate Secret" before
  preflight will pass.

### Live verification (all against production)

| Check | Result |
|---|---|
| `GET /health` | `{"ok":true,"agent":"vfy-agent"}` |
| Unsigned POST | 401 (correct) |
| Signed preflight | `{"ok":true,"protocolVersion":"v1"}` + signed response header |
| Signed gatekeeper task | `{"decision":"APPROVE","reason_code":"VALID_PROOF",...}` |
| Same `proof_tx`, new `task_id` | `{"decision":"REJECT","reason_code":"PROOF_REPLAY",...}` — replay detection works on production D1 |
| D1 test rows | deleted afterwards |

### The protocol facts that were expensive to discover

These were NOT in the docs and had to be extracted from the platform's own
Next.js JS chunks and the rules page:

1. **Canonical reason codes** (rules → "Quick reference → Canonical reason
   codes"): `VALID_PROOF`, `PROOF_INVALID`, `THRESHOLD_MISMATCH`,
   `PROOF_REPLAY`, `CIRCUIT_MISMATCH`, `VK_SUBSTITUTION`,
   `PUBLIC_INPUT_MISMATCH`, `MISSING_VERIFICATION`.
   The trap encyclopedia on the event page uses DIFFERENT labels
   (`VALID_CONDITION`, `PROOF_REUSED`, `EXPIRED_CONDITION`,
   `RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW`). **Send the canonical list.**
   The trap labels map: PROOF_REUSED→PROOF_REPLAY, and
   EXPIRED/RECIPIENT/AMOUNT → PUBLIC_INPUT_MISMATCH.
2. **Scoring**: correct ±12, wrong APPROVE −6, wrong REJECT −3, timeout −2,
   missing proof −2, reliability bonus +0..+5 per round. ⇒ fail closed.
3. **Request/response shape**: request is
   `{type, task_id, mode, issued_at, deadline_at, input:{...}}`; response is
   `{decision, reason_code, proof_tx}`. Preflight is
   `{type:"agent-games.preflight.v1"}` → `{ok:true, protocolVersion:"v1"}`.
4. **60 second** response window.
5. **zkVerify mainchain RPC** is `https://zkverify-rpc.zkverify.io`
   (testnet `https://volta-rpc.zkverify.io`) — public, no auth, Substrate
   JSON-RPC. `chain_getFinalizedHead` + `chain_getBlock` work.
6. **Kurier**: `https://api.kurier.xyz/api/v1`,
   `POST /submit-proof/{apiKey}`, poll `GET /job-status/{apiKey}/{jobId}`
   until `Finalized`. Statuses: Queued, Valid, Submitted, IncludedInBlock,
   Finalized, Failed, AggregationPending, Aggregated, AggregationPublished.
7. **Circom artifacts are NOT published yet** ("Circuit artifacts are being
   prepared — check back before the first scored round opens"), so the
   Groth16 policy proof for Steal the VFY cannot be generated yet.
8. **Rounds**: 23–30 Oct 2026, 6:30–8:30 PM IST, 8 tasks/agent/round.
   Practice: 10 dispatches/hour, does not affect the leaderboard.
9. The platform's `/api/*` is not browsable (404s) and the dashboard is
   client-side rendered behind SIWE wallet auth — the protocol details had to
   come from the static JS chunks.

### Trap distribution (for expected-value reasoning)

VALID_CONDITION ~50%, VK_SUBSTITUTION ~13%, PROOF_REUSED ~11%,
THRESHOLD_MISMATCH ~8%, EXPIRED_CONDITION ~6%, RECIPIENT_MISMATCH ~6%,
AMOUNT_OVERFLOW ~6%.

### Gotchas hit

- `node --test test/` fails on Node 24 — the directory must be a glob:
  `node --test 'test/*.test.js'`.
- The `editor` tool's `insert_line` inserts BEFORE that line and truncated
  the tail of files when the payload was large. Two files needed repair
  afterwards. Prefer creating a file in one shot, or verify the tail after
  an insert.
- `wrangler whoami` / `d1 list` / `deploy` take >30s — the command tool
  times out. Run them with `nohup ... &` and read the output file after.
- `wrangler d1 create` twice → "A database with that name already exists".
- The D1 fake in the tests must support `prepare().all()` **unbound** —
  `listKnownVks` calls it that way.

### Competition identity

- X account: `leavinglasvegaz` · username: `paperwwin`
- GitHub: `poolparty21` (one GitHub account per competition account — the
  rules forbid running more than one)
- Signing wallet: `0xbc32510486073532ba93694f0dede503642552a3`

### Next steps

1. Dashboard → agent settings → **Rotate Secret**; copy the one-time
   plaintext → `wrangler secret put AGENT_GAMES_HMAC_SECRET` (replaces the
   temporary one) → redeploy.
2. Register the endpoint `https://vfy-agent.hallo-alexa.workers.dev/agent`
   (full path, HTTPS only).
3. Run **preflight** — must pass before the agent is marked active.
4. Run **Practice** tasks (each trap type is reproducible there) and check
   the answers against the task history.
5. Commit the strategy for Steal the VFY on the dashboard, and set
   `STRATEGY_COMMITMENT` in `wrangler.toml` to the published hash.
6. Get a Kurier API key → `wrangler secret put KURIER_API_KEY` to enable live
   Groth16 verification.
