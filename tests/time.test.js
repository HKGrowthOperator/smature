import { test } from "node:test";
import assert from "node:assert/strict";
import { inWindow, startOfDay, zonedParts, nextWindowStart, dayKey, zonedTime } from "../src/lib/time.js";

const schedule = { timezone: "Europe/Berlin", days: "1,2,3,4,5", window_start: "08:00", window_end: "17:00" };

test("Versandfenster nach Wochentag und Uhrzeit (Berlin)", () => {
  // Mi, 7.10.2026 10:00 Berlin = 08:00 UTC (Sommerzeit)
  assert.equal(inWindow(schedule, Date.UTC(2026, 9, 7, 8, 0)), true);
  assert.equal(inWindow(schedule, Date.UTC(2026, 9, 7, 5, 59)), false); // 07:59 Berlin
  assert.equal(inWindow(schedule, Date.UTC(2026, 9, 7, 15, 0)), false); // 17:00 Berlin → Ende exklusiv
  assert.equal(inWindow(schedule, Date.UTC(2026, 9, 10, 9, 0)), false); // Samstag
  assert.equal(inWindow({ ...schedule, window_start: "22:00", window_end: "02:00", days: "1,2,3,4,5,6,7" }, Date.UTC(2026, 9, 7, 22, 30)), true); // über Mitternacht
});

test("Tagesbeginn in Zeitzone, auch an der Zeitumstellung", () => {
  const ts = Date.UTC(2026, 9, 25, 12, 0); // 25.10.2026: Umstellung auf Winterzeit
  const start = startOfDay(ts, "Europe/Berlin");
  const p = zonedParts(start, "Europe/Berlin");
  assert.deepEqual([p.day, p.hour, p.minute], [25, 0, 0]);
  assert.equal(dayKey(ts, "Europe/Berlin"), "2026-10-25");
  assert.equal(zonedTime(2026, 1, 15, 9, 30, "Europe/Berlin"), Date.UTC(2026, 0, 15, 8, 30));
});

test("Nächster Fensterbeginn", () => {
  const fri = Date.UTC(2026, 9, 9, 16, 0); // Fr 18:00 Berlin
  const next = nextWindowStart(schedule, fri);
  const p = zonedParts(next, "Europe/Berlin");
  assert.deepEqual([p.weekday, p.hour, p.minute], [1, 8, 0]); // Montag 08:00
});
