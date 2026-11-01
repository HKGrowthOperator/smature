// Leadquellen: Firmen aus OpenStreetMap (Overpass) nach Region und Kategorie holen, Website und Impressum prüfen,
// je Projekt-Profil qualifizieren und passende Firmen als Leads in den Pool des Projekts legen („Pool · Projekt“).
// Läuft als Hintergrund-Worker mit Tageslimit: je Takt eine OpenStreetMap-Abfrage und ein kleines Paket Websites.
// Regeln: nur öffentliche Firmen-Websites (max. 5 Seiten), keine fremden Verzeichnisse, keine SMTP-Abfragen bei fremden
// Servern, Rechts-Ausschluss und Sperrliste wie bei jedem Lead, Freemail-Adressen nur, wenn die Kontaktregeln es erlauben.
import { q, tx, insert, update, parseJson } from "../db.js";
import { getSettings } from "../settings.js";
import { findPlace, judgePlace, placesEnabled } from "../lib/places.js";
import { buildQuery, runOverpass, toCandidates } from "../lib/overpass.js";
import { normalizeEmail, syntaxValid, verifyEmail, isFreemail, isRole } from "../lib/verify.js";
import { inspectSite } from "./sitecheck.js";
import { personalEmailFor, guessChiefEmail } from "./imprint.js";
import { normalizeDomain, ensureAccountForLead, findAccountByDomain } from "./accounts.js";
import { legalRiskHit } from "../engine/rules.js";
import { recordEvent } from "../events.js";
import { DAY_MS } from "../lib/time.js";
import { listProjects } from "./projects.js";
import { leadCase } from "../lib/cases.js";

// Kategorien = OpenStreetMap-Tag-Filter (Overpass-Syntax). Ein Eintrag kann mehrere Filter bündeln.
export const CATEGORIES = {
  craft_all: { label: "Handwerk (alle Gewerke)", filters: ['["craft"]'] },
  craft_bau: { label: "Bau- und Ausbaugewerke", filters: ['["craft"~"^(roofer|carpenter|joiner|scaffolder|painter|plasterer|tiler|floorer|insulation|stonemason|builder|window_construction|glaziery|parquet_layer|dry_wall|rigger|gardener|landscaper)$"]'] },
  craft_technik: { label: "Elektro, SHK, Metall, Maschinen", filters: ['["craft"~"^(electrician|plumber|hvac|metal_construction|locksmith|blacksmith|welder|machinist|electronics_repair|sawmill|cabinet_maker|agricultural_engines|boatbuilder)$"]'] },
  industrial: { label: "Industrie und Produktion", filters: ['["industrial"]', '["man_made"="works"]'] },
  office_company: { label: "Firmensitze (office=company)", filters: ['["office"="company"]'] },
  office_agency: { label: "Agenturen, Beratung, IT, Dienstleister", filters: ['["office"~"^(advertising_agency|consulting|it|marketing|coworking|telecommunication|web_design|graphic_design|employment_agency|financial_advisor|estate_agent|insurance|architect|engineer|surveyor|association|security|logistics|energy_supplier|property_management)$"]'] },
  shop_auto: { label: "Kfz, Reifen, Werkstätten", filters: ['["shop"~"^(car_repair|car|tyres|car_parts|motorcycle|caravan|truck|trailer|boat)$"]'] },
  shop_local: { label: "Fachhandel und Läden", filters: ['["shop"~"^(bakery|butcher|florist|furniture|kitchen|bed|bicycle|hairdresser|beauty|optician|jewelry|clothes|shoes|sports|garden_centre|doityourself|hardware|interior_decoration|curtain|paint|electronics|appliance|trade|pet|wine|deli|bathroom_furnishing|tiles|windows|doors|fireplace|lighting|frame|printing|copyshop|tailor|dry_cleaning|laundry|locksmith)$"]'] },
  gastro: { label: "Gastronomie und Hotels", filters: ['["amenity"~"^(restaurant|cafe|bar|pub|biergarten|ice_cream|fast_food)$"]', '["tourism"~"^(hotel|guest_house|apartment|chalet|camp_site)$"]'] },
  leisure: { label: "Fitness, Sport, Vereine, Schulen", filters: ['["leisure"~"^(fitness_centre|sports_centre|dance|bowling_alley|horse_riding|swimming_pool|golf_course)$"]', '["club"]', '["amenity"~"^(driving_school|dancing_school|music_school|language_school|veterinary|dentist|car_wash|car_rental|events_venue)$"]'] },
  logistics: { label: "Logistik, Spedition, Entsorgung", filters: ['["office"="logistics"]', '["amenity"~"^(waste_transfer_station|recycling)$"]', '["industrial"~"^(warehouse|logistics|depot|scrap_yard)$"]'] }
};

// Profile = ein Pool je Projekt: welche Kategorien gesucht und wie die Firmen bewertet werden.
export const PROFILES = {
  website: { label: "Webseite", description: "Betriebe mit schwacher oder alter Website: Handwerk, Werkstätten, Fachhandel, Gastronomie, Vereine, Dienstleister. Je schwächer die Website, desto besser passt das Angebot.", categories: ["craft_all", "shop_auto", "shop_local", "gastro", "leisure", "office_agency", "office_company", "logistics"] },
  automation: { label: "Webseite / Automation", description: "Betriebe, bei denen Anfragen laufen (Formular, Terminbuchung, Notdienst, viele Leistungen), aber kein Prozess dahinter steht.", categories: ["craft_all", "shop_auto", "shop_local", "gastro", "leisure", "office_agency", "office_company", "logistics"] },
  dealuno: { label: "Sales-Software (B2B)", description: "Agenturen, Berater, Coaches und Dienstleister, die B2B-Kunden gewinnen – kein Handwerk, keine reinen Endkunden-Läden.", categories: ["office_agency", "office_company"] },
  growth_os: { label: "Software Mittelstand", description: "Industrie- und Handwerks-Mittelstand ab etwa 20 Mitarbeitenden mit Auftragsgeschäft: Bau, Technik, Metall, Produktion, Logistik.", categories: ["craft_bau", "craft_technik", "industrial", "office_company", "shop_auto", "logistics"] }
};

const CATEGORY_LABELS = {
  "craft=electrician": "Elektrotechnik", "craft=plumber": "Sanitär/Heizung", "craft=hvac": "Heizung/Klima/Lüftung", "craft=carpenter": "Zimmerei", "craft=joiner": "Tischlerei",
  "craft=roofer": "Dachdeckerei", "craft=painter": "Malerbetrieb", "craft=metal_construction": "Metallbau", "craft=scaffolder": "Gerüstbau", "craft=tiler": "Fliesenleger",
  "craft=window_construction": "Fensterbau", "craft=gardener": "Garten- und Landschaftsbau", "craft=landscaper": "Garten- und Landschaftsbau", "craft=plasterer": "Stuckateur/Putz",
  "craft=floorer": "Bodenleger", "craft=insulation": "Dämmung", "craft=stonemason": "Steinmetz", "craft=builder": "Bauunternehmen", "craft=glaziery": "Glaserei", "craft=locksmith": "Schlosserei",
  "craft=blacksmith": "Schmiede", "craft=welder": "Schweißbetrieb", "craft=machinist": "Zerspanung", "craft=cabinet_maker": "Möbeltischlerei", "craft=sawmill": "Sägewerk", "craft=photographer": "Fotograf",
  "craft=printer": "Druckerei", "craft=upholsterer": "Polsterei", "craft=caterer": "Catering", "craft=cleaning": "Gebäudereinigung", "craft=electronics_repair": "Elektronik-Service",
  "office=company": "Unternehmen", "office=advertising_agency": "Werbeagentur", "office=consulting": "Unternehmensberatung", "office=it": "IT-Dienstleister", "office=marketing": "Marketing",
  "office=coworking": "Coworking", "office=telecommunication": "Telekommunikation", "office=web_design": "Webdesign", "office=graphic_design": "Grafikdesign", "office=employment_agency": "Personaldienstleister",
  "office=financial_advisor": "Finanzberatung", "office=estate_agent": "Immobilien", "office=insurance": "Versicherung", "office=architect": "Architekturbüro", "office=engineer": "Ingenieurbüro",
  "office=surveyor": "Vermessung", "office=association": "Verband/Verein", "office=security": "Sicherheitsdienst", "office=logistics": "Logistik", "office=energy_supplier": "Energieversorger", "office=property_management": "Hausverwaltung",
  "shop=car_repair": "Kfz-Werkstatt", "shop=car": "Autohaus", "shop=tyres": "Reifenservice", "shop=car_parts": "Kfz-Teile", "shop=motorcycle": "Motorrad", "shop=caravan": "Caravan", "shop=truck": "Nutzfahrzeuge", "shop=trailer": "Anhänger",
  "shop=bakery": "Bäckerei", "shop=butcher": "Metzgerei", "shop=florist": "Blumen", "shop=furniture": "Möbel", "shop=kitchen": "Küchenstudio", "shop=bed": "Betten", "shop=bicycle": "Fahrrad", "shop=hairdresser": "Friseur",
  "shop=beauty": "Kosmetik", "shop=optician": "Optiker", "shop=jewelry": "Juwelier", "shop=clothes": "Mode", "shop=shoes": "Schuhe", "shop=sports": "Sport", "shop=garden_centre": "Gartencenter", "shop=doityourself": "Baumarkt",
  "shop=hardware": "Eisenwaren", "shop=interior_decoration": "Raumausstattung", "shop=paint": "Farben", "shop=electronics": "Elektronik", "shop=appliance": "Haushaltsgeräte", "shop=trade": "Fachhandel", "shop=printing": "Druck",
  "amenity=restaurant": "Restaurant", "amenity=cafe": "Café", "amenity=bar": "Bar", "amenity=pub": "Gaststätte", "amenity=biergarten": "Biergarten", "amenity=fast_food": "Imbiss", "amenity=driving_school": "Fahrschule",
  "amenity=dentist": "Zahnarztpraxis", "amenity=veterinary": "Tierarztpraxis", "amenity=car_wash": "Autowäsche", "amenity=car_rental": "Autovermietung", "amenity=events_venue": "Veranstaltungsort", "amenity=recycling": "Recycling",
  "tourism=hotel": "Hotel", "tourism=guest_house": "Pension", "leisure=fitness_centre": "Fitnessstudio", "leisure=sports_centre": "Sportzentrum", "leisure=dance": "Tanzschule", "man_made=works": "Produktionsbetrieb",
  "leisure=bowling_alley": "Bowlingcenter", "leisure=horse_riding": "Reiterhof", "leisure=swimming_pool": "Schwimmbad", "leisure=golf_course": "Golfplatz", "amenity=dancing_school": "Tanzschule",
  "amenity=music_school": "Musikschule", "amenity=language_school": "Sprachschule", "amenity=ice_cream": "Eisdiele", "tourism=apartment": "Ferienwohnung", "tourism=chalet": "Ferienhaus", "tourism=camp_site": "Campingplatz",
  "shop=pet": "Tierbedarf", "shop=wine": "Weinhandel", "shop=deli": "Feinkost", "shop=bathroom_furnishing": "Badausstattung", "shop=tiles": "Fliesenhandel", "shop=windows": "Fensterhandel", "shop=doors": "Türenhandel",
  "shop=fireplace": "Kaminstudio", "shop=lighting": "Leuchten", "shop=frame": "Bilderrahmen", "shop=copyshop": "Copyshop", "shop=tailor": "Schneiderei", "shop=dry_cleaning": "Textilreinigung", "shop=laundry": "Wäscherei",
  "shop=locksmith": "Schlüsseldienst", "shop=curtain": "Gardinen", "industrial=warehouse": "Lager", "industrial=logistics": "Logistik", "industrial=depot": "Depot", "industrial=scrap_yard": "Schrottplatz",
  "amenity=waste_transfer_station": "Entsorgung", "office=lawyer": "Kanzlei", "club=sport": "Sportverein"
};
export function categoryLabel(category) {
  if (!category) return "";
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  const [key, value] = String(category).split("=");
  if (key === "industrial") return `Industrie (${value})`;
  if (key === "club") return `Verein (${value})`;
  return value ? value.replace(/_/g, " ") : key;
}

// Reihenfolge bei gleicher Passung: Software-Produkte (höherer Auftragswert) vor Website.
const PROFILE_PRIORITY = ["growth_os", "dealuno", "automation", "website"];
const FIT_SCORE = { A: 3, B: 2, C: 1 };
const PROFILE_BONUS = { growth_os: 1, dealuno: 1, automation: 0, website: 0 };

export const sourcingState = { lastTickAt: null, lastError: null, running: false, lastSummary: null };
let verifier = verifyEmail;
let placeFinder = findPlace;
export function setPlaceFinder(fn) { placeFinder = fn || findPlace; }
export function setSourcingVerifier(fn) { verifier = fn || verifyEmail; }

// Profil aus dem Projektnamen raten (für die Vorbelegung in der Oberfläche).
export function profileFor(project) {
  const n = String(project?.name || "").toLowerCase();
  if (/automation|system/.test(n)) return "automation";
  if (/dealuno|sales.?app|crm/.test(n)) return "dealuno";
  if (/mittelstand|growth os|prozess/.test(n)) return "growth_os";
  return "website";
}

// Pool-Liste je Projekt (wird beim ersten Lauf angelegt) – Zielgruppe: die des Projekts, sonst eine geteilte.
export function poolList(projectId, { create = true } = {}) {
  const project = q.get("SELECT * FROM projects WHERE id = ?", projectId);
  if (!project) return null;
  const name = `Pool · ${project.name}`;
  const existing = q.get("SELECT * FROM lead_lists WHERE name = ?", name);
  if (existing || !create) return existing;
  const tg = q.get(`SELECT id FROM target_groups WHERE project_id = ? OR EXISTS (SELECT 1 FROM json_each(also_project_ids) WHERE value = ?)
    ORDER BY project_id = ? DESC, id LIMIT 1`, projectId, projectId, projectId);
  const id = insert("lead_lists", { name, target_group_id: tg?.id || null, project_id: projectId, created_at: Date.now() });
  return q.get("SELECT * FROM lead_lists WHERE id = ?", id);
}

export function createRun({ project_id, profile, regions, categories, max_candidates = 300, user_id = null }) {
  const now = Date.now();
  const list = poolList(project_id);
  const id = insert("sourcing_runs", {
    project_id, list_id: list?.id || null, profile, source: "osm", regions: JSON.stringify(regions), categories: JSON.stringify(categories),
    status: "queued", max_candidates, created_by: user_id, created_at: now, updated_at: now
  });
  return q.get("SELECT * FROM sourcing_runs WHERE id = ?", id);
}

export function dailyUsed(now = Date.now()) {
  return q.value("SELECT COUNT(*) FROM sourcing_candidates WHERE checked_at >= ? AND status IN ('imported','rejected','error')", now - DAY_MS) || 0;
}

// ---------- Qualifizierung je Profil (regelbasiert, ohne KI) ----------
const B2B_WORDS = /agentur|beratung|consult|coach|marketing|vertrieb|sales|software|saas|digital|media|medien|recruit|personal|dienstleist|studio|werbung|design|seo|strateg|kommunikation|public relations|\bpr\b/;
const B2C_ONLY = /friseur|restaurant|café|cafe|pizzeria|imbiss|nagelstudio|kosmetik|tattoo|fitness|bäckerei|metzgerei|blumen|apotheke|praxis|zahnarzt|tierarzt|hotel|pension/;
const HANDWERK = /handwerk|meisterbetrieb|dachdeck|sanitär|sanitaer|heizung|elektro|maler|tischler|schreiner|metallbau|zimmerei|gerüstbau|geruestbau|fliesen|garten|bauunternehm|hochbau|tiefbau|installateur|schlosser|kfz|werkstatt|lackier/;
const INDUSTRY = /fertigung|produktion|montage|metall|maschinen|anlagen|industrie|\bbau\b|elektro|shk|sanitär|heizung|logistik|spedition|entsorgung|recycling|service|werkstatt|handwerk|zerspanung|blech|stahl|kunststoff|verpackung|lackier|galvan|schweiß|automatisierung|gebäudetechnik|klima|lüftung|tga|tiefbau|hochbau|dachdeck|gerüst/;
const NONPROFIT = /\be\.\s?v\.|\bverein\b|verband|stiftung|gemeinnützig|ggmbh|\bdrk\b|rotes kreuz|caritas|diakonie|\bawo\b|malteser|johanniter|kirche|kirchengemeinde|universit|hochschule|klinik|krankenhaus|feuerwehr|polizei|landkreis|\bstadt (?!werke)|rathaus|ministerium|behörde|\bamt\b|jobcenter|bundes|landes(?!bau)/i;
const AGENCY = /agentur|agency|consult|beratung|berater|coach|marketing|\bmedia\b|medien|digital|software|systemhaus|\bedv\b|\bit\b|it-|design|studio|recruit|personal|dienstleist|werbung|kommunikation|\bpr\b|seo|online|web|cloud|daten|data|automation|vertrieb|sales/i;
// Fälle, die nie in den Sales-Software- bzw. Mittelstand-Pool gehören (die Vorlagen hätten dort keinen passenden Absatz).
const DEALUNO_NOT = new Set(["bau", "technik", "metall", "industrie", "logistik", "handwerk", "werkstatt", "laden", "gastro", "freizeit", "praxis"]);
const GROWTH_NOT = new Set(["agentur", "it", "personal", "beratung", "immobilien", "laden", "gastro", "freizeit", "praxis"]);
const SALES_SIGNALS = [/\bb2b\b/, /geschäftskunden|firmenkunden|unternehmen als kunden|für unternehmen|für den mittelstand/, /neukunden|kundengewinnung|leadgenerierung|akquise/, /vertriebsteam|sales team|\bsdr\b|account manager|vertriebsmitarbeiter|business development/, /\bcrm\b|hubspot|pipedrive|salesforce/, /mittelstand|\bkmu\b/];

export function qualify(profile, cand, site) {
  const text = String(site.text || "");
  const name = String(cand.name || "").toLowerCase();
  const emp = site.employees?.estimate ?? null;
  const quality = site.quality || { score: 5, issues: [] };
  const issues = quality.issues.join(", ");
  if (profile === "website") {
    const g = site.google?.good ? ", gute Google-Bewertungen" : "";
    if (quality.score <= 4) return { fit: "A", reason: `Website schwach (${quality.score}/10: ${issues})${g}` };
    // Gute Google-Bewertungen bei mittelmäßiger Website: Ruf ist da, der Webauftritt hält nicht mit → A.
    if (quality.score <= 7) return { fit: g ? "A" : "B", reason: `Website mittel (${quality.score}/10${issues ? `: ${issues}` : ""})${g}` };
    return { fit: "C", reason: `Website wirkt aktuell (${quality.score}/10) – eher SEO/GEO-Thema` };
  }
  if (profile === "automation") {
    const s = site.inquiry?.signals || [];
    if (quality.score <= 3) return { fit: "C", reason: `Website zu schwach (${quality.score}/10) – eher Pool Webseite` };
    if (site.inquiry?.form && (site.inquiry.booking || s.length >= 3)) return { fit: "A", reason: `Anfragen laufen: ${s.join(", ")}` };
    if (site.inquiry?.form || s.length >= 2) return { fit: "B", reason: s.length ? `Anfrage-Signale: ${s.join(", ")}` : "Kontaktformular vorhanden" };
    return { fit: "C", reason: "Kaum Anfrage-Signale auf der Website" };
  }
  // Fall aus Kategorie und Firmenname – dieselben Regeln wie die Fall-Absätze in den Vorlagen.
  const fall = leadCase({ industry: cand.category_label || categoryLabel(cand.category), company: cand.name });
  if (profile === "dealuno") {
    if (/^(shop|amenity|leisure|tourism|club|craft|industrial)=/.test(cand.category || "")) return { reject: "Handel, Gastronomie, Freizeit, Handwerk oder Industrie – kein B2B-Dienstleister" };
    if (HANDWERK.test(name) || (B2C_ONLY.test(name) && !B2B_WORDS.test(name))) return { reject: "Kein B2B-Dienstleister (Handwerk oder Endkunden)" };
    if (DEALUNO_NOT.has(fall)) return { reject: `Kein B2B-Dienstleister (${fall})` };
    // Agentur/Beratung/IT muss im Namen, Seitentitel oder oben auf der Startseite stehen – „Beratung“ irgendwo im Text reicht nicht.
    if (!AGENCY.test(`${name} ${site.quality?.title || ""} ${text.slice(0, 2500)}`)) return { reject: "Keine Agentur, Beratung oder Dienstleistung erkennbar" };
    const hits = SALES_SIGNALS.filter(re => re.test(text)).length;
    if (emp && emp > 150) return { fit: "C", reason: `Groß (${emp} Mitarbeitende) – eher Konzern-Vertrieb` };
    if (hits >= 2) return { fit: "A", reason: `B2B-Vertrieb erkennbar (${hits} Signale)` };
    if (hits === 1) return { fit: "B", reason: "B2B-Kunden erkennbar" };
    return { fit: "C", reason: "B2B-Dienstleister, Vertriebsweg unklar" };
  }
  if (profile === "growth_os") {
    // Handel, Gastronomie, Freizeit: kein Auftragsgeschäft, auch wenn „Produktion“ oder „Service“ im Text steht.
    if (/^(shop|amenity|leisure|tourism|club)=/.test(cand.category || "")) return { reject: "Handel, Gastronomie oder Freizeit – kein Auftragsgeschäft" };
    if (GROWTH_NOT.has(fall)) return { reject: `Kein Auftragsgeschäft in Industrie oder Handwerk (${fall})` };
    const industrial = INDUSTRY.test(`${name} ${cand.category || ""} ${text.slice(0, 20000)}`);
    if (emp !== null && emp < 10) return { reject: `Zu klein (${emp} Mitarbeitende)` };
    if (emp !== null && emp > 500) return { fit: "C", reason: `Sehr groß (${emp} Mitarbeitende) – eher Konzern mit eigener IT` };
    if (!industrial) return { fit: "C", reason: "Kein Auftragsgeschäft in Industrie oder Handwerk erkennbar" };
    if (emp !== null && emp >= 50) return { fit: "A", reason: `${emp} Mitarbeitende, Auftragsgeschäft` };
    if (emp !== null && emp >= 20) return { fit: "B", reason: `${emp} Mitarbeitende, Auftragsgeschäft` };
    if (emp !== null) return { fit: "C", reason: `${emp} Mitarbeitende – an der Untergrenze` };
    const sig = site.employees?.signals || [];
    const bigForm = /GmbH|KG|AG|SE/.test(site.imprint?.legal_form || "");
    if (bigForm && sig.some(s => /offene stellen|standorte|fahrzeuge|monteure|lkw/i.test(s))) return { fit: "B", reason: `Größe nicht genannt, aber ${sig.join(", ")}` };
    return { fit: "C", reason: "Mitarbeiterzahl unbekannt" };
  }
  return { fit: "C", reason: "" };
}

// Welcher Pool passt am besten? Alle Profile bewerten, Laufprofil gewinnt bei Gleichstand, dann Software vor Website.
export function bestPool(runProfile, cand, site) {
  const results = Object.fromEntries(Object.keys(PROFILES).map(k => [k, qualify(k, cand, site)]));
  // Nur A/B dürfen den Pool des Laufs überstimmen – ein C („unklar“) nie. Software vor Website bei Gleichstand.
  const score = k => (results[k].reject ? 0 : results[k].fit === "C" ? 1 : FIT_SCORE[results[k].fit] + PROFILE_BONUS[k]);
  const order = [runProfile, ...PROFILE_PRIORITY.filter(k => k !== runProfile)];
  let best = runProfile;
  for (const k of order) if (score(k) > score(best) && results[k].fit !== "C") best = k;
  return { profile: best, result: results[best], all: results, rejected: score(best) === 0 };
}

function projectForProfile(profile, fallback) {
  const p = listProjects().find(x => profileFor(x) === profile);
  return p ? p.id : fallback;
}

// ---------- Adressen: veröffentlichte Chef-Adresse > persönliche > gebildete Chef-Adresse > Zentrale > OSM/Freemail ----------
const EXTRA_ROLE = /^(impressum|zentrale|buero|büro|verwaltung|anfrage|anfragen|shop|kundendienst|empfang|sekretariat|post|bestellung|auftrag|auftraege|dispo|werkstatt|lager|technik|einkauf|hallo|hello|mail|office|kontakt\w*|info\w*|service\w*|team\w*|vertrieb\w*|verkauf\w*|buchhaltung|rechnung\w*|personal|jobs|karriere|bewerbung\w*|presse|marketing|webmaster|datenschutz|notdienst|zentrale\w*)$/;
const isGeneric = e => isRole(e) || EXTRA_ROLE.test(String(e).split("@")[0]);

function emailOptions(cand, site, domain) {
  // Eigene Domains der Firma: aus OpenStreetMap, Ziel der Website (Weiterleitungen) und eine OSM-Firmenadresse.
  const siteDomain = normalizeDomain(site.url);
  const domains = [...new Set([domain, siteDomain, cand.email && !isFreemail(cand.email) ? normalizeDomain(cand.email) : ""].filter(Boolean))];
  const own = e => domains.includes(normalizeDomain(e));
  const found = [...new Set((site.imprint?.emails || []).map(normalizeEmail).filter(syntaxValid))];
  const person = site.imprint?.people?.[0] || null;
  const published = person ? personalEmailFor(person, found, domains) : null;
  // Chef-Adresse nur bilden, wenn die Firma ihre Domain nachweislich für Mail nutzt (sonst ist jeder Rat ein Bounce), nie für Umlaut-Domains.
  const mailDomain = found.filter(own).map(normalizeDomain)[0] || (cand.email && own(normalizeEmail(cand.email)) ? normalizeDomain(cand.email) : "");
  const guess = getSettings().guess_chief_emails && !published && person && mailDomain && !/(^|\.)xn--/.test(mailDomain) ? guessChiefEmail(person, mailDomain, found) : null;
  const list = [];
  const push = (email, kind, reason) => { if (email && syntaxValid(email) && !list.some(x => x.email === email)) list.push({ email, kind, reason }); };
  push(published, "published", "Auf der Website veröffentlicht");
  for (const e of found) if (own(e) && !isGeneric(e)) push(e, "personal", "Persönliche Adresse auf der Website");
  if (guess) push(guess.email, "guess", guess.guessed ? "Aus dem Namen gebildet (Standardmuster), ungeprüft" : "Aus Name und Adressmuster der Firma gebildet");
  for (const e of found) if (own(e) && isGeneric(e)) push(e, "generic", "Zentrale Adresse aus dem Impressum");
  // Fremde Domains im Impressum sind meist die Webagentur oder der Hoster – nie übernehmen. Nur die OSM-Adresse darf abweichen.
  if (cand.email) push(normalizeEmail(cand.email), isFreemail(cand.email) ? "freemail" : (own(normalizeEmail(cand.email)) ? "generic" : "other"), "Aus OpenStreetMap");
  for (const e of found) if (!own(e) && isFreemail(e)) push(e, "freemail", "Freemail-Adresse von der Website");
  return { list, person, generic: list.find(x => x.kind === "generic")?.email || "", domains };
}

function siteSummary(site) {
  return {
    quality: site.quality, inquiry: site.inquiry?.signals || [], employees: site.employees, facts: (site.facts || []).map(f => f.statement),
    people: (site.imprint?.people || []).map(p => `${[p.first_name, p.last_name].filter(Boolean).join(" ")} (${p.role})`), legal_form: site.imprint?.legal_form || "", pages: site.pages
  };
}

// ---------- Lead + Firma + Fakten anlegen ----------
function importCandidate(run, cand, site, qual, chosen, { person, generic, profile, projectId }) {
  const now = Date.now();
  const list = projectId ? poolList(projectId) : (run.list_id ? q.get("SELECT * FROM lead_lists WHERE id = ?", run.list_id) : null);
  const addr = site.imprint?.address;
  const facts = site.facts || [];
  const custom = {
    pool: PROFILES[profile]?.label || profile, quelle: "OpenStreetMap + Website", osm_id: cand.osm_id, osm_name: site.imprint?.company && site.imprint.company !== cand.name ? cand.name : "", kategorie: cand.category_label, region: cand.region,
    plz: cand.plz || addr?.plz || "", strasse: cand.street || addr?.street || "", rechtsform: site.imprint?.legal_form || "",
    mitarbeiter: site.employees?.estimate ? String(site.employees.estimate) : "", groessen_hinweise: (site.employees?.signals || []).join(", "),
    website_qualitaet: `${site.quality.score}/10`, website_hinweise: site.quality.issues.join(", "), anfrage_signale: (site.inquiry?.signals || []).join(", "),
    lob: facts.filter(f => f.type !== "estimate").slice(0, 3).map(f => f.statement).join(" · "),
    impressum_geprueft: new Date(now).toISOString().slice(0, 10), impressum_quelle: site.imprint?.url || "",
    google_place_id: site.google?.place_id || "", google_bewertungen: site.google?.status || ""
  };
  if (chosen.kind === "guess") { custom.zentrale_email = generic; custom.chef_email_quelle = chosen.reason; }
  else if (["published", "personal"].includes(chosen.kind)) custom.chef_email_quelle = chosen.reason;
  for (const k of Object.keys(custom)) if (!custom[k]) delete custom[k];
  const named = person && ["published", "personal", "guess", "generic"].includes(chosen.kind) ? person : null;
  const row = {
    email: chosen.email, salutation: named?.salutation ? `${named.salutation}${named.title ? ` ${named.title}` : ""}` : "",
    first_name: named?.first_name || "", last_name: named?.last_name || "", position: named?.role || "",
    // Firmenname: der Rechtsträger aus dem Impressum (OSM nennt oft nur Filiale oder Kurzname); der OSM-Name bleibt in den Zusatzfeldern.
    company: (site.imprint?.company || cand.name).slice(0, 200), website: site.url || cand.website, phone: site.imprint?.phone || cand.phone || "", city: cand.city || addr?.city || "", country: "Deutschland",
    industry: cand.category_label || "", source: "Leadquelle: OpenStreetMap + Website",
    notes: `Gefunden über Leadquellen (${PROFILES[profile]?.label || profile}, ${cand.category_label || "Firma"}, ${cand.region}) · ${qual.reason}`,
    verify_status: chosen.verify, verify_reason: chosen.verify_reason || chosen.reason, consent_status: "none", custom: JSON.stringify(custom), created_at: now, updated_at: now
  };
  return tx(() => {
    const leadId = insert("leads", row);
    if (list) q.run("INSERT OR IGNORE INTO lead_list_members (list_id, lead_id, added_at) VALUES (?, ?, ?)", list.id, leadId, now);
    const lead = q.get("SELECT * FROM leads WHERE id = ?", leadId);
    const accountId = ensureAccountForLead(lead);
    if (accountId) {
      if (projectId) q.run("UPDATE accounts SET project_id = ?, updated_at = ? WHERE id = ? AND project_id IS NULL", projectId, now, accountId);
      const acc = q.get("SELECT * FROM accounts WHERE id = ?", accountId);
      update("accounts", accountId, { industry: acc.industry || row.industry, city: acc.city || row.city, employees: acc.employees || (site.employees?.estimate ? `ca. ${site.employees.estimate}` : ""), updated_at: now });
      for (const f of facts) {
        if (q.get("SELECT 1 FROM account_facts WHERE account_id = ? AND key = ? AND status = 'active'", accountId, f.key)) continue;
        insert("account_facts", {
          account_id: accountId, key: f.key, statement: f.statement, type: f.type === "estimate" ? "estimate" : "verified", confidence: f.type === "estimate" ? 50 : 85,
          source_type: "website", source_url: f.source_url || "", quote: f.quote || "", observed_at: now, status: "active", created_by: "scrape", created_at: now
        });
      }
    }
    for (const p of q.all("SELECT id FROM products WHERE project_id = ?", projectId || 0)) {
      q.run(`INSERT INTO lead_fit (lead_id, product_id, fit, reason, checked_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(lead_id, product_id) DO UPDATE SET fit = excluded.fit, reason = excluded.reason, checked_at = excluded.checked_at`, leadId, p.id, qual.fit, qual.reason, now);
    }
    return { leadId, accountId };
  });
}

// ---------- Einen Kandidaten prüfen ----------
async function processCandidate(run, cand) {
  const settings = getSettings();
  const domain = normalizeDomain(cand.website) || (cand.email && !isFreemail(cand.email) ? normalizeDomain(cand.email) : "");
  const start = cand.website || (domain ? `https://${domain}` : "");
  const finish = (status, patch = {}) => { update("sourcing_candidates", cand.id, { status, checked_at: Date.now(), ...patch }); return status; };
  if (!start) return finish("rejected", { reason: "Keine Website und keine Firmen-Adresse" });
  if (domain && findAccountByDomain(domain)) return finish("duplicate", { reason: "Firma schon in Coldmail" });
  const site = await inspectSite(start);
  if (!site.ok) return finish("error", { reason: site.error || "Website nicht erreichbar" });
  // Die Website kann auf eine andere Domain weiterleiten – auch die zählt als „schon in Coldmail“.
  const siteDomain = normalizeDomain(site.url);
  if (siteDomain && siteDomain !== domain && (findAccountByDomain(siteDomain) || q.get("SELECT 1 FROM leads WHERE substr(email, instr(email, '@') + 1) = ?", siteDomain))) return finish("duplicate", { reason: "Firma schon in Coldmail" });
  const label = categoryLabel(cand.category);
  if (NONPROFIT.test(`${cand.name} ${site.quality.title}`)) return finish("rejected", { reason: "Kein Unternehmen (Verein, Verband, gemeinnützig, Behörde, Klinik)", data: JSON.stringify(siteSummary(site)) });
  const legal = legalRiskHit({ company: cand.name, industry: label, website: site.url, email: cand.email, position: site.quality.title }, settings);
  if (legal) return finish("rejected", { reason: `Rechtliches Umfeld (${legal}) – nie per Kaltakquise`, data: JSON.stringify(siteSummary(site)) });
  const { list, person, generic } = emailOptions(cand, site, domain);
  const allowFreemail = !settings.skip_freemail_cold;
  const usable = list.filter(x => x.kind !== "freemail" || allowFreemail);
  if (!usable.length) return finish("rejected", { reason: list.length ? "Nur Freemail-Adresse (Kaltakquise nur an Firmenadressen)" : "Keine E-Mail-Adresse gefunden", data: JSON.stringify(siteSummary(site)) });
  let chosen = null;
  for (const c of usable.slice(0, 4)) {
    if (q.get("SELECT 1 FROM leads WHERE email = ?", c.email)) continue;
    if (q.get("SELECT 1 FROM blocklist WHERE value = ? OR value = ?", c.email, normalizeDomain(c.email))) return finish("rejected", { reason: "Auf der Sperrliste" });
    const vr = c.kind === "guess" ? { status: "risky", reason: c.reason } : await verifier(c.email).catch(() => ({ status: "unknown", reason: "" }));
    if (vr.status === "invalid") continue;
    chosen = { ...c, verify: vr.status, verify_reason: vr.reason || c.reason };
    break;
  }
  if (!chosen) return finish(usable.every(c => q.get("SELECT 1 FROM leads WHERE email = ?", c.email)) ? "duplicate" : "rejected", { reason: "Keine neue, zustellbare Adresse", data: JSON.stringify(siteSummary(site)) });
  // Google-Bewertungen (nur mit Schlüssel): erst jetzt, damit keine Abfrage für ohnehin aussortierte Firmen anfällt.
  let google = null;
  if (placesEnabled()) {
    let place;
    try { place = await placeFinder({ name: site.imprint?.company || cand.name, city: cand.city || site.imprint?.address?.city || "", plz: cand.plz || site.imprint?.address?.plz || "", website: site.url || cand.website }); }
    catch (err) { return finish("error", { reason: err.message }); }
    google = { ...judgePlace(place, settings), place_id: place.place_id || "" };
    site.google = google;
    if (settings.google_require_reviews && ["keine", "nicht gefunden", "geschlossen"].includes(google.status)) {
      return finish("rejected", { reason: google.status === "geschlossen" ? "Laut Google dauerhaft geschlossen" : google.status === "keine" ? "Keine Google-Bewertungen" : "Bei Google nicht gefunden", data: JSON.stringify(siteSummary(site)) });
    }
  }
  const pool = bestPool(run.profile, { ...cand, category_label: label }, site);
  const summary = { ...siteSummary(site), pools: Object.fromEntries(Object.entries(pool.all).map(([k, r]) => [k, r.reject ? `– ${r.reject}` : `${r.fit}: ${r.reason}`])) };
  if (pool.rejected) return finish("rejected", { reason: pool.all[run.profile].reject || pool.all[run.profile].reason, data: JSON.stringify(summary) });
  const qual = pool.result;
  const projectId = projectForProfile(pool.profile, run.project_id);
  const { leadId, accountId } = importCandidate(run, { ...cand, category_label: label }, site, qual, chosen, { person, generic, profile: pool.profile, projectId });
  const reason = pool.profile === run.profile ? qual.reason : `${qual.reason} → Pool ${PROFILES[pool.profile].label}`;
  return finish("imported", { fit: qual.fit, reason, lead_id: leadId, account_id: accountId, email: chosen.email, data: JSON.stringify(summary) });
}

// ---------- Kandidaten sammeln: je Takt eine OpenStreetMap-Abfrage für eine Region × eine Kategorie ----------
// Je Abfrage bis zu drei Kategorien (jede Kategorie = ein Scan der Region, drei sind noch schnell genug).
const CATS_PER_QUERY = 3;
export function workUnits(run) {
  const regions = parseJson(run.regions, []);
  const cats = parseJson(run.categories, []).filter(k => CATEGORIES[k]);
  const groups = [];
  for (let i = 0; i < cats.length; i += CATS_PER_QUERY) groups.push(cats.slice(i, i + CATS_PER_QUERY));
  return { regions, cats, groups, total: regions.length * groups.length };
}

// Nach einem Timeout/Überlast-Fehler zwei Minuten lang keine neue OpenStreetMap-Abfrage (fair gegenüber dem Server).
let overpassPausedUntil = 0;

async function collectUnit(run) {
  const { regions, cats, groups, total } = workUnits(run);
  if (!cats.length) throw new Error("Keine Kategorien gewählt");
  const idx = run.region_index;
  if (idx >= total) return { region: "", added: 0, dup: 0, elements: 0 };
  const region = regions[Math.floor(idx / groups.length)];
  const group = groups[idx % groups.length];
  const catKey = group.join("+");
  let elements;
  try {
    elements = await runOverpass(buildQuery(region, group.flatMap(k => CATEGORIES[k].filters), { limit: 4000 }));
  } catch (err) {
    if (/timed out|HTTP 5\d\d|ausgelastet|nicht erreichbar/i.test(err.message)) overpassPausedUntil = Date.now() + 2 * 60 * 1000;
    throw err;
  }
  const cands = toCandidates(elements);
  const seen = new Set(q.all("SELECT domain, email FROM sourcing_candidates WHERE run_id = ?", run.id).flatMap(r => [r.domain, r.email ? `mail:${r.email}` : ""]).filter(Boolean));
  const now = Date.now();
  let added = 0, dup = 0;
  const remaining = Math.max(0, run.max_candidates - run.found);
  tx(() => {
    for (const c of cands) {
      if (added >= remaining) break;
      if (!c.website && !c.email) continue;
      const domain = normalizeDomain(c.website) || (c.email && !isFreemail(c.email) ? normalizeDomain(c.email) : "");
      const key = domain || `mail:${c.email}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let status = "new", reason = "";
      if (domain && (findAccountByDomain(domain) || q.get("SELECT 1 FROM leads WHERE substr(email, instr(email, '@') + 1) = ?", domain))) { status = "duplicate"; reason = "Firma schon in Coldmail"; }
      else if (domain && q.get("SELECT 1 FROM sourcing_candidates WHERE domain = ? AND project_id IS ? AND status IN ('imported','rejected','duplicate')", domain, run.project_id)) { status = "duplicate"; reason = "Schon in einem früheren Lauf geprüft"; }
      else if (c.email && q.get("SELECT 1 FROM leads WHERE email = ?", normalizeEmail(c.email))) { status = "duplicate"; reason = "Adresse schon in Coldmail"; }
      insert("sourcing_candidates", {
        run_id: run.id, project_id: run.project_id, osm_id: c.osm_id, domain, name: c.name.slice(0, 200), website: c.website.slice(0, 500), email: c.email.slice(0, 200), phone: c.phone.slice(0, 60),
        city: c.city.slice(0, 100), plz: c.plz.slice(0, 10), category: c.category.slice(0, 80), region, status, reason, data: JSON.stringify({ street: c.street }),
        checked_at: status === "new" ? null : now, created_at: now
      });
      if (status === "new") added++; else dup++;
    }
  });
  // Erste Kategorie einer Region ohne jeden Treffer: Hinweis auf einen falschen Regionsnamen.
  const note = !elements.length && idx % groups.length === 0 ? `Region „${region}“: keine Treffer (Name wie bei OpenStreetMap schreiben, z. B. „Oberbergischer Kreis“)` : "";
  const keep = (run.error || "").split(" · ").filter(e => e && !/OpenStreetMap-Abfrage fehlgeschlagen/.test(e));
  update("sourcing_runs", run.id, { found: run.found + added, duplicates: run.duplicates + dup, region_index: idx + 1, updated_at: now, error: [...keep, note].filter(Boolean).join(" · ").slice(0, 1000) || null });
  return { region, category: catKey, elements: elements.length, added, dup };
}

// ---------- Ein Takt: sammeln, prüfen, abschließen ----------
export async function runSourcingTick({ batch = 10, concurrency = 3, now = Date.now() } = {}) {
  if (sourcingState.running) return { skipped: true };
  sourcingState.running = true;
  const summary = { collected: 0, processed: 0, imported: 0, rejected: 0, duplicates: 0, errors: 0, limit_reached: false };
  try {
    for (const run of q.all("SELECT * FROM sourcing_runs WHERE status IN ('queued','running') ORDER BY created_at")) {
      if (run.status === "queued") update("sourcing_runs", run.id, { status: "running", started_at: now, updated_at: now });
      const fresh = q.get("SELECT * FROM sourcing_runs WHERE id = ?", run.id);
      const pending = q.value("SELECT COUNT(*) FROM sourcing_candidates WHERE run_id = ? AND status = 'new'", run.id);
      if (pending || fresh.region_index >= workUnits(fresh).total || fresh.found >= fresh.max_candidates) continue;
      if (overpassPausedUntil > now) { summary.overpass_paused = true; break; }
      // Nach einem Fehler (Server ausgelastet) erst nach zwei Minuten erneut fragen.
      if (fresh.error && /ausgelastet|nicht erreichbar|fehlgeschlagen/.test(fresh.error) && fresh.updated_at > now - 2 * 60 * 1000) continue;
      try {
        const r = await collectUnit(fresh);
        summary.collected += r.added;
      } catch (err) {
        update("sourcing_runs", run.id, { error: String(err.message || err).slice(0, 500), updated_at: now });
        sourcingState.lastError = err.message;
      }
      break; // je Takt nur eine OpenStreetMap-Abfrage (Fair-Use)
    }
    const settings = getSettings();
    const limit = Number(settings.sourcing_daily_limit) || 0;
    const used = dailyUsed(now);
    if (limit && used >= limit) summary.limit_reached = true;
    else {
      const room = limit ? Math.min(batch, limit - used) : batch;
      const cands = q.all(`SELECT c.* FROM sourcing_candidates c JOIN sourcing_runs r ON r.id = c.run_id WHERE c.status = 'new' AND r.status = 'running' ORDER BY r.created_at, c.id LIMIT ?`, room);
      let i = 0;
      const worker = async () => {
        while (i < cands.length) {
          const c = cands[i++];
          const run = q.get("SELECT * FROM sourcing_runs WHERE id = ?", c.run_id);
          let status;
          try { status = await processCandidate(run, c); }
          catch (err) { update("sourcing_candidates", c.id, { status: "error", reason: String(err.message || err).slice(0, 300), checked_at: Date.now() }); status = "error"; }
          summary.processed++;
          summary[status === "imported" ? "imported" : status === "rejected" ? "rejected" : status === "duplicate" ? "duplicates" : "errors"]++;
          q.run(`UPDATE sourcing_runs SET checked = checked + 1, imported = imported + ?, rejected = rejected + ?, duplicates = duplicates + ?, errors = errors + ?, updated_at = ? WHERE id = ?`,
            status === "imported" ? 1 : 0, status === "rejected" ? 1 : 0, status === "duplicate" ? 1 : 0, status === "error" ? 1 : 0, Date.now(), c.run_id);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, cands.length) }, worker));
    }
    for (const run of q.all("SELECT * FROM sourcing_runs WHERE status = 'running'")) {
      const pending = q.value("SELECT COUNT(*) FROM sourcing_candidates WHERE run_id = ? AND status = 'new'", run.id);
      if (!pending && (run.region_index >= workUnits(run).total || run.found >= run.max_candidates)) {
        update("sourcing_runs", run.id, { status: "done", finished_at: Date.now(), updated_at: Date.now() });
        recordEvent("sourcing_done", { data: { run_id: run.id, project_id: run.project_id, imported: run.imported, checked: run.checked } });
      }
    }
    sourcingState.lastError = null;
  } catch (err) {
    sourcingState.lastError = err.message;
    console.error("[sourcing]", err);
  } finally {
    sourcingState.running = false;
    sourcingState.lastTickAt = Date.now();
    sourcingState.lastSummary = summary;
  }
  return summary;
}

let timer = null;
export function startSourcing(intervalMs = 20000) {
  stopSourcing();
  const loop = async () => {
    try { await runSourcingTick(); } catch (err) { sourcingState.lastError = err.message; console.error("[sourcing]", err); }
    timer = setTimeout(loop, intervalMs);
    timer.unref?.();
  };
  timer = setTimeout(loop, 10000);
  timer.unref?.();
}
export function stopSourcing() {
  if (timer) clearTimeout(timer);
  timer = null;
}
