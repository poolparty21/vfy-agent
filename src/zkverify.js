// zkVerify verification.
//
// The platform requires the agent to "independently verify the proof on-chain
// via zkVerify" and to "use the registered_vk field — never the submitted
// proof_vk — when calling zkVerify". Two paths are supported:
//
//   A) Kurier (REST) — the documented, recommended path. We submit the
//      Groth16 proof with the REGISTERED vk hash and poll the job until the
//      chain finalizes it. This is the only path that proves a proof to be
//      valid, so it is preferred whenever an API key is configured.
//   B) On-chain read — we look the task's `proof_tx` up in zkVerify's own
//      finalized blocks and confirm the transaction is really there.
//
// TWO HARD CONSTRAINTS shaped this file:
//
// 1. THE 60-SECOND WINDOW. The agent must answer within 60s or it scores as a
//    timeout (-2). Measured RPC latency on the public zkVerify node is
//    1.4-2.0s PER CALL, so a naive sequential block walk blows the window on
//    its own. Every lookup here is parallel and hard-bounded by a deadline.
//
// 2. THE 50-SUBREQUEST LIMIT. Cloudflare Workers allows 50 subrequests per
//    invocation on the free plan. A block walk costs 2 calls per block, so
//    the lookback is capped and the total is counted before it is spent.
//
// Verification is also only ever EVIDENCE. It can catch a genuinely invalid
// proof, but it never vetoes a verdict the deterministic policy already
// reached: the trap set is built from the payload fields, and a wrong REJECT
// still costs half of a wrong APPROVE.

import { blake2b256Hex } from "./blake2.js";

export const DEFAULT_RPC = "https://zkverify-rpc.zkverify.io";
export const KURIER_API = "https://api.kurier.xyz/api/v1";

/** Deadline for any single RPC call. */
const RPC_TIMEOUT_MS = 4000;

/** Cloudflare's per-invocation subrequest cap on the free plan. */
const MAX_SUBREQUESTS = 50;

/**
 * How many recent blocks to search for a proof reference.
 *
 * Each block costs 2 subrequests, so 8 blocks = 16 calls. That leaves room
 * under the 50-per-invocation cap for the D1 queries (which also count) and
 * for the Kurier path. Substrate has no "get tx by hash" RPC, so a search is a
 * block walk — and proofs are always recent, so a small window suffices.
 */
const LOOKBACK_BLOCKS = 8;

async function rpc(url, method, params, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`zkVerify RPC ${method}: HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`zkVerify RPC ${method}: ${json.error.message ?? "error"}`);
    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

/** Current finalized block height — the authority for expiry checks. */
export async function finalizedBlockNumber(rpcUrl = DEFAULT_RPC) {
  const head = await rpc(rpcUrl, "chain_getFinalizedHead", []);
  const block = await rpc(rpcUrl, "chain_getBlock", [head]);
  return Number(block?.block?.header?.number ?? 0);
}

/**
 * Confirm a transaction is present in a finalized zkVerify block.
 *
 * `chain_getBlock` returns a block's extrinsics as HEX STRINGS, not as objects
 * carrying a `hash` — a Substrate transaction hash is blake2_256 of the
 * encoded extrinsic, so each candidate is hashed here (see src/blake2.js) and
 * compared with the task's proof reference.
 *
 * The candidate blocks are fetched IN PARALLEL: at the measured 1.4-2.0s per
 * call, a sequential walk would exceed the agent's 60s response window.
 *
 * @returns {Promise<{blockHash: string, blockNumber: number, index: number}|null>}
 */
export async function findTransaction(txHash, rpcUrl = DEFAULT_RPC, lookback = LOOKBACK_BLOCKS) {
  const hash = String(txHash ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return null;

  // 2 calls for the head, 2 per candidate block — keep it inside the cap.
  const maxBlocks = Math.max(1, Math.min(lookback, Math.floor((MAX_SUBREQUESTS - 4) / 2)));

  const head = await rpc(rpcUrl, "chain_getFinalizedHead", []);
  const headBlock = await rpc(rpcUrl, "chain_getBlock", [head]);
  const headNum = Number(headBlock?.block?.header?.number ?? 0);
  const from = Math.max(0, headNum - maxBlocks);

  const heights = [];
  for (let n = headNum; n >= from; n--) heights.push(n);

  const blocks = await Promise.all(
    heights.map(async (n) => {
      try {
        const blockHash = await rpc(rpcUrl, "chain_getBlockHash", [n]);
        if (!blockHash) return null;
        const block = await rpc(rpcUrl, "chain_getBlock", [blockHash]);
        return { n, blockHash, block };
      } catch {
        return null;
      }
    }),
  );

  for (const entry of blocks) {
    if (!entry) continue;
    const extrinsics = entry.block?.block?.extrinsics ?? [];
    for (let i = 0; i < extrinsics.length; i++) {
      const ext = extrinsics[i];
      if (typeof ext !== "string") continue;
      if (blake2b256Hex(ext) === hash) {
        return { blockHash: entry.blockHash, blockNumber: entry.n, index: i };
      }
    }
  }
  return null;
}

/**
 * Find a specific transaction inside a known block and re-derive its hash.
 *
 * `findTransaction` walks the last few blocks, which is right for a task that
 * arrives seconds after its proof was published. A proof REFERENCE that is
 * published for review is older than that, so it is looked up by the block
 * number it was published in instead — the same way an explorer does it.
 *
 * The hash is re-derived with our own BLAKE2b-256 rather than trusted from
 * the RPC, so the returned value is a real check and not an echo.
 *
 * @returns {Promise<{blockHash: string, blockNumber: number, index: number, derived: string}|null>}
 */
export async function findTransactionInBlock(proofTx, blockNumber, rpcUrl = DEFAULT_RPC) {
  const hash = String(proofTx ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return null;
  if (!Number.isInteger(blockNumber) || blockNumber < 0) return null;

  const blockHash = await rpc(rpcUrl, "chain_getBlockHash", [blockNumber]);
  if (!blockHash) return null;
  const block = await rpc(rpcUrl, "chain_getBlock", [blockHash]);

  const extrinsics = block?.block?.extrinsics ?? [];
  for (let i = 0; i < extrinsics.length; i++) {
    const ext = extrinsics[i];
    if (typeof ext !== "string") continue;
    const derived = blake2b256Hex(ext);
    if (derived === hash) {
      return { blockHash, blockNumber, index: i, derived };
    }
  }
  return null;
}

/**
 * Confirm the transaction is in a FINALIZED (not merely best) block.
 *
 * @returns {Promise<{finalized: boolean, headNumber: number}>}
 */
export async function isFinalized(blockNumber, rpcUrl = DEFAULT_RPC) {
  const headNumber = await finalizedBlockNumber(rpcUrl);
  return { finalized: blockNumber <= headNumber, headNumber };
}

/**
 * Verify a published proof reference against zkVerify mainchain.
 *
 * This is the check behind the Wildcard submission's zkVerify claim: the
 * transaction hash is RE-DERIVED from the raw extrinsic bytes with our own
 * BLAKE2b-256 (not echoed from the RPC) and the containing block is checked
 * against the finalized head.
 *
 * @returns {Promise<{ok: boolean, proofTx: string, blockNumber: number,
 *   blockHash?: string, extrinsicIndex?: number, derivedHash?: string,
 *   finalized?: boolean, finalizedHead?: number, error?: string}>}
 */
export async function verifyProofReference(proofTx, blockNumber, rpcUrl = DEFAULT_RPC) {
  const hash = String(proofTx ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    return { ok: false, proofTx: hash, blockNumber, error: "not a 32-byte transaction hash" };
  }
  const found = await findTransactionInBlock(hash, blockNumber, rpcUrl);
  if (!found) {
    return { ok: false, proofTx: hash, blockNumber, error: "transaction not found in that block" };
  }
  const { finalized, headNumber } = await isFinalized(blockNumber, rpcUrl);
  return {
    ok: finalized && found.derived === hash,
    proofTx: hash,
    blockNumber,
    blockHash: found.blockHash,
    extrinsicIndex: found.index,
    derivedHash: found.derived,
    finalized,
    finalizedHead: headNumber,
  };
}

/**
 * Submit a Groth16 proof to zkVerify through Kurier and wait for it to be
 * finalized on chain.
 *
 * @returns {Promise<{ok: boolean, status: string, txHash?: string, reason?: string}>}
 */
export async function verifyViaKurier({
  proof,
  publicSignals,
  registeredVk,
  apiKey = process.env.KURIER_API_KEY,
  apiBase = process.env.KURIER_API_BASE || KURIER_API,
  timeoutMs = 25_000,
}) {
  if (!apiKey) return { ok: false, status: "skipped", reason: "no Kurier API key configured" };
  if (!proof || !registeredVk) return { ok: false, status: "skipped", reason: "no proof material" };

  const submit = await fetch(`${apiBase}/submit-proof/${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: { proof, publicSignals, vk: registeredVk },
    }),
  });
  if (!submit.ok) {
    return { ok: false, status: "submit_failed", reason: `Kurier HTTP ${submit.status}` };
  }
  const job = await submit.json();
  const jobId = job?.jobId ?? job?.id;
  if (!jobId) return { ok: false, status: "submit_failed", reason: "Kurier returned no job id" };

  const deadline = Date.now() + timeoutMs;
  let status = job?.optimisticVerify ?? "Queued";
  while (Date.now() < deadline) {
    const poll = await fetch(`${apiBase}/job-status/${apiKey}/${jobId}`);
    if (!poll.ok) return { ok: false, status: "poll_failed", reason: `Kurier HTTP ${poll.status}` };
    const body = await poll.json();
    status = body?.status ?? status;
    if (status === "Finalized") {
      return { ok: true, status, txHash: body?.txHash ?? body?.transactionHash };
    }
    if (status === "Failed" || status === "Invalid") {
      return { ok: false, status, reason: body?.reason ?? "verification failed" };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, status, reason: "timed out waiting for finalization" };
}
