-- D1 schema for the zkVerify Agent Games agent.
--
-- D1 (not KV) because the replay check needs strong consistency: two tasks
-- carrying the same proof_tx must not both be answered as "first use".

-- Every proof reference we have seen, per scope. The task_id that first
-- claimed a reference owns it; a later task with the same reference is a
-- replay and must be rejected.
CREATE TABLE IF NOT EXISTS proof_refs (
  scope      TEXT NOT NULL,   -- 'competition' | 'practice'
  proof_tx   TEXT NOT NULL,   -- lowercased proof reference
  task_id    TEXT NOT NULL,   -- the task that first used it
  seen_at    TEXT NOT NULL,
  PRIMARY KEY (scope, proof_tx)
);

-- Answer cache, keyed by task_id. The platform may retry a task after a
-- network failure, and a retry must get the identical answer.
CREATE TABLE IF NOT EXISTS answers (
  task_id    TEXT PRIMARY KEY,
  mode       TEXT NOT NULL,
  response   TEXT NOT NULL,   -- the exact JSON body we returned
  answered_at TEXT NOT NULL
);

-- Steal the VFY turns: the full envelope is kept for replays and disputes.
CREATE TABLE IF NOT EXISTS vfy_turns (
  match_id   TEXT NOT NULL,
  turn       INTEGER NOT NULL,
  mode       TEXT NOT NULL,
  request    TEXT NOT NULL,
  response   TEXT NOT NULL,
  answered_at TEXT NOT NULL,
  PRIMARY KEY (match_id, turn)
);

-- Registered VK hashes we have seen, so a proof_vk that belongs to a
-- different (but real) circuit is reported as CIRCUIT_MISMATCH rather than
-- VK_SUBSTITUTION.
CREATE TABLE IF NOT EXISTS known_vks (
  vk_hash    TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL
);
