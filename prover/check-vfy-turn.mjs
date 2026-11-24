// Does ONE Steal the VFY turn actually produce a proof?
//
//   node prover/check-vfy-turn.mjs
//
// Run this BEFORE registering a strategy commitment, not after a match has gone
// unproved. It answers the only question that matters for scoring: can a witness
// exist, and does the resulting proof verify against the platform's own key?
//
// What it does, using the same code a live turn uses:
//   1. derives the commitment with prover/poseidon.mjs (Poseidon(params, salt));
//   2. maps a practice turn through prover/maps/steal-the-vfy.mjs — the map a
//      running prover uses — which REFUSES a commitment that is not the hash of
//      the strategy on this machine;
//   3. builds the witness with the published vfy-policy.wasm and proves with
//      vfy-policy_final.zkey (prover/circuits/steal-the-vfy/);
//   4. verifies the proof against the vkey exported from that zkey;
//   5. builds the turn response the Worker would send and checks that
//      policyProof carries the proof and NINE public signals, with [1] equal to
//      the registered commitment.
//
// Exit code 0 means the commitment is provable. Anything else must block the
// registration: a commitment that cannot be proved is −2 on every turn of the
// match, which is exactly what the 13–17 Nov stage cost.
//
// Artifacts are gitignored binaries. If they are missing:
//   mkdir -p prover/circuits/steal-the-vfy && \
//   curl -sS -o prover/circuits/steal-the-vfy/circuit.wasm https://agentgames.zkverify.io/circuits/vfy-policy.wasm && \
//   curl -sS -o prover/circuits/steal-the-vfy/circuit.zkey https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey
import fs from "node:fs";
import { existsSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { WitnessCalculatorBuilder } from "circom_runtime";
import mapInput from "./maps/steal-the-vfy.mjs";
import { parseSalt, parseStrategyParams, strategyCommitment, toHex32 } from "./poseidon.mjs";
import { buildTurnResponse, chooseAction, matchIdField } from "../src/vfy.js";

const dir = new URL("./circuits/steal-the-vfy/", import.meta.url);
const file = (name) => new URL(name, dir);

for (const name of ["circuit.wasm", "circuit.zkey"]) {
  if (!existsSync(file(name))) {
    console.error(`missing ${name} in prover/circuits/steal-the-vfy/ — see the header of this file for the download commands.`);
    process.exit(2);
  }
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const params = parseStrategyParams(process.env.STRATEGY_PARAMS ?? "10,0,0,0,0,0,0,0");
const salt = parseSalt(
  process.env.STRATEGY_SALT ?? fs.readFileSync(new URL("../.strategy-salt", import.meta.url), "utf8"),
);
const commitment = strategyCommitment(params, salt);
const commitmentHex = toHex32(commitment);

// A practice turn exactly like the platform's: 100/100, turn 1, version "v1".
const envelope = {
  protocolVersion: "v1",
  eventId: "steal-the-vfy",
  mode: "practice",
  matchId: "9f4e1b2a-c53d-4b21-9f8a-1234567890ab",
  turn: 1,
  resolverVersion: "v1",
  strategyCommitment: { hash: commitmentHex },
  state: { selfBalance: 100, opponentBalance: 100 },
};

const action = chooseAction(envelope.state);
console.log(`\nturn: ${envelope.matchId} #${envelope.turn}  ${action.type}${action.amount ? " " + action.amount : ""}`);
console.log(`commitment: ${commitmentHex}\n`);

const turnPayload = {
  matchId: envelope.matchId,
  turn: envelope.turn,
  selfBalance: envelope.state.selfBalance,
  opponentBalance: envelope.state.opponentBalance,
  action,
  circuitVersion: envelope.resolverVersion,
  commitment: commitmentHex,
};

const inputs = mapInput({ turn: turnPayload });
check("map accepts the commitment as Poseidon(strategyParams, salt)", true);
check("EXTRACT amount equals strategyParams[0]", inputs.amount === params[0].toString(), `${inputs.amount} vs ${params[0]}`);

const calc = await WitnessCalculatorBuilder(fs.readFileSync(file("circuit.wasm")));
let wtns;
try {
  wtns = await calc.calculateWTNSBin(inputs, true);
  check("circuit builds a witness for this turn", true, `${wtns.length} bytes`);
} catch (err) {
  check("circuit builds a witness for this turn", false, String(err?.message).split("\n").filter(Boolean).slice(-1)[0]);
}

if (wtns) {
  const { proof, publicSignals } = await snarkjs.groth16.prove(
    fs.readFileSync(file("circuit.zkey")),
    { type: "mem", data: wtns },
  );

  const vkey = existsSync(file("vkey.json"))
    ? JSON.parse(fs.readFileSync(file("vkey.json"), "utf8"))
    : await snarkjs.zKey.exportVerificationKey(fs.readFileSync(file("circuit.zkey")));

  check("official vkey has nPublic 9", vkey.nPublic === 9, String(vkey.nPublic));
  check("proof has 9 public signals", publicSignals.length === 9, String(publicSignals.length));
  check("signal[1] is the registered commitment", publicSignals[1] === commitment.toString());
  check("signal[0] is a non-zero digest", publicSignals[0] !== "0");

  const expected = [
    matchIdField(envelope.matchId).toString(), // [2]
    String(envelope.turn), // [3]
    String(envelope.state.selfBalance), // [4]
    String(envelope.state.opponentBalance), // [5]
    String(action.type === "HOLD" ? 0 : action.type === "FORTIFY" ? 1 : 2), // [6]
    String(action.amount ?? 0), // [7]
    "1", // [8] circuitVersion
  ];
  check("signals [2..8] bind the turn", expected.every((v, i) => publicSignals[i + 2] === v), expected.map((v, i) => `${i + 2}=${publicSignals[i + 2]}${publicSignals[i + 2] === v ? "" : "≠" + v}`).join(" "));

  const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  check("proof verifies against the platform's vkey", verified);

  // The response shape the platform grades: proof and public_signals together,
  // both inside policyProof, nine signals.
  const response = buildTurnResponse(envelope, new Date(), undefined, { proof, public_signals: publicSignals });
  check("policyProof.proof is present", Boolean(response.policyProof.proof));
  check("policyProof.public_signals has 9", response.policyProof.public_signals?.length === 9);

  // The binding the whole thing exists for: a commitment that is not the hash of
  // this strategy must be refused before a single turn is played.
  let refused = false;
  try {
    mapInput({ turn: { ...turnPayload, commitment: toHex32(strategyCommitment(params, salt + 1n)) } });
  } catch {
    refused = true;
  }
  check("a commitment that is not Poseidon(params, salt) is refused", refused);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("NOT PROVABLE — do not register this commitment.");
  process.exit(1);
}
console.log("PROVABLE — one practice turn returns policyProof.proof with 9 signals.");
// snarkjs keeps a worker handle alive after verify; exit explicitly so a
// pipeline around this script does not hang on an otherwise finished check.
process.exit(0);
