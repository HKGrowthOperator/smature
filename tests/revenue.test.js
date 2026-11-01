// Revenue OS: Projekte-Board, Firmen (Account Brain), Recherche mit Belegen, Lebenszyklus, Qualitätsprüfung,
// Heute-Liste, Chancen bis zum Auftrag und Lernen nach Umsatz.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeLead, makeMailbox, makeCampaign, enroll } from "./helpers.js";
import { createApp } from "../src/app.js";
import { ensureAdmin } from "../src/auth.js";
import { q, insert } from "../src/db.js";
import { setAiClientFactory } from "../src/ai/claude.js";
import { ensureAccountForLead, normalizeDomain, mergeAccounts } from "../src/intel/accounts.js";
import { advance, sideState, setLifecycle } from "../src/intel/lifecycle.js";
import { setResearchFetcher, validateResearch } from "../src/intel/research.js";
import { brainText, nextBestAction } from "../src/intel/brain.js";
import { checkMessage } from "../src/orchestration/qa.js";
import { todayActions } from "../src/orchestration/today.js";
import { markMeetingBooked } from "../src/engine/followup.js";
import { ensurePersonalization } from "../src/ai/features.js";
import { markNoResponse } from "../src/intel/watch.js";
import { DAY_MS } from "../src/lib/time.js";

let cleanup, server, base, api;
const prompts = [];
const responses = {};

// Fake-API: Antwort je nach Schema (Recherche, Briefing, Discovery, Personalisierung …).
function fakeClient() {
  const respond = p => {
    prompts.push(p);
    const props = Object.keys(p.output_config?.format?.schema?.properties || {});
    const key = props.includes("facts") ? "research" : props.includes("known_facts") ? "brief" : props.includes("confirmed_pains") ? "discovery" : props.includes("first_line") ? "first_line" : props.includes("underlying") ? "loss" : "other";
    const r = typeof responses[key] === "function" ? responses[key](p) : responses[key] || {};
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(r) }], usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const stream = run => ({ finalMessage: async () => run() });
  return { messages: { stream: p => stream(() => respond(p)) }, beta: { messages: { stream: p => stream(() => respond(p)) } } };
}

const SITE = {
  "https://mustermann-metallbau.de/": `<html><body><h1>Mustermann Metallbau GmbH</h1><p>Ihr Partner für Stahlbau und Schweißtechnik in Gummersbach. Seit 1998 fertigen wir Treppen, Geländer und Hallen für Industrie und Gewerbe.</p>
    <a href="/impressum">Impressum</a> <a href="/karriere">Karriere</a> <a href="/news">Aktuelles</a></body></html>`,
  "https://mustermann-metallbau.de/impressum": "<html><body><p>Mustermann Metallbau GmbH, Industriestraße 5, 51643 Gummersbach. Geschäftsführer: Max Mustermann. Telefon: 02261 12345.</p></body></html>",
  "https://mustermann-metallbau.de/karriere": "<html><body><p>Wir suchen ab sofort drei Monteure (m/w/d) für den Außendienst sowie eine Disponentin für die Einsatzplanung.</p></body></html>",
  "https://mustermann-metallbau.de/news": "<html><body><p>März 2026: Wir haben unsere neue Produktionshalle in Wiehl eröffnet.</p></body></html>"
};

const RESEARCH = {
  company: { name: "Mustermann Metallbau GmbH", industry: "Metallbau", city: "Gummersbach", employees_estimate: "40–60", summary: "Stahl- und Metallbau mit Außendienst-Montage" },
  facts: [
    { key: "standort", statement: "Sitz in Gummersbach", type: "verified", confidence: 95, source: "S2", quote: "Industriestraße 5, 51643 Gummersbach" },
    { key: "leistung", statement: "Fertigt Treppen, Geländer und Hallen", type: "verified", confidence: 90, source: "S1", quote: "fertigen wir Treppen, Geländer und Hallen" },
    { key: "umsatz", statement: "Umsatz 12 Mio. €", type: "verified", confidence: 90, source: "S1", quote: "Umsatz von 12 Millionen Euro" },
    { key: "erfunden", statement: "Hat 500 Mitarbeitende", type: "verified", confidence: 90, source: "S9", quote: "500 Mitarbeitende" }
  ],
  signals: [
    { type: "hiring", title: "Sucht drei Monteure und eine Disponentin", detail: "Außendienst wächst", strength: 85, confidence: 90, source: "S3", quote: "drei Monteure (m/w/d) für den Außendienst" },
    { type: "expansion", title: "Neue Produktionshalle in Wiehl", detail: "", strength: 75, confidence: 90, source: "S4", quote: "neue Produktionshalle in Wiehl eröffnet" }
  ],
  hypotheses: [{ kind: "pain", statement: "Einsatzplanung des Außendienstes wird mit dem Wachstum aufwendiger", interpretation: "Neue Disponentin und Monteure deuten auf mehr Koordination", confidence: 65, evidence: ["G1"] }],
  people: [
    { name: "Max Mustermann", role: "Geschäftsführer", committee_role: "economic_buyer", decision_power: "high", pain_influence: "high", source: "S2" },
    { name: "Erika Erfunden", role: "Leitung Service", committee_role: "champion", decision_power: "medium", pain_influence: "very_high", source: "S2" }
  ],
  strategy: { primary_entry: "Geschäftsführer", secondary: "Disposition", champion: "", economic_buyer: "Max Mustermann", technical: "", do_not_contact: "" },
  scores: { fit: 80, pain: 65, timing: 85, contactability: 70, fit_reason: "Metallbau mit Außendienst", pain_reason: "Wachstum im Außendienst", timing_reason: "Stellen + neue Halle", contactability_reason: "GF und Telefon im Impressum" },
  why_now: { summary: "Wächst im Außendienst und hat eine neue Halle eröffnet", confidence: 80 },
  play: { matched_play_id: 0, persona: "Geschäftsführer", trigger: "Stellen im Außendienst", pain: "Einsatzplanung", angle: "Disposition bei Wachstum", proof: "", channel: "call", cta: "15 Minuten Prozess-Check" },
  disqualify: { yes: false, reason: "" }
};

before(async () => {
  cleanup = setupDb({ ADMIN_EMAIL: "admin@test.de", ADMIN_PASSWORD: "ein-langes-passwort" });
  ensureAdmin();
  setAiClientFactory(() => fakeClient());
  setResearchFetcher(async url => {
    const key = new URL(url).toString();
    return SITE[key] ? { url: key, html: SITE[key] } : null;
  });
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
after(async () => { setAiClientFactory(null); setResearchFetcher(null); await new Promise(r => server.close(r)); cleanup(); });

async function waitJob(id) {
  for (let i = 0; i < 100; i++) {
    const j = (await api(`/api/jobs/${id}`)).json;
    if (j.status !== "running") return j;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error("Auftrag hängt");
}

test("Projekte: vier Themenordner angelegt, Board mit einer Spalte je Projekt", async () => {
  const list = (await api("/api/projects")).json;
  assert.deepEqual(list.map(p => p.name), ["Webseite", "Software Sales App", "Software Mittelstand", "Webseite / Automation"]);
  const sm = list.find(p => p.slug === "software-mittelstand");
  const prod = await api("/api/products", { method: "POST", body: { name: "Einsatzplanung", project_id: sm.id } });
  assert.equal(prod.status, 200);
  assert.equal(prod.json.project_id, sm.id);
  assert.equal((await api("/api/products", { method: "POST", body: { name: "X", project_id: 999 } })).status, 400, "unbekanntes Projekt");
  const tg = await api("/api/target-groups", { method: "POST", body: { name: "Metallbau NRW", project_id: sm.id } });
  assert.equal(tg.json.project_id, sm.id);
  const board = (await api("/api/projects/board")).json;
  assert.equal(board.columns.length, 4, "keine Spalte „Ohne Projekt“, solange alles zugeordnet ist");
  const col = board.columns.find(c => c.project.id === sm.id);
  assert.equal(col.products[0].name, "Einsatzplanung");
  assert.equal(col.target_groups[0].name, "Metallbau NRW");
  await api("/api/products", { method: "POST", body: { name: "Ohne Ordner" } });
  assert.equal((await api("/api/projects/board")).json.columns.length, 5, "Nicht zugeordnete Produkte erscheinen in „Ohne Projekt“");
  const created = await api("/api/projects", { method: "POST", body: { name: "Recruiting", color: "#123456" } });
  assert.equal(created.json.slug, "recruiting");
  await api(`/api/projects/${created.json.id}`, { method: "DELETE" });
});

test("Firmen-Zuordnung über die Domain: gleiche Firma, keine Freemail-Firmen, Personen im Committee", () => {
  assert.equal(normalizeDomain("https://www.Beispiel-GmbH.de/kontakt?x=1"), "beispiel-gmbh.de");
  assert.equal(normalizeDomain("max@beispiel.de"), "beispiel.de");
  const a = makeLead({ email: "a.meier@acme-bau.de", company: "Acme Bau GmbH", first_name: "Anna", last_name: "Meier", position: "Geschäftsführerin" });
  const b = makeLead({ email: "b.kurz@acme-bau.de", company: "Acme Bau", first_name: "Ben", last_name: "Kurz" });
  const free = makeLead({ email: "privat@gmail.com", company: "" });
  const accA = ensureAccountForLead(a);
  assert.ok(accA);
  assert.equal(ensureAccountForLead(b), accA, "zweite Person derselben Domain → dieselbe Firma");
  assert.equal(ensureAccountForLead(free), null, "Freemail ohne Website → keine Firma");
  const acc = q.get("SELECT * FROM accounts WHERE id = ?", accA);
  assert.equal(acc.domain, "acme-bau.de");
  assert.equal(acc.name, "Acme Bau GmbH");
  assert.equal(q.value("SELECT COUNT(*) FROM account_people WHERE account_id = ?", accA), 2);
  // Zusammenführen: Tochterfirma unter anderer Domain
  const c = makeLead({ email: "info@acme-tochter.de", company: "Acme Tochter" });
  const accC = ensureAccountForLead(c);
  mergeAccounts(accA, accC);
  assert.equal(q.value("SELECT account_id FROM leads WHERE id = ?", c), accA);
  assert.equal(q.get("SELECT 1 FROM accounts WHERE id = ?", accC), undefined);
});

test("Lebenszyklus: automatisch nur vorwärts, Endzustände bleiben, Seitenzustände nicht nach Termin", () => {
  const id = insert("accounts", { domain: "lc-test.de", name: "LC", lifecycle: "discovered", created_at: Date.now(), updated_at: Date.now() });
  assert.ok(advance(id, "contacted"));
  assert.equal(advance(id, "researched"), false, "kein Rückschritt");
  assert.ok(advance(id, "engaged"));
  assert.ok(sideState(id, "not_now"));
  assert.ok(advance(id, "engaged"), "aus „Später“ zurück ins Gespräch");
  assert.ok(advance(id, "meeting"));
  assert.equal(sideState(id, "no_response"), false, "nach Termin kein „Keine Reaktion“");
  setLifecycle(id, "suppressed");
  assert.equal(advance(id, "meeting"), false, "gesperrt bleibt gesperrt");
});

test("Recherche: nur belegte Fakten, Personen nur aus der Website, Anlass → Aufgabe in Heute", async () => {
  responses.research = RESEARCH;
  const pid = (await api("/api/projects")).json.find(p => p.slug === "software-mittelstand").id;
  const created = await api("/api/accounts", { method: "POST", body: { domain: "https://mustermann-metallbau.de/", project_id: pid, research: true } });
  assert.equal(created.status, 200);
  const job = await waitJob(created.json.job.id);
  assert.equal(job.status, "done", job.error);
  const b = (await api(`/api/accounts/${created.json.account.id}`)).json;
  const statements = b.facts.map(f => f.statement);
  assert.ok(statements.includes("Sitz in Gummersbach"));
  assert.ok(!statements.includes("Hat 500 Mitarbeitende"), "Fakt mit erfundener Quelle wird verworfen");
  const umsatz = b.facts.find(f => f.statement.startsWith("Umsatz"));
  assert.ok(!umsatz || (umsatz.type === "estimate" && umsatz.confidence <= 40), "Zitat steht nicht in der Quelle → höchstens Schätzung");
  assert.equal(b.signals.length, 2);
  assert.deepEqual(b.people.map(p => p.name), ["Max Mustermann"], "erfundene Person wird nicht übernommen");
  assert.equal(b.account.lifecycle, "triggered");
  assert.equal(b.scores.opportunity, Math.round(0.35 * 80 + 0.25 * 65 + 0.25 * 85 + 0.15 * 70));
  assert.equal(b.hypotheses[0].evidence.signals.length, 1, "Hypothese verweist auf den Anlass");
  const task = q.get("SELECT * FROM tasks WHERE account_id = ? AND status = 'open'", b.account.id);
  assert.match(task.title, /Neuer Anlass/);
  const research = prompts.find(p => Object.keys(p.output_config.format.schema.properties).includes("facts"));
  assert.match(JSON.stringify(research.messages), /drei Monteure/, "Karriereseite wurde gelesen");
  assert.match(JSON.stringify(research.system), /Einsatzplanung/, "Produkte des Projekts fließen ein");
  const today = (await api(`/api/today?project=${pid}`)).json;
  assert.ok(today.items.some(i => i.task_id === task.id), "Anlass steht in „Heute“");
  assert.equal(today.stats.triggered, 1);
  const text = brainText(b.account.id);
  assert.match(text, /Sitz in Gummersbach/);
  assert.match(text, /Vermutung 65 %/);
});

test("Hypothese widerlegen → Gedächtnis; Qualitätsprüfung blockiert widerlegte Annahmen und Creepy-Texte", async () => {
  const acc = q.get("SELECT * FROM accounts WHERE domain = 'mustermann-metallbau.de'");
  const hyp = q.get("SELECT * FROM account_hypotheses WHERE account_id = ?", acc.id);
  const r = await api(`/api/accounts/${acc.id}/hypotheses/${hyp.id}`, { method: "PUT", body: { status: "rejected", note: "Planung läuft bereits über eine Software" } });
  assert.equal(r.json.hypotheses.find(h => h.id === hyp.id).status, "rejected");
  assert.ok(r.json.memory.some(m => m.kind === "rejected_assumption"));
  const bad = checkMessage({ subject: "Frage", body: "Ihre Einsatzplanung des Außendienstes wird mit dem Wachstum sicher aufwendiger." }, { accountId: acc.id });
  assert.equal(bad.ok, false);
  assert.ok(bad.issues.some(i => i.type === "forbidden"));
  const creepy = checkMessage({ body: "Ich habe gesehen, wie war Ihr Urlaub? Unser System hat erkannt, dass Sie 30 % verlieren." });
  assert.ok(creepy.creepy_score > 35 && !creepy.ok);
  assert.ok(creepy.issues.some(i => i.type === "unsupported"), "Zahl ohne Beleg");
  const good = checkMessage({ body: "Guten Tag Herr Mustermann,\n\nSie suchen drei Monteure für den Außendienst. Wie planen Sie heute die Einsätze?\n\nViele Grüße" }, { accountId: acc.id });
  assert.ok(good.ok, JSON.stringify(good.issues));
  assert.equal(brainText(acc.id).includes("WIDERLEGT") || brainText(acc.id).includes("Widerlegte Annahmen"), true);
});

test("Personalisierung: Account Brain im Prompt, creepy Einstiegssatz wird verworfen", async () => {
  const acc = q.get("SELECT * FROM accounts WHERE domain = 'mustermann-metallbau.de'");
  const leadId = makeLead({ email: "max@mustermann-metallbau.de", first_name: "Max", last_name: "Mustermann", company: "Mustermann Metallbau GmbH", website: "" });
  ensureAccountForLead(leadId);
  const lead = q.get("SELECT * FROM leads WHERE id = ?", leadId);
  assert.equal(lead.account_id, acc.id);
  const mb = makeMailbox();
  const cid = makeCampaign({ mailboxIds: [mb], ai_mode: "first_line", steps: [{ subject: "Frage", body: "{{anrede}},\n\n{{ai_first_line}}\n\nViele Grüße" }] });
  const clId = enroll(cid, leadId);
  const campaign = q.get("SELECT * FROM campaigns WHERE id = ?", cid);
  const cl = q.get("SELECT * FROM campaign_leads WHERE id = ?", clId);
  let n = 0;
  responses.first_line = () => { n++; return { first_line: "Wir beobachten Ihr Unternehmen seit Wochen und wissen, wie Ihr Urlaub war." }; };
  const ai = await ensurePersonalization({ campaign, steps: [], cl, lead, mailbox: q.get("SELECT * FROM mailboxes WHERE id = ?", mb), stepIndex: 0, variantKey: "A" });
  assert.equal(n, 2, "zweiter Versuch mit Rückmeldung");
  assert.equal(ai.first_line, "", "fällt durch → kein Satz");
  assert.equal(ai.qa.ok, false);
  const last = prompts.at(-1);
  assert.match(JSON.stringify(last.messages), /Account Brain/);
  assert.match(JSON.stringify(last.messages), /Qualitätsprüfung abgelehnt/);
  responses.first_line = { first_line: "Sie suchen gerade drei Monteure für den Außendienst." };
  const ok = await ensurePersonalization({ campaign, steps: [], cl: q.get("SELECT * FROM campaign_leads WHERE id = ?", clId), lead, mailbox: q.get("SELECT * FROM mailboxes WHERE id = ?", mb), stepIndex: 0, variantKey: "A", force: true });
  assert.equal(ok.first_line, "Sie suchen gerade drei Monteure für den Außendienst.");
});

test("Termin → Chance mit Herkunft, Briefing, Gesprächsauswertung, Gewonnen mit Wert, Lernen nach Umsatz", async () => {
  const acc = q.get("SELECT * FROM accounts WHERE domain = 'mustermann-metallbau.de'");
  const play = (await api("/api/plays", { method: "POST", body: { name: "Metallbau – Monteure gesucht", project_id: acc.project_id, persona: "Geschäftsführer", angle: "Disposition bei Wachstum", trigger_type: "hiring" } })).json;
  await api(`/api/accounts/${acc.id}`, { method: "PUT", body: { play_id: play.id } });
  const lead = q.get("SELECT * FROM leads WHERE account_id = ? AND email = 'max@mustermann-metallbau.de'", acc.id);
  markMeetingBooked(lead.id, { at: Date.now() + DAY_MS, source: "test" });
  const opp = q.get("SELECT * FROM opportunities WHERE account_id = ?", acc.id);
  assert.ok(opp, "Termin legt Chance an");
  const attribution = JSON.parse(opp.attribution);
  assert.equal(attribution.play_id, play.id);
  assert.equal(attribution.trigger_type, "hiring");
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = ?", acc.id), "meeting");

  responses.brief = { known_facts: ["Sitz in Gummersbach"], hypotheses: ["Planung aufwendig"], do_not_assume: ["Excel"], questions: ["1", "2", "3", "4", "5", "6", "7"], goal: "Prozess verstehen", next_step: "Demo", risks: [] };
  const briefed = (await api(`/api/opportunities/${opp.id}/brief`, { method: "POST" })).json;
  assert.equal(briefed.prep.questions.length, 6, "Schmerz-Leitfaden: 6 Fragen, Rest abgeschnitten");
  assert.ok(todayActions().items.every(i => !(i.opportunity_id === opp.id && i.title.startsWith("Termin vorbereiten"))), "mit Briefing kein Vorbereiten-Hinweis mehr");

  responses.discovery = {
    confirmed_pains: [{ statement: "Disposition per Telefon und Whiteboard", severity: "high", hypothesis_id: 0 }], rejected_hypotheses: [], systems: ["Excel", "Outlook"],
    decision_process: "GF entscheidet", timing: "Q1", budget: "unbekannt", next_step: "Demo mit Disponentin", objections: [{ type: "no_time", statement: "Gerade viel los" }],
    quality: { pain_confirmed: 90, authority: 100, need: 80, timing: 70, technical_fit: 80, commercial_fit: 60 }, do_not_claim: ["Dass sie Excel-Profis sind"]
  };
  assert.equal((await api(`/api/opportunities/${opp.id}/discovery`, { method: "POST", body: { notes: "kurz" } })).status, 400);
  const disc = (await api(`/api/opportunities/${opp.id}/discovery`, { method: "POST", body: { notes: "GF Mustermann: Disposition läuft über Telefon und Whiteboard, Excel für Stunden. Entscheidung Q1." } })).json;
  assert.equal(disc.quality.authority, 100);
  assert.equal(disc.next_step, "Demo mit Disponentin");
  assert.ok(q.get("SELECT 1 FROM account_memory WHERE account_id = ? AND kind = 'system' AND text = 'Excel'", acc.id));
  assert.ok(q.get("SELECT 1 FROM account_hypotheses WHERE account_id = ? AND status = 'confirmed'", acc.id));

  await api(`/api/opportunities/${opp.id}/stage`, { method: "POST", body: { stage: "proposal" } });
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = ?", acc.id), "proposal");
  assert.equal((await api(`/api/opportunities/${opp.id}/stage`, { method: "POST", body: { stage: "won" } })).status, 400, "Gewonnen braucht Auftragswert");
  const won = (await api(`/api/opportunities/${opp.id}/stage`, { method: "POST", body: { stage: "won", value_eur: 24000 } })).json;
  assert.equal(won.stage, "won");
  assert.ok(won.attribution.confirmed_pains.includes("Disposition per Telefon und Whiteboard"));
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = ?", acc.id), "won");

  const report = (await api("/api/learning")).json;
  assert.equal(report.totals.won, 1);
  assert.equal(report.totals.revenue, 24000);
  const row = report.plays.find(p => p.id === play.id);
  assert.equal(row.won, 1);
  assert.equal(row.revenue_per_account, 24000);
  assert.equal(report.by_angle[0].label, "Disposition bei Wachstum");
  const noTime = report.objections.find(o => o.key === "no_time");
  assert.equal(noTime.text, "Keine Zeit", "Einwände werden nach Art gebündelt");
  assert.deepEqual(noTime.examples, ["Gerade viel los"]);
  const pipe = (await api("/api/opportunities?stage=won")).json;
  assert.equal(pipe.summary.by_stage.won.value, 24000);
});

test("Verloren: Grund Pflicht, Erkenntnis landet im Gedächtnis und in der Auswertung", async () => {
  const id = (await api("/api/accounts", { method: "POST", body: { domain: "verloren-gmbh.de", name: "Verloren GmbH" } })).json.account.id;
  const opp = (await api(`/api/accounts/${id}/opportunities`, { method: "POST", body: { stage: "qualified", value_eur: 8000 } })).json.opportunity_id;
  assert.equal((await api(`/api/opportunities/${opp}/stage`, { method: "POST", body: { stage: "lost", loss: {} } })).status, 400);
  const r = await api(`/api/opportunities/${opp}/stage`, { method: "POST", body: { stage: "lost", loss: { primary: "existing_system", detectable_earlier: true, signal: "ERP-Projekt im Impressum/News", learning: "Firmen mit laufendem ERP-Projekt später ansprechen" } } });
  assert.equal(r.json.stage, "lost");
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = ?", id), "lost");
  assert.ok(q.get("SELECT 1 FROM account_memory WHERE account_id = ? AND text LIKE '%ERP-Projekt%'", id));
  const report = (await api("/api/learning")).json;
  assert.equal(report.loss_reasons[0].key, "existing_system");
  assert.equal(report.detectable_earlier[0].opportunity_id, opp);
});

test("Heute: positive Antwort zuerst, mit Antwortziel; Aufgabe an Firma ohne Lead → Termin legt Chance an", async () => {
  const leadId = makeLead({ email: "s.weber@weber-anlagen.de", company: "Weber Anlagen", first_name: "Sara", last_name: "Weber" });
  const accId = ensureAccountForLead(leadId);
  const mb = makeMailbox();
  const now = Date.now();
  const conv = insert("conversations", { mailbox_id: mb, lead_id: leadId, subject: "Re: Frage", label: "interested", status: "open", last_at: now - 45 * 60000, last_inbound_at: now - 45 * 60000, created_at: now - DAY_MS });
  insert("messages", { conversation_id: conv, lead_id: leadId, mailbox_id: mb, direction: "in", kind: "reply", subject: "Re: Frage", text: "Klingt spannend", status: "received", created_at: now - 45 * 60000 });
  const t = todayActions();
  assert.equal(t.items[0].kind, "reply");
  assert.equal(t.items[0].conversation_id, conv);
  assert.equal(t.items[0].overdue, true, "45 Min. > 30 Min. Ziel");
  assert.equal(nextBestAction(q.get("SELECT * FROM accounts WHERE id = ?", accId)).type, "reply");

  // Firma aus dem Impressum: Person ohne E-Mail, Aufgabe → Termin (z. B. über die Sales App vereinbart)
  const acc2 = (await api("/api/accounts", { method: "POST", body: { domain: "kaltenbach-technik.de", name: "Kaltenbach Technik" } })).json.account;
  const withPerson = (await api(`/api/accounts/${acc2.id}/people`, { method: "POST", body: { name: "Jan Kaltenbach", role: "Geschäftsführer", phone: "02261 999", committee_role: "economic_buyer" } })).json;
  const person = withPerson.people[0];
  assert.equal((await api(`/api/accounts/${acc2.id}/tasks`, { method: "POST", body: { type: "call", person_id: person.id } })).status, 400, "keine Anrufe in dieser App");
  await api(`/api/accounts/${acc2.id}/tasks`, { method: "POST", body: { person_id: person.id } });
  const task = q.get("SELECT * FROM tasks WHERE account_id = ? AND status = 'open'", acc2.id);
  const row = (await api(`/api/tasks/${task.id}`)).json;
  assert.equal(row.phone, "02261 999", "Telefon aus dem Firmenprofil");
  await api(`/api/tasks/${task.id}/outcome`, { method: "POST", body: { outcome: "meeting", notes: "Termin Dienstag" } });
  assert.ok(q.get("SELECT 1 FROM opportunities WHERE account_id = ?", acc2.id), "Termin → Chance");
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = ?", acc2.id), "meeting");
  assert.ok(q.get("SELECT 1 FROM account_memory WHERE account_id = ? AND text LIKE '%Termin Dienstag%'", acc2.id));
});

test("Anlass von Hand: passende Firma springt auf „Anlass erkannt“; Sperren stoppt alles", async () => {
  const acc = (await api("/api/accounts", { method: "POST", body: { domain: "hand-anlass.de", name: "Hand Anlass" } })).json.account;
  const b = (await api(`/api/accounts/${acc.id}/signals`, { method: "POST", body: { title: "Neuer Geschäftsführer seit Mai", type: "leadership" } })).json;
  assert.equal(b.account.lifecycle, "triggered");
  assert.ok(q.get("SELECT 1 FROM tasks WHERE account_id = ? AND title LIKE 'Neuer Anlass%'", acc.id));
  const sup = (await api(`/api/accounts/${acc.id}/lifecycle`, { method: "POST", body: { state: "suppressed", reason: "Wünscht keinen Kontakt" } })).json;
  assert.equal(sup.account.lifecycle, "suppressed");
  assert.equal(q.value("SELECT COUNT(*) FROM tasks WHERE account_id = ? AND status = 'open'", acc.id), 0);
});

test("Keine Reaktion: kontaktierte Firma ohne Antwort nach Sequenz-Ende wird später erneut geprüft", () => {
  const leadId = makeLead({ email: "x@stille-firma.de", company: "Stille Firma" });
  const accId = ensureAccountForLead(leadId);
  advance(accId, "contacted");
  const mb = makeMailbox();
  insert("messages", { lead_id: leadId, mailbox_id: mb, direction: "out", kind: "campaign", subject: "Frage", text: "…", status: "sent", created_at: Date.now() - 20 * DAY_MS });
  markNoResponse();
  const a = q.get("SELECT * FROM accounts WHERE id = ?", accId);
  assert.equal(a.lifecycle, "no_response");
  assert.ok(a.next_check_at > Date.now());
});

test("Plausibilitätsprüfung der Recherche ohne KI", () => {
  const sources = [{ label: "S1", url: "https://a.de/", text: "Wir sind ein Familienbetrieb mit 25 Mitarbeitern in Köln." }];
  const v = validateResearch({ facts: [{ statement: "25 Mitarbeitende", type: "verified", confidence: 90, source: "S1", quote: "25 Mitarbeitern in Köln" }], signals: [{ type: "hiring", title: "x", detail: "", strength: 80, confidence: 80, source: "S1", quote: "sucht Monteure" }], hypotheses: [], people: [] }, sources);
  assert.equal(v.facts.length, 1);
  assert.equal(v.facts[0].type, "verified");
  assert.equal(v.signals.length, 0, "Anlass ohne Zitat in der Quelle wird verworfen");
});

// ---------- Regressionen aus dem Code-Review ----------
import { deleteLeadCompletely } from "../src/api/leads.js";
import { markUnsubscribed } from "../src/mail/inbound.js";
import { contactBlock } from "../src/engine/rules.js";
import { backfillAccounts, domainForLead } from "../src/intel/accounts.js";
import { createTask, handleBooking } from "../src/engine/followup.js";
import { isPrivateIp } from "../src/lib/website.js";

test("DSGVO-Löschung entfernt auch Person und Notizen im Firmenprofil", () => {
  const id = makeLead({ email: "erika@loesch-gmbh.de", first_name: "Erika", last_name: "Muster", phone: "0221 123456" });
  const acc = ensureAccountForLead(id);
  markUnsubscribed(id, { source: "link" });
  markUnsubscribed(id, { source: "link" });
  assert.equal(q.value("SELECT COUNT(*) FROM account_memory WHERE lead_id = ?", id), 1, "keine doppelte Notiz");
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = ?", acc), "suppressed", "niemand mehr erreichbar → Firma gesperrt");
  deleteLeadCompletely(id);
  assert.equal(q.value("SELECT COUNT(*) FROM account_people WHERE account_id = ? AND (email = 'erika@loesch-gmbh.de' OR name LIKE '%Erika%')", acc), 0);
  assert.equal(q.value("SELECT COUNT(*) FROM account_memory WHERE account_id = ? AND text LIKE '%Erika%'", acc), 0);
});

test("„Nicht kontaktieren“ und gesperrte Firmen werden beim Versand und Aufnehmen durchgesetzt", async () => {
  const camp = { legal_basis: "consent" };
  const a = makeLead({ email: "nein@sperr-firma.de" });
  ensureAccountForLead(a);
  const lead = q.get("SELECT * FROM leads WHERE id = ?", a);
  const person = q.get("SELECT * FROM account_people WHERE lead_id = ?", a);
  assert.equal(contactBlock(camp, lead), null);
  await api(`/api/accounts/${lead.account_id}/people/${person.id}`, { method: "PUT", body: { do_not_contact: true } });
  assert.match(contactBlock(camp, lead).reason, /nicht kontaktieren/);
  const b = makeLead({ email: "x@gesperrt-ag.de" });
  const accB = ensureAccountForLead(b);
  setLifecycle(accB, "suppressed");
  assert.match(contactBlock(camp, q.get("SELECT * FROM leads WHERE id = ?", b), { stepIndex: 1 }).reason, /gesperrt/);
});

test("Firmen-Zuordnung: neue Leads trotz vieler Freemail-Leads, keine Facebook-Firma", () => {
  for (let i = 0; i < 30; i++) makeLead({ email: `privat${i}x@gmail.com`, website: "" });
  const fresh = makeLead({ email: "neu@frisch-gmbh.de" });
  backfillAccounts(10);
  assert.ok(q.value("SELECT account_id FROM leads WHERE id = ?", fresh), "neueste Leads zuerst");
  assert.equal(domainForLead({ email: "a@firma-x.de", website: "https://www.facebook.com/firmax" }), "firma-x.de");
  const id = makeLead({ email: "b@kaputte-seite.de", website: "keine" });
  const acc = q.get("SELECT * FROM accounts WHERE id = ?", ensureAccountForLead(id));
  assert.equal(acc.website, "https://kaputte-seite.de");
});

test("Endzustände bleiben, Absage einer Person stuft die Firma nicht herab, wenn ein Kollege interessiert ist", () => {
  const id = insert("accounts", { domain: "verloren-bleibt.de", name: "V", lifecycle: "lost", created_at: Date.now(), updated_at: Date.now() });
  assert.equal(sideState(id, "not_now"), false);
  assert.equal(sideState(id, "no_response"), false);
});

test("Terminabsage setzt Chance und Firma zurück; Aufgaben je Person", () => {
  const leadId = makeLead({ email: "termin@absage-gmbh.de", first_name: "Tim" });
  const acc = ensureAccountForLead(leadId);
  markMeetingBooked(leadId, { at: Date.now() + DAY_MS, source: "test" });
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = ?", acc), "meeting");
  handleBooking({ event: "invitee.canceled", payload: { email: "termin@absage-gmbh.de" } });
  assert.equal(q.value("SELECT meeting_at FROM opportunities WHERE account_id = ?", acc), null);
  assert.equal(q.value("SELECT lifecycle FROM accounts WHERE id = ?", acc), "engaged");
  const p1 = insert("account_people", { account_id: acc, name: "A", created_at: Date.now(), updated_at: Date.now() });
  const p2 = insert("account_people", { account_id: acc, name: "B", created_at: Date.now(), updated_at: Date.now() });
  assert.notEqual(createTask({ type: "todo", account_id: acc, person_id: p1, title: "A" }), createTask({ type: "todo", account_id: acc, person_id: p2, title: "B" }));
  assert.equal(createTask({ type: "call", account_id: acc, person_id: p1, title: "Anruf" }), null, "Anruf-Aufgaben entstehen nicht");
});

test("SSRF-Schutz erkennt IPv4-gemappte IPv6-Adressen in Hex-Form", () => {
  for (const ip of ["::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "::7f00:1", "2002:7f00:1::"]) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ["::ffff:808:808", "2606:4700::1111", "8.8.8.8"]) assert.equal(isPrivateIp(ip), false, ip);
});
