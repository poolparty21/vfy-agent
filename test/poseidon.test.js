// Poseidon over BN254 Fr, as the vfy-policy circuit computes it.
//
// These vectors were produced by circomlibjs (the reference implementation the
// circuit's compiler relies on). They pin the constant table, the round count
// (8 full + 60 partial) and the input order — params first, salt last. A wrong
// commitment is not a wrong hash, it is a witness that cannot exist, i.e. −2 on
// every turn of a match.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FIELD, poseidon, strategyCommitment, toHex32, parseSalt, parseStrategyParams } from "../prover/poseidon.mjs";

test("poseidon(9) matches the circomlib vectors", () => {
  const vectors = [
    [[0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], "800120061924841277379997862745106495629262503147852650856598454570844641064"],
    [[1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n], "13589767895268936107593642967621470491511464502761040466226072462545218539640"],
    [
      [10n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 12345678901234567890123456789012345678901234567890n],
      "1208312360607453585269166657524850344715023154826282765339325551000804926610",
    ],
  ];
  for (const [inputs, expected] of vectors) {
    assert.equal(poseidon(inputs).toString(), expected, JSON.stringify(inputs.map(String)));
  }
});

test("poseidon requires exactly nine inputs", () => {
  assert.throws(() => poseidon([1n, 2n]), /exactly 9 inputs/);
});

test("the commitment is Poseidon(params, salt) with the salt last", () => {
  const params = [10n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
  const salt = 42n;
  assert.equal(strategyCommitment(params, salt), poseidon([...params, salt]));
  // Order is part of the definition: salt first would be a different value.
  assert.notEqual(strategyCommitment(params, salt), poseidon([salt, ...params]));
  // And so is every parameter.
  assert.notEqual(strategyCommitment(params, salt), strategyCommitment([9n, ...params.slice(1)], salt));
});

test("a different salt gives a different commitment", () => {
  const params = parseStrategyParams("10,0,0,0,0,0,0,0");
  assert.notEqual(strategyCommitment(params, 1n), strategyCommitment(params, 2n));
});

test("strategyParams must be eight values", () => {
  assert.throws(() => strategyCommitment([1n, 2n, 3n], 1n), /exactly 8/);
});

test("commitments are in the field and print as 32-byte hex", () => {
  const c = strategyCommitment([10n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], 7n);
  assert.ok(c > 0n && c < FIELD);
  assert.match(toHex32(c), /^0x[0-9a-f]{64}$/);
});

test("salt and params parse from the file's hex and a comma list", () => {
  assert.equal(parseSalt("0x0a\n"), 10n);
  assert.equal(parseSalt("0a"), 10n);
  assert.deepEqual(
    parseStrategyParams("10, 0,0,0,0,0,0,0").map(String),
    ["10", "0", "0", "0", "0", "0", "0", "0"],
  );
  assert.throws(() => parseStrategyParams("1,2,3"), /8 comma-separated/);
});
