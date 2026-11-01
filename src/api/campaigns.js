// API: Kampagnen mit Sequenz (Schritte + A/B-Varianten), Leads, Start/Pause, Vorschau, Testversand, Statistik.
import { q, tx, insert, update, parseJson, likeAny } from "../db.js";
import { fail, v } from "../http.js";
import { isValidTimezone, dayKey, nextWindowStart, DAY_MS } from "../lib/time.js";
import { loadSteps, renderStep, enabledVariants } from "../mail/compose.js";
import { lintTemplate } from "../lib/template.js";
import { checkCopy } from "../lib/spam.js";
import { sendTestStep } from "../engine/sender.js";
import { ensurePersonalization, aiAvailable, reviewCopy } from "../ai/features.js";
import { imapConfigured } from "../mail/imap.js";
import { describeSmtpError } from "../mail/transport.js";
import { getSettings } from "../settings.js";
import { approvalState, complianceIssues, enrollBlock, nurtureTexts, LEGAL_BASES } from "../engine/rules.js";
import { advance } from "../intel/lifecycle.js";

const CL_STATUSES = ["queued", "active", "paused", "completed", "replied", "bounced", "unsubscribed", "blocked", "invalid", "stopped", "skipped", "error"];
const LETTERS = "ABCDEFGH";

function readCampaign(body, existing = {}) {
  const get = k => (body[k] !== undefined ? body[k] : existing[k]);
  const timezone = String(get("timezone") || getSettings().timezone || "Europe/Berlin");
  if (!isValidTimezone(timezone)) fail(400, "Ungültige Zeitzone");
  const daysRaw = get("days");
  const days = (Array.isArray(daysRaw) ? daysRaw : String(daysRaw ?? "1,2,3,4,5").split(",")).map(Number).filter(d => d >= 1 && d <= 7);
  const hm = (value, name) => {
    const s = String(value || "");
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(s)) fail(400, `${name} muss im Format HH:MM sein`);
    return s.padStart(5, "0");
  };
  const mailboxIds = (Array.isArray(get("mailbox_ids")) ? get("mailbox_ids") : parseJson(get("mailbox_ids"), [])).map(Number).filter(Number.isInteger);
  const existingIds = new Set(q.all("SELECT id FROM mailboxes").map(r => r.id));
  const minGap = v.int(get("min_gap_sec"), { min: 30, max: 86400, fallback: 240 });
  const tgId = get("target_group_id");
  const productId = get("product_id");
  if (productId && !q.get("SELECT 1 FROM products WHERE id = ?", Number(productId))) fail(400, "Produkt nicht gefunden");
  const playId = get("play_id");
  if (playId && !q.get("SELECT 1 FROM plays WHERE id = ?", Number(playId))) fail(400, "Play nicht gefunden");
  const nurtureRaw = get("nurture_texts");
  const nurture = (Array.isArray(nurtureRaw) ? nurtureRaw : parseJson(nurtureRaw, []) || []).slice(0, 5)
    .map(t => ({ body: v.text(typeof t === "string" ? t : t?.body, { max: 5000, name: "Nachfass-Text" }) }))
    .filter(t => t.body.trim());
  return {
    name: v.str(get("name"), { max: 160, required: true, name: "Name" }),
    target_group_id: tgId ? v.id(tgId, "Zielgruppe") : null,
    product_id: productId ? v.id(productId, "Produkt") : null,
    play_id: playId ? v.id(playId, "Play") : null,
    legal_basis: v.oneOf(get("legal_basis") || "consent", Object.keys(LEGAL_BASES), "consent"),
    min_fit: v.oneOf(get("min_fit") ?? "", ["", "A", "B", "C"], ""),
    auto_list_id: get("auto_list_id") ? v.id(get("auto_list_id"), "Liste") : null,
    nurture_enabled: v.bool(get("nurture_enabled"), true),
    nurture_days: v.int(get("nurture_days"), { min: 1, max: 30, fallback: 3 }),
    nurture_max: v.int(get("nurture_max"), { min: 0, max: 5, fallback: 2 }),
    nurture_mode: v.oneOf(get("nurture_mode") || "auto", ["auto", "draft"], "auto"),
    nurture_texts: JSON.stringify(nurture),
    call_on_interest: v.bool(get("call_on_interest"), false),
    call_after_sequence: v.bool(get("call_after_sequence"), false),
    timezone,
    days: [...new Set(days)].sort().join(","),
    window_start: hm(get("window_start") ?? "08:00", "Startzeit"),
    window_end: hm(get("window_end") ?? "17:00", "Endzeit"),
    daily_limit: v.int(get("daily_limit"), { min: 1, max: 10000, fallback: 50, name: "Tageslimit" }),
    ramp_enabled: v.bool(get("ramp_enabled"), false),
    ramp_week1: v.int(get("ramp_week1"), { min: 1, max: 10000, fallback: 150, name: "Limit Woche 1" }),
    ramp_week2: v.int(get("ramp_week2"), { min: 1, max: 10000, fallback: 250, name: "Limit Woche 2" }),
    min_gap_sec: minGap,
    max_gap_sec: Math.max(minGap, v.int(get("max_gap_sec"), { min: 30, max: 86400, fallback: 600 })),
    stop_on_reply: v.bool(get("stop_on_reply"), true),
    stop_on_auto_reply: v.bool(get("stop_on_auto_reply"), false),
    stop_company_on_reply: v.bool(get("stop_company_on_reply"), true),
    track_opens: v.bool(get("track_opens"), false),
    track_clicks: v.bool(get("track_clicks"), false),
    unsubscribe: v.bool(get("unsubscribe"), true),
    skip_missing_vars: v.bool(get("skip_missing_vars"), true),
    skip_risky: v.bool(get("skip_risky"), false),
    ai_mode: v.oneOf(get("ai_mode") || "off", ["off", "first_line", "full"], "off"),
    ai_instructions: v.text(get("ai_instructions") ?? "", { max: 4000 }),
    mailbox_ids: JSON.stringify([...new Set(mailboxIds.filter(id => existingIds.has(id)))]),
    start_at: get("start_at") ? v.int(get("start_at"), { min: 0 }) : null
  };
}

function saveSteps(campaignId, steps) {
  if (!Array.isArray(steps)) fail(400, "Schritte müssen eine Liste sein");
  if (steps.length > 12) fail(400, "Maximal 12 Schritte");
  tx(() => {
    q.run("DELETE FROM campaign_steps WHERE campaign_id = ?", campaignId);
    steps.forEach((s, i) => {
      const variants = (Array.isArray(s.variants) ? s.variants : [{ subject: s.subject, body: s.body }]).slice(0, LETTERS.length).map((variant, j) => ({
        key: LETTERS[j],
        subject: v.str(variant.subject, { max: 300, name: "Betreff" }),
        body: v.text(variant.body, { max: 20000, name: "Text" }),
        enabled: variant.enabled !== false
      }));
      if (!variants.length) variants.push({ key: "A", subject: "", body: "", enabled: true });
      insert("campaign_steps", { campaign_id: campaignId, position: i, delay_days: i === 0 ? 0 : v.num(s.delay_days, { min: 0, max: 90, fallback: 3 }), variants: JSON.stringify(variants) });
    });
  });
}

export function campaignStats(campaignId, { days = 30 } = {}) {
  const c = q.get("SELECT * FROM campaigns WHERE id = ?", campaignId);
  const statusRows = q.all("SELECT status, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? GROUP BY status", campaignId);
  const leads = Object.fromEntries(statusRows.map(r => [r.status, r.n]));
  const totalLeads = statusRows.reduce((a, r) => a + r.n, 0);
  const sent = q.get(`SELECT COUNT(*) AS sent, COUNT(DISTINCT lead_id) AS contacted, SUM(CASE WHEN first_open_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
    SUM(CASE WHEN first_click_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked FROM messages WHERE campaign_id = ? AND direction = 'out' AND kind = 'campaign' AND status != 'failed'`, campaignId);
  const ev = Object.fromEntries(q.all("SELECT type, COUNT(DISTINCT lead_id) AS n FROM events WHERE campaign_id = ? GROUP BY type", campaignId).map(r => [r.type, r.n]));
  const contacted = sent.contacted || 0;
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const totals = {
    leads: totalLeads, sent: sent.sent || 0, contacted, opened: sent.opened || 0, clicked: sent.clicked || 0,
    replied: ev.reply || 0, interested: ev.interested || 0, bounced: ev.bounce || 0, unsubscribed: ev.unsubscribe || 0, auto_replies: ev.auto_reply || 0,
    reply_rate: pct(ev.reply || 0, contacted), interest_rate: pct(ev.interested || 0, contacted), bounce_rate: pct(ev.bounce || 0, contacted),
    open_rate: pct(sent.opened || 0, sent.sent || 0), click_rate: pct(sent.clicked || 0, sent.sent || 0)
  };
  const perVariant = q.all(`SELECT step, variant, COUNT(*) AS sent, SUM(CASE WHEN first_open_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
    SUM(CASE WHEN first_click_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked, SUM(CASE WHEN status = 'bounced' THEN 1 ELSE 0 END) AS bounced
    FROM messages WHERE campaign_id = ? AND direction = 'out' AND kind = 'campaign' AND status != 'failed' GROUP BY step, variant ORDER BY step, variant`, campaignId);
  const replyBy = q.all("SELECT step, variant, COUNT(DISTINCT lead_id) AS n FROM events WHERE campaign_id = ? AND type = 'reply' GROUP BY step, variant", campaignId);
  const interestBy = q.all(`SELECT m.step, m.variant, COUNT(DISTINCT e.lead_id) AS n FROM events e
    JOIN messages m ON m.id = (SELECT id FROM messages WHERE campaign_id = e.campaign_id AND lead_id = e.lead_id AND direction = 'in' ORDER BY created_at LIMIT 1)
    WHERE e.campaign_id = ? AND e.type = 'interested' GROUP BY m.step, m.variant`, campaignId);
  const key = (s, va) => `${s}:${va}`;
  const replies = new Map(replyBy.map(r => [key(r.step, r.variant), r.n]));
  const interests = new Map(interestBy.map(r => [key(r.step, r.variant), r.n]));
  const variants = perVariant.map(r => ({
    ...r, replied: replies.get(key(r.step, r.variant)) || 0, interested: interests.get(key(r.step, r.variant)) || 0,
    reply_rate: pct(replies.get(key(r.step, r.variant)) || 0, r.sent), open_rate: pct(r.opened, r.sent)
  }));
  const tz = c?.timezone || "Europe/Berlin";
  const since = Date.now() - days * DAY_MS;
  const series = new Map();
  for (let i = days - 1; i >= 0; i--) series.set(dayKey(Date.now() - i * DAY_MS, tz), { day: dayKey(Date.now() - i * DAY_MS, tz), sent: 0, replies: 0, opens: 0, bounces: 0 });
  for (const e of q.all("SELECT type, created_at FROM events WHERE campaign_id = ? AND created_at >= ? AND type IN ('sent','reply','open','bounce')", campaignId, since)) {
    const day = series.get(dayKey(e.created_at, tz));
    if (!day) continue;
    if (e.type === "sent") day.sent++; else if (e.type === "reply") day.replies++; else if (e.type === "open") day.opens++; else if (e.type === "bounce") day.bounces++;
  }
  return { totals, leads, variants, series: [...series.values()] };
}

export function campaignFull(id) {
  const c = q.get("SELECT * FROM campaigns WHERE id = ?", id);
  if (!c) return null;
  const loaded = loadSteps(id);
  const steps = loaded.map(s => ({ id: s.id, position: s.position, delay_days: s.delay_days, variants: s.variants }));
  const tg = c.target_group_id ? q.get("SELECT id, name, language FROM target_groups WHERE id = ?", c.target_group_id) : null;
  const product = c.product_id ? q.get("SELECT id, name, booking_url, kit_url, kit_label FROM products WHERE id = ?", c.product_id) : null;
  const nextSend = c.status === "active" ? nextWindowStart(c, Date.now()) : null;
  const { approved_hash, ...rest } = c;
  return {
    ...rest, mailbox_ids: parseJson(c.mailbox_ids, []), nurture_texts: nurtureTexts(c), steps, target_group: tg, product,
    approval: approvalState(c, loaded), next_window_at: nextSend, stats: c.is_template ? null : campaignStats(id).totals
  };
}

export function launchCheck(id) {
  const c = q.get("SELECT * FROM campaigns WHERE id = ?", id);
  const errors = [], warnings = [];
  const steps = loadSteps(id);
  if (!steps.length) errors.push("Die Sequenz hat noch keinen Schritt.");
  steps.forEach((s, i) => {
    const vs = enabledVariants(s);
    if (!vs.length || !vs.some(x => String(x.body || "").trim())) errors.push(`Schritt ${i + 1} hat keinen Text.`);
    if (i === 0 && vs.some(x => !String(x.subject || "").trim())) errors.push("Schritt 1 braucht einen Betreff (jede Variante).");
    for (const x of vs) for (const p of [...lintTemplate(x.subject), ...lintTemplate(x.body)]) errors.push(`Schritt ${i + 1}, Variante ${x.key}: ${p}`);
  });
  const ids = parseJson(c.mailbox_ids, []);
  const boxes = ids.length ? q.all("SELECT * FROM mailboxes WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(ids.map(Number))) : [];
  if (!boxes.length) errors.push("Kein Postfach ausgewählt.");
  else if (!boxes.some(b => b.status === "active")) errors.push("Keines der ausgewählten Postfächer ist aktiv.");
  const noImap = boxes.filter(b => !imapConfigured(b));
  if (noImap.length) warnings.push(`Ohne IMAP werden Antworten nicht erkannt und Sequenzen nicht gestoppt: ${noImap.map(b => b.email).join(", ")}`);
  const leadCount = q.value("SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = ? AND status IN ('queued','active')", id);
  if (!leadCount) errors.push("Keine Leads in der Kampagne.");
  const unverified = q.value("SELECT COUNT(*) FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = ? AND l.verify_status = 'unknown'", id);
  if (unverified) warnings.push(`${unverified} Leads sind noch nicht geprüft – vor dem Start „E-Mails prüfen“ senkt die Bounce-Rate.`);
  if (c.ai_mode !== "off" && !aiAvailable()) errors.push("KI-Personalisierung ist aktiv, aber die KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN für das Max-Abo).");
  if (c.ai_mode === "full") warnings.push("KI-Volltext formuliert die freigegebenen Texte je Lead um – Stichproben in der Vorschau prüfen.");
  const compliance = complianceIssues(c, steps);
  errors.push(...compliance.errors);
  warnings.push(...compliance.warnings);
  const approval = approvalState(c, steps);
  if (!approval.approved) errors.push(approval.outdated ? "Die Texte wurden nach der Freigabe geändert – bitte erneut prüfen und freigeben." : "Die Texte sind noch nicht freigegeben (Sequenz prüfen → „Texte freigeben“).");
  if (c.is_template) errors.push("Das ist eine Vorlage – daraus zuerst eine Kampagne erstellen.");
  if (c.ai_mode !== "off" && !c.target_group_id) warnings.push("KI-Personalisierung ohne Zielgruppe – die KI kennt dann nur das allgemeine Angebot.");
  if (c.track_opens || c.track_clicks) warnings.push("Öffnungs-/Klick-Tracking verschlechtert die Zustellbarkeit leicht (HTML statt reinem Text).");
  if (!String(c.days || "").trim()) errors.push("Keine Versandtage ausgewählt.");
  const capacity = boxes.filter(b => b.status === "active").reduce((a, b) => a + (b.daily_limit || 0), 0);
  if (capacity && capacity < c.daily_limit) warnings.push(`Die ausgewählten Postfächer schaffen zusammen max. ${capacity} Mails/Tag (Kampagnenlimit ${c.daily_limit}).`);
  return { ok: !errors.length, errors: [...new Set(errors)], warnings: [...new Set(warnings)], leads: leadCount, approval };
}

// Autopilot: Kampagnen mit „Liste automatisch nachladen“ bekommen neue Listen-Mitglieder; wer vor der ersten Mail aus der
// Liste geflogen ist (z. B. „nicht passend“ nach der Recherche), wird wieder ausgetragen. Läuft im Scheduler-Takt.
export function autoEnrollTick() {
  const out = { added: 0, removed: 0 };
  for (const c of q.all("SELECT * FROM campaigns WHERE auto_list_id IS NOT NULL AND status IN ('active','draft','paused') AND is_template = 0")) {
    if (!q.get("SELECT 1 FROM lead_lists WHERE id = ?", c.auto_list_id)) continue;
    const fresh = q.all(`SELECT m.lead_id FROM lead_list_members m WHERE m.list_id = ? AND NOT EXISTS (SELECT 1 FROM campaign_leads cl WHERE cl.campaign_id = ? AND cl.lead_id = m.lead_id) ORDER BY m.added_at, m.lead_id LIMIT 500`, c.auto_list_id, c.id).map(r => r.lead_id);
    if (fresh.length) out.added += enroll(c.id, fresh).added;
    const gone = q.run(`DELETE FROM campaign_leads WHERE campaign_id = ? AND status = 'queued' AND step = 0 AND lead_id NOT IN (SELECT lead_id FROM lead_list_members WHERE list_id = ?)`, c.id, c.auto_list_id).changes;
    out.removed += Number(gone) || 0;
  }
  return out;
}

export function enroll(campaignId, leadIds) {
  const c = q.get("SELECT * FROM campaigns WHERE id = ?", campaignId);
  const result = { added: 0, already: 0, skipped: 0, reasons: {} };
  const settings = getSettings();
  const now = Date.now();
  tx(() => {
    for (const leadId of leadIds) {
      const lead = q.get("SELECT * FROM leads WHERE id = ?", leadId);
      if (!lead) continue;
      let reason = q.get("SELECT 1 FROM blocklist WHERE value = ? OR value = ?", lead.email, lead.email.split("@")[1]) ? "gesperrt" : null;
      if (!reason && q.get("SELECT 1 FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?", campaignId, leadId)) { result.already++; continue; }
      if (!reason) reason = enrollBlock(c, lead, settings);
      if (reason) {
        result.skipped++;
        result.reasons[reason] = (result.reasons[reason] || 0) + 1;
        continue;
      }
      const res = q.run("INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, status, step, next_at, created_at) VALUES (?, ?, 'queued', 0, ?, ?)", campaignId, leadId, c.start_at || null, now);
      if (Number(res.changes)) {
        result.added++;
        if (lead.account_id) {
          if (c.play_id) q.run("UPDATE accounts SET play_id = COALESCE(play_id, ?) WHERE id = ?", c.play_id, lead.account_id);
          advance(lead.account_id, "outreach_ready", `In Kampagne „${c.name}“`);
        }
      } else result.already++;
    }
  });
  if (result.added && c.status === "completed") q.run("UPDATE campaigns SET status = 'active', completed_at = NULL WHERE id = ?", campaignId);
  return result;
}

function sampleLead(campaignId, leadId) {
  if (leadId) {
    const lead = q.get("SELECT * FROM leads WHERE id = ?", v.id(leadId)) || fail(404, "Lead nicht gefunden");
    const cl = q.get("SELECT * FROM campaign_leads WHERE campaign_id = ? AND lead_id = ?", campaignId, lead.id);
    return { lead, cl };
  }
  const cl = q.get("SELECT * FROM campaign_leads WHERE campaign_id = ? ORDER BY id LIMIT 1", campaignId);
  if (cl) return { lead: q.get("SELECT * FROM leads WHERE id = ?", cl.lead_id), cl };
  return { lead: { id: 0, email: "max.mustermann@beispiel-gmbh.de", salutation: "Herr", first_name: "Max", last_name: "Mustermann", company: "Beispiel GmbH", position: "Geschäftsführer", website: "beispiel-gmbh.de", city: "Köln", industry: "Handwerk", custom: "{}" }, cl: null };
}

function previewMailbox(c) {
  const ids = parseJson(c.mailbox_ids, []);
  return (ids.length ? q.get("SELECT * FROM mailboxes WHERE id IN (SELECT value FROM json_each(?)) ORDER BY status = 'active' DESC LIMIT 1", JSON.stringify(ids.map(Number))) : null)
    || q.get("SELECT * FROM mailboxes ORDER BY id LIMIT 1")
    || { id: 0, email: "sie@ihre-firma.de", from_name: "Ihr Name", signature: "" };
}

export function register(r) {
  r.get("/api/campaigns", () => q.all(`SELECT c.*, tg.name AS target_group_name, p.name AS product_name FROM campaigns c
    LEFT JOIN target_groups tg ON tg.id = c.target_group_id LEFT JOIN products p ON p.id = c.product_id
    WHERE c.is_template = 0 ORDER BY c.created_at DESC`)
    .map(({ approved_hash, ...c }) => ({ ...c, approved: !!approved_hash && approvalState({ ...c, approved_hash }, loadSteps(c.id)).approved, mailbox_ids: parseJson(c.mailbox_ids, []), nurture_texts: undefined, stats: campaignStats(c.id, { days: 1 }).totals })));

  r.post("/api/campaigns", ({ body }) => {
    const now = Date.now();
    const row = readCampaign({ ...body, name: body.name || "Neue Kampagne" });
    if (!body.mailbox_ids) row.mailbox_ids = JSON.stringify(q.all("SELECT id FROM mailboxes WHERE status = 'active'").map(m => m.id));
    const id = insert("campaigns", { ...row, status: "draft", created_at: now, updated_at: now });
    saveSteps(id, Array.isArray(body.steps) && body.steps.length ? body.steps : [{ delay_days: 0, variants: [{ subject: "", body: "{{anrede}},\n\n\n\nViele Grüße" }] }]);
    return campaignFull(id);
  });

  r.get("/api/campaigns/:id", ({ params }) => campaignFull(v.id(params.id)) || fail(404, "Kampagne nicht gefunden"));

  r.put("/api/campaigns/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const existing = q.get("SELECT * FROM campaigns WHERE id = ?", id) || fail(404, "Kampagne nicht gefunden");
    const row = readCampaign(body, existing);
    if (row.legal_basis !== existing.legal_basis) Object.assign(row, { cold_ack_at: null, cold_ack_by: null });
    let paused = false;
    tx(() => {
      update("campaigns", id, { ...row, updated_at: Date.now() });
      if (body.steps !== undefined) saveSteps(id, body.steps);
      // Laufende Kampagne mit geänderten Texten: anhalten, bis die neuen Texte freigegeben sind.
      const now = q.get("SELECT * FROM campaigns WHERE id = ?", id);
      if (existing.status === "active" && !approvalState(now, loadSteps(id)).approved) {
        q.run("UPDATE campaigns SET status = 'paused' WHERE id = ?", id);
        paused = true;
      }
    });
    return { ...campaignFull(id), paused_for_approval: paused };
  });

  r.delete("/api/campaigns/:id", ({ params }) => {
    q.run("DELETE FROM campaigns WHERE id = ?", v.id(params.id));
    return { ok: true };
  });

  r.post("/api/campaigns/:id/duplicate", ({ params }) => {
    const id = v.id(params.id);
    const c = q.get("SELECT * FROM campaigns WHERE id = ?", id) || fail(404, "Kampagne nicht gefunden");
    const now = Date.now();
    const { id: _, status, launched_at, completed_at, created_at, updated_at, ...rest } = c;
    const newId = insert("campaigns", { ...rest, name: `${c.name} (Kopie)`, status: "draft", created_at: now, updated_at: now });
    saveSteps(newId, loadSteps(id).map(s => ({ delay_days: s.delay_days, variants: s.variants })));
    return campaignFull(newId);
  });

  r.get("/api/campaigns/:id/check", ({ params }) => launchCheck(v.id(params.id)));

  // Texte freigeben: speichert den Hash des aktuellen Inhalts. Jede spätere Änderung hebt die Freigabe auf.
  r.post("/api/campaigns/:id/approve", ({ params, body, user }) => {
    const id = v.id(params.id);
    const c = q.get("SELECT * FROM campaigns WHERE id = ?", id) || fail(404, "Kampagne nicht gefunden");
    const steps = loadSteps(id);
    if (body.revoke) {
      q.run("UPDATE campaigns SET approved_hash = NULL, approved_at = NULL, approved_by = NULL WHERE id = ?", id);
      if (c.status === "active") q.run("UPDATE campaigns SET status = 'paused' WHERE id = ?", id);
      return campaignFull(id);
    }
    if (!steps.length) fail(400, "Die Sequenz hat noch keinen Schritt.");
    const issues = complianceIssues(c, steps);
    const content = issues.errors.filter(e => /^(Schritt|Nachfass-Text)/.test(e));
    if (content.length) fail(400, `Vor der Freigabe korrigieren: ${content.join(" ")}`, { errors: content });
    for (const [i, s] of steps.entries()) {
      for (const x of enabledVariants(s)) for (const p of [...lintTemplate(x.subject), ...lintTemplate(x.body)]) fail(400, `Schritt ${i + 1}, Variante ${x.key}: ${p}`);
    }
    const { hash } = approvalState(c, steps);
    q.run("UPDATE campaigns SET approved_hash = ?, approved_at = ?, approved_by = ?, updated_at = ? WHERE id = ?", hash, Date.now(), user.name || user.email, Date.now(), id);
    return campaignFull(id);
  });

  // Kaltakquise: ausdrückliche Bestätigung, dass das Risiko bekannt ist (wird mit Name und Zeit dokumentiert).
  r.post("/api/campaigns/:id/cold-ack", ({ params, body, user }) => {
    const id = v.id(params.id);
    const c = q.get("SELECT * FROM campaigns WHERE id = ?", id) || fail(404, "Kampagne nicht gefunden");
    if (c.legal_basis !== "cold") fail(400, "Nur für Kampagnen mit Rechtsgrundlage „Kaltakquise“");
    if (body.confirm !== true) fail(400, "Bitte die Bestätigung ankreuzen.");
    q.run("UPDATE campaigns SET cold_ack_at = ?, cold_ack_by = ?, updated_at = ? WHERE id = ?", Date.now(), user.name || user.email, Date.now(), id);
    return campaignFull(id);
  });

  r.post("/api/campaigns/:id/status", ({ params, body }) => {
    const id = v.id(params.id);
    const c = q.get("SELECT * FROM campaigns WHERE id = ?", id) || fail(404, "Kampagne nicht gefunden");
    const action = v.oneOf(body.action, ["launch", "pause", "resume"], null);
    if (action === "launch" || action === "resume") {
      const check = launchCheck(id);
      if (!check.ok) fail(400, check.errors.join(" "), check);
      q.run("UPDATE campaigns SET status = 'active', launched_at = COALESCE(launched_at, ?), completed_at = NULL, updated_at = ? WHERE id = ?", Date.now(), Date.now(), id);
      return { ...campaignFull(id), check };
    }
    if (c.status !== "active") fail(400, "Kampagne läuft nicht");
    q.run("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ?", Date.now(), id);
    return campaignFull(id);
  });

  r.get("/api/campaigns/:id/stats", ({ params, query }) => campaignStats(v.id(params.id), { days: v.int(query.get("days"), { min: 7, max: 120, fallback: 30 }) }));

  r.get("/api/campaigns/:id/leads", ({ params, query }) => {
    const id = v.id(params.id);
    const where = ["cl.campaign_id = ?"], args = [id];
    const status = query.get("status");
    if (status && CL_STATUSES.includes(status)) { where.push("cl.status = ?"); args.push(status); }
    const search = String(query.get("q") || "").trim();
    if (search) { const like = likeAny(search); where.push("(l.email LIKE ? ESCAPE '\\' OR l.company LIKE ? ESCAPE '\\' OR l.last_name LIKE ? ESCAPE '\\')"); args.push(like, like, like); }
    const limit = v.int(query.get("limit"), { min: 1, max: 500, fallback: 50 });
    const page = v.int(query.get("page"), { min: 1, fallback: 1 });
    const sql = where.join(" AND ");
    const total = q.value(`SELECT COUNT(*) FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE ${sql}`, ...args);
    const items = q.all(`SELECT cl.id, cl.lead_id, cl.status, cl.step, cl.next_at, cl.last_sent_at, cl.replied_at, cl.interest, cl.last_error, cl.mailbox_id, cl.ai,
      l.email, l.first_name, l.last_name, l.company, l.verify_status, m.email AS mailbox_email
      FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id LEFT JOIN mailboxes m ON m.id = cl.mailbox_id WHERE ${sql}
      ORDER BY cl.id LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit)
      .map(row => ({ ...row, ai: undefined, has_ai: row.ai && row.ai !== "{}" }));
    return { items, total, page, limit };
  });

  r.post("/api/campaigns/:id/leads", ({ params, body }) => {
    const id = v.id(params.id);
    q.get("SELECT 1 FROM campaigns WHERE id = ?", id) || fail(404, "Kampagne nicht gefunden");
    let leadIds = [];
    if (Array.isArray(body.lead_ids)) leadIds = body.lead_ids.map(Number).filter(Number.isInteger);
    if (body.list_id) leadIds = leadIds.concat(q.all("SELECT lead_id FROM lead_list_members WHERE list_id = ? ORDER BY added_at, lead_id", v.id(body.list_id)).map(r => r.lead_id));
    if (!leadIds.length) fail(400, "Keine Leads ausgewählt");
    return enroll(id, [...new Set(leadIds)]);
  });

  r.post("/api/campaigns/:id/leads/action", ({ params, body }) => {
    const id = v.id(params.id);
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger);
    if (!ids.length) fail(400, "Keine Einträge ausgewählt");
    const action = v.oneOf(body.action, ["pause", "resume", "stop", "remove", "restart", "regenerate_ai"], null);
    const list = JSON.stringify(ids);
    let changes = 0;
    if (action === "pause") changes = q.run(`UPDATE campaign_leads SET status = 'paused' WHERE campaign_id = ? AND id IN (SELECT value FROM json_each(?)) AND status IN ('queued','active')`, id, list).changes;
    if (action === "resume") changes = q.run(`UPDATE campaign_leads SET status = CASE WHEN step > 0 THEN 'active' ELSE 'queued' END, next_at = COALESCE(next_at, ?) WHERE campaign_id = ? AND id IN (SELECT value FROM json_each(?)) AND status IN ('paused','error','skipped')`, Date.now(), id, list).changes;
    if (action === "stop") changes = q.run(`UPDATE campaign_leads SET status = 'stopped', next_at = NULL WHERE campaign_id = ? AND id IN (SELECT value FROM json_each(?)) AND status IN ('queued','active','paused','error')`, id, list).changes;
    if (action === "remove") changes = q.run(`DELETE FROM campaign_leads WHERE campaign_id = ? AND id IN (SELECT value FROM json_each(?))`, id, list).changes;
    if (action === "restart") changes = q.run(`UPDATE campaign_leads SET status = 'queued', step = 0, next_at = NULL, attempts = 0, last_error = NULL, replied_at = NULL, thread_message_id = NULL, thread_subject = NULL, last_message_id = NULL, refs = '' WHERE campaign_id = ? AND id IN (SELECT value FROM json_each(?))`, id, list).changes;
    if (action === "regenerate_ai") changes = q.run(`UPDATE campaign_leads SET ai = '{}', ai_attempts = 0 WHERE campaign_id = ? AND id IN (SELECT value FROM json_each(?))`, id, list).changes;
    return { changes: Number(changes) };
  });

  r.post("/api/campaigns/:id/preview", async ({ params, body }) => {
    const id = v.id(params.id);
    const c = q.get("SELECT * FROM campaigns WHERE id = ?", id) || fail(404, "Kampagne nicht gefunden");
    const steps = Array.isArray(body.steps) ? body.steps.map((s, i) => ({ position: i, delay_days: s.delay_days, variants: (s.variants || []).map((x, j) => ({ ...x, key: LETTERS[j] })) })) : loadSteps(id);
    const stepIndex = v.int(body.step, { min: 0, max: Math.max(0, steps.length - 1), fallback: 0 });
    let { lead, cl } = sampleLead(id, body.lead_id);
    const mailbox = cl?.mailbox_id ? (q.get("SELECT * FROM mailboxes WHERE id = ?", cl.mailbox_id) || previewMailbox(c)) : previewMailbox(c);
    const campaign = { ...c, ...(body.ai_mode ? { ai_mode: body.ai_mode } : {}) };
    let aiError = null;
    if (body.generate_ai && campaign.ai_mode !== "off") {
      if (!cl) fail(400, "Für die KI-Vorschau muss der Lead in der Kampagne sein.");
      if (!aiAvailable()) fail(400, "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN fehlt).");
      try {
        const variantKey = parseJson(cl.variants, {})[stepIndex] || body.variant || "A";
        const ai = await ensurePersonalization({ campaign, steps, cl, lead, mailbox, stepIndex, variantKey, force: !!body.force });
        cl = { ...cl, ai: JSON.stringify(ai) };
      } catch (err) {
        aiError = err.message;
      }
    }
    const rendered = renderStep({ campaign, steps, stepIndex, variantKey: body.variant || (cl ? parseJson(cl.variants, {})[stepIndex] : null), lead, mailbox, cl });
    // Copy-Check auf die Vorlage (mit Variablen), nicht auf den fertigen Text mit Signatur und Fußzeile.
    const tpl = enabledVariants(steps[stepIndex]).find(x => x.key === rendered.variant) || {};
    const copy = checkCopy(stepIndex > 0 && !String(tpl.subject || "").trim() ? "" : tpl.subject, tpl.body);
    return { ...rendered, lead: { id: lead.id, email: lead.email, name: [lead.first_name, lead.last_name].filter(Boolean).join(" "), company: lead.company }, mailbox: { email: mailbox.email, from_name: mailbox.from_name }, ai_error: aiError, copy };
  });

  r.post("/api/campaigns/:id/test", async ({ params, body }) => {
    const id = v.id(params.id);
    const c = q.get("SELECT * FROM campaigns WHERE id = ?", id) || fail(404, "Kampagne nicht gefunden");
    const to = v.email(body.to, { name: "Empfänger" });
    const steps = loadSteps(id);
    const stepIndex = v.int(body.step, { min: 0, max: Math.max(0, steps.length - 1), fallback: 0 });
    const { lead, cl } = sampleLead(id, body.lead_id);
    const mailbox = body.mailbox_id ? q.get("SELECT * FROM mailboxes WHERE id = ?", v.id(body.mailbox_id)) : previewMailbox(c);
    if (!mailbox?.smtp_host) fail(400, "Kein Postfach zum Senden vorhanden");
    try {
      const rendered = await sendTestStep({ campaign: c, steps, stepIndex, lead, mailbox, to, cl });
      return { ok: true, subject: rendered.subject };
    } catch (err) {
      fail(502, describeSmtpError(err));
    }
  });

  r.post("/api/copy/check", ({ body }) => checkCopy(v.text(body.subject ?? "", { max: 1000 }), v.text(body.body ?? "", { max: 50000 })));

  r.post("/api/copy/review", async ({ body }) => {
    if (!aiAvailable()) fail(400, "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN fehlt).");
    return reviewCopy({
      subject: v.text(body.subject ?? "", { max: 1000 }), body: v.text(body.body ?? "", { max: 50000 }),
      targetGroupId: body.target_group_id ? v.id(body.target_group_id) : null, productId: body.product_id ? v.id(body.product_id) : null,
      legalBasis: v.oneOf(body.legal_basis || "consent", Object.keys(LEGAL_BASES), "consent")
    });
  });
}
