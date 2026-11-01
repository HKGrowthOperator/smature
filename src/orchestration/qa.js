// Nachrichten-Qualitätsprüfung vor dem Versand (ohne KI, deterministisch): generische Floskeln, „creepy“
// Formulierungen (Überwachungs-Eindruck, Privates), Zahlen ohne Beleg, widerlegte Annahmen und Vermutungen,
// die als Tatsache formuliert sind. Ergebnis: Qualität 0–100, Creepy-Score 0–100 und konkrete Hinweise.
import { q } from "../db.js";
import { getSettings } from "../settings.js";

const GENERIC = [
  [/ich hoffe,? (diese|meine) ((e-?)?mail|nachricht) (erreicht|findet) sie/i, "Floskel „Ich hoffe, diese Mail erreicht Sie …“"],
  [/(bin|sind) (auf|über) ihr(e|en)? (unternehmen|firma|website|webseite|profil) gesto(ß|ss)en/i, "Floskel „bin auf Ihr Unternehmen gestoßen“"],
  [/beeindruckend(e|en|es)? (unternehmen|website|webseite|arbeit|entwicklung)/i, "Lob ohne Inhalt („beeindruckend“)"],
  [/\b(synergie|synergien|win-win|game.?changer|revolution(är|aer)|bahnbrechend|einzigartig(e|en)? l(ö|oe)sung)/i, "Werbesprache"],
  [/\binnovative[nr]? l(ö|oe)sung(en)?\b/i, "Leere Formel „innovative Lösung“"],
  [/\b(nur|lediglich) (noch )?(heute|diese woche)\b|\blimitiert(es|e)? angebot\b|\bletzte chance\b/i, "Künstlicher Zeitdruck"],
  [/\bkostenlos(e|es|en)?\b.*\bunverbindlich(e|es|en)?\b/i, "Werbe-Doppelformel „kostenlos und unverbindlich“"]
];

// Gewicht = Beitrag zum Creepy-Score.
const CREEPY = [
  [/\bihr(e|en|em|er)? (familie|kinder|frau|mann|ehefrau|ehemann|hochzeit|geburtstag|urlaub|hobbys?|privatleben|wohnort|haus|auto|wohnung)\b/i, 45, "Privates erwähnt"],
  [/\b(gl(ü|ue)ckwunsch|gratulation|gratuliere) (zur|zum) (hochzeit|geburtstag|nachwuchs|baby)\b/i, 45, "Privates erwähnt"],
  [/\b(instagram|facebook|tiktok|privaten? profil)\b/i, 35, "Private Social-Media-Kanäle"],
  [/\blinked-?in[- ]?(profil|aktivit(ä|ae)t|beitrag|post)/i, 25, "Bezug auf persönliche LinkedIn-Aktivität"],
  [/\b(wir|ich) (beobachte[nt]?|verfolge[nt]?|tracke[nt]?|(ü|ue)berwache[nt]?)\b/i, 40, "Überwachungs-Eindruck („wir beobachten …“)"],
  [/\bunser (system|tool|algorithmus|ki) hat (erkannt|festgestellt|ermittelt|analysiert)/i, 35, "„Unser System hat erkannt …“"],
  [/\b(habe|haben) (ihr(e|en)? )?(profil|website|webseite|unternehmen|stellenanzeigen?) (genau |ausf(ü|ue)hrlich |gr(ü|ue)ndlich )?(analysiert|ausgewertet|durchleuchtet|gescannt)/i, 25, "„Ihr Profil analysiert“"],
  [/\b(gestern|vorgestern|heute morgen|letzte nacht) (haben|hatten|waren) sie\b/i, 30, "Sehr genaue zeitliche Beobachtung"],
  [/\b(ich|wir) (wei(ß|ss)|wissen),? dass sie\b/i, 20, "„Ich weiß, dass Sie …“"],
  [/\bihr(e|en)? (gehalt|alter|privatnummer|handynummer)\b/i, 45, "Persönliche Daten"]
];

// Vermutung als Tatsache formuliert.
const ASSERTIVE = [
  [/\bsie haben (sicher|bestimmt|garantiert|zweifellos)\b/i, "Vermutung als Tatsache („Sie haben sicher …“)"],
  [/\bihr (gr(ö|oe)(ß|ss)tes )?problem ist\b/i, "Pain als Tatsache behauptet („Ihr Problem ist …“)"],
  [/\b(offensichtlich|eindeutig) (haben|kämpfen|leiden) sie\b/i, "Unterstellung („offensichtlich kämpfen Sie …“)"],
  [/\bsie (verlieren|verschwenden) (gerade|aktuell|jeden tag|t(ä|ae)glich)\b/i, "Verlust als Tatsache unterstellt"]
];

const STOP = new Set(["nicht", "keine", "kein", "einen", "einer", "eines", "dieser", "diese", "dieses", "werden", "wurde", "haben", "hatte", "sind", "sein", "ihre", "ihren", "ihrem", "unser", "unsere", "durch", "aktuell", "bereits", "schon", "noch", "mehr", "sehr", "ohne", "auch", "oder", "aber", "dass", "denn", "weil", "wird", "kann", "können", "sollte", "firma", "unternehmen"]);
const words = s => String(s || "").toLowerCase().replace(/[^a-zäöüß0-9 ]+/gi, " ").split(/\s+/).filter(w => w.length >= 5 && !STOP.has(w));

// Zahlen (12, 30 %, 3 Std.) in der Mail, die in keinem Beleg stehen. Platzhalter und Datumsangaben zählen nicht.
function numberClaims(text) {
  const clean = String(text || "").replace(/\{\{[^}]*\}\}/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/\b\d{1,2}\.\d{1,2}\.(\d{2,4})?\b/g, " ").replace(/\b\d{1,2}:\d{2}\b/g, " ");
  const out = [];
  const re = /(\d+(?:[.,]\d+)?)\s*(%|prozent|stunden|std\.?|minuten|min\.?|tage|wochen|monate|jahre|mitarbeitende|mitarbeiter|kunden|euro|€|x|mal)?/gi;
  let m;
  while ((m = re.exec(clean))) {
    const n = m[1];
    if (/^(19|20)\d\d$/.test(n) && !m[2]) continue; // Jahreszahl
    if (Number(n.replace(",", ".")) <= 2 && !m[2]) continue; // „1 Frage“, „2 Minuten“ ohne Einheit
    out.push({ raw: m[0].trim(), n });
  }
  return out;
}

function evidenceText({ accountId = null, productId = null, lead = null, extra = "" } = {}) {
  const parts = [extra];
  if (accountId) {
    parts.push(...q.all("SELECT statement, quote FROM account_facts WHERE account_id = ? AND status = 'active'", accountId).map(f => `${f.statement} ${f.quote}`));
    parts.push(...q.all("SELECT title, detail, quote FROM account_signals WHERE account_id = ? AND status = 'active'", accountId).map(s => `${s.title} ${s.detail} ${s.quote}`));
    const a = q.get("SELECT employees, summary FROM accounts WHERE id = ?", accountId);
    if (a) parts.push(a.employees, a.summary);
  }
  if (productId) {
    const p = q.get("SELECT offer, proof, description, profile FROM products WHERE id = ?", productId);
    if (p) parts.push(p.offer, p.proof, p.description, p.profile);
  }
  if (lead) parts.push(lead.reason, lead.notes, lead.custom);
  return parts.filter(Boolean).join("\n");
}

// Prüft Betreff + Text. context: { accountId, productId, lead, template } – template = freigegebene Vorlage (deren Zahlen gelten als belegt).
export function checkMessage({ subject = "", body = "" }, { accountId = null, productId = null, lead = null, template = "", threshold } = {}) {
  const text = `${subject}\n${body}`;
  const issues = [];
  let creepy = 0, quality = 100;
  for (const [re, label] of GENERIC) if (re.test(text)) { issues.push({ type: "generic", severity: "warn", text: label }); quality -= 10; }
  for (const [re, weight, label] of CREEPY) if (re.test(text)) { issues.push({ type: "creepy", severity: "block", text: label }); creepy += weight; }
  for (const [re, label] of ASSERTIVE) if (re.test(text)) { issues.push({ type: "assertive", severity: "warn", text: label }); quality -= 12; creepy += 10; }

  const evidence = evidenceText({ accountId, productId, lead, extra: template });
  const unsupported = numberClaims(text).filter(c => !evidence.includes(c.n));
  for (const c of unsupported.slice(0, 5)) issues.push({ type: "unsupported", severity: "warn", text: `Zahl ohne Beleg: „${c.raw}“` });
  quality -= Math.min(30, unsupported.length * 10);

  if (accountId) {
    const forbidden = [
      ...q.all("SELECT statement AS text FROM account_hypotheses WHERE account_id = ? AND status = 'rejected'", accountId).map(r => ({ ...r, kind: "widerlegte Annahme" })),
      ...q.all("SELECT text FROM account_memory WHERE account_id = ? AND kind IN ('do_not_claim','rejected_assumption')", accountId).map(r => ({ ...r, kind: "darf nicht behauptet werden" }))
    ];
    const have = new Set(words(text));
    for (const f of forbidden) {
      const key = [...new Set(words(f.text))];
      if (key.length < 2) continue;
      const hit = key.filter(w => have.has(w)).length;
      if (hit >= 2 && hit / key.length >= 0.6) { issues.push({ type: "forbidden", severity: "block", text: `Enthält ${f.kind}: „${f.text.slice(0, 120)}“` }); quality -= 25; creepy += 15; }
    }
  }

  const words_ = body.trim().split(/\s+/).filter(Boolean).length;
  if (words_ > 180) { issues.push({ type: "length", severity: "warn", text: `Lang (${words_} Wörter) – Cold Mails wirken mit 50–120 Wörtern am besten` }); quality -= 8; }
  const questions = (body.match(/\?/g) || []).length;
  if (questions > 3) { issues.push({ type: "cta", severity: "warn", text: `${questions} Fragen – besser genau eine klare Frage` }); quality -= 6; }

  creepy = Math.min(100, creepy);
  const limit = Number(threshold ?? getSettings().creepy_threshold) || 35;
  const blocked = creepy > limit || issues.some(i => i.type === "forbidden");
  return { quality: Math.max(0, Math.min(100, quality)), creepy_score: creepy, threshold: limit, ok: !blocked, issues };
}

// Kurze Rückmeldung für einen zweiten KI-Versuch.
export function qaFeedback(result) {
  return result.issues.filter(i => i.severity === "block" || i.type === "unsupported" || i.type === "assertive").map(i => `- ${i.text}`).join("\n");
}
