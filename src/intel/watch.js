// Beobachtung (Watch Engine): Firmen, die passen, aber gerade keinen Anlass haben, werden regelmäßig neu
// recherchiert. Taucht ein Anlass auf (neue Stelle, Standort, Führungswechsel …), springt die Firma auf
// „Anlass erkannt“ und landet mit Aufgabe in „Heute“. Außerdem: Firmen ohne Reaktion nach Ablauf aller Sequenzen
// auf „Keine Reaktion“ setzen und später erneut prüfen.
import { q, getSetting, setSetting } from "../db.js";
import { getSettings } from "../settings.js";
import { DAY_MS, dayKey } from "../lib/time.js";
import { AiLimitError, aiAvailable } from "../ai/claude.js";
import { researchAccount } from "./research.js";
import { sideState } from "./lifecycle.js";

const WATCH_STATES = ["watching", "not_now", "no_response", "qualified", "researched"];
export const watchState = { lastRunAt: null, lastError: null, researched: 0 };

// Kontaktierte Firmen ohne Antwort, deren Sequenzen alle durch sind und deren letzte Mail ≥ 14 Tage her ist.
export function markNoResponse(now = Date.now()) {
  const rows = q.all(`SELECT a.id FROM accounts a WHERE a.lifecycle = 'contacted'
    AND NOT EXISTS (SELECT 1 FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE l.account_id = a.id AND cl.status IN ('queued','active','paused'))
    AND NOT EXISTS (SELECT 1 FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.account_id = a.id AND m.direction = 'in' AND m.kind != 'auto_reply')
    AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.account_id = a.id AND t.status = 'open')
    AND (SELECT MAX(m.created_at) FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.account_id = a.id AND m.direction = 'out') < ?`, now - 14 * DAY_MS);
  const days = Number(getSettings().watch_interval_days) || 30;
  for (const r of rows) {
    if (sideState(r.id, "no_response", "Sequenz beendet, keine Antwort")) q.run("UPDATE accounts SET next_check_at = ? WHERE id = ?", now + days * DAY_MS, r.id);
  }
  return rows.length;
}

export async function runWatchTick(now = Date.now()) {
  watchState.lastRunAt = now;
  const settings = getSettings();
  markNoResponse(now);
  if (!aiAvailable()) return 0;
  const key = `watch_count:${dayKey(now, settings.timezone || "Europe/Berlin")}`;
  const used = Number(getSetting(key, "0")) || 0;
  const limit = Math.max(0, Number(settings.watch_daily_limit) || 0);
  if (used >= limit) return 0;
  const due = q.all(`SELECT id FROM accounts WHERE next_check_at IS NOT NULL AND next_check_at <= ? AND (domain IS NOT NULL OR website != '')
    AND lifecycle IN (${WATCH_STATES.map(() => "?").join(",")}) ORDER BY COALESCE(fit_score, 0) DESC, next_check_at LIMIT ?`, now, ...WATCH_STATES, limit - used);
  let done = 0, tried = 0;
  for (const { id } of due) {
    tried++;
    try {
      await researchAccount(id);
      done++;
    } catch (err) {
      if (err instanceof AiLimitError) { watchState.lastError = err.message; break; }
      watchState.lastError = err.message;
      // Website nicht erreichbar o. Ä.: in einer Woche erneut versuchen statt jede Stunde.
      q.run("UPDATE accounts SET next_check_at = ? WHERE id = ?", now + 7 * DAY_MS, id);
    }
    setSetting(key, String(used + tried));
  }
  watchState.researched += done;
  return done;
}

let timer = null;
let running = false;
export function startWatch(intervalMs = 60 * 60 * 1000) {
  stopWatch();
  const run = async () => {
    if (running) return;
    running = true;
    try { await runWatchTick(); } catch (err) { watchState.lastError = err.message; console.error("[watch]", err); } finally { running = false; }
  };
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  setTimeout(run, 60 * 1000).unref?.();
}

export function stopWatch() {
  if (timer) clearInterval(timer);
  timer = null;
}
