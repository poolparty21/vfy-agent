// Verify a zkVerify proof reference (a Groth16 proof transaction) on mainchain.
//
// The Agent Games Wildcard entry claims that the agent confirms a proof
// transaction really landed on zkVerify's mainchain. This script makes that
// claim independently checkable: give it a transaction hash and the block
// number that contains it, and it re-derives the transaction hash from the
// raw extrinsic bytes using this repo's own BLAKE2b-256 implementation.
//
//   node scripts/verify-proof-reference.mjs
//   node scripts/verify-proof-reference.mjs 0xabc... 5664252
//
// It has NO dependencies: it talks to the public zkVerify RPC over fetch and
// uses src/blake2.js, the same from-scratch BLAKE2b-256 the Worker uses.

import { blake2b256Hex } from "../src/blake2.js";
import { findTransactionInBlock, finalizedBlockNumber, verifyProofReference, isFinalized } from "../src/zkverify.js";

const RPC = process.env.ZKVERIFY_RPC || "https://zkverify-rpc.zkverify.io";

/** The reference shipped with the Wildcard submission. */
const DEFAULT_REFERENCE = {
  proofTx: "0x52f943ec94d2adc0ee2554efc8540a52cefedfc6366012f26466f4fb831930ab",
  blockNumber: 5664252,
  statement: "0x25ba695155889be7a509883bd2a47926c2a6e2e9adf4a2aff8304ebc4591b463",
  vkHash: "0xeff0bb5fb5dde45258b16a9caa7db40371b456c85ea79f26a6225b7723c24a10",
};

export { DEFAULT_REFERENCE, verifyProofReference, isFinalized };

if (import.meta.url === `file://${process.argv[1]}`) {
  const proofTx = process.argv[2] || DEFAULT_REFERENCE.proofTx;
  const blockNumber = Number(process.argv[3] || DEFAULT_REFERENCE.blockNumber);
  try {
    const result = await verifyProofReference(proofTx, blockNumber);
    console.log("proof reference :", result.proofTx);
    console.log("block           :", result.blockNumber, result.blockHash ?? "-");
    console.log("extrinsic index :", result.extrinsicIndex ?? "-");
    console.log("re-derived hash :", result.derivedHash ?? "-");
    console.log("finalized       :", result.finalized, `(finalized head ${result.finalizedHead ?? "-"})`);
    if (result.ok) {
      console.log("OK — the reference is a real, finalized zkVerify mainchain transaction.");
      process.exit(0);
    }
    console.error("FAILED:", result.error ?? "the reference did not verify");
    process.exit(1);
  } catch (err) {
    console.error("FAILED:", err.message);
    process.exit(1);
  }
}
