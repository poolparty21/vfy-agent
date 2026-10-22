// HMAC-SHA256 request/response signing for the Agent Games protocol.
//
// Contract (from the platform build guide):
//   - the platform signs the RAW request body with the shared secret
//   - the signature travels in the `x-agent-games-signature` header
//   - we must verify it against the raw bytes BEFORE parsing the body
//   - every response we send must carry the same header over the raw response body
//
// Two details are undocumented, so both are handled defensively:
//   1. the secret is shown once as a 32-byte random value (64 hex chars) but the
//      platform may key the HMAC with the hex TEXT or with the DECODED BYTES
//      -> we try both and remember which one verified.
//   2. the header may be a bare hex digest or `sha256=<hex>`
//      -> we accept both on input and mirror the format we were given on output.

const enc = new TextEncoder();

export const SECRET_HEADER = "x-agent-games-signature";

/** Split a signature header into its optional `algo=` prefix and the hex digest. */
export function parseSignature(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const m = raw.match(/^([A-Za-z0-9_.-]+)=([0-9a-fA-F]+)$/);
  if (m) return { prefix: `${m[1]}=`, digest: m[2].toLowerCase() };
  return { prefix: "", digest: raw.toLowerCase() };
}

/** Candidate HMAC keys derived from the shared secret. */
export function keyForms(secret) {
  const s = String(secret ?? "").trim();
  const forms = [{ form: "text", key: enc.encode(s) }];
  const hex = s.replace(/^0x/i, "");
  if (hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(hex)) {
    forms.push({ form: "hex", key: Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16)) });
  }
  return forms;
}

/**
 * The set of secrets this endpoint accepts.
 *
 * The platform issues a SEPARATE one-time secret per registered agent
 * ("Rotate Secret" on the agent's own settings page). Several agents can
 * point at one endpoint, so the secret is a LIST: a comma-separated
 * `AGENT_GAMES_HMAC_SECRETS`, with the single `AGENT_GAMES_HMAC_SECRET` kept
 * working for the one-agent case.
 */
export function secretList(env) {
  const raw = [
    ...String(env.AGENT_GAMES_HMAC_SECRETS ?? "").split(","),
    env.AGENT_GAMES_HMAC_SECRET ?? "",
  ]
    .map((s) => String(s).trim())
    .filter(Boolean);
  return [...new Set(raw)];
}

/** HMAC-SHA256 hex digest of `bytes` under `keyBytes`. */
export async function hmacHex(keyBytes, bytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, bytes);
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time-ish comparison of two hex digests. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a request signature.
 * @returns {Promise<{ok: boolean, keyForm: string, prefix: string}>}
 *   `keyForm`/`prefix` describe the form that verified, so responses can mirror it.
 */
export async function verifySignature(secret, rawBody, headerValue) {
  const { prefix, digest } = parseSignature(headerValue);
  if (!digest) return { ok: false, keyForm: "text", prefix };
  for (const { form, key } of keyForms(secret)) {
    const expected = await hmacHex(key, rawBody);
    if (safeEqual(expected, digest)) return { ok: true, keyForm: form, prefix };
  }
  return { ok: false, keyForm: "text", prefix };
}

/**
 * A stable, non-secret identifier for the agent that owns a secret.
 *
 * Several agents can share one endpoint, and the platform numbers task ids
 * PER AGENT (gk_9d1, gk_9d2, ...). Every stored row is therefore scoped by
 * this key, so agent #2 is never served agent #1's cached answer and never
 * sees agent #1's proof references as replays.
 *
 * It is a short digest of the secret: stable across requests, and it reveals
 * nothing about the secret itself.
 */
export async function agentKeyFor(secret) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(String(secret ?? "")));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify a request signature against ANY of the accepted secrets.
 *
 * @param {string[]} secrets  the accepted secrets
 * @param {Uint8Array} rawBody  the raw request body
 * @param {string} headerValue  the `x-agent-games-signature` header
 * @returns {Promise<{ok: boolean, keyForm: string, prefix: string, secret: string, agentKey: string}>}
 *   `keyForm`/`prefix` describe the form that verified, so responses can
 *   mirror it; `secret` is the secret that matched and `agentKey` identifies
 *   the agent that owns it.
 */
export async function verifySignatureAny(secrets, rawBody, headerValue) {
  const { prefix, digest } = parseSignature(headerValue);
  if (!digest) {
    return { ok: false, keyForm: "text", prefix, secret: "", agentKey: "" };
  }
  for (const secret of secrets) {
    for (const { form, key } of keyForms(secret)) {
      const expected = await hmacHex(key, rawBody);
      if (safeEqual(expected, digest)) {
        return {
          ok: true,
          keyForm: form,
          prefix,
          secret,
          agentKey: await agentKeyFor(secret),
        };
      }
    }
  }
  return { ok: false, keyForm: "text", prefix, secret: "", agentKey: "" };
}

/** Produce a response signature header, mirroring the form used by the platform. */
export async function signBody(secret, bytes, { keyForm = "text", prefix = "" } = {}) {
  const form = keyForms(secret).find((f) => f.form === keyForm) ?? keyForms(secret)[0];
  const digest = await hmacHex(form.key, bytes);
  return `${prefix}${digest}`;
}
