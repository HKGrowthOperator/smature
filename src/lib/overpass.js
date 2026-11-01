// OpenStreetMap-Abfragen über die Overpass API: Firmen mit Website oder E-Mail in einer Verwaltungsregion nach Kategorien.
// Fair-Use: eine Abfrage zur Zeit, eigener User-Agent, Ersatz-Server bei Ausfall. Daten © OpenStreetMap-Mitwirkende (ODbL).
const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const UA = "SmatureColdmail/1.0 (Leadquellen; +https://coldmail.example.de)";
// Ein Filter für alle Kontaktwege (Schlüssel-Regex) – eine Teilabfrage je Kategorie statt vier.
const CONTACT_FILTER = '[~"^(website|contact:website|email|contact:email)$"~"."]';
const CATEGORY_KEYS = ["craft", "office", "industrial", "man_made", "shop", "amenity", "leisure", "club", "tourism", "healthcare"];

let fetchImpl = null;
export function setOverpassFetch(fn) { fetchImpl = fn; }

const quote = s => String(s).replace(/["\\]/g, "\\$&");

// Tag-Filter je Kategorie → Teilabfragen. Nur Objekte mit Website oder E-Mail – ohne Kontaktweg entsteht kein Lead.
// Klein halten: eine Abfrage je Region und Kategorie, sonst läuft der Server in den Timeout.
export function buildQuery(region, filters, { limit = 3000, timeout = 90 } = {}) {
  const parts = filters.map(f => `  nwr(area.a)${f}${CONTACT_FILTER};`);
  return `[out:json][timeout:${timeout}];\narea["boundary"="administrative"]["name"="${quote(region)}"]->.a;\n(\n${parts.join("\n")}\n);\nout center tags ${limit};`;
}

export async function runOverpass(query, { timeoutMs = 110000 } = {}) {
  const errors = [];
  for (const url of ENDPOINTS) {
    const host = new URL(url).hostname;
    try {
      const f = fetchImpl || fetch;
      const res = await f(url, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA, Accept: "application/json" },
        body: `data=${encodeURIComponent(query)}`, signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) {
        // Fehlertext des Servers mitnehmen (z. B. „Query timed out“), dann den nächsten Server probieren.
        const text = (await res.text().catch(() => "")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
        errors.push(`${host}: HTTP ${res.status}${text ? ` – ${text}` : ""}`);
        continue;
      }
      const json = await res.json();
      const elements = Array.isArray(json.elements) ? json.elements : [];
      // Eine „remark“ (Timeout, Speicher, „too busy“) mit leerem oder unvollständigem Ergebnis ist kein echtes „keine Treffer“ – später erneut.
      if (json.remark && (!elements.length || /error|timed out|too busy|out of memory/i.test(json.remark))) { errors.push(`${host}: ${String(json.remark).slice(0, 200)}`); continue; }
      return elements;
    } catch (err) {
      errors.push(`${host}: ${err.message}`);
    }
  }
  throw new Error(`OpenStreetMap-Abfrage fehlgeschlagen – ${errors.join(" | ")}`);
}

const tag = (t, ...keys) => { for (const k of keys) if (t[k]) return String(t[k]).trim(); return ""; };

// OSM-Objekte → Kandidaten (Name, Website, E-Mail, Telefon, Adresse, Kategorie „schlüssel=wert“).
export function toCandidates(elements) {
  const out = [];
  for (const el of elements || []) {
    const t = el.tags || {};
    const name = tag(t, "name", "official_name", "brand", "operator");
    if (!name) continue;
    const website = tag(t, "website", "contact:website", "url").split(/[;\s]/)[0];
    const email = tag(t, "email", "contact:email").split(/[;\s,]/)[0].toLowerCase();
    const catKey = CATEGORY_KEYS.find(k => t[k]);
    out.push({
      osm_id: `${el.type}/${el.id}`, name: name.replace(/\s+/g, " "), website, email,
      phone: tag(t, "phone", "contact:phone", "contact:mobile").split(";")[0].trim(),
      city: tag(t, "addr:city"), plz: tag(t, "addr:postcode"), street: [tag(t, "addr:street"), tag(t, "addr:housenumber")].filter(Boolean).join(" "),
      category: catKey ? `${catKey}=${String(t[catKey]).split(";")[0]}` : "",
      lat: el.lat ?? el.center?.lat ?? null, lon: el.lon ?? el.center?.lon ?? null
    });
  }
  return out;
}
