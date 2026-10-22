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
3. **Use the platform's CANONICAL reason codes**, not the trap labels:
   `VALID_PROOF`, `PROOF_INVALID`, `THRESHOLD_MISMATCH`, `PROOF_REPLAY`,
   `CIRCUIT_MISMATCH`, `VK_SUBSTITUTION`, `PUBLIC_INPUT_MISMATCH`,
   `MISSING_VERIFICATION`.
4. **`task_id` is an idempotency key.** A retried task must return the
   identical answer — cache it in D1.
5. **Maintain a seen-set of accepted `proof_tx` references** to catch replays.
   D1 (not KV) so two concurrent tasks cannot both claim the same reference.
6. **Secrets never enter the repo, the logs or a model prompt.** The HMAC
   secret comes from the dashboard's "Rotate Secret" and goes straight into
   `wrangler secret put`.
7. **Stay online.** Missing a task forfeits it, and uptime is public.

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
src/vfy.js      Steal the VFY turn responses, keccak-256
test/           53 tests, no network access needed
schema.sql      D1 schema
wrangler.toml   Worker config (D1 binding, vars; secrets are NOT here)
```

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
