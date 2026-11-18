// The gatekeeper circuit input mapping.
//
// The mapping is the one place where a mistake is expensive: a renamed signal or
// a swapped pair is accepted silently here and then fails the witness, or proves
// the wrong statement, during a scored round. So the golden values below are
// literals — this test does not re-derive them with the code under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import toSignals, { taskIdField, TASK_ID_ENCODINGS } from "../prover/maps/gatekeeper.mjs";

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** The 13 signals in the circuit's own order (gatekeeper.circom public order). */
const SIGNALS = [
  "registeredVkHash",
  "proofVkHash",
  "minimum",
  "publicBalance",
  "expiryBlock",
  "currentBlock",
  "recipient",
  "conditionRecipient",
  "amount",
  "maxTransfer",
  "taskId",
  "decision",
  "salt",
];

const TASK_ID = "task-0001";

/** Every value distinct, so a swap between any two signals cannot pass. */
const payload = ({ input = {}, ...rest } = {}) => ({
  input: {
    registered_vk: "111111",
    proof_vk: "222222",
    minimum: "1000",
    public_balance: "5000",
    expiry_block: 900,
    current_block: 800,
    recipient: "333",
    condition_recipient: "444",
    amount: "4000",
    max_transfer: "10000",
    ...input,
  },
  taskId: TASK_ID,
  decision: "APPROVE",
  taskIdEncoding: "keccakModP",
  ...rest,
});

test("the mapping emits the 13 signals in circuit order, and nothing else", () => {
  const signals = toSignals(payload());
  assert.deepEqual(Object.keys(signals), SIGNALS);
});

test("each signal carries the value of its own platform input field", () => {
  const { salt, ...signals } = toSignals(payload());
  assert.deepStrictEqual(signals, {
    registeredVkHash: "111111",
    proofVkHash: "222222",
    minimum: "1000",
    publicBalance: "5000",
    expiryBlock: "900",
    currentBlock: "800",
    recipient: "333",
    conditionRecipient: "444",
    amount: "4000",
    maxTransfer: "10000",
    taskId: "8164914842601646057142930263238418237309196141420463877226188252636114351424",
    decision: "1",
  });
  assert.match(salt, /^\d+$/);
});

test("APPROVE maps to 1 and REJECT to 0; anything else is not an approval", () => {
  assert.equal(toSignals(payload()).decision, "1");
  assert.equal(toSignals(payload({ decision: "REJECT" })).decision, "0");
  assert.equal(toSignals(payload({ decision: "approve" })).decision, "0");
  assert.equal(toSignals(payload({ decision: undefined })).decision, "0");
});

test("every input is reduced into the bn128 scalar field", () => {
  const big = (P + 7n).toString();
  const signals = toSignals(
    payload({ input: { minimum: big, public_balance: P.toString(), max_transfer: `0x${P.toString(16)}` } }),
  );
  assert.equal(signals.minimum, "7");
  assert.equal(signals.publicBalance, "0");
  assert.equal(signals.maxTransfer, "0");
});

test("a decimal input above 2^53 keeps full precision", () => {
  const amount = (1n << 200n).toString();
  assert.equal(toSignals(payload({ input: { amount } })).amount, amount);
});

test("a missing input field throws instead of producing a garbage signal", () => {
  const { minimum, ...rest } = payload().input;
  assert.throws(() => toSignals({ ...payload(), input: rest }), TypeError);
});

test("salt is a fresh field element on every proof", () => {
  const a = toSignals(payload()).salt;
  const b = toSignals(payload()).salt;
  assert.notEqual(a, b);
  assert.ok(BigInt(a) < P && BigInt(b) < P);
  assert.ok(BigInt(a) > 0n && BigInt(b) > 0n);
});

test("the taskId encoding is applied, and defaults to keccakModP", () => {
  const expected = "8164914842601646057142930263238418237309196141420463877226188252636114351424";
  assert.equal(taskIdField(TASK_ID), expected);
  assert.equal(taskIdField(TASK_ID, "keccakModP"), expected);
  assert.equal(
    taskIdField(TASK_ID, "keccakShr8"),
    "31894198603912679910714571340775071239489047427423687020414797861859821685",
  );
  assert.equal(taskIdField("0xab", "hexDigits"), "171");
  assert.equal(
    taskIdField("9f8a1c2e-4b6d-4e8f-9a0b-1c2d3e4f5a6b", "uuidTail"),
    "212064359871587327551882868698488199787",
  );
});

test("an unknown taskId encoding falls back to keccakModP", () => {
  assert.equal(taskIdField(TASK_ID, "noSuchEncoding"), taskIdField(TASK_ID, "keccakModP"));
  assert.equal(toSignals(payload({ taskIdEncoding: "noSuchEncoding" })).taskId, taskIdField(TASK_ID));
});

test("uuidTail falls back to keccakModP when the id is not a uuid", () => {
  assert.equal(taskIdField(TASK_ID, "uuidTail"), taskIdField(TASK_ID, "keccakModP"));
});

test("the taskId is hashed as a string, so a numeric id matches its text form", () => {
  assert.equal(taskIdField(42), taskIdField("42"));
  assert.equal(toSignals(payload({ taskId: 42 })).taskId, toSignals(payload({ taskId: "42" })).taskId);
});

test("every encoding returns a decimal string below the modulus", () => {
  for (const name of Object.keys(TASK_ID_ENCODINGS)) {
    const value = taskIdField(TASK_ID, name);
    assert.match(value, /^\d+$/, `${name} must be a decimal string`);
    assert.ok(BigInt(value) < P, `${name} must be inside the field`);
  }
});
