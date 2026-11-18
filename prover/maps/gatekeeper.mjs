// Gatekeeper circuit (GatekeeperEvaluation) input mapping.
//
// The 13 signals were recovered from gatekeeper.wasm and confirmed end to end:
// a valid condition + decision 1 (APPROVE) proves against the official VK, and
// the circuit REFUSES decision 0 on the same condition (assert at line 102).
// So the circuit encodes the trap rules itself: only the decision its own rules
// allow can be proved.
//
// salt is a PUBLIC signal here (it is the 13th public signal), so it carries no
// secrecy requirement — it is random per proof so that two proofs of the same
// condition are unlinkable.
import { randomBytes } from "node:crypto";
import { keccak256 } from "../../src/vfy.js";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Any decimal/hex integer reduced into the bn128 scalar field. */
const field = (v) => (BigInt(v) % P).toString();

/**
 * The platform's task_id -> field encoding is not published. Only the encoding
 * the platform uses can match its own expectation, so it is a per-request knob
 * (TASKID_ENCODING); practice tasks settle it without a prover redeploy.
 */
const kec = (id) => BigInt(keccak256(new TextEncoder().encode(String(id))));

export const TASK_ID_ENCODINGS = {
  keccakModP: (id) => kec(id) % P,
  keccakShr8: (id) => kec(id) >> 8n,
  hexDigits: (id) => BigInt("0x" + (String(id).replace(/[^0-9a-f]/gi, "") || "0")) % P,
  uuidTail: (id) => {
    const m = String(id).match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i);
    return m ? BigInt("0x" + m[0].replace(/-/g, "")) : kec(id) % P;
  },
};

export function taskIdField(taskId, encoding = "keccakModP") {
  const f = TASK_ID_ENCODINGS[encoding] ?? TASK_ID_ENCODINGS.keccakModP;
  return f(taskId).toString();
}

/**
 * @param {object} payload { input, taskId, decision, taskIdEncoding }
 * @returns the circuit's 13 signals as decimal strings
 */
export default ({ input, taskId, decision, taskIdEncoding }) => ({
  registeredVkHash: field(input.registered_vk),
  proofVkHash: field(input.proof_vk),
  minimum: field(input.minimum),
  publicBalance: field(input.public_balance),
  expiryBlock: field(input.expiry_block),
  currentBlock: field(input.current_block),
  recipient: field(input.recipient),
  conditionRecipient: field(input.condition_recipient),
  amount: field(input.amount),
  maxTransfer: field(input.max_transfer),
  taskId: taskIdField(taskId, taskIdEncoding),
  decision: decision === "APPROVE" ? "1" : "0",
  salt: BigInt("0x" + randomBytes(31).toString("hex")).toString(),
});

/** The circuit's other decision — tried only when the caller allows it. */
export const alternate = (payload) => ({
  ...payload,
  decision: payload.decision === "APPROVE" ? "REJECT" : "APPROVE",
});
