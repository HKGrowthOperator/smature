// Postfach-Logik: Tageslimit mit Ramp-up, heutige Versandzahlen, öffentliche Darstellung (ohne Passwörter).
import { q } from "../db.js";
import { config } from "../config.js";
import { startOfDay, DAY_MS } from "../lib/time.js";
import { getSettings } from "../settings.js";

export function appTimezone() {
  return getSettings().timezone || config.defaultTimezone;
}

// Hauptdomain-Weg: so viel verträgt der Ruf der Geschäftsdomain, ohne die normale Post zu gefährden. Das Tageslimit gilt
// für die ganze Domain – mehrere Postfächer auf der Hauptdomain teilen es sich.
export const MAIN_PER_MAILBOX = 30;
export const MAIN_PER_DAY = 60;

// Hauptdomain, wenn über sie versendet wird (Einrichtung „main“), sonst "".
export function mainSendingDomain(settings = getSettings()) {
  if (settings.setup_mode !== "main") return "";
  return String(settings.main_domain || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:\s]/)[0].replace(/\.$/, "");
}
export const mailboxDomain = email => String(email || "").toLowerCase().split("@")[1] || "";

export function effectiveDailyLimit(mb, now = Date.now()) {
  const limit = Math.max(0, Number(mb.daily_limit) || 0);
  if (!mb.ramp_enabled) return limit;
  const started = mb.ramp_started_at || mb.created_at || now;
  const days = Math.max(0, Math.floor((now - started) / DAY_MS));
  return Math.min(limit, Math.max(1, Number(mb.ramp_start) || 1) + days * Math.max(0, Number(mb.ramp_step) || 0));
}

export function sentTodayByMailbox(now = Date.now()) {
  const since = startOfDay(now, appTimezone());
  const rows = q.all("SELECT mailbox_id, COUNT(*) AS n FROM messages WHERE direction = 'out' AND kind IN ('campaign','manual','nurture') AND status != 'failed' AND created_at >= ? GROUP BY mailbox_id", since);
  return new Map(rows.map(r => [r.mailbox_id, r.n]));
}

export function warmupSentToday(mailboxId, now = Date.now()) {
  return q.value("SELECT COUNT(*) FROM warmup WHERE from_mailbox_id = ? AND sent_at >= ?", mailboxId, startOfDay(now, appTimezone()));
}

export function warmupTarget(mb, now = Date.now()) {
  if (!mb.warmup_enabled) return 0;
  const started = mb.warmup_started_at || now;
  const days = Math.max(0, Math.floor((now - started) / DAY_MS));
  return Math.min(Math.max(1, Number(mb.warmup_daily) || 1), 2 + days * 2);
}

// Anteil der Warmup-Mails, die im Posteingang (statt Spam) gelandet sind – letzte 14 Tage.
export function warmupHealth(mailboxId, now = Date.now()) {
  const row = q.get("SELECT SUM(CASE WHEN landed = 'inbox' THEN 1 ELSE 0 END) AS inbox, SUM(CASE WHEN landed = 'spam' THEN 1 ELSE 0 END) AS spam FROM warmup WHERE to_mailbox_id = ? AND checked_at >= ?", mailboxId, now - 14 * DAY_MS);
  const inbox = row?.inbox || 0, spam = row?.spam || 0;
  return { inbox, spam, score: inbox + spam ? Math.round(inbox / (inbox + spam) * 100) : null };
}

export function publicMailbox(mb, sentToday = new Map(), now = Date.now()) {
  if (!mb) return null;
  const { smtp_pass, imap_pass, ...rest } = mb;
  const bounces = q.get("SELECT COUNT(*) AS sent, SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced FROM messages WHERE mailbox_id = ? AND direction = 'out' AND kind = 'campaign' AND created_at >= ?", mb.id, now - 30 * DAY_MS);
  return {
    ...rest,
    has_smtp_pass: !!smtp_pass,
    has_imap_pass: !!imap_pass,
    imap_configured: !!(mb.imap_host && mb.imap_user && imap_pass),
    sent_today: sentToday.get(mb.id) || 0,
    limit_today: effectiveDailyLimit(mb, now),
    warmup_sent_today: warmupSentToday(mb.id, now),
    warmup_target_today: warmupTarget(mb, now),
    warmup_health: warmupHealth(mb.id, now),
    sent_30d: bounces?.sent || 0,
    bounce_rate_30d: bounces?.sent ? Math.round((bounces.bounced || 0) / bounces.sent * 1000) / 10 : 0
  };
}

export function getMailbox(id) {
  return q.get("SELECT * FROM mailboxes WHERE id = ?", id);
}

export function recordMailboxError(mb, message, { pause = false, retryAt } = {}) {
  const count = (mb.error_count || 0) + 1;
  const status = pause || count >= 5 ? "error" : mb.status;
  q.run("UPDATE mailboxes SET error_count = ?, last_error = ?, status = ?, next_send_at = ?, updated_at = ? WHERE id = ?",
    count, String(message).slice(0, 500), status, retryAt || Date.now() + 5 * 60 * 1000, Date.now(), mb.id);
  return status;
}

export function recordMailboxSuccess(mb, nextSendAt) {
  q.run("UPDATE mailboxes SET error_count = 0, last_error = NULL, last_sent_at = ?, next_send_at = ?, ramp_started_at = COALESCE(ramp_started_at, ?), updated_at = ? WHERE id = ?",
    Date.now(), nextSendAt, Date.now(), Date.now(), mb.id);
}
