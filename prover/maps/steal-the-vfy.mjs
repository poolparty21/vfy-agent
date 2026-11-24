// Steal the VFY (vfy-policy) circuit input mapping.
//
// 17 inputs = the nine scalars the platform knows plus the eight private
// strategy params:
//
//   commitment, salt, matchId, turnNumber, selfBalance, opponentBalance,
//   action, amount, circuitVersion
//   + strategyParams[0..7]
//
// and nine public signals, in the circuit's output-then-public order:
//
//   [0] digest (turn-binding hash), [1] commitment, [2] matchId,
//   [3] turnNumber, [4] selfBalance, [5] opponentBalance, [6] action,
//   [7] amount, [8] circuitVersion
//
// Signal [1] is the commitment the platform froze at pairing, and the circuit
// checks it against Poseidon(strategyParams[0..7], salt) — so this map REFUSES
// to build a witness for a commitment that is not the hash of the strategy on
// this prover. That turns "every turn is silently unprovable" into one clear
// error, which is how the frozen keccak commitment should have failed.
//
// THE STRATEGY STAYS ON THE PROVER. The salt and the eight params are the
// private witness; the Worker never sees them and only forwards the turn facts.
// Both come from the prover's environment (STRATEGY_SALT / STRATEGY_PARAMS) or,
// for this PC, from the gitignored `.strategy-salt` at the repo root. On Fly the
// salt must be a secret (`fly secrets set STRATEGY_SALT=…`) because
// .dockerignore keeps the file out of the image.
import { readFileSync } from "node:fs";
import { FIELD, parseSalt, parseStrategyParams, strategyCommitment } from "../poseidon.mjs";
import { matchIdField } from "../../src/vfy.js";

const ACTION_CODE = { HOLD: 0, FORTIFY: 1, EXTRACT: 2 };

/** The committed policy, readable but never published: [extractCap, …]. */
const strategyParams = () =>
  parseStrategyParams(process.env.STRATEGY_PARAMS ?? "10,0,0,0,0,0,0,0");

const salt = () => {
  const fromEnv = String(process.env.STRATEGY_SALT ?? "").trim();
  if (fromEnv) return parseSalt(fromEnv);
  try {
    return parseSalt(readFileSync(new URL("../../.strategy-salt", import.meta.url), "utf8"));
  } catch (err) {
    throw new Error(`no STRATEGY_SALT and no readable .strategy-salt (${err?.message})`);
  }
};

const field = (v) => {
  if (v === undefined || v === null || v === "") throw new Error("missing circuit input");
  return (BigInt(v) % FIELD).toString();
};

/**
 * @param {object} payload { turn: { matchId, turn, selfBalance, opponentBalance,
 *   action: {type, amount?}, circuitVersion, commitment } }
 * @returns the circuit's 17 inputs as decimal strings
 */
export default ({ turn }) => {
  if (!turn) throw new Error("payload.turn is required");
  const action = ACTION_CODE[turn.action?.type];
  if (action === undefined) throw new Error(`unknown action ${turn.action?.type}`);

  const commitment = BigInt(turn.commitment);
  const params = strategyParams();
  const s = salt();

  // Fail here, with a readable message, instead of inside the witness
  // generator: the circuit would refuse this anyway (commitment is bound to the
  // params), and every turn would cost −2 with only a stack trace to show.
  const derived = strategyCommitment(params, s);
  if (derived !== commitment) {
    throw new Error(
      `commitment ${turn.commitment} is not Poseidon(strategyParams, salt) for the strategy on this prover ` +
        `(expected ${"0x" + derived.toString(16).padStart(64, "0")})`,
    );
  }

  return {
    commitment: field(commitment),
    salt: s.toString(),
    matchId: matchIdField(turn.matchId).toString(),
    turnNumber: field(turn.turn),
    selfBalance: field(turn.selfBalance),
    opponentBalance: field(turn.opponentBalance),
    action: String(action),
    // The circuit requires amount == strategyParams[0] exactly for EXTRACT and
    // rejects an amount on HOLD/FORTIFY, so this mirrors the policy rather than
    // re-deriving it.
    amount: action === ACTION_CODE.EXTRACT ? field(turn.action?.amount) : "0",
    circuitVersion: "1",
    strategyParams: params.map((v) => (v % FIELD).toString()),
  };
};
