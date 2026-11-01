// Einrichtungs-Assistent: Domains, Postfächer (2 je Domain, Klarnamen), Warmup + Signaturen, Kampagnen-Check,
// Hochfahren des Tageslimits und Schutz vor stehengebliebenen Platzhaltern.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeCampaign, makeMailbox } from "./helpers.js";
import { createApp } from "../src/app.js";
import { ensureAdmin } from "../src/auth.js";
import { q, insert } from "../src/db.js";
import { DAY_MS } from "../src/lib/time.js";
import { campaignDailyLimit, availableMailboxes } from "../src/engine/scheduler.js";
import { complianceIssues } from "../src/engine/rules.js";
import { loadSteps } from "../src/mail/compose.js";
import { domainSuggestions, tldLevel, signatureCheck } from "../src/setup/status.js";
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

test("Domain-Regeln: Vorschläge nah am Namen, keine Spam-Endungen, schlanke Signatur", () => {
  const s = domainSuggestions("Musterfirma UG (haftungsbeschränkt)", "musterfirma.de");
  assert.ok(s.includes("getmusterfirma.com"));
  assert.ok(s.includes("musterfirmahq.de"));
  assert.equal(tldLevel("x.xyz"), "bad");
  assert.equal(tldLevel("x.com"), "ok");
  assert.equal(signatureCheck("").ok, false);
  assert.equal(signatureCheck("Beste Grüße\nMax Mustermann\nGeschäftsführer – Musterfirma").ok, true);
  assert.equal(signatureCheck('Grüße\n<img src="banner.png">').ok, false);
});

test("Leerer Stand: alle Schritte offen, Tool-Kosten 0 €", async () => {
  const s = (await api("/api/setup")).json;
  assert.deepEqual(s.steps.map(x => x.key), ["domains", "mailboxes", "warmup", "campaign", "launch"]);
  assert.equal(s.steps[0].status, "todo");
  assert.equal(s.costs.tools_per_month, 0);
});

test("Domains speichern, Postfächer gesammelt anlegen (Warmup, Signatur), Hauptdomain wird erkannt", async () => {
  const put = await api("/api/setup", { method: "PUT", body: { main_domain: "https://www.musterfirma.de/", company_name: "Muster GmbH", domains: "getmuster.com\nmusterhq.com, musterteam.com trymuster.com mustergroup.xyz" } });
  assert.equal(put.status, 200);
  assert.equal(put.json.main_domain, "musterfirma.de");
  assert.equal(put.json.planned_domains.length, 5);
  assert.equal(put.json.steps[0].checks.find(c => c.label.startsWith("Seriöse Endung")).status, "bad", ".xyz wird bemängelt");
  const rows = [
    { email: "m.muster@getmuster.com", password: "pw-1", from_name: "Max Muster" },
    { email: "max@getmuster.com", password: "pw-2", from_name: "Max Muster" },
    { email: "info@musterhq.com", password: "pw-3", from_name: "Max Muster" },
    { email: "ohne-pw@musterhq.com", password: "", from_name: "Max Muster" }
  ];
  const r = await api("/api/setup/mailboxes", { method: "POST", body: { preset: { provider: "allinkl", smtp_host: "w0000000.kasserver.com", imap_host: "w0000000.kasserver.com" }, rows, position: "Geschäftsführer", test: false } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map(x => x.ok), [true, true, true, false], "ohne Passwort scheitert nur die eine Zeile");
  const mb = q.get("SELECT * FROM mailboxes WHERE email = 'm.muster@getmuster.com'");
  assert.equal(mb.smtp_host, "w0000000.kasserver.com");
  assert.equal(mb.imap_host, "w0000000.kasserver.com");
  assert.equal(mb.warmup_enabled, 1);
  assert.ok(mb.warmup_started_at);
  assert.match(mb.signature, /Max Muster\nGeschäftsführer – Muster GmbH/);
  assert.notEqual(mb.smtp_pass, "pw-1", "Passwort verschlüsselt gespeichert");
  const st = r.json.status;
  const names = st.steps[1].checks.find(c => c.label.startsWith("Klarnamen"));
  assert.equal(names.status, "warn");
  assert.match(names.detail, /info@musterhq\.com/);
  assert.match(st.steps[1].checks.find(c => c.label.startsWith("2 Postfächer")).detail, /getmuster\.com: 2/);
  assert.equal(st.steps[2].checks.find(c => c.label.startsWith("14 Tage")).status, "warn", "Warmup läuft erst seit heute");

  // Postfach auf der Hauptdomain = Problem
  makeMailbox({ email: "max@musterfirma.de" });
  const s2 = (await api("/api/setup")).json;
  assert.equal(s2.steps[0].checks.find(c => c.label === "Nicht die Hauptdomain").status, "bad");
  q.run("DELETE FROM mailboxes WHERE email = 'max@musterfirma.de'");
});

test("Warmup für alle und fehlende Signaturen per Klick", async () => {
  q.run("UPDATE mailboxes SET warmup_enabled = 0, warmup_started_at = NULL, signature = '' WHERE email = 'max@getmuster.com'");
  const w = await api("/api/setup/warmup-all", { method: "POST" });
  assert.equal(w.json.changed, 1);
  const s = await api("/api/setup/signatures", { method: "POST", body: { position: "Vertrieb" } });
  assert.equal(s.json.changed, 1, "nur das Postfach ohne Signatur");
  assert.match(q.value("SELECT signature FROM mailboxes WHERE email = 'max@getmuster.com'"), /Vertrieb – Muster GmbH/);
  // 15 Tage später ist das Warmup durch
  q.run("UPDATE mailboxes SET warmup_started_at = ?", Date.now() - 15 * DAY_MS);
  const st = (await api("/api/setup")).json;
  assert.equal(st.steps[2].checks.find(c => c.label.startsWith("14 Tage")).status, "ok");
});

test("Kampagnen-Check: Berlin, Mo–Fr 8–17, Hochfahren, alle Postfächer, Gerüst, Start-Bereitschaft", async () => {
  const ids = q.all("SELECT id FROM mailboxes").map(m => m.id);
  const cid = makeCampaign({
    mailboxIds: ids.slice(0, 1), daily_limit: 300, days: "1,2,3,4,5", window_start: "08:00", window_end: "17:00",
    steps: [
      { variants: [{ key: "A", subject: "Frage zu {{company}}", body: "{{anrede}},\n\nkurze Frage.", enabled: true }, { key: "B", subject: "{{first_name}}, kurz", body: "{{anrede}},\n\nB.", enabled: true }] },
      { subject: "", body: "{{anrede}},\n\nnachgehakt.", delay: 4 }, { subject: "", body: "{{anrede}},\n\nnoch einmal.", delay: 5 },
      { subject: "", body: "{{anrede}},\n\nein Beispiel.", delay: 5 }, { subject: "Letzter Versuch", body: "{{anrede}},\n\nich störe nicht weiter.", delay: 5 }
    ]
  });
  let c = (await api("/api/setup")).json.campaigns.find(x => x.id === cid);
  const byLabel = l => c.checks.find(x => x.label.startsWith(l));
  assert.equal(byLabel("Sequenz").status, "ok");
  assert.equal(byLabel("A/B").status, "ok");
  assert.equal(byLabel("Follow-ups im selben Thread").status, "ok");
  assert.equal(byLabel("Langsam hochfahren").status, "warn", "300/Tag ohne Hochfahren");
  assert.equal(byLabel("Alle Postfächer").status, "warn");
  await api(`/api/campaigns/${cid}`, { method: "PUT", body: { ramp_enabled: true, ramp_week1: 150, ramp_week2: 250, mailbox_ids: ids } });
  c = (await api("/api/setup")).json.campaigns.find(x => x.id === cid);
  assert.equal(c.checks.find(x => x.label.startsWith("Langsam hochfahren")).status, "ok");
  assert.equal(c.checks.find(x => x.label.startsWith("Alle Postfächer")).status, "ok");
  assert.equal(c.launch.find(x => x.label.startsWith("Leads hinzugefügt")).status, "todo");

  // Hochfahren: Woche 1 → 150, Woche 2 → 250, danach 300
  const camp = q.get("SELECT * FROM campaigns WHERE id = ?", cid);
  const launched = Date.now();
  assert.equal(campaignDailyLimit({ ...camp, launched_at: launched }, launched + DAY_MS), 150);
  assert.equal(campaignDailyLimit({ ...camp, launched_at: launched }, launched + 8 * DAY_MS), 250);
  assert.equal(campaignDailyLimit({ ...camp, launched_at: launched }, launched + 15 * DAY_MS), 300);
  assert.equal(campaignDailyLimit({ ...camp, ramp_enabled: 0 }, launched), 300);
});

test("Platzhalter aus dem Standard-Gerüst blockieren die Freigabe", async () => {
  saveSettings({ footer_text: "Muster GmbH · Musterstr. 1 · 12345 Musterstadt" });
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb], approved: false, steps: [{ subject: "Frage", body: "{{anrede}},\n\n[Anlass: Was ist bei {{company}} gerade los?]\n\nViele Grüße" }] });
  const c = q.get("SELECT * FROM campaigns WHERE id = ?", cid);
  assert.ok(complianceIssues(c, loadSteps(cid)).errors.some(e => /Platzhalter in eckigen Klammern/.test(e)));
  const r = await api(`/api/campaigns/${cid}/approve`, { method: "POST", body: {} });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Platzhalter/);
});

test("Weg „Hauptdomain“: kein Domainkauf, ein Postfach, Start sofort mit sanftem Hochfahren", async () => {
  assert.equal((await api("/api/setup", { method: "PUT", body: { setup_mode: "irgendwas" } })).status, 400);
  const put = await api("/api/setup", { method: "PUT", body: { setup_mode: "main", main_domain: "musterfirma.de" } });
  assert.equal(put.json.mode, "main");
  assert.equal(put.json.steps[1].checks[0].label, "Postfächer auf der Hauptdomain");
  assert.equal(put.json.steps[1].checks[0].status, "todo");
  assert.deepEqual(put.json.suggestions, [], "keine Domain-Vorschläge zum Kaufen");

  const yesterday = Date.now() - DAY_MS - 60_000;
  const mb = makeMailbox({ email: "max@musterfirma.de", daily_limit: 30, ramp_enabled: 1, ramp_start: 5, ramp_step: 3, ramp_started_at: yesterday, signature: "Beste Grüße\nMax Mustermann" });
  const cid = makeCampaign({ mailboxIds: [mb], daily_limit: 30 });
  const others = q.all("SELECT id FROM mailboxes WHERE id != ? AND status = 'active'", mb).map(r => r.id);
  for (const id of others) q.run("UPDATE mailboxes SET status = 'paused' WHERE id = ?", id);
  const s = (await api("/api/setup")).json;
  const domains = s.steps[0];
  assert.ok(!domains.checks.some(c => c.status === "bad"), "Hauptdomain ist bewusst gewählt – kein Fehler");
  assert.equal(domains.checks.find(c => c.label.startsWith("Kleine Menge")).status, "ok");
  assert.equal(s.steps[1].checks[0].status, "ok");
  const gentle = s.steps[2].checks.find(c => c.label.startsWith("Sanfter Start"));
  assert.match(gentle.detail, /max@musterfirma\.de: heute 8\/Tag, 30 ab/, "Tag 2: 5 + 3");
  assert.equal(s.steps[2].checks.find(c => c.label === "Warmup").status, "ok", "mit einem Postfach kein Warmup nötig");
  assert.equal(s.warmup_ready_at, null);
  const c = s.campaigns.find(x => x.id === cid);
  assert.equal(c.ready_at, null, "kein Warten auf 14 Tage");
  assert.ok(!c.launch.some(x => x.label.startsWith("Warmup")));
  assert.equal(c.launch.find(x => x.label === "Sanfter Start aktiv").status, "ok");
  assert.equal(c.checks.find(x => x.label === "Menge passend zur Hauptdomain").status, "ok");

  // Zu viel Menge über die Hauptdomain wird angemahnt (nicht blockiert)
  q.run("UPDATE campaigns SET daily_limit = 300 WHERE id = ?", cid);
  q.run("UPDATE mailboxes SET daily_limit = 80 WHERE id = ?", mb);
  const s2 = (await api("/api/setup")).json;
  assert.equal(s2.campaigns.find(x => x.id === cid).checks.find(x => x.label === "Menge passend zur Hauptdomain").status, "warn");
  const small = s2.steps[0].checks.find(x => x.label.startsWith("Kleine Menge"));
  assert.equal(small.status, "ok", "das Domain-Limit wird beim Versand erzwungen");
  assert.match(small.detail, /zusammen höchstens 60\/Tag.*Postfach-Limits zusammen 80/);
  assert.equal(s2.campaigns.find(x => x.id === cid).launch.find(x => x.label === "Sanfter Start aktiv").status, "warn");

  for (const id of others) q.run("UPDATE mailboxes SET status = 'active' WHERE id = ?", id);
  await api("/api/setup", { method: "PUT", body: { setup_mode: "separate" } });
  q.run("DELETE FROM campaigns WHERE id = ?", cid);
  q.run("DELETE FROM mailboxes WHERE id = ?", mb);
});

test("Hauptdomain: alle Postfächer der Domain teilen sich das Tageslimit (pro Takt nie mehr als übrig)", async () => {
  await api("/api/setup", { method: "PUT", body: { setup_mode: "main", main_domain: "https://www.teilfirma.de/" } });
  const boxes = ["webseiten", "automation", "dealuno", "webseite-automation"].map(n => makeMailbox({ email: `${n}@teilfirma.de`, daily_limit: 30 }));
  const other = makeMailbox({ email: "vertrieb@andere-domain.de", daily_limit: 30 });
  const mainIds = () => [...availableMailboxes().keys()].filter(id => boxes.includes(id));
  assert.equal(mainIds().length, 4, "noch nichts gesendet: alle vier frei");
  const send = (mailbox, n) => { for (let i = 0; i < n; i++) insert("messages", { lead_id: null, mailbox_id: mailbox, direction: "out", kind: "campaign", status: "sent", created_at: Date.now() }); };
  send(boxes[0], 30); send(boxes[1], 28);
  const free = availableMailboxes();
  assert.equal(mainIds().length, 2, "60 − 58 = 2 Mails übrig → höchstens zwei Postfächer in diesem Takt");
  assert.ok([...free.values()].filter(a => boxes.includes(a.mb.id)).every(a => a.remaining <= 2));
  assert.ok(free.has(other), "andere Domain ist nicht betroffen");
  send(boxes[2], 2);
  assert.equal(mainIds().length, 0, "Tageslimit der Hauptdomain erreicht");
  await api("/api/setup", { method: "PUT", body: { setup_mode: "separate" } });
  assert.equal(mainIds().length, 3, "Weg „separate“: kein Domain-Limit, nur die Postfach-Limits (eins ist voll)");
  q.run("DELETE FROM messages WHERE mailbox_id IN (SELECT value FROM json_each(?))", JSON.stringify(boxes));
  for (const id of [...boxes, other]) q.run("DELETE FROM mailboxes WHERE id = ?", id);
});
