#!/usr/bin/env node
// Post-deploy gate for the agent endpoint.
//
//   node scripts/post-deploy-check.mjs
//   AGENT_GAMES_HMAC_SECRET=... node scripts/post-deploy-check.mjs --url https://host
//   node scripts/post-deploy-check.mjs --secret-file .secrets/agent-games.txt
//
// Two checks, both required:
//
//   1. GET /health resolves the prover. A deployment whose prover is missing is
//      still "up": every answer is correct and simply carries no proof, which
//      costs -2 per provable task and the reliability bonus — exactly the
//      failure that is invisible after a deploy.
//
//   2. One signed Proof Gatekeeper task with NO proof material, so the Worker
//      must generate the proof itself. The reply has to carry a decision, a
//      Groth16 proof and its public_signals, and that proof has to verify
//      against the official gatekeeper vkey (exported from the published
//      circuit.zkey, so it is the platform's key, not our own restatement).
//
// Exit code is 0 only when both pass; 1 when a check fails; 2 when the check
// cannot run at all (no secret, no circuit artifacts).
//
// The probe is a practice task with a synthetic 16-byte proof_tx, so it spends
// no zkVerify RPC calls and cannot look like a real competition answer. It does
// write one `answers` row and claims one `proof_refs` row; the exact cleanup
// command is printed at the end.
import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const require = createRequire(new URL("prover/package.json", ROOT));

/** The gatekeeper circuit registered for the competition (AGENTS.md). */
const GATEKEEPER_VK = "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";
/** The registration cutoff the Worker itself applies (src/prover.js). */
const PROVER_STALE_MS = 10 * 60_000;
const RECIPIENT = "0xabcdef1234567890abcdef1234567890abcdef12";

function usage(msg) {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: node scripts/post-deploy-check.mjs [--url URL] [--secret-file PATH]");
  process.exit(2);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") out.url = argv[++i];
    else if (a === "--secret-file") out.secretFile = argv[++i];
    else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const BASE = (args.url ?? process.env.AGENT_URL ?? "https://vfy-agent.hallo-alexa.workers.dev").replace(/\/+$/, "");
const AGENT = `${BASE}/agent`;

const sign = (secret, body) => createHmac("sha256", secret).update(body).digest("hex");

/** Read the platform HMAC secret. Never printed, only its length. */
function readSecret() {
  const file = args.secretFile ?? process.env.AGENT_GAMES_SECRET_FILE;
  if (file) {
    if (!existsSync(file)) usage(`secret file not found: ${file}`);
    return readFileSync(file, "utf8").trim();
  }
  return String(process.env.AGENT_GAMES_HMAC_SECRET ?? "").trim();
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

/** 1. The prover resolves and can prove the circuit we need. */
async function checkHealth() {
  let res;
  try {
    res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    return check("health reachable", false, err?.message ?? String(err));
  }
  if (!check("health returns 200", res.status === 200, `HTTP ${res.status}`)) return false;

  let body;
  try {
    body = await res.json();
  } catch {
    return check("health is JSON", false, "body was not JSON");
  }
  if (!check("health ok", body?.ok === true, JSON.stringify(body?.agent ?? ""))) return false;

  const prover = body?.prover;
  if (!check("prover resolves", Boolean(prover), prover ? `source ${prover.source}` : "prover: null")) return false;
  if (!check("prover source is known", prover.source === "registration" || prover.source === "config", String(prover.source))) {
    return false;
  }

  if (prover.source === "registration") {
    // A stale row means the prover stopped heartbeating: the Worker would
    // ignore it, so this is not a working prover.
    const age = Number(prover.age_ms);
    if (!check("registration is fresh", Number.isFinite(age) && age >= 0 && age <= PROVER_STALE_MS, `age_ms ${prover.age_ms}`)) {
      return false;
    }
  } else {
    console.log("note  source \"config\": the prover advertises no circuit list, so /health cannot confirm it has gatekeeper");
  }

  const circuits = Array.isArray(prover.circuits) ? prover.circuits : [];
  if (circuits.length > 0) {
    if (!check("prover offers gatekeeper", circuits.includes("gatekeeper"), circuits.join(", "))) return false;
  }
  return true;
}

/** The official verification key: exported from the published zkey. */
async function officialVkey(snarkjs) {
  const dir = new URL("prover/circuits/gatekeeper/", ROOT);
  const vkeyPath = fileURLToPath(new URL("vkey.json", dir));
  if (existsSync(vkeyPath)) return JSON.parse(readFileSync(vkeyPath, "utf8"));
  const zkey = fileURLToPath(new URL("circuit.zkey", dir));
  if (!existsSync(zkey)) {
    // Not a failed check: there is simply nothing to verify against. A proof
    // that is accepted unchecked would defeat the point of the probe.
    usage("prover/circuits/gatekeeper/circuit.zkey is missing — download the official artifacts first");
  }
  return snarkjs.zKey.exportVerificationKey(zkey);
}

/**
 * 2. A signed task with no proof material: the proof must come from our own
 *    prover and must verify against the official vkey.
 */
async function checkProbe(secret, snarkjs) {
  const taskId = `probe_postdeploy_${randomUUID()}`;
  // 16 bytes, like the platform's practice references: /^(0x)?[0-9a-f]{64}$/
  // does not match, so the Worker skips the on-chain lookup entirely.
  const proofTx = `0x${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const task = {
    type: "agent-games.proof-gatekeeper.v1",
    task_id: taskId,
    mode: "practice",
    issued_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + 60_000).toISOString(),
    // Deliberately NO proof, proof_data or public_signals: the Worker has to
    // ask the prover. proof_vk is present because a real task carries it, and
    // decide() rejects when both it and a verification are missing.
    input: {
      registered_vk: GATEKEEPER_VK,
      proof_vk: GATEKEEPER_VK,
      minimum: "1000",
      public_balance: "1460",
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: RECIPIENT,
      condition_recipient: RECIPIENT,
      amount: "500",
      max_transfer: "1000",
      proof_tx: proofTx,
    },
  };

  const body = Buffer.from(JSON.stringify(task));
  const sent = sign(secret, body);
  // Two commands on purpose: `d1 execute --command` reliably runs one
  // statement, and a combined two-statement command silently changed nothing.
  const cleanup = [
    `npx --yes wrangler@4 d1 execute vfy-agent --remote --command "DELETE FROM answers WHERE task_id='${taskId}'"`,
    `npx --yes wrangler@4 d1 execute vfy-agent --remote --command "DELETE FROM proof_refs WHERE proof_tx='${proofTx}'"`,
  ];
  const printCleanup = () => console.log(`      cleanup:\n        ${cleanup.join("\n        ")}`);

  let res;
  try {
    res = await fetch(AGENT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-games-signature": sent },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return check("probe answered", false, err?.message ?? String(err));
  }
  const raw = Buffer.from(await res.arrayBuffer());
  if (!check("probe returns 200", res.status === 200, `HTTP ${res.status}`)) {
    if (res.status === 401) console.log("      the signing secret was not accepted — check AGENT_GAMES_HMAC_SECRET");
    printCleanup();
    return false;
  }

  // The Worker signs every response with the secret the request used; an
  // unsigned or mismatched reply means we are not talking to the agent's own
  // response path.
  const given = (res.headers.get("x-agent-games-signature") ?? "").trim().replace(/^sha256=/, "");
  if (!check("response is signed with this secret", given === sign(secret, raw))) {
    printCleanup();
    return false;
  }

  let out;
  try {
    out = JSON.parse(raw.toString("utf8"));
  } catch {
    printCleanup();
    return check("probe is JSON", false, raw.toString("utf8").slice(0, 200));
  }

  const decided = out.decision === "APPROVE" || out.decision === "REJECT";
  if (!check("probe carries a decision", decided, `${out.decision} / ${out.reason_code}`)) {
    printCleanup();
    return false;
  }

  if (!check("probe carries a proof", Boolean(out.proof) && Array.isArray(out.public_signals))) {
    console.log("      no proof in the reply: the prover is reachable from /health but refused or timed out");
    printCleanup();
    return false;
  }

  const vkey = await officialVkey(snarkjs);
  if (!check("public_signals match the official circuit", out.public_signals.length === vkey.nPublic, `${out.public_signals.length} of nPublic ${vkey.nPublic}`)) {
    printCleanup();
    return false;
  }

  let verified = false;
  try {
    verified = await snarkjs.groth16.verify(vkey, out.public_signals, out.proof);
  } catch (err) {
    console.log(`      verify threw: ${err?.message ?? err}`);
  }
  const ok = check("proof verifies against the official vkey", verified === true);
  printCleanup();
  return ok;
}

const secret = readSecret();
if (!secret) {
  usage("no signing secret: set AGENT_GAMES_HMAC_SECRET or pass --secret-file");
}
if (!existsSync(new URL("prover/node_modules/snarkjs", ROOT))) {
  usage("snarkjs is not installed — run `cd prover && npm ci` so the proof can be verified");
}
const snarkjs = require("snarkjs");

console.log(`post-deploy check → ${BASE}\n`);
await checkHealth();
console.log("");
await checkProbe(secret, snarkjs);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
