// Proof Gatekeeper policy tests.
//
// Every trap the platform documents gets a case here, plus the fail-closed
// behaviour for malformed payloads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, REASON, toBig, normAddress, toReasonCode } from "../src/decide.js";

const VK_A = "0x7d3a0000000000000000000000000000000000000000000000000000f291";
const VK_B = "0xa4c1000000000000000000000000000000000000000000000000000000b8ff";

/** A valid condition: every field agrees. */
function valid(overrides = {}) {
  return {
    registered_vk: VK_A,
    proof_vk: VK_A,
    minimum: "1000",
    public_balance: "1460",
    expiry_block: 19842201,
    current_block: 19832000,
    recipient: "0xDe42000000000000000000000000000000009f01",
    condition_recipient: "0xDe42000000000000000000000000000000009f01",
    amount: "500",
    max_transfer: "1000",
    proof_tx: "0xa4c10000000000000000000000000000000000000000000000000000008ff1",
    ...overrides,
  };
}

test("valid condition is approved", () => {
  const v = decide(valid());
  assert.equal(v.decision, "APPROVE");
  assert.equal(v.reason_code, REASON.VALID);
});

test("VK substitution is rejected", () => {
  const v = decide(valid({ proof_vk: VK_B }));
  assert.equal(v.decision, "REJECT");
  assert.equal(v.reason_code, REASON.VK_SUBSTITUTION);
});

test("a known but different VK is reported as a circuit mismatch", () => {
  const v = decide(valid({ proof_vk: VK_B }), { knownVks: [VK_B] });
  assert.equal(v.reason_code, REASON.CIRCUIT_MISMATCH);
});

test("threshold below the minimum is rejected", () => {
  const v = decide(valid({ public_balance: "999" }));
  assert.equal(v.reason_code, REASON.THRESHOLD_MISMATCH);
});

test("a threshold exactly equal to the minimum passes", () => {
  const v = decide(valid({ public_balance: "1000" }));
  assert.equal(v.decision, "APPROVE");
});

test("an expired condition is rejected", () => {
  const v = decide(valid({ current_block: 19842201, expiry_block: 19842201 }));
  assert.equal(v.decision, "REJECT");
  assert.equal(v.reason_code, REASON.PUBLIC_INPUT_MISMATCH);
});

test("a block before the expiry passes", () => {
  const v = decide(valid({ current_block: 19842200, expiry_block: 19842201 }));
  assert.equal(v.decision, "APPROVE");
});

test("a recipient mismatch is rejected", () => {
  const v = decide(valid({ condition_recipient: "0xde4200000000000000000000000000000000dead" }));
  assert.equal(v.reason_code, REASON.PUBLIC_INPUT_MISMATCH);
});

test("a recipient match is case-insensitive", () => {
  const v = decide(
    valid({
      recipient: "0xDE42000000000000000000000000000000009F01",
      condition_recipient: "0xde42000000000000000000000000000000009f01",
    }),
  );
  assert.equal(v.decision, "APPROVE");
});

test("an amount above the transfer cap is rejected", () => {
  const v = decide(valid({ amount: "1001", max_transfer: "1000" }));
  assert.equal(v.reason_code, REASON.PUBLIC_INPUT_MISMATCH);
});

test("an amount exactly at the cap passes", () => {
  const v = decide(valid({ amount: "1000", max_transfer: "1000" }));
  assert.equal(v.decision, "APPROVE");
});

test("a replayed proof reference is rejected before any other check", () => {
  // Even a fully valid condition is rejected when the reference was used
  // before: the trap checklist says check the reference first.
  const v = decide(valid(), { isReplay: true });
  assert.equal(v.reason_code, REASON.PROOF_REPLAY);
});

test("a missing proof reference is rejected", () => {
  const input = valid();
  delete input.proof_tx;
  const v = decide(input);
  assert.equal(v.reason_code, REASON.MISSING_VERIFICATION);
});

test("a failed verification is rejected as an invalid proof", () => {
  const v = decide(valid(), { verificationFailed: true });
  assert.equal(v.reason_code, REASON.PROOF_INVALID);
});

test("a malformed input is rejected, not crashed on", () => {
  for (const bad of [null, undefined, 42, "nope", [], {}]) {
    const v = decide(bad);
    assert.equal(v.decision, "REJECT");
    assert.equal(v.reason_code, REASON.PROOF_INVALID);
  }
});

test("missing numeric fields fail closed", () => {
  const input = valid();
  delete input.minimum;
  const v = decide(input);
  assert.equal(v.decision, "REJECT");
  assert.equal(v.reason_code, REASON.PUBLIC_INPUT_MISMATCH);
});

test("a missing proof_vk is rejected unless we verified it ourselves", () => {
  const input = valid();
  delete input.proof_vk;
  assert.equal(decide(input).reason_code, REASON.PROOF_INVALID);
  assert.equal(decide(input, { verificationOk: true }).decision, "APPROVE");
});

test("toBig accepts the formats the platform sends", () => {
  assert.equal(toBig("1000"), 1000n);
  assert.equal(toBig(1000), 1000n);
  assert.equal(toBig(1000n), 1000n);
  assert.equal(toBig("0x10"), 16n);
  assert.equal(toBig("abc"), null);
  assert.equal(toBig(1.5), null);
  assert.equal(toBig(null), null);
});

test("normAddress strips the prefix and lowercases", () => {
  assert.equal(normAddress("0xDE4209f01"), "de4209f01");
  assert.equal(normAddress("de4209f01"), "de4209f01");
  assert.equal(normAddress(42), "");
});

test("each verdict also carries the specific trap label", () => {
  // The canonical vocabulary collapses expiry, recipient and amount into one
  // code; the trap vocabulary must not, or a rejected task would be recorded
  // as the wrong trap.
  assert.equal(decide(valid()).trap_code, "VALID_CONDITION");
  assert.equal(decide(valid({ public_balance: "1" })).trap_code, "THRESHOLD_MISMATCH");
  assert.equal(decide(valid({ current_block: 19999999 })).trap_code, "EXPIRED_CONDITION");
  assert.equal(
    decide(valid({ condition_recipient: "0xde4200000000000000000000000000000000dead" })).trap_code,
    "RECIPIENT_MISMATCH",
  );
  assert.equal(decide(valid({ amount: "99999" })).trap_code, "AMOUNT_OVERFLOW");
  assert.equal(decide(valid({ proof_vk: VK_B })).trap_code, "VK_SUBSTITUTION");
  assert.equal(decide(valid(), { isReplay: true }).trap_code, "PROOF_REUSED");
});

test("toReasonCode maps the canonical code to the trap label on request", () => {
  assert.equal(toReasonCode(REASON.VALID, "canonical"), "VALID_PROOF");
  assert.equal(toReasonCode(REASON.VALID, "trap"), "VALID_CONDITION");
  assert.equal(toReasonCode(REASON.PROOF_REPLAY, "trap"), "PROOF_REUSED");
  // Codes that are identical in both vocabularies pass through unchanged.
  assert.equal(toReasonCode(REASON.VK_SUBSTITUTION, "trap"), "VK_SUBSTITUTION");
  assert.equal(toReasonCode(REASON.THRESHOLD_MISMATCH, "trap"), "THRESHOLD_MISMATCH");
});
