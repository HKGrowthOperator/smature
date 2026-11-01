// Leadquellen: OpenStreetMap-Kandidaten, Website-Prüfung, Qualifizierung je Profil, Pool-Import, Hintergrund-Takt, API.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeLead } from "./helpers.js";
import { createApp } from "../src/app.js";
import { ensureAdmin } from "../src/auth.js";
import { q, insert, parseJson } from "../src/db.js";
import { buildQuery, toCandidates, setOverpassFetch } from "../src/lib/overpass.js";
import { websiteQuality, inquirySignals, employeeEstimate, extractFacts, extractAddress, extractPhone, legalForm, setSiteFetcher } from "../src/intel/sitecheck.js";
import { qualify, createRun, runSourcingTick, poolList, setSourcingVerifier, categoryLabel, bestPool, workUnits } from "../src/intel/sourcing.js";
import { htmlToText } from "../src/lib/text.js";
import { guessChiefEmail } from "../src/intel/imprint.js";
import { saveSettings } from "../src/settings.js";

const OLD_HOME = `<html><head><title>Müller Bedachungen – Dachdecker Gummersbach</title></head><body>
<a href="/impressum">Impressum</a> <a href="/ueber-uns">Über uns</a> <a href="/karriere">Karriere</a>
<h1>Müller Bedachungen</h1><p>Dachdeckerei und Zimmerei in Gummersbach. Steildach, Flachdach, Fassade, Dachfenster und Reparaturen für Privat- und Gewerbekunden im Oberbergischen Kreis.
Wir sind Ihr Partner rund ums Dach. Rufen Sie uns an oder kommen Sie vorbei. Unsere Leistungen umfassen Neueindeckung, Sanierung, Dämmung, Abdichtung und Wartung.
Wir arbeiten mit Ziegel, Schiefer, Metall und Bitumen. Seit vielen Jahren betreuen wir Hausbesitzer, Verwaltungen und Gewerbebetriebe in der Region.</p>
<font size="2">© 2016 Müller Bedachungen</font></body></html>`;
const OLD_IMPRINT = `<html><body><h1>Impressum</h1><p>Müller Bedachungen GmbH<br>Hauptstraße 12<br>51643 Gummersbach</p><p>Telefon: 02261 123456<br>E-Mail: info@mueller-dach.de</p>
<p>Geschäftsführer: Peter Müller</p><p>Registergericht: Amtsgericht Köln, HRB 12345</p></body></html>`;
const OLD_ABOUT = `<html><body><h1>Über uns</h1><p>Seit 1985 sind wir als Familienbetrieb in Gummersbach für Sie da. Als Meisterbetrieb der Dachdecker-Innung stehen wir für saubere Arbeit.
Unser Team: 25 Mitarbeiter, davon 4 Meister. Wir bilden aus und sind in zweiter Generation inhabergeführt.</p></body></html>`;
const OLD_CAREER = `<html><body><h1>Karriere</h1><p>Dachdecker (m/w/d) gesucht. Zimmerer (m/w/d) gesucht.</p></body></html>`;

const MODERN_HOME = `<html><head><meta name="viewport" content="width=device-width"><title>Agentur Nord – B2B-Marketing und Vertrieb</title></head><body>
<a href="/impressum">Impressum</a> <a href="/kontakt">Kontakt</a>
<h1>Agentur Nord</h1><h2>Leadgenerierung</h2><h2>Content</h2><h2>Webdesign</h2><h2>SEO</h2><h2>Beratung</h2><h2>Kampagnen</h2>
<p>Wir helfen Unternehmen aus dem Mittelstand, Neukunden zu gewinnen. B2B-Marketing, Leadgenerierung und Vertriebsunterstützung für Geschäftskunden.
Unser Vertriebsteam begleitet Sie von der Strategie bis zum Abschluss. Jetzt anfragen und Termin vereinbaren. Angebot anfordern für Ihre Kampagne.</p>
<a href="https://calendly.com/agentur-nord">Termin buchen</a>
<form><input type="email" name="email"><textarea name="msg"></textarea></form>
<p>© 2026 Agentur Nord GmbH</p></body></html>`;
const MODERN_IMPRINT = `<html><body><h1>Impressum</h1><p>Agentur Nord GmbH, Hafenweg 3, 50667 Köln</p><p>Tel.: 0221 9876543, E-Mail: anna.weber@agentur-nord.de, info@agentur-nord.de</p><p>Geschäftsführerin: Anna Weber</p></body></html>`;

const LAW_HOME = `<html><head><meta name="viewport" content="x"><title>Kanzlei Schmidt Rechtsanwälte</title></head><body><a href="/impressum">Impressum</a><p>Rechtsberatung für Unternehmen. Wir vertreten Sie.</p><p>© 2026</p></body></html>`;
const LAW_IMPRINT = `<html><body><p>Kanzlei Schmidt Rechtsanwälte, Ring 1, 50667 Köln, E-Mail: kanzlei@kanzlei-recht.de</p><p>Inhaber: Jens Schmidt</p></body></html>`;

const FREE_HOME = `<html><head><title>Malerbetrieb Klein</title></head><body><a href="/impressum">Impressum</a><p>Malerarbeiten aller Art.</p></body></html>`;
const FREE_IMPRINT = `<html><body><p>Malerbetrieb Klein, Dorfstraße 5, 51645 Gummersbach, E-Mail: malerklein@t-online.de</p><p>Inhaber: Karl Klein</p></body></html>`;

const PAGES = {
  "https://www.mueller-dach.de": OLD_HOME, "https://www.mueller-dach.de/impressum": OLD_IMPRINT, "https://www.mueller-dach.de/ueber-uns": OLD_ABOUT, "https://www.mueller-dach.de/karriere": OLD_CAREER,
  "https://www.agentur-nord.de": MODERN_HOME, "https://www.agentur-nord.de/impressum": MODERN_IMPRINT,
  "https://www.kanzlei-recht.de": LAW_HOME, "https://www.kanzlei-recht.de/impressum": LAW_IMPRINT,
  "https://www.maler-klein.de": FREE_HOME, "https://www.maler-klein.de/impressum": FREE_IMPRINT,
  "https://www.werk-koeln.de": OLD_HOME.replace("Müller Bedachungen", "Werk Köln"), "https://www.werk-koeln.de/impressum": OLD_IMPRINT.replace("mueller-dach.de", "werk-koeln.de"), "https://www.werk-koeln.de/ueber-uns": OLD_ABOUT, "https://www.werk-koeln.de/karriere": OLD_CAREER
};
const ELEMENTS = {
  "Oberbergischer Kreis": [
    { type: "node", id: 1, lat: 51, lon: 7.5, tags: { name: "Müller Bedachungen", craft: "roofer", website: "https://www.mueller-dach.de", "addr:city": "Gummersbach", "addr:postcode": "51643", phone: "+49 2261 123456" } },
    { type: "way", id: 2, center: { lat: 51, lon: 7 }, tags: { name: "Agentur Nord", office: "advertising_agency", "contact:website": "https://www.agentur-nord.de", "addr:city": "Köln" } },
    { type: "node", id: 3, tags: { name: "Kanzlei Schmidt Rechtsanwälte", office: "lawyer", website: "https://www.kanzlei-recht.de" } },
    { type: "node", id: 4, tags: { name: "Malerbetrieb Klein", craft: "painter", website: "https://www.maler-klein.de" } },
    { type: "node", id: 5, tags: { name: "Bestand GmbH", craft: "electrician", website: "https://www.bestand.de" } },
    { type: "node", id: 6, tags: { craft: "plumber", website: "https://ohne-namen.de" } },
    { type: "node", id: 7, tags: { name: "Nur Telefon", craft: "plumber", phone: "0221 1" } }
  ],
  "Köln": [{ type: "node", id: 8, tags: { name: "Werk Köln", industrial: "factory", website: "https://www.werk-koeln.de", "addr:city": "Köln" } }]
};

let cleanup, server, base, api;
before(async () => {
  cleanup = setupDb({ ADMIN_EMAIL: "admin@test.de", ADMIN_PASSWORD: "ein-langes-passwort" });
  ensureAdmin();
  saveSettings({ guess_chief_emails: true }); // die Tests prüfen das Bilden von Adressen
  server = createApp();
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@test.de", password: "ein-langes-passwort" }) });
  const session = { cookie: (res.headers.get("set-cookie") || "").split(";")[0], csrf: (await res.json()).csrf };
  api = async (path, { method = "GET", body } = {}) => {
    const r = await fetch(base + path, { method, headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  setSourcingVerifier(async email => ({ status: /invalid/.test(email) ? "invalid" : "valid", reason: "" }));
  setSiteFetcher(async url => { const key = String(url).replace(/\/$/, ""); return PAGES[key] ? { url: key === key.replace(/\/.*$/, "") ? key : key, html: PAGES[key] } : null; });
  setOverpassFetch(async (url, opts) => {
    const query = decodeURIComponent(String(opts.body).slice(5));
    const region = (/\["name"="([^"]+)"\]/.exec(query) || [])[1];
    return { ok: true, status: 200, json: async () => ({ elements: ELEMENTS[region] || [] }) };
  });
  const now = Date.now();
  insert("target_groups", { name: "Website-Kunden", project_id: 1, created_at: now, updated_at: now });
  insert("products", { name: "Unternehmenswebsite", project_id: 1, created_at: now, updated_at: now });
  makeLead({ email: "info@bestand.de", website: "https://www.bestand.de", company: "Bestand GmbH" });
});
after(async () => { setOverpassFetch(null); setSiteFetcher(null); setSourcingVerifier(null); await new Promise(r => server.close(r)); cleanup(); });

test("Overpass-Abfrage und Kandidaten aus OSM-Objekten", () => {
  const query = buildQuery("Oberbergischer Kreis", ['["craft"]', '["office"="company"]'], { limit: 100 });
  assert.match(query, /area\["boundary"="administrative"\]\["name"="Oberbergischer Kreis"\]/);
  assert.match(query, /nwr\(area\.a\)\["craft"\]\[~"\^\(website\|contact:website\|email\|contact:email\)\$"~"\."\];/);
  assert.match(query, /nwr\(area\.a\)\["office"="company"\]\[~/);
  assert.equal((query.match(/nwr\(area\.a\)/g) || []).length, 2, "eine Teilabfrage je Filter");
  assert.match(query, /out center tags 100;/);
  const c = toCandidates(ELEMENTS["Oberbergischer Kreis"]);
  assert.equal(c.length, 6, "Objekt ohne Namen fällt weg");
  assert.deepEqual({ ...c[0], lat: undefined, lon: undefined }, { osm_id: "node/1", name: "Müller Bedachungen", website: "https://www.mueller-dach.de", email: "", phone: "+49 2261 123456", city: "Gummersbach", plz: "51643", street: "", category: "craft=roofer", lat: undefined, lon: undefined });
  assert.equal(c[1].website, "https://www.agentur-nord.de");
  assert.equal(c[1].category, "office=advertising_agency");
  assert.equal(categoryLabel("craft=roofer"), "Dachdeckerei");
  assert.equal(categoryLabel("industrial=factory"), "Industrie (factory)");
});

test("Overpass: „remark“ mit leerem Ergebnis gilt als Fehler, nicht als „keine Treffer“", async () => {
  const { runOverpass } = await import("../src/lib/overpass.js");
  const prev = async (url, opts) => ({ ok: true, status: 200, json: async () => ({ elements: [] , remark: "The server is probably too busy to handle your request." }) });
  setOverpassFetch(prev);
  await assert.rejects(() => runOverpass("x"), /too busy/);
  setOverpassFetch(async () => ({ ok: true, status: 200, json: async () => ({ elements: [] }) }));
  assert.deepEqual(await runOverpass("x"), [], "ohne remark ist leer wirklich leer");
  setOverpassFetch(async (url, opts) => {
    const query = decodeURIComponent(String(opts.body).slice(5));
    const region = (/\["name"="([^"]+)"\]/.exec(query) || [])[1];
    return { ok: true, status: 200, json: async () => ({ elements: ELEMENTS[region] || [] }) };
  });
});

test("Website-Qualität, Anfrage-Signale, Mitarbeiterzahl, Fakten, Impressum-Felder", () => {
  const old = websiteQuality(OLD_HOME, "https://www.mueller-dach.de/", new Date("2026-10-07"));
  assert.ok(old.score <= 4, `alte Seite schwach: ${old.score}`);
  assert.ok(old.issues.includes("nicht für Handys gebaut") && old.issues.includes("Stand 2016") && old.issues.includes("veralteter Aufbau") && old.issues.includes("kein Kontaktformular"));
  const modern = websiteQuality(MODERN_HOME, "https://www.agentur-nord.de/", new Date("2026-10-07"));
  assert.ok(modern.score >= 8, `moderne Seite: ${modern.score}`);
  const inq = inquirySignals(MODERN_HOME, htmlToText(MODERN_HOME));
  assert.ok(inq.form && inq.booking);
  assert.ok(inq.signals.includes("Kontaktformular") && inq.signals.includes("Online-Terminbuchung") && inq.signals.includes("viele Leistungen"));
  const emp = employeeEstimate([htmlToText(OLD_ABOUT), htmlToText(OLD_CAREER)], [{ kind: "career", text: htmlToText(OLD_CAREER) }]);
  assert.equal(emp.estimate, 25);
  assert.equal(emp.jobs, 2);
  const facts = extractFacts([{ kind: "home", url: "h", html: OLD_HOME, text: htmlToText(OLD_HOME) }, { kind: "about", url: "a", html: OLD_ABOUT, text: htmlToText(OLD_ABOUT) }]);
  const keys = facts.map(f => f.key);
  assert.ok(keys.includes("gruendung") && keys.includes("familie") && keys.includes("meister") && keys.includes("ausbildung") && keys.includes("team"), keys.join(","));
  const g = facts.find(f => f.key === "gruendung");
  assert.equal(g.statement, "Betrieb seit 1985");
  assert.ok(g.quote.includes("1985") && g.source_url === "a");
  const text = htmlToText(OLD_IMPRINT);
  assert.deepEqual(extractAddress(text), { street: "Hauptstraße 12", plz: "51643", city: "Gummersbach" });
  assert.equal(extractPhone(text), "02261 123456");
  assert.equal(legalForm(text), "GmbH");
  assert.equal(legalForm("Schmidt GmbH & Co. KG, Inhaber"), "GmbH & Co. KG");
  assert.equal(guessChiefEmail({ first_name: "André", last_name: "Horsthemke" }, "baeckerei-horsthemke.de", []).email, "andre@baeckerei-horsthemke.de", "Akzente werden abgestreift");
  assert.equal(guessChiefEmail({ first_name: "Jörg", last_name: "Müller" }, "firma.de", []).email, "joerg@firma.de");
});

test("Qualifizierung je Profil", () => {
  const weak = { text: "dachdecker handwerk", quality: { score: 3, issues: ["nicht für Handys gebaut"] }, inquiry: { signals: [], form: false }, employees: { estimate: 25, signals: [] }, imprint: { legal_form: "GmbH" } };
  assert.equal(qualify("website", { name: "Müller Bedachungen" }, weak).fit, "A");
  assert.equal(qualify("website", { name: "x" }, { ...weak, quality: { score: 9, issues: [] } }).fit, "C");
  assert.equal(qualify("automation", { name: "x" }, { ...weak, quality: { score: 7, issues: [] }, inquiry: { signals: ["Kontaktformular", "Online-Terminbuchung", "WhatsApp"], form: true, booking: true } }).fit, "A");
  // Fall-Regeln: Klimatechnik nie in den DealUno-Pool, Beratung nie in den Growth-OS-Pool.
  assert.match(qualify("dealuno", { name: "Gesellschaft Kälte Klima Technik mbH", category: "craft=hvac" }, { ...weak, text: "Wir beraten Unternehmen. B2B Geschäftskunden Neukunden" }).reject || "", /kein B2B/);
  assert.match(qualify("growth_os", { name: "Oberwasser Consulting", category: "office=consulting" }, { ...weak, employees: { estimate: 60, signals: [] }, text: "Produktion Montage Industrie" }).reject || "", /beratung/);
  assert.equal(qualify("growth_os", { name: "Müller Bedachungen", category: "craft=roofer" }, weak).fit, "B");
  assert.equal(qualify("growth_os", { name: "x", category: "craft=roofer" }, { ...weak, employees: { estimate: 60, signals: [] } }).fit, "A");
  assert.ok(qualify("growth_os", { name: "x" }, { ...weak, employees: { estimate: 5, signals: [] } }).reject);
  assert.ok(qualify("growth_os", { name: "Bäckerei Hesse", category: "shop=bakery" }, { ...weak, employees: { estimate: 1000, signals: [] } }).reject, "Handel ist kein Auftragsgeschäft");
  assert.equal(qualify("growth_os", { name: "Stahlwerk", category: "industrial=factory" }, { ...weak, text: "stahl produktion", employees: { estimate: 2000, signals: [] } }).fit, "C", "Konzern");
  assert.ok(qualify("dealuno", { name: "Müller Dachdeckerei" }, weak).reject, "Handwerk ist kein DealUno-Kunde");
  const agency = { text: "wir helfen unternehmen neukunden zu gewinnen. b2b vertriebsteam geschäftskunden", quality: { score: 9, issues: [] }, inquiry: { signals: [], form: true }, employees: { estimate: 12, signals: [] }, imprint: {} };
  assert.equal(qualify("dealuno", { name: "Agentur Nord" }, agency).fit, "A");
});

test("Lauf: sammeln, prüfen, Pool füllen – Dubletten, Recht und Freemail aussortiert", async () => {
  const run = createRun({ project_id: 1, profile: "website", regions: ["Oberbergischer Kreis"], categories: ["craft_all", "office_agency"], max_candidates: 50 });
  const s = await runSourcingTick({ batch: 20 });
  assert.equal(s.collected, 4, "4 neue Kandidaten (Bestand ist Dublette, ohne Kontaktweg fällt weg)");
  assert.equal(s.processed, 4);
  assert.equal(s.imported, 2);
  assert.equal(s.rejected, 2);
  assert.equal(q.get("SELECT status, region_index FROM sourcing_runs WHERE id = ?", run.id).region_index, 1, "eine Abfrage je Takt");
  assert.equal(bestPool("website", { name: "Hamburger", category: "craft=plumber" }, { text: "sanitär service", quality: { score: 9, issues: [], title: "" }, inquiry: { signals: [], form: false }, employees: { estimate: null, signals: [] }, imprint: { legal_form: "" } }).profile, "website", "C überstimmt den Lauf-Pool nie");
  // Nonprofit-Ausschluss und Agentur-Erkennung
  const siteLike = { text: "wir helfen unternehmen neukunden zu gewinnen. b2b vertriebsteam", quality: { score: 9, issues: [], title: "Agentur" }, inquiry: { signals: [], form: true }, employees: { estimate: 12, signals: [] }, imprint: {} };
  assert.equal(bestPool("website", { name: "Agentur Nord" }, siteLike).profile, "dealuno", "Agentur mit B2B-Vertrieb → DealUno, auch aus dem Webseiten-Lauf");
  assert.equal(bestPool("website", { name: "Müller Bedachungen", category: "craft=roofer" }, { text: "dachdecker", quality: { score: 3, issues: ["alt"], title: "" }, inquiry: { signals: [], form: false }, employees: { estimate: 25, signals: [] }, imprint: { legal_form: "GmbH" } }).profile, "website", "Gleichstand → Laufprofil");
  assert.equal(bestPool("website", { name: "Stahlbau Nord", category: "craft=metal_construction" }, { text: "metallbau fertigung montage", quality: { score: 3, issues: ["alt"], title: "" }, inquiry: { signals: [], form: false }, employees: { estimate: 80, signals: [] }, imprint: { legal_form: "GmbH" } }).profile, "growth_os", "80 Mitarbeitende Auftragsgeschäft → Software Mittelstand");
  const fresh = q.get("SELECT * FROM sourcing_runs WHERE id = ?", run.id);
  assert.equal(fresh.status, "done", "zwei Kategorien = eine gebündelte Abfrage → nach einem Takt fertig");
  assert.equal(workUnits({ regions: JSON.stringify(["A", "B"]), categories: JSON.stringify(["craft_all", "shop_auto", "gastro", "leisure"]) }).total, 4, "2 Regionen × 2 Dreiergruppen");
  assert.deepEqual({ found: fresh.found, checked: fresh.checked, imported: fresh.imported, rejected: fresh.rejected, duplicates: fresh.duplicates }, { found: 4, checked: 4, imported: 2, rejected: 2, duplicates: 1 });
  const byName = Object.fromEntries(q.all("SELECT * FROM sourcing_candidates WHERE run_id = ?", run.id).map(c => [c.name, c]));
  assert.equal(byName["Bestand GmbH"].status, "duplicate");
  assert.equal(byName["Kanzlei Schmidt Rechtsanwälte"].status, "rejected");
  assert.match(byName["Kanzlei Schmidt Rechtsanwälte"].reason, /Rechtliches Umfeld/);
  assert.equal(byName["Malerbetrieb Klein"].status, "rejected");
  assert.match(byName["Malerbetrieb Klein"].reason, /Freemail/);
  // Dachdecker: alte Website → A, Chef-Adresse aus dem Impressum-Namen gebildet, Zentrale bleibt als Rückfall, Fakten am Firmenprofil.
  const m = byName["Müller Bedachungen"];
  assert.equal(m.status, "imported");
  assert.equal(m.fit, "A");
  const lead = q.get("SELECT * FROM leads WHERE id = ?", m.lead_id);
  assert.equal(lead.email, "peter@mueller-dach.de");
  assert.equal(lead.verify_status, "risky");
  assert.deepEqual([lead.first_name, lead.last_name, lead.position, lead.company, lead.city, lead.industry, lead.phone], ["Peter", "Müller", "Geschäftsführung", "Müller Bedachungen GmbH", "Gummersbach", "Dachdeckerei", "02261 123456"], "Firmenname = Rechtsträger aus dem Impressum");
  assert.equal(parseJson(lead.custom, {}).osm_name, "Müller Bedachungen");
  const custom = parseJson(lead.custom, {});
  assert.equal(custom.zentrale_email, "info@mueller-dach.de");
  assert.equal(custom.mitarbeiter, "25");
  assert.equal(custom.website_qualitaet, `${websiteQuality(OLD_HOME, "https://www.mueller-dach.de", new Date()).score}/10`);
  assert.match(custom.lob, /Betrieb seit 1985/);
  const pool = poolList(1, { create: false });
  assert.equal(pool.name, "Pool · Webseite");
  assert.ok(pool.target_group_id, "Zielgruppe des Projekts am Pool");
  assert.ok(q.get("SELECT 1 FROM lead_list_members WHERE list_id = ? AND lead_id = ?", pool.id, lead.id));
  assert.equal(q.value("SELECT project_id FROM accounts WHERE id = ?", lead.account_id), 1);
  assert.equal(parseJson(lead.custom, {}).pool, "Webseite");
  const facts = q.all("SELECT * FROM account_facts WHERE account_id = ? AND created_by = 'scrape'", lead.account_id);
  assert.ok(facts.length >= 4, `Fakten: ${facts.length}`);
  assert.ok(facts.every(f => f.source_url.startsWith("https://www.mueller-dach.de")));
  assert.equal(q.value("SELECT fit FROM lead_fit WHERE lead_id = ?", lead.id), "A");
  // Agentur: veröffentlichte persönliche Adresse der Geschäftsführerin, Anrede Frau; moderne Seite → für den Webseiten-Pitch nur C.
  const a = byName["Agentur Nord"];
  assert.equal(a.status, "imported");
  assert.equal(a.fit, "A");
  assert.match(a.reason, /→ Pool Sales-Software/);
  const alead = q.get("SELECT * FROM leads WHERE id = ?", a.lead_id);
  assert.equal(alead.email, "anna.weber@agentur-nord.de");
  assert.equal(alead.verify_status, "valid");
  assert.equal(alead.salutation, "Frau");
  assert.equal(parseJson(alead.custom, {}).anfrage_signale.includes("Online-Terminbuchung"), true);
  const pool2 = poolList(2, { create: false });
  assert.equal(pool2.name, "Pool · Software Sales App");
  assert.ok(q.get("SELECT 1 FROM lead_list_members WHERE list_id = ? AND lead_id = ?", pool2.id, alead.id), "Agentur liegt im DealUno-Pool");
  assert.equal(q.value("SELECT project_id FROM accounts WHERE id = ?", alead.account_id), 2);
  // Zweiter Lauf im selben Projekt: schon geprüfte Firmen gelten als bekannt.
  const again = createRun({ project_id: 1, profile: "automation", regions: ["Oberbergischer Kreis"], categories: ["craft_all"], max_candidates: 50 });
  const s2 = await runSourcingTick({ batch: 20 });
  assert.equal(s2.collected, 0);
  assert.equal(q.get("SELECT * FROM sourcing_runs WHERE id = ?", again.id).duplicates, 5);
  assert.equal(q.get("SELECT status FROM sourcing_runs WHERE id = ?", again.id).status, "done");
});

test("Tageslimit hält die Prüfung an, Lauf läuft danach weiter", async () => {
  saveSettings({ sourcing_daily_limit: 1 });
  const run = createRun({ project_id: 3, profile: "growth_os", regions: ["Köln"], categories: ["industrial"], max_candidates: 10 });
  const s = await runSourcingTick({ batch: 20 });
  assert.equal(s.collected, 1);
  assert.equal(s.limit_reached, true);
  assert.equal(s.processed, 0);
  assert.equal(q.get("SELECT status FROM sourcing_runs WHERE id = ?", run.id).status, "running");
  saveSettings({ sourcing_daily_limit: 0 });
  const s2 = await runSourcingTick({ batch: 20 });
  assert.equal(s2.processed, 1);
  const fresh = q.get("SELECT * FROM sourcing_runs WHERE id = ?", run.id);
  assert.equal(fresh.status, "done");
  const c = q.get("SELECT * FROM sourcing_candidates WHERE run_id = ?", run.id);
  assert.equal(c.status, "imported");
  assert.equal(c.fit, "B", "25 Mitarbeitende, Auftragsgeschäft → B");
  assert.equal(q.get("SELECT name FROM lead_lists WHERE id = ?", fresh.list_id).name, "Pool · Software Mittelstand");
});

test("API: Meta, Läufe anlegen, Kandidaten, Pause/Weiter, Einstellungen", async () => {
  const meta = (await api("/api/sourcing/meta")).json;
  assert.equal(meta.profiles.length, 4);
  const p1 = meta.projects.find(p => p.id === 1);
  assert.equal(p1.profile, "website");
  assert.equal(p1.pool.leads, 1);
  assert.equal(meta.projects.find(p => p.id === 2).pool.leads, 1);
  assert.equal(meta.projects.find(p => p.id === 3).profile, "growth_os");
  const bad = await api("/api/sourcing/runs", { method: "POST", body: { project_id: 1, regions: "" } });
  assert.equal(bad.status, 400);
  const created = await api("/api/sourcing/runs", { method: "POST", body: { project_id: 4, regions: "Köln\nBonn", categories: ["craft_all", "unbekannt"], max_candidates: 20 } });
  assert.equal(created.status, 200);
  assert.equal(created.json.profile, "automation");
  assert.deepEqual(created.json.regions, ["Köln", "Bonn"]);
  assert.deepEqual(created.json.categories, ["craft_all"]);
  const paused = await api(`/api/sourcing/runs/${created.json.id}/pause`, { method: "POST" });
  assert.equal(paused.json.status, "paused");
  const resumed = await api(`/api/sourcing/runs/${created.json.id}/resume`, { method: "POST" });
  assert.equal(resumed.json.status, "running");
  const runs = (await api("/api/sourcing/runs")).json;
  assert.ok(runs.length >= 3 && runs[0].project_name);
  const first = runs[runs.length - 1];
  const detail = (await api(`/api/sourcing/runs/${first.id}`)).json;
  assert.equal(detail.stats.by_status.imported, 2);
  assert.ok(detail.stats.reasons.some(r => /Rechtliches Umfeld/.test(r.reason)));
  const rejected = (await api(`/api/sourcing/runs/${first.id}/candidates?status=rejected`)).json;
  assert.equal(rejected.total, 2);
  assert.ok(rejected.items[0].data.quality, "Zusammenfassung der Website-Prüfung liegt bei");
  const settings = await api("/api/sourcing/settings", { method: "PUT", body: { sourcing_daily_limit: 500, sourcing_regions: "Köln, Bonn\nKreis Olpe" } });
  assert.deepEqual(settings.json, { sourcing_daily_limit: 500, sourcing_regions: ["Köln", "Bonn", "Kreis Olpe"] });
  const tick = await api("/api/sourcing/tick", { method: "POST" });
  assert.equal(tick.status, 200);
  const del = await api(`/api/sourcing/runs/${created.json.id}`, { method: "DELETE" });
  assert.equal(del.json.ok, true);
  // Lauf samt Leads verwerfen: Leads und verwaiste Firmen verschwinden, Pool-Liste bleibt.
  const leadsBefore = q.value("SELECT COUNT(*) FROM leads WHERE source LIKE 'Leadquelle%'");
  const withLeads = await api(`/api/sourcing/runs/${first.id}?leads=1`, { method: "DELETE" });
  assert.equal(withLeads.json.removed, 2);
  assert.equal(q.value("SELECT COUNT(*) FROM leads WHERE source LIKE 'Leadquelle%'"), leadsBefore - 2);
  assert.equal(q.value("SELECT COUNT(*) FROM accounts WHERE domain IN ('mueller-dach.de','agentur-nord.de')"), 0);
  assert.ok(q.get("SELECT 1 FROM lead_lists WHERE name = 'Pool · Webseite'"));
});


test("Adresse: „Fax“, „Deutschland“ oder Telefonzeilen werden nie zum Ort", async () => {
  const { extractAddress } = await import("../src/intel/sitecheck.js");
  assert.deepEqual(extractAddress("Hauptstraße 12\n51709 Marienheide Deutschland\nTel 02264 1234"), { street: "Hauptstraße 12", plz: "51709", city: "Marienheide" });
  assert.equal(extractAddress("Telefon 02264 51709 Fax 02264 4321"), null);
  assert.equal(extractAddress("Musterweg 3 51709 Fax 02264 4321"), null);
  assert.deepEqual(extractAddress("Musterweg 3, 51709 Bergisch Gladbach\nFax 1"), { street: "Musterweg 3", plz: "51709", city: "Bergisch Gladbach" });
});
