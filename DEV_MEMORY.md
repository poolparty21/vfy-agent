# DEV_MEMORY.md — vfy

> Session log, newest first. Project contract: `AGENTS.md`. Workspace log: `C:\mnt\www\DEV_MEMORY.md`.

---

## 2026-10-22 — Agent registered as "missi" · real secret installed · preflight verified

**Status:** the agent is REGISTERED on the platform and live-verified with the
**real** platform secret. The remaining step is the platform's own first health
check + the owner's preflight run.

### The real secret is in place

- Dashboard-issued secret installed as the Worker secret
  `AGENT_GAMES_HMAC_SECRET` (the temporary test secret was replaced).
- **Backup:** the value is stored in the workspace secret store
  `C:\mnt\www\.env.local` under `AGENT_GAMES_HMAC_SECRET` (outside every git
  repo). The platform says the secret is shown ONCE and cannot be recovered —
  **that file is the only backup.** If the Worker secret is ever lost, rotate
  it on the dashboard and re-put it.
- The value itself is deliberately NOT written into this repo's files.

### Live verification with the REAL secret

| Check | Result |
|---|---|
| `GET /agent` | 200 `{"ok":true,"agent":"vfy-agent","protocolVersion":"v1"}` |
| `GET /health` | 200 `{"ok":true,"agent":"vfy-agent"}` |
| Preflight, secret as **text** | 200 `{"ok":true,"protocolVersion":"v1"}` |
| Preflight, secret as **decoded hex bytes** | 200 — both forms work |
| Response signature | Mirrors the incoming request's key form — correct for either (see the correction below) |
| Unsigned POST | 401 |

**Conclusion on the undocumented detail:** the platform's key form is not
determinable from outside — our response signature simply mirrors the form of
the incoming request. The dual-form code in `src/hmac.js` is what makes this
work either way, so it stays. (An earlier version of this note claimed the
platform used the text form; a controlled test later showed that claim was
wrong. See the correction further down.)

### The health-check fix

The dashboard said *"pending its first health check"*, and `GET /agent` was
returning **404** (only POST was routed). If the platform probes the
registered endpoint with a GET, a 404 reads as an offline agent and would fail
the check. Fixed: `GET /agent` now answers **200** with
`{ok, agent, protocolVersion}` (unauthenticated, like `/health`).
Regression test added — 54 tests, 54 pass.

### Agent identity

- Agent name on the platform: **`missi`**
- X account `leavinglasvegaz` · username `paperwwin` · GitHub `poolparty21`
- Signing wallet `0xbc32510486073532ba93694f0dede503642552a3`
- Endpoint registered: `https://vfy-agent.hallo-alexa.workers.dev/agent`

### Correction: the HMAC key form is UNRESOLVED (not "text" as first recorded)

The earlier note in this file said the platform keys the HMAC with the secret
as **text**. That was wrong — it was an inference from one observation, not a
measurement. A controlled test (2026-10-22 14:2x IST) shows the truth:

- Request signed with the secret as **text** → 200, response signed with **text**
- Request signed with the secret as **decoded hex bytes** → 200, response signed
  with **hex bytes**

The response signature **mirrors the form of the incoming request** (our
`src/hmac.js` remembers which key form verified and replies in the same form).
So we cannot tell from outside which form the platform uses — and it does not
matter, because our implementation answers in whatever form it received.

**What is certain:** the secret in the Worker is the platform's, and our
signing is byte-correct for whichever form the platform uses. The only way to
settle it is the platform's own preflight round-trip. Keep the dual-form
fallback; it is not redundant, it is the thing that makes this work either way.

### First-secret registration vs rotation

The owner registered the agent for the FIRST time and copied the one-time
secret straight from the registration panel. That is the normal path and
**no rotation is needed** — rotating would just invalidate the secret we
already installed. The secret in the Worker is the registration secret, and it
is the one the platform will use. (Rotation only becomes relevant if the
secret is ever exposed, or the platform itself asks for one.)

### Timeline (from the home page, 2026 timeline block)

| Date | What |
|---|---|
| 21 Oct | Registrations open |
| 21 Oct – 19 Nov | Creator and Wildcard tracks run |
| **23 Oct – 30 Oct** | **Proof Gatekeeper and Steal the VFY open** (8 daily rounds, 6:30–8:30 PM IST) |
| 2 Nov | IRL showdown in Mumbai, DevCon week |
| 19 Nov | The Agent Games close |

At the time of writing it was **22 Oct, 14:22 IST → 25 hours to round 01**.

### Next steps

1. **Watch the dashboard** — the first health check should now pass (it may
   still be pending if it ran before the GET fix; hit "recheck" if offered).
2. **Run preflight** on the platform — it must pass before the agent is marked
   active. It should pass: the same signed request we tested returns 200 with
   a correct signature.
3. **Run Practice tasks** — every trap type is reproducible there and it does
   not touch the leaderboard. Check each answer against the task history.
4. Commit the Steal the VFY strategy on the dashboard → put the published hash
   in `STRATEGY_COMMITMENT` in `wrangler.toml`.
5. Optional: `wrangler secret put KURIER_API_KEY` to enable live Groth16
   verification through Kurier.

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
