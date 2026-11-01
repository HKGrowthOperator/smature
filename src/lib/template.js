// Vorlagen: Spintax {Hallo|Hi}, Variablen {{first_name}} mit Fallback {{first_name|Hallo}} und deutsche Anrede.
import { seededRandom } from "../crypto.js";
import { leadCase, CASES } from "./cases.js";
import { observation, observationShort, observationConcrete } from "./observations.js";

export const VARIABLES = [
  { key: "anrede", label: "Förmliche Anrede („Sehr geehrter Herr Müller“)" },
  { key: "hallo", label: "Lockere Anrede („Hallo Max“)" },
  { key: "first_name", label: "Vorname" },
  { key: "last_name", label: "Nachname" },
  { key: "full_name", label: "Vor- und Nachname" },
  { key: "herr_frau", label: "„Herr Müller“ / „Frau Müller“" },
  { key: "company", label: "Firma" },
  { key: "position", label: "Position" },
  { key: "website", label: "Website" },
  { key: "domain", label: "Domain der Firma" },
  { key: "city", label: "Stadt" },
  { key: "industry", label: "Branche" },
  { key: "sender_name", label: "Absendername" },
  { key: "sender_first_name", label: "Vorname Absender" },
  { key: "produkt", label: "Name des Produkts" },
  { key: "termin_link", label: "Termin-Link des Produkts" },
  { key: "kit_link", label: "Link zum Info-Kit des Produkts" },
  { key: "kit_name", label: "Bezeichnung des Info-Kits" },
  { key: "ai_first_line", label: "KI-Einstiegssatz (bei KI-Modus „Einstiegssatz“)" },
  { key: "beobachtung_konkret", label: "Nur belegte Beobachtung zur Website (aus der Leadquellen-Prüfung) – sonst leer; mit {{beobachtung_konkret|}} verwenden" },
  { key: "beobachtung", label: "Beobachtung zur Website des Leads (aus der Leadquellen-Prüfung: Handy, Footer-Jahr, Formular …), sonst ein Satz je Fall" },
  { key: "aufgefallen", label: "Kurzform der Beobachtung für den Betreff („Footer sagt 2019“), leer ohne konkreten Befund" },
  { key: "signal", label: "Beobachtung mit Anfrage-Signalen zuerst (Notdienst, Terminbuchung, offene Stellen) – für Automation" },
  { key: "fall", label: `Fall des Leads für {{#fall …}}-Absätze (${Object.keys(CASES).join(", ")})` },
  { key: "unsubscribe_url", label: "Abmelde-Link" },
  { key: "privacy_url", label: "Link zur Datenschutzerklärung (Einstellungen)" }
];

const ALIASES = {
  firstname: "first_name", vorname: "first_name", lastname: "last_name", nachname: "last_name",
  companyname: "company", firma: "company", unternehmen: "company", name: "full_name", fullname: "full_name",
  title: "position", jobtitle: "position", stadt: "city", ort: "city", branche: "industry",
  sendername: "sender_name", accountsignature: "signature", personalization: "ai_first_line",
  terminlink: "termin_link", bookinglink: "termin_link", calendarlink: "termin_link", product: "produkt", kitlink: "kit_link", infokit: "kit_link"
};

export function salutationGender(s) {
  const x = String(s || "").trim().toLowerCase().replace(/\./g, "");
  if (/^(herr|hr|mr|mister|sir|m)\b/.test(x)) return "m";
  if (/^(frau|fr|ms|mrs|miss|madam|f|w)\b/.test(x)) return "f";
  return "";
}

function titleFrom(s) {
  const m = /\b(prof\.?\s*dr\.?|dr\.?\s*med\.?|dr\.?|prof\.?)/i.exec(String(s || ""));
  return m ? m[1].replace(/\s+/g, " ").trim() + " " : "";
}

export function greeting(lead, language = "de", kind = "formal") {
  const g = salutationGender(lead.salutation);
  const title = titleFrom(lead.salutation);
  const last = String(lead.last_name || "").trim();
  const first = String(lead.first_name || "").trim();
  if (language === "en") {
    if (kind === "casual") return first ? `Hi ${first}` : "Hi";
    if (g && last) return `Dear ${g === "m" ? "Mr." : "Ms."} ${title}${last}`;
    return first ? `Dear ${first}` : "Hello";
  }
  if (kind === "casual") return first ? `Hallo ${first}` : "Hallo";
  if (g === "m" && last) return `Sehr geehrter Herr ${title}${last}`;
  if (g === "f" && last) return `Sehr geehrte Frau ${title}${last}`;
  if (first && last) return `Guten Tag ${first} ${last}`;
  return "Guten Tag";
}

function domainOf(lead) {
  const site = String(lead.website || "").trim();
  if (site) {
    try { return new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname.replace(/^www\./, ""); } catch { /* weiter */ }
  }
  return String(lead.email || "").split("@")[1] || "";
}

// Termin-Link: Produkt-Link, sonst allgemeiner Link; optional mit vorbelegter E-Mail-Adresse.
export function bookingLink(base, lead, prefill = false) {
  const url = String(base || "").trim();
  if (!url || !prefill || !lead?.email) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has("email")) u.searchParams.set("email", lead.email);
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
    if (name && !u.searchParams.has("name")) u.searchParams.set("name", name);
    return u.toString();
  } catch {
    return url;
  }
}

export function productVars(product, lead, settings = {}) {
  return {
    produkt: product?.name || "",
    termin_link: bookingLink(product?.booking_url || settings.booking_url, lead, !!settings.booking_prefill),
    kit_link: product?.kit_url || "",
    kit_name: product?.kit_label || (product?.kit_url ? "Info-Kit" : "")
  };
}

export function buildVars({ lead = {}, mailbox = {}, ai = {}, extra = {}, language = "de" } = {}) {
  const custom = typeof lead.custom === "string" ? safeParse(lead.custom) : (lead.custom || {});
  const g = salutationGender(lead.salutation);
  const vars = {
    email: lead.email, first_name: lead.first_name, last_name: lead.last_name,
    full_name: [lead.first_name, lead.last_name].filter(Boolean).join(" "),
    company: lead.company, position: lead.position, website: lead.website, domain: domainOf(lead),
    phone: lead.phone, city: lead.city, country: lead.country, industry: lead.industry, linkedin: lead.linkedin,
    salutation: lead.salutation,
    anrede: greeting(lead, language, "formal"),
    hallo: greeting(lead, language, "casual"),
    herr_frau: g && lead.last_name ? `${g === "m" ? (language === "en" ? "Mr." : "Herr") : (language === "en" ? "Ms." : "Frau")} ${lead.last_name}` : [lead.first_name, lead.last_name].filter(Boolean).join(" "),
    sender_name: mailbox.from_name, sender_first_name: String(mailbox.from_name || "").split(/\s+/)[0], sender_email: mailbox.email,
    ai_first_line: ai.first_line,
    fall: leadCase(lead),
    beobachtung: observation(lead),
    beobachtung_konkret: observationConcrete(lead),
    aufgefallen: observationShort(lead),
    signal: observation(lead, { prefer: "signals" }),
    signal_kurz: observationShort(lead, { prefer: "signals" })
  };
  for (const [k, value] of Object.entries(custom)) {
    vars[`custom.${k.toLowerCase()}`] = value;
    if (!(k.toLowerCase() in vars)) vars[k.toLowerCase()] = value;
  }
  for (const [k, value] of Object.entries(ai || {})) if (typeof value === "string") vars[`ai.${k}`] = value;
  Object.assign(vars, extra);
  return vars;
}

function safeParse(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }

// Spintax auflösen. {{Variablen}} werden vorher geschützt, damit ihre Klammern nicht als Spintax gelten.
export function spin(text, rnd = Math.random) {
  const protectedVars = [];
  let out = String(text || "").replace(/\{\{[^{}]*\}\}/g, m => `\u0000${protectedVars.push(m) - 1}\u0000`);
  const re = /\{([^{}]*\|[^{}]*)\}/;
  let guard = 0;
  while (re.test(out) && guard++ < 1000) {
    out = out.replace(re, (_, inner) => {
      const options = inner.split("|");
      return options[Math.floor(rnd() * options.length)] ?? "";
    });
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => protectedVars[Number(i)]);
}

const VAR_RE = /\{\{\s*([\p{L}0-9_.\-]+)\s*(?:\|([^{}]*))?\}\}/gu;

export function fillVars(text, vars) {
  const missing = new Set();
  const lookup = Object.fromEntries(Object.entries(vars).map(([k, val]) => [k.toLowerCase(), val]));
  const out = String(text || "").replace(VAR_RE, (_, rawName, fallback) => {
    let name = rawName.toLowerCase();
    if (ALIASES[name.replace(/[_\-]/g, "")] && !(name in lookup)) name = ALIASES[name.replace(/[_\-]/g, "")];
    const value = lookup[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
    if (fallback !== undefined) return fallback.trim();
    missing.add(name);
    return "";
  });
  return { text: out, missing: [...missing] };
}

// Fall-Absätze: {{#fall handwerk,bau}} … {{#fall gastro}} … {{#sonst}} … {{/fall}} – es bleibt der erste Zweig stehen, dessen
// Schlüssel zum Fall des Leads passt, sonst der {{#sonst}}-Zweig, sonst nichts. Leerzeilen um den Block werden sauber zusammengezogen.
const CASE_BLOCK_RE = /\{\{#fall\s+([^{}]*)\}\}([\s\S]*?)\{\{\/fall\}\}/g;
const BRANCH_RE = /\{\{#(fall\s+[^{}]*|sonst)\}\}/g;

function caseBranches(firstKeys, inner) {
  const branches = [];
  let keys = firstKeys, last = 0;
  for (const m of inner.matchAll(BRANCH_RE)) {
    branches.push({ keys, text: inner.slice(last, m.index) });
    keys = m[1] === "sonst" ? "sonst" : m[1].replace(/^fall\s+/, "");
    last = m.index + m[0].length;
  }
  branches.push({ keys, text: inner.slice(last) });
  return branches.map(b => ({ keys: b.keys.split(/[,\s]+/).map(k => k.trim().toLowerCase()).filter(Boolean), text: b.text.replace(/^\n+|\n+$/g, "") }));
}

export function resolveCases(text, caseKey = "sonst", pick = null) {
  const key = String(caseKey || "sonst").toLowerCase();
  const out = String(text || "").replace(CASE_BLOCK_RE, (_, firstKeys, inner) => {
    const branches = caseBranches(firstKeys, inner);
    if (pick === "longest") return branches.reduce((a, b) => (b.text.length > a.text.length ? b : a), branches[0]).text;
    const hit = branches.find(b => b.keys.includes(key)) || branches.find(b => b.keys.includes("sonst"));
    return hit ? hit.text : "";
  });
  // Ein leerer Zweig darf keine doppelten Leerzeilen hinterlassen.
  return out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

export const hasCases = text => /\{\{#fall\s/.test(String(text || ""));

export function render(template, vars, seed) {
  const rnd = seed === undefined ? Math.random : seededRandom(seed);
  return fillVars(spin(resolveCases(template, vars?.fall), rnd), vars);
}

export function usedVariables(text) {
  const names = new Set();
  for (const m of String(text || "").matchAll(VAR_RE)) names.add(m[1].toLowerCase());
  return [...names];
}

// Prüft Vorlagen auf offensichtliche Fehler (unausgeglichene Klammern).
export function lintTemplate(text) {
  const problems = [];
  const s = String(text || "");
  const opens = (s.match(/\{\{/g) || []).length, closes = (s.match(/\}\}/g) || []).length;
  if (opens !== closes) problems.push("Variablen-Klammern {{ }} sind nicht ausgeglichen.");
  const stripped = s.replace(/\{\{[^{}]*\}\}/g, "");
  let depth = 0;
  for (const ch of stripped) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) problems.push("Spintax-Klammern { } sind nicht ausgeglichen.");
  // Vollständige Blöcke entfernen – was dann noch von {{#fall}}, {{#sonst}} oder {{/fall}} übrig ist, ist unausgeglichen.
  const rest = s.replace(CASE_BLOCK_RE, "");
  if (/\{\{#fall\s|\{\{#sonst\}\}|\{\{\/fall\}\}/.test(rest)) problems.push("Fall-Blöcke {{#fall …}} … {{/fall}} sind nicht ausgeglichen (jeder Block beginnt mit {{#fall …}} und endet mit {{/fall}}).");
  for (const m of s.matchAll(/\{\{#fall\s+([^{}]*)\}\}/g)) {
    for (const k of m[1].split(/[,\s]+/).filter(Boolean)) if (!CASES[k.toLowerCase()]) problems.push(`Unbekannter Fall „${k}“ – möglich: ${Object.keys(CASES).join(", ")}.`);
  }
  return problems;
}
