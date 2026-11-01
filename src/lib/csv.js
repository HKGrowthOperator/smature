// CSV lesen/schreiben (RFC 4180). Erkennt Trennzeichen , ; Tab (deutsches Excel nutzt ;).
export function detectDelimiter(text) {
  const firstLines = text.split(/\r?\n/).slice(0, 5).join("\n");
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLines) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return count > 0 ? best : ",";
}

export function parseCsv(input, delimiter) {
  const text = String(input || "").replace(/^﻿/, "");
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [], field = "", inQuotes = false, i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && field === "") { inQuotes = true; i++; continue; }
    if (ch === d) { row.push(field); field = ""; i++; continue; }
    if (ch === "\r") { i++; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ""));
  if (!nonEmpty.length) return { delimiter: d, headers: [], rows: [] };
  const headers = nonEmpty[0].map((h, idx) => h.trim() || `Spalte ${idx + 1}`);
  return { delimiter: d, headers, rows: nonEmpty.slice(1).map(r => headers.map((_, idx) => (r[idx] ?? "").trim())) };
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  // Formel-Injection in Excel verhindern.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[";\n\r,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers, rows, delimiter = ";") {
  return "﻿" + [headers, ...rows].map(r => r.map(csvCell).join(delimiter)).join("\r\n") + "\r\n";
}

export const LEAD_FIELDS = ["email", "salutation", "first_name", "last_name", "company", "position", "website", "phone", "city", "country", "industry", "linkedin", "source", "notes"];

const GUESS = {
  email: ["email", "e-mail", "e mail", "mail", "emailadresse", "e-mail-adresse", "email address", "e-mail adresse", "mailadresse"],
  salutation: ["anrede", "salutation", "gender", "geschlecht", "titel anrede"],
  first_name: ["vorname", "first name", "firstname", "first_name", "given name"],
  last_name: ["nachname", "last name", "lastname", "last_name", "surname", "familienname"],
  company: ["firma", "company", "unternehmen", "company name", "firmenname", "organisation", "organization", "account name"],
  position: ["position", "titel", "title", "job title", "jobtitel", "funktion", "rolle", "role"],
  website: ["website", "webseite", "url", "domain", "homepage", "web", "company website", "internetseite"],
  phone: ["telefon", "phone", "tel", "telefonnummer", "phone number", "mobile", "handy"],
  city: ["stadt", "ort", "city", "location", "standort"],
  country: ["land", "country"],
  industry: ["branche", "industry", "sector", "sektor"],
  linkedin: ["linkedin", "linkedin url", "linkedin profile", "person linkedin url"],
  source: ["quelle", "source", "herkunft"],
  notes: ["notiz", "notizen", "notes", "bemerkung", "kommentar"]
};

export function guessMapping(headers) {
  const mapping = {};
  const used = new Set();
  headers.forEach((h, idx) => {
    const n = h.trim().toLowerCase().replace(/[_]+/g, " ");
    for (const [field, names] of Object.entries(GUESS)) {
      if (used.has(field)) continue;
      if (names.includes(n) || names.includes(n.replace(/\s+/g, ""))) { mapping[idx] = field; used.add(field); return; }
    }
  });
  headers.forEach((h, idx) => {
    if (mapping[idx]) return;
    const n = h.trim().toLowerCase();
    if (!used.has("email") && n.includes("mail")) { mapping[idx] = "email"; used.add("email"); return; }
    mapping[idx] = `custom:${h.trim()}`;
  });
  return mapping;
}
