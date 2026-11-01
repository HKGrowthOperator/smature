// Gemeinsame Test-Hilfen: temporäre Datenbank + Konfiguration.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb, closeDb, insert, q } from "../src/db.js";
import { contentHash } from "../src/engine/rules.js";
import { loadSteps } from "../src/mail/compose.js";
import { encrypt } from "../src/crypto.js";
import { resetSettingsCache } from "../src/settings.js";

export function setupDb(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "coldmail-test-"));
  loadConfig({ APP_SECRET: "test-secret-test-secret-test-secret-1234", DATA_DIR: dir, APP_URL: "https://cold.example.test", COOKIE_SECURE: "false", WORKERS: "false", ALLOW_INSECURE_TLS: "true", ...extraEnv });
  openDb(join(dir, "test.db"));
  resetSettingsCache();
  return () => { closeDb(); rmSync(dir, { recursive: true, force: true }); };
}

export function makeMailbox(overrides = {}) {
  const now = Date.now();
  return insert("mailboxes", {
    email: `sender${Math.random().toString(36).slice(2, 7)}@test-firma.de`, from_name: "Max Mustermann", smtp_host: "127.0.0.1", smtp_port: 2525, smtp_secure: 0,
    smtp_user: "u", smtp_pass: encrypt("p"), daily_limit: 50, ramp_enabled: 0, min_gap_sec: 0, save_sent: 0, created_at: now, updated_at: now, ...overrides
  });
}

export function makeLead(overrides = {}) {
  const now = Date.now();
  return insert("leads", { email: `lead${Math.random().toString(36).slice(2, 8)}@firma-${Math.random().toString(36).slice(2, 6)}.de`, salutation: "Herr", first_name: "Max", last_name: "Müller", company: "Müller GmbH", verify_status: "valid", consent_status: "granted", created_at: now, updated_at: now, ...overrides });
}

// Kampagnen in Tests sind standardmäßig freigegeben (approved: false für ungeprüfte Texte).
export function makeCampaign({ mailboxIds, steps, approved = true, ...overrides }) {
  const now = Date.now();
  const id = insert("campaigns", {
    name: "Test", status: "active", timezone: "Europe/Berlin", days: "1,2,3,4,5,6,7", window_start: "00:00", window_end: "23:59", daily_limit: 100,
    min_gap_sec: 30, max_gap_sec: 30, mailbox_ids: JSON.stringify(mailboxIds), created_at: now, updated_at: now, ...overrides
  });
  (steps || [{ subject: "Frage zu {{company}}", body: "{{anrede}},\n\nkurze Frage." }, { subject: "", body: "{{anrede}},\n\nnachgehakt.", delay: 3 }]).forEach((s, i) =>
    insert("campaign_steps", { campaign_id: id, position: i, delay_days: i === 0 ? 0 : (s.delay ?? 3), variants: JSON.stringify(s.variants || [{ key: "A", subject: s.subject, body: s.body, enabled: true }]) }));
  if (approved) approveCampaign(id);
  return id;
}

export function approveCampaign(id) {
  const c = q.get("SELECT * FROM campaigns WHERE id = ?", id);
  q.run("UPDATE campaigns SET approved_hash = ?, approved_at = ?, approved_by = 'Test' WHERE id = ?", contentHash(c, loadSteps(id)), Date.now(), id);
}

export function enroll(campaignId, leadId, overrides = {}) {
  return insert("campaign_leads", { campaign_id: campaignId, lead_id: leadId, status: "queued", created_at: Date.now(), ...overrides });
}

// Fake-SMTP über setTransportFactory: zeichnet Sendungen auf oder wirft vorgegebene Fehler.
export function fakeTransport() {
  const sent = [];
  let failWith = null;
  const factory = () => ({
    async sendMail(msg) {
      if (failWith) { const f = typeof failWith === "function" ? failWith(msg) : failWith; if (f) throw f; }
      sent.push({ ...msg, raw: msg.raw.toString() });
      return { messageId: "x" };
    },
    async verify() { if (failWith) throw failWith; return true; },
    close() {}
  });
  return { factory, sent, fail(err) { failWith = err; } };
}
