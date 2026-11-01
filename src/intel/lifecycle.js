// Lebenszyklus einer Firma (State Machine). Hauptpfad von „Entdeckt“ bis „Gewonnen“, daneben Endzustände.
// Automatische Übergänge gehen nur vorwärts; Nutzer können jeden Zustand setzen.
import { q } from "../db.js";
import { recordEvent, emitWebhook } from "../events.js";

export const LIFECYCLE = {
  discovered: "Entdeckt",
  researched: "Recherchiert",
  qualified: "Qualifiziert",
  watching: "Beobachten",
  triggered: "Anlass erkannt",
  outreach_ready: "Bereit für Ansprache",
  contacted: "Kontaktiert",
  engaged: "Im Gespräch",
  meeting: "Termin",
  opportunity: "Qualifizierte Chance",
  proposal: "Angebot",
  won: "Gewonnen",
  disqualified: "Passt nicht",
  no_response: "Keine Reaktion",
  not_now: "Später",
  suppressed: "Gesperrt",
  lost: "Verloren"
};

const MAIN = ["discovered", "researched", "qualified", "watching", "triggered", "outreach_ready", "contacted", "engaged", "meeting", "opportunity", "proposal", "won"];
const rank = state => MAIN.indexOf(state);
// Aus diesen Zuständen holt nur ein Mensch (oder ein neuer Anlass/Antwort) die Firma zurück.
const STICKY = new Set(["won", "lost", "suppressed", "disqualified"]);

export function setLifecycle(accountId, state, { reason = "", by = "user" } = {}) {
  if (!LIFECYCLE[state]) throw new Error(`Unbekannter Zustand: ${state}`);
  const a = q.get("SELECT id, lifecycle FROM accounts WHERE id = ?", accountId);
  if (!a || a.lifecycle === state) return false;
  const now = Date.now();
  q.run("UPDATE accounts SET lifecycle = ?, lifecycle_at = ?, updated_at = ? WHERE id = ?", state, now, now, accountId);
  recordEvent("lifecycle", { data: { account_id: accountId, from: a.lifecycle, to: state, reason, by } });
  if (state === "triggered") emitWebhook("account.triggered", { account_id: accountId, reason });
  return true;
}

// Automatischer Schritt nach vorn (z. B. Mail gesendet → kontaktiert). Rückschritte und gesperrte Firmen bleiben unberührt.
export function advance(accountId, state, reason = "", { allowFromSide = [] } = {}) {
  if (!accountId) return false;
  const a = q.get("SELECT lifecycle FROM accounts WHERE id = ?", accountId);
  if (!a) return false;
  const current = a.lifecycle;
  if (STICKY.has(current) && !allowFromSide.includes(current)) return false;
  const side = rank(current) < 0;
  if (!side && rank(state) <= rank(current)) return false;
  if (side && !allowFromSide.includes(current) && !["no_response", "not_now"].includes(current)) return false;
  return setLifecycle(accountId, state, { reason, by: "system" });
}

// Seitenzustand (keine Reaktion, später, gesperrt …) – nicht, wenn schon ein Termin oder mehr erreicht ist.
export function sideState(accountId, state, reason = "") {
  if (!accountId) return false;
  const a = q.get("SELECT lifecycle FROM accounts WHERE id = ?", accountId);
  if (!a) return false;
  if (state !== "suppressed" && rank(a.lifecycle) >= rank("meeting")) return false;
  if (["suppressed", "won"].includes(a.lifecycle)) return false;
  // Verloren/disqualifiziert bleiben, außer die Firma wird ganz gesperrt.
  if (["lost", "disqualified"].includes(a.lifecycle) && state !== "suppressed") return false;
  return setLifecycle(accountId, state, { reason, by: "system" });
}

export function accountOfLead(leadId) {
  return leadId ? q.value("SELECT account_id FROM leads WHERE id = ?", leadId) || null : null;
}
