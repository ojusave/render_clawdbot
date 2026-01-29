import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Busboy from "busboy";
import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";
import WebSocket, { WebSocketServer } from "ws";

// Render sets PORT for HTTP services; default locally to 8080.
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);

// Prefer Render's persistent disk mount if present.
const DATA_MOUNT = "/data";
const HAS_RENDER_DISK = (() => {
  try {
    return fs.existsSync(DATA_MOUNT) && fs.statSync(DATA_MOUNT).isDirectory();
  } catch {
    return false;
  }
})();

const STATE_DIR =
  process.env.MOLTBOT_STATE_DIR?.trim() ||
  (HAS_RENDER_DISK ? path.join(DATA_MOUNT, ".moltbot") : path.join(os.homedir(), ".moltbot"));

const WORKSPACE_DIR =
  process.env.MOLTBOT_WORKSPACE_DIR?.trim() ||
  (HAS_RENDER_DISK ? path.join(DATA_MOUNT, "workspace") : path.join(STATE_DIR, "workspace"));

// Protect /install with a user-provided password.
const SETUP_PASSWORD = (process.env.RENDER_SETUP_PASSWORD || process.env.SETUP_PASSWORD || "").trim() || null;

// Gateway admin token (protects Moltbot gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  const envTok = (process.env.RENDER_GATEWAY_TOKEN || process.env.MOLTBOT_GATEWAY_TOKEN || "").trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // ignore
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch {
    // best-effort
  }
  return generated;
}

const MOLTBOT_GATEWAY_TOKEN = resolveGatewayToken();
process.env.MOLTBOT_GATEWAY_TOKEN = MOLTBOT_GATEWAY_TOKEN;

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;
const GATEWAY_READY_TIMEOUT_MS = Number.parseInt(process.env.GATEWAY_READY_TIMEOUT_MS ?? "60000", 10);
const GATEWAY_READY_PATH = (process.env.GATEWAY_READY_PATH ?? "/healthz").trim() || "/healthz";
const GATEWAY_READY_POLL_MS = Number.parseInt(process.env.GATEWAY_READY_POLL_MS ?? "300", 10);
const GATEWAY_READY_REQ_TIMEOUT_MS = Number.parseInt(process.env.GATEWAY_READY_REQ_TIMEOUT_MS ?? "2000", 10);

// Static branding assets (optional).
const PUBLIC_DIR = path.join(process.cwd(), "public");
const RENDER_LOGO_FILE = (process.env.RENDER_LOGO_FILE || "Render logo - Black.jpg").trim();
const RENDER_LOGO_PATH = path.join(PUBLIC_DIR, RENDER_LOGO_FILE);
const RENDER_DEPLOY_URL =
  (process.env.RENDER_DEPLOY_URL || "https://render.com/deploy?repo=https://github.com/ojusave/render_clawdbot").trim();
const RENDER_LOGO_URL = (() => {
  try {
    if (!fs.existsSync(RENDER_LOGO_PATH)) return null;
  } catch {
    return null;
  }
  return `/public/${encodeURIComponent(RENDER_LOGO_FILE)}`;
})();

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const MOLTBOT_ENTRY = process.env.MOLTBOT_ENTRY?.trim() || "/moltbot/dist/entry.js";
const MOLTBOT_NODE = process.env.MOLTBOT_NODE?.trim() || "node";

function moltArgs(args) {
  return [MOLTBOT_ENTRY, ...args];
}

function configPath() {
  return process.env.MOLTBOT_CONFIG_PATH?.trim() || path.join(STATE_DIR, "moltbot.json");
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? GATEWAY_READY_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? GATEWAY_READY_POLL_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? GATEWAY_READY_REQ_TIMEOUT_MS;
  const readyPath = (opts.path ?? GATEWAY_READY_PATH).trim() || "/healthz";
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), requestTimeoutMs);
      const res = await fetch(`${GATEWAY_TARGET}${readyPath}`, {
        method: "GET",
        signal: controller.signal,
      }).finally(() => clearTimeout(t));

      // /healthz should be 200; treat any non-5xx as "gateway is responding".
      if (res && res.status < 500) return true;
    } catch {
      // not ready
    }
    await sleep(pollMs);
  }
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not installed");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    MOLTBOT_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(MOLTBOT_NODE, moltArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      MOLTBOT_STATE_DIR: STATE_DIR,
      MOLTBOT_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not installed" };
  // If a start is already in-flight, ALWAYS wait for it. Otherwise concurrent
  // requests can race and get proxied before the gateway has bound the port.
  if (gatewayStarting) {
    await gatewayStarting;
    return { ok: true };
  }
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady();
      if (!ready) {
        // Prevent wedging the installer on slow cold starts.
        // If the gateway eventually comes up, a subsequent retry will succeed.
        try {
          gatewayProc?.kill("SIGTERM");
        } catch {
          // ignore
        }
        gatewayProc = null;
        throw new Error(`Gateway did not become ready in time (timeout ${GATEWAY_READY_TIMEOUT_MS}ms)`);
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

function requireInstallAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send("RENDER_SETUP_PASSWORD is not set. Set it in Render Environment Variables before using /install.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Moltbot Install"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (password !== SETUP_PASSWORD) {
    res.set("WWW-Authenticate", 'Basic realm="Moltbot Install"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        MOLTBOT_STATE_DIR: STATE_DIR,
        MOLTBOT_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

async function getUpstreamAuthGroups() {
  // Mirror upstream Moltbot wizard 1:1 by using its own option builder.
  // Falls back to a minimal list if the internal modules ever move.
  try {
    const authProfilesMod = await import(pathToFileURL("/moltbot/dist/agents/auth-profiles.js").href);
    const authChoiceOptionsMod = await import(
      pathToFileURL("/moltbot/dist/commands/auth-choice-options.js").href,
    );

    const ensureAuthProfileStore = authProfilesMod.ensureAuthProfileStore;
    const buildAuthChoiceGroups = authChoiceOptionsMod.buildAuthChoiceGroups;

    if (typeof ensureAuthProfileStore !== "function" || typeof buildAuthChoiceGroups !== "function") {
      throw new Error("Missing upstream auth-choice functions");
    }

    // In containers we never want to prompt for secrets/keychain access.
    const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false });

    const { groups } = buildAuthChoiceGroups({
      store,
      includeSkip: false,
      includeClaudeCliIfMissing: true,
      platform: process.platform,
    });

    return (Array.isArray(groups) ? groups : []).map((g) => ({
      value: g.value,
      label: g.label,
      hint: g.hint,
      options: (Array.isArray(g.options) ? g.options : []).map((o) => ({
        value: o.value,
        label: o.label,
        hint: o.hint,
      })),
    }));
  } catch (err) {
    console.warn("[wrapper] failed to load upstream auth choices; using fallback:", String(err));
    return [
      {
        value: "anthropic",
        label: "Anthropic",
        hint: "Claude Code CLI + API key",
        options: [
          { value: "apiKey", label: "Anthropic API key" },
          { value: "token", label: "Anthropic token (paste setup-token)" },
        ],
      },
      {
        value: "google",
        label: "Google",
        hint: "Gemini API key + OAuth",
        options: [{ value: "gemini-api-key", label: "Google Gemini API key" }],
      },
      {
        value: "openai",
        label: "OpenAI",
        hint: "Codex OAuth + API key",
        options: [{ value: "openai-api-key", label: "OpenAI API key" }],
      },
    ];
  }
}

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    MOLTBOT_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map authChoice -> CLI flag for API-key–based providers. Keep in sync with moltbot
    // register.onboard (--auth-choice / --*-api-key) and onboard-non-interactive/local/auth-choice.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "apiKey": "--anthropic-api-key",
      "openai-api-key": "--openai-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "xiaomi-api-key": "--xiaomi-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "minimax-cloud": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "venice-api-key": "--venice-api-key",
      "opencode-zen": "--opencode-zen-api-key",
      "setup-token": "--token",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) args.push(flag, secret);

    if ((payload.authChoice === "token" || payload.authChoice === "setup-token") && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function isSafeTarPath(p) {
  if (!p) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\0")) return false;
  const norm = path.posix.normalize(p);
  if (norm.startsWith("../") || norm === "..") return false;
  return true;
}

function canRestoreFromTarPath(p) {
  // We only allow restoring into the Render disk roots we manage.
  if (!isSafeTarPath(p)) return false;
  return (
    p === ".moltbot" ||
    p === "workspace" ||
    p.startsWith(".moltbot/") ||
    p.startsWith("workspace/")
  );
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
// Avoid leaking tokenized URLs via Referer headers.
app.use((_req, res, next) => {
  res.set("Referrer-Policy", "no-referrer");
  next();
});

// Serve static assets (e.g. Render logo used for branding).
if (fs.existsSync(PUBLIC_DIR)) {
  app.use("/public", express.static(PUBLIC_DIR, { maxAge: "7d" }));
}

// Render health check.
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.get("/install/app.js", requireInstallAuth, (_req, res) => {
  res.type("application/javascript");
  res.send(fs.readFileSync(path.join(process.cwd(), "src", "install-app.js"), "utf8"));
});

app.get("/install", requireInstallAuth, (_req, res) => {
  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>🦞 Moltbot Installer — Clawdbot on Render</title>
  <meta name="description" content="Moltbot — The AI that actually does things. Deploy on Render with installer and Control UI." />
  <style>
    :root {
      --bg-deep: #050810;
      --bg-surface: #0a0f1a;
      --bg-elevated: #111827;
      --coral-bright: #ff4d4d;
      --cyan-bright: #00e5cc;
      --text-primary: #f0f4ff;
      --text-secondary: #8892b0;
      --text-muted: #5a6480;
      --border-subtle: rgba(136, 146, 176, 0.15);
      --border-accent: rgba(255, 77, 77, 0.3);
    }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem auto; max-width: 1100px; padding: 0 1.25rem; background: var(--bg-deep); color: var(--text-primary); }
    .card { border: 1px solid var(--border-subtle); border-radius: 12px; padding: 1.25rem; margin: 1rem 0; background: rgba(10, 15, 26, 0.6); }
    .brandbar { display:flex; align-items:center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
    .brand { display:flex; align-items:center; gap: 0.75rem; text-decoration:none; color: inherit; }
    .brand img { height: 32px; width: auto; display:block; }
    .actions { margin-left: auto; display:flex; align-items:center; gap: 0.75rem; }
    a.actionBtn { display:inline-flex; align-items:center; justify-content:center; padding: 0.6rem 0.9rem; border-radius: 999px; border: 1px solid var(--border-accent); background: var(--coral-bright); color: #fff; text-decoration:none; font-weight: 700; }
    a.actionBtn:hover { background: #e63946; }
    h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
    .tagline { color: var(--coral-bright); font-size: 0.95rem; margin-bottom: 1.5rem; }
    label { display:block; margin-top: 0.75rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.6rem; margin-top: 0.25rem; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 8px; color: var(--text-primary); }
    input::placeholder { color: var(--text-muted); }
    button { padding: 0.8rem 1.2rem; border-radius: 10px; border: 0; background: var(--coral-bright); color: #fff; font-weight: 700; cursor: pointer; }
    button:hover { background: #e63946; }
    code { background: var(--bg-elevated); padding: 0.1rem 0.3rem; border-radius: 6px; color: var(--cyan-bright); }
    .muted { color: var(--text-muted); }
    .row { display: flex; gap: 1rem; flex-wrap: wrap; }
    .row > div { flex: 1; min-width: 280px; }
    a { color: var(--cyan-bright); }
    a:hover { color: var(--coral-bright); }
    pre { background: var(--bg-elevated); padding: 1rem; border-radius: 8px; overflow-x: auto; color: var(--text-secondary); }
  </style>
</head>
<body>
  <div class="brandbar">
    <a class="brand" href="https://render.com" target="_blank" rel="noreferrer">
      ${RENDER_LOGO_URL ? `<img src="${RENDER_LOGO_URL}" alt="Render" />` : "<strong>Render</strong>"}
    </a>
    <div class="actions">
      <a class="actionBtn" href="${RENDER_DEPLOY_URL}" target="_blank" rel="noreferrer">Deploy on Render</a>
    </div>
  </div>
  <h1>🦞 Moltbot Installer</h1>
  <p class="tagline">The AI that actually does things. Configure Clawdbot on Render.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status">Loading...</div>
    <div style="margin-top: 0.75rem">
      <a href="/moltbot?token=${MOLTBOT_GATEWAY_TOKEN}" target="_blank" rel="noreferrer">Open Control UI</a>
      &nbsp;|&nbsp;
      <a href="/install/export" target="_blank">Download backup (.tar.gz)</a>
    </div>
  </div>

  <div class="card">
    <h2>1) Model/auth provider</h2>
    <p class="muted">Pick how Moltbot should authenticate to your model provider.</p>
    <label>Provider group</label>
    <select id="authGroup"></select>

    <label>Auth method</label>
    <select id="authChoice"></select>

    <label>Key / Token (if required)</label>
    <input id="authSecret" type="password" placeholder="Paste API key / token (not the gateway token)" />
    <div class="muted" style="margin-top: 0.25rem">
      If you pick a CLI/OAuth method and see “no credentials found”, switch to the API key option for your provider.
    </div>

    <label>Installer flow</label>
    <select id="flow">
      <option value="quickstart">quickstart</option>
      <option value="advanced">advanced</option>
      <option value="manual">manual</option>
    </select>
  </div>

  <div class="card">
    <h2>2) Optional: Channels</h2>
    <p class="muted">You can add channels later. These are just shortcuts if you want bots wired up immediately. WhatsApp, Google Chat, Signal, and more: add via Control UI or <code>moltbot channels add</code> after install.</p>
    <p class="muted" style="margin-top: 0.5rem"><button type="button" id="channelHelpBtn" style="padding: 0.4rem 0.8rem; font-size: 0.85rem; background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 6px; color: var(--cyan-bright); cursor: pointer;">Show channel add --help</button> (writes CLI help to log below)</p>
    <div class="row">
      <div>
        <label>Telegram bot token (optional)</label>
        <input id="telegramToken" type="password" placeholder="123456:ABC..." />
        <div class="muted" style="margin-top: 0.25rem">
          Get it from BotFather: open Telegram, message <code>@BotFather</code>, run <code>/newbot</code>, then copy the token.
        </div>
      </div>
      <div>
        <label>Discord bot token (optional)</label>
        <input id="discordToken" type="password" placeholder="Bot token" />
        <div class="muted" style="margin-top: 0.25rem">
          Discord Developer Portal → create app → add Bot → copy token. Enable <strong>MESSAGE CONTENT INTENT</strong> if required.
        </div>
      </div>
    </div>
    <div class="row">
      <div>
        <label>Slack bot token (optional)</label>
        <input id="slackBotToken" type="password" placeholder="xoxb-..." />
      </div>
      <div>
        <label>Slack app token (optional)</label>
        <input id="slackAppToken" type="password" placeholder="xapp-..." />
      </div>
    </div>
  </div>

  <div class="card">
    <h2>3) Run installer</h2>
    <button id="run">Install / Configure</button>
    <button id="pairingApprove" style="background:#1f2937; margin-left:0.5rem">Approve pairing</button>
    <button id="doctorBtn" style="background:#0f172a; margin-left:0.5rem">Run doctor</button>
    <button id="reset" style="background:#444; margin-left:0.5rem">Reset install</button>
    <pre id="log" style="white-space:pre-wrap"></pre>
    <p class="muted">
      Reset deletes the config file so you can rerun onboarding. Pairing approval lets you grant DM access when <code>dmPolicy=pairing</code>. Doctor runs migrations and config checks.
    </p>
  </div>

  <div class="card">
    <h2>After install — more from Moltbot</h2>
    <p class="muted">Channels, skills, and config you can add after setup:</p>
    <ul style="margin: 0.5rem 0; padding-left: 1.25rem; color: var(--text-secondary);">
      <li><strong>Channels</strong> — WhatsApp, Google Chat, Signal, iMessage, MS Teams, Matrix, and more: use Control UI or <code>moltbot channels add --channel &lt;name&gt;</code>. <a href="https://docs.molt.bot/channels" target="_blank" rel="noreferrer">Channels docs</a></li>
      <li><strong>More model providers</strong> — Cerebras, Groq, xAI, Mistral, etc. are supported via env vars (e.g. <code>CEREBRAS_API_KEY</code>, <code>GROQ_API_KEY</code>) or <code>models.providers</code> in config. Set them in Render Environment or after install. <a href="https://docs.molt.bot/concepts/model-providers" target="_blank" rel="noreferrer">Model providers</a></li>
      <li><strong>Skills</strong> — Install from <a href="https://clawdhub.com" target="_blank" rel="noreferrer">ClawdHub</a> or via the Control UI.</li>
      <li><strong>Doctor</strong> — Run <code>moltbot doctor</code> (or use the Run doctor button above) for migrations and config checks. <a href="https://docs.molt.bot/gateway/doctor" target="_blank" rel="noreferrer">Doctor docs</a></li>
      <li><strong>Configuration</strong> — Full config reference: <a href="https://docs.molt.bot/gateway/configuration" target="_blank" rel="noreferrer">Configuration</a></li>
    </ul>
  </div>

  <div class="card">
    <h2>Backups</h2>
    <p class="muted">Export a backup for migration, or import one to restore state + workspace on this service.</p>
    <form id="importForm">
      <label>Import backup (.tar.gz)</label>
      <input id="importFile" type="file" accept=".tar.gz,application/gzip,application/x-gzip" />
      <div style="margin-top: 0.75rem">
        <button type="submit" style="background:#0f172a">Import backup</button>
      </div>
      <p class="muted">Import only restores <code>.moltbot/</code> and <code>workspace/</code> into your Render disk mount.</p>
    </form>
  </div>

  <script src="/install/app.js"></script>
</body>
</html>`);
});

app.get("/install/api/status", requireInstallAuth, async (_req, res) => {
  const warnings = [];
  const version = await runCmd(MOLTBOT_NODE, moltArgs(["--version"]));

  let moltbotVersion = version.output.trim();
  let moltbotMissing = false;
  if (version.code !== 0) {
    moltbotVersion = "";
    moltbotMissing = true;
    warnings.push("Warning: moltbot CLI did not run successfully (this is expected outside the container build).");
  }

  const channelsHelp = await runCmd(MOLTBOT_NODE, moltArgs(["channels", "add", "--help"]));
  const channelsHelpText = channelsHelp.output || "";

  const authGroups = await getUpstreamAuthGroups();

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    moltbotVersion,
    moltbotMissing,
    channelsAddHelp: channelsHelpText,
    authGroups,
    warnings,
  });
});

app.post("/install/api/run", requireInstallAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({ ok: true, output: "Already installed.\nUse Reset install if you want to rerun onboarding.\n" });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(MOLTBOT_NODE, moltArgs(onboardArgs));

    let extra = "";
    const ok = onboard.code === 0 && isConfigured();

    // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
    if (ok) {
      // Ensure gateway token is written into config so the browser UI can authenticate reliably.
      // (We also enforce loopback bind since the wrapper proxies externally.)
      // Newer Moltbot builds may refuse to start unless gateway.mode is explicit.
      await runCmd(MOLTBOT_NODE, moltArgs(["config", "set", "gateway.mode", "local"]));
      await runCmd(MOLTBOT_NODE, moltArgs(["config", "set", "gateway.auth.mode", "token"]));
      await runCmd(MOLTBOT_NODE, moltArgs(["config", "set", "gateway.auth.token", MOLTBOT_GATEWAY_TOKEN]));
      await runCmd(MOLTBOT_NODE, moltArgs(["config", "set", "gateway.bind", "loopback"]));
      await runCmd(MOLTBOT_NODE, moltArgs(["config", "set", "gateway.port", String(INTERNAL_GATEWAY_PORT)]));
      // Moltbot default is /clawdbot; align with wrapper’s /moltbot path.
      await runCmd(MOLTBOT_NODE, moltArgs(["config", "set", "gateway.controlUi.basePath", "/moltbot"]));

      const channelsHelp = await runCmd(MOLTBOT_NODE, moltArgs(["channels", "add", "--help"]));
      const helpText = channelsHelp.output || "";
      const supports = (name) => helpText.includes(name);

      if (payload.telegramToken?.trim()) {
        if (!supports("telegram")) {
          extra += "\n[telegram] skipped (this moltbot build does not list telegram in `channels add --help`)\n";
        } else {
          const token = payload.telegramToken.trim();
          const cfgObj = {
            enabled: true,
            dmPolicy: "pairing",
            botToken: token,
            groupPolicy: "allowlist",
            streamMode: "partial",
          };
          const set = await runCmd(
            MOLTBOT_NODE,
            moltArgs(["config", "set", "--json", "channels.telegram", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(MOLTBOT_NODE, moltArgs(["config", "get", "channels.telegram"]));
          extra += `\n[telegram config] exit=${set.code}\n${set.output || "(no output)"}`;
          extra += `\n[telegram verify] exit=${get.code}\n${get.output || "(no output)"}`;
        }
      }

      if (payload.discordToken?.trim()) {
        if (!supports("discord")) {
          extra += "\n[discord] skipped (this moltbot build does not list discord in `channels add --help`)\n";
        } else {
          const token = payload.discordToken.trim();
          const cfgObj = {
            enabled: true,
            token,
            groupPolicy: "allowlist",
            dm: { policy: "pairing" },
          };
          const set = await runCmd(
            MOLTBOT_NODE,
            moltArgs(["config", "set", "--json", "channels.discord", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(MOLTBOT_NODE, moltArgs(["config", "get", "channels.discord"]));
          extra += `\n[discord config] exit=${set.code}\n${set.output || "(no output)"}`;
          extra += `\n[discord verify] exit=${get.code}\n${get.output || "(no output)"}`;
        }
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        if (!supports("slack")) {
          extra += "\n[slack] skipped (this moltbot build does not list slack in `channels add --help`)\n";
        } else {
          const cfgObj = {
            enabled: true,
            botToken: payload.slackBotToken?.trim() || undefined,
            appToken: payload.slackAppToken?.trim() || undefined,
          };
          const set = await runCmd(
            MOLTBOT_NODE,
            moltArgs(["config", "set", "--json", "channels.slack", JSON.stringify(cfgObj)]),
          );
          const get = await runCmd(MOLTBOT_NODE, moltArgs(["config", "get", "channels.slack"]));
          extra += `\n[slack config] exit=${set.code}\n${set.output || "(no output)"}`;
          extra += `\n[slack verify] exit=${get.code}\n${get.output || "(no output)"}`;
        }
      }

      await restartGateway();
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/install/api/run] error:", err);
    return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.post("/install/api/doctor", requireInstallAuth, async (_req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({ ok: false, output: "Not installed. Run the installer first." });
  }
  const r = await runCmd(MOLTBOT_NODE, moltArgs(["doctor", "--non-interactive"]));
  return res.status(r.code === 0 ? 200 : 200).json({ ok: r.code === 0, output: r.output || "" });
});

app.post("/install/api/pairing/approve", requireInstallAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) return res.status(400).json({ ok: false, error: "Missing channel or code" });
  const r = await runCmd(MOLTBOT_NODE, moltArgs(["pairing", "approve", String(channel), String(code)]));
  return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
});

app.post("/install/api/reset", requireInstallAuth, async (_req, res) => {
  try {
    fs.rmSync(configPath(), { force: true });
    res.type("text/plain").send("OK - deleted config file. You can rerun install now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/install/export", requireInstallAuth, async (_req, res) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="render-moltbot-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from /data so archives are easy to restore on Render.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const underData = (p) => p === DATA_MOUNT || p.startsWith(DATA_MOUNT + path.sep);
  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = DATA_MOUNT;
    paths = [path.relative(DATA_MOUNT, stateAbs) || ".", path.relative(DATA_MOUNT, workspaceAbs) || "."];
  }

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

app.post("/install/api/import", requireInstallAuth, async (req, res) => {
  if (!HAS_RENDER_DISK) {
    return res.status(400).type("text/plain").send("Import requires a persistent disk mounted at /data.");
  }

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 250 * 1024 * 1024 } });

  const tmpDir = path.join(os.tmpdir(), "render-moltbot");
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `backup-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.tar.gz`);

  let sawFile = false;
  let writeError = null;

  bb.on("file", (_name, file, info) => {
    const filename = info?.filename || "backup.tar.gz";
    if (!filename) return;
    sawFile = true;
    const out = fs.createWriteStream(tmpFile, { mode: 0o600 });
    file.pipe(out);
    out.on("error", (e) => {
      writeError = e;
      try {
        file.unpipe(out);
        file.resume();
      } catch {
        // ignore
      }
    });
  });

  bb.on("error", (err) => {
    writeError = err;
  });

  bb.on("finish", async () => {
    try {
      if (!sawFile) return res.status(400).type("text/plain").send("No file uploaded. Use form field name 'backup'.");
      if (writeError) return res.status(500).type("text/plain").send(`Upload failed: ${String(writeError)}`);

      await tar.x({
        file: tmpFile,
        cwd: DATA_MOUNT,
        strict: true,
        onwarn: () => {},
        filter: (p) => canRestoreFromTarPath(p),
      });

      // Apply immediately.
      if (isConfigured()) await restartGateway();
      return res.type("text/plain").send("OK - imported backup into /data (.moltbot + workspace).");
    } catch (err) {
      console.error("[import]", err);
      return res.status(500).type("text/plain").send(`Import failed: ${String(err)}`);
    } finally {
      try {
        fs.rmSync(tmpFile, { force: true });
      } catch {
        // ignore
      }
    }
  });

  req.pipe(bb);
});

function landingHtml() {
  const installed = isConfigured();
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Moltbot on Render — The AI that actually does things</title>
  <meta name="description" content="Moltbot — The AI that actually does things. Deploy Clawdbot on Render with installer and Control UI." />
  <style>
    :root {
      --bg-deep: #050810;
      --bg-surface: #0a0f1a;
      --bg-elevated: #111827;
      --coral-bright: #ff4d4d;
      --cyan-bright: #00e5cc;
      --text-primary: #f0f4ff;
      --text-secondary: #8892b0;
      --text-muted: #5a6480;
      --border-subtle: rgba(136, 146, 176, 0.15);
      --border-accent: rgba(255, 77, 77, 0.3);
    }
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 2rem auto; max-width: 1100px; padding: 0 1.25rem; background: var(--bg-deep); color: var(--text-primary); }
    .card { border: 1px solid var(--border-subtle); border-radius: 12px; padding: 1.25rem; margin: 1rem 0; background: rgba(10, 15, 26, 0.6); }
    a.button { display: inline-block; padding: 0.8rem 1.2rem; border-radius: 10px; background: var(--coral-bright); color: #fff; text-decoration: none; font-weight: 700; margin-right: 0.5rem; }
    a.button:hover { background: #e63946; }
    .muted { color: var(--text-muted); }
    code { background: var(--bg-elevated); padding: 0.1rem 0.3rem; border-radius: 6px; color: var(--cyan-bright); }
    .brandbar { display:flex; align-items:center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
    .brand { display:flex; align-items:center; gap: 0.75rem; text-decoration:none; color: inherit; }
    .brand img { height: 32px; width: auto; display:block; }
    .actions { margin-left: auto; display:flex; align-items:center; gap: 0.75rem; }
    a.actionBtn { display:inline-flex; align-items:center; justify-content:center; padding: 0.6rem 0.9rem; border-radius: 999px; border: 1px solid var(--border-accent); background: var(--coral-bright); color:#fff; text-decoration:none; font-weight:700; }
    a.actionBtn:hover { background: #e63946; }
    .tagline { color: var(--coral-bright); font-size: 1rem; margin-bottom: 1rem; }
    .links { margin-top: 1rem; font-size: 0.9rem; }
    .links a { color: var(--cyan-bright); }
    .links a:hover { color: var(--coral-bright); }
  </style>
</head>
<body>
  <div class="brandbar">
    <a class="brand" href="https://render.com" target="_blank" rel="noreferrer">
      ${RENDER_LOGO_URL ? `<img src="${RENDER_LOGO_URL}" alt="Render" />` : "<strong>Render</strong>"}
    </a>
    <div class="actions">
      <a class="actionBtn" href="${RENDER_DEPLOY_URL}" target="_blank" rel="noreferrer">Deploy on Render</a>
    </div>
  </div>
  <h1>🦞 Moltbot on Render</h1>
  <p class="tagline">The AI that actually does things. Deploy Clawdbot with a built-in installer and Control UI.</p>
  <div class="card">
    <p class="muted">Wrapper status: <strong>${installed ? "installed" : "not installed"}</strong></p>
    <p class="muted">State dir: <code>${STATE_DIR}</code><br/>Workspace dir: <code>${WORKSPACE_DIR}</code></p>
    <p>
      ${
        installed
          ? `<a class="button" href="/moltbot?token=${MOLTBOT_GATEWAY_TOKEN}" rel="noreferrer">Open Control UI</a>`
          : `<a class="button" href="/install">Open Installer</a>`
      }
    </p>
    <p class="muted">If you just deployed, go to <code>/install</code> first.</p>
    <div class="links">
      <a href="https://docs.clawd.bot" target="_blank" rel="noreferrer">Docs</a> · <a href="https://discord.gg/clawd" target="_blank" rel="noreferrer">Discord</a> · <a href="https://github.com/moltbot/moltbot" target="_blank" rel="noreferrer">GitHub</a>
    </div>
  </div>
</body>
</html>`;
}

// Proxy everything else to the gateway if installed; otherwise show a landing page.
// IMPORTANT: Do not forward proxy headers to the internal gateway.
// The gateway is loopback-only and already protected by token auth; forwarding headers can make
// localhost clients look "remote behind an untrusted proxy", which triggers pairing/insecure-context
// friction for Control UI.
const STRIP_PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-server",
  "x-forwarded-ssl",
  "x-real-ip",
  "x-client-ip",
  "cf-connecting-ip",
  "true-client-ip",
];

function stripProxyHeaders(req) {
  // Node normalizes incoming header keys to lowercase in `req.headers`.
  for (const h of STRIP_PROXY_HEADERS) {
    if (h in req.headers) delete req.headers[h];
  }
}

const proxy = httpProxy.createProxyServer({ target: GATEWAY_TARGET, ws: true, xfwd: false });
proxy.on("error", (err, _req, _res) => console.error("[proxy]", err));

// WebSocket connections can be long-lived. Some hosting stacks may drop "idle" TCP connections.
// Keep sockets alive and disable timeouts to reduce unexpected disconnects.
const WS_KEEPALIVE_MS = Number.parseInt(process.env.WS_KEEPALIVE_MS ?? "30000", 10);
const WS_PING_INTERVAL_MS = Number.parseInt(process.env.WS_PING_INTERVAL_MS ?? "25000", 10);

function hardenSocketForWs(sock) {
  try {
    // Disable inactivity timeout (Node defaults can close idle sockets).
    sock.setTimeout(0);
    // Lower latency; helps with small WS frames.
    sock.setNoDelay(true);
    // Enable TCP keepalive probes.
    sock.setKeepAlive(true, WS_KEEPALIVE_MS);
  } catch {
    // ignore
  }
}

proxy.on("open", (proxySocket) => {
  hardenSocketForWs(proxySocket);
});

function parseWsProtocols(req) {
  const raw = req.headers["sec-websocket-protocol"];
  if (!raw) return undefined;
  const s = Array.isArray(raw) ? raw.join(",") : String(raw);
  const parts = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function buildUpstreamWsHeaders(req) {
  const headers = { ...req.headers };
  // Do not forward proxy headers (Render/CDNs) to the internal gateway.
  for (const h of STRIP_PROXY_HEADERS) delete headers[h];

  // Hop-by-hop / WebSocket handshake headers should be generated by the WS client.
  delete headers.connection;
  delete headers.upgrade;
  delete headers["sec-websocket-key"];
  delete headers["sec-websocket-version"];
  delete headers["sec-websocket-extensions"];

  // Ensure the internal gateway sees an internal host.
  headers.host = `${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;
  return headers;
}

function startWsPing(ws) {
  if (!WS_PING_INTERVAL_MS || WS_PING_INTERVAL_MS <= 0) return null;
  const t = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }, WS_PING_INTERVAL_MS);
  // Don't keep the process alive just for the ping timer.
  t.unref?.();
  return t;
}

function safeClearInterval(t) {
  if (!t) return;
  try {
    clearInterval(t);
  } catch {
    // ignore
  }
}

function isHtmlRequest(req) {
  const accept = String(req.headers.accept || "").toLowerCase();
  // Browsers typically send Accept including text/html for navigations.
  return accept.includes("text/html") || accept.includes("application/xhtml+xml") || accept === "";
}

function buildTokenizedDashboardUrl(req) {
  const u = new URL(`http://_/${req.originalUrl.replace(/^\//, "")}`);
  // Always send users to the dashboard route.
  u.pathname = "/moltbot";
  u.searchParams.set("token", MOLTBOT_GATEWAY_TOKEN);
  return u.pathname + u.search;
}

app.use(async (req, res) => {
  if (!isConfigured()) {
    // Allow installer routes; everything else shows a landing page.
    if (req.path.startsWith("/install") || req.path === "/healthz") return res.status(404).type("text/plain").send("Not Found");
    return res.status(200).type("html").send(landingHtml());
  }

  try {
    await ensureGatewayRunning();
  } catch (err) {
    return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
  }

  // Render (and other CDNs/proxies) add X-Forwarded-* headers. Do NOT send them to the internal
  // gateway; it runs loopback-only and should treat clients as local.
  stripProxyHeaders(req);

  // If user hits the UI without the right token, redirect to the correct tokenized URL.
  // This prevents "token_mismatch" loops caused by stale/wrong tokens in the browser.
  if ((req.path === "/" || req.path === "/moltbot") && isHtmlRequest(req)) {
    const provided = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!provided || provided !== MOLTBOT_GATEWAY_TOKEN) {
      return res.redirect(302, buildTokenizedDashboardUrl(req));
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[wrapper] listening on :${PORT}`);
  console.log(`[wrapper] state dir: ${STATE_DIR}`);
  console.log(`[wrapper] workspace dir: ${WORKSPACE_DIR}`);
  console.log(`[wrapper] gateway token: ${MOLTBOT_GATEWAY_TOKEN ? "(set)" : "(missing)"}`);
  console.log(`[wrapper] gateway target: ${GATEWAY_TARGET}`);
  if (!SETUP_PASSWORD) console.warn("[wrapper] WARNING: RENDER_SETUP_PASSWORD is not set; /install will error.");
});

const wsServer = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) return void socket.destroy();
  try {
    await ensureGatewayRunning();
  } catch {
    return void socket.destroy();
  }
  hardenSocketForWs(socket);

  // Use an explicit WS bridge so we can send ping frames to keep Render/proxies from
  // terminating idle connections (which shows up as code 1006 in browsers).
  wsServer.handleUpgrade(req, socket, head, (clientWs) => {
    const protocols = parseWsProtocols(req);
    const upstreamUrl = `ws://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}${req.url || "/"}`;
    const upstreamWs = new WebSocket(upstreamUrl, protocols, {
      headers: buildUpstreamWsHeaders(req),
      perMessageDeflate: false,
    });

    // Best-effort hardening for both sides.
    clientWs.on("error", () => {});
    upstreamWs.on("error", (err) => console.error("[ws-proxy]", err));

    const clientPing = startWsPing(clientWs);
    const upstreamPing = startWsPing(upstreamWs);

    const shutdown = (who, code, reason) => {
      safeClearInterval(clientPing);
      safeClearInterval(upstreamPing);

      try {
        if (who !== "client" && clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
      } catch {
        try {
          clientWs.terminate();
        } catch {
          // ignore
        }
      }

      try {
        if (who !== "upstream" && upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close(code, reason);
      } catch {
        try {
          upstreamWs.terminate();
        } catch {
          // ignore
        }
      }
    };

    clientWs.on("close", (code, reason) => shutdown("client", code, reason));
    upstreamWs.on("close", (code, reason) => shutdown("upstream", code, reason));

    clientWs.on("message", (data, isBinary) => {
      if (upstreamWs.readyState !== WebSocket.OPEN) return;
      try {
        upstreamWs.send(data, { binary: isBinary });
      } catch {
        // ignore
      }
    });

    upstreamWs.on("message", (data, isBinary) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;
      try {
        clientWs.send(data, { binary: isBinary });
      } catch {
        // ignore
      }
    });

    upstreamWs.on("open", () => {
      // ws exposes the underlying net.Socket as `_socket` (best-effort).
      hardenSocketForWs(upstreamWs._socket);
    });
  });
});

process.on("SIGTERM", () => {
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});

