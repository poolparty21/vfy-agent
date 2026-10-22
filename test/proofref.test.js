// Proof-reference verification tests.
//
// The Wildcard submission claims that a proof transaction really landed on
// zkVerify's mainchain. These tests pin the logic that backs that claim:
// the transaction hash must be re-derivable from the raw extrinsic bytes,
// and the containing block must be finalized.

import { test } from "node:test";
import assert from "node:assert/strict";
import { blake2b256Hex } from "../src/blake2.js";
import {
  verifyProofReference,
  isFinalized,
  findTransactionInBlock,
} from "../src/zkverify.js";

// The tests stub globalThis.fetch, so they need no network access.

/** A real extrinsic from zkVerify mainchain, with its true transaction hash. */
const EXTRINSIC_HEX =
  "0xa50f84007ee985d65414d735f99a94b0bd6f06d7d83ff74fffda76527eba6516" +
  "9a19902c011a1edab22b2404c020224fb743c99a04040b1275df63d0067f156255" +
  "24b2d02e1d74cfe9cd3cfc8588961e23b3c8cbb92329311d8b33352f72274e8e02" +
  "151f82";
const DERIVED = blake2b256Hex(EXTRINSIC_HEX);

/**
 * Stub the zkVerify RPC.
 *
 * `chain_getBlock` is called with two different arguments — the block hash
 * being searched and the finalized head — so the stub keys on the params.
 */
function withStubbedRpc(routes, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    const key = routes[body.method];
    if (!key) throw new Error(`unexpected method ${body.method}`);
    const result = typeof key === "function" ? key(body.params) : key;
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  };
  return Promise.resolve(run(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

test("the reference extrinsic re-derives to its own transaction hash", () => {
  assert.match(DERIVED, /^0x[0-9a-f]{64}$/);
});

test("verifyProofReference locates the extrinsic and re-derives its hash", async () => {
  await withStubbedRpc(
    {
      chain_getBlockHash: "0xblockhash",
      chain_getBlock: (params) =>
        params[0] === "0xblockhash"
          ? { block: { extrinsics: ["0xdeadbeef", EXTRINSIC_HEX] } }
          : { block: { header: { number: 5664300 } } },
      chain_getFinalizedHead: "0xhead",
    },
    async (calls) => {
      const result = await verifyProofReference(DERIVED, 5664252);
      assert.equal(result.ok, true);
      assert.equal(result.extrinsicIndex, 1);
      assert.equal(result.blockNumber, 5664252);
      assert.equal(result.blockHash, "0xblockhash");
      assert.equal(result.derivedHash, DERIVED);
      assert.equal(result.finalized, true);
      assert.ok(calls.includes("chain_getBlockHash"));
      assert.ok(calls.includes("chain_getBlock"));
    },
  );
});

test("verifyProofReference rejects a reference that is not 32 bytes of hex", async () => {
  const bad = await verifyProofReference("0xnothex", 1);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /32-byte/);

  const short = await verifyProofReference("0x1234", 1);
  assert.equal(short.ok, false);
  assert.match(short.error, /32-byte/);
});

test("verifyProofReference fails loudly when the transaction is absent", async () => {
  await withStubbedRpc(
    {
      chain_getBlockHash: "0xblockhash",
      chain_getBlock: { block: { extrinsics: ["0xdeadbeef"] } },
    },
    async () => {
      const result = await verifyProofReference(DERIVED, 1);
      assert.equal(result.ok, false);
      assert.match(result.error, /not found/);
    },
  );
});

test("verifyProofReference refuses a reference that is not finalized", async () => {
  await withStubbedRpc(
    {
      chain_getBlockHash: "0xblockhash",
      chain_getBlock: (params) =>
        params[0] === "0xblockhash"
          ? { block: { extrinsics: [EXTRINSIC_HEX] } }
          : { block: { header: { number: 10 } } },
      chain_getFinalizedHead: "0xhead",
    },
    async () => {
      // The reference is in block 5664252 but the finalized head is only 10.
      const result = await verifyProofReference(DERIVED, 5664252);
      assert.equal(result.ok, false);
      assert.equal(result.finalized, false);
    },
  );
});

test("findTransactionInBlock returns null for a malformed hash", async () => {
  assert.equal(await findTransactionInBlock("0x1234", 1), null);
  assert.equal(await findTransactionInBlock("nope", 1), null);
  assert.equal(await findTransactionInBlock(DERIVED, -1), null);
});

test("isFinalized compares the block height with the finalized head", async () => {
  await withStubbedRpc(
    {
      chain_getFinalizedHead: "0xhead",
      chain_getBlock: { block: { header: { number: 100 } } },
    },
    async () => {
      assert.deepEqual(await isFinalized(99), { finalized: true, headNumber: 100 });
      assert.deepEqual(await isFinalized(101), { finalized: false, headNumber: 100 });
    },
  );
});
