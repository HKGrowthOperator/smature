// Website-Prüfung für Leadquellen: Startseite, Impressum und bis zu drei weitere eigene Seiten der Firma lesen und ableiten:
// Qualität der Website (Webseiten-Pitch), Anfrage-Signale (Website + Automation), Mitarbeiterzahl (Software Mittelstand),
// Geschäftsführung mit Adressen (Chef-Adresse) und belegte Fakten für ein echtes Lob in der ersten Mail.
// Nur öffentliche Seiten der Firma selbst, höchstens 5 Seiten je Firma, keine fremden Verzeichnisse, kein Login.
import { fetchPage, extractLinks } from "../lib/website.js";
import { htmlToText, decodeEntities } from "../lib/text.js";
import { imprintPeople, imprintEmails } from "./imprint.js";

let fetcher = fetchPage;
export function setSiteFetcher(fn) { fetcher = fn || fetchPage; }

const PAGE_KINDS = [
  ["impressum", /impressum|imprint|legal-notice|anbieterkennzeichnung/i],
  ["contact", /kontakt|contact|anfahrt/i],
  ["about", /ueber-uns|uber-uns|über-uns|über uns|about|unternehmen|wir-ueber|wir über|\bteam\b|\bfirma\b|historie|geschichte|philosophie/i],
  ["career", /karriere|jobs|stellen|career|ausbildung|bewerb/i],
  ["references", /referenz|projekte|kundenstimmen|bewertungen|portfolio/i],
  ["services", /leistung|produkt|service|angebot|kompetenz/i]
];

function startUrls(start) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(start) ? start : `https://${start}`); } catch { return [start]; }
  const host = u.hostname.replace(/^www\./, "");
  return [...new Set([u.toString(), `https://www.${host}/`, `http://www.${host}/`, `http://${host}/`])];
}
const pathOf = url => { try { return new URL(url).pathname; } catch { return ""; } };

export async function inspectSite(start, { maxPages = 5 } = {}) {
  let home = null;
  for (const url of startUrls(start)) {
    home = await fetcher(url).catch(() => null);
    if (home) break;
  }
  if (!home) return { ok: false, error: "Website nicht erreichbar" };
  const pages = [{ kind: "home", url: home.url, html: home.html }];
  const links = extractLinks(home.html, home.url);
  for (const [kind, re] of PAGE_KINDS) {
    if (pages.length >= maxPages) break;
    const link = links.find(l => re.test(pathOf(l.url)) || re.test(l.text));
    if (!link || pages.some(p => p.url === link.url)) continue;
    const page = await fetcher(link.url).catch(() => null);
    if (page) pages.push({ kind, url: page.url, html: page.html });
  }
  // Das Impressum ist Pflicht – notfalls die üblichen Pfade probieren.
  if (!pages.some(p => p.kind === "impressum")) {
    for (const path of ["/impressum", "/impressum/", "/impressum.html"]) {
      let page = null;
      try { page = await fetcher(new URL(path, home.url).toString()); } catch { page = null; }
      if (page) { pages.push({ kind: "impressum", url: page.url, html: page.html }); break; }
    }
  }
  for (const p of pages) p.text = htmlToText(p.html);
  const imprintPage = pages.find(p => p.kind === "impressum") || (/impressum|geschäftsführer|inhaber/i.test(pages[0].text) ? pages[0] : null);
  const imprint = imprintPage ? readImprint(imprintPage, pages) : { url: "", people: [], emails: [], phone: "", address: null, legal_form: "" };
  const texts = pages.map(p => p.text);
  return {
    ok: true, url: home.url, pages: pages.map(p => ({ kind: p.kind, url: p.url })), imprint,
    quality: websiteQuality(home.html, home.url), inquiry: inquirySignals(home.html, texts.join("\n")),
    employees: employeeEstimate(texts, pages), facts: extractFacts(pages), text: texts.join("\n").toLowerCase().slice(0, 60000)
  };
}

function readImprint(page, pages) {
  const emails = new Set(imprintEmails(page.html));
  for (const p of pages) if (p.kind === "contact" || p.kind === "home") for (const e of imprintEmails(p.html)) emails.add(e);
  return { url: page.url, people: imprintPeople(page.text), emails: [...emails], phone: extractPhone(page.text), address: extractAddress(page.text), legal_form: legalForm(page.text), company: extractCompanyName(page.text) };
}

// Rechtsträger aus dem Impressum: die erste Zeile mit Rechtsform (z. B. „Bäckerei Horsthemke GmbH & Co. KG“).
const LEGAL_LINE = /^\s*(?:firma\s+)?([A-ZÄÖÜ0-9][^\n|•:]{1,70}?\s(?:GmbH\s*&\s*Co\.?\s*KGaA|GmbH\s*&\s*Co\.?\s*KG|AG\s*&\s*Co\.?\s*KG|UG\s*\(haftungsbeschränkt\)(?:\s*&\s*Co\.?\s*KG)?|gGmbH|GmbH|AG|SE|KGaA|KG|OHG|GbR|e\.\s?Kfr\.|e\.\s?Kfm\.|e\.\s?K\.|eG))(?![A-Za-zäöüÄÖÜß])/m;
export function extractCompanyName(text) {
  const t = String(text || "").replace(/\u00a0/g, " ");
  const m = LEGAL_LINE.exec(t);
  if (!m) return "";
  const name = m[1].replace(/\s+/g, " ").replace(/^(angaben gemäß § 5 (tmg|ddg)|impressum|anbieter|betreiber|herausgeber|verantwortlich(?:er)?)[:\s]*/i, "").trim();
  // Kein Name, wenn die Zeile ein Satz ist (Verben, Kommas) oder offensichtlich nicht der Betreiber (Hosting, Agentur).
  if (name.length < 4 || name.length > 80 || /,|\b(ist|sind|wird|haftet|vertreten|durch|von|bei|für|mit)\b/i.test(name) || /hosting|agentur|webdesign|datenschutz/i.test(name)) return "";
  return name;
}

// ---------- Qualität der Website (10 = modern, 0 = kaputt) ----------
const BUILDERS = /jimdo|wixsite|wix\.com|parastorage|webnode|site123|weebly|homepage-baukasten|mywebsite-editor|websitebuilder|cm4all|jimstatic|ionos-website|strato-homepage/i;
const OLD_MARKUP = /<frameset|<font\b|<marquee|<center>|cellpadding=|\.swf\b|document\.write\(/i;
const FORM_RE = /<form[\s\S]{0,4000}?(<textarea|type=["']?email)/i;

export function websiteQuality(html, finalUrl = "", now = new Date()) {
  const h = String(html || "");
  const issues = [];
  let score = 10;
  if (/^http:\/\//i.test(finalUrl)) { score -= 2; issues.push("kein HTTPS"); }
  if (!/<meta[^<>]+name=["']viewport["']/i.test(h)) { score -= 3; issues.push("nicht für Handys gebaut"); }
  if (BUILDERS.test(h)) { score -= 1; issues.push("Baukasten"); }
  if (OLD_MARKUP.test(h)) { score -= 2; issues.push("veralteter Aufbau"); }
  if (/baustelle|under construction|coming soon|im aufbau|in kürze online|demnächst online/i.test(h)) { score -= 3; issues.push("Baustelle"); }
  const text = htmlToText(h);
  if (text.length < 600) { score -= 2; issues.push("sehr wenig Inhalt"); }
  const form = FORM_RE.test(h);
  if (!form) { score -= 1; issues.push("kein Kontaktformular"); }
  const years = [...h.matchAll(/(?:©|&copy;|copyright)[^0-9<]{0,40}((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi)].flatMap(m => [m[1], m[2]].filter(Boolean).map(Number));
  const year = years.length ? Math.max(...years) : null;
  const age = year ? now.getFullYear() - year : null;
  if (age !== null && age >= 6) { score -= 2; issues.push(`Stand ${year}`); }
  else if (age !== null && age >= 3) { score -= 1; issues.push(`Stand ${year}`); }
  const title = decodeEntities((/<title[^<>]*>([^<]*)<\/title>/i.exec(h) || [])[1] || "").trim();
  if (!title || /^(home|startseite|willkommen|index|untitled|neue seite|homepage)$/i.test(title)) { score -= 1; issues.push("nichtssagender Seitentitel"); }
  return { score: Math.max(0, Math.min(10, score)), issues, https: !/^http:\/\//i.test(finalUrl), form, year, title: title.slice(0, 120), text_length: text.length };
}

// ---------- Anfrage-Signale (laufen bei der Firma Anfragen ein?) ----------
const BOOKING = /calendly|cal\.com|terminbuchung|online-termin|termin online|online buchen|jetzt buchen|bookingkit|shore\.com|timify|treatwell|planity|etermin|hubspot\.com\/meetings|zeeg\.me|youcanbook|setmore|simplybook|termin vereinbaren/i;
const CTA = /jetzt anfragen|anfrage senden|angebot anfordern|unverbindlich(?:es)? angebot|kostenvoranschlag|rückruf|rueckruf|termin vereinbaren|beratung anfragen|kostenlose beratung|jetzt kontakt|anfrage stellen|projekt anfragen|unverbindlich anfragen|jetzt anfrage/gi;

export function inquirySignals(html, text) {
  const h = String(html || ""), t = String(text || "");
  const signals = [];
  const form = FORM_RE.test(h);
  const booking = BOOKING.test(h);
  if (form) signals.push("Kontaktformular");
  if (booking) signals.push("Online-Terminbuchung");
  if (/wa\.me\/|api\.whatsapp\.com|whatsapp/i.test(h)) signals.push("WhatsApp");
  const ctas = (t.match(CTA) || []).length;
  if (ctas >= 2) signals.push(`${ctas} Anfrage-Aufrufe`);
  if (/notdienst|24 ?h|24 stunden|rund um die uhr|schnell vor ort|soforthilfe/i.test(t)) signals.push("Notdienst/24h");
  if ((h.match(/<h[23][\s>]/gi) || []).length >= 6) signals.push("viele Leistungen");
  if (/standorte|filialen|niederlassung/i.test(t)) signals.push("mehrere Standorte");
  return { signals, form, booking, score: Math.min(10, signals.length * 2 + (booking ? 2 : 0)) };
}

// ---------- Mitarbeiterzahl ----------
const EMP = /(\d{1,4})\s*(?:\+|plus)?\s*(mitarbeiter(?:innen|:innen|\*innen)?|mitarbeitende|beschäftigte|angestellte|kolleg(?:en|innen|:innen)|fachkräfte|köpfiges team|mann starkes team|monteure|fahrer|fahrzeuge|lkw)\b/gi;

export function employeeEstimate(texts, pages = []) {
  const signals = [];
  let best = null;
  for (const t of texts) {
    for (const m of String(t || "").matchAll(EMP)) {
      const n = Number(m[1]);
      if (n < 2 || n > 5000) continue;
      const unit = m[2].toLowerCase();
      signals.push(`${n} ${m[2]}`);
      if (/fahrzeuge|fahrer|monteure|lkw/.test(unit)) continue; // Hinweis auf Größe, aber keine Mitarbeiterzahl
      if (best === null || n > best) best = n;
    }
  }
  const career = pages.find(p => p.kind === "career");
  let jobs = 0;
  if (career) {
    jobs = (String(career.text || "").match(/\(\s*m\s*\/\s*w\s*\/\s*d\s*\)|\(\s*w\s*\/\s*m\s*\/\s*d\s*\)|m\/w\/d|w\/m\/d/gi) || []).length;
    if (jobs) signals.push(`${jobs} offene Stellen`);
  }
  if (/standorte|niederlassungen/i.test(texts.join(" "))) signals.push("mehrere Standorte");
  return { estimate: best, jobs, signals: [...new Set(signals)].slice(0, 6) };
}

// ---------- Belegte Fakten für ein echtes Lob ----------
const FACT_RULES = [
  ["gruendung", /(?:seit|gegründet|gegruendet|gründung|gegr\.)\s*(?:im\s+jahre?\s*)?((?:18|19|20)\d{2})/i, m => `Betrieb seit ${m[1]}`],
  ["erfahrung", /(?:über|ueber|mehr als|seit)\s*(\d{2,3})\s*jahren?\s*(?:erfahrung|tradition|am markt|handwerk|familienbetrieb|in familienhand|erfolgreich)/i, m => `Über ${m[1]} Jahre Erfahrung`],
  ["familie", /familienbetrieb|familienunternehmen|familiengeführt|inhabergeführt|in (?:zweiter|dritter|vierter|fünfter|2\.|3\.|4\.|5\.) generation/i, m => `Familienbetrieb (${m[0]})`],
  ["meister", /meisterbetrieb|innungsbetrieb|innungsmitglied|mitglied (?:in|der) [^.\n]{0,40}innung|fachbetrieb/i, m => m[0]],
  ["ausbildung", /ausbildungsbetrieb|wir bilden aus|ausbildungsplätze?|azubis?\b/i, () => "Ausbildungsbetrieb"],
  ["zertifikat", /iso\s?9001(?::\s?\d{4})?|iso\s?14001|iso\s?45001|iso\s?50001|din\s?en\s?1090(?:-\d)?|din\s?en\s?iso\s?\d{4,5}|zertifiziert(?:er|es|e)? (?:fachbetrieb|nach|durch) [^.\n]{3,40}|ral[- ]gütezeichen|gütegemeinschaft [^.\n]{3,30}|tüv[- ]geprüft|dekra[- ]geprüft|vds[- ]anerkannt|energieeffizienz-experte/i, m => `Zertifiziert: ${m[0]}`],
  ["auszeichnung", /ausgezeichnet (?:als|mit) [^.\n]{3,60}|auszeichnung(?:en)? (?:als|für|zum|zur|des) [^.\n]{3,60}|preisträger (?:des|der|beim|im|bei) [^.\n]{3,60}|top[- ]?(?:company|arbeitgeber) [^.\n]{0,30}/i, m => m[0]],
  ["bewertung", /(\d[,.]\d)\s*(?:von 5|\/\s*5|sterne)[^.\n]{0,40}|(\d{2,5})\s*(?:google[- ])?(?:bewertungen|rezensionen)/i, m => `Bewertungen: ${m[0]}`],
  ["kunden", /(?:über|ueber|mehr als)\s*(\d[\d.]{1,6})\s*(?:zufriedene\s+)?(?:kunden|projekte|aufträge|auftraege|objekte|anlagen|installationen)/i, m => m[0]],
  ["team", /(\d{1,4})\s*(?:mitarbeiter(?:innen|:innen)?|mitarbeitende|beschäftigte)/i, m => `${m[1]} Mitarbeitende`],
  ["region", /(?:im|in der|aus dem|für den|für die)\s+(?:region|kreis|raum|großraum|grossraum)\s+([A-ZÄÖÜ][\wäöüß-]{2,30})/, m => `Verwurzelt in der Region ${m[1]}`]
];
const PAGE_ORDER = ["about", "home", "references", "services", "career", "contact", "impressum"];

export function extractFacts(pages) {
  const facts = [];
  const sorted = [...pages].sort((a, b) => PAGE_ORDER.indexOf(a.kind) - PAGE_ORDER.indexOf(b.kind));
  for (const [key, re, make] of FACT_RULES) {
    for (const p of sorted) {
      const text = String(p.text || "");
      const m = re.exec(text);
      if (!m) continue;
      const raw = make(m).replace(/\s+/g, " ").trim();
      const statement = raw.charAt(0).toUpperCase() + raw.slice(1);
      if (statement.length < 4) break;
      const start = Math.max(0, m.index - 40);
      const quote = text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, " ").trim();
      facts.push({ key, statement: statement.slice(0, 200), quote: quote.slice(0, 220), source_url: p.url, source_type: p.kind, type: "verified" });
      break;
    }
  }
  // Schwerpunkte aus den Überschriften der Leistungs-/Startseite (Schätzung, kein Zitat).
  const services = pages.find(p => p.kind === "services") || pages.find(p => p.kind === "home");
  if (services) {
    const heads = [...String(services.html || "").matchAll(/<h[23][^<>]*>([^<]{4,60})<\/h[23]>/gi)].map(m => decodeEntities(m[1]).replace(/\s+/g, " ").trim())
      .filter(t => t && !/kontakt|impressum|news|aktuelles|öffnungszeiten|anfahrt|cookie|datenschutz|newsletter|willkommen/i.test(t));
    const unique = [...new Set(heads)];
    if (unique.length >= 2) facts.push({ key: "schwerpunkte", statement: `Schwerpunkte: ${unique.slice(0, 4).join(", ")}`, quote: "", source_url: services.url, source_type: services.kind, type: "estimate" });
  }
  return facts.slice(0, 7);
}

// ---------- Impressum-Felder ----------
const CITY_STOP = /^(Fax|Tel|Telefon|Telefax|Mobil|Fon|Phone|Mail|E-Mail|Email|Web|Internet|Www|Postfach|Germany|Deutschland|Geschäftsführer|Geschäftsführung|Inhaber|Vertreten|Registergericht|Amtsgericht|Steuernummer|Ust|USt|Öffnungszeiten|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag|Kontakt|Impressum|Datenschutz)\.?$/i;

export function extractAddress(text) {
  const t = String(text || "").replace(/ /g, " ");
  const m = /([A-ZÄÖÜ][^\n,|;]{2,48}?\s\d{1,4}\s?[a-zA-Z]?(?:\s?[-–/]\s?\d{1,3})?)\s*[,\n|]?\s*(?:D[- ])?(\d{5})\s+([A-ZÄÖÜ][a-zäöüß]+(?:[ -](?:am|an|im|in|der|bei|a\.|i\.)?\s?[A-ZÄÖÜ][a-zäöüß.]+)*)/.exec(t);
  if (!m) return null;
  // Was nach der PLZ steht, ist nicht immer der Ort: „Fax“, „Tel“, „Deutschland“ oder der nächste Absatz.
  const city = m[3].trim().split(/\s+/).filter(w => !CITY_STOP.test(w)).join(" ").replace(/\s+(?:Deutschland|Germany)$/i, "").trim();
  if (!city || CITY_STOP.test(city)) return null;
  const street = m[1].trim();
  if (/^(tel|telefon|fax|mobil|fon|phone|e-?mail|web|www)\b/i.test(street)) return null;
  return { street, plz: m[2], city };
}

export function extractPhone(text) {
  const m = /(?:tel(?:efon)?|fon|phone|telefonnummer)\s*[.:]?\s*(\+?\(?\d[\d\s\/().-]{6,22}\d)/i.exec(String(text || ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

export function legalForm(text) {
  const m = /\b(GmbH\s*&\s*Co\.?\s*KGaA|GmbH\s*&\s*Co\.?\s*KG|AG\s*&\s*Co\.?\s*KG|UG\s*\(haftungsbeschränkt\)(?:\s*&\s*Co\.?\s*KG)?|gGmbH|GmbH|AG|SE|KGaA|KG|OHG|GbR|e\.\s?Kfr\.|e\.\s?Kfm\.|e\.\s?K\.|e\.\s?V\.|eG|Einzelunternehmen|Inh\.)(?![A-Za-zäöüÄÖÜß])/.exec(String(text || ""));
  return m ? m[1].replace(/\s+/g, " ") : "";
}
