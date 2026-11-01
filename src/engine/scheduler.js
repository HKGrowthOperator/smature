// Versand-Takt: verteilt fällige Sequenz-Schritte auf verfügbare Postfächer (Rotation, Limits, Abstände, Zeitfenster).
import { q } from "../db.js";
import { parseJson } from "../db.js";
import { inWindow, startOfDay, DAY_MS } from "../lib/time.js";
import { loadSteps } from "../mail/compose.js";
import { effectiveDailyLimit, sentTodayByMailbox, mainSendingDomain, mailboxDomain, MAIN_PER_DAY } from "../mail/mailboxes.js";
import { sendCampaignStep } from "./sender.js";
import { recordEvent, emitWebhook } from "../events.js";
import { runWarmupTick } from "../mail/warmup.js";
import { approvalState } from "./rules.js";
import { runNurtureTick } from "./followup.js";
import { autoEnrollTick } from "../api/campaigns.js";
import { autopilotSettings, planDay } from "./autopilot.js";

let running = false;
let inflight = null;

// Für sauberes Herunterfahren: auf den laufenden Takt warten, damit eine gerade versendete Mail noch protokolliert wird.
export function schedulerIdle(timeoutMs = 9000) {
  if (!inflight) return Promise.resolve();
  return Promise.race([inflight, new Promise(r => setTimeout(r, timeoutMs).unref?.())]);
}
export const schedulerState = { lastTickAt: null, lastSent: 0, lastError: null, ticks: 0 };

function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function availableMailboxes(now = Date.now()) {
  const sentToday = sentTodayByMailbox(now);
  const list = q.all("SELECT * FROM mailboxes WHERE status = 'active' AND next_send_at <= ?", now);
  const out = new Map();
  for (const mb of list) {
    const remaining = effectiveDailyLimit(mb, now) - (sentToday.get(mb.id) || 0);
    if (remaining > 0) out.set(mb.id, { mb, remaining, sent: sentToday.get(mb.id) || 0 });
  }
  // Versand über die Hauptdomain: alle Postfächer dieser Domain teilen sich ein Tageslimit. Pro Takt sendet jedes Postfach
  // höchstens eine Mail – deshalb nur so viele Postfächer freigeben, wie heute noch Mails übrig sind.
  const main = mainSendingDomain();
  if (main) {
    const used = q.all("SELECT id, email FROM mailboxes").filter(m => mailboxDomain(m.email) === main).reduce((s, m) => s + (sentToday.get(m.id) || 0), 0);
    let budget = MAIN_PER_DAY - used;
    for (const slot of [...out.values()].filter(a => mailboxDomain(a.mb.email) === main).sort((a, b) => a.sent - b.sent)) {
      if (budget > 0) { slot.remaining = Math.min(slot.remaining, budget); budget--; }
      else out.delete(slot.mb.id);
    }
  }
  return out;
}

// Tageslimit der Kampagne, beim Hochfahren: Woche 1 → ramp_week1, Woche 2 → ramp_week2, danach das volle Tageslimit.
export function campaignDailyLimit(campaign, now = Date.now()) {
  const limit = Math.max(0, Number(campaign.daily_limit) || 0);
  if (!campaign.ramp_enabled) return limit;
  const weeks = Math.floor(Math.max(0, now - (campaign.launched_at || now)) / (7 * DAY_MS));
  if (weeks === 0) return Math.min(limit, Number(campaign.ramp_week1) || limit);
  if (weeks === 1) return Math.min(limit, Number(campaign.ramp_week2) || limit);
  return limit;
}

function campaignSentToday(campaign, now) {
  return q.value("SELECT COUNT(*) FROM messages WHERE campaign_id = ? AND direction = 'out' AND kind = 'campaign' AND created_at >= ?", campaign.id, startOfDay(now, campaign.timezone));
}

// Fällige Leads. Follow-ups bleiben bei ihrem Postfach: ist es gerade nicht frei (Abstand, Limit, Pause), warten sie,
// statt die Abfrage zu verstopfen. Nur wenn das Postfach gelöscht oder aus der Kampagne genommen wurde, wird neu verteilt.
function dueLeads(campaignId, now, limit, { freeIds, allowedIds }) {
  return q.all(`
    SELECT cl.*, l.email AS l_email, l.status AS l_status, l.verify_status AS l_verify_status
    FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
    WHERE cl.campaign_id = ? AND cl.status IN ('queued','active') AND (cl.next_at IS NULL OR cl.next_at <= ?)
      AND (cl.mailbox_id IS NULL
        OR cl.mailbox_id IN (SELECT value FROM json_each(?))
        OR cl.mailbox_id NOT IN (SELECT value FROM json_each(?))
        OR NOT EXISTS (SELECT 1 FROM mailboxes WHERE id = cl.mailbox_id))
    ORDER BY CASE WHEN cl.step > 0 THEN 0 ELSE 1 END, COALESCE(cl.next_at, 0), cl.id
    LIMIT ?`, campaignId, now, JSON.stringify(freeIds), JSON.stringify(allowedIds), limit);
}

export function completeFinishedCampaigns(now = Date.now()) {
  const done = q.all(`SELECT c.id, c.name FROM campaigns c WHERE c.status = 'active'
    AND EXISTS (SELECT 1 FROM campaign_leads WHERE campaign_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM campaign_leads WHERE campaign_id = c.id AND status IN ('queued','active','paused'))`);
  for (const c of done) {
    q.run("UPDATE campaigns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?", now, now, c.id);
    recordEvent("campaign_completed", { campaign_id: c.id });
    emitWebhook("campaign.completed", { campaign_id: c.id, name: c.name });
  }
  return done.length;
}

export async function tick(now = Date.now()) {
  if (running) return { skipped: true };
  running = true;
  let done;
  inflight = new Promise(r => { done = r; });
  let sent = 0;
  try {
    try { autoEnrollTick(); } catch (err) { recordEvent("error", { data: { where: "autoEnroll", message: err.message } }); }
    // Tages-Autopilot: Tagesmenge je Autopilot-Kampagne aus dem Tagesplan statt aus dem festen Kampagnen-Limit.
    let plan = null;
    if (autopilotSettings().enabled) {
      try { plan = planDay(now); } catch (err) { recordEvent("error", { data: { where: "autopilotPlan", message: err.message } }); }
    }
    const available = availableMailboxes(now);
    const campaigns = shuffle(q.all("SELECT * FROM campaigns WHERE status = 'active' AND (start_at IS NULL OR start_at <= ?)", now));
    for (const campaign of campaigns) {
      if (!available.size) break;
      if (!inWindow(campaign, now)) continue;
      const planned = plan?.quotas.get(campaign.id);
      let remaining = planned ? planned.quota - planned.sent : campaignDailyLimit(campaign, now) - campaignSentToday(campaign, now);
      if (remaining <= 0) continue;
      const allowed = new Set(parseJson(campaign.mailbox_ids, []).map(Number));
      const pool = () => [...available.values()].filter(a => allowed.has(a.mb.id));
      if (!pool().length) continue;
      const steps = loadSteps(campaign.id);
      if (!steps.length) continue;
      // Nur freigegebene Texte gehen raus. Wurde nach der Freigabe etwas geändert: Kampagne anhalten.
      if (campaign.is_template || !approvalState(campaign, steps).approved) {
        q.run("UPDATE campaigns SET status = 'paused', updated_at = ? WHERE id = ?", Date.now(), campaign.id);
        recordEvent("campaign_paused", { campaign_id: campaign.id, data: { reason: "Texte nicht freigegeben" } });
        continue;
      }
      const freeIds = pool().map(a => a.mb.id);
      const due = dueLeads(campaign.id, now, Math.max(4, freeIds.length * 3), { freeIds, allowedIds: [...allowed] });
      for (const row of due) {
        if (remaining <= 0 || !pool().length) break;
        let slot = null;
        const sticky = row.mailbox_id && allowed.has(row.mailbox_id) && q.get("SELECT 1 FROM mailboxes WHERE id = ?", row.mailbox_id);
        if (sticky) {
          // Follow-ups bleiben beim selben Postfach (gleicher Thread, gleicher Absender).
          slot = available.get(row.mailbox_id) || null;
          if (!slot) continue;
        }
        if (!slot) slot = pool().sort((a, b) => a.sent - b.sent || b.remaining - a.remaining)[0];
        if (!slot) break;
        const lead = q.get("SELECT * FROM leads WHERE id = ?", row.lead_id);
        if (!lead) continue;
        const cl = q.get("SELECT * FROM campaign_leads WHERE id = ?", row.id);
        const result = await sendCampaignStep({ campaign, steps, cl, lead, mailbox: slot.mb, now });
        if (result.status === "sent") {
          sent++; remaining--;
          slot.remaining--; slot.sent++;
          available.delete(slot.mb.id); // pro Takt max. eine Mail je Postfach – der Abstand regelt den Rest
        } else if (result.attempted) {
          available.delete(slot.mb.id);
        }
      }
    }
    const nurture = await runNurtureTick(now, available).catch(err => { schedulerState.lastError = `Nachfassen: ${err.message}`; return { sent: 0 }; });
    sent += nurture.sent || 0;
    completeFinishedCampaigns(now);
    await runWarmupTick(now).catch(err => { schedulerState.lastError = `Warmup: ${err.message}`; });
    schedulerState.lastError = null;
  } catch (err) {
    schedulerState.lastError = err.message;
    console.error("[scheduler]", err);
  } finally {
    running = false;
    done();
    inflight = null;
    schedulerState.lastTickAt = Date.now();
    schedulerState.lastSent = sent;
    schedulerState.ticks++;
  }
  return { sent };
}

let timer = null;
export function startScheduler(intervalMs) {
  stopScheduler();
  const loop = async () => {
    await tick().catch(() => {});
    timer = setTimeout(loop, intervalMs);
    timer.unref?.();
  };
  timer = setTimeout(loop, 3000);
  timer.unref?.();
}
export function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}
