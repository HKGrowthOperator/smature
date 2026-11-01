// Google Places API (New): Bewertungen einer Firma finden (Sterne + Anzahl).
// Schlüssel: GOOGLE_PLACES_API_KEY. Nach den Google-Maps-Bedingungen werden Bewertungen nicht dauerhaft gespeichert –
// gespeichert wird nur die Place ID und das Ergebnis der Prüfung (gut / vorhanden / keine).
import { config } from "../config.js";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELDS = "places.id,places.displayName,places.rating,places.userRatingCount,places.websiteUri,places.formattedAddress,places.businessStatus";

let fetcher = (url, opts) => fetch(url, opts);
export function setPlacesFetch(fn) { fetcher = fn || ((url, opts) => fetch(url, opts)); }

export const placesEnabled = () => !!config.googlePlacesKey;

const host = u => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const fold = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss").replace(/\b(gmbh|ug|kg|ohg|gbr|e\.?k\.?|inh\.?|co\.?|&|und|haftungsbeschrankt)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

// Sucht die Firma (Name + Ort) und wählt den Treffer mit derselben Website, sonst einen namensgleichen am Ort.
export async function findPlace({ name, city = "", plz = "", website = "" }) {
  if (!config.googlePlacesKey) return { checked: false };
  const textQuery = [name, plz, city].filter(Boolean).join(" ").slice(0, 200);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  let res;
  try {
    res = await fetcher(ENDPOINT, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": config.googlePlacesKey, "X-Goog-FieldMask": FIELDS },
      body: JSON.stringify({ textQuery, languageCode: "de", regionCode: "DE", pageSize: 5 })
    });
  } finally { clearTimeout(timer); }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = body; try { msg = JSON.parse(body).error?.message || body; } catch { /* Text */ }
    throw new Error(`Google Places ${res.status}: ${String(msg).slice(0, 200)}`);
  }
  const places = (await res.json()).places || [];
  const site = host(website);
  const n = fold(name);
  const byWebsite = site ? places.find(p => host(p.websiteUri || "") === site) : null;
  const byName = places.find(p => {
    const pn = fold(p.displayName?.text);
    const sameName = pn && n && (pn.includes(n) || n.includes(pn));
    const addr = String(p.formattedAddress || "");
    return sameName && (!city && !plz || (plz && addr.includes(plz)) || (city && addr.toLowerCase().includes(String(city).toLowerCase())));
  });
  const hit = byWebsite || byName;
  if (!hit) return { checked: true, found: false };
  return { checked: true, found: true, place_id: hit.id, rating: hit.rating ?? null, count: hit.userRatingCount ?? 0, matched_by: byWebsite ? "website" : "name", closed: hit.businessStatus === "CLOSED_PERMANENTLY" };
}

// Bewertung nach den Regeln aus den Einstellungen.
export function judgePlace(p, s) {
  if (!p?.checked) return { status: "nicht geprüft" };
  if (!p.found) return { status: "nicht gefunden" };
  if (p.closed) return { status: "geschlossen" };
  if (!p.count) return { status: "keine" };
  const good = p.count >= (s.google_good_count ?? 10) && (p.rating ?? 0) >= (s.google_good_rating ?? 4.5);
  return { status: good ? "gut" : "vorhanden", good };
}
