// Konfiguration aus Umgebungsvariablen. Wird einmal beim Start (oder in Tests) geladen.
import { resolve } from "node:path";

export const config = {};

const bool = (v, fallback) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(String(v).toLowerCase()));
const num = (v, fallback) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? fallback : Number(v));

export function loadConfig(env = process.env) {
  const appUrl = String(env.APP_URL || "http://localhost:3000").replace(/\/+$/, "");
  const next = {
    env: env.NODE_ENV || "development",
    port: num(env.PORT, 3000),
    host: env.HOST || "0.0.0.0",
    dataDir: resolve(env.DATA_DIR || "./data"),
    appUrl,
    // Eigene Tracking-Domain (CNAME auf diese App) – verbessert die Zustellbarkeit, weil Links nicht auf die App-Domain zeigen.
    trackingUrl: String(env.TRACKING_URL || appUrl).replace(/\/+$/, ""),
    appSecret: env.APP_SECRET || "",
    adminEmail: (env.ADMIN_EMAIL || "").trim().toLowerCase(),
    adminPassword: env.ADMIN_PASSWORD || "",
    adminName: env.ADMIN_NAME || "Admin",
    adminPasswordReset: bool(env.ADMIN_PASSWORD_RESET, false),
    cookieSecure: bool(env.COOKIE_SECURE, true),
    trustProxy: bool(env.TRUST_PROXY, false),
    anthropicKey: env.ANTHROPIC_API_KEY || "",
    // Schlüssel, die nicht an einen Workspace gebunden sind, brauchen die Workspace-ID (Console → Settings → Workspaces).
    anthropicWorkspace: env.ANTHROPIC_WORKSPACE_ID || "",
    // Max-Abo: Token aus `claude setup-token`. Abrechnung über die Nutzungslimits des Abos statt pro Token.
    claudeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN || "",
    // Google Places API (New) für die Prüfung der Google-Bewertungen in den Leadquellen.
    googlePlacesKey: env.GOOGLE_PLACES_API_KEY || "",
    claudeBin: env.CLAUDE_BIN || "claude",
    // subscription | api – Standard: Max-Abo, wenn ein Token gesetzt ist.
    aiProvider: (env.AI_PROVIDER || (env.CLAUDE_CODE_OAUTH_TOKEN ? "subscription" : env.ANTHROPIC_API_KEY ? "api" : "")).toLowerCase(),
    aiModel: env.AI_MODEL || "claude-opus-5-5",
    aiTimeoutMs: num(env.AI_TIMEOUT_MS, 300000),
    aiFallbacks: bool(env.AI_FALLBACKS, true),
    schedulerIntervalMs: num(env.SCHEDULER_INTERVAL_MS, 15000),
    syncIntervalMs: num(env.SYNC_INTERVAL_MS, 120000),
    workers: bool(env.WORKERS, true),
    defaultTimezone: env.DEFAULT_TIMEZONE || "Europe/Berlin",
    smtpTimeoutMs: num(env.SMTP_TIMEOUT_MS, 30000),
    // Nur für Tests/Entwicklung: TLS-Zertifikate lokaler Testserver akzeptieren. In Produktion nie setzen.
    allowInsecureTls: bool(env.ALLOW_INSECURE_TLS, false),
    // Nur für Tests: Website-Abruf auch für private Adressen erlauben.
    allowPrivateFetch: bool(env.ALLOW_PRIVATE_FETCH, false)
  };
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, next);
  return config;
}

export function validateConfig(cfg = config) {
  const problems = [];
  if (!cfg.appSecret || cfg.appSecret.length < 32) problems.push("APP_SECRET fehlt oder ist kürzer als 32 Zeichen (verschlüsselt Postfach-Passwörter).");
  if (!/^https?:\/\//.test(cfg.appUrl)) problems.push("APP_URL muss mit http:// oder https:// beginnen.");
  if (cfg.adminPassword && cfg.adminPassword.length < 12) problems.push("ADMIN_PASSWORD muss mindestens 12 Zeichen haben.");
  return problems;
}
