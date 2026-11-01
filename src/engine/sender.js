// Versand eines Sequenz-Schritts an einen Lead – inkl. Prüfungen, KI-Personalisierung, Threading und Fehlerbehandlung.
import { q, tx, update, parseJson } from "../db.js";
import { token as newToken, randomBetween } from "../crypto.js";
import { DAY_MS, startOfDay } from "../lib/time.js";
import { renderStep, composeMail, newMessageId, chooseVariant, loadSteps } from "../mail/compose.js";
import { buildRaw, sendRaw, classifySmtpError, describeSmtpError } from "../mail/transport.js";
import { recordMailboxError, recordMailboxSuccess, appTimezone } from "../mail/mailboxes.js";
import { ensureConversation, addMessage, isBlocked } from "./conversations.js";
import { recordEvent, emitWebhook, leadPayload } from "../events.js";
import { appendToSent } from "../mail/imap.js";
import { ensurePersonalization, aiAvailable, AiLimitError } from "../ai/features.js";
import { contactBlock } from "./rules.js";
import { advance } from "../intel/lifecycle.js";

const AI_STEP_TIMEOUT_MS = 3 * 60 * 1000;

// Langsame KI-Antworten dürfen den Versand-Takt nicht blockieren.
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); timer.unref?.(); })
  ]);
}

const FINAL = { unsubscribed: "unsubscribed", bounced: "bounced", blocked: "blocked", invalid: "invalid" };

function finish(cl, status, reason = null) {
  q.run("UPDATE campaign_leads SET status = ?, last_error = ?, next_at = NULL WHERE id = ?", status, reason, cl.id);
  return { status: "skipped", reason: reason || status };
}

function defer(cl, ms, reason, { countAttempt = true, maxAttempts = 5 } = {}) {
  const attempts = (cl.attempts || 0) + (countAttempt ? 1 : 0);
  if (attempts >= maxAttempts) {
    q.run("UPDATE campaign_leads SET status = 'error', attempts = ?, last_error = ?, next_at = NULL WHERE id = ?", attempts, String(reason).slice(0, 500), cl.id);
    return { status: "failed", reason };
  }
  q.run("UPDATE campaign_leads SET attempts = ?, last_error = ?, next_at = ? WHERE id = ?", attempts, String(reason).slice(0, 500), Date.now() + ms, cl.id);
  return { status: "deferred", reason };
}

// Prüft, ob ein Lead (noch) angeschrieben werden darf. Gibt null zurück, wenn ja.
export function eligibility(campaign, cl, lead) {
  if (FINAL[lead.status]) return FINAL[lead.status];
  if (isBlocked(lead.email)) return "blocked";
  if (lead.verify_status === "invalid") return "invalid";
  if (campaign.skip_risky && lead.verify_status === "risky") return "skipped";
  if (campaign.stop_on_reply && cl.replied_at) return "replied";
  return null;
}

// Kontaktregeln (Einwilligung, Qualität, Sperrfristen, Firmen-Limit) – endgültig überspringen oder später erneut.
function applyContactRules(campaign, cl, lead, stepIndex, now) {
  const rule = contactBlock(campaign, lead, { stepIndex, now, clId: cl.id });
  if (!rule) return null;
  if (rule.final) return finish(cl, "skipped", rule.reason);
  return defer(cl, Math.max(60 * 1000, (rule.retryAt || now + 60 * 60 * 1000) - Date.now()), rule.reason, { countAttempt: false });
}

export async function sendCampaignStep({ campaign, steps = loadSteps(campaign.id), cl, lead, mailbox, now = Date.now() }) {
  const blocked = eligibility(campaign, cl, lead);
  if (blocked) return finish(cl, blocked);
  const stepIndex = cl.step || 0;
  const step = steps[stepIndex];
  if (!step) return finish(cl, "completed");
  const ruled = applyContactRules(campaign, cl, lead, stepIndex, now);
  if (ruled) return ruled;

  const variants = parseJson(cl.variants, {}) || {};
  let variantKey = variants[stepIndex];
  if (!variantKey || !step.variants.some(v => v.key === variantKey)) variantKey = chooseVariant(step);
  if (!variantKey) return finish(cl, "error", `Schritt ${stepIndex + 1} hat keinen Inhalt`);
  variants[stepIndex] = variantKey;

  // KI-Personalisierung (Einstiegssatz einmal pro Lead, Volltext pro Schritt).
  if (campaign.ai_mode && campaign.ai_mode !== "off") {
    if (!aiAvailable()) return defer(cl, 60 * 60 * 1000, "KI nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN fehlt)", { countAttempt: false });
    try {
      const ai = await withTimeout(ensurePersonalization({ campaign, steps, cl, lead, mailbox, stepIndex, variantKey }), AI_STEP_TIMEOUT_MS, "KI-Personalisierung dauert zu lange");
      cl = { ...cl, ai: JSON.stringify(ai), ai_attempts: 0 };
    } catch (err) {
      // Abo-Limit erreicht: warten, bis das Kontingent wieder frei ist – zählt nicht als Fehlversuch.
      if (err instanceof AiLimitError) return defer(cl, Math.max(5 * 60 * 1000, (err.retryAt || 0) - Date.now()), err.message, { countAttempt: false });
      const attempts = (cl.ai_attempts || 0) + 1;
      q.run("UPDATE campaign_leads SET ai_attempts = ? WHERE id = ?", attempts, cl.id);
      if (attempts < 3) return defer(cl, 15 * 60 * 1000, `KI-Personalisierung fehlgeschlagen: ${err.message}`, { countAttempt: false });
      // Nach 3 Fehlversuchen: Vorlage ohne KI-Text verwenden (Fallbacks in der Vorlage greifen).
    }
  }

  // Während KI/Website-Abruf kann sich der Stand geändert haben (pausiert, geantwortet, abgemeldet): direkt vor dem Versand neu prüfen.
  const current = q.get("SELECT * FROM campaign_leads WHERE id = ?", cl.id);
  if (!current || !["queued", "active"].includes(current.status) || (current.step || 0) !== stepIndex) return { status: "skipped", reason: "Status hat sich geändert" };
  if (q.value("SELECT status FROM campaigns WHERE id = ?", campaign.id) !== "active") return { status: "skipped", reason: "Kampagne läuft nicht" };
  lead = q.get("SELECT * FROM leads WHERE id = ?", lead.id) || lead;
  cl = { ...current, ai: cl.ai };
  const stillBlocked = eligibility(campaign, cl, lead);
  if (stillBlocked) return finish(cl, stillBlocked);
  const stillRuled = applyContactRules(campaign, cl, lead, stepIndex, Date.now());
  if (stillRuled) return stillRuled;

  // Wechsel des Postfachs (altes gelöscht/aus der Kampagne entfernt): neuer Thread statt „Re:“ von fremder Adresse.
  const freshThread = stepIndex > 0 && !!cl.last_message_id && cl.mailbox_id !== mailbox.id;
  if (freshThread) cl = { ...cl, last_message_id: null, thread_message_id: null, thread_subject: null, refs: "" };

  const token = newToken(18);
  const rendered = renderStep({ campaign, steps, stepIndex, variantKey, lead, mailbox, cl, token, freshThread });
  if (rendered.missing.length && campaign.skip_missing_vars) {
    return finish(cl, "error", `Variable fehlt: ${rendered.missing.join(", ")} – Lead ergänzen oder Fallback {{${rendered.missing[0]}|…}} setzen`);
  }
  if (!rendered.subject.trim() && !rendered.threadReply) return finish(cl, "error", "Betreff ist leer");

  const messageId = newMessageId(mailbox.email);
  let inReplyTo = null, references = null;
  if (rendered.threadReply && cl.last_message_id && !freshThread) {
    inReplyTo = cl.last_message_id;
    references = [cl.refs, cl.last_message_id].filter(Boolean).join(" ").trim();
  }
  const mail = composeMail({
    mailbox, lead, subject: rendered.subject, text: rendered.text, token, messageId, inReplyTo, references,
    trackOpens: !!campaign.track_opens, trackClicks: !!campaign.track_clicks, listUnsubscribe: !!campaign.unsubscribe
  });

  let raw;
  try {
    raw = await buildRaw(mail);
    await sendRaw(mailbox, { from: mailbox.email, to: lead.email, raw });
  } catch (err) {
    return handleSendError({ err, campaign, cl, lead, mailbox, stepIndex, variantKey, rendered, messageId, token, now });
  }

  const sentAt = Date.now();
  const nextIndex = stepIndex + 1;
  const hasNext = nextIndex < steps.length;
  const gap = Math.max(Number(mailbox.min_gap_sec) || 0, randomBetween(Number(campaign.min_gap_sec) || 60, Number(campaign.max_gap_sec) || 120));
  const nextAt = hasNext ? sentAt + Math.max(0, Number(steps[nextIndex].delay_days) || 0) * DAY_MS : null;
  const newThread = !rendered.threadReply || freshThread;
  try {
    tx(() => {
      // Wurde der Eintrag während des Versands entfernt, die Nachricht trotzdem protokollieren (ohne Verweis).
      const clId = q.get("SELECT id FROM campaign_leads WHERE id = ?", cl.id) ? cl.id : null;
      const conv = ensureConversation({ mailbox_id: mailbox.id, lead_id: lead.id, campaign_id: campaign.id, campaign_lead_id: clId, subject: rendered.subject, now: sentAt });
      const msgId = addMessage({
        conversation_id: conv.id, mailbox_id: mailbox.id, lead_id: lead.id, campaign_id: campaign.id, campaign_lead_id: clId,
        step: stepIndex, variant: variantKey, direction: "out", kind: "campaign", message_id: messageId, in_reply_to: inReplyTo, refs: references,
        from_addr: mailbox.email, to_addr: lead.email, subject: rendered.subject, text: rendered.text, html: mail.html || null, token, status: "sent", created_at: sentAt
      });
      // Status nur weiterschalten, wenn er während des Versands nicht geändert wurde (z. B. gestoppt oder geantwortet).
      q.run(`UPDATE campaign_leads SET step = ?, status = CASE WHEN status IN ('queued','active') THEN ? ELSE status END,
        next_at = CASE WHEN status IN ('queued','active') THEN ? ELSE next_at END, mailbox_id = ?, last_message_id = ?, thread_message_id = ?, thread_subject = ?,
        refs = ?, variants = ?, attempts = 0, last_error = NULL, last_sent_at = ? WHERE id = ?`,
        nextIndex, hasNext ? "active" : "completed", nextAt, mailbox.id, messageId,
        newThread ? messageId : (cl.thread_message_id || messageId), newThread ? rendered.subject : (cl.thread_subject || rendered.subject),
        newThread ? "" : references || "", JSON.stringify(variants), sentAt, cl.id);
      recordEvent("sent", { campaign_id: campaign.id, lead_id: lead.id, mailbox_id: mailbox.id, message_id: msgId, step: stepIndex, variant: variantKey });
      recordMailboxSuccess(mailbox, sentAt + gap * 1000);
    });
  } catch (err) {
    // Die Mail ist raus – auf keinen Fall erneut senden.
    console.error("[sender] Protokollieren nach dem Versand fehlgeschlagen", err);
    try {
      q.run("UPDATE campaign_leads SET step = ?, next_at = ?, status = CASE WHEN status IN ('queued','active') THEN ? ELSE status END, mailbox_id = ?, last_message_id = ?, last_sent_at = ? WHERE id = ?",
        nextIndex, nextAt, hasNext ? "active" : "completed", mailbox.id, messageId, sentAt, cl.id);
      recordMailboxSuccess(mailbox, sentAt + gap * 1000);
    } catch (inner) {
      console.error("[sender] Notfall-Update fehlgeschlagen", inner);
    }
  }

  if (lead.account_id) advance(lead.account_id, "contacted", `Mail ${stepIndex + 1} aus „${campaign.name}“`);
  if (mailbox.save_sent) appendToSent(mailbox, raw).catch(() => {});
  return { status: "sent", messageId };
}

function handleSendError({ err, campaign, cl, lead, mailbox, stepIndex, variantKey, rendered, messageId, token, now }) {
  const kind = classifySmtpError(err);
  const message = describeSmtpError(err);
  switch (kind.type) {
    case "recipient": {
      tx(() => {
        const conv = ensureConversation({ mailbox_id: mailbox.id, lead_id: lead.id, campaign_id: campaign.id, campaign_lead_id: cl.id, subject: rendered.subject, now });
        const msgId = addMessage({
          conversation_id: conv.id, mailbox_id: mailbox.id, lead_id: lead.id, campaign_id: campaign.id, campaign_lead_id: cl.id,
          step: stepIndex, variant: variantKey, direction: "out", kind: "campaign", message_id: messageId, from_addr: mailbox.email, to_addr: lead.email,
          subject: rendered.subject, text: rendered.text, token, status: "bounced", error: message
        });
        q.run("UPDATE leads SET status = 'bounced', updated_at = ? WHERE id = ?", Date.now(), lead.id);
        q.run("UPDATE campaign_leads SET status = 'bounced', last_error = ?, next_at = NULL WHERE lead_id = ? AND status IN ('queued','active')", message, lead.id);
        recordEvent("bounce", { campaign_id: campaign.id, lead_id: lead.id, mailbox_id: mailbox.id, message_id: msgId, step: stepIndex, variant: variantKey, data: { reason: message, smtp: true } });
        q.run("UPDATE mailboxes SET next_send_at = ? WHERE id = ?", Date.now() + Math.max(60, Number(mailbox.min_gap_sec) || 60) * 1000, mailbox.id);
      });
      emitWebhook("lead.bounced", { lead: leadPayload(lead.id), campaign_id: campaign.id, reason: message });
      return { status: "bounced", reason: message, attempted: true };
    }
    case "recipient_temp":
      // Empfänger vorübergehend nicht erreichbar (Postfach voll, Greylisting): später erneut, Postfach bleibt unberührt.
      return { ...defer(cl, 6 * 60 * 60 * 1000, message, { maxAttempts: 4 }), attempted: true };
    case "sender":
      // Absender wird abgelehnt: Postfach-Problem, nie den Lead als Bounce markieren.
      recordMailboxError(mailbox, message, { pause: kind.permanent, retryAt: Date.now() + 60 * 60 * 1000 });
      return { ...defer(cl, 60 * 60 * 1000, message, { countAttempt: false }), attempted: true };
    case "auth":
      recordMailboxError(mailbox, message, { pause: true });
      return { ...defer(cl, 30 * 60 * 1000, message, { countAttempt: false }), attempted: true };
    case "quota": {
      const tomorrow = startOfDay(Date.now(), appTimezone()) + DAY_MS + 60 * 60 * 1000;
      q.run("UPDATE mailboxes SET last_error = ?, next_send_at = ?, updated_at = ? WHERE id = ?", message, tomorrow, Date.now(), mailbox.id);
      return { ...defer(cl, 60 * 60 * 1000, message, { countAttempt: false }), attempted: true };
    }
    case "policy":
      recordMailboxError(mailbox, message, { retryAt: Date.now() + 30 * 60 * 1000 });
      return { ...defer(cl, 2 * 60 * 60 * 1000, message, { maxAttempts: 3 }), attempted: true };
    case "message":
      return { ...finish(cl, "error", message), attempted: true };
    default:
      recordMailboxError(mailbox, message);
      return { ...defer(cl, 30 * 60 * 1000, message), attempted: true };
  }
}

// Manuelle Antwort aus der Unibox (im Thread des Gesprächs).
// kind "nurture" + token: Nachfass-Mail mit Abmelde-Link/-Header (Text enthält dann bereits Fußzeile und Abmelde-Hinweis).
export async function sendManualReply({ conversation, mailbox, lead, text, subject, kind = "manual", token = null }) {
  const last = q.get("SELECT * FROM messages WHERE conversation_id = ? AND message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1", conversation.id);
  const refsRow = q.all("SELECT message_id FROM messages WHERE conversation_id = ? AND message_id IS NOT NULL ORDER BY created_at", conversation.id).map(r => r.message_id);
  const baseSubject = subject || (last?.subject || conversation.subject || "");
  const finalSubject = /^(re|aw):/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;
  const messageId = newMessageId(mailbox.email);
  const signature = mailbox.signature ? `\n\n${mailbox.signature}` : "";
  const fullText = `${String(text).trim()}${signature}`;
  // Antwort geht an den, der zuletzt geschrieben hat (z. B. Kollege statt der angeschriebenen Adresse).
  const lastIn = q.value("SELECT from_addr FROM messages WHERE conversation_id = ? AND direction = 'in' AND kind = 'reply' AND from_addr IS NOT NULL ORDER BY created_at DESC LIMIT 1", conversation.id);
  const to = lastIn && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lastIn) ? String(lastIn).toLowerCase() : lead.email;
  const recipient = to === lead.email ? lead : { ...lead, email: to, first_name: "", last_name: "" };
  const mail = composeMail({
    mailbox, lead: recipient, subject: finalSubject, text: fullText, token, messageId,
    inReplyTo: last?.message_id || undefined, references: refsRow.slice(-10).join(" ") || undefined, listUnsubscribe: !!token
  });
  const raw = await buildRaw(mail);
  await sendRaw(mailbox, { from: mailbox.email, to, raw });
  const id = addMessage({
    conversation_id: conversation.id, mailbox_id: mailbox.id, lead_id: lead.id, campaign_id: conversation.campaign_id, campaign_lead_id: conversation.campaign_lead_id,
    direction: "out", kind, message_id: messageId, in_reply_to: last?.message_id || null, refs: refsRow.slice(-10).join(" "),
    from_addr: mailbox.email, to_addr: to, subject: finalSubject, text: fullText, token, status: "sent"
  });
  q.run("UPDATE conversations SET unread = 0 WHERE id = ?", conversation.id);
  recordEvent(kind === "nurture" ? "nurture_sent" : "manual_sent", { campaign_id: conversation.campaign_id, lead_id: lead.id, mailbox_id: mailbox.id, message_id: id });
  if (mailbox.save_sent) appendToSent(mailbox, raw).catch(() => {});
  return { id, messageId };
}

// Testmail eines Schritts an eine beliebige Adresse (ohne Tracking, ohne Zählung).
export async function sendTestStep({ campaign, steps, stepIndex, lead, mailbox, to, cl = null }) {
  const variantKey = cl ? (parseJson(cl.variants, {}) || {})[stepIndex] : null;
  const rendered = renderStep({ campaign, steps, stepIndex, variantKey, lead, mailbox, cl, token: "test" });
  const mail = composeMail({ mailbox, lead: { ...lead, email: to }, subject: `[Test] ${rendered.subject}`, text: rendered.text, token: null, messageId: newMessageId(mailbox.email), listUnsubscribe: false });
  const raw = await buildRaw(mail);
  await sendRaw(mailbox, { from: mailbox.email, to, raw });
  return rendered;
}
