# AGENTS.md — vfy (zkVerify Agent Games 2026)

> Project contract for the agent in `C:\mnt\www\vfy`. Workspace conventions live in
> `C:\mnt\www\AGENTS.md`; the skill trigger table lives in `C:\mnt\www\SKILLS.md`.

## What this project is

An agent endpoint for the **zkVerify Agent Games 2026** competition
(`https://agentgames.zkverify.io`). The platform POSTs signed tasks to our
registered HTTPS endpoint and scores the answers.

- **Proof Gatekeeper** — the event we are entered in. We receive a payment
  condition plus a proof reference and must return APPROVE or REJECT.
- **Steal the VFY** — a turn-based game event. Handler is implemented; the
  Groth16 policy proof waits on the platform publishing the circuit artifacts.

## The rules that decide everything

Scoring (from the platform's "Points per task" table):

| Outcome | Points |
|---|---|
| Correct APPROVE | +12 |
| Correct REJECT | +12 |
| Incorrect APPROVE | **−6** |
| Incorrect REJECT | −3 |
| Delivery timeout (no answer in 60s) | −2 |
| Missing / invalid proof | −2 |
| Reliability bonus (per round) | +0 to +5 |

**Consequence: a wrong APPROVE costs twice a wrong REJECT.** The policy
therefore fails closed — anything missing, unparseable or ambiguous is a
REJECT. Never let an exception turn into a 5xx: a 5xx is recorded as a
delivery timeout.

## Hard rules

1. **Verify the HMAC signature against the RAW body BEFORE parsing.** The
   digest is in `x-agent-games-signature`. Every response must carry the same
   header over the raw response body.
2. **Never verify with `proof_vk`.** Always use `registered_vk`.
3. **Send a reason code from the platform's lists.** Two exist — the rules
   page's "Canonical reason codes" (`VALID_PROOF`, `PUBLIC_INPUT_MISMATCH`, …)
   and the event page's trap labels (`VALID_CONDITION`, `RECIPIENT_MISMATCH`,
   …), the latter being what the arena renders. `AGENT_REASON_STYLE` selects
   between them; `src/decide.js` computes both, so switching is a var change.
4. **`task_id` is an idempotency key.** A retried task must return the
   identical answer — cache it in D1.
5. **Maintain a seen-set of accepted `proof_tx` references** to catch replays.
   D1 (not KV) so two concurrent tasks cannot both claim the same reference.
6. **Return the proof.** Every provable task needs the Groth16 `proof` and its
   `public_signals` in the response — omitting them costs −2 and forfeits the
   reliability bonus.
7. **Secrets never enter the repo, the logs or a model prompt.** The HMAC
   secret comes from the dashboard's "Rotate Secret" and goes straight into
   `wrangler secret put`.
8. **Stay online.** Missing a task forfeits it, and uptime is public.

## Three limits the runtime must respect

| Limit | Value | Enforced by |
|---|---|---|
| Response window | 60s | lookups parallel + deadline-bounded from `deadline_at` |
| Subrequests (free plan) | 50 / invocation | block walk capped at 8 blocks; count computed before spending |
| zkVerify RPC latency | 1.4–2.0s per call | candidate blocks fetched with `Promise.all` |

A Substrate tx hash is `blake2_256` of the encoded extrinsic, so
`src/blake2.js` implements BLAKE2b-256 (RFC 7693) from scratch — Node and
Web Crypto have no blake2b-256.


## The two undocumented details (handled defensively)

- The secret is shown once as 32 random bytes (64 hex chars) but the platform
  may key the HMAC with the hex TEXT or the DECODED BYTES → `src/hmac.js`
  tries both and remembers which one verified.
- The header may be a bare hex digest or `sha256=<hex>` → we accept both and
  mirror the format we were given.

## Layout

```
src/hmac.js     signature verification and signing (raw body only)
src/decide.js   the deterministic policy — pure, no I/O, fully unit tested
src/worker.js   the HTTP contract: routing, preflight, task handlers
src/store.js    D1 access: replay seen-set, answer cache, turn log
src/zkverify.js on-chain verification (Kurier) + zkVerify RPC reads
src/vfy.js      Steal the VFY turn responses, keccak-256, circuit version
scripts/verify-proof-reference.mjs   re-check the published proof reference
test/           87 tests, no network access needed
schema.sql      D1 schema
wrangler.toml   Worker config (D1 binding, vars; secrets are NOT here)
```

## The commitment is a Steal the VFY field — not Proof Gatekeeper

**Proof Gatekeeper has NO commitment.** The Gatekeeper page never mentions it;
Steal the VFY does, and VFY's pre-tournament rule is *"You cannot enter the
tournament without it."* So:

| Agent | Event | commitment field? |
|---|---|---|
| `missi` | Proof Gatekeeper | **no — nothing to fill in** |
| `jimmygreen` | Steal the VFY | **yes — Dashboard → My Agents → jimmygreen → Edit → the Steal the VFY section** |

The four secrets map to the platform agents like this (proved by matching each
secret to its agentKey and to the D1 rows):

| secret env var | agentKey | agent |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | `d010c67c80f1f176` | missi (original) |
| `AGENT_GAMES_HMAC_SECRET_JIMMYGREEN` | `57c2e98a1e7f2e6d` | jimmygreen (original) |
| `AGENT_GAMES_HMAC_SECRET_ROTATED` | `96218151c607b016` | **jimmygreen (rotated) — the VFY agent** |
| `AGENT_GAMES_HMAC_SECRET_MISSI_ROTATED` | `52293fd21240a55b` | **missi (rotated) — the Gatekeeper agent** |

## The circuits are published — `/api/circuit-info`

`GET https://agentgames.zkverify.io/api/circuit-info` returns each circuit's
`vkHash` and artifact URLs (the wasm and zkey both download, HTTP 200). The old
"artifacts are being prepared" blocker is gone.

- gatekeeper vkHash `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- vfyPolicy vkHash `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`

From the zkeys: gatekeeper has **12 public inputs**, vfy-policy has **8** — and
our `publicInputsHash` covers exactly **eight** words, so its shape is right.

The circuits' real input signal names (they are NOT strings in the wasm —
circom hashes them with FNV-1a-64, so recover them by probing
`getInputSignalSize`):

- **vfy-policy** (17 inputs): `commitment`, `salt`, `matchId`, `turnNumber`,
  `selfBalance`, `opponentBalance`, `action`, `amount`, `circuitVersion`
  + 8 private witness inputs still to identify.
- **gatekeeper** (13 inputs): `minimum`, `publicBalance`, `amount`,
  `expiryBlock`, `currentBlock`, `recipient`, `conditionRecipient`,
  `maxTransfer`, `salt`, `registeredVkHash` + 3 still to identify.

Note `turnNumber` (not `turn`) and `registeredVkHash` (not `registeredVk`).

## `resolverVersion` must be echoed VERBATIM

The platform has sent **both** `"v1-draft"` and `"v1"`, and the build guide's
example uses `"v1"`. The platform *"rejects any turn response that uses a
different circuit version"*, so the response must use whatever the envelope
said. `CIRCUIT_VERSION_CODE` maps both spellings to code 1 (same circuit), and
an unknown version falls back to code 1 instead of throwing — a missing
response is a delivery timeout (−2), which is worse than a wrong answer.

## The published proof reference

The Wildcard submission publishes one real, finalized zkVerify mainchain
transaction:

```
0x52f943ec94d2adc0ee2554efc8540a52cefedfc6366012f26466f4fb831930ab
```

A Groth16 proof submitted to `settlementGroth16Pallet.submitProof` in block
**5664252** (`0xbf30d6b5…32c3a9`), extrinsic index 2, acknowledged by the chain
with a `ProofVerified` event for statement `0x25ba6951…91b463` against the
on-chain registered VK `0xeff0bb5f…3c24a10`.

It is checked three ways, all of which must agree:
- `node scripts/verify-proof-reference.mjs` — no dependencies, no API key
- `GET https://vfy-agent.hallo-alexa.workers.dev/proof-reference` — the same
  check, live, for reviewers
- `https://zkverify.subscan.io/extrinsic/<hash>` — an independent explorer

⚠️ **Never substitute the practice `proof_tx`.** It is synthetic and only 16
bytes. A real reference is 32 bytes and must resolve on chain.

## How the zkVerify chain is read (no @polkadot/api in production)

The runtime has **no dependencies** — the proof libraries are written from
scratch. Reading the chain needs three things:

1. **The pallet names.** `settlementGroth16Pallet` (index 161) is the Groth16
   verifier; `aggregate` (81) holds the aggregation domain state. The names
   live in the runtime metadata, not in the RPC.
2. **`blake2_256` of the encoded extrinsic** = the transaction hash. That is
   `src/blake2.js`; the RPC returns extrinsics as bare hex strings, so the
   hash has to be computed, not read.
3. **Storage prefixes** (`twox128`) if a storage map is read directly. The
   canonical `System::Events` key is the test vector: `twox128("System") ++
   twox128("Events")` must equal
   `0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7`.

For one-off investigation, `@polkadot/api` can be installed in the
gitignored `.tooling/` directory — it is **not** a project dependency and
must never end up in `package.json`.

## Commands

```bash
npm test                              # 53 tests, no network
/home/unexpected/.npm-global/bin/wrangler deploy
/home/unexpected/.npm-global/bin/wrangler d1 execute vfy-agent --remote --file=schema.sql
/home/unexpected/.npm-global/bin/wrangler secret put AGENT_GAMES_HMAC_SECRET
```

⚠️ **Use the GLOBAL wrangler** (`/home/unexpected/.npm-global/bin/wrangler`).
A project-local `node_modules` on Windows carries
`@cloudflare/workerd-windows-64`, which breaks `wrangler` on Linux.

## Deploy target

- Worker: `vfy-agent` → `https://vfy-agent.hallo-alexa.workers.dev`
- Agent path: `POST /agent` (the dashboard wants the FULL path, not the root)
- D1: `vfy-agent` / `3e45bef3-3b81-4f44-8e61-b3961fae49b4`
- Account: `Hallo_alexa@pm.me` (`5ba10289ae72efe68ba890bf4b509a34`)
