// Groth16 prover for the vfy-agent Worker.
//
// Proving cannot happen inside the Worker: the circom wasm wants a heap larger
// than a Worker's 128 MB. It runs here instead, as a long-lived process.
//
// WHY THE CALCULATOR IS BUILT ONCE
// snarkjs's groth16.fullProve builds a fresh witness calculator on every call,
// and on Windows that asks the OS for a multi-gigabyte wasm memory each time.
// Measured on this machine, that made a single prove anywhere from 170 ms to
// 6.2 s — against a 15 s task window, with the platform's pushes every ~30 s.
// Holding one calculator per circuit and streaming the .wtns to groth16.prove
// is a stable ~70 ms (witness 2 ms, prove 70 ms), so the variance is gone.
//
//   circuits/<name>/circuit.wasm + circuit.zkey   (binaries, gitignored)
//   maps/<name>.mjs                              (signal mapping)
//
// Requests and responses are HMAC-SHA256 signed with PROVER_TOKEN, so the
// tunnel in front of this can be public without the prover being open.
//
//   PROVER_TOKEN=... node server.mjs      (listens on 127.0.0.1:8790)
import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as snarkjs from "snarkjs";
import { WitnessCalculatorBuilder } from "circom_runtime";

const PORT = Number(process.env.PROVER_PORT ?? 8790);
// fileURLToPath, not `.pathname`: the latter yields /C:/... on Windows, which
// every fs call then fails to open (the prover would load zero circuits).
const DIR = process.env.CIRCUITS_DIR ?? fileURLToPath(new URL("./circuits", import.meta.url));
const TOKEN = (process.env.PROVER_TOKEN ?? "").trim();
if (!TOKEN) {
  console.error("PROVER_TOKEN is required (the Worker signs every request with it).");
  process.exit(1);
}

const sign = (buf) => createHmac("sha256", TOKEN).update(buf).digest("hex");
const ok = (given, raw) => {
  const want = sign(raw);
  return typeof given === "string" && given.length === want.length && timingSafeEqual(Buffer.from(given), Buffer.from(want));
};

/** Proving is CPU-bound on one thread: run one at a time so requests queue instead of thrash. */
let chain = Promise.resolve();
const serialize = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
};

const circuits = new Map();

async function loadCircuits() {
  circuits.clear();
  if (!existsSync(DIR)) return;
  for (const name of readdirSync(DIR)) {
    const d = join(DIR, name);
    const wasm = join(d, "circuit.wasm");
    const zkey = join(d, "circuit.zkey");
    // A map beside the artifacts wins; otherwise ../maps/<name>.mjs. The
    // fallback keeps the map in one place, where its import of ../../src/vfy.js
    // resolves, instead of duplicating it next to the binaries.
    const map = [join(d, "map.mjs"), join(DIR, "..", "maps", `${name}.mjs`)].find(existsSync);
    if (!map || ![wasm, zkey].every(existsSync)) continue;
    const mod = await import(pathToFileURL(map).href + `?v=${Date.now()}`);
    const vkeyPath = join(d, "vkey.json");
    const vkey = existsSync(vkeyPath) ? JSON.parse(readFileSync(vkeyPath, "utf8")) : await snarkjs.zKey.exportVerificationKey(zkey);
    const calc = await WitnessCalculatorBuilder(readFileSync(wasm));
    circuits.set(name, { wasm, zkey, vkey, calc, mapInput: mod.default });
    console.log(`${name}: ready (nPublic ${vkey.nPublic})`);
  }
}

/** Witness + proof for one input set. Throws when the circuit rejects the input. */
async function proveWith(c, inputs) {
  const data = await c.calc.calculateWTNSBin(inputs, true);
  const { proof, publicSignals } = await snarkjs.groth16.prove(c.zkey, { type: "mem", data });
  return { proof: { ...proof, curve: proof.curve ?? "bn128" }, publicSignals };
}

await loadCircuits();

function reply(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json", "x-prover-signature": sign(body) });
  res.end(body);
}

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    // Unsigned health only: it names circuits and nothing about a task.
    if (req.method === "GET" && req.url === "/health") {
      return reply(res, 200, { ok: true, circuits: [...circuits.keys()] });
    }
    if (!ok(req.headers["x-prover-signature"], raw)) return reply(res, 401, { error: "bad signature" });
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return reply(res, 400, { error: "bad json" });
    }

    if (req.url !== "/prove") return reply(res, 404, { error: "not found" });

    const c = circuits.get(msg.circuit);
    if (!c) return reply(res, 404, { error: `no circuit ${msg.circuit}` });

    const t0 = Date.now();
    // One attempt only. The circuit refuses a witness its rules disagree with,
    // and that refusal IS the answer: the Worker never wants the other decision
    // proved (a wrong APPROVE costs twice a wrong REJECT), so the policy picks
    // the decision and the circuit only confirms it.
    try {
      const { proof, publicSignals } = await serialize(() => proveWith(c, c.mapInput(msg.payload)));
      // Cheap (~50 ms) and worth it: never hand the Worker a proof that does
      // not verify against the platform's own key.
      const verified = await snarkjs.groth16.verify(c.vkey, publicSignals, proof);
      console.log(`prove ${msg.circuit} ms=${Date.now() - t0} verified=${verified}`);
      return reply(res, 200, { proof, public_signals: publicSignals, verified, ms: Date.now() - t0 });
    } catch (err) {
      console.warn(`prove ${msg.circuit} refused:`, String(err?.message).split("\n").filter(Boolean).slice(-1)[0]);
      return reply(res, 422, { error: "not provable", ms: Date.now() - t0 });
    }
  });
}).listen(PORT, "127.0.0.1", async () => {
  console.log(`prover on 127.0.0.1:${PORT}, circuits: ${[...circuits.keys()].join(", ") || "none"}`);
  // Prove once at boot so the first real task does not pay the wasm's memory set-up.
  for (const [name, c] of circuits) {
    try {
      const sample = c.mapInput({
        input: {
          registered_vk: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
          proof_vk: "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
          minimum: "1000",
          public_balance: "1460",
          expiry_block: 8430000,
          current_block: 8420000,
          recipient: "0xabcdef1234567890abcdef1234567890abcdef12",
          condition_recipient: "0xabcdef1234567890abcdef1234567890abcdef12",
          amount: "500",
          max_transfer: "1000",
        },
        taskId: `warm_${randomBytes(4).toString("hex")}`,
        decision: "APPROVE",
        taskIdEncoding: "keccakModP",
      });
      const t = Date.now();
      await serialize(() => proveWith(c, sample));
      console.log(`${name}: warmed in ${Date.now() - t}ms`);
    } catch (err) {
      console.warn(`${name}: warm-up failed`, String(err?.message).split("\n")[0]);
    }
  }
});
