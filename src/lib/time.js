// Zeitzonen-Helfer ohne Abhängigkeiten (Intl). Wochentage: 1 = Montag … 7 = Sonntag.
export const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const formatters = new Map();

function formatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimezone(tz) {
  try { formatter(tz); return true; } catch { return false; }
}

export function zonedParts(ts, tz) {
  const parts = {};
  for (const p of formatter(tz).formatToParts(new Date(ts))) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday]
  };
}

export function tzOffset(ts, tz) {
  const p = zonedParts(ts, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

// Zeitpunkt "Datum + Uhrzeit in Zeitzone" → Epoch-ms.
export function zonedTime(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - tzOffset(guess, tz);
  ts = guess - tzOffset(ts, tz);
  return ts;
}

export function startOfDay(ts, tz) {
  const p = zonedParts(ts, tz);
  return zonedTime(p.year, p.month, p.day, 0, 0, tz);
}

export function dayKey(ts, tz) {
  const p = zonedParts(ts, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function parseHm(value, fallback = "08:00") {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || fallback));
  if (!m) return parseHm(fallback);
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

export function parseDays(days) {
  return String(days || "").split(",").map(Number).filter(d => d >= 1 && d <= 7);
}

// Liegt ts im Versandfenster (Wochentag + Uhrzeit) der Kampagne?
export function inWindow(schedule, ts) {
  const tz = schedule.timezone || "Europe/Berlin";
  const p = zonedParts(ts, tz);
  if (!parseDays(schedule.days).includes(p.weekday)) return false;
  const start = parseHm(schedule.window_start, "08:00"), end = parseHm(schedule.window_end, "17:00");
  const minutes = p.hour * 60 + p.minute;
  const s = start.h * 60 + start.m, e = end.h * 60 + end.m;
  if (e > s) return minutes >= s && minutes < e;
  return minutes >= s || minutes < e; // Fenster über Mitternacht
}

// Nächster Fensterbeginn ab ts (für Anzeige "nächster Versand").
export function nextWindowStart(schedule, ts) {
  if (inWindow(schedule, ts)) return ts;
  const tz = schedule.timezone || "Europe/Berlin";
  const days = parseDays(schedule.days);
  if (!days.length) return null;
  const start = parseHm(schedule.window_start, "08:00");
  for (let i = 0; i < 8; i++) {
    const p = zonedParts(ts + i * DAY_MS, tz);
    const candidate = zonedTime(p.year, p.month, p.day, start.h, start.m, tz);
    if (candidate > ts && days.includes(zonedParts(candidate, tz).weekday)) return candidate;
  }
  return null;
}
