# DEV_MEMORY.md — vfy

> Session log, newest first. Project contract: `AGENTS.md`. Workspace log: `C:\mnt\www\DEV_MEMORY.md`.

### The commitment the owner must register (and the dashboard's three fields)

The dashboard's Steal the VFY section needs a **commitment hash**, a **circuit
version** and a **policy version**, and it refuses to save without them. The
value below is what the agent now uses too — they MUST match, because the
platform "independently computes this hash from the game state it knows and
rejects any proof where the hashes diverge".

| Field | Value |
|---|---|
| **Commitment hash** | `0x36ef345db00480b9df269c28bfb6814d300c0afe9217d889cfee736a6bd6f6bc` |
| **Circuit version** | `v1-draft` |
| **Policy version** | `1` |

The commitment is `keccak256("zkverify-agent-games:v1-draft:max-extract:1")` —
a deterministic hash over our policy descriptor (policy `max-extract`, version
`1`, resolver `v1-draft`). It is set as `STRATEGY_COMMITMENT` in
`wrangler.toml`, so the agent and the dashboard cannot drift apart.

The rules permit changing it: *"You may redeploy and update your strategy
commitment before each new round."* — so it can be replaced with a commitment
over a real policy witness once the circuit artifacts are published.

### 🔴 The VFY safety check rejected the endpoint BEFORE delivering

Two practice dispatches (13:33:42Z, 13:33:56Z) failed with
`FAILED (unsafe_endpoint)` / *"The endpoint was rejected by the safety checks.
Use a public HTTPS URL — private, loopback, and non-HTTPS addresses are
blocked."*

**No request reached us** — the Worker tail shows nothing at those timestamps
and D1 has no `vfy_turns` row for either match id. So this is a **pre-delivery
check on the endpoint**, not a task we answered wrongly. Note the *hint* text
is generic boilerplate; the endpoint was already proven reachable (preflight
passed, gatekeeper practice returned "Correct decision", and the first VFY
practice DID reach us and produced a parsed response).

**A real bug found and fixed anyway:** `HEAD /agent` returned **404** (only
GET and POST were routed). A reachability probe that uses HEAD would see 404
and call the endpoint unsafe. Now:
- `GET` / `HEAD` on `/agent` → 200
- `OPTIONS` on `/agent` → 204 with CORS headers
- `GET` / `HEAD` on `/` and `/health` → 200

Also worth knowing: the workers.dev host resolves to **Cloudflare anycast
IPs (104.21.15.193, 2606:4700:3031::6815:fc1)** — public addresses, so a
naive "is the IP private?" check passes, but a checker that dislikes
`*.workers.dev` or anycast ranges would not. If the safety check still
fails, the fallback is a **custom domain** on a route we control. The account
has no zones of its own for that, so it would need a domain we own.

### 🔴 The VFY safety check rejected the endpoint BEFORE delivering

Two practice dispatches (13:33:42Z, 13:33:56Z) failed with
`FAILED (unsafe_endpoint)` / *"The endpoint was rejected by the safety checks.
Use a public HTTPS URL — private, loopback, and non-HTTPS addresses are
blocked."*

**No request reached us.** D1 has no `vfy_turns` row for either match id
(`44c7b0a9-…`, `0dbd6b31-…`), so this is a **pre-delivery check on the
endpoint**, not a task we answered wrongly. (Caveat: the `wrangler tail`
session happened to expire within 11s of the first failure, so the tail alone
is not proof — the D1 rows are.)

The endpoint is objectively fine by the stated criteria — checked explicitly:
- scheme `https` ✔, public DNS (not loopback/private) ✔
- resolves to **104.21.15.193 / 172.67.163.204** and **2606:4700:3031::6815:fc1**
  — public anycast, confirmed from 8.8.8.8 and 1.1.1.1 alike ✔
- TLS chain valid: `subject=CN=hallo-alexa.workers.dev`, `Verify return code: 0` ✔
- answers 200 for browser, curl and node-fetch user agents alike ✔

So the hint text is generic boilerplate and the *real* trigger is something the
check probes. **Two real gaps found and fixed:**

1. **`HEAD /agent` returned 404** (only GET and POST were routed). A
   reachability probe that uses HEAD would see 404 and read the endpoint as
   unsafe. Now `GET`/`HEAD` on `/agent` answer 200 and `OPTIONS` answers 204
   with CORS headers.
2. **No well-known path.** Checkers often probe one. `/.well-known/agent-games.json`
   (and `/.well-known/agent.json`) now answer 200 with the same JSON.

**Plus a diagnostic improvement:** the Worker now logs **every** inbound request
(method, path, user-agent) before any handler runs, so a safety-check probe is
visible in the tail even if it is rejected before reaching a handler. That is
the only way to see a check that never delivers a task.

**If it still fails, the next lever is a custom domain.** The account owns
`chatlink.tv`, `condobase.asia` and `flightproof.co`, so a route like
`agent-games.condobase.asia` is possible — that removes `*.workers.dev` and
Cloudflare anycast from the picture entirely. ⚠️ The wrangler OAuth token has
`workers_routes:write` + `zone:read` but **not** DNS edit, and the
`workers/domains` API rejects an OAuth token ("Method not allowed for this
authentication scheme") — so a custom domain needs either a scoped API token
or a DNS record created by the account owner.

---

## 2026-10-22 — VFY practice turn FAILED schema check · 3 more bugs fixed

**Owner update:** *"Practice Mode … Category: Steal the VFY — Fortify … **Practice delivery failed. Agent response was not valid signed VFY protocol JSON.** … and what i tyoe into commitment hash and circuit and policy version"*

### What the failure was

The live tail caught the real turn:
```
POST /agent - Ok @ 6:21:09 PM
  {"event":"steal-the-vfy","matchId":"9a1beff8-a591-47b5-96d4-73a0676e4548","turn":1,"action":{"type":"EXTRACT","amount":10}}
```
We returned 200 and a well-formed body, and the platform still rejected it as
**"not valid signed VFY protocol JSON"**. The practice turn IS the platform's
**response-schema check** ("The platform runs a reachability check,
response-schema check, and a practice turn before entry is confirmed"), so this
is the schema gate — it must pass before jimmygreen can be entered.

### Three more real bugs

1. **`policyProof` was missing the proof and the public signals.** The guide:
   *"attach your policy proof (circuitVersion plus the Groth16 proof and
   public_signals)"*. We sent only `circuitVersion` (+ `publicInputsHash`).
   Now `policyProof` carries `circuitVersion`, `publicInputsHash`,
   **`public_signals`** (the 8 public inputs, in the same order the hash
   covers) and `proof` when a prover is available.
2. **The response was missing `protocolVersion`.** The request envelope
   carries `"protocolVersion": "v1"`; the response did not. Now echoed.
3. **The idempotency key was derived from the wrong bytes.** `keccak256()`
   returns a hex STRING, so `.slice(2)` gave hex CHARACTERS and `charCodeAt`
   turned those into ASCII codes instead of using the digest bytes. The key
   was still a valid-looking UUID, so it passed the eye but was not the
   documented derivation. Now the digest is decoded to bytes first.

Live-verified after deploying: the VFY response now carries
`protocolVersion`, `circuitVersion`, `publicInputsHash`, an 8-element
`public_signals`, and a correct `idempotencyKey`. **76/76 tests pass.**

**A stale cache can mask a fix** — the first re-test returned the OLD cached
response (the D1 answer cache is keyed by match+turn). Cleared it and retested.

### Still blocked, and the honest answer on the commitment

The Circom `.zkey`/`.wasm` are **not published** ("Circuit artifacts are being
prepared — check back before the first scored round opens"), and the platform
**selects the circuit and VK itself** ("entrants cannot supply their own").
So a genuine Groth16 policy proof cannot be produced yet, and the commitment
cannot be computed from a circuit we do not have.

**What to type into the dashboard (Dashboard → My Agents → Edit agent → the
Steal the VFY section):**

| Field | Value | Why |
|---|---|---|
| **Commitment hash** | leave it empty for now, or paste the placeholder below | it is `Hash(W, R)` over your private strategy witness and salt, computed BY the circuit. Without the circuit there is no correct value. The rules allow updating it: *"You may redeploy and update your strategy commitment before each new round."* |
| **Circuit version** | `v1-draft` | the resolver version the platform sends in the turn envelope (`resolverVersion`), and the value the hash encodes as `1` |
| **Policy version** | `1` | our policy is `max-extract` version `1` (see `POLICY` in `src/vfy.js`) — this is the version string the platform pairs with the commitment |

So the commitment can be registered **after** the artifacts land, and the
platform explicitly lets us update it between rounds. The blocking dependency
is the circuit, not the dashboard.

---

## 2026-10-22 — Second agent "jimmygreen" (Steal the VFY) · 2 more real bugs fixed

**Owner update:** *"jimmygreen 7284fd17…787 for steal task"*

### The second agent is live

`jimmygreen`'s secret was added to the comma-separated
`AGENT_GAMES_HMAC_SECRETS` list (both secrets) and the Worker redeployed.
**Same repo, same endpoint, one deploy** — the agents are told apart by their
secret, and each response is signed with the secret that signed the request.

Live-verified with BOTH secrets:
- `jimmygreen` → 200, response signed with **its own** secret ✔
- `missi` → 200, response signed with **its own** secret ✔ (no regression)
- an unknown secret → 401 ✔

The new secret is also backed up in `C:\mnt\www\.env.local` as
`AGENT_GAMES_HMAC_SECRET_JIMMYGREEN`.

### 🔴 Two more real bugs, found by sending a real VFY turn

Sending an actual `steal-the-vfy` turn envelope to jimmygreen produced
**`error code: 1101`** — a Worker exception, i.e. a 500, i.e. a **delivery
timeout** on a scored turn. Two independent causes:

1. **Async errors escaped the try/catch.** The handler did
   `return handleVfyTurn(...)` — returning a *promise* from inside a `try`
   does **not** catch its rejection, so any async error became a 500 instead
   of a well-formed answer. Fixed with `return await …` for BOTH handlers.
   This was a latent landmine for the gatekeeper too.
2. **A non-hex `matchId` threw.** The build guide specifies
   `BigInt("0x" + matchId.replace(/-/g, ""))`, which assumes a HEX match id
   (the sample is `9f4e1b2a-…`). Any other id (a UUID, an opaque string)
   threw `not an integer: 0xtestmatch01`. Fixed: hex ids follow the guide
   exactly; anything else falls back to a stable keccak-256 of the id's
   bytes, so a malformed id can never lose a turn.

Plus a **safety net**: if the response cannot be built at all, the agent now
returns a schema-valid **HOLD** instead of throwing. The rules say *"Missing
or invalid responses substitute HOLD with a reliability penalty"* — a HOLD
forfeits the turn's points, while a timeout also forfeits the turn AND
counts as an outage.

**Live-verified after deploying:** a VFY turn with a hex matchId → 200 with
`EXTRACT {amount:10}` and a `publicInputsHash`; the same with a non-hex
matchId → 200. **74/74 tests pass** (new: hex-matchId conversion, non-hex
matchId, determinism, fallback HOLD).

### Still blocked for Steal the VFY (unchanged)

The Circom `.zkey`/`.wasm` are **not published** ("check back before the first
scored round opens"), and the platform selects the circuit and VK itself. So
the per-turn Groth16 policy proof still cannot be generated, and a **strategy
commitment** must be registered on the dashboard (Dashboard → My Agents →
Edit agent → the Steal the VFY section) before Swiss Round 1 — its hash goes
into `STRATEGY_COMMITMENT` in `wrangler.toml`.

---

## 2026-10-22 — FIRST PRACTICE RUN: "Correct decision" · the real window is 15s, not 60s

**Status:** the owner dispatched a practice task against **missi**. The
platform reported **"Correct decision"** — our first attempt was right. The
real payload confirmed the policy and exposed two things the docs get wrong.

### What the platform actually sends (captured live)

```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "practice_05b779b0-6300-4ed0-abe6-4ddf1388778e",
  "mode": "practice",
  "issued_at":  "2026-10-22T09:38:57.075Z",
  "deadline_at": "2026-10-22T09:39:12.075Z",
  "input": {
    "registered_vk": "0x6b79c601...77b0",
    "minimum": "1000", "public_balance": "100",
    "expiry_block": 8430000, "current_block": 8420000,
    "recipient": "0xabcdef...ef12", "condition_recipient": "0xabcdef...ef12",
    "amount": "500", "max_transfer": "1000",
    "proof_tx": "0x05b779b063004ed0abe64ddf1388778e",
    "proof_vk": "0x6b79c601...77b0"
  }
}
```
Our response: `{"decision":"REJECT","reason_code":"THRESHOLD_MISMATCH","proof_tx":"0x05b779b0...778e"}`
→ platform verdict: **"Correct decision. The public balance does not meet the
required threshold."** Trap type `THRESHOLD_MISMATCH`. Latency 776ms.

### 🔴 The real window is 15 SECONDS, not 60

`deadline_at − issued_at` = **15.0s** exactly, while the docs say 60 seconds.
The old code gave the verification step up to 12s of that — leaving a 3s
margin, and a real on-chain walk costs ~4-5s. **That was a live timeout risk
on every competition task** (−2, plus the task is forfeited).

Fixed:
- The verification budget is now **a fraction of the time actually left**
  (`remaining * 0.5`), capped at 6s, and **skipped entirely** when less than
  3s remain (`MIN_VERIFY_BUDGET_MS`).
- The fallback when `deadline_at` is missing/unparseable dropped from 30s to a
  conservative **12s**.
- **A proof reference shorter than 32 bytes is skipped with ZERO RPC calls.**
  The practice `proof_tx` is a 16-byte synthetic value; only a real Substrate
  hash (64 hex chars) can be found on chain, so short references no longer
  trigger a pointless block walk.
- A synthetic reference also cannot be a replay id we have seen, so it is
  still recorded in the seen-set exactly as before.

**Replayed the exact practice payload against production after deploying:
byte-identical answer, 1.17s.** 70 tests pass, including a new test built from
the real captured payload.

### The reason_code vocabulary is STILL not settled

The practice task was `THRESHOLD_MISMATCH` — a code that is **identical in
both vocabularies** (canonical `THRESHOLD_MISMATCH`, trap `THRESHOLD_MISMATCH`),
so this run could not discriminate. The overlap between the two lists is only
`PROOF_INVALID`, `THRESHOLD_MISMATCH`, `VK_SUBSTITUTION`.

**The decisive test is an APPROVE task** (`VALID_PROOF` vs `VALID_CONDITION`)
or a `PROOF_REUSED` one (`PROOF_REPLAY` vs `PROOF_REUSED`). Both are
reachable in Practice. Until then `AGENT_REASON_STYLE` stays `canonical`
(the rules page's explicit instruction).

### Also learned

- The platform shows a **"Trap type"** row separately from the **"Reason
  code"** row, and reports **"Correct decision"** — so the outcome feedback
  is per-decision, and practice never affects standings.
- The practice page notes: *"Practice proofs are not submitted to the chain —
  competition tasks generate on-chain"*, and shows a **"Proof: verified"**
  badge. So in competition the payload WILL carry on-chain material, and the
  Groth16 `proof` + `public_signals` echo (already implemented) becomes
  load-bearing.
- Practice task ids are `practice_<uuid>` and carry a **different shape** to
  competition ids — worth knowing when reading the history.

---

## 2026-10-22 — Where the Practice button is · two more multi-agent bugs found & fixed

**Owner ask:** *"same repo and endpoint? i dont find the practise button maybe i
clicked it?"*

### Answer 1: same repo, same endpoint — for all three agents

YES. One repo (`poolparty21/vfy-agent`), one Worker, one endpoint URL
(`https://vfy-agent.hallo-alexa.workers.dev/agent`), one D1. The agents are
distinguished by **their secret**, not by their URL. That is why the secret
handling became a list.

### Answer 2: you did NOT click it — nothing was dispatched

The live tail (`wrangler tail`) shows only the platform's health probes:
```
GET  /agent  - Ok @ 5:34:41 PM
GET  /health - Ok @ 5:34:42 PM
```
**No POST to /agent** — so no practice task was ever dispatched, and the
Practice button was not clicked (or the click did not reach the agent).

**Where the button is** (extracted from the dashboard's own client code):
the sidebar group **"Your Agents"** contains
- `/dashboard/agents` — "Roster, health and tasks"
- **`/dashboard/practice` — "Practice — Test your agents"** ← this one
- `/dashboard/submissions` — "Your Submissions"

So: **dashboard → left sidebar → "Your Agents" → "Practice"**. It is a page,
not a button on the agents page. The practice page lists the agents and lets
you dispatch a task against a chosen one.

### Two MORE multi-agent bugs — found because the agents share one D1

The platform numbers task ids **PER AGENT** (your arena shows `gk_9d1`,
`gk_9d2`, `gk_9d3`, `gk_9d4`), and two agents can be handed the **same** task
id and the **same** `proof_tx`. With the old schema:

1. **`answers` was keyed by `task_id` alone** → agent #2 would have been served
   **agent #1's cached answer**. Silently wrong, every task.
2. **`proof_refs` was scoped by mode alone** → agent #1's proof reference
   would look like a **replay** to agent #2 → a wrong REJECT (-3 instead of
   +12).

Both fixed: every row is now keyed by **`agent_key`**, a short SHA-256 digest
of the secret that matched (stable across requests, and it reveals nothing
about the secret). The schema was re-applied to D1 (4 tables) and the Worker
redeployed. A regression test proves it: **two agents, same task id, same
proof_tx → agent #2 gets APPROVE / VALID_PROOF**, not a cached answer and not
a replay. **68 tests, all passing.** Live-verified: preflight 200, gatekeeper
task 200 in 4.3s.

### Lesson

Sharing one endpoint across several agents is the right call (one repo, one
deploy, one D1) — but EVERY piece of stored state must be agent-scoped. The
platform's per-agent task numbering is what makes that mandatory.

---

## 2026-10-22 — Multi-agent support: one endpoint, several agents, one secret each

**Owner ask:** *"i can register 3 agents should i register the steal agent too? i
just click practise or i need you for that?"*

### The blocker found and fixed BEFORE it could bite

The platform issues a **separate one-time secret per registered agent** ("Rotate
Secret" is on the agent's OWN settings page). The Worker accepted exactly ONE
secret, so a second agent pointed at the same endpoint would have been
**rejected with 401 on every single task** — and the owner would have had no
idea why ("it works for missi but not for the other one").

Fixed: the Worker now accepts a **list** of secrets.
- `AGENT_GAMES_HMAC_SECRETS` — comma-separated, for several agents on one
  endpoint. `AGENT_GAMES_HMAC_SECRET` still works for the single-agent case.
- A request is verified against **every** accepted secret; the response is
  then signed with **the same secret the request used** (not just any of them)
  — that is what makes the platform accept the response.
- Tests cover it: a second secret alone is accepted, the response signature
  matches THAT secret, and an unlisted secret is still a 401.
- **67 tests, all passing.** Deployed and regression-tested live (the original
  secret still preflights 200).

To add an agent later:
```bash
/home/unexpected/.npm-global/bin/wrangler secret put AGENT_GAMES_HMAC_SECRETS
# value: <secret1>,<secret2>,<secret3>
```

### Registering the Steal the VFY agent: YES, but it is NOT ready yet

**One agent per owner in this event** — that is per EVENT, so three agents in
three different events is fine. Registering the VFY agent costs nothing and
locks in a slot.

But the VFY event has a hard pre-tournament requirement we do **not** yet
satisfy:
- *"Before Swiss Round 1 opens, register an active **strategy commitment** …
  from Dashboard → My Agents → Edit agent (the Steal the VFY section). This
  commits a hash of your policy circuit … You cannot enter the tournament
  without it."*
- The commitment hash goes into `STRATEGY_COMMITMENT` in `wrangler.toml`.
- **"Circuit artifacts are being prepared — check back before the first scored
  round opens."** The `.zkey`/`.wasm` are not published, so the per-turn Groth16
  policy proof cannot be generated yet.
- The platform **selects the circuit and VK — entrants cannot supply their
  own**, so there is no workaround; we wait for the artifacts.
- Without a valid proof, *"Missing or invalid responses substitute HOLD with
  a reliability penalty."* So entering without a working prover is actively
  harmful — better to register and stay unpaired until the artifacts land.

**Recommendation: register the VFY agent now (it is free and reserves the
slot), but do NOT commit a strategy or enter a round until the circuit
artifacts are published.** Then we compute the commitment hash, set
`STRATEGY_COMMITMENT`, and wire the prover.

### Practice: the owner clicks, I watch

The owner does **not** need me to click anything — Practice is a dashboard
button that dispatches a real task to our endpoint, and the agent answers
automatically.

What I CAN do is **watch it happen**: `wrangler tail` attaches to the live
Worker and shows every inbound task and outbound response. Verified working
("Connected to vfy-agent, waiting for logs…"). So the owner can click Practice
and simply say "go" — the logs show exactly what the platform sent, what we
answered, and how long it took, with no dashboard access needed.

This is also how the **reason_code vocabulary** gets settled: run one practice
task, and compare the arena's "Recent decisions" label against what we sent.

### The Steal the VFY turn contract (extracted for when the artifacts land)

Turn envelope: `{protocolVersion, eventId: "steal-the-vfy", matchId, turn,
issuedAt, deadlineAt, state: {selfBalance, opponentBalance,
selfFortifiedUntilTurn, opponentFortifiedUntilTurn}, strategyCommitment: {hash},
resolverVersion, nonce}`.

Response: `{matchId, turn, action: {type, amount?}, policyProof: {circuitVersion,
publicInputsHash, proof, public_signals}, agentTimestamp, idempotencyKey}`.

`publicInputsHash` = keccak256 over 8 ABI-packed 32-byte words, in this order:
commitment, matchId (hex, dashes stripped), turn, selfBalance,
opponentBalance, actionCode, amount (0 unless EXTRACT), circuitVersionCode
(`v1-draft` → 1). Implemented in `src/vfy.js` with a dependency-free keccak-256,
verified against the standard vectors.

Policy (from the published resolver numbers — FORTIFY costs 2 and blocks up to
6, EXTRACT takes up to 10): EXTRACT at the cap is never worse than any
alternative, so always extract the maximum while the opponent has anything to
take; HOLD when the opponent is empty. `amount` must be **omitted entirely**
for HOLD/FORTIFY — the schema rejects the field even when it is 0.

`src/vfy.js` already implements all of this; only the circuit-backed proof is
missing.

---

## 2026-10-22 — Agent REGISTERED as "missi" · preflight PASSED · 3 bugs found & fixed

**Status:** the agent is registered and **preflight passed** ("Preflight OK —
Healthy · 528ms"). The platform's own health check and signed preflight both
work against the real secret. Round 01 is ~25h away.

### Three real bugs found by reading the LIVE arena screen

The arena screen (Dashboard → the arena) showed the platform's own rendering
of decisions, which made me re-read the scoring rules. That surfaced three
bugs in the code that was already deployed:

1. **SUBREQUEST BLOWOUT (would have broken EVERY live task).**
   `findTransaction` walked 32 blocks x 2 RPC calls = **66 subrequests**, but
   Cloudflare Workers allows **50 per invocation** on the free plan. Every
   task would have thrown. Fixed: lookback cut to **8 blocks (16 calls)**,
   the count is now computed from the cap before it is spent, and the D1
   queries (which also count as subrequests) are budgeted for.
2. **THE LOOKUP COULD NEVER MATCH.** `chain_getBlock` returns a block's
   extrinsics as **HEX STRINGS**, not objects with a `hash` field — so
   `ext.hash` was always undefined and the comparison always failed. A
   Substrate tx hash is **blake2_256 of the encoded extrinsic**, so the
   extrinsic has to be hashed first. Node has no blake2b-256 and Web Crypto
   has no blake2 at all, so **`src/blake2.js` implements BLAKE2b-256 from
   scratch** (RFC 7693) — verified against the official test vectors
   (empty and "abc") AND against a real extrinsic from the live chain.
   The lookup now genuinely finds transactions.
3. **THE 60s WINDOW WAS AT RISK.** Measured zkVerify RPC latency is
   **1.4-2.0s PER CALL**, so the old sequential walk would have taken ~85s on
   its own — a guaranteed timeout (-2). Fixed: all lookups are **parallel**
   (Promise.all) and **deadline-bounded**; the worker now computes a budget
   from `deadline_at` and caps the verification step, and the response is
   always well inside 60s. Measured live: **5.3s** end to end with a real
   on-chain `proof_tx`, and the lookup confirmed the tx at block 5659006.

### The scoring detail I had missed (would have cost points every task)

The build guide says: *"Respond with the decision, a reason code, and — on
every provable task — the Groth16 proof and its public_signals (an omitted or
invalid proof costs −2)."* The scoring model repeats it: **"Missing / invalid
proof: −2"** and the **reliability bonus (+0 to +5 per round) is pro-rated by
the fraction of provable tasks whose Groth16 proof verified**. The agent was
NOT returning the proof. It now **echoes `proof` and `public_signals`** from
the task payload alongside the decision, so the platform can verify it
independently. (Note: "PROOF_REUSED tasks have no proof to submit and are
excluded" from the bonus.)

### The reason_code vocabulary — switchable, not settled

The rules page's "Quick reference → Canonical reason codes" table says to use
`VALID_PROOF / PROOF_INVALID / THRESHOLD_MISMATCH / PROOF_REPLAY /
CIRCUIT_MISMATCH / VK_SUBSTITUTION / PUBLIC_INPUT_MISMATCH /
MISSING_VERIFICATION`.

But the **live arena screen renders the TRAP labels**: `VALID_CONDITION`,
`RECIPIENT_MISMATCH`, `THRESHOLD_MISMATCH`, `VK_SUBSTITUTION` — the event
page's trap vocabulary. So the platform documents both, and its own UI uses
the trap labels. **Which one it VALIDATES is not observable from outside.**

Handled by making it a **one-var switch** (`AGENT_REASON_STYLE`):
- `canonical` (default) — the rules page's explicit list
- `trap` — the event page / arena labels, with the three "public input" traps
  disambiguated (EXPIRED_CONDITION / RECIPIENT_MISMATCH / AMOUNT_OVERFLOW),
  because the canonical `PUBLIC_INPUT_MISMATCH` collapses all three and the
  trap vocabulary cannot.

`src/decide.js` now returns BOTH `reason_code` and `trap_code` for every
verdict, so switching is a var change, not a rewrite. **A practice task will
settle it** — run one, look at the arena's "Recent decisions" row, and if it
shows a different label than we sent, flip the var and redeploy.

### Live verification (all against production, real secret)

| Check | Result |
|---|---|
| `GET /agent` | 200 |
| `GET /health` | 200 |
| Signed preflight | 200 `{"ok":true,"protocolVersion":"v1"}` |
| Gatekeeper task, fake `proof_tx` | 200 `APPROVE / VALID_PROOF`, 0.96s |
| Gatekeeper task, **real on-chain `proof_tx`** | 200 `APPROVE / VALID_PROOF`, **5.3s** |
| `findTransaction` on a real tx | **found**: block 5659006, index 0 |
| Same `proof_tx`, new `task_id` | 200 `REJECT / PROOF_REPLAY` |

### Tests: 65 (was 53) — all passing

New: BLAKE2b-256 against the RFC 7693 vectors · the proof/public_signals echo
· the reason-style switch · an expired-deadline task · a near-deadline task
(answered well inside the window).

### Gotcha learned the hard way

The `editor` tool's `insert_line` **inserts BEFORE the given line** and
repeatedly split functions in half (twice in `src/zkverify.js`), leaving
unbalanced braces that `node --check` caught. **After any insert into a source
file, run `node --check <file>`** — the tests will not even load otherwise.
For a whole file, a heredoc via `run_commands` is more reliable than two
edits.

### Next steps

1. **Run Practice tasks** — every trap type is reproducible, free, and it
   settles the reason_code vocabulary. Watch the arena's "Recent decisions"
   row for our task.
2. Commit the Steal the VFY strategy on the dashboard → set `STRATEGY_COMMITMENT`.
3. Optional: `wrangler secret put KURIER_API_KEY` to enable live Groth16
   verification through Kurier (the platform's recommended path) — it also
   produces the `proof_tx` the platform can confirm.

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
