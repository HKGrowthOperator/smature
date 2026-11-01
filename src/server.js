// Einstiegspunkt: Konfiguration laden, Datenbank öffnen, HTTP-Server und Hintergrund-Jobs starten.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, validateConfig, config } from "./config.js";
import { openDb, closeDb } from "./db.js";
import { ensureAdmin } from "./auth.js";
import { createApp } from "./app.js";
import { startScheduler, stopScheduler, schedulerIdle } from "./engine/scheduler.js";
import { startSync, stopSync } from "./engine/sync.js";
import { startWatch, stopWatch } from "./intel/watch.js";
import { startSourcing, stopSourcing } from "./intel/sourcing.js";
import { startAutopilot, stopAutopilot } from "./engine/autopilot.js";

loadConfig();
const problems = validateConfig();
if (problems.length) {
  console.error("Konfiguration unvollständig:\n- " + problems.join("\n- "));
  process.exit(1);
}

mkdirSync(config.dataDir, { recursive: true });
openDb(join(config.dataDir, "coldmail.db"));
if (ensureAdmin()) console.log(`Administrator ${config.adminEmail} angelegt.`);

const server = createApp();
server.requestTimeout = 5 * 60 * 1000;
server.listen(config.port, config.host, () => {
  console.log(`Smature Coldmail läuft auf ${config.appUrl} (Port ${config.port})`);
  if (config.workers) {
    startScheduler(config.schedulerIntervalMs);
    startSync(config.syncIntervalMs);
    startWatch();
    startSourcing();
    startAutopilot();
  } else {
    console.log("Hintergrund-Jobs deaktiviert (WORKERS=false).");
  }
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} empfangen – fahre herunter …`);
  setTimeout(() => process.exit(0), 15000).unref();
  stopScheduler();
  stopSync();
  stopWatch();
  stopSourcing();
  stopAutopilot();
  // Laufenden Versand-Takt abschließen lassen, sonst würde eine bereits gesendete Mail nach dem Neustart doppelt verschickt.
  await schedulerIdle(10000);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
