// Nachfassen und Anrufliste:
//  • Interesse gezeigt, danach Funkstille → nach X Tagen freundlich nachhaken (nur freigegebene Texte, im selben Thread),
//    oder einen Entwurf zur Prüfung anlegen. Nach dem letzten Nachfassen: Anruf-Aufgabe.
//  • Aufgaben aus Antworten (antworten, anrufen, später melden) und Sperrfristen bei „kein Interesse“.
//  • Termin gebucht (Buchungs-Webhook oder Klick) → alles stoppen, Ereignis + Webhook.
import { q, tx, insert } from "../db.js";
import { DAY_MS, inWindow } from "../lib/time.js";
import { buildVars, render, productVars } from "../lib/template.js";
import { token as newToken, randomBetween } from "../crypto.js";
import { getSettings } from "../settings.js";
import { setLabelHook, LABELS, onLabel } from "../ai/features.js";
import { setInboundHandler } from "../mail/inbound.js";
import { composeMail, newMessageId, unsubscribeUrl, targetLanguage, loadSteps } from "../mail/compose.js";
import { buildRaw, sendRaw, describeSmtpError, classifySmtpError } from "../mail/transport.js";
import { recordMailboxError, recordMailboxSuccess } from "../mail/mailboxes.js";
import { appendToSent } from "../mail/imap.js";
import { addMessage, isBlocked } from "./conversations.js";
import { approvalState, nurtureTexts, accountBlock } from "./rules.js";
import { recordEvent, emitWebhook, leadPayload } from "../events.js";
import { advance, sideState, setLifecycle } from "../intel/lifecycle.js";
import { ensureOpportunityForMeeting } from "../conversion/opportunities.js";

export const TASK_TYPES = {
  call: "Anrufen (Interesse)",
  call_sequence: "Anrufen (nach Sequenz)",
  reply: "Antworten",
  nurture_draft: "Nachfassen (Entwurf prüfen)",
  recontact: "Später wieder melden",
  todo: "Aufgabe"
};

export const CALL_OUTCOMES = {
  meeting: "Termin vereinbart",
  interested: "Interesse – Infos senden",
  callback: "Rückruf vereinbart",
  no_answer: "Nicht erreicht",
  not_interested: "Kein Interesse",
  wrong_number: "Falsche Nummer",
  do_not_contact: "Kein Kontakt mehr gewünscht",
  done: "Erledigt"
};

const NURTURE_LABELS = ["interested", "meeting", "question"];
const DEFAULTS = { nurture_enabled: 1, nurture_days: 3, nurture_max: 2, nurture_mode: "draft", call_on_interest: 1 };

const leadName = lead => [lead?.first_name, lead?.last_name].filter(Boolean).join(" ") || lead?.email || "Lead";
const leadLabel = lead => `${leadName(lead)}${lead?.company ? ` (${lead.company})` : ""}`;

function campaignOf(conv) {
  return conv?.campaign_id ? q.get("SELECT * FROM campaigns WHERE id = ?", conv.campaign_id) : null;
}

function settingsFor(campaign) {
  return campaign ? { ...DEFAULTS, ...campaign } : DEFAULTS;
}

// ---------- Aufgaben ----------

// Diese App macht ausschließlich Cold Mailing – telefoniert wird in der eigenen Sales App. Anruf-Aufgaben entstehen nicht mehr;
// die Nummern bleiben am Lead (Export „Warm“ → Sales App).
export const CALL_TYPES = ["call", "call_sequence"];

export function createTask({ type, title, lead_id = null, account_id = null, person_id = null, conversation_id = null, campaign_id = null, product_id = null, due_at = Date.now(), notes = "", draft = null, user_id = null, priority = 0 }) {
  if (CALL_TYPES.includes(type)) return null;
  if (!account_id && lead_id) account_id = q.value("SELECT account_id FROM leads WHERE id = ?", lead_id) || null;
  // Keine doppelten offenen Aufgaben gleicher Art für denselben Lead bzw. dieselbe Firma.
  const open = lead_id
    ? q.get("SELECT * FROM tasks WHERE type = ? AND lead_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", type, lead_id)
    : account_id ? q.get("SELECT * FROM tasks WHERE type = ? AND account_id = ? AND lead_id IS NULL AND person_id IS ? AND status = 'open' ORDER BY id DESC LIMIT 1", type, account_id, person_id) : null;
  if (open) {
    if (notes && !String(open.notes || "").includes(notes)) q.run("UPDATE tasks SET notes = TRIM(notes || char(10) || ?) WHERE id = ?", notes, open.id);
    if (due_at < open.due_at) q.run("UPDATE tasks SET due_at = ? WHERE id = ?", due_at, open.id);
    if (priority > (open.priority || 0)) q.run("UPDATE tasks SET priority = ? WHERE id = ?", priority, open.id);
    return open.id;
  }
  const id = insert("tasks", { type, title, lead_id, account_id, person_id, conversation_id, campaign_id, product_id, due_at, status: "open", notes, draft, user_id, priority, created_at: Date.now() });
  emitWebhook("task.created", { task_id: id, type, title, due_at, lead: lead_id ? leadPayload(lead_id) : null, account_id, campaign_id });
  return id;
}

export function closeTasks({ leadId, conversationId = null, types = null, outcome = "done", status = "done" }) {
  const where = ["status = 'open'"], args = [];
  if (leadId) { where.push("lead_id = ?"); args.push(leadId); }
  if (conversationId) { where.push("conversation_id = ?"); args.push(conversationId); }
  if (types) { where.push("type IN (SELECT value FROM json_each(?))"); args.push(JSON.stringify(types)); }
  return Number(q.run(`UPDATE tasks SET status = ?, outcome = COALESCE(outcome, ?), done_at = ? WHERE ${where.join(" AND ")}`, status, outcome, Date.now(), ...args).changes);
}

// ---------- Nachfassen ----------

function lastMessage(conversationId) {
  return q.get("SELECT direction, created_at FROM messages WHERE conversation_id = ? AND kind != 'auto_reply' ORDER BY created_at DESC, id DESC LIMIT 1", conversationId);
}

// Plant das nächste Nachfassen: nur bei Interesse, wenn wir zuletzt geschrieben haben und noch Versuche übrig sind.
export function armNurture(conversationId, now = Date.now()) {
  const conv = q.get("SELECT * FROM conversations WHERE id = ?", conversationId);
  if (!conv || conv.nurture_stopped || conv.meeting_at) return null;
  const c = settingsFor(campaignOf(conv));
  if (!c.nurture_enabled || !NURTURE_LABELS.includes(conv.label)) {
    q.run("UPDATE conversations SET nurture_next_at = NULL WHERE id = ?", conv.id);
    return null;
  }
  const last = lastMessage(conv.id);
  // Letzte Nachricht kam vom Lead: zuerst antworten wir (Aufgabe „Antworten“), dann wird nachgefasst.
  const next = last && last.direction === "out" ? last.created_at + Math.max(1, Number(c.nurture_days) || 3) * DAY_MS : null;
  q.run("UPDATE conversations SET nurture_next_at = ? WHERE id = ?", next, conv.id);
  return next;
}

export function stopNurture(conversationId, reason) {
  q.run("UPDATE conversations SET nurture_stopped = ?, nurture_next_at = NULL WHERE id = ?", reason, conversationId);
}

function nurtureWindow(settings) {
  return { timezone: settings.timezone || "Europe/Berlin", days: settings.nurture_weekdays || "1,2,3,4,5", window_start: settings.nurture_window_start || "08:30", window_end: settings.nurture_window_end || "17:30" };
}

// Text für das n-te Nachfassen: nur aus der freigegebenen Kampagne (automatisch) – sonst Entwurf.
function approvedNurtureText(campaign, index) {
  if (!campaign || campaign.nurture_mode !== "auto") return null;
  if (!approvalState(campaign, loadSteps(campaign.id)).approved) return null;
  const texts = nurtureTexts(campaign);
  return texts[index]?.body || null;
}

export function renderNurture({ body, lead, mailbox, campaign, token, settings = getSettings() }) {
  const product = campaign?.product_id ? q.get("SELECT * FROM products WHERE id = ?", campaign.product_id) : null;
  const unsub = unsubscribeUrl(token || "vorschau");
  const vars = buildVars({ lead, mailbox, extra: { unsubscribe_url: unsub, privacy_url: settings.privacy_url, ...productVars(product, lead, settings) }, language: targetLanguage(campaign) });
  const main = render(body, vars, `nurture:${lead.id}:${token}`);
  const parts = [main.text.trim()];
  if (mailbox?.signature) parts.push(render(mailbox.signature, vars).text.trim());
  if (settings.unsubscribe_text && !/unsubscribe_url/.test(body)) parts.push(render(settings.unsubscribe_text, vars).text.trim());
  if (settings.footer_text) parts.push(render(settings.footer_text, vars).text.trim());
  return { text: parts.filter(Boolean).join("\n\n"), missing: main.missing };
}

function threadInfo(conversationId) {
  const msgs = q.all("SELECT message_id, subject FROM messages WHERE conversation_id = ? AND message_id IS NOT NULL ORDER BY created_at", conversationId);
  const last = msgs.at(-1);
  const base = [...msgs].reverse().find(m => m.subject)?.subject || "";
  return { inReplyTo: last?.message_id || null, references: msgs.slice(-10).map(m => m.message_id).join(" "), subject: /^(re|aw):/i.test(base) ? base : `Re: ${base}` };
}

async function sendNurtureMail({ conv, lead, mailbox, campaign, body, settings }) {
  const token = newToken(18);
  const rendered = renderNurture({ body, lead, mailbox, campaign, token, settings });
  if (rendered.missing.length) throw new Error(`Variable fehlt: ${rendered.missing.join(", ")}`);
  const thread = threadInfo(conv.id);
  const messageId = newMessageId(mailbox.email);
  const mail = composeMail({ mailbox, lead, subject: thread.subject, text: rendered.text, token, messageId, inReplyTo: thread.inReplyTo || undefined, references: thread.references || undefined, listUnsubscribe: true });
  const raw = await buildRaw(mail);
  await sendRaw(mailbox, { from: mailbox.email, to: lead.email, raw });
  const sentAt = Date.now();
  const gap = Math.max(Number(mailbox.min_gap_sec) || 0, randomBetween(Number(campaign?.min_gap_sec) || 60, Number(campaign?.max_gap_sec) || 180));
  tx(() => {
    const msgId = addMessage({
      conversation_id: conv.id, mailbox_id: mailbox.id, lead_id: lead.id, campaign_id: conv.campaign_id, campaign_lead_id: conv.campaign_lead_id,
      direction: "out", kind: "nurture", message_id: messageId, in_reply_to: thread.inReplyTo, refs: thread.references,
      from_addr: mailbox.email, to_addr: lead.email, subject: thread.subject, text: rendered.text, token, status: "sent", created_at: sentAt
    });
    recordEvent("nurture_sent", { campaign_id: conv.campaign_id, lead_id: lead.id, mailbox_id: mailbox.id, message_id: msgId, data: { n: (conv.nurture_count || 0) + 1 } });
    recordMailboxSuccess(mailbox, sentAt + gap * 1000);
  });
  if (mailbox.save_sent) appendToSent(mailbox, raw).catch(() => {});
  return sentAt;
}

function nurtureBlocked(lead, now) {
  if (!lead || lead.status !== "active") return "Lead nicht aktiv";
  if (isBlocked(lead.email)) return "gesperrt";
  if (lead.consent_status === "revoked") return "Widerspruch";
  if (lead.hold_until && lead.hold_until > now) return "gesperrt (kein Interesse)";
  if (lead.meeting_at) return "Termin gebucht";
  const acc = accountBlock(lead, { firstContact: false });
  if (acc) return acc;
  return null;
}

// Wird im Versand-Takt aufgerufen. available: Map der freien Postfächer (wie im Scheduler).
export async function runNurtureTick(now = Date.now(), available = new Map()) {
  const settings = getSettings();
  if (!inWindow(nurtureWindow(settings), now)) return { sent: 0, drafts: 0 };
  const due = q.all("SELECT * FROM conversations WHERE nurture_next_at IS NOT NULL AND nurture_next_at <= ? AND nurture_stopped IS NULL ORDER BY nurture_next_at LIMIT 25", now);
  let sent = 0, drafts = 0;
  for (const conv of due) {
    const lead = q.get("SELECT * FROM leads WHERE id = ?", conv.lead_id);
    const blocked = nurtureBlocked(lead, now);
    if (blocked) { stopNurture(conv.id, blocked); continue; }
    if (!NURTURE_LABELS.includes(conv.label)) { q.run("UPDATE conversations SET nurture_next_at = NULL WHERE id = ?", conv.id); continue; }
    const last = lastMessage(conv.id);
    if (!last || last.direction !== "out") { q.run("UPDATE conversations SET nurture_next_at = NULL WHERE id = ?", conv.id); continue; }
    const campaign = campaignOf(conv);
    const c = settingsFor(campaign);
    const count = conv.nurture_count || 0;
    if (count >= (Number(c.nurture_max) || 0)) {
      // Alle Nachfass-Mails ohne Reaktion: keine weitere Mail. Der Lead bleibt „Warm“ – Übergabe an die Sales App per Export.
      stopNurture(conv.id, "exhausted");
      continue;
    }
    const text = approvedNurtureText(campaign, count);
    if (!text) {
      // Kein freigegebener Text oder Modus „Entwurf“: Mensch prüft und sendet.
      createTask({ type: "nurture_draft", title: `Nachfassen: ${leadLabel(lead)}`, lead_id: lead.id, conversation_id: conv.id, campaign_id: conv.campaign_id, product_id: campaign?.product_id || null, draft: nurtureTexts(campaign || {})[count]?.body || null, notes: `Interesse gezeigt, seit ${Math.round((now - last.created_at) / DAY_MS)} Tagen keine Antwort.` });
      q.run("UPDATE conversations SET nurture_next_at = NULL WHERE id = ?", conv.id);
      drafts++;
      continue;
    }
    const slot = conv.mailbox_id ? available.get(conv.mailbox_id) : null;
    if (!slot) continue; // Postfach gerade belegt oder Limit erreicht – nächster Takt.
    const mailbox = slot.mb;
    try {
      await sendNurtureMail({ conv, lead, mailbox, campaign, body: text, settings });
      q.run("UPDATE conversations SET nurture_count = nurture_count + 1, nurture_next_at = ? WHERE id = ?", Date.now() + Math.max(1, Number(c.nurture_days) || 3) * DAY_MS, conv.id);
      available.delete(mailbox.id);
      sent++;
    } catch (err) {
      const kind = classifySmtpError(err);
      const message = err.responseCode ? describeSmtpError(err) : err.message;
      if (kind.type === "recipient") { stopNurture(conv.id, "bounce"); continue; }
      if (err.responseCode && ["auth", "sender", "policy", "connection", "quota"].includes(kind.type)) recordMailboxError(mailbox, message, { pause: kind.type === "auth" });
      q.run("UPDATE conversations SET nurture_next_at = ? WHERE id = ?", Date.now() + 2 * 60 * 60 * 1000, conv.id);
      available.delete(mailbox.id);
    }
  }
  return { sent, drafts };
}

// ---------- Reaktion auf Einordnung (KI oder Nutzer) ----------

export function onLabelChange(conv, label, meta = {}) {
  const fresh = q.get("SELECT * FROM conversations WHERE id = ?", conv.id) || conv;
  const lead = q.get("SELECT * FROM leads WHERE id = ?", fresh.lead_id);
  if (!lead) return;
  const campaign = campaignOf(fresh);
  const settings = getSettings();
  const base = { lead_id: lead.id, conversation_id: fresh.id, campaign_id: fresh.campaign_id, product_id: campaign?.product_id || null, notes: fresh.ai_summary || "" };
  const last = lastMessage(fresh.id);
  const now = Date.now();

  const accountId = lead.account_id;
  const memo = (kind, text, meta = {}) => { if (accountId && text) q.run("INSERT INTO account_memory (account_id, kind, text, source, meta, lead_id, created_at) VALUES (?, ?, ?, 'email', ?, ?, ?)", accountId, kind, text.slice(0, 1000), JSON.stringify(meta), lead.id, now); };
  if (NURTURE_LABELS.includes(label)) advance(accountId, "engaged", `Antwort: ${LABELS[label]}`, { allowFromSide: ["disqualified", "lost"] });
  // Absage einer Person: Firma nur dann auf „Später“, wenn kein Kollege gerade positiv im Gespräch ist.
  const colleagueEngaged = accountId && q.get(`SELECT 1 FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE l.account_id = ? AND l.id != ?
    AND c.label IN ('interested','meeting','question') AND c.status != 'done'`, accountId, lead.id);
  const later = (reason, days) => {
    if (!accountId || colleagueEngaged) return;
    if (sideState(accountId, "not_now", reason)) q.run("UPDATE accounts SET next_check_at = ? WHERE id = ?", now + days * DAY_MS, accountId);
  };
  if (label === "not_interested") { later("Kein Interesse per Mail", Number(settings.not_interested_hold_days) || 365); memo("objection", `Kein Interesse (${leadLabel(lead)}): ${fresh.ai_summary || ""}`.trim(), { type: "no_interest" }); }
  if (label === "later") { later("Später melden", 90); memo("timing", `Später melden (${leadLabel(lead)}): ${fresh.ai_summary || ""}`.trim()); }
  if (label === "unsubscribe" && accountId && !q.get("SELECT 1 FROM account_people WHERE account_id = ? AND do_not_contact = 0 AND lead_id IS NOT NULL AND lead_id != ?", accountId, lead.id)) sideState(accountId, "suppressed", "Abmeldung");
  if (label === "wrong_person") memo("note", `Falscher Ansprechpartner: ${leadLabel(lead)}. ${fresh.ai_summary || ""}`.trim());

  if (NURTURE_LABELS.includes(label)) {
    if (last?.direction === "in") createTask({ ...base, type: "reply", title: `Antworten: ${leadLabel(lead)} – ${LABELS[label]}` });
    if (fresh.nurture_stopped && fresh.nurture_stopped !== "meeting") q.run("UPDATE conversations SET nurture_stopped = NULL, nurture_count = 0 WHERE id = ?", fresh.id);
    armNurture(fresh.id, now);
  } else if (label === "later") {
    stopNurture(fresh.id, "later");
    createTask({ ...base, type: "recontact", title: `Wieder melden: ${leadLabel(lead)}`, due_at: now + 30 * DAY_MS });
  } else if (label === "not_interested") {
    stopNurture(fresh.id, "not_interested");
    const holdDays = Number(settings.not_interested_hold_days) || 365;
    q.run("UPDATE leads SET hold_until = MAX(COALESCE(hold_until, 0), ?), updated_at = ? WHERE id = ?", now + holdDays * DAY_MS, now, lead.id);
    q.run("UPDATE campaign_leads SET status = 'stopped', last_error = 'Kein Interesse', next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", lead.id);
    closeTasks({ leadId: lead.id, types: ["call", "call_sequence", "reply", "nurture_draft"], outcome: "not_interested", status: "dismissed" });
  } else if (label === "unsubscribe") {
    stopNurture(fresh.id, "unsubscribe");
    q.run("UPDATE leads SET consent_status = 'revoked', updated_at = ? WHERE id = ?", now, lead.id);
    closeTasks({ leadId: lead.id, outcome: "unsubscribe", status: "dismissed" });
  } else if (label === "wrong_person") {
    stopNurture(fresh.id, "wrong_person");
    createTask({ ...base, type: "todo", title: `Richtigen Ansprechpartner anlegen: ${lead.company || leadLabel(lead)}` });
  }
}

setLabelHook(onLabelChange);
// Absage per Mail ohne KI erkannt (mail/inbound.js): gleicher Weg wie die KI-Einordnung „Kein Interesse“.
setInboundHandler("not_interested", conv => conv && onLabel(conv, "not_interested"));


// ---------- Termin gebucht ----------

export function markMeetingBooked(leadId, { at = null, source = "manual", conversationId = null } = {}) {
  const lead = q.get("SELECT * FROM leads WHERE id = ?", leadId);
  if (!lead) return false;
  const now = Date.now();
  const when = at || now;
  const first = !lead.meeting_at;
  tx(() => {
    q.run("UPDATE leads SET meeting_at = ?, updated_at = ? WHERE id = ?", when, now, leadId);
    const convs = conversationId ? [{ id: conversationId }] : q.all("SELECT id FROM conversations WHERE lead_id = ?", leadId);
    for (const c of convs) {
      q.run("UPDATE conversations SET meeting_at = ?, label = 'meeting', label_by = CASE WHEN label_by = 'user' THEN 'user' ELSE 'booking' END, nurture_stopped = 'meeting', nurture_next_at = NULL WHERE id = ?", when, c.id);
    }
    q.run("UPDATE campaign_leads SET status = 'stopped', last_error = 'Termin gebucht', interest = 'meeting', next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", leadId);
    closeTasks({ leadId, types: ["call", "call_sequence", "reply", "nurture_draft", "recontact"], outcome: "meeting" });
    if (first) {
      const conv = q.get("SELECT campaign_id FROM conversations WHERE lead_id = ? ORDER BY last_at DESC LIMIT 1", leadId);
      recordEvent("meeting", { campaign_id: conv?.campaign_id || null, lead_id: leadId, data: { source, at: when } });
      if (!q.get("SELECT 1 FROM events WHERE type = 'interested' AND lead_id = ?", leadId)) recordEvent("interested", { campaign_id: conv?.campaign_id || null, lead_id: leadId, data: { label: "meeting", source } });
    }
  });
  if (first) emitWebhook("lead.meeting", { lead: leadPayload(leadId), at: new Date(when).toISOString(), source });
  // Revenue: Firma in „Termin“, Verkaufschance mit Zuordnung (Anlass, Pain, Persona, Kanal, Play) anlegen.
  const accountId = q.value("SELECT account_id FROM leads WHERE id = ?", leadId);
  if (accountId) {
    advance(accountId, "meeting", "Termin gebucht", { allowFromSide: ["disqualified", "lost"] });
    ensureOpportunityForMeeting({ accountId, leadId, meetingAt: at || null, source });
  }
  return true;
}

// Buchungstools (Calendly, Cal.com, eigene Sales App …) schicken unterschiedliche Formate – E-Mail und Startzeit herausfinden.
export function parseBookingPayload(body) {
  const b = body && typeof body === "object" ? body : {};
  const p = b.payload && typeof b.payload === "object" ? b.payload : b.data && typeof b.data === "object" ? b.data : b;
  const candidates = [p.email, p.invitee?.email, p.attendee?.email, p.attendees?.[0]?.email, p.responses?.email?.value, p.responses?.email, p.lead?.email, p.contact?.email, b.email];
  const email = candidates.map(x => (typeof x === "string" ? x.trim().toLowerCase() : "")).find(x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)) || null;
  const startRaw = p.start_time || p.startTime || p.scheduled_event?.start_time || p.event?.start_time || p.start || b.start_time || null;
  const start = startRaw ? Date.parse(startRaw) : NaN;
  const cancelled = /cancel/i.test(String(b.event || b.triggerEvent || b.type || "")) || p.status === "canceled" || p.status === "cancelled";
  return { email, at: Number.isFinite(start) ? start : null, cancelled };
}

export function handleBooking(body) {
  const { email, at, cancelled } = parseBookingPayload(body);
  if (!email) return { ok: false, matched: false, error: "Keine E-Mail-Adresse im Payload gefunden" };
  const lead = q.get("SELECT * FROM leads WHERE email = ?", email);
  if (!lead) return { ok: true, matched: false };
  if (cancelled) {
    q.run("UPDATE leads SET meeting_at = NULL, updated_at = ? WHERE id = ?", Date.now(), lead.id);
    recordEvent("meeting_cancelled", { lead_id: lead.id });
    // Chance im Stadium „Termin“ ohne Termin zurücksetzen; ohne andere offene Chance ist die Firma wieder „im Gespräch“.
    if (lead.account_id) {
      const opp = q.get("SELECT * FROM opportunities WHERE account_id = ? AND stage = 'meeting' ORDER BY id DESC LIMIT 1", lead.account_id);
      if (opp) q.run("UPDATE opportunities SET meeting_at = NULL, prep = NULL, next_step = 'Termin abgesagt – neu vereinbaren', updated_at = ? WHERE id = ?", Date.now(), opp.id);
      const other = q.get("SELECT 1 FROM opportunities WHERE account_id = ? AND stage IN ('qualified','proposal')", lead.account_id);
      if (!other && q.value("SELECT lifecycle FROM accounts WHERE id = ?", lead.account_id) === "meeting") setLifecycle(lead.account_id, "engaged", { reason: "Termin abgesagt", by: "system" });
    }
    createTask({ type: "todo", title: `Termin abgesagt: ${leadLabel(lead)} – neu vereinbaren`, lead_id: lead.id });
    return { ok: true, matched: true, cancelled: true };
  }
  markMeetingBooked(lead.id, { at, source: "booking" });
  return { ok: true, matched: true, lead_id: lead.id };
}
