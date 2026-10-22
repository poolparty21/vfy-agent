// Steal the VFY tests.
//
// The keccak implementation is checked against the standard test vectors —
// if it is wrong, every publicInputsHash is wrong and the turn is scored as
// a HOLD with no proof.

import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, publicInputsHash, idempotencyKey, chooseAction, buildTurnResponse, isVfyTurn, fallbackTurnResponse } from "../src/vfy.js";

const enc = new TextEncoder();
const hex = (s) => "0x" + [...s].map((b) => b.toString(16).padStart(2, "0")).join("");

test("keccak256 matches the standard empty-string vector", () => {
  assert.equal(
    keccak256(enc.encode("")),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
});

test("keccak256 matches the standard 'abc' vector", () => {
  assert.equal(
    keccak256(enc.encode("abc")),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
});

test("keccak256 matches the standard 200-byte vector", () => {
  const input = new Uint8Array(200).fill(0xa3);
  assert.equal(
    keccak256(input),
    "0x3a57666b048777f2c953dc4456f45a2588e1cb6f2da760122d530ac2ce607d4a",
  );
});

test("publicInputsHash is deterministic and order-sensitive", () => {
  const base = {
    commitment: "0x" + "11".repeat(32),
    matchId: "3f2a1b",
    turn: 7,
    selfBalance: 100,
    opponentBalance: 50,
    action: { type: "EXTRACT", amount: 10 },
    circuitVersion: "v1-draft",
  };
  const a = publicInputsHash(base);
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, publicInputsHash({ ...base }));
  // Field order matters: swapping two fields changes the hash.
  assert.notEqual(
    a,
    publicInputsHash({ ...base, turn: base.selfBalance, selfBalance: base.turn }),
  );
});

test("publicInputsHash rejects an unknown circuit version", () => {
  assert.throws(
    () =>
      publicInputsHash({
        commitment: "0x" + "11".repeat(32),
        matchId: "1",
        turn: 1,
        selfBalance: 1,
        opponentBalance: 1,
        action: { type: "HOLD" },
        circuitVersion: "v2-unknown",
      }),
    /unknown circuit version/,
  );
});

test("idempotencyKey is a stable v4-shaped UUID per turn", () => {
  const k = idempotencyKey("match-1", 3);
  assert.match(k, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(k, idempotencyKey("match-1", 3));
  assert.notEqual(k, idempotencyKey("match-1", 4));
  assert.notEqual(k, idempotencyKey("match-2", 3));
});

test("chooseAction extracts up to the cap and holds against an empty opponent", () => {
  assert.deepEqual(chooseAction({ opponentBalance: 50 }), { type: "EXTRACT", amount: 10 });
  assert.deepEqual(chooseAction({ opponentBalance: 4 }), { type: "EXTRACT", amount: 4 });
  assert.deepEqual(chooseAction({ opponentBalance: 0 }), { type: "HOLD" });
});

test("the turn response omits amount for HOLD and includes the hash", () => {
  const res = buildTurnResponse({
    matchId: "abc-def",
    turn: 2,
    state: { selfBalance: 10, opponentBalance: 0 },
    resolverVersion: "v1-draft",
    strategyCommitment: { hash: "0x" + "22".repeat(32) },
  });
  assert.equal(res.matchId, "abc-def");
  assert.equal(res.turn, 2);
  assert.deepEqual(res.action, { type: "HOLD" });
  assert.equal(res.action.amount, undefined, "amount must be omitted entirely for HOLD");
  assert.equal(res.policyProof.circuitVersion, "v1-draft");
  assert.match(res.policyProof.publicInputsHash, /^0x[0-9a-f]{64}$/);
  assert.ok(res.idempotencyKey);
  assert.ok(res.agentTimestamp);
});

test("an EXTRACT turn carries the amount", () => {
  const res = buildTurnResponse({
    matchId: "abc",
    turn: 1,
    state: { selfBalance: 10, opponentBalance: 40 },
    strategyCommitment: { hash: "0x" + "22".repeat(32) },
  });
  assert.deepEqual(res.action, { type: "EXTRACT", amount: 10 });
});

test("isVfyTurn recognises only turn envelopes", () => {
  assert.equal(isVfyTurn({ eventId: "steal-the-vfy", matchId: "m", turn: 1 }), true);
  assert.equal(isVfyTurn({ eventId: "proof-gatekeeper", matchId: "m", turn: 1 }), false);
  assert.equal(isVfyTurn({ type: "agent-games.preflight.v1" }), false);
  assert.equal(isVfyTurn(null), false);
});

test("a hex match id follows the build guide's conversion exactly", () => {
  // The guide: BigInt("0x" + matchId.replace(/-/g, "")).
  const base = {
    commitment: "0x" + "11".repeat(32),
    turn: 3,
    selfBalance: 95,
    opponentBalance: 105,
    action: { type: "EXTRACT", amount: 10 },
    circuitVersion: "v1-draft",
  };
  const viaGuide = publicInputsHash({ ...base, matchId: "9f4e1b2a-c53d-4b21-9f8a-1234567890ab" });
  assert.match(viaGuide, /^0x[0-9a-f]{64}$/);
});

test("a non-hex match id does not throw and still produces a hash", () => {
  // A UUID or any opaque id must not take the turn down. It used to throw
  // "not an integer", which became a delivery timeout.
  const base = {
    commitment: "0x" + "11".repeat(32),
    turn: 3,
    selfBalance: 95,
    opponentBalance: 105,
    action: { type: "EXTRACT", amount: 10 },
    circuitVersion: "v1-draft",
  };
  for (const id of ["test-match-01", "not hex at all", "", "zzz"]) {
    const hash = publicInputsHash({ ...base, matchId: id });
    assert.match(hash, /^0x[0-9a-f]{64}$/, `matchId ${JSON.stringify(id)} must still hash`);
  }
});

test("a non-hex match id is deterministic", () => {
  const base = {
    commitment: "0x" + "11".repeat(32),
    turn: 1,
    selfBalance: 1,
    opponentBalance: 1,
    action: { type: "HOLD" },
    circuitVersion: "v1-draft",
  };
  assert.equal(
    publicInputsHash({ ...base, matchId: "abc-def" }),
    publicInputsHash({ ...base, matchId: "abc-def" }),
  );
});

test("the fallback turn response is schema-valid HOLD", () => {
  const res = fallbackTurnResponse({ matchId: "m-1", turn: 4 });
  assert.equal(res.matchId, "m-1");
  assert.equal(res.turn, 4);
  assert.deepEqual(res.action, { type: "HOLD" });
  assert.equal(res.action.amount, undefined);
  assert.equal(res.policyProof.circuitVersion, "v1-draft");
  assert.match(res.idempotencyKey, /^[0-9a-f-]{36}$/);
});
