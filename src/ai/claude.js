// Claude-Anbindung mit zwei Abrechnungswegen:
//  • subscription (Standard): Claude Code im Headless-Modus (`claude -p`) mit dem Token aus `claude setup-token`.
//    Jede Anfrage zählt gegen die Nutzungslimits des Claude-Max-Abos – keine Abrechnung pro Token, kein API-Key.
//  • api: offizielles Anthropic-SDK mit ANTHROPIC_API_KEY (Abrechnung pro Token).
// Dazu ein eigenes Tageslimit und eine Pause, sobald das Abo-Limit erreicht ist (statt Fehlern oder Ausweichen auf die API).
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { q } from "../db.js";
import { getSettings } from "../settings.js";
import { dayKey, startOfDay, DAY_MS } from "../lib/time.js";

export class AiError extends Error {}
export class AiLimitError extends AiError {
  constructor(message, retryAt) {
    super(message);
    this.retryAt = retryAt;
  }
}

let client = null;
let fallbacksSupported = true;
let testMode = false;
let clientFactory = defaultFactory;
function defaultFactory() { return new Anthropic({ apiKey: config.anthropicKey, maxRetries: 3, timeout: 600000, ...(config.anthropicWorkspace ? { defaultHeaders: { "anthropic-workspace-id": config.anthropicWorkspace } } : {}) }); }
const usage = { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, errors: 0, last_error: null };

// Für Tests: eigener API-Client (Modus "api").
export function setAiClientFactory(fn) {
  client = null;
  fallbacksSupported = true;
  clientFactory = fn || defaultFactory;
  testMode = !!fn;
}

export function aiProvider() {
  if (testMode) return "api";
  if (config.aiProvider === "subscription" && config.claudeOauthToken) return "subscription";
  if (config.aiProvider === "api" && config.anthropicKey) return "api";
  return "";
}

export function aiAvailable() {
  return !!aiProvider();
}

function tz() {
  return getSettings().timezone || config.defaultTimezone;
}

function budgetRow(now = Date.now()) {
  const day = dayKey(now, tz());
  return q.get("SELECT * FROM ai_jobs_usage WHERE day = ?", day) || { day, requests: 0, blocked_until: null };
}

export function aiUsage() {
  const now = Date.now();
  const row = budgetRow(now);
  const pausedUntil = q.value("SELECT MAX(blocked_until) FROM ai_jobs_usage") || null;
  return {
    ...usage,
    provider: aiProvider(),
    model: config.aiModel,
    today: row.requests,
    daily_limit: Number(getSettings().ai_daily_limit) || 0,
    paused_until: pausedUntil && pausedUntil > now ? pausedUntil : null
  };
}

// Vor jeder Anfrage: eigenes Tageslimit und Abo-Pause prüfen.
export function checkBudget(now = Date.now()) {
  const paused = q.value("SELECT MAX(blocked_until) FROM ai_jobs_usage");
  if (paused && paused > now) throw new AiLimitError("KI pausiert: Nutzungslimit des Abos erreicht.", paused);
  const limit = Number(getSettings().ai_daily_limit) || 0;
  const row = budgetRow(now);
  if (limit > 0 && row.requests >= limit) {
    throw new AiLimitError(`KI-Tageslimit (${limit} Anfragen) erreicht – geht morgen weiter.`, startOfDay(now, tz()) + DAY_MS + 5 * 60 * 1000);
  }
}

function countRequest(now = Date.now()) {
  q.run("INSERT INTO ai_jobs_usage (day, requests) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET requests = requests + 1", dayKey(now, tz()));
}

export function pauseAi(until) {
  const day = dayKey(Date.now(), tz());
  q.run("INSERT INTO ai_jobs_usage (day, requests, blocked_until) VALUES (?, 0, ?) ON CONFLICT(day) DO UPDATE SET blocked_until = excluded.blocked_until", day, until);
}

export function resumeAi() {
  q.run("UPDATE ai_jobs_usage SET blocked_until = NULL");
}

function supportsEffort(model) {
  return !/haiku|sonnet-4-5|sonnet-4-0|opus-4-1|opus-4-0|3-/.test(model);
}

function describeApiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "API-Schlüssel ungültig oder abgelaufen.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Keine Berechtigung für dieses Modell.";
  if (err instanceof Anthropic.RateLimitError) return "Rate-Limit der KI erreicht – bitte später erneut versuchen.";
  if (err instanceof Anthropic.BadRequestError) return `Ungültige KI-Anfrage: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Keine Verbindung zur KI.";
  if (err instanceof Anthropic.APIError) return `KI-Fehler (${err.status}): ${err.message}`;
  return err.message || "Unbekannter KI-Fehler";
}

// ---------- Weg 1: Max-Abo über Claude Code (headless) ----------

// Bekannte Limit-Meldungen von Claude Code ("Claude AI usage limit reached|<epoch>", "You've hit your limit · resets 3pm" …).
const LIMIT_RE = /(usage limit|limit reached|hit your (usage )?limit|rate[ _-]?limit|out of (extra )?usage|resets? (at|in|\d))/i;
const AUTH_RE = /(invalid api key|oauth|authenticat|unauthori[sz]ed|token (has )?expired|please run \/login|not logged in|credit balance)/i;

function retryAtFrom(text) {
  const epoch = /\|(\d{10,13})\b/.exec(String(text || ""));
  if (epoch) {
    const n = Number(epoch[1]);
    return n < 1e12 ? n * 1000 : n;
  }
  return Date.now() + 60 * 60 * 1000;
}

function runProcess(bin, args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill("SIGINT"); setTimeout(() => child.kill("SIGKILL"), 5000).unref(); }, timeoutMs);
    child.stdout.on("data", d => { stdout += d; if (stdout.length > 20 * 1024 * 1024) child.kill("SIGKILL"); });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function parseResult(stdout) {
  const text = String(stdout || "").trim();
  try { return JSON.parse(text); } catch { /* evtl. mehrere Zeilen */ }
  const lines = text.split("\n").reverse();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.type === "result") return obj;
    } catch { /* weiter */ }
  }
  return null;
}

async function callViaSubscription({ systemText, content, schema, effort }) {
  const dir = await mkdtemp(join(tmpdir(), "coldmail-ai-"));
  try {
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
    const files = [];
    let prompt = "";
    for (const b of blocks) {
      if (b.type === "text") prompt += `${b.text}\n\n`;
      else if (b.type === "document" && b.source?.type === "base64") {
        const name = `dokument-${files.length + 1}.pdf`;
        await writeFile(join(dir, name), Buffer.from(b.source.data, "base64"));
        files.push({ name, title: b.title || name });
      }
    }
    if (files.length) prompt = `Lies zuerst diese PDF-Dateien im aktuellen Ordner vollständig mit dem Read-Werkzeug: ${files.map(f => `${f.name} („${f.title}“)`).join(", ")}.\n\n${prompt}`;
    await writeFile(join(dir, "system.txt"), systemText);
    const args = [
      "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
      "--model", config.aiModel, "--system-prompt-file", join(dir, "system.txt"),
      "--tools", files.length ? "Read" : "", "--permission-mode", "dontAsk",
      "--max-turns", String(files.length ? 6 + files.length * 2 : 3),
      "--no-session-persistence", "--disable-slash-commands", "--strict-mcp-config"
    ];
    if (files.length) args.push("--allowedTools", "Read");
    if (effort && supportsEffort(config.aiModel)) args.push("--effort", effort);
    // Eigene, leere Claude-Umgebung; KEIN API-Key → Abrechnung ausschließlich über das Abo.
    const home = join(config.dataDir, "claude-home");
    await mkdir(home, { recursive: true });
    const env = {
      PATH: process.env.PATH, HOME: home, LANG: "C.UTF-8",
      CLAUDE_CODE_OAUTH_TOKEN: config.claudeOauthToken,
      DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
    };
    if (process.env.USE_BUILTIN_RIPGREP) env.USE_BUILTIN_RIPGREP = process.env.USE_BUILTIN_RIPGREP;
    if (process.env.HTTPS_PROXY) env.HTTPS_PROXY = process.env.HTTPS_PROXY;
    if (process.env.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS;
    let out;
    try {
      out = await runProcess(config.claudeBin, args, { cwd: dir, env, input: prompt, timeoutMs: config.aiTimeoutMs });
    } catch (err) {
      if (err.code === "ENOENT") throw new AiError("Claude Code ist auf dem Server nicht installiert (Befehl „claude“ fehlt).");
      throw new AiError(`Claude Code konnte nicht gestartet werden: ${err.message}`);
    }
    const res = parseResult(out.stdout);
    const message = String(res?.result || out.stderr || out.stdout || "").slice(0, 500);
    if (!res || res.is_error || (res.subtype && res.subtype !== "success")) {
      if (LIMIT_RE.test(message)) throw new AiLimitError("Nutzungslimit des Claude-Abos erreicht – KI pausiert bis zum Reset.", retryAtFrom(message));
      if (AUTH_RE.test(message)) throw new AiError("Claude-Abo-Anmeldung fehlgeschlagen – CLAUDE_CODE_OAUTH_TOKEN neu mit `claude setup-token` erzeugen.");
      throw new AiError(`Claude Code: ${message || `Exit-Code ${out.code}`}`);
    }
    for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) usage[k] += Number(res.usage?.[k]) || 0;
    if (res.structured_output && typeof res.structured_output === "object") return res.structured_output;
    try {
      return JSON.parse(res.result);
    } catch {
      throw new AiError("Die KI-Antwort war kein gültiges JSON.");
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------- Weg 2: Anthropic-API (pro Token) ----------

async function callViaApi({ systemBlocks, content, schema, maxTokens, effort }) {
  if (!client) client = clientFactory();
  const outputConfig = { format: { type: "json_schema", schema } };
  if (supportsEffort(config.aiModel)) outputConfig.effort = effort;
  const base = { model: config.aiModel, max_tokens: maxTokens, system: systemBlocks, messages: [{ role: "user", content }], output_config: outputConfig };
  // Streaming + finalMessage(): keine HTTP-Timeouts bei langen Eingaben (PDF-Wissen) oder langen Antworten.
  let res;
  try {
    if (config.aiFallbacks && fallbacksSupported) {
      try {
        res = await client.beta.messages.stream({ ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }).finalMessage();
      } catch (err) {
        if (!(err instanceof Anthropic.BadRequestError)) throw err;
        res = await client.messages.stream(base).finalMessage();
        fallbacksSupported = false;
      }
    } else {
      res = await client.messages.stream(base).finalMessage();
    }
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError && err.error?.error?.details?.error_code === "enforced_spend_limit_reached") {
      throw new AiLimitError("Ausgabenlimit der API erreicht – KI pausiert.", Date.now() + 6 * 60 * 60 * 1000);
    }
    throw new AiError(describeApiError(err));
  }
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) usage[k] += Number(res.usage?.[k]) || 0;
  if (res.stop_reason === "refusal") throw new AiError("Die KI hat diese Anfrage abgelehnt.");
  if (res.stop_reason === "max_tokens") throw new AiError("Die KI-Antwort wurde abgeschnitten (zu lang).");
  const text = (res.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError("Die KI-Antwort war kein gültiges JSON.");
  }
}

// system: Liste stabiler Textblöcke, content: Nutzerinhalt (String oder Blöcke inkl. PDF-Dokumente).
export async function callJson({ system, content, schema, maxTokens = 4096, effort = "low" }) {
  const provider = aiProvider();
  if (!provider) throw new AiError("KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN für das Max-Abo oder ANTHROPIC_API_KEY setzen).");
  checkBudget();
  countRequest();
  usage.requests++;
  const parts = (Array.isArray(system) ? system : [system]).filter(Boolean);
  try {
    if (provider === "subscription") return await callViaSubscription({ systemText: parts.join("\n\n"), content, schema, effort });
    const systemBlocks = parts.map(text => ({ type: "text", text }));
    if (systemBlocks.length) systemBlocks[systemBlocks.length - 1].cache_control = { type: "ephemeral" };
    return await callViaApi({ systemBlocks, content, schema, maxTokens, effort });
  } catch (err) {
    usage.errors++;
    usage.last_error = err.message;
    if (err instanceof AiLimitError) pauseAi(err.retryAt);
    throw err;
  }
}
