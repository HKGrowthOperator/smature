// Geschäftsführer aus dem Impressum: Name (und Anrede, wenn sie dort steht) übernehmen und die persönliche Adresse nur
// dann nutzen, wenn sie auf der Website veröffentlicht ist. Adressen werden nie geraten (vorname.nachname@ …) –
// geratene Adressen prallen ab und schaden dem Ruf der Versand-Domain.
import { q, update, parseJson } from "../db.js";
import { fetchPage, extractLinks } from "../lib/website.js";
import { htmlToText, decodeEntities } from "../lib/text.js";
import { normalizeEmail, syntaxValid, isRole, isFreemail, domainOf } from "../lib/verify.js";
import { ensureAccountForLead } from "./accounts.js";
import { getSettings } from "../settings.js";

let fetcher = fetchPage;
export function setImprintFetcher(fn) { fetcher = fn || fetchPage; }

const LABEL = /(gesch(?:ä|ae)ftsf(?:ü|ue)hr(?:erin|er|ung|ende gesellschafterin|ender gesellschafter|ende gesellschafter)|inhaberin|inhaber|vertreten durch(?: (?:den|die|deren|dessen) gesch(?:ä|ae)ftsf(?:ü|ue)hrer(?:in)?)?|vertretungsberechtigte[rn]? gesch(?:ä|ae)ftsf(?:ü|ue)hrer(?:in)?)\s*[:\-–]?\s*/gi;
const STOP = /\b(?:registergericht|amtsgericht|handelsregister|hrb|hra|sitz|telefon|tel|fax|e-?mail|mail|ust|umsatzsteuer\w*|steuernummer|verantwortlich\w*|anschrift|postfach|kontakt|haftung\w*|aufsicht\w*|prokur\w*)\b|www\.|https?:/i;
const TITLES = /\b(herrn?|frau|dr\.?(?:-ing\.?)?|prof\.?|dipl\.?\s*-?\s*(?:ing|kfm|kffr|betriebsw|wirt\.?-?ing)\.?(?:\s*\(fh\))?|ing\.|kfm\.|m\.\s?sc\.?|b\.\s?sc\.?|m\.\s?a\.|b\.\s?a\.|mba|ll\.\s?m\.?)(?=\s|$)/gi;
const NOT_NAME = /\b(gmbh|mbh|kg|ag|ug|ohg|gbr|e\.\s?k|e\.\s?v|co|holding|verwaltung\w*|gesellschaft\w*|beteiligung\w*|stra(?:ß|ss)e|str\.|weg|ring|platz|allee|deutschland|germany|impressum|gesch(?:ä|ae)ftsf\w*|inhaber\w*|vertreten|firma|team|unternehmen|und)\b/i;
const PARTICLE = /^(von|van|de|der|den|zu|zur|vom|ten|ter)$/i;
// Umlaute nach deutscher Konvention (ä → ae), andere Akzente abstreifen (André → andre), Rest nur a–z.
const fold = s => String(s || "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
const fold2 = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/[^a-z]/g, "");

function parseName(raw) {
  let salutation = "";
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (/^(herrn?)\b/i.test(s)) salutation = "Herr";
  else if (/^frau\b/i.test(s)) salutation = "Frau";
  const doctor = /\b(prof\.?\s*)?dr\.?/i.exec(s);
  const clean = s.replace(TITLES, " ").replace(/[()]/g, " ").replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
  if (!clean || clean.length > 60 || /\d|@/.test(clean) || NOT_NAME.test(clean)) return null;
  const parts = clean.split(" ");
  if (parts.length < 2 || parts.length > 4 || PARTICLE.test(parts[0])) return null;
  if (!parts.every(p => PARTICLE.test(p) || /^[A-ZÄÖÜ][a-zäöüßé]+(?:-[A-ZÄÖÜ][a-zäöüßé]+)?\.?$/.test(p) || /^[A-ZÄÖÜ]\.$/.test(p))) return null;
  let cut = parts.length - 1;
  while (cut > 1 && PARTICLE.test(parts[cut - 1])) cut--;
  const first = parts.slice(0, cut).join(" "), last = parts.slice(cut).join(" ");
  if (last.length < 2 || /\.$/.test(last)) return null;
  return { first_name: /^([A-ZÄÖÜ]\.\s?)+$/.test(first) ? "" : first, last_name: last, salutation, title: doctor ? (doctor[1] ? "Prof. Dr." : "Dr.") : "" };
}

// Namen der Geschäftsführung aus dem Impressum-Text. Reihenfolge wie auf der Seite, ohne Dubletten.
export function imprintPeople(text) {
  const src = String(text || "").slice(0, 60000);
  const out = [];
  for (const m of src.matchAll(LABEL)) {
    const female = /(erin|inhaberin)$/i.test(m[1].trim());
    let tail = src.slice(m.index + m[0].length, m.index + m[0].length + 180).split("\n")[0];
    const stop = STOP.exec(tail);
    if (stop) tail = tail.slice(0, stop.index);
    const pieces = tail.split(/,|;|\/|\s&\s|\sund\s|\ssowie\s/i);
    for (const piece of pieces) {
      const p = parseName(piece);
      if (!p) continue;
      if (!p.salutation && female && pieces.length === 1) p.salutation = "Frau";
      p.role = /inhaber/i.test(m[1]) ? "Inhaber" : "Geschäftsführung";
      if (!out.some(o => o.first_name === p.first_name && o.last_name === p.last_name)) out.push(p);
    }
    if (out.length >= 4) break;
  }
  return out;
}

// Veröffentlichte E-Mail-Adressen (auch „name (at) firma.de“).
export function imprintEmails(html) {
  const raw = String(html || "").slice(0, 400000);
  const text = decodeEntities(raw.replace(/<[^<>]*>/g, " "))
    .replace(/\s*[([{]\s*(?:at|ät)\s*[)\]}]\s*/gi, "@").replace(/\s*[([{]\s*(?:punkt|dot)\s*[)\]}]\s*/gi, ".");
  const found = new Set();
  for (const m of `${raw} ${text}`.matchAll(/[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,4}\.[a-z]{2,12}/gi)) {
    const e = normalizeEmail(m[0].replace(/^mailto:/i, ""));
    if (syntaxValid(e)) found.add(e);
  }
  return [...found];
}

// Persönliche Adresse genau dieser Person, nur auf der Firmen-Domain.
export function personalEmailFor(person, emails, domains) {
  const last = [fold(person.last_name.split(" ").pop()), fold2(person.last_name.split(" ").pop())].filter(x => x.length >= 3);
  if (!last.length) return null;
  return emails.find(e => domains.includes(domainOf(e)) && !isRole(e) && !isFreemail(e) && last.some(l => fold(e.split("@")[0]).includes(l))) || null;
}

// Adressmuster der Firma aus einer veröffentlichten persönlichen Adresse ableiten (z. B. „m.muster@“ → {fi}.{l}).
export function firmPattern(emails, domain) {
  for (const e of emails) {
    if (domainOf(e) !== domain || isRole(e) || isFreemail(e)) continue;
    const local = e.split("@")[0];
    if (/^[a-z]\.[a-z]{2,}$/.test(local)) return "{fi}.{l}";
    if (/^[a-z]{2,}\.[a-z]{2,}$/.test(local)) return "{f}.{l}";
    if (/^[a-z]{2,}_[a-z]{2,}$/.test(local)) return "{f}_{l}";
    if (/^[a-z]{2,}-[a-z]{2,}$/.test(local)) return "{f}-{l}";
    if (/^[a-z]{2,}$/.test(local)) return "{f}";
  }
  return "";
}

// Chef-Adresse aus dem Namen bilden (ohne Netzzugriff). Bestes Muster: das der Firma von ihrer Website,
// sonst „vorname@firma“ (häufigster Fall). Rückgabe: { email, pattern, guessed } oder null.
export function guessChiefEmail(person, domain, emails = []) {
  const first = fold(String(person.first_name || "").split(/[\s-]+/)[0]);
  const last = fold(String(person.last_name || "").split(/\s+/).pop());
  if ((!first && !last) || !domain) return null;
  const pat = firmPattern(emails, domain);
  const fill = p => p.replace("{fi}", first.slice(0, 1)).replace("{li}", last.slice(0, 1)).replace("{f}", first).replace("{l}", last);
  for (const p of [...new Set([pat, "{f}", "{f}.{l}", "{fi}.{l}", "{l}"].filter(Boolean))]) {
    if ((p.includes("{f") && !first) || (p.includes("{l") && !last)) continue;
    const local = fill(p);
    if (local.length >= 2) return { email: `${local}@${domain}`, pattern: p, guessed: !pat };
  }
  return null;
}

function startUrls(start) {
  let u;
  try { u = new URL(/^https?:\/\//i.test(start) ? start : `https://${start}`); } catch { return [start]; }
  const host = u.hostname.replace(/^www\./, "");
  return [...new Set([u.toString(), `https://www.${host}/`, `http://www.${host}/`])];
}

const IMPRINT_LINK = /impressum|imprint|legal-notice|rechtliche-hinweise|anbieterkennzeichnung/i;
// Seiten, auf denen Firmen persönliche Adressen zeigen – daraus lernen wir das Adressmuster.
const CONTACT_LINK = /kontakt|contact|team|ansprechpartner|ueber-uns|uber-uns|über-uns|unternehmen|mitarbeiter|geschaeftsf/i;

export async function findImprintContact({ website, email }) {
  const start = website || (email ? `https://${domainOf(email)}` : "");
  if (!start) return { error: "Keine Website" };
  // Viele Firmen-Domains antworten nur mit „www.“ oder nur über http.
  let home = null;
  for (const url of startUrls(start)) {
    home = await fetcher(url);
    if (home) break;
  }
  if (!home) return { error: "Website nicht erreichbar" };
  const links = extractLinks(home.html, home.url);
  const link = links.find(l => IMPRINT_LINK.test(l.text) || IMPRINT_LINK.test(l.url));
  let page = link ? await fetcher(link.url) : null;
  if (!page) {
    for (const path of ["/impressum", "/impressum/", "/impressum.html"]) {
      try { page = await fetcher(new URL(path, home.url).toString()); } catch { page = null; }
      if (page) break;
    }
  }
  if (!page && /impressum/i.test(home.html || "")) page = home;
  if (!page) return { error: "Kein Impressum gefunden" };
  const host = (() => { try { return new URL(home.url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } })();
  const domains = [...new Set([host, domainOf(email || "")].filter(Boolean))];
  const people = imprintPeople(htmlToText(page.html));
  const person = people[0] || null;
  const found = new Set([...imprintEmails(page.html), ...imprintEmails(home.html)]);
  // Kontakt-/Team-Seiten mitlesen: dort steht oft eine persönliche Adresse, aus der sich das Firmen-Muster ableitet.
  const contactLinks = links.filter(l => l.url !== page.url && CONTACT_LINK.test(`${l.text} ${l.url}`)).slice(0, 3);
  for (const l of contactLinks) {
    if (person && personalEmailFor(person, [...found], domains)) break;
    const extra = await fetcher(l.url).catch(() => null);
    if (extra) for (const e of imprintEmails(extra.html)) found.add(e);
  }
  const emails = [...found].filter(e => domains.includes(domainOf(e)));
  const published = person ? personalEmailFor(person, emails, domains) : null;
  const guess = getSettings().guess_chief_emails && !published && person ? guessChiefEmail(person, domains[0], emails) : null;
  return { url: page.url, people, person, email: published, guess, emails };
}

const sameName = (lead, p) => fold(lead.last_name) === fold(p.last_name) && (!lead.first_name || !p.first_name || fold(lead.first_name) === fold(p.first_name));

// Ergebnis auf den Lead anwenden. Bestehende, andere Ansprechpartner werden nicht überschrieben.
export function applyImprintContact(lead, found, now = Date.now()) {
  const custom = parseJson(lead.custom, {}) || {};
  custom.impressum_geprueft = new Date(now).toISOString().slice(0, 10);
  if (found.error) custom.impressum_fehler = found.error; else delete custom.impressum_fehler;
  const row = {};
  const result = { named: false, email_switched: false, email_source: null, note: found.error || "" };
  const p = found.person;
  if (p && (!lead.last_name || sameName(lead, p))) {
    if (!lead.last_name) {
      Object.assign(row, { first_name: p.first_name, last_name: p.last_name });
      result.named = true;
    }
    if (!lead.position) row.position = p.role;
    if (!lead.salutation && p.salutation) row.salutation = `${p.salutation}${p.title ? ` ${p.title}` : ""}`;
    custom.impressum_quelle = found.url;
    // Chef-Adresse: zuerst die veröffentlichte, sonst die aus dem Namen gebildete (geraten → „risky“, Bounce wird erkannt).
    const chief = found.email ? { email: found.email, verify: "valid", source: "published", reason: "Auf der Website veröffentlicht" }
      : found.guess ? { email: found.guess.email, verify: "risky", source: found.guess.guessed ? "guess" : "pattern", reason: found.guess.guessed ? "Aus dem Namen gebildet (Standardmuster), ungeprüft" : "Aus dem Namen und dem Adressmuster der Firma gebildet" }
      : null;
    if (chief && chief.email !== lead.email && isRole(lead.email) && !q.get("SELECT 1 FROM leads WHERE email = ?", chief.email)) {
      custom.zentrale_email = lead.email;
      custom.chef_email_quelle = chief.reason;
      Object.assign(row, { email: chief.email, verify_status: chief.verify, verify_reason: chief.reason });
      result.email_switched = true;
      result.email_source = chief.source;
    }
  } else if (p) result.note = `Impressum nennt ${[p.first_name, p.last_name].filter(Boolean).join(" ")}, am Lead steht ein anderer Kontakt`;
  else if (!found.error) result.note = "Kein Name im Impressum erkannt";
  update("leads", lead.id, { ...row, custom: JSON.stringify(custom), updated_at: now });
  if (result.named || result.email_switched) ensureAccountForLead(q.get("SELECT * FROM leads WHERE id = ?", lead.id));
  return result;
}

// Mehrere Leads prüfen (begrenzte Parallelität). Bereits geprüfte überspringen, außer force.
export async function imprintContacts(ids, { concurrency = 5, force = false, now = Date.now() } = {}) {
  const leads = ids.map(id => q.get("SELECT * FROM leads WHERE id = ?", id)).filter(Boolean)
    .filter(l => force || !(parseJson(l.custom, {}) || {}).impressum_geprueft);
  const summary = { checked: 0, skipped: ids.length - leads.length, named: 0, email_switched: 0, email_published: 0, email_guessed: 0, not_found: 0, items: [] };
  let i = 0;
  async function worker() {
    while (i < leads.length) {
      const lead = leads[i++];
      const found = await findImprintContact(lead).catch(err => ({ error: err.message }));
      const fresh = q.get("SELECT * FROM leads WHERE id = ?", lead.id);
      if (!fresh) continue;
      const r = applyImprintContact(fresh, found, now);
      summary.checked++;
      if (r.named) summary.named++;
      if (r.email_switched) { summary.email_switched++; if (r.email_source === "published") summary.email_published++; else summary.email_guessed++; }
      if (!found.person) summary.not_found++;
      summary.items.push({ id: lead.id, company: lead.company, ...r, person: found.person ? [found.person.first_name, found.person.last_name].filter(Boolean).join(" ") : null });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, leads.length) }, worker));
  return summary;
}
