// Regelbasierter Copy-Check für Cold Mails: Spam-Wörter, Länge, Links, Großschreibung, Personalisierung.
import { usedVariables, resolveCases } from "./template.js";

const TRIGGERS = [
  // Deutsch
  "kostenlos", "gratis", "umsonst", "100%", "100 %", "garantiert", "garantie", "risikofrei", "ohne risiko", "jetzt kaufen", "jetzt bestellen",
  "sofort", "nur heute", "nur noch heute", "begrenztes angebot", "limitiert", "exklusives angebot", "sonderangebot", "rabatt", "preisnachlass",
  "gewinn", "gewinnen", "gewinner", "gewonnen", "geld verdienen", "schnell geld", "nebenverdienst", "reich werden", "verdopple", "verdoppeln",
  "klicken sie hier", "hier klicken", "jetzt klicken", "keine kosten", "keine verpflichtung", "unverbindlich testen", "einmalige chance",
  "dringend", "letzte chance", "nicht verpassen", "geld zurück", "geld-zurück", "bestpreis", "billig", "€€€", "!!!", "abnehmen", "kredit",
  "schulden", "bitcoin", "krypto", "investition mit", "rendite garantiert",
  // Englisch
  "free", "guarantee", "guaranteed", "risk-free", "risk free", "act now", "buy now", "order now", "limited time", "urgent", "winner",
  "click here", "click below", "earn money", "make money", "cash", "$$$", "100% free", "no cost", "no obligation", "special promotion",
  "best price", "cheap", "discount", "lowest price", "double your", "extra income", "once in a lifetime", "congratulations", "dear friend"
];

const SHORTENERS = /(bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rebrand\.ly|cutt\.ly|shorturl\.at)/i;

export function checkCopy(subject = "", body = "") {
  const issues = [];
  let score = 100;
  const penalize = (points, level, message) => { score -= points; issues.push({ level, message }); };

  // Fall-Blöcke: geprüft wird der längste Zweig (schlechtester Fall für Länge und Spam-Wörter).
  body = resolveCases(body, "sonst", "longest");
  subject = resolveCases(subject, "sonst", "longest");
  const plainBody = String(body).replace(/\{\{[^}]*\}\}/g, "x").replace(/\{([^{}]*\|[^{}]*)\}/g, (_, a) => a.split("|")[0]);
  const plainSubject = String(subject).replace(/\{\{[^}]*\}\}/g, "x").replace(/\{([^{}]*\|[^{}]*)\}/g, (_, a) => a.split("|")[0]);
  const all = `${plainSubject}\n${plainBody}`.toLowerCase();

  const found = TRIGGERS.filter(t => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}])${escaped}($|[^\\p{L}])`, "u").test(all);
  });
  if (found.length) penalize(Math.min(30, found.length * 8), found.length > 2 ? "error" : "warn", `Spam-verdächtige Wörter: ${found.slice(0, 8).join(", ")}`);

  const words = plainBody.split(/\s+/).filter(Boolean).length;
  if (words < 25) penalize(5, "warn", `Sehr kurz (${words} Wörter) – wirkt oft unpersönlich.`);
  else if (words > 180) penalize(15, "warn", `Lang (${words} Wörter) – Cold Mails mit 50–125 Wörtern bekommen die meisten Antworten.`);

  if (!plainSubject.trim()) issues.push({ level: "info", message: "Kein Betreff – wird als Antwort im selben Thread gesendet (ideal für Follow-ups)." });
  else {
    if (plainSubject.length > 60) penalize(8, "warn", "Betreff über 60 Zeichen – kurze Betreffs (2–6 Wörter) wirken persönlicher.");
    if (/!/.test(plainSubject)) penalize(8, "warn", "Ausrufezeichen im Betreff wirkt werblich.");
    if (/[A-ZÄÖÜ]{5,}/.test(plainSubject)) penalize(10, "warn", "GROSSBUCHSTABEN im Betreff.");
  }

  const links = (String(body).match(/https?:\/\/[^\s)>\]]+/gi) || []);
  if (links.length > 2) penalize(15, "warn", `${links.length} Links – in der ersten Mail höchstens einen Link (besser keinen) verwenden.`);
  if (links.some(l => SHORTENERS.test(l))) penalize(20, "error", "Link-Kürzer (bit.ly o. Ä.) werden von Spamfiltern stark abgewertet.");
  if (/<img\b/i.test(body)) penalize(10, "warn", "Bilder in Cold Mails senken die Zustellbarkeit.");
  if ((plainBody.match(/!/g) || []).length > 3) penalize(6, "warn", "Viele Ausrufezeichen.");
  const capsWords = (plainBody.match(/\b[A-ZÄÖÜ]{4,}\b/g) || []).filter(w => !/^(GMBH|KG|AG|UG|SEO|CRM|ERP|API|B2B|DSGVO|URL|KPI|USA|EUR|HTML|PDF)$/.test(w));
  if (capsWords.length > 2) penalize(6, "warn", "Mehrere Wörter in Großbuchstaben.");
  if (/€|\$|eur\b/i.test(plainBody) && /\d/.test(plainBody)) issues.push({ level: "info", message: "Preise in der ersten Mail senken oft die Antwortquote – lieber im Gespräch." });

  const vars = usedVariables(`${subject}\n${body}`);
  if (!vars.length) penalize(10, "warn", "Keine Personalisierung (z. B. {{anrede}}, {{company}}).");
  if (!/\?/.test(plainBody)) issues.push({ level: "info", message: "Keine Frage im Text – eine klare, leichte Frage als Abschluss erhöht Antworten." });
  if (!/\{[^{}]*\|[^{}]*\}/.test(`${subject}${body}`)) issues.push({ level: "info", message: "Tipp: Spintax wie {Hallo|Guten Tag} macht jede Mail etwas anders." });

  return { score: Math.max(0, Math.min(100, score)), words, links: links.length, issues };
}
