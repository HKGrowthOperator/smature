// Nativ nachgebaute Make-Szenarien: Notiz mit #nomail/#blacklist sperrt, Klick auf einen Link erzeugt einen heißen Anruf.
// Dazu: Einstiegsangebote/Sequenz-Aufbau aus dem Coaching, der Rechts-Check gegen Schein-Termin-Betreffs, geteilte Zielgruppen
// und der Ausschluss des rechtlichen Umfelds aus der Kaltakquise.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeCampaign, makeMailbox, makeLead, enroll } from "./helpers.js";
import { createApp } from "../src/app.js";
import { ensureAdmin } from "../src/auth.js";
import { q, insert } from "../src/db.js";
import { hmac } from "../src/crypto.js";
import { ensureAccountForLead } from "../src/intel/accounts.js";
import { createTask } from "../src/engine/followup.js";
import { noteTags } from "../src/engine/noteTags.js";
import { complianceIssues, legalRiskHit } from "../src/engine/rules.js";
import { loadSteps } from "../src/mail/compose.js";
import { sequenceRoles, OFFER_TYPES } from "../src/ai/features.js";
import { saveSettings } from "../src/settings.js";

let cleanup, server, base, api;

before(async () => {
  cleanup = setupDb({ ADMIN_EMAIL: "admin@test.de", ADMIN_PASSWORD: "ein-langes-passwort" });
  ensureAdmin();
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
after(async () => { await new Promise(r => server.close(r)); cleanup(); });

const leadWithAccount = overrides => {
  const id = makeLead(overrides);
  ensureAccountForLead(q.get("SELECT * FROM leads WHERE id = ?", id));
  return q.get("SELECT * FROM leads WHERE id = ?", id);
};

test("Schlagwörter werden erkannt – aber nicht in Wörtern oder E-Mail-Adressen", () => {
  assert.deepEqual(noteTags("will keine Mails #nomail"), { nomail: true, blacklist: false });
  assert.deepEqual(noteTags("#Blacklist – nie wieder"), { nomail: false, blacklist: true });
  assert.deepEqual(noteTags("info#nomail@x.de, Kanal#blacklist"), { nomail: false, blacklist: false });
});

test("#nomail in der Aufgaben-Notiz: keine Mails mehr an diese Person", async () => {
  const mb = makeMailbox();
  const lead = leadWithAccount({ email: "max@nomail-firma.de", phone: "0221 123" });
  const cid = makeCampaign({ mailboxIds: [mb] });
  enroll(cid, lead.id);
  const task = createTask({ type: "todo", lead_id: lead.id, title: "Rückfrage klären" });
  const r = await api(`/api/tasks/${task}/outcome`, { method: "POST", body: { outcome: "callback", callback_at: Date.now() + 86400000, notes: "Will keine Mails mehr #nomail" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.note_tags, ["nomail"]);
  assert.ok(q.get("SELECT 1 FROM blocklist WHERE value = 'max@nomail-firma.de'"), "Adresse gesperrt");
  assert.ok(!q.get("SELECT 1 FROM blocklist WHERE value = 'nomail-firma.de'"), "Domain nicht gesperrt");
  assert.equal(q.value("SELECT status FROM campaign_leads WHERE lead_id = ?", lead.id), "stopped");
  assert.equal(q.value("SELECT do_not_contact FROM account_people WHERE lead_id = ?", lead.id) || 0, 0, "Person bleibt in der Firma (Nummer für die Sales App)");
  const notes = () => q.value("SELECT COUNT(*) FROM account_memory WHERE account_id = ? AND text LIKE '#nomail:%'", lead.account_id);
  assert.equal(notes(), 1);
  // Erneut speichern löst nicht doppelt aus
  await api(`/api/tasks/${task}/outcome`, { method: "POST", body: { outcome: "callback", callback_at: Date.now() + 86400000, notes: "nochmal #nomail" } });
  assert.equal(notes(), 1);
});

test("#blacklist im Firmenprofil: ganze Firma gesperrt, alle Aufgaben weg", async () => {
  const a = leadWithAccount({ email: "chef@sperr-gmbh.de" });
  const b = makeLead({ email: "vertrieb@sperr-gmbh.de" });
  ensureAccountForLead(q.get("SELECT * FROM leads WHERE id = ?", b));
  const accountId = a.account_id;
  assert.equal(q.value("SELECT account_id FROM leads WHERE id = ?", b), accountId);
  const t1 = createTask({ type: "todo", lead_id: b, title: "Rückfrage" });
  const r = await api(`/api/accounts/${accountId}/memory`, { method: "POST", body: { kind: "note", text: "Hat sich beschwert, nie wieder #blacklist" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.note_tags, ["blacklist"]);
  assert.ok(q.get("SELECT 1 FROM blocklist WHERE value = 'sperr-gmbh.de' AND kind = 'domain'"));
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = ?", accountId), "suppressed");
  assert.equal(q.value("SELECT COUNT(*) FROM leads WHERE account_id = ? AND consent_status = 'revoked'", accountId), 2);
  assert.equal(q.value("SELECT status FROM tasks WHERE id = ?", t1), "dismissed");
  assert.equal(q.value("SELECT COUNT(*) FROM account_people WHERE account_id = ? AND do_not_contact = 0", accountId), 0);
});

test("#nomail am Lead nur beim ersten Setzen", async () => {
  const lead = leadWithAccount({ email: "lead@notiz-firma.de" });
  const r1 = await api(`/api/leads/${lead.id}`, { method: "PUT", body: { notes: "Mag keine Mails #nomail" } });
  assert.deepEqual(r1.json.note_tags, ["nomail"]);
  const r2 = await api(`/api/leads/${lead.id}`, { method: "PUT", body: { notes: "Mag keine Mails #nomail – ruft zurück" } });
  assert.deepEqual(r2.json.note_tags, []);
});

test("Klick auf einen Link (Einwilligungs-Kampagne) → Lead ist „Warm“ für die Sales App, keine Anruf-Aufgabe", async () => {
  saveSettings({ booking_url: "https://termin.example.de/buchen" });
  const mb = makeMailbox();
  const lead = leadWithAccount({ email: "klick@warm-firma.de" });
  const cid = makeCampaign({ mailboxIds: [mb], track_clicks: 1 });
  insert("messages", { lead_id: lead.id, campaign_id: cid, mailbox_id: mb, direction: "out", kind: "campaign", token: "clickTOKEN112233", created_at: Date.now() - 60000 });
  const url = "https://termin.example.de/buchen?x=1";
  const click = token => fetch(`${base}/t/c/${token}?u=${encodeURIComponent(url)}&s=${hmac(`${token}|${url}`, "click")}`, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
  assert.equal((await click("clickTOKEN112233")).status, 302);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(q.value("SELECT COUNT(*) FROM tasks WHERE lead_id = ?", lead.id), 0, "keine Anruf-Aufgabe – telefoniert wird in der Sales App");
  const warm = await api("/api/leads?status=warm&limit=500");
  assert.ok(warm.json.items.some(l => l.id === lead.id), "Klick macht den Lead „Warm“");

  // Abgemeldeter Kontakt klickt → kein Anruf
  const gone = leadWithAccount({ email: "weg@kalt-firma.de", status: "unsubscribed" });
  insert("messages", { lead_id: gone.id, campaign_id: cid, mailbox_id: mb, direction: "out", kind: "campaign", token: "clickTOKEN445566", created_at: Date.now() - 60000 });
  await click("clickTOKEN445566");
  await new Promise(r => setTimeout(r, 50));
  assert.equal(q.value("SELECT COUNT(*) FROM tasks WHERE lead_id = ?", gone.id), 0);
});

test("Sequenz-Aufbau aus dem Coaching: Eskalation mit festen Rollen, Einstiegsangebote", () => {
  assert.deepEqual(sequenceRoles(5), ["entry", "reminder", "aspect", "relevance", "breakup"]);
  assert.deepEqual(sequenceRoles(3), ["entry", "aspect", "breakup"]);
  assert.deepEqual(sequenceRoles(1), ["entry"]);
  assert.ok(OFFER_TYPES.deliverable && OFFER_TYPES.funding && OFFER_TYPES.question);
  assert.match(OFFER_TYPES.deliverable.hint, /nie behaupten/);
});

test("Rechts-Check: Coaching-Betreffs wie „Meeting {{first_name}} & Julia“ sind in Kaltmails irreführend", () => {
  saveSettings({ footer_text: "Muster GmbH · Musterstr. 1 · 12345 Musterstadt", privacy_url: "https://x.de/datenschutz" });
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb], legal_basis: "cold", approved: false, steps: [{ subject: "Meeting {{first_name}} & Julia", body: "{{anrede}},\n\nkurze Frage.\n\nViele Grüße" }] });
  const issues = complianceIssues(q.get("SELECT * FROM campaigns WHERE id = ?", cid), loadSteps(cid));
  assert.ok(issues.errors.some(e => /täuscht einen vereinbarten Termin/.test(e)));
  const ok = makeCampaign({ mailboxIds: [mb], legal_basis: "cold", approved: false, steps: [{ subject: "Frage zu {{company}}", body: "{{anrede}},\n\nkurze Frage.\n\nViele Grüße" }] });
  assert.ok(!complianceIssues(q.get("SELECT * FROM campaigns WHERE id = ?", ok), loadSteps(ok)).errors.some(e => /täuscht/.test(e)));
});

test("Filter „Warm“ für die Übergabe an die Sales App (CSV)", async () => {
  const hot = leadWithAccount({ email: "warm@export-firma.de", phone: "0221 9", company: "Export GmbH" });
  const cold = leadWithAccount({ email: "kalt@export-firma2.de" });
  insert("conversations", { lead_id: hot.id, label: "interested", last_at: Date.now(), created_at: Date.now(), has_inbound: 1 });
  const r = await api("/api/leads?status=warm&limit=500");
  const emails = r.json.items.map(l => l.email);
  assert.ok(emails.includes("warm@export-firma.de"));
  assert.ok(!emails.includes(cold.email));
  const csv = await api("/api/leads/export?status=warm");
  assert.match(csv.text, /warm@export-firma\.de/);
  assert.match(csv.text, /Export GmbH/);
});

test("Geteilte Zielgruppe: gilt in Webseite und Webseite/Automation, Listen erscheinen in beiden Spalten", async () => {
  const projects = (await api("/api/projects")).json;
  const web = projects.find(p => p.slug === "webseite").id, auto = projects.find(p => p.slug === "webseite-automation").id;
  const tg = (await api("/api/target-groups", { method: "POST", body: { name: "Geteilt – Website-Betriebe", project_id: web, also_project_ids: [auto, web, auto] } })).json;
  assert.deepEqual(tg.also_project_ids, [auto], "Hauptprojekt und Dubletten fallen raus");
  insert("lead_lists", { name: "Geteilte Liste", target_group_id: tg.id, project_id: web, created_at: Date.now() });
  const board = (await api("/api/projects/board")).json.columns;
  const col = id => board.find(c => c.project.id === id);
  assert.ok(col(web).target_groups.some(g => g.id === tg.id && !g.shared));
  assert.ok(col(auto).target_groups.some(g => g.id === tg.id && g.shared));
  assert.ok(col(auto).lists.some(l => l.name === "Geteilte Liste"));
  assert.equal((await api(`/api/target-groups/${tg.id}`, { method: "PUT", body: { also_project_ids: "x" } })).status, 400);
  const cleared = (await api(`/api/target-groups/${tg.id}`, { method: "PUT", body: { also_project_ids: [] } })).json;
  assert.deepEqual(cleared.also_project_ids, []);
});

test("Kaltakquise nie ins rechtliche Umfeld: Kanzleien, Abmahnvereine, Kammern … werden nicht aufgenommen", async () => {
  const hit = company => legalRiskHit({ company, email: "info@firma.de" }, { cold_exclude_terms: "" });
  for (const c of ["Rechtsanwälte Meier & Partner", "Steuerkanzlei Schulz", "Notariat am Markt", "IHK Köln", "Verbraucherzentrale NRW", "Datenschutz Nord GmbH", "Steuerberatung Krause", "Fachanwalt für Arbeitsrecht Weber"]) assert.ok(hit(c), c);
  for (const c of ["Albrecht Bedachungen GmbH", "Notarztdienst Oberberg", "Weihkraft Elektro", "Autohaus Recht & Söhne", "Gebr. Koch GmbH"]) assert.equal(hit(c), null, c);
  assert.ok(legalRiskHit({ company: "Muster", email: "info@kanzlei-muster.de" }, {}), "auch über die E-Mail-Domain");
  assert.match(legalRiskHit({ company: "Allianz Versicherungsbüro" }, { cold_exclude_terms: "versicherung, makler" }), /eigener Ausschluss/);

  saveSettings({ cold_exclude_terms: "" });
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb], legal_basis: "cold", status: "draft" });
  const lawyer = makeLead({ email: "info@ra-meier-test.de", company: "Rechtsanwälte Meier" });
  const roofer = makeLead({ email: "info@dach-test.de", company: "Dachbau Test GmbH" });
  const r = await api(`/api/campaigns/${cid}/leads`, { method: "POST", body: { lead_ids: [lawyer, roofer] } });
  assert.equal(r.json.added, 1);
  assert.ok(Object.keys(r.json.reasons).some(k => /Rechtliches Umfeld/.test(k)), JSON.stringify(r.json.reasons));
  // Mit Einwilligung (z. B. Anfrage einer Kanzlei) bleibt der Kontakt erlaubt
  const consentCid = makeCampaign({ mailboxIds: [mb], legal_basis: "consent", status: "draft" });
  q.run("UPDATE leads SET consent_status = 'granted', consent_source = 'Anfrage' WHERE id = ?", lawyer);
  assert.equal((await api(`/api/campaigns/${consentCid}/leads`, { method: "POST", body: { lead_ids: [lawyer] } })).json.added, 1);
});

test("Projekte sauber getrennt: Import in eine Projekt-Liste ordnet die Firmen zu, fremde Kampagnen nehmen sie nicht auf", async () => {
  const projects = (await api("/api/projects")).json;
  const web = projects.find(p => p.slug === "webseite").id, sales = projects.find(p => p.slug === "software-sales-app").id;
  const csv = "email;firma\ninfo@trenn-web-1.de;Trenn Web 1\ninfo@trenn-web-2.de;Trenn Web 2";
  const imp = await api("/api/leads/import", { method: "POST", body: { csv, new_list_name: "Trennung Webseite", project_id: web } });
  assert.equal(imp.json.imported, 2);
  assert.equal(imp.json.accounts_assigned, 2);
  const ids = q.all("SELECT id FROM leads WHERE email LIKE 'info@trenn-web-%'").map(r => r.id);
  assert.equal(q.value("SELECT COUNT(*) FROM accounts WHERE project_id = ? AND id IN (SELECT account_id FROM leads WHERE email LIKE 'info@trenn-web-%')", web), 2);
  assert.equal((await api(`/api/leads?project=${web}&q=trenn-web`)).json.total, 2);
  assert.equal((await api(`/api/leads?project=${sales}&q=trenn-web`)).json.total, 0);

  const product = insert("products", { name: "Trenn-Produkt", project_id: sales, created_at: Date.now(), updated_at: Date.now() });
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb], product_id: product, status: "draft", legal_basis: "cold" });
  const r = await api(`/api/campaigns/${cid}/leads`, { method: "POST", body: { lead_ids: ids } });
  assert.equal(r.json.added, 0);
  assert.ok(Object.keys(r.json.reasons).some(k => /gehört zu Projekt „Webseite“/.test(k)), JSON.stringify(r.json.reasons));
  // Bewusst umsortieren: dann passt es
  await api("/api/leads/bulk", { method: "POST", body: { action: "set_project", ids: [ids[0]], project_id: sales } });
  assert.equal((await api(`/api/campaigns/${cid}/leads`, { method: "POST", body: { lead_ids: ids } })).json.added, 1);
});
