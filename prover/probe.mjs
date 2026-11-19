// One signed request against a running prover, from anywhere.
//
//   node prover/probe.mjs                                    (127.0.0.1:8790)
//   PROVER_URL=https://vfy-prover-missi.fly.dev node prover/probe.mjs
//
// Proves the same sample the prover warms up with, so a green result means the
// circuit loads and proves, not just that a port answers. Also checks that an
// unsigned request is refused and that the reply is signed with the token,
// which is what the Worker relies on.
//
// The token comes from PROVER_TOKEN or the gitignored .prover-token; it is
// never printed.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = (process.env.PROVER_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
const tokenPath = fileURLToPath(new URL("../.prover-token", import.meta.url));
const token = (process.env.PROVER_TOKEN ?? readFileSync(tokenPath, "utf8")).trim();
if (!token) {
  console.error("no PROVER_TOKEN and no .prover-token file");
  process.exit(2);
}

const sign = (buf) => createHmac("sha256", token).update(buf).digest("hex");

const body = Buffer.from(
  JSON.stringify({
    circuit: "gatekeeper",
    payload: {
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
      taskId: "probe_signed",
      decision: "APPROVE",
      taskIdEncoding: "keccakModP",
    },
  }),
);

const headers = { "content-type": "application/json" };
const [proved, refused] = await Promise.all([
  fetch(`${base}/prove`, { method: "POST", headers: { ...headers, "x-prover-signature": sign(body) }, body }),
  fetch(`${base}/prove`, { method: "POST", headers, body }),
]);

const raw = await proved.text();
const replySigOk = proved.headers.get("x-prover-signature") === sign(Buffer.from(raw));
let json = {};
try {
  json = JSON.parse(raw);
} catch {}

const out = {
  url: base,
  status: proved.status,
  verified: json.verified ?? null,
  signals: Array.isArray(json.public_signals) ? json.public_signals.length : 0,
  ms: json.ms ?? null,
  replySigOk,
  unsignedStatus: refused.status,
};
console.log(JSON.stringify(out, null, 2));

const pass =
  proved.status === 200 && out.verified === true && out.signals === 13 && replySigOk && refused.status === 401;
process.exit(pass ? 0 : 1);
