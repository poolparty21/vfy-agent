// Prints the Steal the VFY strategy commitment C = keccak256(W || R).
//
// W = the policy parameters (extractCap, version) as 32-byte big-endian words,
// R = a private 32-byte salt. The raw strategy stays with us; only C is
// registered on the dashboard.
//
// usage: node scripts_commit.mjs [saltFile]   (creates the salt if missing)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { keccak256, POLICY } from "./src/vfy.js";

const saltFile = process.argv[2] ?? ".strategy-salt";
if (!existsSync(saltFile)) {
  writeFileSync(saltFile, randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
}
const salt = Buffer.from(readFileSync(saltFile, "utf8").trim(), "hex");
if (salt.length !== 32) throw new Error("salt must be 32 bytes of hex");

const word = (n) => Buffer.from(BigInt(n).toString(16).padStart(64, "0"), "hex");
const witness = [POLICY.extractCap, Number(POLICY.version)].map(word);

// keccak256() returns a hex STRING, so decode it back to bytes before
// concatenating — otherwise the digest's characters are hashed instead of its
// bytes.
const digest = Buffer.from(keccak256(Buffer.concat([...witness, salt])).slice(2), "hex");
const commitment = "0x" + digest.toString("hex");

console.log(
  JSON.stringify(
    {
      commitmentHash: commitment,
      circuitVersion: "v1-draft",
      policyVersion: `${POLICY.name}-v${POLICY.version}`,
    },
    null,
    2,
  ),
);
