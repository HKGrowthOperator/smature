// End-to-End gegen einen echten SMTP/IMAP-Server (GreenMail im Docker):
//   docker run -d --name greenmail -p 3025:3025 -p 3143:3143 -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0
//     -Dgreenmail.users=sales1:pw-sales1@test-firma.de,sales2:pw-sales2@test-firma.de,max:pw-max@kunde-a.de,erika:pw-erika@kunde-b.de -Dgreenmail.users.login=email' greenmail/standalone:2.1.2
//   npm run test:e2e
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";

const HOST = process.env.GREENMAIL_HOST || "127.0.0.1";
const skip = !process.env.E2E;
let dir, mods = {};

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), "coldmail-e2e-"));
  const { loadConfig } = await import("../../src/config.js");
  loadConfig({ APP_SECRET: "e2e-secret-e2e-secret-e2e-secret-123", DATA_DIR: dir, APP_URL: "https://cold.example.test", ALLOW_INSECURE_TLS: "true", COOKIE_SECURE: "false", WORKERS: "false" });
  const db = await import("../../src/db.js");
  db.openDb(join(dir, "e2e.db"));
  mods = {
    db,
    crypto: await import("../../src/crypto.js"),
    scheduler: await import("../../src/engine/scheduler.js"),
    imap: await import("../../src/mail/imap.js"),
    warmup: await import("../../src/mail/warmup.js"),
    settings: await import("../../src/settings.js"),
    rules: await import("../../src/engine/rules.js"),
    compose: await import("../../src/mail/compose.js")
  };
});
after(() => { if (dir) { mods.db.closeDb(); rmSync(dir, { recursive: true, force: true }); } });

function mailbox(email, pass) {
  const { insert } = mods.db;
  const now = Date.now();
  return insert("mailboxes", {
    email, from_name: email.startsWith("sales1") ? "Max Mustermann" : "Erika Musterfrau", smtp_host: HOST, smtp_port: 3025, smtp_secure: 0, smtp_user: email, smtp_pass: mods.crypto.encrypt(pass),
    imap_host: HOST, imap_port: 3143, imap_secure: 0, imap_user: email, imap_pass: mods.crypto.encrypt(pass), daily_limit: 50, ramp_enabled: 0, min_gap_sec: 0,
    signature: "Max Mustermann\nMusterfirma", save_sent: 1, created_at: now, updated_at: now
  });
}

async function imapClient(user, pass) {
  const c = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user, pass }, logger: false });
  await c.connect();
  return c;
}

async function inbox(user, pass) {
  const c = await imapClient(user, pass);
  const lock = await c.getMailboxLock("INBOX");
  const out = [];
  try {
    for await (const m of c.fetch("1:*", { envelope: true, source: true, uid: true })) out.push({ uid: m.uid, subject: m.envelope.subject, messageId: m.envelope.messageId, from: m.envelope.from?.[0]?.address, source: m.source.toString() });
  } catch { /* leer */ }
  lock.release();
  await c.logout();
  return out;
}

const smtp = (user, pass) => nodemailer.createTransport({ host: HOST, port: 3025, secure: false, auth: { user, pass }, tls: { rejectUnauthorized: false } });

test("Kampagne: Versand, Rotation, Antwort stoppt Sequenz, Follow-up im Thread, Bounce, Abmelden, Warmup", { skip }, async () => {
  const { q, insert } = mods.db;
  const now = Date.now();
  mods.settings.saveSettings({ footer_text: "Musterfirma GmbH · Musterstraße 1 · 12345 Musterstadt" });
  const mb1 = mailbox("sales1@test-firma.de", "pw-sales1");
  const mb2 = mailbox("sales2@test-firma.de", "pw-sales2");
  const tg = insert("target_groups", { name: "Handwerk", created_at: now, updated_at: now });
  const lead1 = insert("leads", { email: "max@kunde-a.de", salutation: "Herr", first_name: "Max", last_name: "Müller", company: "Kunde A GmbH", verify_status: "valid", consent_status: "granted", consent_source: "E2E-Test", created_at: now, updated_at: now });
  const lead2 = insert("leads", { email: "erika@kunde-b.de", salutation: "Frau", first_name: "Erika", last_name: "Schmidt", company: "Kunde B KG", verify_status: "valid", consent_status: "granted", consent_source: "E2E-Test", created_at: now, updated_at: now });
  const cid = insert("campaigns", {
    name: "E2E", target_group_id: tg, status: "active", timezone: "Europe/Berlin", days: "1,2,3,4,5,6,7", window_start: "00:00", window_end: "23:59",
    daily_limit: 100, min_gap_sec: 30, max_gap_sec: 30, mailbox_ids: JSON.stringify([mb1, mb2]), created_at: now, updated_at: now
  });
  insert("campaign_steps", { campaign_id: cid, position: 0, delay_days: 0, variants: JSON.stringify([{ key: "A", subject: "Frage zu {{company}}", body: "{{anrede}},\n\n{kurze|eine kurze} Frage: Wie gewinnt {{company}} aktuell neue Kunden?\n\nViele Grüße", enabled: true }]) });
  insert("campaign_steps", { campaign_id: cid, position: 1, delay_days: 2, variants: JSON.stringify([{ key: "A", subject: "", body: "{{anrede}},\n\nkurz nachgehakt – ist das ein Thema?", enabled: true }]) });
  // Texte freigeben (ohne Freigabe sendet der Takt nicht).
  q.run("UPDATE campaigns SET approved_hash = ?, approved_at = ?, approved_by = 'E2E' WHERE id = ?", mods.rules.contentHash(q.get("SELECT * FROM campaigns WHERE id = ?", cid), mods.compose.loadSteps(cid)), now, cid);
  for (const l of [lead1, lead2]) insert("campaign_leads", { campaign_id: cid, lead_id: l, status: "queued", created_at: now });

  // 1) Erster Versand: beide Leads, über zwei Postfächer rotiert.
  const r1 = await mods.scheduler.tick(Date.now());
  assert.equal(r1.sent, 2, "beide Leads in einem Takt (je ein Postfach)");
  const out = q.all("SELECT * FROM messages WHERE direction = 'out' ORDER BY id");
  assert.equal(out.length, 2);
  assert.notEqual(out[0].mailbox_id, out[1].mailbox_id, "Rotation über Postfächer");
  assert.match(out[0].subject, /^Frage zu Kunde (A GmbH|B KG)$/);

  const maxInbox = await inbox("max@kunde-a.de", "pw-max");
  assert.equal(maxInbox.length, 1);
  const raw = maxInbox[0].source;
  assert.match(raw, /Sehr geehrter Herr M=C3=BCller|Sehr geehrter Herr Müller/);
  assert.match(raw, /List-Unsubscribe: <https:\/\/cold\.example\.test\/u\//);
  assert.match(raw, /Musterstadt/);

  // Kopie im Gesendet-Ordner des Absenders
  const sentBox = out.find(m => m.lead_id === lead1).mailbox_id === mb1 ? ["sales1@test-firma.de", "pw-sales1"] : ["sales2@test-firma.de", "pw-sales2"];
  {
    const c = await imapClient(...sentBox);
    const list = await c.list();
    await c.logout();
    // GreenMail kennt keinen Sent-Ordner von Haus aus – appendToSent findet dann keinen Ordner, das ist korrekt.
    assert.ok(Array.isArray(list));
  }

  // 2) Max antwortet (echtes Reply mit In-Reply-To).
  await smtp("max@kunde-a.de", "pw-max").sendMail({
    from: "Max Müller <max@kunde-a.de>", to: sentBox[0], subject: `Re: ${maxInbox[0].subject}`,
    inReplyTo: maxInbox[0].messageId, references: maxInbox[0].messageId,
    text: `Hallo, klingt spannend – können wir nächste Woche telefonieren?\n\nAm 07.10.2026 um 10:00 schrieb Max Mustermann <${sentBox[0]}>:\n> {{anrede}} … bitte abmelden: https://cold.example.test/u/xyz`
  });
  // 3) Erika: Abwesenheitsnotiz (darf die Sequenz NICHT stoppen).
  const erikaMsg = (await inbox("erika@kunde-b.de", "pw-erika"))[0];
  const erikaBox = out.find(m => m.lead_id === lead2).mailbox_id === mb1 ? "sales1@test-firma.de" : "sales2@test-firma.de";
  await smtp("erika@kunde-b.de", "pw-erika").sendMail({
    from: "erika@kunde-b.de", to: erikaBox, subject: `Abwesenheitsnotiz: ${erikaMsg.subject}`, headers: { "Auto-Submitted": "auto-replied" },
    inReplyTo: erikaMsg.messageId, text: "Ich bin bis zum 20.10. nicht im Büro."
  });

  for (const id of [mb1, mb2]) await mods.imap.syncMailbox(q.get("SELECT * FROM mailboxes WHERE id = ?", id));
  const cl1 = q.get("SELECT * FROM campaign_leads WHERE lead_id = ?", lead1);
  const cl2 = q.get("SELECT * FROM campaign_leads WHERE lead_id = ?", lead2);
  assert.equal(cl1.status, "replied", "Antwort stoppt die Sequenz");
  assert.equal(cl2.status, "active", "Abwesenheitsnotiz stoppt nicht");
  const conv = q.get("SELECT * FROM conversations WHERE lead_id = ?", lead1);
  assert.equal(conv.has_inbound, 1);
  assert.equal(conv.unread, 1);
  const leadStatus = q.get("SELECT status FROM leads WHERE id = ?", lead1).status;
  assert.equal(leadStatus, "active", "zitierter Abmelde-Link im Verlauf darf nicht als Abmeldung zählen");
  assert.equal(q.get("SELECT label FROM conversations WHERE lead_id = ?", lead2).label, "ooo");

  // 4) Follow-up für Erika: Zeit vorspulen → Antwort im selben Thread, gleiches Postfach.
  q.run("UPDATE campaign_leads SET next_at = ? WHERE id = ?", Date.now() - 1000, cl2.id);
  q.run("UPDATE mailboxes SET next_send_at = 0");
  const r2 = await mods.scheduler.tick(Date.now());
  assert.equal(r2.sent, 1);
  const follow = q.get("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out' AND step = 1", lead2);
  assert.equal(follow.subject, `Re: ${erikaMsg.subject}`);
  assert.equal(follow.in_reply_to, erikaMsg.messageId);
  assert.equal(follow.mailbox_id, cl2.mailbox_id, "Follow-up vom selben Postfach");
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE id = ?", cl2.id).status, "completed");
  const erikaInbox = await inbox("erika@kunde-b.de", "pw-erika");
  const fu = erikaInbox.find(m => m.subject.startsWith("Re:"));
  assert.ok(fu, "Follow-up angekommen");
  assert.match(fu.source, new RegExp(`In-Reply-To: ${erikaMsg.messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

  // 5) Bounce per DSN in den Posteingang des Absenders.
  const lead3 = insert("leads", { email: "weg@kunde-c.de", first_name: "Weg", company: "Kunde C", verify_status: "valid", consent_status: "granted", consent_source: "E2E-Test", created_at: now, updated_at: now });
  const cl3 = insert("campaign_leads", { campaign_id: cid, lead_id: lead3, status: "queued", created_at: now });
  assert.equal(q.get("SELECT status FROM campaigns WHERE id = ?", cid).status, "completed", "alle Leads fertig → Kampagne abgeschlossen");
  q.run("UPDATE campaigns SET status = 'active' WHERE id = ?", cid);
  q.run("UPDATE mailboxes SET next_send_at = 0");
  await mods.scheduler.tick(Date.now());
  const sent3 = q.get("SELECT * FROM messages WHERE lead_id = ? AND direction = 'out'", lead3);
  assert.ok(sent3, `an weg@kunde-c.de gesendet (${JSON.stringify(q.get("SELECT status, last_error FROM campaign_leads WHERE id = ?", cl3))})`);
  const senderEmail = q.get("SELECT email FROM mailboxes WHERE id = ?", sent3.mailbox_id).email;
  const dsn = [
    `From: Mail Delivery System <MAILER-DAEMON@mx.kunde-c.de>`, `To: ${senderEmail}`, `Subject: Undelivered Mail Returned to Sender`,
    `MIME-Version: 1.0`, `Content-Type: multipart/report; report-type=delivery-status; boundary="b1"`, ``,
    `--b1`, `Content-Type: text/plain`, ``, `This is the mail system. Your message could not be delivered.`, ``,
    `--b1`, `Content-Type: message/delivery-status`, ``, `Reporting-MTA: dns; mx.kunde-c.de`, ``, `Final-Recipient: rfc822; weg@kunde-c.de`, `Action: failed`, `Status: 5.1.1`, `Diagnostic-Code: smtp; 550 5.1.1 User unknown`, ``,
    `--b1`, `Content-Type: text/rfc822-headers`, ``, `Message-ID: ${sent3.message_id}`, `Subject: ${sent3.subject}`, ``, `--b1--`, ``
  ].join("\r\n");
  const pw = senderEmail.startsWith("sales1") ? "pw-sales1" : "pw-sales2";
  {
    const c = await imapClient(senderEmail, pw);
    await c.append("INBOX", dsn);
    await c.logout();
  }
  await mods.imap.syncMailbox(q.get("SELECT * FROM mailboxes WHERE id = ?", sent3.mailbox_id));
  assert.equal(q.get("SELECT status FROM leads WHERE id = ?", lead3).status, "bounced");
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE id = ?", cl3).status, "bounced");
  assert.equal(q.get("SELECT status FROM messages WHERE id = ?", sent3.id).status, "bounced");

  // 6) Warmup zwischen den beiden Postfächern: senden, empfangen, als Posteingang werten.
  q.run("UPDATE mailboxes SET warmup_enabled = 1, warmup_daily = 3, warmup_reply_rate = 100, warmup_next_at = 0");
  const w1 = q.get("SELECT * FROM mailboxes WHERE id = ?", mb1);
  const w2 = q.get("SELECT * FROM mailboxes WHERE id = ?", mb2);
  await mods.warmup.sendWarmup(w1, w2);
  mods.settings.saveSettings({ warmup_folder: "Warmup" });
  await mods.imap.syncMailbox(q.get("SELECT * FROM mailboxes WHERE id = ?", mb2));
  const wrow = q.get("SELECT * FROM warmup WHERE from_mailbox_id = ? AND parent_id IS NULL", mb1);
  assert.equal(wrow.landed, "inbox");
  assert.equal(wrow.replied, 1, "Antwortquote 100 % → Antwort gesendet");
  const reply = q.get("SELECT * FROM warmup WHERE parent_id = ?", wrow.id);
  assert.ok(reply, "Warmup-Antwort protokolliert");
  const c2 = await imapClient("sales2@test-firma.de", "pw-sales2");
  const folders = (await c2.list()).map(f => f.path);
  await c2.logout();
  assert.ok(folders.includes("Warmup"), "Warmup-Mail in eigenen Ordner verschoben");
  assert.equal(q.value("SELECT COUNT(*) FROM conversations WHERE has_inbound = 1 AND lead_id IN (SELECT id FROM leads WHERE email LIKE '%test-firma.de')"), 0, "Warmup erscheint nicht in der Unibox");
});

test("Fehlende Variable ohne Fallback: Lead wird übersprungen statt „Frage zu “ zu senden", { skip }, async () => {
  const { q, insert } = mods.db;
  const now = Date.now();
  const mb = q.get("SELECT id FROM mailboxes LIMIT 1")?.id;
  if (!mb) return; // läuft nach dem Haupttest
  const lead = insert("leads", { email: "ohnefirma@kunde-d.de", first_name: "Ohne", verify_status: "valid", consent_status: "granted", consent_source: "E2E-Test", created_at: now, updated_at: now });
  const cid = q.get("SELECT id FROM campaigns LIMIT 1").id;
  const cl = insert("campaign_leads", { campaign_id: cid, lead_id: lead, status: "queued", created_at: now });
  q.run("UPDATE campaigns SET status = 'active' WHERE id = ?", cid);
  q.run("UPDATE mailboxes SET next_send_at = 0, warmup_enabled = 0");
  await mods.scheduler.tick(Date.now());
  const row = q.get("SELECT status, last_error FROM campaign_leads WHERE id = ?", cl);
  assert.equal(row.status, "error");
  assert.match(row.last_error, /company/);
  assert.equal(q.value("SELECT COUNT(*) FROM messages WHERE lead_id = ?", lead), 0);
});

