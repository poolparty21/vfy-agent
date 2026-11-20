// D1-backed state.
//
// D1 gives strong consistency, which the replay check needs: two concurrent
// tasks carrying the same proof_tx must not both be answered as "first use".
// KV is eventually consistent and would let a replay through.
//
// EVERY query is scoped by `agentKey`. Several agents can share one endpoint
// (one Worker, one D1) and the platform numbers task ids per agent
// (gk_9d1, gk_9d2, ...). Without the agent dimension, agent #2 would be
// served agent #1's cached answer, and agent #1's proof references would look
// like replays to agent #2 — a wrong answer on every task.

/**
 * Claim a proof reference.
 *
 * The insert is atomic (INSERT OR IGNORE on the primary key), so exactly one
 * task can own a given reference. The owner is then read back: if it is not
 * this task, the reference was already used and this is a replay.
 *
 * @returns {Promise<boolean>} true when this task is the first user
 */
export async function claimProofRef(db, agentKey, scope, proofTx, taskId, now = new Date()) {
  if (!db || !proofTx) return true;
  await db
    .prepare("INSERT OR IGNORE INTO proof_refs (agent_key, scope, proof_tx, task_id, seen_at) VALUES (?, ?, ?, ?, ?)")
    .bind(agentKey, scope, proofTx, taskId, now.toISOString())
    .run();
  const row = await db
    .prepare("SELECT task_id FROM proof_refs WHERE agent_key = ? AND scope = ? AND proof_tx = ?")
    .bind(agentKey, scope, proofTx)
    .first();
  return !row || row.task_id === taskId;
}

/** Read a previously stored answer for a task (idempotent retries). */
export async function getAnswer(db, agentKey, taskId) {
  if (!db || !taskId) return null;
  const row = await db
    .prepare("SELECT response FROM answers WHERE agent_key = ? AND task_id = ?")
    .bind(agentKey, taskId)
    .first();
  return row?.response ?? null;
}

/** Store the answer body for a task. */
export async function saveAnswer(db, agentKey, taskId, mode, response, now = new Date()) {
  if (!db || !taskId) return;
  await db
    .prepare("INSERT OR IGNORE INTO answers (agent_key, task_id, mode, response, answered_at) VALUES (?, ?, ?, ?, ?)")
    .bind(agentKey, taskId, mode, response, now.toISOString())
    .run();
}

/** Remember a VK hash that appeared in a task, so it counts as "known". */
export async function rememberVk(db, vkHash, now = new Date()) {
  if (!db || !vkHash) return;
  await db
    .prepare("INSERT OR IGNORE INTO known_vks (vk_hash, first_seen) VALUES (?, ?)")
    .bind(vkHash, now.toISOString())
    .run();
}

/** All VK hashes we have seen, used to separate CIRCUIT_MISMATCH from VK_SUBSTITUTION. */
export async function listKnownVks(db) {
  if (!db) return [];
  const res = await db.prepare("SELECT vk_hash FROM known_vks").all();
  return (res?.results ?? []).map((r) => r.vk_hash);
}

/** How long a dead registration is kept before housekeeping removes it. */
const PROVER_ROW_TTL_MS = 24 * 60 * 60_000;

/**
 * Record one prover's current url.
 *
 * ONE ROW PER URL, not one row overall: a PC supervisor (quick tunnel) and the
 * Fly container (stable name) can both be alive and both heartbeat, and a
 * single row would be last-write-wins — the Worker would flip between them every
 * two minutes. Storing both lets `currentProver` choose deterministically.
 *
 * `updated_at` is also the heartbeat, and a row older than the cutoff means
 * "that prover is down", not "it moved".
 */
export async function saveProver(db, { url, circuits = [], now = new Date() }) {
  if (!db || !url) return;
  await db
    .prepare(
      "INSERT INTO provers (url, circuits, updated_at) VALUES (?, ?, ?) ON CONFLICT(url) DO UPDATE SET circuits = excluded.circuits, updated_at = excluded.updated_at",
    )
    .bind(url, JSON.stringify(circuits), now.toISOString())
    .run();
  // Housekeeping: a registration that stopped beating is never a candidate, so
  // its row is dead weight. One small delete per heartbeat keeps it bounded.
  await db
    .prepare("DELETE FROM provers WHERE updated_at < ?")
    .bind(new Date(now.getTime() - PROVER_ROW_TTL_MS).toISOString())
    .run();
}

/** Every registered prover url, without judging how fresh any of them is. */
export async function listProvers(db) {
  if (!db) return [];
  const res = await db.prepare("SELECT url, circuits, updated_at FROM provers").all();
  return res?.results ?? [];
}

/** Store a Steal the VFY turn and read back a previous answer for it. */
export async function getVfyTurn(db, agentKey, matchId, turn) {
  if (!db) return null;
  const row = await db
    .prepare("SELECT response FROM vfy_turns WHERE agent_key = ? AND match_id = ? AND turn = ?")
    .bind(agentKey, matchId, turn)
    .first();
  return row?.response ?? null;
}

/** Record a Steal the VFY turn with its full request envelope. */
export async function saveVfyTurn(db, { agentKey, matchId, turn, mode, request, response }, now = new Date()) {
  if (!db) return;
  await db
    .prepare(
      "INSERT OR IGNORE INTO vfy_turns (agent_key, match_id, turn, mode, request, response, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(agentKey, matchId, turn, mode, request, response, now.toISOString())
    .run();
}
