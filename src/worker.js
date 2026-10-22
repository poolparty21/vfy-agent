// zkVerify Agent Games 2026 — agent endpoint (Cloudflare Worker).
//
// Protocol contract (from the platform build guide and rules):
//   - the platform POSTs a JSON task to our registered endpoint
//   - the request carries `x-agent-games-signature` = HMAC-SHA256 over the
//     RAW request body; we must verify it BEFORE parsing
//   - every response we send carries the same header, over the raw response
//     body
//   - the agent has 60 seconds to answer; late answers score as timeouts
//
// Task types we handle:
//   agent-games.preflight.v1        -> { ok: true, protocolVersion: "v1" }
//   agent-games.proof-gatekeeper.v1  -> { decision, reason_code, proof_tx }
//   steal-the-vfy turn envelopes     -> the turn response
//
// Everything is fail-closed: a signature failure is a 401, an unparseable
// body is a 400, and an internal error still returns a well-formed REJECT
// rather than a 5xx (a 5xx is recorded as a delivery timeout, which costs -2;
// a REJECT costs at most -3 but keeps the contract intact).

import { verifySignature, signBody, SECRET_HEADER } from "./hmac.js";
import { decide, REASON, normAddress, pick } from "./decide.js";
import {
  claimProofRef,
  getAnswer,
  saveAnswer,
  rememberVk,
  listKnownVks,
  getVfyTurn,
  saveVfyTurn,
} from "./store.js";
import { verifyViaKurier, findTransaction } from "./zkverify.js";
import { buildTurnResponse, isVfyTurn } from "./vfy.js";

const enc = new TextEncoder();

/** Build a signed JSON response. */
async function send(env, status, obj, keyForm = "text", prefix = "") {
  const body = enc.encode(JSON.stringify(obj));
  const signature = env.AGENT_GAMES_HMAC_SECRET
    ? await signBody(env.AGENT_GAMES_HMAC_SECRET, body, { keyForm, prefix })
    : "";
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json",
      ...(signature ? { [SECRET_HEADER]: signature } : {}),
    },
  });
}

/**
 * Verify the proof through zkVerify.
 *
 * Two sources of truth, both optional:
 *   - the task may carry the Groth16 proof + public signals, in which case we
 *     submit it to zkVerify ourselves via Kurier, using the REGISTERED vk
 *   - otherwise we only confirm that the task's proof_tx is a real finalized
 *     zkVerify transaction
 *
 * A failure here is evidence, not a veto: the deterministic policy decides.
 */
async function verifyProof(env, input) {
  const registeredVk = pick(input, ["registered_vk", "registeredVk", "vk_hash"]);
  const proof = pick(input, ["proof", "groth16_proof", "proof_data"]);
  const publicSignals = pick(input, ["public_signals", "publicSignals", "public_inputs"]);
  const proofTx = pick(input, ["proof_tx", "proofTx"]);

  const result = { ok: false, failed: false, txHash: null, status: "not_attempted" };

  if (proof && registeredVk) {
    const kurier = await verifyViaKurier({
      proof,
      publicSignals,
      registeredVk,
      apiKey: env.KURIER_API_KEY,
      apiBase: env.KURIER_API_BASE,
    });
    result.status = kurier.status;
    result.ok = kurier.ok;
    result.failed = kurier.status === "Failed" || kurier.status === "Invalid";
    result.txHash = kurier.txHash ?? null;
    return result;
  }

  if (proofTx) {
    const found = await findTransaction(proofTx, env.ZKVERIFY_RPC);
    result.status = found ? "on_chain" : "not_found";
    result.ok = Boolean(found);
    // A proof reference that is nowhere on chain is a real signal, but we do
    // not treat a lookup miss as proof invalid: the reference may predate our
    // lookback window.
  }

  return result;
}


/** Handle one Proof Gatekeeper task. */
async function handleGatekeeper(env, task, keyForm, prefix) {
  const db = env.DB;
  const taskId = String(task.task_id ?? "");
  const mode = task.mode === "competition" ? "competition" : "practice";

  // Idempotency: a retried task must get the identical answer.
  const cached = await getAnswer(db, taskId);
  if (cached) {
    console.log(JSON.stringify({ event: "proof-gatekeeper", taskId, mode, replay: "cached" }));
    return send(env, 200, JSON.parse(cached), keyForm, prefix);
  }

  const input = task.input ?? {};
  const proofTx = String(pick(input, ["proof_tx", "proofTx"]) ?? "").trim().toLowerCase();
  const registeredVk = normAddress(pick(input, ["registered_vk", "registeredVk", "vk_hash"]));
  const proofVk = normAddress(pick(input, ["proof_vk", "proofVk"]));

  // Remember the REGISTERED VK only. A proof_vk that matches a VK we have seen
  // registered for some other task is a real circuit, so it is reported as
  // CIRCUIT_MISMATCH; anything else is a plain VK_SUBSTITUTION.
  await rememberVk(db, registeredVk);
  const knownVks = await listKnownVks(db);

  // Replay check: claim the reference atomically. The owner of the reference
  // is the task that used it first; anyone else is a replay.
  const isFirstUse = await claimProofRef(db, mode, proofTx, taskId);
  const isReplay = proofTx ? !isFirstUse : false;

  const verification = await verifyProof(env, input);

  const verdict = decide(input, {
    isReplay,
    verificationOk: verification.ok,
    verificationFailed: verification.failed,
    knownVks,
  });

  const response = {
    decision: verdict.decision,
    reason_code: verdict.reason_code,
    ...(proofTx ? { proof_tx: proofTx } : {}),
  };

  await saveAnswer(db, taskId, mode, JSON.stringify(response));
  console.log(
    JSON.stringify({
      event: "proof-gatekeeper",
      taskId,
      mode,
      decision: response.decision,
      reason_code: response.reason_code,
      replay: isReplay,
      verification: verification.status,
    }),
  );
  return send(env, 200, response, keyForm, prefix);
}


/** Handle one Steal the VFY turn. */
async function handleVfyTurn(env, task, keyForm, prefix) {
  const db = env.DB;
  const matchId = String(task.matchId ?? "");
  const turn = Number(task.turn ?? 0);

  const cached = await getVfyTurn(db, matchId, turn);
  if (cached) {
    console.log(JSON.stringify({ event: "steal-the-vfy", matchId, turn, replay: "cached" }));
    return send(env, 200, JSON.parse(cached), keyForm, prefix);
  }

  const response = buildTurnResponse(task, new Date(), env.STRATEGY_COMMITMENT);
  await saveVfyTurn(db, {
    matchId,
    turn,
    mode: String(task.mode ?? ""),
    request: JSON.stringify(task),
    response: JSON.stringify(response),
  });
  console.log(JSON.stringify({ event: "steal-the-vfy", matchId, turn, action: response.action }));
  return send(env, 200, response, keyForm, prefix);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health endpoint, unauthenticated, for uptime monitoring.
    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return new Response(JSON.stringify({ ok: true, agent: "vfy-agent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const agentPath = env.AGENT_PATH ?? "/agent";

    // The platform's health check may probe the REGISTERED endpoint with a
    // plain GET, so that path must answer 200 even before a task arrives —
    // a 404 here reads as an offline agent.
    if (request.method === "GET" && url.pathname === agentPath) {
      return new Response(JSON.stringify({ ok: true, agent: "vfy-agent", protocolVersion: "v1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (request.method !== "POST" || url.pathname !== agentPath) {
      return new Response(null, { status: 404 });
    }

    if (!env.AGENT_GAMES_HMAC_SECRET) {
      return new Response("secret not configured", { status: 500 });
    }

    // Verify the signature against the RAW body, before parsing anything.
    const raw = new Uint8Array(await request.arrayBuffer());
    const header = request.headers.get(SECRET_HEADER) ?? "";
    const { ok, keyForm, prefix } = await verifySignature(env.AGENT_GAMES_HMAC_SECRET, raw, header);
    if (!ok) {
      // Lengths only, never values: enough to spot a bad paste vs a scheme
      // mismatch without echoing anything secret.
      console.warn(
        `bad signature (secret length ${String(env.AGENT_GAMES_HMAC_SECRET).trim().length}, signature length ${header.trim().length})`,
      );
      return send(env, 401, { error: "invalid signature" });
    }

    let task;
    try {
      task = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return send(env, 400, { error: "invalid json" }, keyForm, prefix);
    }

    try {
      if (task.type === "agent-games.preflight.v1") {
        return send(env, 200, { ok: true, protocolVersion: "v1" }, keyForm, prefix);
      }
      if (task.type === "agent-games.proof-gatekeeper.v1") {
        return handleGatekeeper(env, task, keyForm, prefix);
      }
      if (isVfyTurn(task)) {
        return handleVfyTurn(env, task, keyForm, prefix);
      }
      console.warn("unknown task type", task.type, JSON.stringify(Object.keys(task)));
      return send(env, 400, { error: "unsupported task type" }, keyForm, prefix);
    } catch (err) {
      console.error("handler error:", err?.message);
      // Fail closed with a well-formed answer rather than a 5xx.
      return send(
        env,
        200,
        { decision: "REJECT", reason_code: REASON.PROOF_INVALID },
        keyForm,
        prefix,
      );
    }
  },
};
