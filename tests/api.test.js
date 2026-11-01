// HTTP-API: Login, CSRF, Rechte, Postfach-Passwörter, Import, Kampagne, Abmelden, Tracking, DSGVO-Löschung, Pfadschutz.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeMailbox, makeLead, makeCampaign } from "./helpers.js";
import { createApp } from "../src/app.js";
import { ensureAdmin } from "../src/auth.js";
import { q, insert } from "../src/db.js";
import { hmac } from "../src/crypto.js";

let cleanup, server, base;
before(async () => {
  cleanup = setupDb({ ADMIN_EMAIL: "admin@test.de", ADMIN_PASSWORD: "ein-langes-passwort" });
  ensureAdmin();
  server = createApp();
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(r => server.close(r)); cleanup(); });

async function login(email = "admin@test.de", password = "ein-langes-passwort") {
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const data = await res.json();
  return { status: res.status, cookie: (res.headers.get("set-cookie") || "").split(";")[0], csrf: data.csrf, data };
}
function client(session) {
  return async (path, { method = "GET", body, csrf = true } = {}) => {
    const headers = { Cookie: session.cookie };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (csrf && method !== "GET") headers["X-CSRF-Token"] = session.csrf;
    const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: "manual" });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  };
}

test("Login, falsches Passwort, Sitzung, CSRF-Pflicht, Sicherheits-Header", async () => {
  assert.equal((await login("admin@test.de", "falsch")).status, 401);
  const s = await login();
  assert.equal(s.status, 200);
  assert.match(s.cookie, /^cm_sid=/);
  const api = client(s);
  assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);
  const dash = await api("/api/dashboard");
  assert.equal(dash.status, 200);
  assert.equal(dash.headers.get("x-frame-options"), "DENY");
  assert.match(dash.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal((await api("/api/target-groups", { method: "POST", body: { name: "X" }, csrf: false })).status, 403);
  assert.equal((await api("/api/target-groups", { method: "POST", body: { name: "X" } })).status, 200);
});

test("Postfach anlegen: Passwort wird verschlüsselt gespeichert und nie zurückgegeben", async () => {
  const api = client(await login());
  const res = await api("/api/mailboxes", { method: "POST", body: { email: "max@musterfirma-mail.de", from_name: "Max", provider: "google", smtp_host: "smtp.gmail.com", smtp_port: 465, smtp_secure: true, smtp_pass: "app-passwort-123", imap_host: "imap.gmail.com", imap_port: 993, imap_secure: true, imap_same_pass: true } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.smtp_pass, undefined);
  assert.equal(res.json.has_smtp_pass, true);
  assert.equal(res.json.save_sent, 0, "Google legt selbst in Gesendet ab");
  assert.equal(res.json.imap_configured, true);
  const row = q.get("SELECT smtp_pass, imap_pass FROM mailboxes WHERE email = 'max@musterfirma-mail.de'");
  assert.match(row.smtp_pass, /^v1:/);
  assert.doesNotMatch(row.smtp_pass, /app-passwort/);
  assert.ok(!(await api("/api/mailboxes")).text.includes("v1:"), "keine verschlüsselten Werte in der API");
  assert.equal((await api("/api/mailboxes", { method: "POST", body: { email: "max@musterfirma-mail.de", smtp_host: "x", smtp_port: 465, smtp_pass: "x" } })).status, 409);
});

test("CSV-Import über die API mit Liste, Duplikaten und ungültigen Zeilen", async () => {
  const api = client(await login());
  const csv = "E-Mail;Vorname;Firma;Größe\nanna@firma-a.de;Anna;A GmbH;10\nANNA@firma-a.de;Anna;A GmbH;10\nkein-email;X;Y;1\nben@firma-b.de;Ben;B KG;20\n";
  const prev = await api("/api/leads/import/preview", { method: "POST", body: { csv } });
  assert.equal(prev.json.total, 4);
  assert.equal(prev.json.mapping[3], "custom:Größe");
  const res = await api("/api/leads/import", { method: "POST", body: { csv, mapping: prev.json.mapping, new_list_name: "Test-Liste", source: "Messe 2026" } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.imported, 2);
  assert.equal(res.json.duplicates_in_file, 1);
  assert.equal(res.json.invalid, 1);
  const lead = q.get("SELECT * FROM leads WHERE email = 'anna@firma-a.de'");
  assert.equal(JSON.parse(lead.custom)["Größe"], "10");
  assert.equal(lead.source, "Messe 2026");
  const exp = await api("/api/leads/export");
  assert.match(exp.headers.get("content-type"), /text\/csv/);
  assert.match(exp.text, /anna@firma-a\.de/);
});

test("Kampagne: Startprüfung, Vorschau mit Variablen, Start nur wenn startklar", async () => {
  const api = client(await login());
  const c = (await api("/api/campaigns", { method: "POST", body: { name: "API-Test", mailbox_ids: [] } })).json;
  const check = (await api(`/api/campaigns/${c.id}/check`)).json;
  assert.equal(check.ok, false);
  assert.ok(check.errors.some(e => /Postfach/.test(e)));
  assert.equal((await api(`/api/campaigns/${c.id}/status`, { method: "POST", body: { action: "launch" } })).status, 400);
  const mbId = q.get("SELECT id FROM mailboxes LIMIT 1").id;
  const steps = [{ delay_days: 0, variants: [{ subject: "Frage zu {{company}}", body: "{{anrede}},\n\n{{company}} – kurze Frage?" }] }, { delay_days: 4, variants: [{ subject: "", body: "{{hallo}}, nachgehakt." }] }];
  const upd = await api(`/api/campaigns/${c.id}`, { method: "PUT", body: { steps, mailbox_ids: [mbId], days: [1, 2, 3, 4, 5], window_start: "09:00", window_end: "16:30" } });
  assert.equal(upd.status, 200, upd.text);
  assert.equal(upd.json.steps.length, 2);
  const list = q.get("SELECT id FROM lead_lists WHERE name = 'Test-Liste'").id;
  const first = await api(`/api/campaigns/${c.id}/leads`, { method: "POST", body: { list_id: list } });
  assert.equal(first.json.added, 0, "ohne Einwilligung keine Aufnahme in eine Einwilligungs-Kampagne");
  assert.equal(first.json.reasons["Keine dokumentierte Einwilligung"], 2);
  const ids = q.all("SELECT lead_id FROM lead_list_members WHERE list_id = ?", list).map(r => r.lead_id);
  assert.equal((await api("/api/leads/bulk", { method: "POST", body: { ids, action: "set_consent", consent_status: "granted" } })).status, 400, "Quelle ist Pflicht");
  assert.equal((await api("/api/leads/bulk", { method: "POST", body: { ids, action: "set_consent", consent_status: "granted", consent_source: "Messe-Formular 03.10.2026" } })).json.affected, 2);
  const en = await api(`/api/campaigns/${c.id}/leads`, { method: "POST", body: { list_id: list } });
  assert.equal(en.json.added, 2);
  const prev = await api(`/api/campaigns/${c.id}/preview`, { method: "POST", body: { step: 1 } });
  assert.equal(prev.json.subject, "Re: Frage zu A GmbH");
  assert.match(prev.json.text, /^Hallo Anna, nachgehakt\./);
  assert.match(prev.json.text, /\/u\/vorschau/);
  const blocked = await api(`/api/campaigns/${c.id}/status`, { method: "POST", body: { action: "launch" } });
  assert.equal(blocked.status, 400);
  assert.ok(blocked.json.details.errors.some(e => /Impressum/.test(e)));
  assert.ok(blocked.json.details.errors.some(e => /nicht freigegeben/.test(e)));
  await api("/api/settings", { method: "PUT", body: { footer_text: "Musterfirma GmbH · Musterstr. 1 · 12345 Musterstadt · GF: Max Mustermann · HRB 123 · Datenschutz: {{privacy_url}}", privacy_url: "https://musterfirma.de/datenschutz" } });
  const approved = await api(`/api/campaigns/${c.id}/approve`, { method: "POST", body: {} });
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.json.approval.approved, true);
  assert.equal(approved.json.approval.approved_by, "Admin");
  const ok = await api(`/api/campaigns/${c.id}/status`, { method: "POST", body: { action: "launch" } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, "active");
  // Text geändert → Freigabe weg, Kampagne pausiert.
  steps[1].variants[0].body = "{{hallo}}, kurz nachgehakt.";
  const edited = await api(`/api/campaigns/${c.id}`, { method: "PUT", body: { steps } });
  assert.equal(edited.json.paused_for_approval, true);
  assert.equal(edited.json.status, "paused");
  assert.equal(edited.json.approval.outdated, true);
});

test("Abmelden: Seite, Formular-POST und One-Click; Lead wird überall gestoppt und gesperrt", async () => {
  const mb = makeMailbox();
  const lead = makeLead({ email: "abmelden@firma-c.de" });
  const cid = makeCampaign({ mailboxIds: [mb] });
  insert("campaign_leads", { campaign_id: cid, lead_id: lead, status: "active", step: 1, created_at: Date.now() });
  insert("messages", { lead_id: lead, campaign_id: cid, mailbox_id: mb, direction: "out", kind: "campaign", token: "unsubTOKEN12345", created_at: Date.now() - 60000 });
  const page = await fetch(`${base}/u/unsubTOKEN12345`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /abmelden@firma-c\.de/);
  assert.equal(q.get("SELECT status FROM leads WHERE id = ?", lead).status, "active", "GET allein meldet nicht ab (Link-Scanner)");
  const post = await fetch(`${base}/u/unsubTOKEN12345`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(post.status, 200);
  assert.equal(q.get("SELECT status FROM leads WHERE id = ?", lead).status, "unsubscribed");
  assert.equal(q.get("SELECT status FROM campaign_leads WHERE lead_id = ?", lead).status, "unsubscribed");
  assert.ok(q.get("SELECT 1 FROM blocklist WHERE value = 'abmelden@firma-c.de'"));
  assert.equal((await fetch(`${base}/u/unbekanntertoken`)).status, 404);
});

test("Tracking: Pixel, signierte Klick-Weiterleitung, keine offene Weiterleitung", async () => {
  const mb = makeMailbox();
  const lead = makeLead();
  insert("messages", { lead_id: lead, mailbox_id: mb, direction: "out", kind: "campaign", token: "trackTOKEN98765", created_at: Date.now() - 60000 });
  const px = await fetch(`${base}/t/o/trackTOKEN98765.gif`, { headers: { "User-Agent": "Mozilla/5.0" } });
  assert.equal(px.headers.get("content-type"), "image/gif");
  assert.equal(q.get("SELECT opens FROM messages WHERE token = 'trackTOKEN98765'").opens, 1);
  const url = "https://musterfirma.de/";
  const good = await fetch(`${base}/t/c/trackTOKEN98765?u=${encodeURIComponent(url)}&s=${hmac(`trackTOKEN98765|${url}`, "click")}`, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
  assert.equal(good.status, 302);
  assert.equal(good.headers.get("location"), url);
  assert.equal(q.get("SELECT clicks FROM messages WHERE token = 'trackTOKEN98765'").clicks, 1);
  const evil = await fetch(`${base}/t/c/trackTOKEN98765?u=${encodeURIComponent("https://evil.example/")}&s=falsch`, { redirect: "manual" });
  assert.equal(evil.status, 400);
});

test("DSGVO-Löschung entfernt Lead, Nachrichten und Gespräche", async () => {
  const api = client(await login());
  const lead = makeLead({ email: "loeschen@firma-d.de" });
  const conv = insert("conversations", { lead_id: lead, last_at: Date.now(), created_at: Date.now(), has_inbound: 1 });
  insert("messages", { conversation_id: conv, lead_id: lead, direction: "in", kind: "reply", text: "geheim", created_at: Date.now() });
  const del = await api(`/api/leads/${lead}`, { method: "DELETE" });
  assert.equal(del.status, 200);
  assert.equal(q.value("SELECT COUNT(*) FROM leads WHERE id = ?", lead), 0);
  assert.equal(q.value("SELECT COUNT(*) FROM messages WHERE lead_id = ?", lead), 0);
  assert.equal(q.value("SELECT COUNT(*) FROM conversations WHERE lead_id = ?", lead), 0);
});

test("Mitarbeiter dürfen keine Einstellungen/Benutzer ändern; Pfad-Traversal blockiert; SPA-Fallback", async () => {
  const admin = client(await login());
  const created = await admin("/api/users", { method: "POST", body: { email: "nick@hk.de", name: "Nick", password: "noch-ein-langes-pw", role: "member" } });
  assert.equal(created.status, 200, created.text);
  const member = client(await login("nick@hk.de", "noch-ein-langes-pw"));
  assert.equal((await member("/api/settings", { method: "PUT", body: { company_name: "X" } })).status, 403);
  assert.equal((await member("/api/users")).status, 403);
  const trav = await fetch(`${base}/..%2f..%2fsrc%2fconfig.js`);
  assert.notEqual(trav.status, 200);
  const trav2 = await fetch(`${base}/js/..%2f..%2fpackage.json`);
  assert.ok(!(await trav2.text()).includes("\"dependencies\""));
  const spa = await fetch(`${base}/kampagnen`);
  assert.match(await spa.text(), /<div id="app">/);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("Gespeichertes Passwort geht nie an einen geänderten Server; kaputte Fremd-Cookies stören nicht", async () => {
  const s = await login();
  const api = client(s);
  const mb = q.get("SELECT id FROM mailboxes WHERE email = 'max@musterfirma-mail.de'").id;
  const moved = await api(`/api/mailboxes/${mb}`, { method: "PUT", body: { smtp_host: "smtp.angreifer.example" } });
  assert.equal(moved.status, 400);
  assert.match(moved.json.error, /Passwort erneut eingeben/);
  const probe = await api("/api/mailboxes/test", { method: "POST", body: { id: mb, imap_host: "imap.angreifer.example" } });
  assert.equal(probe.status, 400);
  const ok = await api(`/api/mailboxes/${mb}`, { method: "PUT", body: { from_name: "Max M." } });
  assert.equal(ok.status, 200, "Andere Felder ohne Passwort änderbar");
  const withOther = await fetch(`${base}/api/me`, { headers: { Cookie: `tracking=100%; ${s.cookie}` } });
  assert.equal(withOther.status, 200);
  assert.notEqual((await fetch(`${base}/%E0%A4%A.js`)).status, 500, "kaputte Kodierung im Pfad ist kein Serverfehler");
});

test("Login-Rate-Limit", async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await login("niemand@test.de", "x");
  assert.equal(last.status, 429);
});
