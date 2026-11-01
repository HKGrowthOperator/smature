// Tages-Autopilot: verteilt die Versand-Kapazität aller Postfächer auf die Autopilot-Kampagnen der Projekte, hält die Pools
// mit automatischen Leadquellen-Läufen voll und räumt nie angeschriebene, nicht mehr gebrauchte Pool-Leads auf.
//
// Tagesplan (wird in jedem Versand-Takt neu gerechnet, ist über den Tag stabil, weil „heute schon gesendet“ auf beiden
// Seiten mitzählt):
//   1. Kapazität = Tageslimits (inkl. Ramp-up) aller Postfächer der Autopilot-Kampagnen, minus was diese Postfächer heute
//      schon für andere Kampagnen/Nachfassen verschickt haben. Hauptdomain-Weg: höchstens MAIN_PER_DAY für die Domain.
//   2. Zuerst die fälligen Folge-Mails (Stufe 2, 3, 4 …) – wer schon angeschrieben ist, bekommt seinen nächsten Schritt pünktlich.
//   3. Der Rest geht als Erst-Mails an die Projekte nach Anteil. Hat ein Projekt nicht genug Leads, wandert sein Rest zu den
//      anderen – so bleibt kein Platz ungenutzt.
import { q, tx, parseJson } from "../db.js";
import { getSettings, saveSettings } from "../settings.js";
import { startOfDay, dayKey, DAY_MS } from "../lib/time.js";
import { effectiveDailyLimit, sentTodayByMailbox, mainSendingDomain, mailboxDomain, MAIN_PER_DAY, appTimezone } from "../mail/mailboxes.js";
import { approvalState } from "./rules.js";
import { loadSteps } from "../mail/compose.js";
import { listProjects } from "../intel/projects.js";
import { PROFILES, profileFor, poolList, createRun } from "../intel/sourcing.js";
import { deleteLeadCompletely } from "../api/leads.js";
import { recordEvent } from "../events.js";

export const autopilotState = { lastTickAt: null, lastError: null, lastCleanup: null, lastRefill: [] };

const clampInt = (n, min, max) => Math.max(min, Math.min(max, Math.round(Number(n) || 0)));
const SOURCED = "Leadquelle:%";

export function autopilotSettings(s = getSettings()) {
  return {
    enabled: !!s.autopilot_enabled,
    shares: s.autopilot_shares && typeof s.autopilot_shares === "object" ? s.autopilot_shares : {},
    buffer_days: clampInt(s.autopilot_buffer_days ?? 7, 1, 60),
    max_age_days: clampInt(s.autopilot_lead_max_age_days ?? 60, 7, 730),
    refill: s.autopilot_refill !== false,
    cleanup: s.autopilot_cleanup !== false
  };
}

// Autopilot-Kampagne je Projekt = Kampagne, die den Pool des Projekts nachlädt (auto_list_id = Pool-Liste).
function autopilotCampaigns() {
  const out = [];
  for (const p of listProjects()) {
    const list = poolList(p.id, { create: false });
    const c = list ? q.get("SELECT * FROM campaigns WHERE is_template = 0 AND auto_list_id = ? ORDER BY id DESC LIMIT 1", list.id) : null;
    out.push({ project: p, list, campaign: c });
  }
  return out;
}

function campaignReady(c, now) {
  if (!c || c.status !== "active" || (c.start_at && c.start_at > now)) return false;
  const steps = loadSteps(c.id);
  return steps.length > 0 && approvalState(c, steps).approved;
}

// Kapazität der Postfächer für den Autopiloten (Tageslimits, heute schon für Fremdes verbraucht).
function capacity(mailboxIds, autopilotIds, now) {
  if (!mailboxIds.size) return { total: 0, used_other: 0, available: 0, mailboxes: 0 };
  const boxes = q.all("SELECT * FROM mailboxes WHERE status = 'active' AND id IN (SELECT value FROM json_each(?))", JSON.stringify([...mailboxIds]));
  const main = mainSendingDomain();
  let total = 0, mainTotal = 0;
  for (const mb of boxes) {
    const lim = effectiveDailyLimit(mb, now);
    if (main && mailboxDomain(mb.email) === main) mainTotal += lim; else total += lim;
  }
  total += Math.min(mainTotal, main ? MAIN_PER_DAY : mainTotal);
  const since = startOfDay(now, appTimezone());
  const ids = JSON.stringify(boxes.map(b => b.id));
  const usedAll = [...sentTodayByMailbox(now).entries()].filter(([id]) => boxes.some(b => b.id === id)).reduce((s, [, n]) => s + n, 0);
  const usedAuto = q.value(`SELECT COUNT(*) FROM messages WHERE direction = 'out' AND kind = 'campaign' AND status != 'failed' AND created_at >= ?
    AND mailbox_id IN (SELECT value FROM json_each(?)) AND campaign_id IN (SELECT value FROM json_each(?))`, since, ids, JSON.stringify([...autopilotIds])) || 0;
  const usedOther = Math.max(0, usedAll - usedAuto);
  return { total, used_other: usedOther, available: Math.max(0, total - usedOther), mailboxes: boxes.length };
}

// Fair verteilen mit Obergrenzen („Wasserstand“): was ein Projekt nicht braucht, bekommen die anderen.
export function waterFill(amount, items) {
  const out = new Map(items.map(i => [i.key, 0]));
  let left = Math.max(0, Math.floor(amount));
  let open = items.filter(i => i.cap > 0 && i.weight > 0);
  while (left > 0 && open.length) {
    const wsum = open.reduce((s, i) => s + i.weight, 0);
    let given = 0;
    for (const i of open) {
      const want = Math.max(1, Math.floor(left * i.weight / wsum));
      const give = Math.min(want, i.cap - out.get(i.key), left - given);
      if (give > 0) { out.set(i.key, out.get(i.key) + give); given += give; }
      if (given >= left) break;
    }
    if (!given) break;
    left -= given;
    open = open.filter(i => out.get(i.key) < i.cap);
  }
  return out;
}

// Pool-Bestand: Leads im Pool, die noch nie eine Kampagnen-Mail bekommen haben und nicht gesperrt sind.
function poolStock(listId) {
  if (!listId) return 0;
  return q.value(`SELECT COUNT(*) FROM lead_list_members m JOIN leads l ON l.id = m.lead_id
    WHERE m.list_id = ? AND l.status = 'active' AND l.verify_status != 'invalid'
      AND NOT EXISTS (SELECT 1 FROM messages WHERE lead_id = l.id AND direction = 'out' AND kind = 'campaign')
      AND NOT EXISTS (SELECT 1 FROM campaign_leads WHERE lead_id = l.id AND status NOT IN ('queued','active','paused'))`, listId) || 0;
}

export function planDay(now = Date.now()) {
  const st = autopilotSettings();
  const rows = autopilotCampaigns();
  const ready = rows.filter(r => campaignReady(r.campaign, now));
  const boxIds = new Set(ready.flatMap(r => parseJson(r.campaign.mailbox_ids, []).map(Number)));
  const cap = capacity(boxIds, ready.map(r => r.campaign.id), now);
  const tz = appTimezone();
  const since = startOfDay(now, tz);
  const endOfDay = since + DAY_MS;

  const per = rows.map(r => {
    const base = { project_id: r.project.id, project: r.project.name, color: r.project.color, profile: profileFor(r.project), pool_list_id: r.list?.id || null,
      campaign_id: r.campaign?.id || null, campaign: r.campaign?.name || null, campaign_status: r.campaign?.status || null, ready: false,
      weight: Math.max(0, Number(st.shares[r.project.id] ?? 1)), pool_stock: poolStock(r.list?.id) };
    if (!r.campaign) return { ...base, problem: r.list ? "Keine Autopilot-Kampagne (Leadquellen → „Pool → Kampagne“)" : "Noch kein Pool" };
    if (!campaignReady(r.campaign, now)) {
      const steps = loadSteps(r.campaign.id);
      const approved = steps.length && approvalState(r.campaign, steps).approved;
      return { ...base, problem: !approved ? "Texte nicht freigegeben" : r.campaign.status !== "active" ? "Kampagne nicht gestartet" : "Startzeit liegt in der Zukunft" };
    }
    const c = r.campaign;
    const sent = q.all("SELECT step, COUNT(*) AS n FROM messages WHERE campaign_id = ? AND direction = 'out' AND kind = 'campaign' AND status != 'failed' AND created_at >= ? GROUP BY step", c.id, since);
    const due = q.all(`SELECT step, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? AND status IN ('queued','active') AND (next_at IS NULL OR next_at < ?) GROUP BY step`, c.id, endOfDay);
    const steps = loadSteps(c.id).length;
    const byStep = Array.from({ length: Math.max(steps, 1) }, (_, i) => ({ step: i + 1, sent: 0, due: 0 }));
    for (const s of sent) if (byStep[s.step]) byStep[s.step].sent += s.n;
    for (const d of due) if (byStep[d.step]) byStep[d.step].due += d.n;
    const followSent = byStep.slice(1).reduce((s, x) => s + x.sent, 0);
    const followDue = byStep.slice(1).reduce((s, x) => s + x.due, 0);
    const newSent = byStep[0].sent, newDue = byStep[0].due;
    return { ...base, ready: true, by_step: byStep, follow: followSent + followDue, follow_sent: followSent, new_avail: newSent + newDue, new_sent: newSent, sent_today: newSent + followSent };
  });

  // 1. Folge-Mails zuerst; reicht die Kapazität nicht, anteilig kürzen.
  const act = per.filter(p => p.ready);
  const followTotal = act.reduce((s, p) => s + p.follow, 0);
  const fu = followTotal <= cap.available ? new Map(act.map(p => [p.campaign_id, p.follow])) : waterFill(cap.available, act.map(p => ({ key: p.campaign_id, weight: Math.max(1, p.follow), cap: p.follow })));
  const usedFollow = [...fu.values()].reduce((s, n) => s + n, 0);
  // 2. Rest als Erst-Mails nach Anteil, mit Umverteilung.
  const rest = Math.max(0, cap.available - usedFollow);
  const nw = waterFill(rest, act.map(p => ({ key: p.campaign_id, weight: p.weight, cap: p.new_avail })));
  // Ziel-Anteil je Projekt ohne Obergrenze (für den Pool-Puffer): so viele Erst-Mails pro Tag „sollte“ das Projekt bekommen.
  const wsum = act.reduce((s, p) => s + p.weight, 0) || 1;
  const newCapacity = Math.max(0, cap.total - followTotal);
  for (const p of per) {
    if (!p.ready) { p.quota = 0; p.target_new = 0; continue; }
    p.quota_follow = fu.get(p.campaign_id) || 0;
    p.quota_new = nw.get(p.campaign_id) || 0;
    p.quota = p.quota_follow + p.quota_new;
    p.target_new = Math.ceil(newCapacity * p.weight / wsum);
    p.pool_target = p.target_new * st.buffer_days;
    p.pool_days = p.target_new ? Math.round(p.pool_stock / p.target_new * 10) / 10 : null;
  }
  const planned = per.reduce((s, p) => s + (p.quota || 0), 0);
  return {
    enabled: st.enabled, settings: st, day: dayKey(now, tz), capacity: cap, planned, unused: Math.max(0, cap.available - planned),
    projects: per, quotas: new Map(per.filter(p => p.ready).map(p => [p.campaign_id, { quota: p.quota, sent: p.sent_today }]))
  };
}

// ---------- Pools nachfüllen: automatische Leadquellen-Läufe, wenn der Bestand unter den Puffer fällt ----------
export function refillPools(plan = planDay(), now = Date.now()) {
  const s = getSettings();
  const regions = Array.isArray(s.sourcing_regions) ? s.sourcing_regions.filter(Boolean) : [];
  const started = [];
  for (const p of plan.projects) {
    if (!p.ready || !p.pool_target || p.pool_stock >= p.pool_target) continue;
    // Ein Lauf je Projekt gleichzeitig. Manuelle Läufe zählen mit.
    if (q.get("SELECT 1 FROM sourcing_runs WHERE project_id = ? AND status IN ('queued','running','paused')", p.project_id)) continue;
    // Letzter automatischer Lauf ohne neue Firmen: Regionen sind erschöpft → höchstens einmal am Tag erneut versuchen.
    const last = q.get("SELECT * FROM sourcing_runs WHERE project_id = ? AND auto = 1 ORDER BY id DESC LIMIT 1", p.project_id);
    if (last && last.imported === 0 && (last.finished_at || last.updated_at) > now - DAY_MS) continue;
    if (!regions.length) continue;
    const runs = q.value("SELECT COUNT(*) FROM sourcing_runs WHERE project_id = ? AND auto = 1", p.project_id) || 0;
    // Regionen rotieren: jeder Lauf beginnt woanders, damit nicht immer dieselbe Gegend abgegrast wird.
    const offset = (runs * 2) % regions.length;
    const rotated = [...regions.slice(offset), ...regions.slice(0, offset)];
    const deficit = p.pool_target - p.pool_stock;
    // Erfahrungsgemäß landet etwa jede vierte geprüfte Firma im Pool.
    const max = clampInt(deficit * 4, 100, 3000);
    const profile = PROFILES[p.profile] ? p.profile : "website";
    const run = createRun({ project_id: p.project_id, profile, regions: rotated, categories: PROFILES[profile].categories, max_candidates: max });
    q.run("UPDATE sourcing_runs SET auto = 1 WHERE id = ?", run.id);
    recordEvent("autopilot_refill", { data: { project_id: p.project_id, run_id: run.id, stock: p.pool_stock, target: p.pool_target, max_candidates: max } });
    started.push({ project_id: p.project_id, project: p.project, run_id: run.id, max_candidates: max, stock: p.pool_stock, target: p.pool_target });
  }
  autopilotState.lastRefill = started;
  return started;
}

// ---------- Aufräumen: nie angeschriebene Leads aus den Leadquellen, die nicht mehr gebraucht werden ----------
// Gelöscht wird nur, wer nie eine Mail bekommen hat (keine Nachricht, kein Gespräch) und nicht gesperrt/abgemeldet ist –
// angeschriebene Leads bleiben, weil an ihnen Sperrfristen, Kontakt-Obergrenzen und Abmeldungen hängen.
//   a) nicht mehr in einem Pool/einer Liste (z. B. „nicht passend“ nach der Recherche) – nach 3 Tagen Schonfrist
//   b) älter als max_age_days und immer noch nicht angeschrieben (Website-Befund veraltet; die Firma darf später neu gefunden werden)
//   c) Adresse ungültig oder jede Kampagnen-Zuordnung beendet, ohne dass je etwas rausging
export function cleanupCandidates(now = Date.now(), maxAgeDays = autopilotSettings().max_age_days) {
  return q.all(`SELECT l.id, l.account_id,
      CASE WHEN NOT EXISTS (SELECT 1 FROM lead_list_members WHERE lead_id = l.id) THEN 'not_in_pool'
           WHEN l.verify_status = 'invalid' THEN 'invalid'
           WHEN l.created_at < ? THEN 'stale'
           ELSE 'finished_unsent' END AS reason
    FROM leads l
    WHERE l.source LIKE ? AND l.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM messages WHERE lead_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM conversations WHERE lead_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM campaign_leads WHERE lead_id = l.id AND step > 0)
      AND NOT EXISTS (SELECT 1 FROM blocklist WHERE value = l.email)
      AND (
        (NOT EXISTS (SELECT 1 FROM lead_list_members WHERE lead_id = l.id) AND l.updated_at < ?
          AND NOT EXISTS (SELECT 1 FROM campaign_leads WHERE lead_id = l.id AND status IN ('queued','active','paused')))
        OR l.verify_status = 'invalid'
        OR l.created_at < ?
        OR (EXISTS (SELECT 1 FROM campaign_leads WHERE lead_id = l.id)
            AND NOT EXISTS (SELECT 1 FROM campaign_leads WHERE lead_id = l.id AND status IN ('queued','active','paused'))
            AND l.updated_at < ?)
      )`, now - maxAgeDays * DAY_MS, SOURCED, now - 3 * DAY_MS, now - maxAgeDays * DAY_MS, now - 7 * DAY_MS);
}

export function cleanupLeads(now = Date.now(), { dryRun = false } = {}) {
  const rows = cleanupCandidates(now);
  const by = {};
  for (const r of rows) by[r.reason] = (by[r.reason] || 0) + 1;
  let accounts = 0;
  if (!dryRun && rows.length) {
    tx(() => {
      for (const r of rows) {
        // Kandidaten-Eintrag freigeben, damit die Firma bei einem späteren Lauf mit frischen Daten neu gefunden werden kann.
        q.run("DELETE FROM sourcing_candidates WHERE lead_id = ?", r.id);
        deleteLeadCompletely(r.id);
        if (r.account_id && !q.get("SELECT 1 FROM leads WHERE account_id = ?", r.account_id) && !q.get("SELECT 1 FROM opportunities WHERE account_id = ?", r.account_id)) {
          q.run("DELETE FROM accounts WHERE id = ?", r.account_id);
          accounts++;
        }
      }
    });
    recordEvent("autopilot_cleanup", { data: { leads: rows.length, accounts, by } });
  }
  const result = { at: now, leads: rows.length, accounts, by, dry_run: dryRun };
  if (!dryRun) {
    autopilotState.lastCleanup = result;
    saveSettings({ autopilot_last_cleanup: result });
  }
  return result;
}

// ---------- Takt: Pools nachfüllen (alle paar Minuten), Aufräumen einmal am Tag ----------
export function runAutopilotTick(now = Date.now()) {
  const st = autopilotSettings();
  autopilotState.lastTickAt = now;
  if (!st.enabled) return { enabled: false };
  const out = { enabled: true, refill: [], cleanup: null };
  try {
    const plan = planDay(now);
    if (st.refill) out.refill = refillPools(plan, now);
    const today = dayKey(now, appTimezone());
    const last = getSettings().autopilot_last_cleanup;
    if (st.cleanup && (!last || dayKey(last.at, appTimezone()) !== today)) out.cleanup = cleanupLeads(now);
    autopilotState.lastError = null;
  } catch (err) {
    autopilotState.lastError = err.message;
    console.error("[autopilot]", err);
  }
  return out;
}

let timer = null;
export function startAutopilot(intervalMs = 5 * 60 * 1000) {
  stopAutopilot();
  const loop = () => {
    runAutopilotTick();
    timer = setTimeout(loop, intervalMs);
    timer.unref?.();
  };
  timer = setTimeout(loop, 30000);
  timer.unref?.();
}
export function stopAutopilot() {
  if (timer) clearTimeout(timer);
  timer = null;
}

