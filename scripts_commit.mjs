// The strategy commitment for Steal the VFY — the hash the CIRCUIT checks.
//
//   node scripts_commit.mjs                      # print the committed strategy
//   node scripts_commit.mjs 10,0,0,0,0,0,0,0     # print for other params
//   node scripts_commit.mjs --new-salt           # rotate the salt (⇒ new commitment)
//
// WHY THIS REPLACED THE keccak VERSION
//
// The platform froze `0xf5a9f63b…14e1e2` — our keccak256(W || R) — as
// jimmygreen's commitment for the whole 13–17 Nov Swiss stage. The circuit
// derives it differently, and in circuit:
//
//     commitment = Poseidon(strategyParams[0..7], salt)   // params first, salt last
//
// Poseidon is not invertible, so no witness could ever exist for the keccak
// value: every turn was unprovable (−2 each) regardless of how well the agent
// played. A commitment is only useful if it is the hash the circuit computes.
//
// HOW THIS IS KNOWN, NOT GUESSED
//
// `prover/poseidon.mjs` is circomlib's Poseidon(9) — t = 10, 8 full rounds, 60
// partial rounds — with circomlib's own constant table. Three independent
// confirmations:
//   1. test/poseidon.test.js pins vectors computed by circomlibjs;
//   2. `node prover/check-vfy-turn.mjs` builds a witness and a real Groth16
//      proof against the platform's published vfy-policy zkey and verifies it;
//   3. with params [10,0,0,0,0,0,0,0] the proof's public signal [1] is this
//      exact value and [0] is the circuit's turn-binding digest, i.e. nine
//      signals as nPublic says.
//
// WHERE IT GOES (Steal the VFY only — Proof Gatekeeper has no commitment):
//   Dashboard → My Agents → jimmygreen → Edit → the Steal the VFY section.
// Both the dashboard and `STRATEGY_COMMITMENT` in wrangler.toml must hold this
// value, and the prover must hold the same salt + params, because the circuit
// recomputes the hash from them.
//
// The salt is private and gitignored (`.strategy-salt`, or STRATEGY_SALT on the
// prover). Without it the commitment cannot be reproduced — back it up.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseSalt, parseStrategyParams, strategyCommitment, toHex32 } from "./prover/poseidon.mjs";

const SALT_PATH = new URL("./.strategy-salt", import.meta.url);
const args = process.argv.slice(2);
const rotate = args.includes("--new-salt");
const paramsArg = args.find((a) => !a.startsWith("--"));

if (rotate) {
  const salt = randomBytes(32);
  // 0x-prefixed hex, one trailing newline: the same shape the rest of the repo reads.
  writeFileSync(SALT_PATH, "0x" + salt.toString("hex") + "\n");
  console.log("wrote a NEW salt to .strategy-salt — the old commitment can no longer be reproduced.");
  console.log("A new salt means a NEW commitment: register it before the next pairing.\n");
}

if (!existsSync(SALT_PATH)) {
  writeFileSync(SALT_PATH, "0x" + randomBytes(32).toString("hex") + "\n");
  console.log("no .strategy-salt existed; generated one (gitignored). Back it up.\n");
}

const params = parseStrategyParams(paramsArg ?? process.env.STRATEGY_PARAMS ?? "10,0,0,0,0,0,0,0");
const salt = parseSalt(readFileSync(SALT_PATH, "utf8"));
const commitment = strategyCommitment(params, salt);

console.log(`strategyParams : ${params.join(",")}`);
console.log(`salt           : 0x${salt.toString(16).padStart(64, "0")}`);
console.log(`commitment     : ${toHex32(commitment)}`);
console.log(`decimal        : ${commitment}`);
console.log("");
console.log("dashboard (jimmygreen → Edit → Steal the VFY):");
console.log(`  commitment hash : ${toHex32(commitment)}`);
console.log("  circuit version : v1-draft   (v1 is the same circuit, code 1)");
console.log("  policy version  : max-extract-v1");
console.log(`  wrangler.toml   : STRATEGY_COMMITMENT = "${toHex32(commitment)}"`);
console.log("");
console.log("Before registering, prove one turn against the official circuit:");
console.log("  node prover/check-vfy-turn.mjs");
