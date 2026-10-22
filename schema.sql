-- D1 schema for the zkVerify Agent Games agent.
--
-- D1 (not KV) because the replay check needs strong consistency: two tasks
-- carrying the same proof_tx must not both be answered as "first use".
--
-- EVERY row is keyed by agent_key as well. Several agents can share one
-- endpoint (one Worker, one D1), and the platform numbers task ids per agent
-- (gk_9d1, gk_9d2, ...) — so without an agent dimension, agent #2 would be
-- served agent #1's cached answer, and agent #1's proof references would look
-- like replays to agent #2.

-- Every proof reference we have seen, per agent and scope. The task_id that
-- first claimed a reference owns it; a later task with the same reference is a
-- replay and must be rejected.
CREATE TABLE IF NOT EXISTS proof_refs (
  agent_key  TEXT NOT NULL,   -- identifies the agent (derived from its secret)
  scope      TEXT NOT NULL,   -- 'competition' | 'practice'
  proof_tx   TEXT NOT NULL,   -- lowercased proof reference
  task_id    TEXT NOT NULL,   -- the task that first used it
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (agent_key, scope, proof_tx)
);

-- Answer cache, keyed by agent and task. The platform may retry a task after
-- a network failure, and a retry must get the identical answer.
CREATE TABLE IF NOT EXISTS answers (
  agent_key  TEXT NOT NULL,
  task_id    TEXT NOT NULL,
  mode       TEXT NOT NULL,
  response   TEXT NOT NULL,   -- the exact JSON body we returned
  answered_at TEXT NOT NULL,
  PRIMARY KEY (agent_key, task_id)
);

-- Steal the VFY turns: the full envelope is kept for replays and disputes.
CREATE TABLE IF NOT EXISTS vfy_turns (
  agent_key  TEXT NOT NULL,
  match_id   TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  mode       TEXT NOT NULL,
  request    TEXT NOT NULL,
  response   TEXT NOT NULL,
  answered_at TEXT NOT NULL,
  PRIMARY KEY (agent_key, match_id, turn)
);

-- Registered VK hashes we have seen, so a proof_vk that belongs to a
-- different (but real) circuit is reported as CIRCUIT_MISMATCH rather than
-- VK_SUBSTITUTION.
CREATE TABLE IF NOT EXISTS known_vks (
  vk_hash    TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL
);
