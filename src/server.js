// Einstiegspunkt: Konfiguration laden, Datenbank öffnen, HTTP-Server und Hintergrund-Jobs starten.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { loadConfig, validateConfig, config } from "./config.js";
import { openDb, closeDb } from "./db.js";
import { ensureAdmin } from "./auth.js";
import { runBootstrap } from "./bootstrap.js";
import { createApp } from "./app.js";
import { startScheduler, stopScheduler, schedulerIdle } from "./engine/scheduler.js";
import { startSync, stopSync } from "./engine/sync.js";
import { startWatch, stopWatch } from "./intel/watch.js";
import { startSourcing, stopSourcing } from "./intel/sourcing.js";
import { startAutopilot, stopAutopilot } from "./engine/autopilot.js";

loadConfig();
// Ohne APP_SECRET: Schlüssel einmal erzeugen und im Daten-Volume speichern (bleibt bei jedem Neustart gleich).
// Ein gesetztes APP_SECRET hat immer Vorrang.
if (!config.appSecret || config.appSecret.length < 32) {
  const file = join(config.dataDir, ".app-secret");
  try {
    mkdirSync(config.dataDir, { recursive: true });
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(48).toString("base64"), { mode: 0o600 });
      console.warn(`APP_SECRET nicht gesetzt – neuer Schlüssel erzeugt und in ${file} gespeichert. Das Volume ${config.dataDir} muss dauerhaft sein, sonst gehen die Postfach-Passwörter beim nächsten Deploy verloren.`);
    }
    config.appSecret = readFileSync(file, "utf8").trim();
  } catch (err) {
    console.error(`APP_SECRET konnte nicht in ${file} gespeichert werden: ${err.message}`);
  }
}
const problems = validateConfig();
if (problems.length) {
  console.error("Konfiguration unvollständig:\n- " + problems.join("\n- "));
  process.exit(1);
}

mkdirSync(config.dataDir, { recursive: true });
openDb(join(config.dataDir, "coldmail.db"));
if (ensureAdmin()) console.log(`Administrator ${config.adminEmail} angelegt.`);
if (process.env.BOOTSTRAP_JSON) runBootstrap(process.env.BOOTSTRAP_JSON).catch(err => console.error(`BOOTSTRAP fehlgeschlagen: ${err.message}`));

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
