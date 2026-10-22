# vfy-agent — zkVerify Agent Games 2026

An agent endpoint for the [zkVerify Agent Games 2026](https://agentgames.zkverify.io)
competition, running on Cloudflare Workers.

The platform POSTs signed tasks to a public HTTPS endpoint and scores each
answer. This agent implements the **Proof Gatekeeper** event (approve or reject
a payment condition backed by a proof) and the **Steal the VFY** turn handler.

## Live endpoint

```
POST https://vfy-agent.hallo-alexa.workers.dev/agent
GET  https://vfy-agent.hallo-alexa.workers.dev/health
```

The dashboard requires the **full handler path**, so register
`https://vfy-agent.hallo-alexa.workers.dev/agent` — not the root domain.

## How it works

Every request carries `x-agent-games-signature`: an HMAC-SHA256 of the **raw**
request body, keyed with the secret the platform generates on "Rotate Secret".
The agent verifies that signature before parsing anything, and signs every
response the same way.

```
platform ──signed JSON──▶ POST /agent ──▶ verify HMAC over raw body
                                                 │
                                                 ├─ preflight      → { ok: true, protocolVersion: "v1" }
                                                 ├─ proof-gatekeeper → { decision, reason_code, proof_tx }
                                                 └─ steal-the-vfy   → turn response
```

### The decision

The Proof Gatekeeper payload describes a payment condition. Seven trap types
hide in it, and the agent must check every field — a proof that verifies
cryptographically can still be the wrong proof.

| Trap | Detection | Canonical reason code |
|---|---|---|
| Valid condition | every field agrees | `VALID_PROOF` |
| VK substitution | `proof_vk ≠ registered_vk` | `VK_SUBSTITUTION` |
| Threshold mismatch | `public_balance < minimum` | `THRESHOLD_MISMATCH` |
| Proof reused | `proof_tx` already claimed | `PROOF_REPLAY` |
| Expired condition | `current_block ≥ expiry_block` | `PUBLIC_INPUT_MISMATCH` |
| Recipient mismatch | `recipient ≠ condition_recipient` | `PUBLIC_INPUT_MISMATCH` |
| Amount overflow | `amount > max_transfer` | `PUBLIC_INPUT_MISMATCH` |

The platform documents **two** vocabularies: the rules page's "Canonical
reason codes" table and the event page's trap labels (`VALID_CONDITION`,
`PROOF_REUSED`, `EXPIRED_CONDITION`, `RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW`) —
the second is what its own arena screen renders. Which one it *validates* is
settled by a practice task, so it is a setting rather than a rewrite:

```toml
AGENT_REASON_STYLE = "canonical"   # or "trap"
```

### The response carries the proof

The build guide requires the Groth16 proof and its `public_signals` on every
provable task — an omitted or invalid proof costs **−2**, and the reliability
bonus (+0 to +5 per round) is pro-rated by the share of provable tasks whose
proof verifies. The agent echoes both from the task payload, alongside the
decision and the `proof_tx` the platform can confirm independently.

### Why it fails closed

The published scoring is asymmetric: a wrong APPROVE costs **−6**, a wrong
REJECT only **−3**, and a timeout **−2**. So anything missing, unparseable or
ambiguous is a REJECT, and no exception is ever allowed to become a 5xx.

### Staying inside the 60-second window

Three limits shape the runtime, and all three are enforced in code:

| Limit | Value | How it is respected |
|---|---|---|
| Response window | 60s | lookups are parallel and deadline-bounded from `deadline_at` |
| Subrequests (free plan) | 50 / invocation | the block walk is capped at 8 blocks (16 calls) and the count is computed before it is spent |
| zkVerify RPC latency | 1.4–2.0s / call | candidate blocks are fetched with `Promise.all` |

A Substrate transaction hash is `blake2_256` of the encoded extrinsic, and
neither Node nor Web Crypto offers blake2b-256 — so `src/blake2.js` implements
BLAKE2b-256 from scratch (RFC 7693), verified against the official test
vectors.

### State

D1 (not KV — the replay check needs strong consistency):

- `proof_refs` — the seen-set of proof references, scoped per mode
- `answers` — cached answers keyed by `task_id`, so a retried task gets the
  identical response
- `vfy_turns` — Steal the VFY turn log, for replays and disputes
- `known_vks` — registered VK hashes, to tell a circuit mismatch apart from a
  plain VK substitution

## Develop

```bash
npm test          # 53 tests, no network access required
```

Deploy (always with the **global** wrangler — a Windows-installed
`node_modules` breaks `wrangler` on Linux):

```bash
/home/unexpected/.npm-global/bin/wrangler deploy
/home/unexpected/.npm-global/bin/wrangler d1 execute vfy-agent --remote --file=schema.sql
/home/unexpected/.npm-global/bin/wrangler secret put AGENT_GAMES_HMAC_SECRET
```

## zkVerify

- Mainchain RPC: `https://zkverify-rpc.zkverify.io` (public, Substrate JSON-RPC)
- Testnet RPC: `https://volta-rpc.zkverify.io`
- Kurier REST: `https://api.kurier.xyz/api/v1` — submit a Groth16 proof with
  the **registered** VK hash and poll the job until it reaches `Finalized`

Set a Kurier key with `wrangler secret put KURIER_API_KEY` to enable live
proof verification.

## Layout

```
src/hmac.js     signature verification and signing (raw body only)
src/decide.js   the deterministic policy — pure, no I/O
src/worker.js   the HTTP contract: routing, preflight, task handlers
src/store.js    D1 access
src/zkverify.js on-chain verification
src/vfy.js      Steal the VFY turn responses, keccak-256
```

See `AGENTS.md` for the project contract and `DEV_MEMORY.md` for the session log.
