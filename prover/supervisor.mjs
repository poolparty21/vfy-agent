// One command to run everything the prover needs, and to keep the Worker
// pointed at it.
//
//   node prover/supervisor.mjs
//
// It runs, and restarts if they die:
//   1. cloudflared — a quick tunnel to the local prover. Its hostname CHANGES
//      on every restart, which is the whole reason this file exists.
//   2. the prover — snarkjs on 127.0.0.1:8790.
//
// and it re-registers the tunnel's current url with the Worker (signed with
// PROVER_TOKEN) as soon as the hostname appears, then every 2 minutes as a
// heartbeat, so a restarted tunnel self-heals instead of silently costing a
// proof on every task.
//
// Env: WORKER_URL, PROVER_TOKEN (or ../.prover-token), PROVER_PORT,
//      CLOUDFLARED (path to the binary), PROVER_CIRCUITS.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROVER_DIR = join(ROOT, "prover");
const PORT = String(process.env.PROVER_PORT ?? 8790);
const WORKER = (process.env.WORKER_URL ?? "https://vfy-agent.hallo-alexa.workers.dev").replace(/\/+$/, "");
const CIRCUITS = (process.env.PROVER_CIRCUITS ?? "gatekeeper").split(",").map((s) => s.trim()).filter(Boolean);
const CLOUDFLARED =
  process.env.CLOUDFLARED ?? join(ROOT, ".tooling", "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
const HEARTBEAT_MS = 2 * 60_000;
const LIVENESS_TIMEOUT_MS = 15_000;
const DEAD_BEATS_BEFORE_RESTART = 2;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const TOKEN = (process.env.PROVER_TOKEN ?? (existsSync(join(ROOT, ".prover-token")) ? readFileSync(join(ROOT, ".prover-token"), "utf8") : "")).trim();
if (!TOKEN) {
  console.error("PROVER_TOKEN (or ./.prover-token) is required: it signs the registration.");
  process.exit(1);
}
if (!existsSync(CLOUDFLARED)) {
  console.error(`cloudflared not found at ${CLOUDFLARED}. Set CLOUDFLARED=/path/to/cloudflared.`);
  process.exit(1);
}

const stamp = () => new Date().toISOString();
let currentUrl = null;
let tunnel = null;
let deadBeats = 0;

/** POST the current url to the Worker. Never throws: a failed beat is a warning. */
async function register(reason) {
  if (!currentUrl) return;
  const body = Buffer.from(JSON.stringify({ url: currentUrl, circuits: CIRCUITS, ts: Date.now() }));
  const sig = createHmac("sha256", TOKEN).update(body).digest("hex");
  try {
    const res = await fetch(`${WORKER}/prover/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-prover-signature": sig },
      body,
    });
    const text = (await res.text()).slice(0, 200);
    console.log(`${stamp()} register (${reason}) ${res.status} ${text}`);
  } catch (err) {
    console.warn(`${stamp()} register (${reason}) FAILED: ${err?.message}`);
  }
}

/** The tunnel's hostname is printed on its log stream, so it is read from there. */
function watchTunnelLogs(stream) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    // Keep the tail only: the banner is small, this must not grow forever.
    if (buffer.length > 8192) buffer = buffer.slice(-4096);
    const match = buffer.match(URL_RE);
    const found = match?.[0]?.replace(/\/+$/, "");
    if (found && found !== currentUrl) {
      currentUrl = found;
      console.log(`${stamp()} tunnel url: ${currentUrl}`);
      register("new url");
    }
  });
}

function startTunnel() {
  const child = spawn(CLOUDFLARED, ["tunnel", "--url", `http://127.0.0.1:${PORT}`, "--protocol", "http2", "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  watchTunnelLogs(child.stdout);
  watchTunnelLogs(child.stderr);
  child.on("exit", (code) => {
    console.warn(`${stamp()} tunnel exited (${code}); restarting in 5s`);
    currentUrl = null;
    deadBeats = 0;
    if (tunnel === child) tunnel = null;
    setTimeout(startTunnel, 5000);
  });
  tunnel = child;
  return child;
}

/**
 * Does the tunnel's public hostname still answer?
 *
 * A quick tunnel can lose its hostname while cloudflared itself stays alive:
 * Cloudflare withdraws the DNS record but the process never exits, so nothing
 * is restarted and this supervisor would keep re-registering a dead url
 * forever. Every prove request then fails and every provable task is answered
 * without a proof (-2 each), with nothing in the logs to show it.
 *
 * So the heartbeat asks the url from outside. After two consecutive failures
 * the tunnel is killed, which mints a new hostname that re-registers itself.
 */
async function tunnelAlive() {
  if (!currentUrl) return true; // still starting: not dead, just not born yet
  try {
    const res = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(LIVENESS_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

function startProver() {
  const child = spawn(process.execPath, [join(PROVER_DIR, "server.mjs")], {
    cwd: PROVER_DIR,
    // stdio inherit: the prover's own lines (circuit loaded, prove times) stay visible.
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, PROVER_TOKEN: TOKEN, PROVER_PORT: PORT },
  });
  child.on("exit", (code) => {
    console.warn(`${stamp()} prover exited (${code}); restarting in 5s`);
    setTimeout(startProver, 5000);
  });
  return child;
}

const children = [startProver(), startTunnel()];

// Heartbeat: keeps the registration fresh while the tunnel keeps the same url,
// so the Worker never falls back to a stale PROVER_URL (or to nothing) — and
// checks that the registered url still answers, so a revoked hostname is
// replaced instead of re-registered.
setInterval(async () => {
  await register("heartbeat");
  if (await tunnelAlive()) {
    deadBeats = 0;
    return;
  }
  deadBeats += 1;
  console.warn(`${stamp()} registered url ${currentUrl} is not answering (${deadBeats}/${DEAD_BEATS_BEFORE_RESTART})`);
  if (deadBeats >= DEAD_BEATS_BEFORE_RESTART) {
    deadBeats = 0;
    console.warn(`${stamp()} restarting the tunnel to mint a fresh hostname`);
    tunnel?.kill();
  }
}, HEARTBEAT_MS);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`${stamp()} ${signal} — stopping prover and tunnel`);
    for (const child of children) child.kill();
    process.exit(0);
  });
}

console.log(`${stamp()} supervising: prover on 127.0.0.1:${PORT}, worker ${WORKER}, circuits ${CIRCUITS.join(", ")}`);
