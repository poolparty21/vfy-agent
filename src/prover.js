// Worker-side client for the remote Groth16 prover (prover/server.mjs), and the
// endpoint the prover uses to tell us where it currently is.
//
// Proving needs more CPU and heap than a Worker has, so the proof is produced
// by a long-lived process reached over HTTPS and every request/response is
// HMAC-SHA256 signed with PROVER_TOKEN. A missing, slow or refusing prover
// costs the proof, never the answer: this module never throws and never waits
// past its budget.
//
// WHY REGISTRATION EXISTS
// The prover is reached through a Cloudflare quick tunnel, and a quick tunnel
// gets a NEW hostname every time it restarts. A url baked into wrangler.toml
// therefore goes stale, and the only symptom was a log line while every answer
// quietly lost its proof (-2 each). So the prover re-registers its current url
// (signed with PROVER_TOKEN) on start and every two minutes, the Worker stores
// it in D1 and prefers it — falling back to PROVER_URL only when no FRESH
// registration exists.
//
// A stale row means the prover stopped heartbeating, i.e. it is DOWN, not
// moved: using it would just add a failing round trip to every task, so the
// row is ignored until it refreshes.
import { hmacHex, safeEqual } from "./hmac.js";
import { getProver, saveProver } from "./store.js";

const enc = new TextEncoder();

export const PROVER_PATH = "/prover/register";
export const PROVER_HEADER = "x-prover-signature";

/** How long a registration is trusted. The prover heartbeats every 2 minutes. */
export const PROVER_STALE_MS = 10 * 60_000;

/** A registration older than this (clock skew either way) is a stale replay. */
const REGISTER_TS_WINDOW_MS = 5 * 60_000;

/** https://host[:port] — a tunnel hostname, or a named tunnel, or a custom host. */
const URL_SHAPE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/i;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/** True when this deployment has any prover configured at all. */
export function proverConfigured(env) {
  return Boolean(String(env.PROVER_TOKEN ?? "").trim()) && Boolean(env.PROVER_URL || env.DB);
}

/**
 * Where the prover is right now.
 *
 * A fresh registration wins. Only when there is none (nothing registered yet,
 * or the heartbeat lapsed) does PROVER_URL apply.
 *
 * @returns {Promise<{url: string, circuits: string[]|null, source: "registration"|"config",
 *   updatedAt?: string, ageMs?: number}|null>}
 */
export async function currentProver(env) {
  if (env.DB) {
    try {
      const row = await getProver(env.DB);
      const age = row ? Date.now() - Date.parse(row.updated_at ?? "") : Infinity;
      if (row?.url && Number.isFinite(age) && age >= 0 && age <= PROVER_STALE_MS) {
        let circuits = [];
        try {
          circuits = JSON.parse(row.circuits ?? "[]");
        } catch {
          circuits = [];
        }
        return { url: row.url, circuits, source: "registration", updatedAt: row.updated_at, ageMs: age };
      }
    } catch (err) {
      // A D1 hiccup must not take the answer down with it.
      console.warn(JSON.stringify({ event: "prover", error: `registration lookup failed: ${err?.message}` }));
    }
  }
  if (env.PROVER_URL) return { url: env.PROVER_URL, circuits: null, source: "config" };
  return null;
}

/**
 * POST /prover/register — the prover announcing its current url.
 *
 * Signed with PROVER_TOKEN over the RAW body, exactly like the agent path is
 * signed by the platform: the digest is checked before anything is parsed.
 * 404 when no prover is configured at all, so the route does not even admit it
 * exists on a deployment that never uses it.
 */
export async function handleProverRegister(request, env) {
  const token = String(env.PROVER_TOKEN ?? "").trim();
  if (!token || !env.DB) return new Response(null, { status: 404 });

  const raw = new Uint8Array(await request.arrayBuffer());
  if (!safeEqual(request.headers.get(PROVER_HEADER) ?? "", await hmacHex(enc.encode(token), raw))) {
    return new Response(null, { status: 401 });
  }

  let msg;
  try {
    msg = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const url = String(msg?.url ?? "").trim().replace(/\/+$/, "");
  if (!URL_SHAPE.test(url)) return json({ error: "url must be https://host" }, 400);

  // A replayed registration must not resurrect an old hostname.
  const ts = Number(msg?.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REGISTER_TS_WINDOW_MS) {
    return json({ error: "stale timestamp" }, 409);
  }

  const circuits = Array.isArray(msg?.circuits)
    ? msg.circuits.filter((c) => typeof c === "string" && c.length > 0 && c.length <= 40).slice(0, 8)
    : [];

  await saveProver(env.DB, { url, circuits });
  console.log(JSON.stringify({ event: "prover-register", host: new URL(url).host, circuits }));
  return json({ ok: true, circuits });
}

/**
 * Ask the prover for a Groth16 proof.
 *
 * @param {object} env
 * @param {string} circuit       "gatekeeper" | "steal-the-vfy"
 * @param {object} payload       whatever the circuit's map expects
 * @param {number} budgetMs      hard ceiling for the whole round trip
 * @param {{allowAlternate?: boolean}} [opts]
 * @returns {Promise<{proof: object, public_signals: string[], verified: boolean|null, alternate: boolean, ms: number|null}|null>}
 */
export async function requestProof(env, circuit, payload, budgetMs, { allowAlternate = false } = {}) {
  if (!proverConfigured(env) || budgetMs < 500) return null;
  const prover = await currentProver(env);
  if (!prover) return null;
  // A registering prover says which circuits it has; a configured one is trusted.
  if (Array.isArray(prover.circuits) && prover.circuits.length > 0 && !prover.circuits.includes(circuit)) {
    console.warn(JSON.stringify({ event: "prover", circuit, error: "prover does not offer this circuit" }));
    return null;
  }

  const body = enc.encode(JSON.stringify({ circuit, payload, allowAlternate }));
  try {
    const res = await fetch(`${prover.url}/prove`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [PROVER_HEADER]: await hmacHex(enc.encode(String(env.PROVER_TOKEN).trim()), body),
      },
      body,
      signal: AbortSignal.timeout(budgetMs),
    });
    const raw = new Uint8Array(await res.arrayBuffer());
    // An unsigned or wrongly signed response is not evidence of anything.
    if (!safeEqual(res.headers.get(PROVER_HEADER) ?? "", await hmacHex(enc.encode(String(env.PROVER_TOKEN).trim()), raw))) {
      console.warn(JSON.stringify({ event: "prover", circuit, status: res.status, error: "bad response signature" }));
      return null;
    }
    const out = JSON.parse(new TextDecoder().decode(raw));
    if (!res.ok || !out.proof) {
      console.warn(JSON.stringify({ event: "prover", circuit, status: res.status, error: out.error ?? "no proof" }));
      return null;
    }
    return {
      // snarkjs proofs carry curve "bn128"; rapidsnark's do not. Normalise so
      // the platform sees the same shape from either engine.
      proof: { ...out.proof, curve: out.proof.curve ?? "bn128" },
      public_signals: out.public_signals,
      verified: out.verified ?? null,
      alternate: Boolean(out.alternate),
      ms: out.ms ?? null,
    };
  } catch (err) {
    // Includes the AbortSignal timeout: the answer goes out without a proof.
    console.warn(JSON.stringify({ event: "prover", circuit, source: prover.source, error: err?.name ?? String(err) }));
    return null;
  }
}
