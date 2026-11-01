// Geschäftsführer aus dem Impressum: Namen erkennen, nur veröffentlichte persönliche Adressen übernehmen, nichts raten.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeLead } from "./helpers.js";
import { createApp } from "../src/app.js";
import { ensureAdmin } from "../src/auth.js";
import { q, parseJson } from "../src/db.js";
import { imprintPeople, imprintEmails, personalEmailFor, firmPattern, guessChiefEmail, setImprintFetcher } from "../src/intel/imprint.js";
import { htmlToText } from "../src/lib/text.js";

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
    return { status: r.status, json: await r.json().catch(() => null) };
  };
});
after(async () => { setImprintFetcher(null); await new Promise(r => server.close(r)); cleanup(); });

const names = html => imprintPeople(htmlToText(html)).map(p => `${p.salutation}|${p.first_name} ${p.last_name}|${p.role}`);

test("Namen aus typischen Impressen", () => {
  assert.deepEqual(names("<p>Geschäftsführer: Dipl.-Ing. Max Mustermann</p><p>Registergericht: Amtsgericht Köln</p>"), ["|Max Mustermann|Geschäftsführung"]);
  assert.deepEqual(names("<p>Vertreten durch die Geschäftsführer Max Mustermann und Karl-Heinz von Berg</p>"), ["|Max Mustermann|Geschäftsführung", "|Karl-Heinz von Berg|Geschäftsführung"]);
  assert.deepEqual(names("Geschäftsführerin: Erika Musterfrau<br>Telefon 0221 123"), ["Frau|Erika Musterfrau|Geschäftsführung"]);
  assert.deepEqual(names("Inhaber: Herr Jens Schmidt, Mailand-Straße 3"), ["Herr|Jens Schmidt|Inhaber"]);
  assert.deepEqual(names("<p>Persönlich haftende Gesellschafterin: Muster Verwaltungs GmbH, vertreten durch deren Geschäftsführer Dr. Paul Beispiel</p>"), ["|Paul Beispiel|Geschäftsführung"]);
  assert.deepEqual(names("Geschäftsführung: Muster Holding GmbH"), [], "Firmen sind keine Personen");
  assert.deepEqual(names("Kontakt: info@firma.de"), []);
  assert.deepEqual(names("Bildrechte: Inhaber der Schutzrechte sind die jeweiligen Fotografen"), [], "kein Name aus Fließtext");
});

test("Adressen: auch verschleiert, nur persönliche der Person auf der Firmen-Domain", () => {
  const html = `<a href="mailto:info@muster-bau.de">info@muster-bau.de</a> m.mustermann (at) muster-bau.de <img src="logo@2x.png"> max.mustermann@gmail.com t.andere@muster-bau.de`;
  const emails = imprintEmails(html);
  assert.ok(emails.includes("m.mustermann@muster-bau.de"));
  const p = { first_name: "Max", last_name: "Mustermann" };
  assert.equal(personalEmailFor(p, emails, ["muster-bau.de"]), "m.mustermann@muster-bau.de");
  assert.equal(personalEmailFor({ first_name: "Jörg", last_name: "Müller" }, ["j.mueller@x.de", "info@x.de"], ["x.de"]), "j.mueller@x.de");
  assert.equal(personalEmailFor({ first_name: "Jörg", last_name: "Müller" }, ["info@x.de"], ["x.de"]), null, "nichts raten");
});

test("Sammelaktion: Name ergänzen, info@ gegen Chef-Adresse tauschen – veröffentlicht oder aus dem Namen gebildet", async () => {
  const pages = {
    "https://muster-bau.de": `<a href="/impressum">Impressum</a>`,
    "https://muster-bau.de/impressum": `<p>Geschäftsführer: Herr Max Mustermann</p><p>E-Mail: m.mustermann@muster-bau.de</p>`,
    "https://ohne-mail.de": `<a href="/rechtliches/impressum">Impressum</a>`,
    "https://ohne-mail.de/rechtliches/impressum": `<p>Geschäftsführerin: Erika Beispiel</p><p>E-Mail: info@ohne-mail.de</p>`,
    "https://www.anderer-kontakt.de": `<p>Impressum – Geschäftsführer: Paul Chef</p>`
  };
  setImprintFetcher(async url => { const key = url.replace(/\/$/, ""); return pages[key] ? { url: key, html: pages[key] } : null; });
  const anon = { salutation: "", first_name: "", last_name: "" };
  const a = makeLead({ ...anon, email: "info@muster-bau.de", website: "https://muster-bau.de", company: "Muster Bau" });
  const b = makeLead({ ...anon, email: "info@ohne-mail.de", company: "Ohne Mail" });
  const c = makeLead({ email: "vertrieb@anderer-kontakt.de", first_name: "Anna", last_name: "Vertrieb", company: "Anderer Kontakt" });
  const d = makeLead({ ...anon, email: "info@offline-test.de", company: "Offline" });
  const r = await api("/api/leads/imprint-contacts", { method: "POST", body: { ids: [a, b, c, d] } });
  assert.equal(r.status, 200);
  assert.equal(r.json.checked, 4);
  assert.equal(r.json.email_published, 1);
  assert.equal(r.json.email_guessed, 1);
  const la = q.get("SELECT * FROM leads WHERE id = ?", a);
  assert.equal(la.email, "m.mustermann@muster-bau.de", "veröffentlichte Adresse übernommen");
  assert.equal(la.verify_status, "valid");
  assert.equal(la.salutation, "Herr");
  assert.equal(parseJson(la.custom, {}).zentrale_email, "info@muster-bau.de");
  const lb = q.get("SELECT * FROM leads WHERE id = ?", b);
  assert.equal(lb.email, "erika@ohne-mail.de", "kein Muster bekannt → Vorname@firma");
  assert.equal(lb.verify_status, "risky", "geraten = riskant, Bounce wird erkannt");
  assert.equal(parseJson(lb.custom, {}).zentrale_email, "info@ohne-mail.de", "info@ bleibt als Zentrale");
  assert.equal(`${lb.salutation} ${lb.first_name} ${lb.last_name}`, "Frau Erika Beispiel");
  const lc = q.get("SELECT * FROM leads WHERE id = ?", c);
  assert.equal(lc.last_name, "Vertrieb", "vorhandener anderer Ansprechpartner bleibt");
  assert.match(r.json.items.find(x => x.id === c).note, /anderer Kontakt/);
  assert.match(r.json.items.find(x => x.id === d).note, /nicht erreichbar/);
  assert.equal(parseJson(q.value("SELECT custom FROM leads WHERE id = ?", d), {}).impressum_fehler, "Website nicht erreichbar");
  assert.equal(r.json.items.find(x => x.id === c).person, "Paul Chef", "Seite nur unter www. erreichbar");
  // Zweiter Lauf: bereits geprüfte werden übersprungen
  const again = await api("/api/leads/imprint-contacts", { method: "POST", body: { ids: [a, b] } });
  assert.equal(again.json.checked, 0);
});

test("Chef-Adresse aus dem Namen: Muster der Firma von der Kontaktseite, sonst Vorname@firma", () => {
  assert.equal(firmPattern(["t.vertrieb@firma.de", "info@firma.de"], "firma.de"), "{fi}.{l}");
  assert.equal(firmPattern(["anna.beispiel@firma.de"], "firma.de"), "{f}.{l}");
  assert.equal(firmPattern(["max@gmail.com", "info@firma.de"], "firma.de"), "", "Freemail und Rollen zählen nicht");
  // Firmen-Muster {fi}.{l} wird angewandt
  const g1 = guessChiefEmail({ first_name: "Jörg-Peter", last_name: "von Müller" }, "firma.de", ["t.vertrieb@firma.de"]);
  assert.equal(g1.email, "j.mueller@firma.de");
  assert.equal(g1.guessed, false, "aus echtem Firmen-Muster, nicht geraten");
  // Kein Muster bekannt → Vorname@firma (häufigster Fall)
  const g2 = guessChiefEmail({ first_name: "Max", last_name: "Mustermann" }, "firma.de", []);
  assert.equal(g2.email, "max@firma.de");
  assert.equal(g2.guessed, true);
  assert.equal(guessChiefEmail({ first_name: "", last_name: "" }, "firma.de", []), null);
});

test("Kontaktseite liefert das Firmen-Muster: Chef-Adresse im selben Format gebildet", async () => {
  const pages = {
    "https://muster-chef.de": `<a href="/impressum">Impressum</a><a href="/team">Team</a>`,
    "https://muster-chef.de/impressum": `<p>Geschäftsführer: Dr. Stefan Berger</p><p>E-Mail: info@muster-chef.de</p>`,
    "https://muster-chef.de/team": `<p>Vertrieb: thomas.klein@muster-chef.de</p>`
  };
  setImprintFetcher(async url => { const key = url.replace(/\/$/, ""); return pages[key] ? { url: key, html: pages[key] } : null; });
  const id = makeLead({ salutation: "", first_name: "", last_name: "", email: "info@muster-chef.de", company: "Muster Chef" });
  const r = await api("/api/leads/imprint-contacts", { method: "POST", body: { ids: [id] } });
  assert.equal(r.json.email_switched, 1);
  const lead = q.get("SELECT * FROM leads WHERE id = ?", id);
  assert.equal(lead.email, "stefan.berger@muster-chef.de", "Muster {f}.{l} von der Team-Seite übernommen");
  assert.equal(lead.verify_status, "risky");
  assert.equal(lead.last_name, "Berger");
  assert.match(parseJson(lead.custom, {}).chef_email_quelle, /Adressmuster der Firma/);
});
