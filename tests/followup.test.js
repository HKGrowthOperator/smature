// Nachfassen bei Interesse, Anrufliste/Aufgaben und Termin-Webhook – über Engine und HTTP-API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { setupDb, makeMailbox, makeLead, makeCampaign, enroll, fakeTransport } from "./helpers.js";
import { createApp } from "../src/app.js";
import { ensureAdmin } from "../src/auth.js";
import { q, insert } from "../src/db.js";
import { saveSettings, getSettings } from "../src/settings.js";
import { tick } from "../src/engine/scheduler.js";
import { processInbound } from "../src/mail/inbound.js";
import { onLabel } from "../src/ai/features.js";
import { setTransportFactory } from "../src/mail/transport.js";
import { setWebhookFetch } from "../src/events.js";
import { DAY_MS } from "../src/lib/time.js";

let cleanup, server, base, api, ft;
const hooks = [];

before(async () => {
  cleanup = setupDb({ ADMIN_EMAIL: "admin@test.de", ADMIN_PASSWORD: "ein-langes-passwort" });
  ensureAdmin();
  saveSettings({
    footer_text: "Musterfirma GmbH · Musterstadt · Datenschutz: {{privacy_url}}", privacy_url: "https://hk.example/datenschutz",
    nurture_window_start: "00:00", nurture_window_end: "23:59", nurture_weekdays: "1,2,3,4,5,6,7",
    webhook_url: "https://hooks.example/coldmail", webhook_events: ["lead.meeting", "task.created"]
  });
  setWebhookFetch(async (url, opts) => { hooks.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; });
  ft = fakeTransport(); setTransportFactory(ft.factory);
  server = createApp();
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@test.de", password: "ein-langes-passwort" }) });
  const session = { cookie: (res.headers.get("set-cookie") || "").split(";")[0], csrf: (await res.json()).csrf };
  api = async (path, { method = "GET", body } = {}) => {
    const r = await fetch(base + path, { method, headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text };
  };
});
after(async () => { setTransportFactory(null); setWebhookFetch(null); await new Promise(r => server.close(r)); cleanup(); });

const reset = () => q.run("UPDATE mailboxes SET next_send_at = 0");

async function setup({ mode = "auto", max = 2, callAfter = 0, steps } = {}) {
  const now = Date.now();
  const pid = insert("products", { name: "Website-Paket", booking_url: "https://cal.example/website", kit_url: "https://hk.example/kit.pdf", kit_label: "Preisliste", created_at: now, updated_at: now });
  const mb = makeMailbox();
  const cid = makeCampaign({
    mailboxIds: [mb], product_id: pid, nurture_mode: mode, nurture_max: max, nurture_days: 3, call_on_interest: 1, call_after_sequence: callAfter,
    nurture_texts: JSON.stringify([{ body: "{{anrede}},\n\nkurz nachgehakt – passt ein Termin? {{termin_link}}" }, { body: "{{anrede}},\n\nletzte kurze Nachfrage. Hier die {{kit_name}}: {{kit_link}}" }]),
    steps: steps || [{ subject: "Frage zu {{company}}", body: "{{anrede}},\n\nkurze Frage." }]
  });
  const lead = makeLead({ phone: "" });
  enroll(cid, lead);
  reset();
  await tick();
  const out = q.get("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", lead);
  return { pid, mb, cid, lead, out, email: q.value("SELECT email FROM leads WHERE id = ?", lead), mbEmail: q.value("SELECT email FROM mailboxes WHERE id = ?", mb) };
}

async function replyFrom(ctx, text, subject = "Re: Frage zu Müller GmbH") {
  const parsed = await simpleParser(Buffer.from([`From: ${ctx.email}`, `To: ${ctx.mbEmail}`, `Subject: ${subject}`, `Message-ID: <r${Math.random().toString(36).slice(2)}@kunde.de>`, `In-Reply-To: ${ctx.out.message_id}`, "", text].join("\r\n")));
  const mailbox = q.get("SELECT * FROM mailboxes WHERE id = ?", ctx.mb);
  return processInbound(mailbox, parsed);
}

function label(convId, value) {
  q.run("UPDATE conversations SET label = ?, label_by = 'user' WHERE id = ?", value, convId);
  onLabel({ ...q.get("SELECT * FROM conversations WHERE id = ?", convId), label_by: "user" }, value);
}

const tasksOf = leadId => q.all("SELECT * FROM tasks WHERE lead_id = ? ORDER BY id", leadId);

test("Interesse → Antwort-Aufgabe (keine Anrufe – nur Cold Mailing); nach unserer Antwort automatisch nachfassen, danach Übergabe per „Warm“", async () => {
  const ctx = await setup();
  const r = await replyFrom(ctx, "Klingt interessant, schicken Sie mir gern mehr Infos.");
  label(r.conversationId, "interested");
  const t1 = tasksOf(ctx.lead);
  assert.deepEqual(t1.map(t => t.type).sort(), ["reply"], "nur Antworten – telefoniert wird in der Sales App");
  assert.ok(hooks.some(h => h.event === "task.created"));
  assert.equal(q.get("SELECT nurture_next_at FROM conversations WHERE id = ?", r.conversationId).nurture_next_at, null, "erst antworten wir selbst");

  const reply = await api(`/api/conversations/${r.conversationId}/reply`, { method: "POST", body: { text: "Gern, anbei die Infos." } });
  assert.equal(reply.status, 200, reply.text);
  assert.equal(q.get("SELECT status FROM tasks WHERE lead_id = ? AND type = 'reply'", ctx.lead).status, "done");
  const conv = q.get("SELECT * FROM conversations WHERE id = ?", r.conversationId);
  assert.ok(conv.nurture_next_at > Date.now() + 2.9 * DAY_MS, "in 3 Tagen nachfassen");

  // Drei Tage später: erste Nachfass-Mail.
  q.run("UPDATE conversations SET nurture_next_at = ? WHERE id = ?", Date.now() - 1000, r.conversationId);
  reset();
  const before = ft.sent.length;
  await tick();
  assert.equal(ft.sent.length, before + 1);
  const raw = ft.sent.at(-1).raw;
  assert.match(raw, /Subject: =\?UTF-8\?Q\?Re=3A_Frage_zu_M=C3=BCller_GmbH\?=/);
  assert.match(raw, /In-Reply-To: </);
  assert.match(raw.replace(/=\r?\n/g, ""), /cal\.example\/website/);
  assert.match(raw, /List-Unsubscribe: <https:\/\/cold\.example\.test\/u\//);
  assert.match(raw.replace(/=\r?\n/g, ""), /Datenschutz: https:\/\/hk\.example\/datenschutz/);
  const n1 = q.get("SELECT * FROM messages WHERE conversation_id = ? AND kind = 'nurture'", r.conversationId);
  assert.ok(n1.token, "eigener Abmelde-Token");
  assert.equal(q.get("SELECT nurture_count FROM conversations WHERE id = ?", r.conversationId).nurture_count, 1);

  q.run("UPDATE conversations SET nurture_next_at = ? WHERE id = ?", Date.now() - 1000, r.conversationId);
  reset(); await tick();
  assert.match(ft.sent.at(-1).raw.replace(/=\r?\n/g, ""), /hk\.example\/kit\.pdf/);
  assert.equal(q.get("SELECT nurture_count FROM conversations WHERE id = ?", r.conversationId).nurture_count, 2);

  // Beide Nachfass-Mails ohne Antwort → kein drittes Mal mailen; der Lead bleibt „Warm“ für die Sales App.
  q.run("UPDATE conversations SET nurture_next_at = ? WHERE id = ?", Date.now() - 1000, r.conversationId);
  reset();
  const sentBefore = ft.sent.length;
  await tick();
  assert.equal(ft.sent.length, sentBefore);
  assert.equal(q.get("SELECT nurture_stopped FROM conversations WHERE id = ?", r.conversationId).nurture_stopped, "exhausted");
  assert.equal(tasksOf(ctx.lead).filter(t => ["call", "call_sequence"].includes(t.type)).length, 0, "keine Anruf-Aufgabe");
  const warm = await api("/api/leads?status=warm&limit=500");
  assert.ok(warm.json.items.some(l => l.id === ctx.lead), "unter „Warm“ zur Übergabe");
});

test("Antwort des Leads stoppt das geplante Nachfassen; Termin per Buchungs-Webhook stoppt alles", async () => {
  const ctx = await setup();
  const r = await replyFrom(ctx, "Interessant.");
  label(r.conversationId, "interested");
  await api(`/api/conversations/${r.conversationId}/reply`, { method: "POST", body: { text: "Danke! Wann passt es Ihnen?" } });
  assert.ok(q.get("SELECT nurture_next_at FROM conversations WHERE id = ?", r.conversationId).nurture_next_at);
  await replyFrom(ctx, "Ich melde mich nächste Woche.");
  assert.equal(q.get("SELECT nurture_next_at FROM conversations WHERE id = ?", r.conversationId).nurture_next_at, null);

  const secret = getSettings().booking_hook_secret;
  assert.ok(secret.length >= 24);
  assert.equal((await fetch(`${base}/hooks/booking/falsch-falsch-falsch-123`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 404);
  const start = "2026-10-20T09:00:00Z";
  const res = await fetch(`${base}/hooks/booking/${secret}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "invitee.created", payload: { email: ctx.email.toUpperCase(), scheduled_event: { start_time: start } } }) });
  assert.deepEqual(await res.json(), { ok: true, matched: true, lead_id: ctx.lead });
  const lead = q.get("SELECT * FROM leads WHERE id = ?", ctx.lead);
  assert.equal(lead.meeting_at, Date.parse(start));
  const conv = q.get("SELECT * FROM conversations WHERE id = ?", r.conversationId);
  assert.equal(conv.label, "meeting");
  assert.equal(conv.nurture_stopped, "meeting");
  assert.equal(tasksOf(ctx.lead).filter(t => t.status === "open").length, 0, "offene Aufgaben erledigt");
  assert.equal(q.value("SELECT COUNT(*) FROM events WHERE type = 'meeting' AND lead_id = ?", ctx.lead), 1);
  assert.ok(hooks.some(h => h.event === "lead.meeting" && h.data.lead.id === ctx.lead));
  // Absage über Cal.com-Format → Aufgabe zum Neu-Vereinbaren (per Mail).
  const cancel = await fetch(`${base}/hooks/booking/${secret}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ triggerEvent: "BOOKING_CANCELLED", payload: { attendees: [{ email: ctx.email }] } }) });
  assert.equal((await cancel.json()).cancelled, true);
  assert.ok(tasksOf(ctx.lead).some(t => t.status === "open" && /abgesagt/.test(t.title)));
});

test("Entwurfs-Modus: Nachfass-Entwurf als Aufgabe, nach Prüfung senden (mit Abmelde-Link und Impressum)", async () => {
  const ctx = await setup({ mode: "draft" });
  const r = await replyFrom(ctx, "Spannend, mehr Infos bitte.");
  label(r.conversationId, "interested");
  await api(`/api/conversations/${r.conversationId}/reply`, { method: "POST", body: { text: "Gern – anbei." } });
  q.run("UPDATE conversations SET nurture_next_at = ? WHERE id = ?", Date.now() - 1000, r.conversationId);
  reset();
  const before = ft.sent.length;
  await tick();
  assert.equal(ft.sent.length, before, "im Entwurfs-Modus wird nichts automatisch gesendet");
  const task = q.get("SELECT * FROM tasks WHERE lead_id = ? AND type = 'nurture_draft'", ctx.lead);
  assert.match(task.draft, /\{\{termin_link\}\}/);
  const list = await api("/api/tasks?status=open");
  assert.ok(list.json.items.some(t => t.id === task.id && t.product_booking_url === "https://cal.example/website"));
  const sent = await api(`/api/tasks/${task.id}/send`, { method: "POST", body: { text: task.draft } });
  assert.equal(sent.status, 200, sent.text);
  const raw = ft.sent.at(-1).raw.replace(/=\r?\n/g, "");
  assert.match(raw, /cal\.example\/website/);
  assert.match(raw, /\/u\/[A-Za-z0-9_-]{16,}/);
  assert.match(raw, /List-Unsubscribe/);
  assert.match(raw, /Musterstadt/);
  assert.equal(q.get("SELECT nurture_count FROM conversations WHERE id = ?", r.conversationId).nurture_count, 1);
  assert.ok(q.get("SELECT nurture_next_at FROM conversations WHERE id = ?", r.conversationId).nurture_next_at > Date.now());
});

test("Kein Interesse → Sperrfrist, Sequenzen gestoppt, Aufgaben weg; Anruf-Aufgaben gibt es nicht", async () => {
  const ctx = await setup({ steps: [{ subject: "Frage", body: "{{anrede}},\n\nA" }, { subject: "", body: "B" }], callAfter: 1 });
  assert.equal(tasksOf(ctx.lead).filter(t => ["call", "call_sequence"].includes(t.type)).length, 0, "auch mit alter Einstellung keine Anruf-Aufgabe nach der Sequenz");
  const r = await replyFrom(ctx, "Interessiert mich.");
  label(r.conversationId, "interested");
  assert.ok(!tasksOf(ctx.lead).some(t => ["call", "call_sequence"].includes(t.type)), "kein Anruf bei Interesse");
  label(r.conversationId, "not_interested");
  const lead = q.get("SELECT * FROM leads WHERE id = ?", ctx.lead);
  assert.ok(lead.hold_until > Date.now() + 300 * DAY_MS, "ein Jahr Sperre (Standard)");
  assert.equal(tasksOf(ctx.lead).filter(t => t.status === "open").length, 0);

  const other = makeLead();
  const call = await api("/api/tasks", { method: "POST", body: { lead_id: other, type: "call" } });
  assert.equal(call.status, 400);
  assert.match(call.json.error, /Sales App/);
  assert.equal((await api("/api/tasks/bulk", { method: "POST", body: { lead_ids: [other], type: "call" } })).status, 400);
  const todo = await api("/api/tasks", { method: "POST", body: { lead_id: other } });
  assert.equal(todo.json.type, "todo");
  const dnc = await api(`/api/tasks/${todo.json.id}/outcome`, { method: "POST", body: { outcome: "do_not_contact" } });
  assert.equal(dnc.status, 200);
  assert.equal(q.get("SELECT status FROM leads WHERE id = ?", other).status, "unsubscribed");
  assert.equal(q.get("SELECT consent_status FROM leads WHERE id = ?", other).consent_status, "revoked");
});

