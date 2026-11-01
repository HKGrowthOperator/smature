// Termin-Briefing, Gesprächsauswertung (Discovery) und Verlust-Analyse – jeweils eine KI-Anfrage auf Basis des Account Brains.
import { q, update, insert, parseJson } from "../db.js";
import { callJson, AiError } from "../ai/claude.js";
import { brainText } from "../intel/brain.js";
import { getSettings } from "../settings.js";
import { QUALITY_KEYS, LOSS_REASONS, defaultProbability } from "./opportunities.js";

function oppContext(opp) {
  const product = opp.product_id ? q.get("SELECT name, description, offer, proof, profile FROM products WHERE id = ?", opp.product_id) : null;
  const s = getSettings();
  return [
    `# Wir\n${s.company_name || ""}\n${s.sender_context || ""}`.trim(),
    product ? `# Produkt: ${product.name}\n${product.description || ""}\n${product.offer || ""}\nBelege: ${product.proof || "(keine)"}\n${product.profile ? product.profile.slice(0, 4000) : ""}` : "",
    brainText(opp.account_id, { maxChars: 8000 })
  ].filter(Boolean).join("\n\n");
}

// Schmerz-Leitfaden fürs Erstgespräch (Bogen aus dem Coaching, in Sie-Form und auf uns zugeschnitten). Wird im Briefing
// von der KI auf die Firma angepasst und steht auf jeder Chance auch ohne KI zur Verfügung.
export const PAIN_GUIDE = [
  { step: "Situation", question: "Was ist im Moment Ihre größte Herausforderung, wenn es um [Thema/Anlass] geht?" },
  { step: "Warum", question: "Was genau stört Sie daran – und warum gerade das?" },
  { step: "Auswirkung", question: "Was kostet Sie das heute, in Zeit, Geld oder entgangenen Aufträgen? Was passiert, wenn sich in den nächsten 12 Monaten nichts ändert?" },
  { step: "Heute", question: "Wie gehen Sie das aktuell an – wie laufen Vertrieb und Marketing bei Ihnen heute konkret?" },
  { step: "Bisher", question: "Was haben Sie schon ausprobiert (Agentur, Berater, eigene Versuche) – und was hat Sie bisher davon abgehalten, es selbst zu lösen?" },
  { step: "Warum jetzt", question: "Warum ist das gerade jetzt ein Thema – und warum nicht einfach weitermachen wie bisher?" }
];

export async function meetingBrief(oppId) {
  const opp = q.get("SELECT * FROM opportunities WHERE id = ?", oppId);
  if (!opp) throw new AiError("Chance nicht gefunden");
  const contact = opp.lead_id ? q.get("SELECT first_name, last_name, position FROM leads WHERE id = ?", opp.lead_id) : null;
  const result = await callJson({
    system: ["Du bereitest Vertriebsgespräche im B2B-Mittelstand vor. Kurz, konkret, ehrlich. Trenne Wissen von Vermutungen. Nichts erfinden.", oppContext(opp)],
    content: `Erstelle ein 5-Minuten-Briefing für den Termin${contact ? ` mit ${[contact.first_name, contact.last_name].filter(Boolean).join(" ")}${contact.position ? ` (${contact.position})` : ""}` : ""}.
- known_facts: was wir sicher wissen (nur Fakten aus dem Account Brain)
- hypotheses: was wir vermuten und im Gespräch prüfen wollen
- do_not_assume: was wir NICHT unterstellen dürfen (unbekannt oder widerlegt)
- questions: genau 6 offene Fragen entlang dieses Bogens, auf genau diese Firma und ihre Hypothesen zugeschnitten und maximal konkret (keine Ja/Nein-Fragen): ${PAIN_GUIDE.map(g => g.step).join(" → ")}. Vorlage: ${PAIN_GUIDE.map(g => `„${g.question}“`).join(" ")}
- goal: Ziel des Termins (ein Satz) und next_step: gewünschter nächster Schritt
- risks: mögliche Einwände/Risiken`,
    schema: {
      type: "object",
      properties: {
        known_facts: { type: "array", items: { type: "string" } }, hypotheses: { type: "array", items: { type: "string" } }, do_not_assume: { type: "array", items: { type: "string" } },
        questions: { type: "array", items: { type: "string" } }, goal: { type: "string" }, next_step: { type: "string" }, risks: { type: "array", items: { type: "string" } }
      },
      required: ["known_facts", "hypotheses", "do_not_assume", "questions", "goal", "next_step", "risks"], additionalProperties: false
    },
    maxTokens: 4000, effort: "medium"
  });
  result.questions = (result.questions || []).slice(0, 6);
  result.created_at = Date.now();
  update("opportunities", oppId, { prep: JSON.stringify(result), updated_at: Date.now() });
  return result;
}

// Gesprächsnotizen → bestätigte Pains, Systeme, Entscheidungsweg, Timing, Einwände, Qualität. Aktualisiert Hypothesen und Gedächtnis.
export async function captureDiscovery(oppId, notes, { userId = null } = {}) {
  const opp = q.get("SELECT * FROM opportunities WHERE id = ?", oppId);
  if (!opp) throw new AiError("Chance nicht gefunden");
  if (!String(notes || "").trim()) throw new AiError("Bitte Gesprächsnotizen eintragen");
  const hyps = q.all("SELECT id, statement, status FROM account_hypotheses WHERE account_id = ? AND status != 'rejected' ORDER BY rank", opp.account_id);
  const result = await callJson({
    system: ["Du wertest Vertriebsgespräche aus. Übernimm nur, was in den Notizen steht. Vermutungen bleiben Vermutungen.", oppContext(opp)],
    content: `# Offene Hypothesen (id: Aussage)\n${hyps.map(h => `${h.id}: ${h.statement}`).join("\n") || "(keine)"}\n\n# Gesprächsnotizen\n${String(notes).slice(0, 20000)}\n\nWerte aus:
- confirmed_pains: im Gespräch bestätigte Probleme mit severity (high/medium/low) und hypothesis_id (passende id aus der Liste oder 0)
- rejected_hypotheses: ids der Hypothesen, die das Gespräch widerlegt hat
- systems: genannte Systeme/Werkzeuge (z. B. ERP, Excel, Outlook)
- decision_process, timing, budget, next_step: kurz, „unbekannt“ wenn nicht genannt
- objections: Einwände mit type (existing_system, too_expensive, no_time, no_need, no_budget, other) und statement
- quality: je 0–100: ${Object.entries(QUALITY_KEYS).map(([k, v]) => `${k} (${v})`).join(", ")}
- do_not_claim: Dinge, die wir künftig nicht behaupten sollten (z. B. falsche Annahmen)`,
    schema: {
      type: "object",
      properties: {
        confirmed_pains: { type: "array", items: { type: "object", properties: { statement: { type: "string" }, severity: { type: "string", enum: ["high", "medium", "low"] }, hypothesis_id: { type: "number" } }, required: ["statement", "severity", "hypothesis_id"], additionalProperties: false } },
        rejected_hypotheses: { type: "array", items: { type: "number" } },
        systems: { type: "array", items: { type: "string" } },
        decision_process: { type: "string" }, timing: { type: "string" }, budget: { type: "string" }, next_step: { type: "string" },
        objections: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["existing_system", "too_expensive", "no_time", "no_need", "no_budget", "other"] }, statement: { type: "string" } }, required: ["type", "statement"], additionalProperties: false } },
        quality: { type: "object", properties: Object.fromEntries(Object.keys(QUALITY_KEYS).map(k => [k, { type: "number" }])), required: Object.keys(QUALITY_KEYS), additionalProperties: false },
        do_not_claim: { type: "array", items: { type: "string" } }
      },
      required: ["confirmed_pains", "rejected_hypotheses", "systems", "decision_process", "timing", "budget", "next_step", "objections", "quality", "do_not_claim"], additionalProperties: false
    },
    maxTokens: 5000, effort: "medium"
  });
  applyDiscovery(opp, result, notes, { userId });
  return result;
}

export function applyDiscovery(opp, result, notes = "", { userId = null } = {}) {
  const now = Date.now();
  const valid = new Set(q.all("SELECT id FROM account_hypotheses WHERE account_id = ?", opp.account_id).map(h => h.id));
  for (const p of result.confirmed_pains || []) {
    if (p.hypothesis_id && valid.has(p.hypothesis_id)) q.run("UPDATE account_hypotheses SET status = 'confirmed', resolved_note = ?, resolved_at = ?, updated_at = ? WHERE id = ?", `Im Gespräch bestätigt (${p.severity})`, now, now, p.hypothesis_id);
    else insert("account_hypotheses", { account_id: opp.account_id, kind: "pain", statement: p.statement, interpretation: `Im Gespräch genannt (${p.severity})`, confidence: 100, evidence: "{}", status: "confirmed", created_by: "meeting", resolved_at: now, created_at: now, updated_at: now });
  }
  for (const id of result.rejected_hypotheses || []) {
    if (!valid.has(id)) continue;
    q.run("UPDATE account_hypotheses SET status = 'rejected', resolved_note = 'Im Gespräch widerlegt', resolved_at = ?, updated_at = ? WHERE id = ?", now, now, id);
    const h = q.get("SELECT statement FROM account_hypotheses WHERE id = ?", id);
    q.run("INSERT INTO account_memory (account_id, kind, text, source, user_id, created_at) VALUES (?, 'rejected_assumption', ?, 'meeting', ?, ?)", opp.account_id, h.statement, userId, now);
  }
  const memo = (kind, text) => { if (text && !/^unbekannt$/i.test(String(text).trim())) q.run("INSERT INTO account_memory (account_id, kind, text, source, user_id, created_at) VALUES (?, ?, ?, 'meeting', ?, ?)", opp.account_id, kind, String(text).slice(0, 1000), userId, now); };
  for (const sys of result.systems || []) memo("system", sys);
  memo("timing", result.timing);
  memo("next_step", result.next_step);
  for (const o of result.objections || []) q.run("INSERT INTO account_memory (account_id, kind, text, source, meta, user_id, created_at) VALUES (?, 'objection', ?, 'meeting', ?, ?, ?)", opp.account_id, o.statement, JSON.stringify({ type: o.type }), userId, now);
  for (const d of result.do_not_claim || []) memo("do_not_claim", d);
  const quality = Object.fromEntries(Object.keys(QUALITY_KEYS).map(k => [k, Math.max(0, Math.min(100, Math.round(Number(result.quality?.[k]) || 0)))]));
  update("opportunities", opp.id, {
    discovery: JSON.stringify({ ...result, notes: String(notes).slice(0, 20000), created_at: now }), quality: JSON.stringify(quality),
    next_step: result.next_step && !/^unbekannt$/i.test(result.next_step) ? result.next_step : opp.next_step,
    probability: defaultProbability(opp.stage === "meeting" ? "qualified" : opp.stage, quality), updated_at: now
  });
}

// Verlust verstehen: Hauptgrund, Nebengrund, eigentliche Ursache, hätte man es früher sehen können, Lernregel.
export async function analyzeLoss(oppId, notes = "") {
  const opp = q.get("SELECT * FROM opportunities WHERE id = ?", oppId);
  if (!opp) throw new AiError("Chance nicht gefunden");
  const disc = parseJson(opp.discovery, null);
  return callJson({
    system: ["Du analysierst verlorene B2B-Verkaufschancen ehrlich und ohne Schönfärberei, damit die Lead-Auswahl besser wird.", oppContext(opp)],
    content: `${disc ? `# Gesprächsauswertung\n${JSON.stringify({ ...disc, notes: undefined }).slice(0, 6000)}\n` : ""}# Notizen zum Verlust\n${String(notes || "(keine)").slice(0, 6000)}\n\nBestimme primary und secondary (je einer von: ${Object.keys(LOSS_REASONS).join(", ")}), underlying (eigentliche Ursache in einem Satz), detectable_earlier (ja/nein), signal (welches Signal hätte es früher gezeigt, sonst leer) und learning (eine konkrete Regel für künftige Bewertung).`,
    schema: {
      type: "object",
      properties: {
        primary: { type: "string", enum: Object.keys(LOSS_REASONS) }, secondary: { type: "string", enum: Object.keys(LOSS_REASONS) }, underlying: { type: "string" },
        detectable_earlier: { type: "boolean" }, signal: { type: "string" }, learning: { type: "string" }
      },
      required: ["primary", "secondary", "underlying", "detectable_earlier", "signal", "learning"], additionalProperties: false
    },
    maxTokens: 2000, effort: "medium"
  });
}
