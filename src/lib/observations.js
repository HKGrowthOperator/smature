// Beobachtung je Lead: ein wahrer, konkreter Satz über die Website der Firma, gebaut aus dem, was die Leadquelle beim
// Prüfen festgehalten hat (website_hinweise, anfrage_signale, groessen_hinweise). Kein Lob (das macht die KI-Zeile),
// sondern die eine Sache, die uns aufgefallen ist – damit die Mail nicht klingt wie alle anderen.
import { leadCase } from "./cases.js";

const parse = c => { if (!c) return {}; if (typeof c === "object") return c; try { return JSON.parse(c) || {}; } catch { return {}; } };
const list = s => String(s || "").split(/\s*,\s*/).map(x => x.trim()).filter(Boolean);

// Reihenfolge = was zuerst genannt wird (das Auffälligste vorn). [kurz für den Betreff, Satz für den Text]
const ISSUES = [
  [/^Baustelle$/i, ["noch Baustelle", "auf Ihrer Seite steht noch „Baustelle“"]],
  [/^nicht für Handys gebaut$/i, ["nicht fürs Handy", "auf dem Handy lässt sich Ihre Seite kaum bedienen, dabei kommt dort heute der Großteil der Besucher an"]],
  [/^kein HTTPS$/i, ["Browser-Warnung", "der Browser warnt vor Ihrer Seite, weil sie ohne Verschlüsselung läuft"]],
  [/^Stand (\d{4})$/i, m => [`Footer sagt ${m[1]}`, `im Footer steht noch ${m[1]}`]],
  [/^kein Kontaktformular$/i, ["ohne Formular", "man kann Ihnen auf der Seite nicht direkt schreiben, es gibt nur die Telefonnummer"]],
  [/^sehr wenig Inhalt$/i, ["zwei Sätze Inhalt", "Ihre Seite sagt in zwei Sätzen, was Sie machen, mehr nicht"]],
  [/^Baukasten$/i, ["Baukasten-Seite", "Ihre Seite läuft über einen Baukasten mit laufendem Abo"]],
  [/^veralteter Aufbau$/i, ["technisch alt", "die Seite ist technisch aus einer anderen Zeit, und Google merkt das"]],
  [/^nichtssagender Seitentitel$/i, ["Titel „Startseite“", "Ihr Seitentitel bei Google heißt nur „Startseite“"]]
];

const SIGNALS = [
  [/^Notdienst\/24h$/i, ["Notdienst, aber nachts still", "Sie werben mit Notdienst rund um die Uhr, aber eine Anfrage um 21 Uhr beantwortet bis zum Morgen niemand"]],
  [/^Online-Terminbuchung$/i, ["Terminbuchung ohne Nachlauf", "Sie haben schon eine Online-Terminbuchung, der Teil danach (Bestätigung, Erinnerung, Bewertung) fehlt noch"]],
  [/^(\d+) offene Stellen?$/i, m => [`${m[1]} offene Stellen`, `Sie suchen gerade ${m[1]} Leute, der Laden wächst also`]],
  [/^mehrere Standorte$/i, ["mehrere Standorte", "Sie haben mehrere Standorte, da laufen Anfragen schnell an der falschen Stelle auf"]],
  [/^viele Leistungen$/i, ["viele Leistungen", "Sie bieten viele Leistungen an, aber die Seite sagt nicht, welche davon Sie am liebsten verkaufen"]]
];

// Reihenfolge der Tabelle = Priorität (das Auffälligste zuerst), unabhängig davon, wie die Hinweise gespeichert wurden.
function match(table, values) {
  const out = [];
  for (const [re, make] of table) for (const val of values) {
    const m = re.exec(val);
    if (m) { out.push(typeof make === "function" ? make(m) : make); break; }
  }
  return out;
}

// Allgemeiner Satz je Fall, wenn die Leadquelle nichts Konkretes festgehalten hat (z. B. Leads aus der alten Sales App).
const GENERIC = {
  bau: "Wer gerade einen Handwerker googelt, entscheidet in Sekunden, bei wem er anfragt.",
  technik: "Wer gerade einen Techniker googelt, entscheidet in Sekunden, bei wem er anfragt.",
  metall: "Einkäufer schauen zuerst auf die Website und entscheiden in Sekunden, wen sie anfragen.",
  industrie: "Einkäufer und Bewerber schauen zuerst auf die Website und entscheiden in Sekunden.",
  logistik: "Disponenten schauen zuerst auf die Website und entscheiden in Sekunden, wen sie anfragen.",
  werkstatt: "Wer abends mit schleifender Bremse am Handy eine Werkstatt sucht, entscheidet in Sekunden, wem er schreibt.",
  gastro: "Wer für Samstag einen Tisch sucht, entscheidet in Sekunden, wem er schreibt.",
  laden: "Wer etwas Bestimmtes sucht, schaut vor dem Losfahren bei Google nach und entscheidet in Sekunden.",
  freizeit: "Wer eine Probestunde sucht, entscheidet in zwei Minuten am Handy, ob er sich meldet.",
  praxis: "Wer einen Termin sucht, entscheidet in zwei Minuten am Handy, ob er sich meldet.",
  sonst: "Wer Sie empfohlen bekommt, schaut vorher online nach und entscheidet in Sekunden."
};

export function observations(lead) {
  const c = parse(lead?.custom);
  return { issues: match(ISSUES, list(c.website_hinweise)), signals: match(SIGNALS, [...list(c.anfrage_signale), ...list(c.groessen_hinweise)]) };
}

// Der Satz für den Text: höchstens zwei Beobachtungen, sonst der allgemeine Satz je Fall.
export function observation(lead, { prefer = "issues" } = {}) {
  const o = observations(lead);
  const pick = prefer === "signals" ? [...o.signals, ...o.issues] : [...o.issues, ...o.signals];
  const two = pick.slice(0, 2).map(x => x[1]);
  if (!two.length) return GENERIC[leadCase(lead)] || GENERIC.sonst;
  const s = two.length === 2 ? `${two[0]}, und ${two[1]}` : two[0];
  return `${two.length === 2 ? "Zwei Dinge sind mir aufgefallen: " : "Eine Sache ist mir aufgefallen: "}${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

// Nur belegte Beobachtungen – ohne den allgemeinen Satz je Fall (leer, wenn nichts Konkretes bekannt ist).
export function observationConcrete(lead, opts = {}) {
  const o = observations(lead);
  return o.issues.length || o.signals.length ? observation(lead, opts) : "";
}

// Kurzform für den Betreff („Footer sagt 2019“); leer, wenn es nichts Konkretes gibt.
export function observationShort(lead, { prefer = "issues" } = {}) {
  const o = observations(lead);
  const pick = prefer === "signals" ? [...o.signals, ...o.issues] : [...o.issues, ...o.signals];
  return pick.length ? pick[0][0] : "";
}
