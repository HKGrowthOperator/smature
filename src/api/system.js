// API: Dashboard, Einstellungen, Benutzer, Systemstatus.
import { q, insert, update } from "../db.js";
import { fail, v } from "../http.js";
import { getSettings, saveSettings } from "../settings.js";
import { hashPassword, verifyPassword, token } from "../crypto.js";
import { publicUser, requireAdmin } from "../auth.js";
import { testWebhook } from "../events.js";
import { aiAvailable, aiUsage, aiProvider, resumeAi } from "../ai/claude.js";
import { config } from "../config.js";
import { schedulerState, tick } from "../engine/scheduler.js";
import { syncLoopState, syncAll } from "../engine/sync.js";
import { dayKey, startOfDay, DAY_MS, isValidTimezone } from "../lib/time.js";
import { sentTodayByMailbox, publicMailbox, appTimezone } from "../mail/mailboxes.js";
import { VARIABLES } from "../lib/template.js";
import { LABELS, FIT_LABELS, OFFER_TYPES } from "../ai/features.js";
import { TASK_TYPES, CALL_OUTCOMES } from "../engine/followup.js";
import { LEGAL_BASES, CONSENT_STATUSES } from "../engine/rules.js";

const WEBHOOK_EVENTS = ["reply.received", "lead.interested", "lead.meeting", "lead.unsubscribed", "lead.bounced", "campaign.completed", "task.created", "account.triggered", "opportunity.won"];

export function ensureBookingSecret() {
  if (!getSettings().booking_hook_secret) saveSettings({ booking_hook_secret: token(24) });
  return getSettings().booking_hook_secret;
}

function publicSettings(user) {
  const s = getSettings();
  const { booking_hook_secret, ...rest } = s;
  return {
    ...rest, webhook_secret: s.webhook_secret ? "••••••••" : "", has_webhook_secret: !!s.webhook_secret,
    booking_hook_url: user?.role === "admin" && booking_hook_secret ? `${config.appUrl}/hooks/booking/${booking_hook_secret}` : null
  };
}

const hm = (value, name) => {
  const s = String(value || "");
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(s)) fail(400, `${name} muss im Format HH:MM sein`);
  return s.padStart(5, "0");
};

export function register(r) {
  r.get("/api/dashboard", () => {
    const tz = appTimezone();
    const now = Date.now();
    const today = startOfDay(now, tz);
    const week = now - 7 * DAY_MS;
    const count = (type, since) => q.value("SELECT COUNT(*) FROM events WHERE type = ? AND created_at >= ?", type, since);
    const sentWeek = count("sent", week);
    const contactedWeek = q.value("SELECT COUNT(DISTINCT lead_id) FROM events WHERE type = 'sent' AND created_at >= ?", week);
    const kpis = {
      sent_today: count("sent", today),
      sent_week: sentWeek,
      replies_week: count("reply", week),
      interested_week: count("interested", week),
      bounces_week: count("bounce", week),
      unsubscribes_week: count("unsubscribe", week),
      unread: q.value("SELECT COUNT(*) FROM conversations WHERE has_inbound = 1 AND unread > 0"),
      reply_rate_week: contactedWeek ? Math.round(count("reply", week) / contactedWeek * 1000) / 10 : 0,
      bounce_rate_week: sentWeek ? Math.round(count("bounce", week) / sentWeek * 1000) / 10 : 0,
      leads_total: q.value("SELECT COUNT(*) FROM leads"),
      leads_queued: q.value("SELECT COUNT(*) FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE c.status = 'active' AND cl.status IN ('queued','active')"),
      meetings_week: count("meeting", week),
      nurture_week: count("nurture_sent", week),
      tasks_open: q.value("SELECT COUNT(*) FROM tasks WHERE status = 'open'"),
      tasks_due: q.value("SELECT COUNT(*) FROM tasks WHERE status = 'open' AND due_at <= ?", now)
    };
    const series = new Map();
    for (let i = 13; i >= 0; i--) { const d = dayKey(now - i * DAY_MS, tz); series.set(d, { day: d, sent: 0, replies: 0, interested: 0 }); }
    for (const e of q.all("SELECT type, created_at FROM events WHERE created_at >= ? AND type IN ('sent','reply','interested')", now - 14 * DAY_MS)) {
      const d = series.get(dayKey(e.created_at, tz));
      if (d) d[e.type === "sent" ? "sent" : e.type === "reply" ? "replies" : "interested"]++;
    }
    const sent = sentTodayByMailbox(now);
    const mailboxes = q.all("SELECT * FROM mailboxes ORDER BY email").map(m => publicMailbox(m, sent, now));
    const campaigns = q.all("SELECT id, name, status FROM campaigns WHERE status IN ('active','paused') AND is_template = 0 ORDER BY updated_at DESC LIMIT 8").map(c => {
      const s = q.get(`SELECT (SELECT COUNT(*) FROM events WHERE campaign_id = ? AND type = 'sent') AS sent, (SELECT COUNT(DISTINCT lead_id) FROM events WHERE campaign_id = ? AND type = 'reply') AS replies,
        (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = ? AND status IN ('queued','active')) AS pending, (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = ?) AS leads`, c.id, c.id, c.id, c.id);
      return { ...c, ...s };
    });
    const setup = {
      mailbox: q.value("SELECT COUNT(*) FROM mailboxes") > 0,
      target_group: q.value("SELECT COUNT(*) FROM target_groups") > 0,
      product: q.value("SELECT COUNT(*) FROM products") > 0,
      template: q.value("SELECT COUNT(*) FROM campaigns WHERE approved_hash IS NOT NULL") > 0,
      privacy: !!getSettings().privacy_url,
      knowledge: q.value("SELECT COUNT(*) FROM knowledge_docs") > 0,
      leads: kpis.leads_total > 0,
      campaign: q.value("SELECT COUNT(*) FROM campaigns WHERE launched_at IS NOT NULL") > 0,
      footer: !!getSettings().footer_text,
      ai: aiAvailable()
    };
    return { kpis, series: [...series.values()], mailboxes, campaigns, setup };
  });

  r.get("/api/meta", () => ({
    variables: VARIABLES, labels: LABELS, webhook_events: WEBHOOK_EVENTS, ai_available: aiAvailable(), ai_provider: aiProvider(), app_url: config.appUrl, tracking_url: config.trackingUrl,
    task_types: TASK_TYPES, call_outcomes: CALL_OUTCOMES, legal_bases: LEGAL_BASES, consent_statuses: CONSENT_STATUSES, fit_labels: FIT_LABELS, offer_types: OFFER_TYPES
  }));

  r.get("/api/settings", ({ user }) => publicSettings(user));

  r.put("/api/settings", ({ body, user }) => {
    requireAdmin(user);
    const patch = {};
    for (const k of ["company_name", "privacy_url", "booking_url", "warmup_folder"]) if (body[k] !== undefined) patch[k] = v.str(body[k], { max: 500 });
    for (const k of ["footer_text", "unsubscribe_text", "sender_context"]) if (body[k] !== undefined) patch[k] = v.text(body[k], { max: k === "sender_context" ? 20000 : 3000 });
    if (body.timezone !== undefined) {
      if (!isValidTimezone(body.timezone)) fail(400, "Ungültige Zeitzone");
      patch.timezone = body.timezone;
    }
    if (body.webhook_url !== undefined) {
      const url = v.str(body.webhook_url, { max: 1000 });
      if (url && !/^https:\/\//i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/i.test(url)) fail(400, "Webhook-URL muss mit https:// beginnen");
      patch.webhook_url = url;
    }
    if (body.webhook_secret !== undefined && body.webhook_secret !== "••••••••") patch.webhook_secret = v.str(body.webhook_secret, { max: 200 });
    if (Array.isArray(body.webhook_events)) patch.webhook_events = body.webhook_events.filter(e => WEBHOOK_EVENTS.includes(e));
    if (body.auto_classify !== undefined) patch.auto_classify = !!body.auto_classify;
    if (body.booking_prefill !== undefined) patch.booking_prefill = !!body.booking_prefill;
    if (body.skip_freemail_cold !== undefined) patch.skip_freemail_cold = !!body.skip_freemail_cold;
    if (body.guess_chief_emails !== undefined) patch.guess_chief_emails = !!body.guess_chief_emails;
    if (body.cold_exclude_terms !== undefined) patch.cold_exclude_terms = v.text(body.cold_exclude_terms, { max: 4000, name: "Ausschluss-Begriffe" });
    if (body.cooldown_days !== undefined) patch.cooldown_days = v.int(body.cooldown_days, { min: 0, max: 730, name: "Sperrfrist" });
    if (body.not_interested_hold_days !== undefined) patch.not_interested_hold_days = v.int(body.not_interested_hold_days, { min: 30, max: 1825, name: "Sperre nach „kein Interesse“" });
    if (body.company_cap_30d !== undefined) patch.company_cap_30d = v.int(body.company_cap_30d, { min: 0, max: 50, name: "Kontakte je Firma" });
    if (body.ai_daily_limit !== undefined) patch.ai_daily_limit = v.int(body.ai_daily_limit, { min: 0, max: 5000, name: "KI-Tageslimit" });
    if (body.watch_interval_days !== undefined) patch.watch_interval_days = v.int(body.watch_interval_days, { min: 7, max: 365, name: "Beobachtungs-Intervall" });
    if (body.watch_daily_limit !== undefined) patch.watch_daily_limit = v.int(body.watch_daily_limit, { min: 0, max: 500, name: "Recherchen pro Tag" });
    if (body.reply_sla_minutes !== undefined) patch.reply_sla_minutes = v.int(body.reply_sla_minutes, { min: 5, max: 1440, name: "Antwortziel" });
    if (body.creepy_threshold !== undefined) patch.creepy_threshold = v.int(body.creepy_threshold, { min: 10, max: 90, name: "Creepy-Grenze" });
    if (body.nurture_window_start !== undefined) patch.nurture_window_start = hm(body.nurture_window_start, "Nachfassen ab");
    if (body.nurture_window_end !== undefined) patch.nurture_window_end = hm(body.nurture_window_end, "Nachfassen bis");
    if (body.nurture_weekdays !== undefined) {
      const days = [...new Set((Array.isArray(body.nurture_weekdays) ? body.nurture_weekdays : String(body.nurture_weekdays).split(",")).map(Number).filter(d => d >= 1 && d <= 7))].sort();
      if (!days.length) fail(400, "Mindestens ein Wochentag fürs Nachfassen");
      patch.nurture_weekdays = days.join(",");
    }
    if (patch.booking_url) {
      try { if (!/^https?:$/.test(new URL(patch.booking_url).protocol)) throw new Error(); } catch { fail(400, "Termin-Link muss mit https:// beginnen"); }
    }
    if (patch.unsubscribe_text !== undefined && patch.unsubscribe_text && !patch.unsubscribe_text.includes("{{unsubscribe_url}}")) fail(400, "Der Abmelde-Text muss {{unsubscribe_url}} enthalten.");
    saveSettings(patch);
    return publicSettings(user);
  });

  r.post("/api/settings/test-webhook", () => testWebhook());

  // Neue Adresse für den Buchungs-Webhook (z. B. wenn die alte bekannt wurde).
  r.post("/api/settings/booking-secret", ({ user }) => {
    requireAdmin(user);
    saveSettings({ booking_hook_secret: token(24) });
    return publicSettings(user);
  });

  r.get("/api/system/ai", () => ({ ...aiUsage(), available: aiAvailable() }));
  r.post("/api/system/ai/resume", ({ user }) => {
    requireAdmin(user);
    resumeAi();
    return { ...aiUsage(), available: aiAvailable() };
  });

  r.get("/api/system", () => ({
    version: "1.0.0",
    app_url: config.appUrl,
    tracking_url: config.trackingUrl,
    ai: { available: aiAvailable(), ...aiUsage(), fallbacks: config.aiFallbacks },
    scheduler: { ...schedulerState, interval_ms: config.schedulerIntervalMs, workers: config.workers },
    sync: { ...syncLoopState, interval_ms: config.syncIntervalMs },
    timezone: appTimezone(),
    db: { leads: q.value("SELECT COUNT(*) FROM leads"), messages: q.value("SELECT COUNT(*) FROM messages"), events: q.value("SELECT COUNT(*) FROM events") }
  }));

  r.post("/api/system/run", async ({ body, user }) => {
    requireAdmin(user);
    if (body.job === "send") return tick();
    if (body.job === "sync") { await syncAll(); return { ok: true }; }
    fail(400, "Unbekannter Job");
  });

  // Benutzer
  r.get("/api/users", ({ user }) => {
    requireAdmin(user);
    return q.all("SELECT * FROM users ORDER BY created_at").map(publicUser);
  });
  r.post("/api/users", ({ body, user }) => {
    requireAdmin(user);
    const email = v.email(body.email);
    if (q.get("SELECT 1 FROM users WHERE email = ?", email)) fail(409, "Benutzer existiert bereits");
    const password = v.str(body.password, { max: 200, required: true, name: "Passwort" });
    if (password.length < 12) fail(400, "Passwort muss mindestens 12 Zeichen haben");
    const id = insert("users", { email, name: v.str(body.name, { max: 120 }), password_hash: hashPassword(password), role: v.oneOf(body.role, ["admin", "member"], "member"), created_at: Date.now() });
    return publicUser(q.get("SELECT * FROM users WHERE id = ?", id));
  });
  r.put("/api/users/:id", ({ params, body, user }) => {
    requireAdmin(user);
    const id = v.id(params.id);
    const existing = q.get("SELECT * FROM users WHERE id = ?", id) || fail(404, "Benutzer nicht gefunden");
    const row = { name: v.str(body.name ?? existing.name, { max: 120 }), role: v.oneOf(body.role ?? existing.role, ["admin", "member"], existing.role) };
    if (existing.role === "admin" && row.role !== "admin" && q.value("SELECT COUNT(*) FROM users WHERE role = 'admin'") <= 1) fail(400, "Mindestens ein Administrator muss bleiben");
    if (body.password) {
      if (String(body.password).length < 12) fail(400, "Passwort muss mindestens 12 Zeichen haben");
      row.password_hash = hashPassword(body.password);
      q.run("DELETE FROM sessions WHERE user_id = ?", id);
    }
    update("users", id, row);
    return publicUser(q.get("SELECT * FROM users WHERE id = ?", id));
  });
  r.delete("/api/users/:id", ({ params, user }) => {
    requireAdmin(user);
    const id = v.id(params.id);
    if (id === user.id) fail(400, "Eigenes Konto kann nicht gelöscht werden");
    const target = q.get("SELECT * FROM users WHERE id = ?", id) || fail(404, "Benutzer nicht gefunden");
    if (target.role === "admin" && q.value("SELECT COUNT(*) FROM users WHERE role = 'admin'") <= 1) fail(400, "Mindestens ein Administrator muss bleiben");
    q.run("DELETE FROM users WHERE id = ?", id);
    return { ok: true };
  });
  r.post("/api/me/password", ({ body, user, session }) => {
    const current = q.get("SELECT * FROM users WHERE id = ?", user.id);
    if (!verifyPassword(body.current || "", current.password_hash)) fail(400, "Aktuelles Passwort ist falsch");
    if (String(body.password || "").length < 12) fail(400, "Neues Passwort muss mindestens 12 Zeichen haben");
    q.run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(body.password), user.id);
    q.run("DELETE FROM sessions WHERE user_id = ? AND id != ?", user.id, session.id);
    return { ok: true };
  });
}
