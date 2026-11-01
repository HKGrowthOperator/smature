// Versandlogik: Rotation, Limits, Ramp-up, Zeitfenster, Threading, Fehlerbehandlung – mit Fake-SMTP und echtem smtp-server.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SMTPServer } from "smtp-server";
import { setupDb, makeMailbox, makeLead, makeCampaign, enroll, fakeTransport } from "./helpers.js";
import { q } from "../src/db.js";
import { tick } from "../src/engine/scheduler.js";
import { setTransportFactory, classifySmtpError } from "../src/mail/transport.js";
import { effectiveDailyLimit } from "../src/mail/mailboxes.js";
import { saveSettings } from "../src/settings.js";
import { DAY_MS } from "../src/lib/time.js";

let cleanup;
before(() => { cleanup = setupDb(); saveSettings({ footer_text: "Musterfirma GmbH · Musterstadt" }); });
after(() => { setTransportFactory(null); cleanup(); });
beforeEach(() => {
  for (const t of ["campaign_leads", "campaign_steps", "campaigns", "messages", "conversations", "events", "leads", "mailboxes", "blocklist"]) q.run(`DELETE FROM ${t}`);
});

test("Rotation: neue Leads verteilt, eine Mail pro Postfach und Takt, Abstand wird gesetzt", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const a = makeMailbox(), b = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [a, b] });
  for (let i = 0; i < 5; i++) enroll(cid, makeLead());
  const r = await tick();
  assert.equal(r.sent, 2);
  assert.equal(new Set(q.all("SELECT mailbox_id FROM messages").map(m => m.mailbox_id)).size, 2);
  const mb = q.get("SELECT * FROM mailboxes WHERE id = ?", a);
  assert.ok(mb.next_send_at > Date.now() + 20000, "Abstand (30 s) gesetzt");
  assert.equal((await tick()).sent, 0, "Postfächer warten den Abstand ab");
  const raw = ft.sent[0].raw;
  assert.match(raw, /Sehr geehrter Herr M/);
  assert.match(raw, /List-Unsubscribe: <https:\/\/cold\.example\.test\/u\//);
  assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  assert.match(raw, /Musterstadt/);
  assert.doesNotMatch(raw, /Content-Type: text\/html/, "ohne Tracking reiner Text");
});

test("Tageslimit, Ramp-up und Kampagnenlimit", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const mb = makeMailbox({ daily_limit: 2 });
  const cid = makeCampaign({ mailboxIds: [mb], daily_limit: 100 });
  for (let i = 0; i < 4; i++) enroll(cid, makeLead());
  for (let i = 0; i < 4; i++) { q.run("UPDATE mailboxes SET next_send_at = 0"); await tick(); }
  assert.equal(ft.sent.length, 2, "Postfach-Tageslimit greift");
  const now = Date.now();
  assert.equal(effectiveDailyLimit({ daily_limit: 40, ramp_enabled: 1, ramp_start: 5, ramp_step: 3, ramp_started_at: now }, now), 5);
  assert.equal(effectiveDailyLimit({ daily_limit: 40, ramp_enabled: 1, ramp_start: 5, ramp_step: 3, ramp_started_at: now - 4 * DAY_MS }, now), 17);
  assert.equal(effectiveDailyLimit({ daily_limit: 40, ramp_enabled: 1, ramp_start: 5, ramp_step: 3, ramp_started_at: now - 30 * DAY_MS }, now), 40);
  q.run("DELETE FROM messages"); q.run("UPDATE mailboxes SET daily_limit = 50, next_send_at = 0");
  q.run("UPDATE campaigns SET daily_limit = 1");
  q.run("UPDATE campaign_leads SET status = 'queued', step = 0");
  await tick(); q.run("UPDATE mailboxes SET next_send_at = 0"); await tick();
  assert.equal(q.value("SELECT COUNT(*) FROM messages"), 1, "Kampagnen-Tageslimit greift");
});

test("Außerhalb des Zeitfensters und vor Startdatum wird nicht gesendet", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb], days: "1", window_start: "08:00", window_end: "08:01" });
  enroll(cid, makeLead());
  // Sonntag 12:00 Berlin
  await tick(Date.UTC(2026, 9, 11, 10, 0));
  assert.equal(ft.sent.length, 0);
  q.run("UPDATE campaigns SET days = '1,2,3,4,5,6,7', window_start = '00:00', window_end = '23:59', start_at = ?", Date.now() + DAY_MS);
  await tick();
  assert.equal(ft.sent.length, 0, "Startdatum in der Zukunft");
});

test("Follow-up: gleiches Postfach, Re:-Betreff, In-Reply-To/References, danach abgeschlossen", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const a = makeMailbox(), b = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [a, b] });
  const lead = makeLead({ company: "Dach AG" });
  const cl = enroll(cid, lead);
  await tick();
  const first = q.get("SELECT * FROM messages WHERE campaign_lead_id = ?", cl);
  assert.equal(first.subject, "Frage zu Dach AG");
  q.run("UPDATE campaign_leads SET next_at = 0 WHERE id = ?", cl);
  q.run("UPDATE mailboxes SET next_send_at = 0");
  await tick();
  const second = q.get("SELECT * FROM messages WHERE campaign_lead_id = ? AND step = 1", cl);
  assert.equal(second.subject, "Re: Frage zu Dach AG");
  assert.equal(second.mailbox_id, first.mailbox_id);
  assert.equal(second.in_reply_to, first.message_id);
  assert.match(ft.sent[1].raw, new RegExp(`In-Reply-To: ${first.message_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE id = ?", cl).status, "completed");
  assert.equal(q.get("SELECT status FROM campaigns WHERE id = ?", cid).status, "completed");
});

test("Gesperrte, abgemeldete, ungültige Leads und fehlende Variablen werden übersprungen", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb] });
  const blocked = makeLead({ email: "x@konkurrenz.de" });
  q.run("INSERT INTO blocklist (value, kind, reason, created_at) VALUES ('konkurrenz.de', 'domain', 't', 0)");
  const unsub = makeLead({ status: "unsubscribed" });
  const invalid = makeLead({ verify_status: "invalid" });
  const noCompany = makeLead({ company: "" });
  for (const l of [blocked, unsub, invalid, noCompany]) enroll(cid, l);
  for (let i = 0; i < 5; i++) { q.run("UPDATE mailboxes SET next_send_at = 0"); await tick(); }
  assert.equal(ft.sent.length, 0);
  const st = Object.fromEntries(q.all("SELECT lead_id, status, last_error FROM campaign_leads").map(r => [r.lead_id, r]));
  assert.equal(st[blocked].status, "blocked");
  assert.equal(st[unsub].status, "unsubscribed");
  assert.equal(st[invalid].status, "invalid");
  assert.equal(st[noCompany].status, "error");
  assert.match(st[noCompany].last_error, /company/);
});

test("A/B-Varianten werden verteilt und je Lead gemerkt", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const boxes = Array.from({ length: 10 }, () => makeMailbox());
  const cid = makeCampaign({ mailboxIds: boxes, steps: [{ variants: [{ key: "A", subject: "Betreff A", body: "Text A {{company}}", enabled: true }, { key: "B", subject: "Betreff B", body: "Text B {{company}}", enabled: true }, { key: "C", subject: "aus", body: "aus", enabled: false }] }] });
  for (let i = 0; i < 10; i++) enroll(cid, makeLead());
  await tick();
  const variants = q.all("SELECT variant FROM messages").map(m => m.variant);
  assert.equal(variants.length, 10);
  assert.ok(!variants.includes("C"), "deaktivierte Variante wird nicht genutzt");
  assert.ok(variants.includes("A") && variants.includes("B"), `beide Varianten genutzt: ${variants}`);
});

test("Öffnungs-/Klick-Tracking erzeugt HTML mit Pixel und signierten Links", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb], track_opens: 1, track_clicks: 1, steps: [{ subject: "Hallo", body: "Siehe https://musterfirma.de/referenzen" }] });
  enroll(cid, makeLead());
  await tick();
  const raw = ft.sent[0].raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=");
  assert.match(raw, /Content-Type: text\/html/);
  assert.match(raw, /\/t\/o\/[A-Za-z0-9_-]+\.gif/);
  assert.match(raw, /\/t\/c\/[A-Za-z0-9_-]+\?u=https%3A%2F%2Fmusterfirma\.de%2Freferenzen&amp;s=/);
});

test("SMTP-Fehler-Einordnung", () => {
  const e = (responseCode, response, code = "EENVELOPE") => Object.assign(new Error(response), { responseCode, response, code });
  assert.equal(classifySmtpError(e(550, "550 5.1.1 <x@y.de>: Recipient address rejected: User unknown")).type, "recipient");
  assert.equal(classifySmtpError(e(550, "550 5.7.1 Message rejected as spam")).type, "policy");
  assert.equal(classifySmtpError(e(452, "452 4.2.2 Mailbox full")).type, "recipient_temp");
  // Volles Empfänger-Postfach ist kein Versandlimit unseres Postfachs.
  assert.equal(classifySmtpError(e(552, "552 5.2.2 The email account that you tried to reach is over quota")).type, "recipient_temp");
  // Absender abgelehnt: Postfach-Problem, kein Bounce des Leads.
  const at = (responseCode, response, command) => Object.assign(e(responseCode, response), { command });
  assert.equal(classifySmtpError(at(553, "553 5.7.1 Sender address rejected: not owned by user", "MAIL FROM")).type, "sender");
  assert.equal(classifySmtpError(at(550, "550 5.1.8 Bad sender address", "MAIL FROM")).type, "sender");
  assert.equal(classifySmtpError(at(550, "550 5.1.1 User unknown", "RCPT TO")).type, "recipient");
  assert.equal(classifySmtpError(at(450, "450 4.7.1 Greylisted, try again later", "RCPT TO")).type, "recipient_temp");
  assert.equal(classifySmtpError(at(421, "421 4.3.0 Temporary system problem", "DATA")).type, "temporary");
  assert.equal(classifySmtpError(e(550, "550 5.4.5 Daily user sending quota exceeded")).type, "quota");
  assert.equal(classifySmtpError(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 })).type, "auth");
  assert.equal(classifySmtpError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNECTION" })).type, "connection");
});

test("Echter SMTP-Server: 550 für unbekannten Empfänger → Bounce, Login-Fehler → Postfach pausiert", async () => {
  setTransportFactory(null);
  const received = [];
  const server = new SMTPServer({
    authOptional: false, disabledCommands: ["STARTTLS"],
    onAuth(auth, _s, cb) { return auth.password === "richtig" ? cb(null, { user: auth.username }) : cb(Object.assign(new Error("Invalid credentials"), { responseCode: 535 })); },
    onRcptTo(addr, _s, cb) { return addr.address.startsWith("unbekannt") ? cb(Object.assign(new Error("5.1.1 User unknown"), { responseCode: 550 })) : cb(); },
    onData(stream, _s, cb) { let d = ""; stream.on("data", c => { d += c; }); stream.on("end", () => { received.push(d); cb(); }); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.server.address().port;
  try {
    const { encrypt } = await import("../src/crypto.js");
    const good = makeMailbox({ smtp_port: port, smtp_pass: encrypt("richtig") });
    const cid = makeCampaign({ mailboxIds: [good] });
    const ok = makeLead({ email: "kunde@firma-ok.de" });
    const bad = makeLead({ email: "unbekannt@firma-ok.de" });
    enroll(cid, ok); enroll(cid, bad);
    await tick(); q.run("UPDATE mailboxes SET next_send_at = 0"); await tick();
    assert.equal(received.length, 1);
    assert.match(received[0], /Subject: =\?UTF-8\?Q\?Frage_zu_M=C3=BCller_GmbH\?=/);
    assert.equal(q.get("SELECT status FROM leads WHERE id = ?", bad).status, "bounced");
    assert.equal(q.get("SELECT status FROM campaign_leads WHERE lead_id = ?", bad).status, "bounced");
    assert.equal(q.value("SELECT COUNT(*) FROM events WHERE type = 'bounce'"), 1);

    const wrong = makeMailbox({ smtp_port: port, smtp_pass: encrypt("falsch") });
    const cid2 = makeCampaign({ mailboxIds: [wrong] });
    enroll(cid2, makeLead());
    await tick();
    const mb = q.get("SELECT * FROM mailboxes WHERE id = ?", wrong);
    assert.equal(mb.status, "error");
    assert.match(mb.last_error, /Anmeldung fehlgeschlagen/);
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("Follow-ups eines belegten Postfachs blockieren neue Leads nicht; pausiertes Postfach → Follow-ups warten", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const a = makeMailbox(), b = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [a, b] });
  for (let i = 0; i < 12; i++) enroll(cid, makeLead(), { status: "active", step: 1, mailbox_id: a, next_at: Date.now() - 1000, last_message_id: `<m${i}@test-firma.de>`, thread_subject: "Frage" });
  for (let i = 0; i < 3; i++) enroll(cid, makeLead());
  q.run("UPDATE mailboxes SET next_send_at = ? WHERE id = ?", Date.now() + 600000, a);
  assert.equal((await tick()).sent, 1, "B schreibt einen neuen Lead an");
  assert.equal(ft.sent[0].envelope.from, q.value("SELECT email FROM mailboxes WHERE id = ?", b));
  assert.equal(q.value("SELECT COUNT(*) FROM campaign_leads WHERE mailbox_id = ? AND step = 1", a), 12, "Follow-ups bleiben bei A");

  q.run("UPDATE mailboxes SET status = 'paused', next_send_at = 0 WHERE id = ?", a);
  q.run("UPDATE mailboxes SET next_send_at = 0 WHERE id = ?", b);
  q.run("UPDATE campaign_leads SET status = 'stopped' WHERE mailbox_id IS NULL");
  assert.equal((await tick()).sent, 0, "kein „Re:“ von fremder Adresse");
});

test("Status-Änderung während des Versands: pausierte Leads werden nicht mehr angeschrieben, gestoppte nicht wiederbelebt", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const a = makeMailbox(), b = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [a, b] });
  const first = enroll(cid, makeLead()), second = enroll(cid, makeLead());
  ft.fail(() => {
    // Während die erste Mail läuft: zweiten Lead pausieren, ersten stoppen.
    q.run("UPDATE campaign_leads SET status = 'paused' WHERE id = ?", second);
    q.run("UPDATE campaign_leads SET status = 'stopped' WHERE id = ?", first);
    ft.fail(null);
    return null;
  });
  assert.equal((await tick()).sent, 1);
  const r1 = q.get("SELECT * FROM campaign_leads WHERE id = ?", first);
  assert.equal(r1.status, "stopped", "Stopp bleibt");
  assert.equal(r1.step, 1, "Versand trotzdem protokolliert");
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE id = ?", second).status, "paused");
  assert.equal(ft.sent.length, 1);
});

test("Absender abgelehnt (MAIL FROM) → Postfach pausiert, Lead bleibt aktiv; volles Empfänger-Postfach bremst das Postfach nicht", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const a = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [a] });
  const lead = makeLead();
  enroll(cid, lead);
  ft.fail(Object.assign(new Error("553 5.7.1 Sender address rejected: not owned by user"), { responseCode: 553, response: "553 5.7.1 Sender address rejected: not owned by user", code: "EENVELOPE", command: "MAIL FROM" }));
  await tick();
  assert.equal(q.get("SELECT status FROM leads WHERE id = ?", lead).status, "active");
  assert.equal(q.get("SELECT status FROM mailboxes WHERE id = ?", a).status, "error");

  const b = makeMailbox();
  const cid2 = makeCampaign({ mailboxIds: [b] });
  const full = makeLead();
  enroll(cid2, full);
  ft.fail(Object.assign(new Error("552 5.2.2 over quota"), { responseCode: 552, response: "552 5.2.2 The email account that you tried to reach is over quota", code: "EENVELOPE", command: "RCPT TO" }));
  await tick();
  const mb = q.get("SELECT * FROM mailboxes WHERE id = ?", b);
  assert.equal(mb.status, "active");
  assert.ok(!mb.last_error, "Postfach nicht als fehlerhaft markiert");
  const cl = q.get("SELECT * FROM campaign_leads WHERE lead_id = ?", full);
  assert.equal(cl.attempts, 1, "Versuch zählt");
  assert.ok(cl.next_at > Date.now() + 60 * 60 * 1000);
  assert.equal(q.get("SELECT status FROM leads WHERE id = ?", full).status, "active");
});
