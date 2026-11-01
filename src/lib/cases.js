// Fall je Lead: aus Branche, Kategorie (Leadquellen), Branche der alten Sales App und Firmenname wird ein Schlüssel abgeleitet,
// mit dem Vorlagen je Fall andere Absätze zeigen ({{#fall handwerk}} … {{#fall gastro}} … {{#sonst}} … {{/fall}}).
export const CASES = {
  bau: "Bau und Ausbau (Dach, Zimmerei, Tischler, Maler, GaLaBau, Fenster, Rohbau)",
  technik: "Elektro, SHK, Klima, Gebäudetechnik, Solar",
  metall: "Metall, Zerspanung, Werkzeug- und Maschinenbau",
  industrie: "Produktion und Industrie (Kunststoff, Verpackung, Chemie, Hersteller)",
  logistik: "Spedition, Transport, Entsorgung, Lager",
  handwerk: "sonstiges Handwerk",
  werkstatt: "Kfz, Reifen, Autohaus, Karosserie",
  laden: "Fachhandel und Läden",
  gastro: "Restaurant, Café, Hotel, Catering",
  freizeit: "Fitness, Fahrschule, Tanz- und Musikschule, Verein",
  praxis: "Praxen (Zahnarzt, Tierarzt, Physiotherapie)",
  agentur: "Werbe-, Marketing-, Web- und Designagenturen, Medien",
  it: "IT-Dienstleister, Software, Systemhaus",
  personal: "Personaldienstleister, Recruiting",
  beratung: "Beratung, Coaching, Finanz- und Versicherungsvermittlung",
  immobilien: "Immobilien, Hausverwaltung",
  dienstleister: "sonstige Dienstleister und Büros (Architekten, Ingenieure, Sicherheit, Reinigung)",
  sonst: "alles andere (Standard-Absatz)"
};

// Reihenfolge = Priorität: das Spezielle vor dem Allgemeinen.
const RULES = [
  ["gastro", /restaurant|caf[eé]\b|\bbar\b|gaststätte|gasthaus|gasthof|biergarten|imbiss|hotel|pension|catering|gastro|kneipe|bistro|pizzeria|eisdiele|ferienwohnung|ferienhaus|camping/i],
  ["werkstatt", /\bkfz\b|werkstatt|autohaus|reifen|motorrad|caravan|nutzfahrzeug|anhänger|autowäsche|autovermietung|karosserie|fahrzeugbau|car_repair|autoservice/i],
  ["praxis", /zahnarzt|zahnärzt|tierarzt|tierärzt|physio|praxis|ergotherap|logopäd|heilpraktik/i],
  ["freizeit", /fitness|sportzentrum|sportstudio|tanzschule|fahrschule|musikschule|sprachschule|\bverein\b|golf|reit(?:hof|stall|sport)|yoga|kampfsport|schwimm|bowling|kegel|kletter|freizeit|spielhalle|kino|minigolf/i],
  ["laden", /bäckerei|bäcker|konditorei|metzger|fleischerei|blumen|florist|möbel|küchenstudio|betten|fahrrad|friseur|frisör|kosmetik|optik|juwelier|\bmode\b|boutique|schuhe|sportgeschäft|gartencenter|baumarkt|eisenwaren|raumausstatt|farbenfach|elektronik|haushaltsgeräte|fachhandel|einzelhandel|\bladen\b|geschäft|druckerei|copyshop|weinhandel|feinkost|tierbedarf|\bpet\b|zoo|fachmarkt/i],
  ["agentur", /werbeagentur|agentur|marketing|webdesign|grafik|design|medien|filmproduktion|fotograf|fotostudio|kommunikation|\bpr\b|social media|content/i],
  ["it", /\bit\b|it-|edv|software|systemhaus|informatik|digitalisierung|digital|hosting|cloud|app-?entwicklung|programmier/i],
  ["personal", /personal|recruiting|zeitarbeit|arbeitsvermittlung|employment|headhunt|personaldienst/i],
  ["beratung", /beratung|berater|consulting|coach|coaching|finanz|versicherung|vermögen|unternehmensentwicklung/i],
  ["immobilien", /immobilien|hausverwaltung|makler|estate|wohnungsbau(?:gesellschaft|genossenschaft)|property/i],
  ["logistik", /logistik|spedition|transport|entsorg|recycling|lager|kurier|umzug|fuhrpark|container/i],
  ["technik", /elektro|sanitär|heizung|klima|lüftung|\bshk\b|haustechnik|\btga\b|gebäudetechnik|gebäudeausr|kälte|solar|photovoltaik|energietechnik|sicherheitstechnik|automatisierungstechnik|regeltechnik|mess- und/i],
  ["metall", /metall|zerspan|schweiß|schlosser|schmiede|maschinenbau|anlagenbau|werkzeugbau|formenbau|stahlbau|dreherei|fräs|blech|oberflächentechnik|galvan|feinmechanik|apparatebau/i],
  ["bau", /\bbau\b|bauunternehm|dach|zimmer(?:ei|er)|tischler|schreiner|holzbau|maler|lackier|stuck|putz\b|fliesen|boden|gerüst|fenster|garten|landschaft|glaser|dämm|isolier|steinmetz|ausbau|rohbau|hochbau|tiefbau|straßenbau|trockenbau|estrich|pflaster|abbruch|sanierung|bauträger/i],
  ["industrie", /industrie|produktion|fertigung|\bwerk\b|hersteller|kunststoff|verpackung|chemie|lebensmittel|textil|papier|gießerei|elektronikfertigung|zulieferer|manufaktur|\bworks\b/i],
  ["handwerk", /handwerk|craft|meister(?:betrieb)?|montage|installation|reinigung|gebäudereinig|polster|sattler|schneider|schlüsseldienst/i],
  ["dienstleister", /architekt|ingenieur|engineering|planungsbüro|vermessung|sicherheitsdienst|wachdienst|büro|dienstleist|service|verlag|steuer|übersetz|event|veranstalt|bildung|schulung|akademie|institut|labor/i]
];

function parse(custom) {
  if (!custom) return {};
  if (typeof custom === "object") return custom;
  try { return JSON.parse(custom) || {}; } catch { return {}; }
}

// Ermittelt den Fall eines Leads. Reihenfolge der Quellen: Branche/Kategorie (am verlässlichsten), dann Firmenname, zuletzt Notizen.
export function leadCase(lead = {}) {
  const c = parse(lead.custom);
  const sources = [
    [lead.industry, c.kategorie, c.branche, c.cluster, c.industry].filter(Boolean).join(" · "),
    String(lead.company || ""),
    String(lead.notes || "").slice(0, 300)
  ];
  for (const text of sources) {
    if (!text.trim()) continue;
    for (const [key, re] of RULES) if (re.test(text)) return key;
  }
  return "sonst";
}

export const caseLabel = key => CASES[key] || CASES.sonst;
