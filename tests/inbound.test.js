// Einordnung eingehender Mails mit realistischen Rohnachrichten.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { setupDb, makeMailbox, makeLead, makeCampaign, enroll, fakeTransport } from "./helpers.js";
import { setTransportFactory } from "../src/mail/transport.js";
import { ensureAccountForLead } from "../src/intel/accounts.js";
import "../src/engine/noteTags.js"; // registriert die Sperre bei rechtlicher Reaktion
import "../src/engine/followup.js"; // registriert „kein Interesse“
import { sendManualReply } from "../src/engine/sender.js";
import { analyzeInbound, parseBounce, processInbound, wantsUnsubscribe, legalThreat, noInterest } from "../src/mail/inbound.js";
import { stripQuoted, htmlToText } from "../src/lib/text.js";
import { q, insert } from "../src/db.js";

let cleanup;
before(() => { cleanup = setupDb(); });
after(() => cleanup());

const mail = lines => simpleParser(Buffer.from(lines.join("\r\n")));

test("Postfix-DSN (multipart/report) → harter Bounce mit Empfänger und Original-Message-ID", async () => {
  const p = await mail([
    "From: MAILER-DAEMON@mx.example.de (Mail Delivery System)", "To: max@test-firma.de", "Subject: Undelivered Mail Returned to Sender",
    "MIME-Version: 1.0", 'Content-Type: multipart/report; report-type=delivery-status; boundary="XYZ"', "",
    "--XYZ", "Content-Type: text/plain", "", "I'm sorry to have to inform you that your message could not be delivered.", "",
    "--XYZ", "Content-Type: message/delivery-status", "", "Reporting-MTA: dns; mx.example.de", "", "Final-Recipient: rfc822; gibtsnicht@example.de", "Action: failed", "Status: 5.1.1", "Diagnostic-Code: smtp; 550 5.1.1 <gibtsnicht@example.de>: Recipient address rejected: User unknown", "",
    "--XYZ", "Content-Type: text/rfc822-headers", "", "Message-ID: <orig123@test-firma.de>", "Subject: Frage", "", "--XYZ--", ""
  ]);
  const b = parseBounce(p);
  assert.equal(b.kind, "hard");
  assert.deepEqual(b.recipients, ["gibtsnicht@example.de"]);
  assert.equal(b.originalMessageId, "<orig123@test-firma.de>");
  assert.equal(b.status, "5.1.1");
});

test("Gmail-Bounce im Klartext und Verzögerungsmeldung", async () => {
  const p = await mail(["From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>", "To: a@b.de", "Subject: Delivery Status Notification (Failure)", "", "Address not found", "", "Your message wasn't delivered to weg@firma.de because the address couldn't be found.", "", "The response was: 550 5.1.1 The email account that you tried to reach does not exist."]);
  const b = parseBounce(p);
  assert.equal(b.kind, "hard");
  assert.ok(b.recipients.includes("weg@firma.de"));
  const delay = await mail(["From: MAILER-DAEMON@x.de", "To: a@b.de", "Subject: Delayed Mail (still being retried)", "MIME-Version: 1.0", 'Content-Type: multipart/report; report-type=delivery-status; boundary="b"', "", "--b", "Content-Type: message/delivery-status", "", "Final-Recipient: rfc822; x@y.de", "Action: delayed", "Status: 4.4.1", "", "--b--"]);
  assert.equal(parseBounce(delay).kind, "delay");
});

test("Abwesenheitsnotizen werden erkannt (Header, Betreff, Text)", async () => {
  assert.equal(analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Re: Frage", "Auto-Submitted: auto-replied", "", "Bin weg."])).type, "auto_reply");
  assert.equal(analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Abwesenheitsnotiz: Frage zu Müller GmbH", "", "Ich bin bis 20.10. nicht im Büro."])).type, "auto_reply");
  assert.equal(analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Re: Frage", "", "Vielen Dank für Ihre Nachricht. Ich bin derzeit im Urlaub und ab dem 14.10. wieder erreichbar."])).type, "auto_reply");
  assert.equal(analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Automatische Antwort: Frage", "X-Auto-Response-Suppress: All", "", "Danke."])).type, "auto_reply");
});

test("Echte Antwort, Abmelde-Wunsch, zitierter Abmelde-Link zählt nicht", async () => {
  const reply = analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Re: Frage", "", "Klingt gut, rufen Sie mich an.", "", "Am 07.10.2026 um 10:00 schrieb Max <l@hk.de>:", "> Kein Interesse? Hier abmelden: https://x/u/abc"]));
  assert.equal(reply.type, "reply");
  assert.equal(reply.unsubscribe, false);
  assert.equal(analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Re: Frage", "", "Bitte nehmen Sie mich aus dem Verteiler."])).unsubscribe, true);
  assert.equal(wantsUnsubscribe("Bitte keine weiteren E-Mails."), true);
  assert.equal(wantsUnsubscribe("Gern mehr Infos per E-Mail."), false);
});

test("Zitat-Entfernung für gängige Mailprogramme", () => {
  assert.equal(stripQuoted("Danke!\n\nOn Mon, Oct 5, 2026 at 9:00 AM Max <l@hk.de> wrote:\n> alt"), "Danke!");
  assert.equal(stripQuoted("Ja gern.\n\n-----Ursprüngliche Nachricht-----\nVon: Max"), "Ja gern.");
  assert.equal(stripQuoted("Passt.\n\nVon: Max Mustermann <l@hk.de>\nGesendet: Montag, 5. Oktober 2026 09:00\nAn: x"), "Passt.");
  assert.equal(stripQuoted("Hallo\n> zitiert\nweiter"), "Hallo\nweiter");
});

test("Verarbeitung: Antwort stoppt Sequenz, stoppt Kollegen derselben Firma, Gespräch in Unibox", async () => {
  const mb = q.get("SELECT * FROM mailboxes WHERE id = ?", makeMailbox());
  const l1 = makeLead({ email: "max@dachbau.de" });
  const l2 = makeLead({ email: "anna@dachbau.de" });
  const l3 = makeLead({ email: "x@gmail.com" });
  const cid = makeCampaign({ mailboxIds: [mb.id] });
  const cl1 = enroll(cid, l1, { status: "active", step: 1 });
  const cl2 = enroll(cid, l2, { status: "queued" });
  enroll(cid, l3, { status: "queued" });
  const conv = insert("conversations", { mailbox_id: mb.id, lead_id: l1, campaign_id: cid, campaign_lead_id: cl1, subject: "Frage", last_at: Date.now(), created_at: Date.now() });
  insert("messages", { conversation_id: conv, mailbox_id: mb.id, lead_id: l1, campaign_id: cid, campaign_lead_id: cl1, step: 0, variant: "A", direction: "out", kind: "campaign", message_id: "<m1@test-firma.de>", to_addr: "max@dachbau.de", subject: "Frage", created_at: Date.now() });
  const p = await mail(["From: Max <max@dachbau.de>", `To: ${mb.email}`, "Subject: Re: Frage", "Message-ID: <r1@dachbau.de>", "In-Reply-To: <m1@test-firma.de>", "", "Ja, interessant."]);
  const res = processInbound(mb, p);
  assert.equal(res.type, "reply");
  assert.equal(res.conversationId, conv);
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE id = ?", cl1).status, "replied");
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE id = ?", cl2).status, "stopped");
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE lead_id = ?", l3).status, "queued", "Freemail-Domains stoppen keine anderen");
  const c = q.get("SELECT * FROM conversations WHERE id = ?", conv);
  assert.equal(c.has_inbound, 1);
  assert.equal(c.unread, 1);
  assert.equal(q.value("SELECT COUNT(*) FROM events WHERE type = 'reply' AND lead_id = ?", l1), 1);
  assert.equal(processInbound(mb, p).type, "duplicate", "gleiche Message-ID wird nicht doppelt verarbeitet");
  // Fremde Mail (kein Lead) wird ignoriert
  assert.equal(processInbound(mb, await mail(["From: news@shop.de", "To: x@y.de", "Subject: Angebot", "", "Hallo"])).type, "ignored");
});

test("Alles landet in der App: direkte Mail eines Unbekannten wird Kontakt, Newsletter/System bleiben draußen", async () => {
  const mb = q.get("SELECT * FROM mailboxes WHERE id = ?", makeMailbox({ email: "webseiten@hk-direkt.de" }));
  const direct = await mail(["From: Petra Neu <p.neu@baeckerei-neu.de>", `To: ${mb.email}`, "Subject: Anfrage Website", "Message-ID: <d1@baeckerei-neu.de>", "", "Hallo, wir brauchen eine neue Website. Können Sie anrufen?"]);
  const res = processInbound(mb, direct);
  assert.equal(res.type, "reply");
  const lead = q.get("SELECT * FROM leads WHERE email = 'p.neu@baeckerei-neu.de'");
  assert.equal(`${lead.first_name} ${lead.last_name}`, "Petra Neu");
  assert.equal(lead.source, "Posteingang");
  assert.equal(lead.consent_status, "none", "keine Einwilligung unterstellt");
  const conv = q.get("SELECT * FROM conversations WHERE id = ?", res.conversationId);
  assert.equal(conv.has_inbound, 1);
  assert.equal(conv.campaign_id, null);
  for (const lines of [
    ["From: noreply@kasserver.com", "To: x@y.de", "Subject: Info", "", "Wartung"],
    ["From: hallo@shop.de", "To: x@y.de", "Subject: Angebote", "List-Unsubscribe: <https://shop.de/u>", "", "Rabatt"],
    ["From: x@agentur.de", "To: x@y.de", "Subject: Abwesend", "Auto-Submitted: auto-replied", "", "Bin weg"]
  ]) assert.equal(processInbound(mb, await mail(lines)).type, "ignored", lines[0]);
  assert.equal(q.value("SELECT COUNT(*) FROM leads WHERE source = 'Posteingang'"), 1);
});

test("Antwort aus der App geht an den, der zuletzt geschrieben hat (Kollege statt angeschriebener Adresse)", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const mb = q.get("SELECT * FROM mailboxes WHERE id = ?", makeMailbox());
  const lead = q.get("SELECT * FROM leads WHERE id = ?", makeLead({ email: "info@kollegen-test.de" }));
  const conv = insert("conversations", { mailbox_id: mb.id, lead_id: lead.id, subject: "Frage", last_at: Date.now(), created_at: Date.now() });
  insert("messages", { conversation_id: conv, mailbox_id: mb.id, lead_id: lead.id, direction: "out", kind: "campaign", message_id: "<k1@test-firma.de>", to_addr: lead.email, subject: "Frage", created_at: Date.now() - 1000 });
  processInbound(mb, await mail(["From: Chef <chef@kollegen-test.de>", `To: ${mb.email}`, "Subject: Re: Frage", "Message-ID: <k2@kollegen-test.de>", "In-Reply-To: <k1@test-firma.de>", "", "Ich bin zuständig, melden Sie sich gern."]));
  await sendManualReply({ conversation: q.get("SELECT * FROM conversations WHERE id = ?", conv), mailbox: mb, lead, text: "Gern, wann passt es Ihnen?" });
  assert.match(ft.sent.at(-1).raw, /^To: chef@kollegen-test\.de/m);
  assert.equal(q.value("SELECT to_addr FROM messages WHERE conversation_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", conv), "chef@kollegen-test.de");
  setTransportFactory(null);
});

test("Nie wieder schreiben: Abmeldung, Absage und Rechtsdrohung werden ohne KI erkannt", () => {
  for (const t of ["Schreiben Sie mir nie wieder!", "Bitte lassen Sie uns in Ruhe.", "Das ist Spam.", "Unterlassen Sie diese Mails.", "Ich verbitte mir unerwünschte Werbung."]) assert.equal(wantsUnsubscribe(t), true, t);
  for (const t of ["Ihre Mail landete im Spam-Ordner, aber klingt gut.", "Gern wieder melden, wenn es Neuigkeiten gibt."]) assert.equal(wantsUnsubscribe(t), false, t);
  for (const t of ["Ich werde Sie abmahnen lassen.", "Woher haben Sie meine Adresse?", "Ich verlange Auskunft nach Art. 15 DSGVO.", "Das gebe ich meinem Anwalt."]) assert.equal(legalThreat(t), true, t);
  assert.equal(legalThreat("Können Sie mir Auskunft über die Kosten geben?"), false);
  for (const t of ["Kein Interesse, danke.", "Wir haben aktuell keinen Bedarf.", "Brauchen wir nicht."]) assert.equal(noInterest(t), true, t);
  assert.equal(noInterest("Klingt interessant, rufen Sie an."), false);
});

test("Absage per Mail: Firma bekommt nie wieder Mails; Rechtsdrohung sperrt alles und legt eine dringende Aufgabe an", async () => {
  const mb = q.get("SELECT * FROM mailboxes WHERE id = ?", makeMailbox());
  const reply = (from, text) => mail([`From: ${from}`, `To: ${mb.email}`, "Subject: Re: Frage", `Message-ID: <${Math.random().toString(36).slice(2)}@x.de>`, "", text]);
  const no = makeLead({ email: "info@absage-test.de", consent_status: "none" });
  const colleague = makeLead({ email: "vertrieb@absage-test.de", consent_status: "none" });
  const cid = makeCampaign({ mailboxIds: [mb.id], legal_basis: "cold" });
  enroll(cid, colleague, { status: "queued" });
  processInbound(mb, await reply("info@absage-test.de", "Danke, aber kein Interesse."));
  assert.ok(q.get("SELECT 1 FROM blocklist WHERE value = 'absage-test.de' AND kind = 'domain'"), "ganze Firma gesperrt");
  assert.equal(q.value("SELECT label FROM conversations WHERE lead_id = ?", no), "not_interested");
  assert.ok(q.value("SELECT hold_until FROM leads WHERE id = ?", no) > Date.now(), "Anrufe ruhen");
  assert.notEqual(q.value("SELECT status FROM campaign_leads WHERE lead_id = ?", colleague), "queued", "Kollege bekommt keine Mail mehr");

  const angry = makeLead({ email: "chef@abmahn-test.de", company: "Abmahn Test GmbH", consent_status: "none" });
  ensureAccountForLead(angry);
  processInbound(mb, await reply("chef@abmahn-test.de", "Woher haben Sie meine Daten? Ich verlange Auskunft nach DSGVO."));
  assert.equal(q.value("SELECT status FROM leads WHERE id = ?", angry), "unsubscribed");
  assert.ok(q.get("SELECT 1 FROM blocklist WHERE value = 'abmahn-test.de'"));
  const task = q.get("SELECT * FROM tasks WHERE lead_id = ? AND status = 'open'", angry);
  assert.ok(task, "dringende Aufgabe");
  assert.equal(task.priority, 500);
  assert.match(task.notes, /Art\. 15 DSGVO/);
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = (SELECT account_id FROM leads WHERE id = ?)", angry), "suppressed");
});

test("Verarbeitung: Bounce ohne Original-ID über Empfängeradresse", async () => {
  const mb = q.get("SELECT * FROM mailboxes WHERE id = ?", makeMailbox());
  const lead = makeLead({ email: "weg@bounce-firma.de" });
  const cid = makeCampaign({ mailboxIds: [mb.id] });
  const cl = enroll(cid, lead, { status: "active", step: 1 });
  insert("messages", { mailbox_id: mb.id, lead_id: lead, campaign_id: cid, campaign_lead_id: cl, step: 0, direction: "out", kind: "campaign", message_id: "<b1@hk>", to_addr: "weg@bounce-firma.de", subject: "x", created_at: Date.now() });
  const p = await mail(["From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>", `To: ${mb.email}`, "Subject: Delivery Status Notification (Failure)", "", "Your message wasn't delivered to weg@bounce-firma.de because the address couldn't be found.", "550 5.1.1 does not exist"]);
  const res = processInbound(mb, p);
  assert.equal(res.type, "bounce");
  assert.equal(res.hard, true);
  assert.equal(q.get("SELECT status FROM leads WHERE id = ?", lead).status, "bounced");
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE id = ?", cl).status, "bounced");
});

test("Keine falschen Abmeldungen; Betreff „Abmelden“ ohne Text zählt", async () => {
  assert.equal(wantsUnsubscribe("Interessant, bisher machen wir keine Werbung über Google. Rufen Sie mich an."), false);
  assert.equal(wantsUnsubscribe("Ich habe keine Nachrichten von Ihnen bekommen, schicken Sie es nochmal?"), false);
  assert.equal(wantsUnsubscribe("Ich möchte keine weiteren Mails erhalten."), true);
  assert.equal(wantsUnsubscribe("Bitte kontaktieren Sie mich nicht mehr."), true, "auch diese Wortstellung heißt: nie wieder");
  assert.equal(wantsUnsubscribe("bitte nicht mehr anschreiben"), true);
  const empty = analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Abmelden", "", ""]));
  assert.equal(empty.type, "reply");
  assert.equal(empty.unsubscribe, true);
});

test("Echte Antwort auf einen Betreff mit „Urlaub“/„Ticket“ ist keine Abwesenheitsnotiz", async () => {
  assert.equal(analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Re: Mehr Buchungen für Ihre Ferienwohnung – Urlaub neu gedacht", "", "Klingt spannend, was kostet das?"])).type, "reply");
  assert.equal(analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: AW: Ihr Support-Ticket created", "", "Ja, gern."])).type, "reply");
  assert.equal(analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Automatische Antwort: Re: Urlaub neu gedacht", "", "Danke."])).type, "auto_reply");
  assert.equal(analyzeInbound(await mail(["From: a@b.de", "To: c@d.de", "Subject: Re: Zoom statt Tool", "", "Gern."])).type, "reply", "„ooo“ nur als eigenes Wort");
});

test("Präparierte Mails blockieren nicht (lineare Laufzeit)", () => {
  const t0 = Date.now();
  stripQuoted("\n".repeat(400000) + "x");
  stripQuoted(("am " + "x".repeat(300) + "\n").repeat(5000));
  htmlToText("<head ".repeat(60000));
  htmlToText("<".repeat(300000));
  assert.ok(Date.now() - t0 < 1500, `zu langsam: ${Date.now() - t0} ms`);
  assert.equal(stripQuoted("Ja gerne\n\nAm 05.10.2026 um 10:00 schrieb Max Mustermann <\nmax@x.de>:\n> alt"), "Ja gerne");
  assert.equal(htmlToText("<html><head><title>x</title></head><body><p>Hallo&nbsp;Welt</p><script>x()</script><br>Ende</body>"), "Hallo Welt\n\nEnde");
});
