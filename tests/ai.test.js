// KI-Funktionen mit simuliertem Claude-Client: Anfrageform (Modell, Schema, Caching, Fallback), Fehlerfälle,
// Personalisierung fließt in den Versand, Antwort-Einordnung setzt Label + Webhook.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { setupDb, makeMailbox, makeLead, makeCampaign, enroll, fakeTransport } from "./helpers.js";
import { q, insert } from "../src/db.js";
import { setAiClientFactory } from "../src/ai/claude.js";
import { distillKnowledge, generateSequence, classifyConversation, draftReply, ensurePersonalization, roboticIssues, FIRST_LINE_TASK } from "../src/ai/features.js";
import { setTransportFactory } from "../src/mail/transport.js";
import { setWebhookFetch, signPayload } from "../src/events.js";
import { saveSettings } from "../src/settings.js";
import { tick } from "../src/engine/scheduler.js";
import { loadSteps } from "../src/mail/compose.js";

let cleanup;
const calls = [];
let responder = () => ({});
let failBeta = null;
function fakeClient() {
  const respond = params => {
    calls.push(params);
    const out = responder(params);
    if (out instanceof Error) throw out;
    return { stop_reason: out.stop_reason || "end_turn", content: [{ type: "text", text: JSON.stringify(out.json ?? out) }], usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  };
  // Nachbildung von client.messages.stream(params).finalMessage()
  const stream = run => ({ finalMessage: async () => run() });
  return {
    messages: { stream: p => stream(() => respond({ ...p, __beta: false })) },
    beta: { messages: { stream: p => stream(() => { if (failBeta) { const e = failBeta; failBeta = null; calls.push({ ...p, __beta: true, __failed: true }); throw e; } return respond({ ...p, __beta: true }); }) } }
  };
}

before(() => {
  cleanup = setupDb({ AI_MODEL: "claude-opus-5-5" });
  setAiClientFactory(() => fakeClient());
  saveSettings({ company_name: "Musterfirma UG", sender_context: "Wir bauen Websites für Handwerksbetriebe.", booking_url: "https://salesapp2.musterfirma.de/buchen/webseite" });
});
after(() => { setAiClientFactory(null); setTransportFactory(null); cleanup(); });
beforeEach(() => { calls.length = 0; });

test("Wissen verdichten: PDF als Dokument-Block, Schema, Caching, Fallback-Beta", async () => {
  const now = Date.now();
  const tg = insert("target_groups", { name: "Handwerk", description: "Betriebe 5–50 MA", created_at: now, updated_at: now });
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
  insert("knowledge_docs", { target_group_id: tg, title: "Info-Blatt", kind: "pdf", data: pdf, size: pdf.length, created_at: now });
  insert("knowledge_docs", { target_group_id: tg, title: "Notizen", kind: "text", content: "Fachkräftemangel ist das Top-Thema.", size: 30, created_at: now });
  responder = () => ({ profile_markdown: "## Wer sie sind\n- Handwerk", suggested_tone: "Sie-Form, bodenständig", suggested_cta: "15-Minuten-Telefonat" });
  await distillKnowledge("target_group", tg);
  const p = calls[0];
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal(p.__beta, true);
  assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(p.fallbacks, "default");
  assert.equal(p.output_config.format.type, "json_schema");
  assert.equal(p.output_config.format.schema.additionalProperties, false);
  assert.equal(p.output_config.effort, "medium");
  assert.equal(p.system.at(-1).cache_control.type, "ephemeral");
  assert.equal(p.messages[0].content[0].type, "document");
  assert.equal(p.messages[0].content[0].source.media_type, "application/pdf");
  assert.match(p.messages[0].content.at(-1).text, /Fachkräftemangel/);
  const row = q.get("SELECT * FROM target_groups WHERE id = ?", tg);
  assert.match(row.profile, /Wer sie sind/);
  assert.equal(row.tone, "Sie-Form, bodenständig");
  assert.equal(row.cta, "15-Minuten-Telefonat");
});

test("Wird der Fallback-Parameter abgelehnt, klappt der Aufruf ohne ihn", async () => {
  failBeta = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "fallbacks" } }, "fallbacks not supported", new Headers());
  const tg = q.get("SELECT id FROM target_groups LIMIT 1").id;
  responder = () => ({ campaign_name: "Handwerk Q4", steps: [
    { delay_days: 0, subject: "frage zu {{company}}", body: "{{anrede}},\n\nText 1", variant_b_subject: "kurze frage", variant_b_body: "B1" },
    { delay_days: 0, subject: "sollte leer sein", body: "{{anrede}},\n\nText 2", variant_b_subject: "x", variant_b_body: "B2" },
    { delay_days: 5, subject: "", body: "Text 3", variant_b_subject: "", variant_b_body: "B3" },
    { delay_days: 5, subject: "", body: "zu viel", variant_b_subject: "", variant_b_body: "" }
  ], nurture: [{ body: "{{anrede}},\n\nkurz nachgehakt: {{termin_link}}" }, { body: "" }] });
  const seq = await generateSequence({ targetGroupId: tg }, { steps: 3, goal: "Termin" });
  assert.equal(calls[0].__failed, true);
  assert.equal(calls[1].__beta, false, "zweiter Versuch ohne Beta");
  assert.equal(calls[1].output_config.effort, "high");
  assert.equal(seq.steps.length, 3, "auf gewünschte Anzahl gekürzt");
  assert.equal(seq.steps[0].delay_days, 0);
  assert.equal(seq.steps[1].delay_days, 5, "fehlender/0-Abstand → Richtwert der Rolle (Mail 2 von 3 = Mehrwert, 5 Tage)");
  assert.equal(seq.steps[1].subject, "sollte leer sein", "Betreff von Follow-ups bleibt, wenn die KI einen setzt");
  assert.deepEqual(seq.nurture, [{ body: "{{anrede}},\n\nkurz nachgehakt: {{termin_link}}" }], "leere Nachfass-Texte fallen weg");
});

test("Einstiegsangebot und fester Mail-Aufbau gehen an die KI; Regeln verbieten Schein-Gespräche und Fake-Verknappung", async () => {
  const tg = q.get("SELECT id FROM target_groups LIMIT 1").id;
  responder = () => ({ campaign_name: "Test", steps: [1, 2, 3, 4, 5].map(i => ({ delay_days: 0, subject: i === 1 ? "Frage" : "", body: `{{anrede}},\n\nText ${i}`, variant_b_subject: "", variant_b_body: "" })), nurture: [] });
  const seq = await generateSequence({ targetGroupId: tg }, { steps: 5, offerType: "deliverable", entryOffer: "Kurze Einschätzung Ihrer Startseite" });
  const req = calls.at(-1);
  const text = JSON.stringify(req.messages) + JSON.stringify(req.system);
  assert.match(text, /Einstiegsangebot: Konkrete Einschätzung/);
  assert.match(text, /Kurze Einschätzung Ihrer Startseite/);
  assert.match(text, /Mail 2: Kurzes Nachhaken/);
  assert.match(text, /Mail 4: Relevanz-Frage/);
  assert.match(text, /Mail 5: Abschluss/);
  assert.match(text, /nur noch 3 Plätze/, "künstliche Verknappung ausdrücklich verboten");
  assert.match(text, /Unser Gespräch/, "Schein-Gespräch ausdrücklich verboten");
  assert.deepEqual(seq.steps.map(s => s.delay_days), [0, 3, 5, 7, 7], "Richtwerte je Rolle");
});

test("Ablehnung (refusal) und abgeschnittene Antworten werden als Fehler gemeldet", async () => {
  const conv = insert("conversations", { lead_id: makeLead(), last_at: Date.now(), created_at: Date.now(), has_inbound: 1 });
  insert("messages", { conversation_id: conv, direction: "in", kind: "reply", text: "Hallo", created_at: Date.now() });
  responder = () => ({ stop_reason: "refusal", json: {} });
  await assert.rejects(classifyConversation(conv), /abgelehnt/);
  responder = () => ({ stop_reason: "max_tokens", json: {} });
  await assert.rejects(classifyConversation(conv), /abgeschnitten/);
});

test("Personalisierung (Volltext) wird gespeichert und genau so versendet; Website-Text fließt ein", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const mb = makeMailbox();
  const tg = q.get("SELECT id FROM target_groups LIMIT 1").id;
  const cid = makeCampaign({ mailboxIds: [mb], ai_mode: "full", target_group_id: tg, steps: [{ subject: "Frage zu {{company}}", body: "{{anrede}},\n\nVorlage." }] });
  const lead = makeLead({ email: "max@gmail.com", company: "Dachbau Müller", website: "", notes: "sucht Azubis" });
  const cl = enroll(cid, lead);
  responder = p => {
    assert.match(p.messages[0].content, /Dachbau Müller/);
    assert.match(p.messages[0].content, /sucht Azubis/);
    assert.match(p.system.map(s => s.text).join("\n"), /Wir bauen Websites für Handwerksbetriebe/);
    return { subject: "Azubis für {Dachbau|Müller}", body: "Sehr geehrter Herr Müller,\n\nSie suchen Azubis – {{company}} könnte über die Website mehr Bewerbungen bekommen. Passt ein kurzes Telefonat?" };
  };
  await tick();
  assert.equal(ft.sent.length, 1);
  const raw = ft.sent[0].raw.replace(/=\r?\n/g, "");
  assert.match(ft.sent[0].raw, /Subject: =\?UTF-8\?Q\?Azubis_f=C3=BCr_Dachbau\?=\r\n/, "Spintax/Klammern aus KI-Text aufgelöst");
  assert.match(raw, /Sie suchen Azubis/);
  assert.doesNotMatch(raw, /Vorlage\./);
  const ai = JSON.parse(q.get("SELECT ai FROM campaign_leads WHERE id = ?", cl).ai);
  assert.ok(ai.steps[0].body.includes("Sie suchen Azubis"));
  // Zweiter Aufruf nutzt den gespeicherten Text (kein neuer KI-Aufruf)
  const before = calls.length;
  await ensurePersonalization({ campaign: q.get("SELECT * FROM campaigns WHERE id = ?", cid), steps: loadSteps(cid), cl: q.get("SELECT * FROM campaign_leads WHERE id = ?", cl), lead: q.get("SELECT * FROM leads WHERE id = ?", lead), mailbox: q.get("SELECT * FROM mailboxes WHERE id = ?", mb), stepIndex: 0, variantKey: "A" });
  assert.equal(calls.length, before);
});

test("Einstiegssatz: benennt etwas Gutes von der Website, klingt menschlich – Robotersprache wird neu geschrieben", async () => {
  assert.match(FIRST_LINE_TASK, /gute Sache/);
  assert.ok(roboticIssues("Ihre Website ist wirklich beeindruckend!"));
  assert.ok(roboticIssues("Sie bauen Dächer – und das seit 1952."), "Gedankenstrich");
  assert.equal(roboticIssues("Ihr Umbau der Sporthalle in Gütersloh ist ein schönes Beispiel dafür, wie viel Erfahrung in Ihrem Team steckt."), "");
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb], ai_mode: "first_line", status: "draft", steps: [{ subject: "Frage", body: "{{anrede}},\n\n{{ai_first_line}}\n\nKurze Frage." }] });
  const lead = makeLead({ email: "info@dachbau-gute-sache.de", company: "Dachbau Gute Sache", website: "" });
  const cl = enroll(cid, lead);
  const prompts = [];
  responder = p => { prompts.push(p.messages[0].content); return { first_line: prompts.length === 1 ? "Ihre Website ist wirklich beeindruckend!" : "Dass Sie seit drei Generationen Dächer in Steinhagen decken, sieht man an den vielen Referenzen auf Ihrer Seite." }; };
  const ai = await ensurePersonalization({ campaign: q.get("SELECT * FROM campaigns WHERE id = ?", cid), steps: loadSteps(cid), cl: q.get("SELECT * FROM campaign_leads WHERE id = ?", cl), lead: q.get("SELECT * FROM leads WHERE id = ?", lead), mailbox: q.get("SELECT * FROM mailboxes WHERE id = ?", mb), stepIndex: 0, variantKey: "A" });
  assert.equal(prompts.length, 2, "zweiter Versuch nach Robotersprache");
  assert.match(prompts[1], /Klingt nicht menschlich/);
  assert.match(ai.first_line, /drei Generationen/);
});

test("KI-Fehler bei der Personalisierung: Lead wird verschoben, nach 3 Versuchen Vorlage", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb], ai_mode: "first_line", steps: [{ subject: "Hallo {{company}}", body: "{{anrede}},\n\n{{ai_first_line|Ich habe eine kurze Frage.}}" }] });
  const cl = enroll(cid, makeLead());
  responder = () => new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers());
  for (let i = 0; i < 3; i++) { q.run("UPDATE campaign_leads SET next_at = 0 WHERE id = ?", cl); q.run("UPDATE mailboxes SET next_send_at = 0"); await tick(); }
  assert.equal(ft.sent.length, 1, "nach dem 3. Fehlversuch mit Fallback-Text gesendet");
  assert.match(ft.sent[0].raw, /Ich habe eine kurze Frage\./);
});

test("Antwort einordnen: Label, Zusammenfassung, Interesse-Ereignis und signierter Webhook", async () => {
  const hooks = [];
  setWebhookFetch(async (url, opts) => { hooks.push({ url, opts }); return { ok: true, status: 200 }; });
  saveSettings({ webhook_url: "https://crm.example/hook", webhook_secret: "geheim", webhook_events: ["lead.interested"] });
  const mb = makeMailbox();
  const lead = makeLead({ email: "interessiert@firma-x.de" });
  const cid = makeCampaign({ mailboxIds: [mb] });
  const cl = enroll(cid, lead, { status: "replied" });
  const conv = insert("conversations", { mailbox_id: mb, lead_id: lead, campaign_id: cid, campaign_lead_id: cl, last_at: Date.now(), created_at: Date.now(), has_inbound: 1, ai_pending: 1 });
  insert("messages", { conversation_id: conv, direction: "out", kind: "campaign", text: "Frage?", created_at: Date.now() - 1000 });
  insert("messages", { conversation_id: conv, direction: "in", kind: "reply", text: "Ja, gern Donnerstag 10 Uhr.\n\n> Frage?", created_at: Date.now() });
  responder = p => { assert.match(p.messages[0].content, /Donnerstag/); assert.doesNotMatch(p.messages[0].content, /> Frage/); return { label: "meeting", summary: "Möchte Donnerstag telefonieren.", next_step: "Termin bestätigen", referral_email: "" }; };
  await classifyConversation(conv);
  const c = q.get("SELECT * FROM conversations WHERE id = ?", conv);
  assert.equal(c.label, "meeting");
  assert.equal(c.label_by, "ai");
  assert.match(c.ai_summary, /Donnerstag/);
  assert.equal(q.get("SELECT interest FROM campaign_leads WHERE id = ?", cl).interest, "meeting");
  assert.equal(q.value("SELECT COUNT(*) FROM events WHERE type = 'interested' AND lead_id = ?", lead), 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(hooks.length, 1);
  const body = hooks[0].opts.body;
  assert.equal(JSON.parse(body).event, "lead.interested");
  assert.equal(hooks[0].opts.headers["X-Coldmail-Signature"], signPayload(body, "geheim"));
  // Manuell gesetztes Label wird von der KI nicht überschrieben
  q.run("UPDATE conversations SET label = 'not_interested', label_by = 'user' WHERE id = ?", conv);
  responder = () => ({ label: "interested", summary: "x", next_step: "", referral_email: "" });
  await classifyConversation(conv);
  assert.equal(q.get("SELECT label FROM conversations WHERE id = ?", conv).label, "not_interested");
  setWebhookFetch(null);
});

test("Antwortentwurf nutzt Verlauf und Terminlink", async () => {
  const conv = q.get("SELECT id FROM conversations WHERE label = 'not_interested'").id;
  responder = p => { assert.match(p.system.map(s => s.text).join("\n") + p.messages[0].content, /salesapp2\.musterfirma\.de/); return { body: "Gern! Donnerstag 10 Uhr passt." }; };
  const d = await draftReply(conv);
  assert.equal(d.body, "Gern! Donnerstag 10 Uhr passt.");
});

test("Nutzer-Label während laufender KI-Einordnung bleibt erhalten", async () => {
  const conv = insert("conversations", { lead_id: makeLead(), last_at: Date.now(), created_at: Date.now(), has_inbound: 1 });
  insert("messages", { conversation_id: conv, direction: "in", kind: "reply", text: "Gern mehr Infos", created_at: Date.now() });
  responder = () => {
    // Nutzer setzt das Label, während die KI noch arbeitet.
    q.run("UPDATE conversations SET label = 'meeting', label_by = 'user' WHERE id = ?", conv);
    return { label: "not_interested", summary: "x", next_step: "", referral_email: "", callback_phone: "" };
  };
  await classifyConversation(conv);
  const row = q.get("SELECT label, label_by, ai_summary FROM conversations WHERE id = ?", conv);
  assert.equal(row.label, "meeting");
  assert.equal(row.label_by, "user");
  assert.match(row.ai_summary, /x/);
});
