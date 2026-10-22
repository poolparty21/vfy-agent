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
