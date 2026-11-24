#!/usr/bin/env node
/**
 * FLOP testnet agent runner.
 *
 * One run = claim testnet $FLOP from the faucet (if the cooldown has expired),
 * spend it on inference through the gateway, then append a voucher record.
 * Vouchers are earned per FLOP spent, so unspent faucet grants are worth zero.
 *
 * Deliberately standalone: no dependencies, no imports from the vfy Worker,
 * its D1, its wrangler config or its secrets. Secrets come only from the
 * env vars this file names explicitly (${ENV:NAME} in the config); nothing
 * is ever written to disk or to the log.
 *
 * Usage:
 *   node runner.mjs probe                 # is the faucet/gateway answering?
 *   node runner.mjs run                   # claim (if due) + spend + log
 *   node runner.mjs run --dry-run         # print the requests, send nothing
 *   node runner.mjs run --force            # ignore the claim cooldown
 *   node runner.mjs status                # totals from state + last record
 *
 * Options: --config <path> (default ./config.json, or $FLOP_CONFIG)
 */

import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  timeoutMs: 30_000,
  retries: 2,
  retryDelayMs: 5_000,
  claimIntervalHours: 24,
  maxCallsPerRun: 8,
  maxSpendPerRunFlop: 100,
  flopPerMillionTokens: 0, // 0 = price unknown, log tokens only
  logDir: "log",
};

/* ---------------------------------------------------------------- args */

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === "dry-run" || key === "force" || key === "help" || key === "quiet") {
      out.flags[key] = true;
    } else {
      out.flags[key] = argv[++i];
    }
  }
  return out;
}

const HELP = `FLOP testnet agent runner

  node runner.mjs probe                 check faucet and gateway reachability
  node runner.mjs run [--force]         claim if due, spend on inference, log
  node runner.mjs run --dry-run         show the exact requests, send nothing
  node runner.mjs status                vouchers, tokens and runs so far

  --config <path>    config file (default ./config.json, or $FLOP_CONFIG)
  --quiet            only write the log, no stdout summary

Fill the faucet and gateway URLs into config.json at launch. Claiming also
works by posting in Technocore chat if the faucet API is not open yet: the
chat path is unchanged, only the vouchers/spend part of the run matters.
`;

/* -------------------------------------------------------- placeholders */

function envOf(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`config references \${ENV:${name}} but that env var is not set`);
  }
  return v;
}

/** {wallet}, {did}, {amount} and ${ENV:NAME}; unknown keys are left visible. */
function fill(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\$\{ENV:([A-Za-z0-9_]+)\}|\{([a-zA-Z_]+)\}/g, (m, envName, key) => {
      if (envName) return envOf(envName);
      if (key && vars[key] !== undefined) return String(vars[key]);
      return m;
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fill(v, vars);
    return out;
  }
  return value;
}

function joinUrl(base, path) {
  if (!path) return base;
  return base.replace(/\/+$/, "") + "/" + String(path).replace(/^\/+/, "");
}

/* ---------------------------------------------------------------- http */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, { method = "GET", body, headers = {}, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json, keep the text */ }
  return { status: res.status, ok: res.ok, text, json };
}

/** Retries network failures and 5xx only: a 4xx is a real answer. */
async function withRetry(label, fn, opts = {}) {
  const retries = opts.retries ?? DEFAULTS.retries;
  const delay = opts.retryDelayMs ?? DEFAULTS.retryDelayMs;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fn();
      if (res.status >= 500) { last = res; if (attempt < retries) { await sleep(delay); continue; } }
      return res;
    } catch (err) {
      last = { status: 0, ok: false, text: String(err?.message ?? err), json: null };
      if (attempt < retries) await sleep(delay);
    }
  }
  return { ...last, networkError: true, label };
}

function num(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Faucets name the granted amount differently; take the first that parses. */
function grantedFlop(json) {
  if (!json || typeof json !== "object") return null;
  return num(
    json.amount, json.amount_flop, json.amountFlop, json.granted, json.flop,
    json.grant?.amount, json.grant?.flop, json.data?.amount, json.balance,
  );
}

function usageTokens(json) {
  if (!json || typeof json !== "object") return null;
  const u = json.usage ?? json.data?.usage ?? {};
  return num(u.total_tokens, (num(u.prompt_tokens) ?? 0) + (num(u.completion_tokens) ?? 0) || null);
}

/* -------------------------------------------------------------- config */

function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`no config at ${path} — copy config.example.json to config.json and fill the urls in at launch`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const cfg = {
    ...raw,
    policy: { ...DEFAULTS, ...(raw.policy ?? {}) },
    faucet: raw.faucet ?? {},
    gateway: raw.gateway ?? {},
    agent: raw.agent ?? {},
    network: raw.network ?? {},
  };
  const logDir = resolve(dirname(path), cfg.policy.logDir ?? "log");
  mkdirSync(logDir, { recursive: true });
  return { cfg, logDir, configPath: resolve(path) };
}

function vars(cfg) {
  return {
    wallet: cfg.agent.wallet ?? "",
    did: cfg.agent.did ?? "",
    amount: cfg.faucet.requestAmount ?? "",
    model: cfg.gateway.model ?? "",
  };
}

function readState(logDir) {
  const p = join(logDir, "state.json");
  if (!existsSync(p)) {
    return { runs: 0, vouchers: 0, tokens: 0, calls: 0, lastClaimAt: null, lastRunAt: null };
  }
  try { return { runs: 0, vouchers: 0, tokens: 0, calls: 0, lastClaimAt: null, lastRunAt: null, ...JSON.parse(readFileSync(p, "utf8")) }; }
  catch { return { runs: 0, vouchers: 0, tokens: 0, calls: 0, lastClaimAt: null, lastRunAt: null }; }
}

function writeState(logDir, state) {
  writeFileSync(join(logDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

/* --------------------------------------------------------------- claim */

function claimRequest(cfg, v) {
  const f = cfg.faucet;
  const method = String(f.method ?? "POST").toUpperCase();
  const url = joinUrl(f.url ?? "", fill(f.path ?? "", v));
  const headers = { "content-type": "application/json", ...fill(f.headers ?? {}, v) };
  const bodyObj = fill(f.bodyTemplate ?? { address: "{wallet}" }, v);
  const body = method === "GET" ? undefined : JSON.stringify(bodyObj);
  return { method, url, headers, body, bodyObj };
}

function claimDue(cfg, state) {
  if (!state.lastClaimAt) return true;
  const elapsed = Date.now() - Date.parse(state.lastClaimAt);
  return !(elapsed < cfg.policy.claimIntervalHours * 3600_000);
}

async function claim(cfg, v, state, { force, dryRun }) {
  const f = cfg.faucet;
  if (!f.url) return { status: "skipped", note: "no faucet url in config" };
  if (!force && !claimDue(cfg, state)) {
    const next = new Date(Date.parse(state.lastClaimAt) + cfg.policy.claimIntervalHours * 3600_000);
    return { status: "cooldown", note: `last claim ${state.lastClaimAt}, next after ${next.toISOString()}` };
  }

  const req = claimRequest(cfg, v);
  if (req.url.includes("{")) return { status: "skipped", note: `unfilled placeholder in faucet url: ${req.url}` };

  if (dryRun) return { status: "dry-run", note: `${req.method} ${req.url}`, body: req.bodyObj };

  const res = await withRetry("faucet", () =>
    http(req.url, { method: req.method, body: req.body, headers: req.headers, timeoutMs: cfg.policy.timeoutMs }),
  );

  if (res.networkError) return { status: "error", note: `network: ${res.text}` };
  if (res.status === 429 || res.status === 409) {
    return { status: "cooldown", note: `faucet said ${res.status}: ${trim(res.text)}` };
  }
  if (!res.ok) return { status: "error", note: `http ${res.status}: ${trim(res.text)}` };

  const granted = grantedFlop(res.json);
  return {
    status: "granted",
    grantedFlop: granted,
    note: granted === null ? `http ${res.status}, amount not in the response` : `http ${res.status}`,
    raw: res.json ?? trim(res.text),
  };
}

function trim(s, n = 300) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/* --------------------------------------------------------------- spend */

function spendRequest(cfg, v) {
  const g = cfg.gateway;
  const url = joinUrl(g.url ?? "", fill(g.path ?? "/v1/chat/completions", v));
  const headers = { "content-type": "application/json", ...fill(g.headers ?? {}, v) };
  if (g.bearerEnv) headers.authorization = `Bearer ${envOf(g.bearerEnv)}`;
  const bodyObj = {
    model: g.model ?? "",
    max_tokens: g.maxTokensPerCall ?? 256,
    messages: [{ role: "user", content: g.prompt ?? "Reply with exactly: ok" }],
  };
  return { method: "POST", url, headers, body: JSON.stringify(bodyObj), bodyObj };
}

async function spend(cfg, v, budgetFlop, { dryRun }) {
  const g = cfg.gateway;
  const p = cfg.policy;
  const out = { calls: 0, tokens: 0, flop: 0, stoppedReason: null, errors: [], lastModel: g.model ?? null };
  if (!g.url) { out.stoppedReason = "no gateway url in config"; return out; }

  const req = spendRequest(cfg, v);
  if (req.url.includes("{")) { out.stoppedReason = `unfilled placeholder in gateway url: ${req.url}`; return out; }

  if (dryRun) {
    out.stoppedReason = "dry-run";
    out.requests = [{ method: req.method, url: req.url, body: req.bodyObj, auth: g.bearerEnv ? `Bearer $${g.bearerEnv}` : "none" }];
    return out;
  }

  while (out.calls < p.maxCallsPerRun) {
    let res;
    try {
      res = await http(req.url, { method: req.method, body: req.body, headers: req.headers, timeoutMs: p.timeoutMs });
    } catch (err) {
      out.errors.push(`network: ${trim(err?.message ?? err, 160)}`);
      out.stoppedReason = out.calls === 0 ? "gateway unreachable" : "network error mid-run";
      break;
    }

    if (res.status === 402 || res.status === 401 || res.status === 403) {
      out.stoppedReason = `gateway refused (${res.status}): ${trim(res.text, 160)}`;
      break;
    }
    if (res.status === 429) { out.stoppedReason = "rate limited (429)"; break; }
    if (!res.ok) {
      out.errors.push(`http ${res.status}: ${trim(res.text, 160)}`);
      if (out.calls === 0) out.stoppedReason = "first call failed";
      break;
    }

    out.calls += 1;
    const tokens = usageTokens(res.json);
    if (tokens === null) out.errors.push("no usage in response, tokens not counted");
    out.tokens += tokens ?? 0;

    if (p.flopPerMillionTokens > 0) {
      out.flop = Number(((out.tokens / 1_000_000) * p.flopPerMillionTokens).toFixed(6));
      if (budgetFlop !== null && out.flop >= Math.min(budgetFlop, p.maxSpendPerRunFlop)) {
        out.stoppedReason = "budget reached";
        break;
      }
      if (out.flop >= p.maxSpendPerRunFlop) { out.stoppedReason = "spend cap reached"; break; }
    }
    if (out.calls >= p.maxCallsPerRun) { out.stoppedReason = "call cap reached"; break; }
  }

  if (!out.stoppedReason) out.stoppedReason = "done";
  return out;
}

/* ------------------------------------------------------------ network */

/** Optional: total vouchers across the network, for a share estimate. */
async function networkVouchers(cfg, v) {
  const url = cfg.network?.vouchersTotalUrl;
  if (!url) return null;
  try {
    const res = await http(fill(url, v), { timeoutMs: 10_000 });
    if (!res.ok) return null;
    const n = num(res.json?.total, res.json?.vouchers, res.json?.total_vouchers, typeof res.json === "number" ? res.json : null);
    return n;
  } catch { return null; }
}

/* --------------------------------------------------------------- main */

async function cmdProbe(cfg, v) {
  const rows = [];
  if (cfg.faucet.url) {
    const base = cfg.faucet.url.replace(/\/+$/, "");
    for (const path of ["", "/health", "/chain"]) {
      try {
        const res = await http(joinUrl(base, path), { timeoutMs: 10_000 });
        rows.push([`faucet${path || "/"}`, res.status, trim(res.text, 160)]);
      } catch (err) {
        rows.push([`faucet${path || "/"}`, "ERR", trim(err.message, 160)]);
      }
    }
  } else {
    rows.push(["faucet", "—", "no url in config"]);
  }
  if (cfg.gateway.url) {
    try {
      const res = await http(joinUrl(cfg.gateway.url, "/v1/models"), {
        headers: cfg.gateway.bearerEnv ? { authorization: `Bearer ${envOf(cfg.gateway.bearerEnv)}` } : {},
        timeoutMs: 10_000,
      });
      const names = (res.json?.data ?? []).map((m) => m.id).filter(Boolean).slice(0, 8);
      rows.push(["/v1/models", res.status, names.length ? names.join(", ") : trim(res.text, 160)]);
    } catch (err) {
      rows.push(["/v1/models", "ERR", trim(err.message, 160)]);
    }
  } else {
    rows.push(["gateway", "—", "no url in config"]);
  }

  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [a, b, c] of rows) console.log(`${a.padEnd(w)}  ${String(b).padEnd(4)}  ${c}`);
  // A 404 on the bare root is normal for a JSON-only service; only "nothing
  // answered at all" is a real failure.
  const answered = rows.some((r) => typeof r[1] === "number" && r[1] >= 200 && r[1] < 400);
  return answered ? 0 : 1;
}

async function cmdRun(cfg, v, flags, logDir) {
  const state = readState(logDir);
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, "");

  // Build the spend request before touching the faucet: a ${ENV:NAME} that is
  // not set must fail here, or the run burns a claim it cannot spend.
  spendRequest(cfg, v);

  const claimRes = await claim(cfg, v, state, { force: !!flags.force, dryRun: !!flags["dry-run"] });

  if (claimRes.status === "granted" && !flags["dry-run"]) {
    state.lastClaimAt = new Date().toISOString();
  }

  const budget = claimRes.grantedFlop ?? null;
  const spendRes = await spend(cfg, v, budget, { dryRun: !!flags["dry-run"] });

  const vouchers = spendRes.flop;
  state.tokens += spendRes.tokens;
  state.calls += spendRes.calls;
  state.vouchers = Number((state.vouchers + vouchers).toFixed(6));

  const netTotal = await networkVouchers(cfg, v);
  const share = netTotal && netTotal > 0 ? (state.vouchers / netTotal) * 100 : null;

  if (!flags["dry-run"]) {
    state.runs += 1;
    state.lastRunAt = new Date().toISOString();
    writeState(logDir, state);

    const record = {
      ts: state.lastRunAt,
      runId,
      claim: claimRes,
      spend: spendRes,
      totals: { runs: state.runs, vouchers: state.vouchers, tokens: state.tokens, calls: state.calls },
      share: { networkVouchers: netTotal, sharePct: share === null ? null : Number(share.toFixed(4)) },
    };
    appendFileSync(join(logDir, "vouchers.jsonl"), JSON.stringify(record) + "\n");
    appendFileSync(
      join(logDir, "runs.log"),
      `${record.ts} ${runId} claim=${claimRes.status}${claimRes.grantedFlop != null ? `(${claimRes.grantedFlop})` : ""} ` +
        `calls=${spendRes.calls} tokens=${spendRes.tokens} flop=${spendRes.flop.toFixed(4)} ` +
        `total=${state.vouchers.toFixed(4)} stop=${spendRes.stoppedReason}` +
        (spendRes.errors.length ? ` errors=${spendRes.errors.length}` : "") +
        "\n",
    );
  }

  const hardFail =
    claimRes.status === "error" ||
    spendRes.stoppedReason === "no gateway url in config" ||
    (!flags["dry-run"] && spendRes.calls === 0);

  // --quiet hides the summary, not the exit code: a scheduler reads the status.
  if (flags.quiet) return hardFail ? 1 : 0;

  const line = (...a) => console.log(...a);
  line(`run ${runId}`);
  line(`  claim    ${claimRes.status}${claimRes.grantedFlop != null ? `  +${claimRes.grantedFlop} FLOP` : ""}  ${claimRes.note ?? ""}`);
  line(`  spend    ${spendRes.calls} calls, ${spendRes.tokens} tokens, ${spendRes.flop.toFixed(4)} FLOP  (${spendRes.stoppedReason})`);
  for (const e of spendRes.errors) line(`           ! ${e}`);
  line(`  vouchers ${state.vouchers.toFixed(4)} total over ${state.runs} run(s)`);
  if (share !== null) line(`  share    ${share.toFixed(4)}% of ${netTotal} network vouchers`);
  if (flags["dry-run"]) {
    line("  dry-run: nothing sent, nothing logged");
    line(`  claim request  ${JSON.stringify(claimRes.body ?? null)}`);
  }
  if (spendRes.stoppedReason === "no gateway url in config") {
    line("  ! set gateway.url in config.json before the real run");
  }
  return hardFail ? 1 : 0;
}

async function cmdStatus(logDir) {
  const state = readState(logDir);
  console.log(JSON.stringify(state, null, 2));
  const p = join(logDir, "vouchers.jsonl");
  if (existsSync(p)) {
    const lines = readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    const last = lines[lines.length - 1];
    console.log(`\n${lines.length} run record(s); most recent:`);
    try { console.log(JSON.stringify(JSON.parse(last), null, 2)); } catch { console.log(last); }
  }
  return 0;
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0] ?? "run";
  if (flags.help || cmd === "help") { console.log(HELP); return 0; }

  const configPath = resolve(flags.config ?? process.env.FLOP_CONFIG ?? join(HERE, "config.json"));
  const { cfg, logDir } = loadConfig(configPath);
  const v = vars(cfg);

  if (cmd === "probe") return cmdProbe(cfg, v);
  if (cmd === "run") return cmdRun(cfg, v, flags, logDir);
  if (cmd === "status") return cmdStatus(logDir);
  console.error(`unknown command: ${cmd}\n`);
  console.log(HELP);
  return 2;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => { console.error(`error: ${err?.message ?? err}`); process.exit(1); },
);
