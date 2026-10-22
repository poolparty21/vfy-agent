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

import { verifySignatureAny, signBody, secretList, SECRET_HEADER } from "./hmac.js";
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
import { buildTurnResponse, fallbackTurnResponse, isVfyTurn } from "./vfy.js";

const enc = new TextEncoder();

/**
 * Bounds for the optional zkVerify verification step.
 *
 * The real response window is unknown: the docs say 60 seconds, but a live
 * practice envelope (2026-10-22) gave only 15. The verification lookup is
 * therefore capped at a fraction of the remaining time and skipped entirely
 * when there is not enough room — a timeout (-2) is worse than any evidence
 * the lookup could add.
 */
const MAX_VERIFY_BUDGET_MS = 6000;
const MIN_VERIFY_BUDGET_MS = 3000;

/**
 * How many milliseconds are left before the platform's deadline.
 *
 * The docs say 60 seconds, but a real practice envelope (2026-10-22) carried
 * `deadline_at` only **15 seconds** after `issued_at`. The real window is
 * therefore unknown and possibly much shorter than advertised, so the budget
 * is taken from the envelope itself and never from a hard-coded assumption.
 *
 * When the deadline is absent or unparseable we fall back to a conservative
 * 12s — short enough to be safe even against a 15s window.
 */
function deadlineBudgetMs(task, fallbackMs = 12_000) {
  const raw = task?.deadline_at ?? task?.deadlineAt;
  if (!raw) return fallbackMs;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return fallbackMs;
  return at - Date.now();
}

/**
 * Build a signed JSON response.
 *
 * `secret` is the secret the request was verified with. Several agents can
 * share one endpoint, each with its own secret, so the response has to be
 * signed with the SAME secret the platform used — not just any of them.
 */
async function send(env, status, obj, { keyForm = "text", prefix = "", secret } = {}) {
  const body = enc.encode(JSON.stringify(obj));
  const key = secret ?? env.AGENT_GAMES_HMAC_SECRET;
  const signature = key ? await signBody(key, body, { keyForm, prefix }) : "";
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
 *
 * @param {number} budgetMs hard ceiling for the whole verification step
 */
async function verifyProof(env, input, budgetMs = 12_000) {
  const registeredVk = pick(input, ["registered_vk", "registeredVk", "vk_hash"]);
  const proof = pick(input, ["proof", "groth16_proof", "proof_data"]);
  const publicSignals = pick(input, ["public_signals", "publicSignals", "public_inputs"]);
  const proofTx = pick(input, ["proof_tx", "proofTx"]);

  const result = { ok: false, failed: false, txHash: null, status: "not_attempted" };
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);

  try {
    if (proof && registeredVk) {
      const kurier = await verifyViaKurier({
        proof,
        publicSignals,
        registeredVk,
        apiKey: env.KURIER_API_KEY,
        apiBase: env.KURIER_API_BASE,
        // Never let Kurier eat the whole response window.
        timeoutMs: Math.max(2000, Math.min(25_000, left() - 3000)),
      });
      result.status = kurier.status;
      result.ok = kurier.ok;
      result.failed = kurier.status === "Failed" || kurier.status === "Invalid";
      result.txHash = kurier.txHash ?? null;
      return result;
    }

    // Only a full 32-byte Substrate transaction hash can be found on chain.
    // A shorter reference (practice tasks use a synthetic 16-byte one) is
    // skipped without spending a single RPC call.
    if (proofTx && /^(0x)?[0-9a-fA-F]{64}$/.test(proofTx.trim()) && left() > 1500) {
      const found = await findTransaction(proofTx, env.ZKVERIFY_RPC);
      result.status = found ? "on_chain" : "not_found";
      result.ok = Boolean(found);
      // A proof reference that is nowhere on chain is a real signal, but we do
      // not treat a lookup miss as proof invalid: the reference may predate our
      // lookback window.
    } else if (proofTx) {
      result.status = "skipped_short_reference";
    }
  } catch (err) {
    result.status = "error";
    result.reason = err?.message;
  }

  return result;
}


/** Handle one Proof Gatekeeper task. */
async function handleGatekeeper(env, task, sign) {
  const db = env.DB;
  const taskId = String(task.task_id ?? "");
  const mode = task.mode === "competition" ? "competition" : "practice";

  // Idempotency: a retried task must get the identical answer.
  const agentKey = sign.agentKey || "default";
  const cached = await getAnswer(db, agentKey, taskId);
  if (cached) {
    console.log(JSON.stringify({ event: "proof-gatekeeper", taskId, mode, replay: "cached" }));
    return send(env, 200, JSON.parse(cached), sign);
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
  const isFirstUse = await claimProofRef(db, agentKey, mode, proofTx, taskId);
  const isReplay = proofTx ? !isFirstUse : false;

  // The real window is unknown: a live practice envelope gave 15 seconds,
  // while the docs claim 60. So the verification step gets only a FRACTION
  // of whatever is left, and is skipped entirely when there is not enough
  // room to do it safely. A timeout (-2) costs more than any evidence the
  // lookup could add.
  const remaining = deadlineBudgetMs(task);
  const budgetMs = remaining <= MIN_VERIFY_BUDGET_MS ? 0 : Math.min(MAX_VERIFY_BUDGET_MS, remaining * 0.5);

  const verification = await verifyProof(env, input, budgetMs);

  const verdict = decide(input, {
    isReplay,
    verificationOk: verification.ok,
    verificationFailed: verification.failed,
    knownVks,
  });

  // Which reason_code vocabulary the platform records. The rules page says
  // "canonical"; the live arena screen renders the trap labels. Switchable
  // with one var until a practice task shows which one it stores.
  const style = env.AGENT_REASON_STYLE === "trap" ? "trap" : "canonical";
  const reasonCode = style === "trap" ? verdict.trap_code : verdict.reason_code;

  // The build guide: "Respond with the decision, a reason code, and — on every
  // provable task — the Groth16 proof and its public_signals (an omitted or
  // invalid proof costs −2)." The task payload carries the proof material the
  // third party submitted, so we echo it back with our decision. The scoring
  // model adds a further −2 for a provable task answered without a valid
  // Groth16 proof, and the reliability bonus is pro-rated by the share of
  // provable tasks whose proof verifies.
  const proof = pick(input, ["proof", "groth16_proof", "proof_data"]);
  const publicSignals = pick(input, ["public_signals", "publicSignals", "public_inputs"]);

  const response = {
    decision: verdict.decision,
    reason_code: reasonCode,
    ...(proofTx ? { proof_tx: proofTx } : {}),
    ...(proof ? { proof } : {}),
    ...(publicSignals ? { public_signals: publicSignals } : {}),
  };

  await saveAnswer(db, agentKey, taskId, mode, JSON.stringify(response));
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
  return send(env, 200, response, sign);
}


/** Handle one Steal the VFY turn. */
async function handleVfyTurn(env, task, sign) {
  const db = env.DB;
  const matchId = String(task.matchId ?? "");
  const turn = Number(task.turn ?? 0);

  const agentKey = sign.agentKey || "default";
  const cached = await getVfyTurn(db, agentKey, matchId, turn);
  if (cached) {
    console.log(JSON.stringify({ event: "steal-the-vfy", matchId, turn, replay: "cached" }));
    return send(env, 200, JSON.parse(cached), sign);
  }

  // Building the response must never be able to lose the turn: a missing or
  // invalid response is scored as a HOLD with a reliability penalty, but a
  // thrown error is a delivery timeout — strictly worse.
  let response;
  try {
    response = buildTurnResponse(task, new Date(), env.STRATEGY_COMMITMENT);
  } catch (err) {
    console.error("vfy response build failed:", err?.message);
    response = fallbackTurnResponse(task);
  }
  await saveVfyTurn(db, {
    agentKey,
    matchId,
    turn,
    mode: String(task.mode ?? ""),
    request: JSON.stringify(task),
    response: JSON.stringify(response),
  });
  console.log(JSON.stringify({ event: "steal-the-vfy", matchId, turn, action: response.action }));
  return send(env, 200, response, sign);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health endpoint, unauthenticated, for uptime monitoring.
    if ((request.method === "GET" || request.method === "HEAD") &&
        (url.pathname === "/health" || url.pathname === "/")) {
      return new Response(JSON.stringify({ ok: true, agent: "vfy-agent" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const agentPath = env.AGENT_PATH ?? "/agent";

    // Log every inbound request, including ones that are rejected before a
    // handler runs. A platform safety check that never reaches us is invisible
    // otherwise, and that is exactly the failure we are chasing.
    console.log(
      JSON.stringify({
        event: "request",
        method: request.method,
        path: url.pathname,
        ua: (request.headers.get("user-agent") ?? "").slice(0, 60),
      }),
    );

    // Some endpoint safety checkers probe a well-known path to confirm the
    // host serves a real application. Answer it with the same JSON as the
    // health check so a probe can never read as an unreachable host.
    if (url.pathname === "/.well-known/agent-games.json" || url.pathname === "/.well-known/agent.json") {
      return new Response(
        JSON.stringify({
          ok: true,
          agent: "vfy-agent",
          protocolVersion: "v1",
          endpoint: agentPath,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    // The platform's safety/reachability check may probe the REGISTERED
    // endpoint with GET, HEAD or OPTIONS before it ever delivers a task. A
    // 404 on that path reads as an unreachable or unsafe endpoint, so every
    // probe method answers 200 on the agent path.
    if (url.pathname === agentPath && request.method !== "POST") {
      const headers = { "content-type": "application/json" };
      if (request.method === "OPTIONS") {
        headers["access-control-allow-origin"] = "*";
        headers["access-control-allow-methods"] = "GET, HEAD, POST, OPTIONS";
        headers["access-control-allow-headers"] = "content-type, x-agent-games-signature";
        headers["access-control-max-age"] = "86400";
        return new Response(null, { status: 204, headers });
      }
      return new Response(JSON.stringify({ ok: true, agent: "vfy-agent", protocolVersion: "v1" }), {
        status: 200,
        headers,
      });
    }

    if (request.method !== "POST" || url.pathname !== agentPath) {
      return new Response(null, { status: 404 });
    }

    const secrets = secretList(env);
    if (secrets.length === 0) {
      return new Response("secret not configured", { status: 500 });
    }

    // Verify the signature against the RAW body, before parsing anything.
    const raw = new Uint8Array(await request.arrayBuffer());
    const header = request.headers.get(SECRET_HEADER) ?? "";
    const { ok, keyForm, prefix, secret, agentKey } = await verifySignatureAny(secrets, raw, header);
    if (!ok) {
      // Lengths only, never values: enough to spot a bad paste vs a scheme
      // mismatch without echoing anything secret.
      console.warn(
        `bad signature (accepted secrets ${secrets.length}, signature length ${header.trim().length})`,
      );
      return send(env, 401, { error: "invalid signature" });
    }

    let task;
    try {
      task = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return send(env, 400, { error: "invalid json" }, { keyForm, prefix, secret, agentKey });
    }

    try {
      if (task.type === "agent-games.preflight.v1") {
        return send(env, 200, { ok: true, protocolVersion: "v1" }, { keyForm, prefix, secret, agentKey });
      }
      if (task.type === "agent-games.proof-gatekeeper.v1") {
        // AWAITED on purpose: returning the promise from inside a `try` does
        // NOT catch its rejection, so an async error would escape as a 500 —
        // and a 500 is recorded as a delivery timeout, not as a wrong answer.
        return await handleGatekeeper(env, task, { keyForm, prefix, secret, agentKey });
      }
      if (isVfyTurn(task)) {
        return await handleVfyTurn(env, task, { keyForm, prefix, secret, agentKey });
      }
      console.warn("unknown task type", task.type, JSON.stringify(Object.keys(task)));
      return send(env, 400, { error: "unsupported task type" }, { keyForm, prefix, secret, agentKey });
    } catch (err) {
      console.error("handler error:", err?.message);
      // Fail closed with a well-formed answer rather than a 5xx.
      return send(
        env,
        200,
        { decision: "REJECT", reason_code: REASON.PROOF_INVALID },
        { keyForm, prefix, secret, agentKey },
      );
    }
  },
};
