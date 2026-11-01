// Account Brain: alles, was wir über eine Firma wissen – an einer Stelle. Die KI bekommt nie einzelne Tabellen,
// sondern immer diese verdichtete Sicht („Was wissen wir aktuell über diesen Account?“).
import { q, parseJson } from "../db.js";
import { DAY_MS } from "../lib/time.js";
import { LIFECYCLE } from "./lifecycle.js";
import { getSettings } from "../settings.js";

const POSITIVE = ["interested", "meeting", "question"];
export const CALL_ATTEMPTS = "'meeting','interested','callback','no_answer','not_interested','wrong_number','do_not_contact'";
const TERMINAL = new Set(["suppressed", "won", "lost", "disqualified"]);

// Wie stark wurde die Firma zuletzt bearbeitet (gegen chaotisches Multithreading und Überkontakt)?
export function saturation(accountId, now = Date.now()) {
  const since = now - 14 * DAY_MS;
  const mails = q.all(`SELECT m.lead_id FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE l.account_id = ? AND m.direction = 'out' AND m.status != 'failed' AND m.created_at >= ?`, accountId, since);
  // Nur echte Anrufversuche zählen (nicht automatisch geschlossene Aufgaben).
  const calls = q.all(`SELECT t.lead_id, t.person_id, p.lead_id AS person_lead FROM tasks t LEFT JOIN account_people p ON p.id = t.person_id
    WHERE t.account_id = ? AND t.type IN ('call','call_sequence') AND t.outcome IN (${CALL_ATTEMPTS}) AND COALESCE(t.done_at, t.due_at) >= ?`, accountId, since);
  const touches = mails.length + calls.length;
  const who = new Set([...mails.map(m => `l${m.lead_id}`), ...calls.map(c => (c.lead_id || c.person_lead ? `l${c.lead_id || c.person_lead}` : `p${c.person_id || "x"}`))]);
  const people = who.size;
  const level = touches >= 5 || people >= 3 ? "high" : touches >= 3 || people >= 2 ? "medium" : touches ? "low" : "none";
  return {
    touches, people, level,
    recommendation: level === "high" ? "Keine weitere Ansprache für 7 Tage" : level === "medium" ? "Keine zusätzliche Person anschreiben, 4 Tage warten" : "",
    wait_until: level === "high" ? now + 7 * DAY_MS : level === "medium" ? now + 4 * DAY_MS : null
  };
}

function peopleOf(accountId) {
  return q.all(`SELECT p.*, l.status AS lead_status, l.consent_status, l.email AS lead_email FROM account_people p LEFT JOIN leads l ON l.id = p.lead_id
    WHERE p.account_id = ? ORDER BY CASE p.committee_role WHEN 'economic_buyer' THEN 0 WHEN 'champion' THEN 1 WHEN 'user' THEN 2 WHEN 'technical' THEN 3 ELSE 4 END, p.id`, accountId);
}

function pickEntry(people, strategy) {
  const usable = people.filter(p => !p.do_not_contact && p.committee_role !== "do_not_contact" && p.lead_status !== "unsubscribed" && p.consent_status !== "revoked");
  const want = String(strategy.primary_entry || "").toLowerCase();
  const byStrategy = want ? usable.find(p => [p.role, p.committee_role, p.name].some(x => x && (String(x).toLowerCase().includes(want) || want.includes(String(x).toLowerCase())))) : null;
  return byStrategy || usable.find(p => p.phone) || usable[0] || null;
}

export function nextBestAction(account, { people = peopleOf(account.id), now = Date.now() } = {}) {
  const name = account.name || account.domain;
  if (TERMINAL.has(account.lifecycle)) return { type: "none", label: "Keine Aktion", reason: `Status „${LIFECYCLE[account.lifecycle]}“` };
  const sla = Number(getSettings().reply_sla_minutes) || 30;
  const pending = q.get(`SELECT c.id, c.last_inbound_at, c.label, l.first_name, l.last_name FROM conversations c JOIN leads l ON l.id = c.lead_id
    WHERE l.account_id = ? AND c.label IN ('interested','meeting','question') AND c.status != 'done'
    AND (SELECT direction FROM messages WHERE conversation_id = c.id AND kind != 'auto_reply' ORDER BY created_at DESC, id DESC LIMIT 1) = 'in'
    ORDER BY c.last_inbound_at LIMIT 1`, account.id);
  if (pending) {
    const minutes = Math.round((now - pending.last_inbound_at) / 60000);
    return { type: "reply", label: "Jetzt antworten", conversation_id: pending.id, reason: `Positive Antwort von ${[pending.first_name, pending.last_name].filter(Boolean).join(" ")} seit ${minutes} Min.${minutes > sla ? ` – Ziel < ${sla} Min.` : ""}`, priority: 1000 + minutes, overdue: minutes > sla };
  }
  const prep = q.get("SELECT id, title, meeting_at FROM opportunities WHERE account_id = ? AND stage = 'meeting' AND prep IS NULL AND meeting_at IS NOT NULL AND meeting_at BETWEEN ? AND ? ORDER BY meeting_at LIMIT 1", account.id, now - 2 * 3600 * 1000, now + 2 * DAY_MS);
  if (prep) return { type: "prep", label: "Termin vorbereiten", opportunity_id: prep.id, reason: `Termin ${new Date(prep.meeting_at).toLocaleString("de-DE")} ohne Briefing`, priority: 700 };
  const proposal = q.get("SELECT id, title FROM opportunities WHERE account_id = ? AND stage = 'proposal' AND (next_step_at <= ? OR (next_step_at IS NULL AND updated_at < ?)) LIMIT 1", account.id, now, now - 7 * DAY_MS);
  if (proposal) return { type: "proposal", label: "Angebot nachfassen", opportunity_id: proposal.id, reason: "Angebot ohne Reaktion bzw. Termin für den nächsten Schritt erreicht", priority: 450 };
  const task = q.get("SELECT id, title, type FROM tasks WHERE account_id = ? AND status = 'open' AND due_at <= ? ORDER BY priority DESC, due_at LIMIT 1", account.id, now + 12 * 3600 * 1000);
  if (task) return { type: "task", label: task.title, task_id: task.id, reason: "Fällige Aufgabe", priority: 500 };
  if (!account.researched_at) return { type: "research", label: "Firma recherchieren", reason: "Noch kein Profil – Website lesen, Anlässe und Ansprechpartner finden", priority: 100 };
  const sat = saturation(account.id, now);
  if (sat.level === "high" || (sat.level === "medium" && ["contacted", "engaged"].includes(account.lifecycle))) {
    return { type: "wait", label: "Pause", reason: `${sat.touches} Kontakte in 14 Tagen (${sat.people} Personen) – ${sat.recommendation}`, priority: 0, until: sat.wait_until };
  }
  if (["watching", "not_now", "no_response"].includes(account.lifecycle)) {
    return { type: "watch", label: "Beobachten", reason: account.next_check_at ? `Nächste Prüfung auf neue Anlässe am ${new Date(account.next_check_at).toLocaleDateString("de-DE")}` : "Auf neuen Anlass warten", priority: 0 };
  }
  if (["contacted", "engaged"].includes(account.lifecycle)) return { type: "wait", label: "Auf Antwort warten", reason: "Sequenz bzw. Nachfassen läuft", priority: 0 };
  if (["meeting", "opportunity", "proposal"].includes(account.lifecycle)) return { type: "wait", label: "Chance läuft", reason: "Nächster Schritt steht in der Pipeline", priority: 0 };
  if (["qualified", "triggered", "outreach_ready", "researched"].includes(account.lifecycle)) {
    const strategy = parseJson(account.strategy, {}) || {};
    const entry = pickEntry(people, strategy);
    const play = parseJson(account.suggested_play, {}) || {};
    const scoreBoost = (account.opportunity_score || 0) + (account.lifecycle === "triggered" ? 200 : 0);
    if (!entry) return { type: "find_contact", label: "Ansprechpartner ermitteln", reason: strategy.primary_entry ? `Gesucht: ${strategy.primary_entry} – „Geschäftsführer suchen“ liest das Impressum` : "Kein Ansprechpartner bekannt – „Geschäftsführer suchen“ liest das Impressum", priority: 150 + scoreBoost };
    // Nur Cold Mailing: Die nächste Aktion ist immer eine Mail-Kampagne (telefoniert wird in der Sales App).
    return {
      type: "email", label: `${entry.name || entry.role} per Cold Mail ansprechen`,
      person_id: entry.id, phone: entry.phone || "", reason: [account.why_now, play.angle ? `Angle: ${play.angle}` : ""].filter(Boolean).join(" · ") || `Opportunity ${account.opportunity_score ?? "–"}`,
      priority: 300 + scoreBoost, goal: play.cta || ""
    };
  }
  return { type: "research", label: "Profil vervollständigen", reason: "Status unklar", priority: 50 };
}

function timeline(accountId, limit = 15) {
  const msgs = q.all(`SELECT m.created_at AS at, m.direction, m.kind, m.subject, l.first_name, l.last_name FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE l.account_id = ? AND m.status != 'failed' ORDER BY m.created_at DESC LIMIT ?`, accountId, limit);
  const calls = q.all("SELECT done_at AS at, type, title, outcome FROM tasks WHERE account_id = ? AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT ?", accountId, limit);
  return [
    ...msgs.map(m => ({ at: m.at, kind: m.direction === "in" ? "reply" : m.kind, text: `${m.direction === "in" ? "Antwort von" : m.kind === "nurture" ? "Nachfassen an" : "Mail an"} ${[m.first_name, m.last_name].filter(Boolean).join(" ")}: ${m.subject || ""}` })),
    ...calls.map(c => ({ at: c.at, kind: c.type, text: `${c.title}${c.outcome ? ` → ${c.outcome}` : ""}` }))
  ].sort((a, b) => b.at - a.at).slice(0, limit);
}

export function accountBrain(accountId) {
  const account = q.get(`SELECT a.*, p.name AS project_name, pr.name AS product_name, u.name AS owner_name FROM accounts a
    LEFT JOIN projects p ON p.id = a.project_id LEFT JOIN products pr ON pr.id = a.product_id LEFT JOIN users u ON u.id = a.owner_id WHERE a.id = ?`, accountId);
  if (!account) return null;
  const people = peopleOf(accountId);
  const facts = q.all("SELECT * FROM account_facts WHERE account_id = ? AND status = 'active' ORDER BY type = 'verified' DESC, confidence DESC, id", accountId);
  const signals = q.all("SELECT * FROM account_signals WHERE account_id = ? AND status = 'active' ORDER BY strength DESC, observed_at DESC", accountId);
  const hypotheses = q.all("SELECT * FROM account_hypotheses WHERE account_id = ? ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'open' THEN 1 ELSE 2 END, rank, confidence DESC", accountId)
    .map(h => ({ ...h, evidence: parseJson(h.evidence, {}) || {} }));
  const memory = q.all("SELECT m.*, u.name AS user_name FROM account_memory m LEFT JOIN users u ON u.id = m.user_id WHERE m.account_id = ? ORDER BY m.id DESC LIMIT 100", accountId);
  const play = account.play_id ? q.get("SELECT * FROM plays WHERE id = ?", account.play_id) : null;
  const opportunities = q.all("SELECT id, title, stage, value_eur, probability, meeting_at, created_at, closed_at FROM opportunities WHERE account_id = ? ORDER BY created_at DESC", accountId);
  const leads = q.all("SELECT id, email, first_name, last_name, position, status, consent_status FROM leads WHERE account_id = ? ORDER BY id", accountId);
  return {
    account: { ...account, score_reasons: parseJson(account.score_reasons, {}) || {}, strategy: parseJson(account.strategy, {}) || {}, suggested_play: parseJson(account.suggested_play, {}) || {}, lifecycle_label: LIFECYCLE[account.lifecycle] },
    scores: { fit: account.fit_score, pain: account.pain_score, timing: account.timing_score, contactability: account.contactability_score, opportunity: account.opportunity_score },
    facts, signals, hypotheses, people, leads, memory, play, opportunities,
    timeline: timeline(accountId), saturation: saturation(accountId), next_action: nextBestAction(account, { people })
  };
}

// Verdichteter Text für KI-Prompts (Personalisierung, Antwortentwürfe, Termin-Briefing …).
export function brainText(accountId, { maxChars = 6000 } = {}) {
  const b = accountId ? accountBrain(accountId) : null;
  if (!b) return "";
  const a = b.account;
  const pct = n => (n === null || n === undefined ? "–" : `${n}`);
  const lines = [
    `# Account Brain: ${a.name || a.domain}${a.domain ? ` (${a.domain})` : ""}`,
    `Status: ${a.lifecycle_label}${a.industry ? ` · Branche: ${a.industry}` : ""}${a.city ? ` · ${a.city}` : ""}${a.employees ? ` · Mitarbeitende: ${a.employees}` : ""}`,
    `Scores: Fit ${pct(b.scores.fit)} · Pain ${pct(b.scores.pain)} · Timing ${pct(b.scores.timing)} · Erreichbarkeit ${pct(b.scores.contactability)} · Opportunity ${pct(b.scores.opportunity)}`,
    a.summary ? `Kurzprofil: ${a.summary}` : "",
    b.facts.length ? `\n## Fakten (nur diese dürfen als Tatsache genannt werden)\n${b.facts.slice(0, 15).map(f => `- ${f.statement} [${f.type === "verified" ? "verifiziert" : "Schätzung"}, ${f.confidence} %, Quelle: ${f.source_type}]`).join("\n")}` : "",
    b.signals.length ? `\n## Aktuelle Anlässe\n${b.signals.slice(0, 6).map(s => `- ${s.title}${s.detail ? ` – ${s.detail}` : ""} (${s.confidence} %)`).join("\n")}` : "",
    a.why_now ? `\n## Why now (Interpretation, nicht als Tatsache formulieren)\n${a.why_now}` : "",
    b.hypotheses.filter(h => h.status !== "rejected").length ? `\n## Hypothesen\n${b.hypotheses.filter(h => h.status !== "rejected").slice(0, 6).map(h => `- [${h.status === "confirmed" ? "BESTÄTIGT" : `Vermutung ${h.confidence} %`}] ${h.statement}`).join("\n")}` : "",
    b.people.length ? `\n## Personen\n${b.people.slice(0, 8).map(p => `- ${p.name || "(ohne Namen)"}${p.role ? `, ${p.role}` : ""}${p.committee_role ? ` – ${p.committee_role}` : ""}${p.do_not_contact ? " – NICHT KONTAKTIEREN" : ""}`).join("\n")}` : "",
    b.play ? `\n## Aktueller Play\nPersona: ${b.play.persona} · Pain: ${b.play.pain} · Angle: ${b.play.angle} · Beleg: ${b.play.proof} · CTA: ${b.play.cta}` : "",
    b.memory.length ? `\n## Gedächtnis\n${b.memory.slice(0, 15).map(m => `- [${m.kind === "do_not_claim" ? "NICHT BEHAUPTEN" : m.kind === "rejected_assumption" ? "WIDERLEGT" : m.kind}] ${m.text}`).join("\n")}` : "",
    b.hypotheses.filter(h => h.status === "rejected").length ? `\n## Widerlegte Annahmen (nie wieder verwenden)\n${b.hypotheses.filter(h => h.status === "rejected").map(h => `- ${h.statement}`).join("\n")}` : ""
  ].filter(Boolean).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n[…gekürzt]` : lines;
}
