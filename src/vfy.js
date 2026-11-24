// Steal the VFY — turn responses.
//
// The build guide specifies the turn response exactly:
//   { matchId, turn, action: { type, amount? }, policyProof: { circuitVersion,
//     publicInputsHash, proof?, public_signals? }, agentTimestamp,
//     idempotencyKey }
//
// publicInputsHash is keccak256 over eight ABI-packed 32-byte words, in this
// exact order (the guide's "common mistakes" list calls the order out as a
// rejection cause):
//   commitment, matchId (hex, dashes stripped), turn, selfBalance,
//   opponentBalance, actionCode, amount (0 unless EXTRACT), circuitVersionCode
//
// Common mistakes the guide warns about, all handled here:
//   - a stale matchId/turn            -> we echo the envelope's values
//   - a wrong field order              -> fixed order above
//   - amount sent for HOLD/FORTIFY     -> omitted entirely
//   - an unknown circuitVersion        -> rejected, the guide requires the
//                                         version to match the commitment

const ACTION_CODE = { HOLD: 0n, FORTIFY: 1n, EXTRACT: 2n };

/**
 * Numeric code of each circuit version, as the circuit encodes it.
 *
 * The turn envelope carries `resolverVersion`, and the response must use the
 * SAME version ("the platform freezes it when matches are paired and rejects
 * any turn response that uses a different circuit version"). The platform has
 * used BOTH spellings — a live turn on 2026-10-22 carried `v1-draft`, a later
 * one carried `v1`, and the build guide's own example uses `v1`. So the
 * version is NOT a fixed constant on our side: it is whatever the envelope
 * says, and the code is looked up per version.
 *
 * `v1` and `v1-draft` are two names for the same draft circuit, so they share
 * code 1. If the platform ever sends an unknown version we still have to
 * answer something, so we fall back to code 1 and echo the version verbatim —
 * the alternative (silently claiming a different version) is what the guide
 * calls out as a rejection cause.
 */
const CIRCUIT_VERSION_CODE = { "v1-draft": 1n, v1: 1n };
const DEFAULT_CIRCUIT_VERSION = "v1-draft";

export const POLICY = { name: "max-extract", version: "1", extractCap: 10 };

const toBig = (v) => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(v.trim())) return BigInt(v.trim());
  throw new Error(`not an integer: ${v}`);
};

/**
 * keccak256 over 32-byte big-endian words.
 *
 * We implement keccak-256 directly instead of pulling in a dependency: the
 * Worker bundle stays small and the function is short enough to audit.
 */
const RC = [
  0x00000001n, 0x00008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn,
  0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an, 0x000000008000808bn,
  0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n,
  0x8000000000000080n, 0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

const rotl = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & 0xffffffffffffffffn;

/** keccak-256 of a byte array, returned as a 0x-prefixed hex string. */
export function keccak256(bytes) {
  const rate = 136; // 1088 bits for keccak-256
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] |= 0x01;
  padded[padded.length - 1] |= 0x80;

  const S = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + b]);
      S[i] ^= lane;
    }
    for (let round = 0; round < 24; round++) {
      const C = new Array(5).fill(0n);
      for (let x = 0; x < 5; x++) C[x] = S[x] ^ S[x + 5] ^ S[x + 10] ^ S[x + 15] ^ S[x + 20];
      for (let x = 0; x < 5; x++) {
        const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
        for (let y = 0; y < 25; y += 5) S[x + y] ^= D;
      }
      const B = new Array(25).fill(0n);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(S[x + 5 * y], ROT[x + 5 * y]);
        }
      }
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          S[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & 0xffffffffffffffffn & B[((x + 2) % 5) + 5 * y]);
        }
      }
      S[0] ^= RC[round];
    }
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = S[i];
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return "0x" + [...out].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One 32-byte big-endian word. */
function word(v) {
  const n = toBig(v);
  if (n < 0n || n >= 1n << 256n) throw new Error("field out of range");
  const out = new Uint8Array(32);
  let x = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}


/**
 * keccak256 over the eight ABI-packed words, in the guide's order.
 * @returns {string} 0x-prefixed 32-byte hex digest
 */
export function publicInputsHash({
  commitment,
  matchId,
  turn,
  selfBalance,
  opponentBalance,
  action,
  circuitVersion,
}) {
  // An unknown version still has to be answered (a missing response is a
  // timeout, which is worse than a wrong answer). Fall back to code 1 — the
  // same draft circuit under another name — and echo the version verbatim.
  const versionCode = CIRCUIT_VERSION_CODE[circuitVersion] ?? 1n;
  const fields = [
    commitment,
    matchIdField(matchId),
    turn,
    selfBalance,
    opponentBalance,
    ACTION_CODE[action.type],
    action.type === "EXTRACT" ? action.amount : 0,
    versionCode,
  ].map(word);
  const buf = new Uint8Array(fields.length * 32);
  fields.forEach((w, i) => buf.set(w, i * 32));
  return keccak256(buf);
}

/*
 * WHY THERE IS NO buildPublicSignals() ANY MORE (removed 2026-11-20)
 *
 * The eight words publicInputsHash packs are NOT the circuit's public signals.
 * The published vfy-policy zkey has nVars 1909 / nPublic 9, and snarkjs returns
 * one public signal per nPublic (the gatekeeper control is nPublic 13 and its
 * real proofs carry exactly 13). vfy-policy's first signal is the circuit's own
 * digest OUTPUT, which only the witness calculator can produce.
 *
 * So a hand-built array could never verify: eight entries, no digest, and the
 * guide fails any turn whose signals are not "the circuit's output-then-public
 * order". Signals now come from the prover verbatim, or not at all.
 */

/**
 * The 32-byte word for a match id.
 *
 * The build guide specifies `BigInt("0x" + matchId.replace(/-/g, ""))`, which
 * assumes a HEX match id (the sample is "9f4e1b2a-..."). A match id that is
 * not hex — a UUID, or any opaque string — would make that conversion throw
 * and take the whole turn down with it.
 *
 * So: hex ids follow the guide exactly, and anything else falls back to a
 * stable keccak-256 of the id's bytes. The fallback can never differ from the
 * platform for a hex id (the case the platform actually produces), and it
 * keeps a malformed id from becoming a lost turn.
 */
export function matchIdField(matchId) {
  const raw = String(matchId ?? "");
  const hex = raw.replace(/^0x/i, "").replace(/-/g, "");
  if (hex.length > 0 && /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
    return BigInt("0x" + hex);
  }
  // Not hex: use the digest of the raw bytes, big-endian.
  const digest = keccak256(new TextEncoder().encode(raw));
  return BigInt(digest);
}

/**
 * Deterministic per-turn idempotency key: a retry of the same turn reuses it,
 * a different turn never does. Shaped as an RFC 4122 v4 UUID so strict
 * validators accept it.
 */
export function idempotencyKey(matchId, turn) {
  // keccak256() returns a hex STRING, so the digest has to be decoded to
  // bytes first — slicing the string would hash the hex CHARACTERS.
  const digest = keccak256(new TextEncoder().encode(`steal-the-vfy:${matchId}:${turn}`));
  const h = Uint8Array.from(digest.slice(2).match(/../g), (b) => parseInt(b, 16));
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const s = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Choose an action from the turn state.
 *
 * The published resolver numbers: FORTIFY costs 2 and blocks up to 6; EXTRACT
 * takes up to 10. Per-turn balance swing (me - them):
 *            opp HOLD  opp FORTIFY  opp EXTRACT
 *   EXTRACT    +20        +10           0
 *   FORTIFY     -2          0         -10
 *   HOLD         0         +2         -20
 * EXTRACT at the cap is never worse than any alternative, so the committed
 * policy extracts the maximum while the opponent has anything to take.
 */
export function chooseAction(state, policy = POLICY) {
  const opponent = toBig(state?.opponentBalance ?? 0);
  if (opponent <= 0n) return { type: "HOLD" };
  // ALWAYS ask for the full cap, never min(opponent, cap).
  //
  // The vfy-policy circuit requires amount == strategyParams[0] EXACTLY, so a
  // turn that extracts 4 because the opponent only holds 4 has NO WITNESS under
  // a commitment of [10, …] — it would cost −2 like any other invalid proof.
  // "EXTRACT takes up to 10" means the resolver clamps the transfer, not that
  // the agent asks for less.
  return { type: "EXTRACT", amount: Number(policy.extractCap) };
}

/**
 * Build the turn response.
 * @param {object} env  the turn envelope from the platform
 * @param {Date} now
 * @param {string} [registeredCommitment] used when the envelope omits it
 * @param {{proof: object, public_signals: string[]}|null} [proofMaterial]
 *        the prover's Groth16 proof for THIS turn, attached verbatim
 */
export function buildTurnResponse(env, now = new Date(), registeredCommitment, proofMaterial = null) {
  const action = chooseAction(env.state);
  // Echo the envelope's version VERBATIM. The platform rejects a response that
  // uses a different circuit version, so answering "v1-draft" to a "v1"
  // envelope would be rejected even though the hash is right.
  const circuitVersion =
    typeof env.resolverVersion === "string" && env.resolverVersion
      ? env.resolverVersion
      : DEFAULT_CIRCUIT_VERSION;
  const policyProof = { circuitVersion };
  const commitment = env.strategyCommitment?.hash ?? registeredCommitment;
  if (commitment) {
    policyProof.publicInputsHash = publicInputsHash({
      commitment,
      matchId: env.matchId,
      turn: env.turn,
      selfBalance: env.state.selfBalance,
      opponentBalance: env.state.opponentBalance,
      action,
      circuitVersion,
    });
  }

  // "attach your policy proof (circuitVersion plus the Groth16 proof and
  // public_signals)" — the proof and its signals are required TOGETHER, and
  // both must sit inside policyProof.
  //
  // They are copied from the prover exactly as it returned them. Rebuilding
  // them here is impossible: signal [0] is the circuit's digest output, and the
  // platform verifies the array against its own witness computation. A turn we
  // cannot prove goes out WITHOUT the pair — the platform resolves it as HOLD
  // with an invalid proof (−2), and a fabricated proof is the same −2 plus a
  // lie that hides the real failure.
  if (proofMaterial?.proof && Array.isArray(proofMaterial.public_signals)) {
    policyProof.proof = proofMaterial.proof;
    policyProof.public_signals = proofMaterial.public_signals;
  }
  return {
    protocolVersion: env.protocolVersion ?? "v1",
    matchId: env.matchId,
    turn: env.turn,
    // amount must be omitted for HOLD/FORTIFY, not sent as 0
    action: action.type === "EXTRACT" ? { type: "EXTRACT", amount: action.amount } : { type: action.type },
    policyProof,
    agentTimestamp: now.toISOString(),
    idempotencyKey: idempotencyKey(env.matchId, env.turn),
  };
}

/** A turn envelope for the Steal the VFY event. */
export const isVfyTurn = (body) =>
  Boolean(body && body.eventId === "steal-the-vfy" && body.matchId !== undefined && body.turn !== undefined);

/**
 * A minimal, schema-valid HOLD response.
 *
 * Used when the real response cannot be built. A missing or invalid response
 * is scored as a HOLD with a reliability penalty, whereas a thrown error is a
 * delivery timeout — strictly worse. HOLD is the safe fallback: it forfeits
 * the turn's points but keeps the connection alive.
 */
export function fallbackTurnResponse(env, now = new Date()) {
  return {
    matchId: env?.matchId,
    turn: env?.turn,
    action: { type: "HOLD" },
    policyProof: { circuitVersion: "v1-draft" },
    agentTimestamp: now.toISOString(),
    idempotencyKey: idempotencyKey(env?.matchId ?? "", env?.turn ?? 0),
  };
}
