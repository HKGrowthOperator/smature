// KI über das Claude-Max-Abo: Claude Code headless (`claude -p`) mit OAuth-Token – nie mit API-Key.
// Ein Test-Doppel (tests/fixtures/fake-claude.mjs) ersetzt den echten Befehl.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupDb, makeMailbox, makeLead, makeCampaign, enroll, fakeTransport } from "./helpers.js";
import { q, insert } from "../src/db.js";
import { config } from "../src/config.js";
import { saveSettings } from "../src/settings.js";
import { aiProvider, aiUsage, resumeAi, AiLimitError, callJson } from "../src/ai/claude.js";
import { distillKnowledge, qualifyLead } from "../src/ai/features.js";
import { tick } from "../src/engine/scheduler.js";
import { setTransportFactory } from "../src/mail/transport.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.mjs");
let cleanup;
const home = () => join(config.dataDir, "claude-home");
const calls = () => (existsSync(join(home(), "calls.jsonl")) ? readFileSync(join(home(), "calls.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
const respond = r => writeFileSync(join(home(), "next-response.json"), JSON.stringify(r));

before(() => {
  cleanup = setupDb({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-test-token", CLAUDE_BIN: FAKE, ANTHROPIC_API_KEY: "sk-ant-api03-darf-nicht-raus", AI_PROVIDER: "" });
  mkdirSync(home(), { recursive: true });
});
after(() => { setTransportFactory(null); cleanup(); });
beforeEach(() => {
  resumeAi();
  saveSettings({ ai_daily_limit: 300 });
  for (const f of ["calls.jsonl", "next-response.json"]) rmSync(join(home(), f), { force: true });
});

const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

test("Mit Token läuft die KI über das Abo: richtige Argumente, OAuth-Token, kein API-Key in der Umgebung", async () => {
  assert.equal(aiProvider(), "subscription");
  respond({ structured_output: { ok: true } });
  const res = await callJson({ system: ["Regel 1", "Regel 2"], content: "Bitte prüfen", schema, effort: "low" });
  assert.deepEqual(res, { ok: true });
  const call = calls().at(-1);
  assert.equal(call.oauth, "sk-ant-oat01-test-token");
  assert.ok(!call.env.includes("ANTHROPIC_API_KEY"), "API-Key wird nie an Claude Code gegeben");
  assert.ok(!call.env.includes("ANTHROPIC_AUTH_TOKEN"));
  const a = call.args;
  assert.equal(a[0], "-p");
  assert.equal(a[a.indexOf("--output-format") + 1], "json");
  assert.deepEqual(JSON.parse(a[a.indexOf("--json-schema") + 1]), schema);
  assert.equal(a[a.indexOf("--model") + 1], "claude-opus-5-5");
  assert.equal(a[a.indexOf("--tools") + 1], "", "ohne Dokumente keine Werkzeuge");
  assert.ok(a.includes("--no-session-persistence") && a.includes("--strict-mcp-config") && a.includes("--disable-slash-commands"));
  assert.ok(!a.includes("--bare"), "--bare würde den OAuth-Token ignorieren");
  assert.equal(a[a.indexOf("--effort") + 1], "low");
  assert.match(call.system, /Regel 1\n\nRegel 2/);
  assert.match(call.stdin, /Bitte prüfen/);
});

test("PDF-Wissen: Datei liegt im Arbeitsordner, nur Lese-Werkzeug erlaubt, Ergebnis landet im Produkt", async () => {
  const now = Date.now();
  const pid = insert("products", { name: "Website-Paket", description: "Websites für Handwerker", created_at: now, updated_at: now });
  const pdf = Buffer.from("%PDF-1.4\n%%EOF");
  insert("knowledge_docs", { product_id: pid, title: "Preisblatt", kind: "pdf", data: pdf, size: pdf.length, created_at: now });
  respond({ structured_output: { profile_markdown: "## Was das Produkt ist\n- Website in 14 Tagen", suggested_tone: "Sie", suggested_cta: "Telefonat" } });
  await distillKnowledge("product", pid);
  const call = calls().at(-1);
  assert.ok(call.files.includes("dokument-1.pdf"));
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "Read");
  assert.equal(call.args[call.args.indexOf("--allowedTools") + 1], "Read");
  assert.match(call.stdin, /dokument-1\.pdf/);
  assert.match(q.get("SELECT profile FROM products WHERE id = ?", pid).profile, /14 Tagen/);
  assert.ok(!existsSync(call.cwd), "Arbeitsordner wird aufgeräumt");
});

test("Abo-Limit erreicht → KI pausiert bis zum Reset, Versand wartet ohne Fehlversuch", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  respond({ is_error: true, result: `Claude AI usage limit reached|${reset}` });
  await assert.rejects(callJson({ system: ["x"], content: "y", schema }), err => err instanceof AiLimitError && err.retryAt === reset * 1000);
  assert.equal(aiUsage().paused_until, reset * 1000);
  const before = calls().length;
  await assert.rejects(callJson({ system: ["x"], content: "y", schema }), AiLimitError);
  assert.equal(calls().length, before, "während der Pause keine weiteren Aufrufe");

  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const cid = makeCampaign({ mailboxIds: [makeMailbox()], ai_mode: "first_line" });
  const cl = enroll(cid, makeLead({ email: "inhaber@dachbau-test.de" }));
  await tick();
  const row = q.get("SELECT * FROM campaign_leads WHERE id = ?", cl);
  assert.equal(ft.sent.length, 0);
  assert.equal(row.ai_attempts || 0, 0, "Limit zählt nicht als KI-Fehler");
  assert.ok(row.next_at >= reset * 1000 - 1000, "wartet bis zum Reset");
  assert.match(row.last_error, /Nutzungslimit/);
  resumeAi();
  assert.equal(aiUsage().paused_until, null);
});

test("Eigenes Tageslimit schützt das Abo-Kontingent; Qualitätsprüfung speichert Passung und Anlass", async () => {
  saveSettings({ ai_daily_limit: aiUsage().today + 1 });
  const now = Date.now();
  const pid = insert("products", { name: "SEO", icp: "Handwerksbetriebe 5–50 MA", created_at: now, updated_at: now });
  const lead = q.get("SELECT * FROM leads WHERE id = ?", makeLead({ email: "info@tischlerei-test.de", company: "Tischlerei Holz", reason: "" }));
  respond({ structured_output: { fit: "A", reason: "Tischlerei mit 12 MA, Website ohne Online-Anfrage." } });
  const res = await qualifyLead(lead, q.get("SELECT * FROM products WHERE id = ?", pid), { research: "Tischlerei Holz – seit 1990" });
  assert.deepEqual(res, { fit: "A", reason: "Tischlerei mit 12 MA, Website ohne Online-Anfrage." });
  assert.equal(q.get("SELECT fit FROM lead_fit WHERE lead_id = ? AND product_id = ?", lead.id, pid).fit, "A");
  assert.match(q.get("SELECT reason FROM leads WHERE id = ?", lead.id).reason, /12 MA/, "Anlass wird am Lead dokumentiert");
  await assert.rejects(qualifyLead(lead, q.get("SELECT * FROM products WHERE id = ?", pid), { research: "" }), /Tageslimit/);
});

test("Ungültiger Token und fehlender Befehl geben verständliche Fehler", async () => {
  respond({ is_error: true, result: "Invalid API key · Please run /login" });
  await assert.rejects(callJson({ system: ["x"], content: "y", schema }), /setup-token/);
  const old = config.claudeBin;
  config.claudeBin = "/nicht/vorhanden/claude";
  try {
    await assert.rejects(callJson({ system: ["x"], content: "y", schema }), /nicht installiert/);
  } finally {
    config.claudeBin = old;
  }
});
