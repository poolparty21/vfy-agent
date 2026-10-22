// End-to-end tests against the real Worker `fetch` handler.
//
// These exercise the wire contract: signature verification on the raw body,
// preflight, a gatekeeper task, idempotent retries and the replay set.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { hmacHex, SECRET_HEADER } from "../src/hmac.js";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const enc = new TextEncoder();
const VK = "0x7d3a0000000000000000000000000000000000000000000000000000f291";

/** A tiny in-memory D1 stand-in that mimics the SQL we actually run. */
function fakeDb() {
  const answers = new Map();
  const proofRefs = new Map();
  const knownVks = new Map();
  const vfyTurns = new Map();
  return {
    prepare(sql) {
      const s = sql.replace(/\s+/g, " ").trim();
      // Real D1 allows prepare().all() without bind(), so the statement
      // object exposes the same methods before and after bind().
      const stmt = {
        async run() {
          return { success: true };
        },
        async all() {
          if (s.startsWith("SELECT vk_hash FROM known_vks")) {
            return { results: [...knownVks.keys()].map((vk_hash) => ({ vk_hash })) };
          }
          return { results: [] };
        },
        async first(column) {
          return null;
        },
        bind(...args) {
          return {
            async run() {
              if (s.startsWith("INSERT OR IGNORE INTO answers")) {
                if (!answers.has(args[0])) answers.set(args[0], { response: args[2] });
              } else if (s.startsWith("INSERT OR IGNORE INTO proof_refs")) {
                const key = `${args[0]}|${args[1]}`;
                if (!proofRefs.has(key)) proofRefs.set(key, { task_id: args[2] });
              } else if (s.startsWith("INSERT OR IGNORE INTO known_vks")) {
                knownVks.set(args[0], { first_seen: args[1] });
              } else if (s.startsWith("INSERT OR IGNORE INTO vfy_turns")) {
                const key = `${args[0]}|${args[1]}`;
                if (!vfyTurns.has(key)) vfyTurns.set(key, { response: args[4] });
              }
              return { success: true };
            },
            async all() {
              return stmt.all();
            },
            async first(column) {
              let row = null;
              if (s.startsWith("SELECT response FROM answers")) row = answers.get(args[0]) ?? null;
              else if (s.startsWith("SELECT task_id FROM proof_refs")) {
                row = proofRefs.get(`${args[0]}|${args[1]}`) ?? null;
              } else if (s.startsWith("SELECT response FROM vfy_turns")) {
                row = vfyTurns.get(`${args[0]}|${args[1]}`) ?? null;
              }
              if (!row) return null;
              return column ? { [column]: row[column] } : row;
            },
          };
        },
      };
      return stmt;
    },
  };
}

const env = () => ({ AGENT_GAMES_HMAC_SECRET: SECRET, AGENT_PATH: "/agent", DB: fakeDb() });

/** POST a task the way the platform does: signed over the raw body. */
async function post(task, { secret = SECRET, path = "/agent", sign = true } = {}) {
  const raw = enc.encode(JSON.stringify(task));
  const headers = { "content-type": "application/json" };
  if (sign) headers[SECRET_HEADER] = await hmacHex(enc.encode(secret), raw);
  return worker.fetch(new Request(`https://example.test${path}`, { method: "POST", headers, body: raw }), env());
}

/** POST into a specific environment (for state that must persist). */
async function postTo(e, task) {
  const raw = enc.encode(JSON.stringify(task));
  return worker.fetch(
    new Request("https://example.test/agent", {
      method: "POST",
      headers: { [SECRET_HEADER]: await hmacHex(enc.encode(SECRET), raw) },
      body: raw,
    }),
    e,
  );
}

const gatekeeperTask = (inputOverrides = {}, taskOverrides = {}) => ({
  type: "agent-games.proof-gatekeeper.v1",
  task_id: "gk_test_1",
  mode: "competition",
  issued_at: "2026-10-22T10:00:00Z",
  deadline_at: "2026-10-22T10:01:00Z",
  ...taskOverrides,
  input: {
    registered_vk: VK,
    proof_vk: VK,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: "0xDe42000000000000000000000000000000009f01",
    condition_recipient: "0xDe42000000000000000000000000000000009f01",
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0xa4c10000000000000000000000000000000000000000000000000000008ff1",
    ...inputOverrides,
  },
});

test("health endpoint answers without a signature", async () => {
  const res = await worker.fetch(new Request("https://example.test/health"), env());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, agent: "vfy-agent" });
});

test("preflight returns ok and a signed response", async () => {
  const res = await post({ type: "agent-games.preflight.v1", agent_id: "agt_1", nonce: "abc" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, protocolVersion: "v1" });
  assert.ok(res.headers.get(SECRET_HEADER), "response must carry the signature header");
});

test("a request with a bad signature is refused with 401", async () => {
  const res = await post(gatekeeperTask(), { sign: false });
  assert.equal(res.status, 401);
});

test("a request signed with the wrong secret is refused", async () => {
  const res = await post(gatekeeperTask(), { secret: "f".repeat(64) });
  assert.equal(res.status, 401);
});

test("a request to the wrong path is a 404", async () => {
  const res = await post(gatekeeperTask(), { path: "/nope" });
  assert.equal(res.status, 404);
});

test("a GET on the registered agent path answers 200 (health check)", async () => {
  const res = await worker.fetch(new Request("https://example.test/agent"), env());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.protocolVersion, "v1");
});

test("a valid gatekeeper task is approved and signed", async () => {
  const res = await post(gatekeeperTask());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.decision, "APPROVE");
  assert.equal(body.reason_code, "VALID_PROOF");
  assert.ok(res.headers.get(SECRET_HEADER));
});

test("a VK substitution is rejected with the canonical reason code", async () => {
  const res = await post(
    gatekeeperTask({ proof_vk: "0xa4c1000000000000000000000000000000000000000000000000000000b8ff" }),
  );
  const body = await res.json();
  assert.equal(body.decision, "REJECT");
  assert.equal(body.reason_code, "VK_SUBSTITUTION");
});

test("a threshold mismatch is rejected", async () => {
  const res = await post(gatekeeperTask({ public_balance: "10" }));
  assert.equal((await res.json()).reason_code, "THRESHOLD_MISMATCH");
});

test("an expired condition is rejected", async () => {
  const res = await post(gatekeeperTask({ current_block: 19999999 }));
  const body = await res.json();
  assert.equal(body.decision, "REJECT");
  assert.equal(body.reason_code, "PUBLIC_INPUT_MISMATCH");
});

test("a recipient mismatch is rejected", async () => {
  const res = await post(
    gatekeeperTask({ condition_recipient: "0xde4200000000000000000000000000000000dead" }),
  );
  assert.equal((await res.json()).reason_code, "PUBLIC_INPUT_MISMATCH");
});

test("an amount above the cap is rejected", async () => {
  const res = await post(gatekeeperTask({ amount: "5000" }));
  assert.equal((await res.json()).reason_code, "PUBLIC_INPUT_MISMATCH");
});

test("a replayed proof reference is rejected", async () => {
  const e = env();
  const first = await postTo(e, gatekeeperTask());
  assert.equal((await first.json()).decision, "APPROVE");

  // A different task id carrying the same proof_tx is a replay.
  const second = await postTo(e, gatekeeperTask({}, { task_id: "gk_test_2" }));
  const body = await second.json();
  assert.equal(body.decision, "REJECT");
  assert.equal(body.reason_code, "PROOF_REPLAY");
});

test("a retried task gets the identical answer", async () => {
  const e = env();
  const one = await postTo(e, gatekeeperTask());
  const two = await postTo(e, gatekeeperTask());
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.deepEqual(await one.json(), await two.json());
});

test("an unknown task type is a 400, not a 500", async () => {
  const res = await post({ type: "agent-games.something-else.v1" });
  assert.equal(res.status, 400);
});

test("invalid JSON is a 400", async () => {
  const raw = enc.encode("{not json");
  const res = await worker.fetch(
    new Request("https://example.test/agent", {
      method: "POST",
      headers: { [SECRET_HEADER]: await hmacHex(enc.encode(SECRET), raw) },
      body: raw,
    }),
    env(),
  );
  assert.equal(res.status, 400);
});

