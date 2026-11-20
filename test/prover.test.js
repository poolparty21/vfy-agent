// The prover registration path, and the call it exists to enable.
//
// A quick tunnel gets a new hostname every restart, so the prover registers its
// current url and the Worker prefers it. The rules under test: the body is
// signed with PROVER_TOKEN and checked before parsing, only https hosts are
// accepted, a replayed registration is refused, and — the point of the whole
// thing — a FRESH registration beats PROVER_URL while a STALE one does not.
//
// Registrations are kept one per url, because two provers can heartbeat at
// once (a PC quick tunnel and the Fly container). When both are fresh the
// choice must be deterministic and must prefer the stable host, or the Worker
// flips between them every two minutes.
//
// The second half drives requestProof itself against a mocked fetch, so a
// registration that is stored but never actually used cannot pass: the request
// must go to the registered url, carry exactly {circuit, payload}, be signed
// over those bytes, and refuse a response that is not signed back.

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { hmacHex } from "../src/hmac.js";
import { currentProver, requestProof, PROVER_STALE_MS, PROVER_HEADER } from "../src/prover.js";

const TOKEN = "e".repeat(64);
const enc = new TextEncoder();
const NEW_URL = "https://brand-new-tunnel.trycloudflare.com";
const OLD_URL = "https://previous-tunnel.trycloudflare.com";
const CONFIG_URL = "https://configured-fallback.trycloudflare.com";

/** A D1 stand-in for the `provers` table: one row per registered url. */
function fakeDb(...rows) {
  const state = { provers: new Map(rows.filter(Boolean).map((r) => [r.url, r])) };
  return {
    state,
    prepare(sql) {
      const s = sql.replace(/\s+/g, " ").trim();
      const stmt = (args) => ({
        async run() {
          if (s.startsWith("INSERT INTO provers")) {
            state.provers.set(args[0], { url: args[0], circuits: args[1], updated_at: args[2] });
          } else if (s.startsWith("DELETE FROM provers")) {
            for (const [url, row] of state.provers) if (row.updated_at < args[0]) state.provers.delete(url);
          }
          return { success: true };
        },
        async first() {
          return null;
        },
        async all() {
          return { results: [...state.provers.values()] };
        },
      });
      const base = stmt([]);
      base.bind = (...args) => stmt(args);
      return base;
    },
  };
}

/** A stored registration row, `ageMs` old. */
const storedRow = (url, ageMs = 0) => ({
  url,
  circuits: JSON.stringify(["gatekeeper"]),
  updated_at: new Date(Date.now() - ageMs).toISOString(),
});

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
  assert.equal(db.state.provers.get(NEW_URL).url, NEW_URL);

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

// --- two provers at once: the resolution must not depend on who beat last ----------

const STABLE_URL = "https://vfy-prover-missi.fly.dev";

test("a stable prover wins over a quick tunnel when both are fresh", async () => {
  // Both heartbeat inside the cut-off, so both are candidates. Last write used
  // to decide, which flipped the Worker between them every two minutes.
  for (const rows of [[storedRow(NEW_URL), storedRow(STABLE_URL)], [storedRow(STABLE_URL), storedRow(NEW_URL)]]) {
    const prover = await currentProver({ DB: fakeDb(...rows) });
    assert.equal(prover.url, STABLE_URL, "stable host wins regardless of insert order");
    assert.equal(prover.kind, "stable");
    assert.equal(prover.source, "registration");
    assert.deepEqual(prover.circuits, ["gatekeeper"]);
  }
});

test("a fresh tunnel is still used when the stable prover stopped beating", async () => {
  const db = fakeDb(storedRow(NEW_URL), storedRow(STABLE_URL, PROVER_STALE_MS + 60_000));
  const prover = await currentProver({ DB: db });
  assert.equal(prover.url, NEW_URL, "the quick-tunnel case must not regress");
  assert.equal(prover.kind, "tunnel");
});

test("a configured stable PROVER_URL beats a fresh tunnel registration", async () => {
  const prover = await currentProver({ DB: fakeDb(storedRow(NEW_URL)), PROVER_URL: STABLE_URL });
  assert.equal(prover.url, STABLE_URL);
  assert.equal(prover.source, "config");
  assert.equal(prover.kind, "stable");
});

test("a stable registration beats a stable PROVER_URL pointing at the same url", async () => {
  // The kind tie-break is not enough to decide this: only the source clause is.
  // The registration wins because it carries the circuit list.
  const prover = await currentProver({ DB: fakeDb(storedRow(STABLE_URL)), PROVER_URL: STABLE_URL });
  assert.equal(prover.url, STABLE_URL);
  assert.equal(prover.source, "registration");
  assert.equal(prover.kind, "stable");
  assert.deepEqual(prover.circuits, ["gatekeeper"]);
});

test("a failed provers read still resolves PROVER_URL, and says so", async (t) => {
  // A D1 hiccup must cost the registration, never the answer.
  const warn = t.mock.method(console, "warn", () => {});
  const brokenDb = {
    prepare() {
      return {
        async all() {
          throw new Error("D1_ERROR: network unavailable");
        },
      };
    },
  };
  const prover = await currentProver({ DB: brokenDb, PROVER_URL: CONFIG_URL });
  assert.equal(prover.source, "config");
  assert.equal(prover.url, CONFIG_URL);

  const logged = warn.mock.calls.map((c) => JSON.parse(String(c.arguments[0])));
  assert.equal(logged.length, 1);
  assert.equal(logged[0].event, "prover");
  assert.match(logged[0].error, /registration lookup failed/);

  // With nothing else configured the same failure means no prover, not a throw.
  assert.equal(await currentProver({ DB: brokenDb }), null);
});

test("two fresh stable registrations resolve to the newest, not the last written", async () => {
  const older = "https://prover-a.fly.dev";
  const newer = "https://prover-b.fly.dev";
  const prover = await currentProver({ DB: fakeDb(storedRow(older, 5 * 60_000), storedRow(newer, 60_000)) });
  assert.equal(prover.url, newer);
});

// --- the prove call the registration exists for ---------------------------------

const PROOF = {
  pi_a: ["1", "2", "1"],
  pi_b: [
    ["3", "4"],
    ["5", "6"],
    ["1", "0"],
  ],
  pi_c: ["7", "8", "1"],
  protocol: "groth16",
};

const circuitPayload = {
  input: { minimum: "1000", public_balance: "5000" },
  taskId: "task-0001",
  decision: "APPROVE",
  taskIdEncoding: "keccakModP",
};

/** A response with the prover's own signature over its raw body. */
async function proverResponse(obj, { status = 200, token = TOKEN } = {}) {
  const raw = enc.encode(JSON.stringify(obj));
  return new Response(raw, {
    status,
    headers: { "content-type": "application/json", [PROVER_HEADER]: await hmacHex(enc.encode(token), raw) },
  });
}

/**
 * Swap in a fetch that records what requestProof sends, and restore the real
 * one afterwards. Offline by construction: every call is answered by `handler`.
 */
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(calls.at(-1));
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Register a prover, then return an env whose only prover is that registration. */
async function registeredEnv({ circuits = ["gatekeeper"], url = NEW_URL } = {}) {
  const db = fakeDb();
  const res = await register(envelope({ url, circuits }), { env: envFor(db) });
  assert.equal(res.status, 200);
  return envFor(db);
}

test("a registered prover is called at its registered url with a signed body", async () => {
  const env = await registeredEnv();

  await withFetch(
    () => proverResponse({ proof: PROOF, public_signals: ["1", "0"], verified: true, ms: 74 }),
    async (calls) => {
      const out = await requestProof(env, "gatekeeper", circuitPayload, 4000);

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${NEW_URL}/prove`, "the registration, not the config, is the address");
      assert.equal(calls[0].init.method, "POST");
      assert.equal(calls[0].init.headers["content-type"], "application/json");

      // The wire body is exactly {circuit, payload} — no leftover options — and
      // the signature covers precisely those bytes.
      const body = Buffer.from(calls[0].init.body).toString("utf8");
      assert.equal(body, JSON.stringify({ circuit: "gatekeeper", payload: circuitPayload }));
      assert.deepEqual(Object.keys(JSON.parse(body)), ["circuit", "payload"]);
      assert.equal(calls[0].init.headers[PROVER_HEADER], await hmacHex(enc.encode(TOKEN), enc.encode(body)));

      assert.deepEqual(out, {
        proof: { ...PROOF, curve: "bn128" },
        public_signals: ["1", "0"],
        verified: true,
        ms: 74,
      });
    },
  );
});

test("a fresh registration is used instead of PROVER_URL", async () => {
  const env = { ...(await registeredEnv()), PROVER_URL: CONFIG_URL };

  await withFetch(
    () => proverResponse({ proof: PROOF, public_signals: [], verified: true, ms: 70 }),
    async (calls) => {
      assert.ok(await requestProof(env, "gatekeeper", circuitPayload, 4000));
      assert.equal(calls[0].url, `${NEW_URL}/prove`);
    },
  );
});

test("a prover advertising the wrong circuit is never called", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const env = await registeredEnv({ circuits: ["steal-the-vfy"] });

  await withFetch(
    () => {
      throw new Error("fetch must not be reached for a circuit the prover does not offer");
    },
    async (calls) => {
      assert.equal(await requestProof(env, "gatekeeper", circuitPayload, 4000), null);
      assert.equal(calls.length, 0);
    },
  );

  const logged = JSON.parse(String(warn.mock.calls[0].arguments[0]));
  assert.equal(logged.event, "prover");
  assert.match(logged.error, /does not offer this circuit/);
});

test("a response signed with the wrong token is refused", async () => {
  const env = await registeredEnv();

  await withFetch(
    () => proverResponse({ proof: PROOF, public_signals: [], verified: true, ms: 70 }, { token: "f".repeat(64) }),
    async () => {
      assert.equal(await requestProof(env, "gatekeeper", circuitPayload, 4000), null);
    },
  );
});

test("an unsigned refusal, or a 200 carrying no proof, yields no proof", async () => {
  const env = await registeredEnv();

  await withFetch(
    () => proverResponse({ error: "not provable", ms: 12 }, { status: 422 }),
    async () => {
      assert.equal(await requestProof(env, "gatekeeper", circuitPayload, 4000), null);
    },
  );

  await withFetch(
    () => proverResponse({ public_signals: [], verified: true, ms: 12 }),
    async () => {
      assert.equal(await requestProof(env, "gatekeeper", circuitPayload, 4000), null);
    },
  );
});

test("a prover that never answers costs the proof, not the caller", async () => {
  const env = await registeredEnv();

  await withFetch(
    ({ init }) =>
      new Promise((_resolve, reject) => {
        // Ref'd on purpose: AbortSignal.timeout's timer is unref'd, so nothing
        // would fire the abort if this were the only pending handle.
        const keepAlive = setTimeout(() => reject(new Error("never answered")), 5000);
        init.signal.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal.reason);
        });
      }),
    async () => {
      const started = Date.now();
      assert.equal(await requestProof(env, "gatekeeper", circuitPayload, 600), null);
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 500 && elapsed < 2000, `aborted inside the budget (${elapsed} ms)`);
    },
  );
});

test("no time left, or no fresh registration, means no call at all", async () => {
  await withFetch(
    () => {
      throw new Error("fetch must not be reached");
    },
    async (calls) => {
      assert.equal(await requestProof(await registeredEnv(), "gatekeeper", circuitPayload, 499), null);
      assert.equal(calls.length, 0, "a budget under the floor is not spent");

      const stale = envFor(
        fakeDb({
          url: OLD_URL,
          circuits: JSON.stringify(["gatekeeper"]),
          updated_at: new Date(Date.now() - PROVER_STALE_MS - 60_000).toISOString(),
        }),
      );
      assert.equal(await requestProof(stale, "gatekeeper", circuitPayload, 4000), null);
      assert.equal(calls.length, 0, "a stale registration is not dialled");
    },
  );
});
