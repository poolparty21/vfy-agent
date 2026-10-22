// Deterministic Proof Gatekeeper policy.
//
// Every check fails closed: anything missing, unparseable or ambiguous is a
// REJECT. Rationale from the published scoring model: a wrong APPROVE costs
// -6, a wrong REJECT only -3, and a delivery timeout costs -2 — so an
// unparseable condition is always cheaper to reject.
//
// Reason codes are the platform's CANONICAL enum (Agent Games rules,
// "Quick reference -> Canonical reason codes"). The trap encyclopedia uses
// different labels (VALID_CONDITION, PROOF_REUSED, EXPIRED_CONDITION,
// RECIPIENT_MISMATCH, AMOUNT_OVERFLOW); the canonical list is the one the
// rules tell us to send as `reason_code`, so the trap-specific ones map:
//
//   PROOF_REUSED       -> PROOF_REPLAY
//   EXPIRED_CONDITION  -> PUBLIC_INPUT_MISMATCH
//   RECIPIENT_MISMATCH -> PUBLIC_INPUT_MISMATCH
//   AMOUNT_OVERFLOW    -> PUBLIC_INPUT_MISMATCH
//
// The decision (APPROVE / REJECT) is what the platform scores; the reason code
// is the machine-readable explanation of it.

export const REASON = {
  VALID: "VALID_PROOF",
  PROOF_INVALID: "PROOF_INVALID",
  THRESHOLD_MISMATCH: "THRESHOLD_MISMATCH",
  PROOF_REPLAY: "PROOF_REPLAY",
  CIRCUIT_MISMATCH: "CIRCUIT_MISMATCH",
  VK_SUBSTITUTION: "VK_SUBSTITUTION",
  PUBLIC_INPUT_MISMATCH: "PUBLIC_INPUT_MISMATCH",
  MISSING_VERIFICATION: "MISSING_VERIFICATION",
};

/** Addresses are hex: compare case-insensitively and ignore the 0x prefix. */
export function normAddress(v) {
  if (typeof v !== "string") return "";
  return v.trim().toLowerCase().replace(/^0x/, "");
}

/** Accept a bigint, a safe integer, or a decimal/hex string. */
export function toBig(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? BigInt(v) : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(s)) return BigInt(s);
  }
  return null;
}

/**
 * Pick the first present value among a list of candidate field names.
 * The platform's payload uses snake_case; tolerate a couple of aliases so a
 * schema tweak upstream does not silently turn into a wrong REJECT.
 */
export function pick(input, names) {
  for (const n of names) {
    if (input[n] !== undefined && input[n] !== null && input[n] !== "") return input[n];
  }
  return undefined;
}

export const reject = (reason_code) => ({ decision: "REJECT", reason_code });


/**
 * Decide a Proof Gatekeeper task.
 *
 * @param {object} input            task.input from the platform
 * @param {object} [opts]
 * @param {boolean} [opts.isReplay]        proof reference already accepted for another task
 * @param {boolean} [opts.verificationOk]  a real zkVerify call confirmed the proof
 * @param {boolean} [opts.verificationFailed] a real zkVerify call rejected the proof
 * @param {string[]} [opts.knownVks]  other VK hashes known to be registered on-chain
 * @returns {{decision: "APPROVE"|"REJECT", reason_code: string}}
 */
export function decide(input, opts = {}) {
  const { isReplay = false, verificationOk = false, verificationFailed = false, knownVks = [] } = opts;

  if (!input || typeof input !== "object" || Array.isArray(input)) return reject(REASON.PROOF_INVALID);

  const registeredVk = normAddress(pick(input, ["registered_vk", "registeredVk", "vk_hash"]));
  const proofVk = normAddress(pick(input, ["proof_vk", "proofVk"]));
  const rawProofTx = pick(input, ["proof_tx", "proofTx"]);
  const proofTx = typeof rawProofTx === "string" ? rawProofTx.trim().toLowerCase() : "";

  // 1. Replay first (the trap's own checklist: "check the reference before any
  //    other validation"). A valid proof gains no re-entry by being resubmitted.
  if (isReplay) return reject(REASON.PROOF_REPLAY);

  // 2. Verification key substitution. A missing proof_vk is only tolerated when
  //    we could actually verify the proof against registered_vk (see zkverify.js);
  //    otherwise the condition cannot be compared at all.
  if (proofVk && registeredVk && proofVk !== registeredVk) {
    const isKnown = knownVks.map(normAddress).includes(proofVk);
    return reject(isKnown ? REASON.CIRCUIT_MISMATCH : REASON.VK_SUBSTITUTION);
  }
  if (!proofVk && !verificationOk) return reject(REASON.PROOF_INVALID);

  // 3. A verifiable on-chain reference must exist.
  if (!proofTx) return reject(REASON.MISSING_VERIFICATION);

  // 4. The proof itself must verify. Only an actual failed verification call
  //    can produce this; we never reject on the mere absence of a call.
  if (verificationFailed) return reject(REASON.PROOF_INVALID);

  // 5. Threshold: the balance disclosed in the proof must meet the minimum.
  const minimum = toBig(pick(input, ["minimum", "min_threshold", "min"]));
  const publicBalance = toBig(pick(input, ["public_balance", "publicBalance", "balance"]));
  if (minimum === null || publicBalance === null) return reject(REASON.PUBLIC_INPUT_MISMATCH);
  if (publicBalance < minimum) return reject(REASON.THRESHOLD_MISMATCH);

  // 6. Expiry: an on-chain confirmation after the deadline does not revive the
  //    payment window.
  const expiry = toBig(pick(input, ["expiry_block", "expiryBlock"]));
  const current = toBig(pick(input, ["current_block", "currentBlock", "block_number"]));
  if (expiry === null || current === null) return reject(REASON.PUBLIC_INPUT_MISMATCH);
  if (current >= expiry) return reject(REASON.PUBLIC_INPUT_MISMATCH);

  // 7. Recipient: the address committed in the proof must equal the one on the
  //    payment condition. Exact match, no prefixes.
  const recipient = normAddress(pick(input, ["recipient", "proof_recipient"]));
  const conditionRecipient = normAddress(pick(input, ["condition_recipient", "conditionRecipient"]));
  if (!recipient || !conditionRecipient) return reject(REASON.PUBLIC_INPUT_MISMATCH);
  if (recipient !== conditionRecipient) return reject(REASON.PUBLIC_INPUT_MISMATCH);

  // 8. Amount: a valid balance proof does not override the transfer cap.
  const amount = toBig(pick(input, ["amount", "payment_amount"]));
  const maxTransfer = toBig(pick(input, ["max_transfer", "maxTransfer"]));
  if (amount === null || maxTransfer === null) return reject(REASON.PUBLIC_INPUT_MISMATCH);
  if (amount <= 0n || amount > maxTransfer) return reject(REASON.PUBLIC_INPUT_MISMATCH);

  return { decision: "APPROVE", reason_code: REASON.VALID };
}
