// Richtlinien: Freigabe, Rechts-Check vor dem Start, Kontaktregeln je Lead (Einwilligung, Qualität, Sperrfristen, Firmen-Limit).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeMailbox, makeLead, makeCampaign, enroll, fakeTransport, approveCampaign } from "./helpers.js";
import { q, insert } from "../src/db.js";
import { saveSettings } from "../src/settings.js";
import { loadSteps } from "../src/mail/compose.js";
import { complianceIssues, contactBlock, approvalState, contentHash } from "../src/engine/rules.js";
import { tick } from "../src/engine/scheduler.js";
import { setTransportFactory } from "../src/mail/transport.js";
import { DAY_MS } from "../src/lib/time.js";

let cleanup;
before(() => { cleanup = setupDb(); });
after(() => { setTransportFactory(null); cleanup(); });
beforeEach(() => {
  for (const t of ["tasks", "lead_fit", "campaign_leads", "campaign_steps", "campaigns", "messages", "conversations", "events", "leads", "mailboxes", "blocklist", "products"]) q.run(`DELETE FROM ${t}`);
  saveSettings({ footer_text: "Musterfirma GmbH · Musterstadt · Datenschutz: {{privacy_url}}", privacy_url: "https://hk.example/datenschutz", cooldown_days: 90, company_cap_30d: 3, skip_freemail_cold: true });
});

const campaign = id => q.get("SELECT * FROM campaigns WHERE id = ?", id);

test("Freigabe: Hash über Texte, Abstände, Nachfass-Texte und Rechtsgrundlage", () => {
  const cid = makeCampaign({ mailboxIds: [], nurture_texts: JSON.stringify([{ body: "{{anrede}}, kurz nachgehakt." }]) });
  assert.equal(approvalState(campaign(cid), loadSteps(cid)).approved, true);
  q.run("UPDATE campaign_steps SET delay_days = 7 WHERE campaign_id = ? AND position = 1", cid);
  assert.equal(approvalState(campaign(cid), loadSteps(cid)).outdated, true, "Abstand geändert → Freigabe weg");
  approveCampaign(cid);
  q.run("UPDATE campaigns SET nurture_texts = ? WHERE id = ?", JSON.stringify([{ body: "Anderer Text" }]), cid);
  assert.equal(approvalState(campaign(cid), loadSteps(cid)).approved, false, "Nachfass-Text geändert → Freigabe weg");
  approveCampaign(cid);
  q.run("UPDATE campaigns SET legal_basis = 'cold' WHERE id = ?", cid);
  assert.equal(approvalState(campaign(cid), loadSteps(cid)).approved, false, "Rechtsgrundlage geändert → Freigabe weg");
  const h = contentHash(campaign(cid), loadSteps(cid));
  q.run("UPDATE campaigns SET daily_limit = 5, name = 'Neu' WHERE id = ?", cid);
  assert.equal(contentHash(campaign(cid), loadSteps(cid)), h, "Limits und Name ändern die Freigabe nicht");
});

test("Rechts-Check: Impressum, Abmeldung, Tracking ohne Einwilligung, Re:-Betreff, Kaltakquise-Regeln, fehlende Links", () => {
  const pid = insert("products", { name: "Website", created_at: Date.now(), updated_at: Date.now() });
  const cid = makeCampaign({
    mailboxIds: [], legal_basis: "cold", product_id: pid, track_opens: 1, unsubscribe: 0,
    steps: [
      { subject: "Re: unser Gespräch", body: "{{anrede}},\n\nwie besprochen hier der Link {{termin_link}} und {{kit_link}}." },
      { subject: "", body: "x", delay: 2 }, { subject: "", body: "y" }, { subject: "", body: "z" }
    ]
  });
  saveSettings({ footer_text: "", privacy_url: "" });
  const { errors, warnings } = complianceIssues(campaign(cid), loadSteps(cid));
  const has = (list, re) => assert.ok(list.some(e => re.test(e)), `fehlt: ${re} in ${JSON.stringify(list)}`);
  has(errors, /Impressum fehlt/);
  has(errors, /Abmelde-Möglichkeit ist aus/);
  has(errors, /Datenschutzerklärung/);
  has(errors, /Tracking braucht eine Einwilligung/);
  has(errors, /bestätigen, dass das Risiko/);
  has(errors, /höchstens 3 Mails/);
  has(errors, /Re:/);
  has(errors, /Gespräch oder eine Anfrage, die es nicht gab/);
  has(errors, /kein Termin-Link/);
  has(errors, /kein Info-Kit/);
  has(warnings, /mindestens 4 Tage/);
  has(warnings, /Qualitätsfilter/);

  saveSettings({ footer_text: "Musterfirma UG · Datenschutz: {{privacy_url}}", privacy_url: "https://hk.example/datenschutz", booking_url: "https://cal.example/termin" });
  const ok = makeCampaign({ mailboxIds: [], legal_basis: "consent" });
  assert.deepEqual(complianceIssues(campaign(ok), loadSteps(ok)).errors, []);
});

test("Einwilligungs-Kampagne: nur mit dokumentierter Einwilligung; Widerruf und Sperre gelten immer", () => {
  const cid = makeCampaign({ mailboxIds: [] });
  const c = campaign(cid);
  const lead = id => q.get("SELECT * FROM leads WHERE id = ?", id);
  assert.match(contactBlock(c, lead(makeLead({ consent_status: "none" }))).reason, /Einwilligung/);
  assert.equal(contactBlock(c, lead(makeLead({ consent_status: "granted" }))), null);
  assert.equal(contactBlock(c, lead(makeLead({ consent_status: "customer" }))), null);
  assert.match(contactBlock(c, lead(makeLead({ consent_status: "revoked" })), { stepIndex: 2 }).reason, /Widerspruch/);
  assert.match(contactBlock(c, lead(makeLead({ hold_until: Date.now() + DAY_MS })), { stepIndex: 1 }).reason, /Gesperrt bis/);
});

test("Kaltakquise: keine Freemail-Adressen, nur geprüfte passende Leads, Sperrfrist und Firmen-Limit", async () => {
  const pid = insert("products", { name: "SEO", created_at: Date.now(), updated_at: Date.now() });
  const cid = makeCampaign({ mailboxIds: [], legal_basis: "cold", product_id: pid, min_fit: "B", cold_ack_at: Date.now() });
  const c = campaign(cid);
  const lead = overrides => q.get("SELECT * FROM leads WHERE id = ?", makeLead({ consent_status: "none", ...overrides }));
  assert.match(contactBlock(c, lead({ email: "max.mueller@gmail.com" })).reason, /Freemail/);
  const unchecked = lead({ email: "chef@bau-eins.de" });
  assert.match(contactBlock(c, unchecked).reason, /nicht geprüft/);
  q.run("INSERT INTO lead_fit (lead_id, product_id, fit, reason, checked_at) VALUES (?, ?, 'C', 'Zu klein', ?)", unchecked.id, pid, Date.now());
  assert.match(contactBlock(c, unchecked).reason, /Passt nicht gut genug \(C\): Zu klein/);
  q.run("UPDATE lead_fit SET fit = 'B' WHERE lead_id = ?", unchecked.id);
  assert.equal(contactBlock(c, unchecked), null);

  // Sperrfrist: schon von einer anderen Kampagne angeschrieben.
  insert("messages", { lead_id: unchecked.id, direction: "out", kind: "campaign", step: 0, to_addr: unchecked.email, status: "sent", created_at: Date.now() - 10 * DAY_MS });
  assert.match(contactBlock(c, unchecked).reason, /vor weniger als 90 Tagen/);

  // Firmen-Limit: 3 Kollegen derselben Domain in 30 Tagen → vierter wartet (nicht endgültig).
  for (let i = 0; i < 3; i++) {
    const colleague = makeLead({ email: `k${i}@gross-firma.de` });
    insert("messages", { lead_id: colleague, direction: "out", kind: "campaign", step: 0, to_addr: `k${i}@gross-firma.de`, status: "sent", created_at: Date.now() - DAY_MS });
  }
  const fourth = lead({ email: "k4@gross-firma.de" });
  q.run("INSERT INTO lead_fit (lead_id, product_id, fit, checked_at) VALUES (?, ?, 'A', ?)", fourth.id, pid, Date.now());
  const block = contactBlock(c, fourth);
  assert.match(block.reason, /Schon 3 Kontakte dieser Firma/);
  assert.equal(block.final, false);
  assert.ok(block.retryAt > Date.now());
});

test("Versand wendet die Regeln an und protokolliert den Grund", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const cid = makeCampaign({ mailboxIds: [makeMailbox(), makeMailbox()] });
  const ok = enroll(cid, makeLead());
  const noConsent = enroll(cid, makeLead({ consent_status: "none" }));
  await tick();
  assert.equal(ft.sent.length, 1);
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE id = ?", ok).status, "active");
  const skipped = q.get("SELECT * FROM campaign_leads WHERE id = ?", noConsent);
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.last_error, /Einwilligung/);
});

test("Nicht freigegebene Kampagne wird angehalten statt zu senden", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const cid = makeCampaign({ mailboxIds: [makeMailbox()], approved: false });
  enroll(cid, makeLead());
  await tick();
  assert.equal(ft.sent.length, 0);
  assert.equal(campaign(cid).status, "paused");
});
