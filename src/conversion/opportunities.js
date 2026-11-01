// Verkaufschancen (Conversion Engine): Termin → qualifizierte Chance → Angebot → gewonnen/verloren.
// Bei jeder Chance wird festgehalten, was zum Erfolg geführt hat (Anlass, Pain, Persona, Kanal, Play, Beleg) –
// Grundlage für das Lernen bis zum Umsatz statt bis zur Antwortquote.
import { q, insert, update, parseJson } from "../db.js";
import { recordEvent, emitWebhook } from "../events.js";
import { advance, setLifecycle } from "../intel/lifecycle.js";
import { DAY_MS } from "../lib/time.js";
import { CALL_ATTEMPTS } from "../intel/brain.js";

export const STAGES = { meeting: "Termin", qualified: "Qualifiziert", proposal: "Angebot", won: "Gewonnen", lost: "Verloren" };
export const QUALITY_KEYS = { pain_confirmed: "Pain bestätigt", authority: "Entscheidungsbefugnis", need: "Bedarf", timing: "Zeitpunkt", technical_fit: "Technische Passung", commercial_fit: "Kaufmännische Passung" };
export const LOSS_REASONS = { no_urgency: "Keine Dringlichkeit", too_expensive: "Zu teuer", competitor: "Wettbewerber", existing_system: "Bestehendes System/Projekt", no_budget: "Kein Budget", no_decision: "Keine Entscheidung", not_fit: "Passt fachlich nicht", ghosted: "Keine Rückmeldung mehr", other: "Sonstiges" };

export function qualityOverall(quality) {
  const vals = Object.keys(QUALITY_KEYS).map(k => Number(quality?.[k])).filter(n => Number.isFinite(n));
  return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

// Wahrscheinlichkeit je Phase, bei qualifizierten Chancen abhängig von der Gesprächsqualität.
export function defaultProbability(stage, quality) {
  const overall = qualityOverall(quality);
  switch (stage) {
    case "meeting": return 10;
    case "qualified": return overall === null ? 30 : Math.round(20 + overall * 0.3);
    case "proposal": return overall === null ? 50 : Math.round(40 + overall * 0.4);
    case "won": return 100;
    default: return 0;
  }
}

export function weightedValue(opp) {
  if (!opp.value_eur) return 0;
  const p = opp.probability ?? defaultProbability(opp.stage, parseJson(opp.quality, {}));
  return Math.round(opp.value_eur * p / 100);
}

// Was hat zur Chance geführt? (erste Berührung, Anlass, erste Hypothese, Persona, Kanal, Play)
export function attributionSnapshot(accountId, leadId = null) {
  const account = q.get("SELECT * FROM accounts WHERE id = ?", accountId) || {};
  const firstMail = q.get(`SELECT m.created_at, m.campaign_id, m.lead_id FROM messages m JOIN leads l ON l.id = m.lead_id
    WHERE l.account_id = ? AND m.direction = 'out' AND m.status != 'failed' ORDER BY m.created_at LIMIT 1`, accountId);
  const firstCall = q.get(`SELECT done_at AS created_at, person_id, lead_id FROM tasks WHERE account_id = ? AND type IN ('call','call_sequence')
    AND status = 'done' AND outcome IN (${CALL_ATTEMPTS}) AND done_at IS NOT NULL ORDER BY done_at LIMIT 1`, accountId);
  const first = [firstMail && { ...firstMail, channel: "email" }, firstCall && { ...firstCall, channel: "call" }].filter(Boolean).sort((a, b) => a.created_at - b.created_at)[0] || null;
  const personOf = id => (id ? q.get("SELECT first_name, last_name, position FROM leads WHERE id = ?", id) : null);
  const firstLead = personOf(first?.lead_id);
  const trigger = q.get("SELECT title, type FROM account_signals WHERE account_id = ? AND first_seen_at <= COALESCE(?, first_seen_at) ORDER BY strength DESC LIMIT 1", accountId, first?.created_at ?? null)
    || q.get("SELECT title, type FROM account_signals WHERE account_id = ? ORDER BY strength DESC LIMIT 1", accountId);
  const pain = q.get("SELECT statement FROM account_hypotheses WHERE account_id = ? AND kind = 'pain' AND status != 'rejected' ORDER BY rank, confidence DESC LIMIT 1", accountId);
  const campaign = first?.campaign_id ? q.get("SELECT id, name, play_id FROM campaigns WHERE id = ?", first.campaign_id) : null;
  const playId = campaign?.play_id || account.play_id || null;
  const play = playId ? q.get("SELECT * FROM plays WHERE id = ?", playId) : null;
  const contact = personOf(leadId);
  return {
    first_touch_at: first?.created_at || null,
    first_channel: first?.channel || null,
    first_persona: firstLead?.position || null,
    meeting_persona: contact?.position || null,
    trigger: trigger?.title || null, trigger_type: trigger?.type || null,
    initial_pain: pain?.statement || null,
    play_id: play?.id || null, angle: play?.angle || (parseJson(account.suggested_play, {}) || {}).angle || null, proof: play?.proof || null,
    campaign_id: campaign?.id || null, industry: account.industry || null,
    scores_at_start: { fit: account.fit_score, pain: account.pain_score, timing: account.timing_score, contactability: account.contactability_score, opportunity: account.opportunity_score }
  };
}

export function createOpportunity({ accountId, leadId = null, personId = null, title, stage = "meeting", meetingAt = null, valueEur = null, ownerId = null, campaignId = null }) {
  const account = q.get("SELECT * FROM accounts WHERE id = ?", accountId);
  if (!account) throw new Error("Firma nicht gefunden");
  const attribution = attributionSnapshot(accountId, leadId);
  const now = Date.now();
  const id = insert("opportunities", {
    account_id: accountId, project_id: account.project_id, product_id: account.product_id, play_id: attribution.play_id, campaign_id: campaignId || attribution.campaign_id,
    lead_id: leadId, person_id: personId, title: title || `${account.name || account.domain} – Erstgespräch`, stage, value_eur: valueEur, probability: defaultProbability(stage, {}),
    meeting_at: meetingAt, attribution: JSON.stringify(attribution), owner_id: ownerId || account.owner_id, created_at: now, updated_at: now
  });
  recordEvent("opportunity", { campaign_id: attribution.campaign_id, lead_id: leadId, data: { account_id: accountId, opportunity_id: id, stage } });
  return id;
}

// Termin gebucht → offene Chance verwenden oder neu anlegen.
export function ensureOpportunityForMeeting({ accountId, leadId = null, meetingAt = null, source = "" }) {
  const open = q.get("SELECT * FROM opportunities WHERE account_id = ? AND stage IN ('meeting','qualified','proposal') ORDER BY id DESC LIMIT 1", accountId);
  if (open) {
    if (meetingAt && open.stage === "meeting") update("opportunities", open.id, { meeting_at: meetingAt, updated_at: Date.now() });
    return open.id;
  }
  const campaignId = leadId ? q.value("SELECT campaign_id FROM conversations WHERE lead_id = ? AND campaign_id IS NOT NULL ORDER BY last_at DESC LIMIT 1", leadId) : null;
  return createOpportunity({ accountId, leadId, meetingAt, campaignId, stage: "meeting" });
}

const STAGE_TO_LIFECYCLE = { meeting: "meeting", qualified: "opportunity", proposal: "proposal" };

export function setStage(oppId, stage, { valueEur, lost = null, winning = null } = {}) {
  const opp = q.get("SELECT * FROM opportunities WHERE id = ?", oppId);
  if (!opp) throw new Error("Chance nicht gefunden");
  if (!STAGES[stage]) throw new Error("Unbekannte Phase");
  const now = Date.now();
  const patch = { stage, updated_at: now, probability: defaultProbability(stage, parseJson(opp.quality, {})) };
  if (valueEur !== undefined && valueEur !== null) patch.value_eur = valueEur;
  if (stage === "won" || stage === "lost") {
    patch.closed_at = now;
    const attribution = parseJson(opp.attribution, {}) || {};
    const confirmed = q.all("SELECT statement FROM account_hypotheses WHERE account_id = ? AND kind = 'pain' AND status = 'confirmed'", opp.account_id).map(h => h.statement);
    Object.assign(attribution, {
      confirmed_pains: confirmed,
      sales_cycle_days: attribution.first_touch_at ? Math.max(0, Math.round((now - attribution.first_touch_at) / DAY_MS)) : null,
      ...(winning || {})
    });
    patch.attribution = JSON.stringify(attribution);
    if (stage === "lost") patch.loss = JSON.stringify(lost || {});
  }
  update("opportunities", oppId, patch);
  if (stage === "won") {
    setLifecycle(opp.account_id, "won", { reason: opp.title, by: "user" });
    recordEvent("won", { campaign_id: opp.campaign_id, lead_id: opp.lead_id, data: { account_id: opp.account_id, opportunity_id: oppId, value: patch.value_eur ?? opp.value_eur } });
    emitWebhook("opportunity.won", { opportunity_id: oppId, account_id: opp.account_id, value_eur: patch.value_eur ?? opp.value_eur });
  } else if (stage === "lost") {
    if (!q.get("SELECT 1 FROM opportunities WHERE account_id = ? AND id != ? AND stage IN ('meeting','qualified','proposal')", opp.account_id, oppId)) setLifecycle(opp.account_id, "lost", { reason: (lost && lost.primary) || "", by: "user" });
    recordEvent("lost", { campaign_id: opp.campaign_id, lead_id: opp.lead_id, data: { account_id: opp.account_id, opportunity_id: oppId, reason: lost?.primary || "" } });
    if (lost?.learning) q.run("INSERT INTO account_memory (account_id, kind, text, source, created_at) VALUES (?, 'note', ?, 'user', ?)", opp.account_id, `Verloren – Erkenntnis: ${lost.learning}`, now);
  } else if (STAGE_TO_LIFECYCLE[stage]) {
    advance(opp.account_id, STAGE_TO_LIFECYCLE[stage], `Chance: ${STAGES[stage]}`, { allowFromSide: ["lost"] });
  }
  return q.get("SELECT * FROM opportunities WHERE id = ?", oppId);
}
