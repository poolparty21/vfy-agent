// The prover registration path.
//
// A quick tunnel gets a new hostname every restart, so the prover registers its
// current url and the Worker prefers it. The rules under test: the body is
// signed with PROVER_TOKEN and checked before parsing, only https hosts are
// accepted, a replayed registration is refused, and — the point of the whole
// thing — a FRESH registration beats PROVER_URL while a STALE one does not.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { hmacHex } from "../src/hmac.js";
import { currentProver, PROVER_STALE_MS } from "../src/prover.js";

const TOKEN = "e".repeat(64);
const enc = new TextEncoder();
const NEW_URL = "https://brand-new-tunnel.trycloudflare.com";
const OLD_URL = "https://previous-tunnel.trycloudflare.com";
const CONFIG_URL = "https://configured-fallback.trycloudflare.com";

/** A D1 stand-in for the single-row `prover` table. */
function fakeDb(prover = null) {
  const state = { prover };
  return {
    state,
    prepare(sql) {
      const s = sql.replace(/\s+/g, " ").trim();
      const stmt = (args) => ({
        async run() {
          if (s.startsWith("INSERT INTO prover")) {
            state.prover = { url: args[0], circuits: args[1], updated_at: args[2] };
          }
          return { success: true };
        },
        async first() {
          if (s.startsWith("SELECT url, circuits, updated_at FROM prover")) return state.prover;
          return null;
        },
        async all() {
          return { results: [] };
        },
      });
      const base = stmt([]);
      base.bind = (...args) => stmt(args);
      return base;
    },
  };
}

const envelope = (overrides = {}) => ({
  url: NEW_URL,
  circuits: ["gatekeeper"],
  ts: Date.now(),
  ...overrides,
});

/** POST a registration, signed over the raw body exactly as the prover does. */
async function register(body, { env, token = TOKEN } = {}) {
  const raw = enc.encode(JSON.stringify(body));
  const headers = { "content-type": "application/json" };
  if (token !== null) headers["x-prover-signature"] = await hmacHex(enc.encode(token), raw);
  return worker.fetch(new Request("https://example.test/prover/register", { method: "POST", headers, body: raw }), env);
}

const envFor = (db) => ({ PROVER_TOKEN: TOKEN, DB: db });

test("health reports the prover source; with nothing registered, no prover", async () => {
  const res = await worker.fetch(new Request("https://example.test/health"), envFor(fakeDb()));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.prover, null);
});

test("a registration without a signature is refused", async () => {
  const res = await register(envelope(), { env: envFor(fakeDb()), token: null });
  assert.equal(res.status, 401);
});

test("a registration signed with the wrong token is refused", async () => {
  const res = await register(envelope(), { env: envFor(fakeDb()), token: "f".repeat(64) });
  assert.equal(res.status, 401);
});

test("without PROVER_TOKEN the route does not exist", async () => {
  const res = await register(envelope(), { env: { DB: fakeDb() } });
  assert.equal(res.status, 404);
});

test("a non-https url is refused", async () => {
  const res = await register(envelope({ url: "http://insecure.trycloudflare.com" }), { env: envFor(fakeDb()) });
  assert.equal(res.status, 400);
});

test("a stale timestamp is refused, so an old hostname cannot be resurrected", async () => {
  const res = await register(envelope({ ts: Date.now() - 60 * 60_000 }), { env: envFor(fakeDb()) });
  assert.equal(res.status, 409);
});

test("a valid registration is stored and becomes the prover url", async () => {
  const db = fakeDb();
  const res = await register(envelope(), { env: envFor(db) });
  assert.equal(res.status, 200);
  assert.equal(db.state.prover.url, NEW_URL);

  const prover = await currentProver({ DB: db, PROVER_URL: CONFIG_URL });
  assert.equal(prover.source, "registration", "a fresh registration must beat PROVER_URL");
  assert.equal(prover.url, NEW_URL);
  assert.deepEqual(prover.circuits, ["gatekeeper"]);
});

test("a stale registration falls back to PROVER_URL", async () => {
  const db = fakeDb({
    url: OLD_URL,
    circuits: JSON.stringify(["gatekeeper"]),
    updated_at: new Date(Date.now() - PROVER_STALE_MS - 60_000).toISOString(),
  });
  const prover = await currentProver({ DB: db, PROVER_URL: CONFIG_URL });
  assert.equal(prover.source, "config");
  assert.equal(prover.url, CONFIG_URL);
});

test("a stale registration with no PROVER_URL means no prover at all", async () => {
  const db = fakeDb({
    url: OLD_URL,
    circuits: "[]",
    updated_at: new Date(Date.now() - PROVER_STALE_MS - 60_000).toISOString(),
  });
  assert.equal(await currentProver({ DB: db }), null);
});

test("a fresh heartbeat keeps an unchanged url usable", async () => {
  const db = fakeDb();
  await register(envelope(), { env: envFor(db) });
  const first = await currentProver({ DB: db });
  assert.equal(first.url, NEW_URL);

  // Same hostname, new registration (what the 2-minute heartbeat sends).
  await register(envelope({ ts: Date.now() }), { env: envFor(db) });
  const second = await currentProver({ DB: db });
  assert.equal(second.url, NEW_URL);
  assert.equal(second.source, "registration");
});
