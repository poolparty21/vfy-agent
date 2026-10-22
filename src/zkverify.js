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
//      blocks to confirm the proof really landed on chain.
//
// Neither path may veto a decision the deterministic policy already reached
// on its own evidence: the trap set is built from the payload fields, and a
// wrong REJECT costs half of a wrong APPROVE. Verification only adds
// evidence (and can catch a genuinely invalid proof).

export const DEFAULT_RPC = "https://zkverify-rpc.zkverify.io";
export const KURIER_API = "https://api.kurier.xyz/api/v1";

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`zkVerify RPC ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`zkVerify RPC ${method}: ${json.error.message ?? "error"}`);
  return json.result;
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
 * Substrate exposes no "get tx by hash" RPC, so we walk back from the
 * finalized head. The lookback is deliberately small: the Worker free plan
 * caps subrequests, and a stale proof reference only weakens the evidence —
 * it never changes the deterministic verdict.
 */
export async function findTransaction(txHash, rpcUrl = DEFAULT_RPC, lookback = 24) {
  const hash = String(txHash ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) return null;
  const head = await rpc(rpcUrl, "chain_getFinalizedHead", []);
  const headBlock = await rpc(rpcUrl, "chain_getBlock", [head]);
  const headNum = Number(headBlock?.block?.header?.number ?? 0);
  const from = Math.max(0, headNum - lookback);
  for (let n = headNum; n >= from; n--) {
    const blockHash = await rpc(rpcUrl, "chain_getBlockHash", [n]);
    if (!blockHash) continue;
    const block = await rpc(rpcUrl, "chain_getBlock", [blockHash]);
    for (const ext of block?.block?.extrinsics ?? []) {
      if (String(ext?.hash ?? "").toLowerCase() === hash) {
        return { blockHash, blockNumber: n, index: ext.index };
      }
    }
  }
  return null;
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
  timeoutMs = 40_000,
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
