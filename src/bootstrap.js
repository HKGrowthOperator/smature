// Einmalige Einrichtung beim Start über die Umgebungsvariable BOOTSTRAP_JSON (z. B. in Coolify gesetzt, nie im Repo).
// Idempotent: vorhandene Postfächer werden übersprungen, Projekte nur gelöscht, wenn es sie gibt.
// Nach erfolgreichem Lauf die Variable wieder entfernen – Passwörter gehören danach nur noch in die (verschlüsselte) Datenbank.
//
// {
//   "setup_mode": "separate", "main_domain": "firma.de", "domains": ["getfirma.com"], "company_name": "Firma GmbH",
//   "remove_projects": ["webseite"], "add_projects": [{ "name": "Firma", "description": "…" }],
//   "mailboxes": { "provider": "google", "position": "Geschäftsführer", "daily_limit": 30, "warmup": true,
//                  "rows": [{ "email": "a@getfirma.com", "password": "…", "from_name": "Vorname Nachname" }] }
// }
import { q, insert } from "./db.js";
import { getSettings, saveSettings } from "./settings.js";
import { normalizeDomainInput, SETUP_MODES } from "./setup/status.js";
import { readMailbox, testConnection, PROVIDERS } from "./api/mailboxes.js";
import { getMailbox } from "./mail/mailboxes.js";

const slugify = s => String(s).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "projekt";

export async function runBootstrap(raw, log = console.log) {
  if (!raw) return null;
  let cfg;
  try { cfg = JSON.parse(raw); } catch (err) { log(`BOOTSTRAP_JSON ungültig: ${err.message}`); return null; }
  const report = { settings: [], projects_removed: [], projects_added: [], mailboxes: [] };

  const patch = {};
  if (cfg.setup_mode && SETUP_MODES[cfg.setup_mode]) patch.setup_mode = cfg.setup_mode;
  if (cfg.main_domain) patch.main_domain = normalizeDomainInput(cfg.main_domain);
  if (Array.isArray(cfg.domains)) patch.setup_domains = [...new Set([...(getSettings().setup_domains || []), ...cfg.domains.map(normalizeDomainInput).filter(Boolean)])];
  if (typeof cfg.company_name === "string" && cfg.company_name.trim()) patch.company_name = cfg.company_name.trim();
  if (Object.keys(patch).length) { saveSettings(patch); report.settings = Object.keys(patch); }

  for (const slug of cfg.remove_projects || []) {
    const p = q.get("SELECT id, name FROM projects WHERE slug = ?", slug);
    if (p) { q.run("DELETE FROM projects WHERE id = ?", p.id); report.projects_removed.push(p.name); }
  }
  for (const proj of cfg.add_projects || []) {
    const name = String(proj.name || "").trim();
    if (!name || q.get("SELECT 1 FROM projects WHERE name = ?", name)) continue;
    let slug = slugify(name), n = 2;
    while (q.get("SELECT 1 FROM projects WHERE slug = ?", slug)) slug = `${slugify(name)}-${n++}`;
    const now = Date.now();
    insert("projects", { name, slug, description: String(proj.description || ""), color: String(proj.color || "#2b7353"), position: q.value("SELECT COALESCE(MAX(position), 0) + 1 FROM projects"), created_at: now, updated_at: now });
    report.projects_added.push(name);
  }

  const mb = cfg.mailboxes;
  const created = [];
  if (mb && Array.isArray(mb.rows)) {
    const provider = PROVIDERS[mb.provider] ? mb.provider : "custom";
    const base = { ...PROVIDERS[provider], ...(mb.smtp_host ? { smtp_host: mb.smtp_host, imap_host: mb.imap_host || mb.smtp_host } : {}) };
    const company = getSettings().company_name || "";
    const position = String(mb.position || "");
    for (const row of mb.rows) {
      const email = String(row.email || "").trim().toLowerCase();
      try {
        const existing = q.get("SELECT id FROM mailboxes WHERE email = ?", email);
        if (existing) {
          // Vorhandenes Postfach: Passwort und Server aus der Vorgabe übernehmen (z. B. Port 587 statt 465).
          const cur = getMailbox(existing.id);
          const upd = readMailbox({ email: cur.email, smtp_host: base.smtp_host, smtp_port: base.smtp_port, smtp_secure: base.smtp_secure, imap_host: base.imap_host, imap_port: base.imap_port, imap_secure: base.imap_secure, smtp_pass: String(row.password || "").replace(/\s+/g, ""), imap_same_pass: true }, cur);
          q.run("UPDATE mailboxes SET smtp_host = ?, smtp_port = ?, smtp_secure = ?, imap_host = ?, imap_port = ?, imap_secure = ?, smtp_pass = ?, imap_pass = ?, updated_at = ? WHERE id = ?",
            upd.smtp_host, upd.smtp_port, upd.smtp_secure, upd.imap_host, upd.imap_port, upd.imap_secure, upd.smtp_pass, upd.imap_pass, Date.now(), existing.id);
          created.push({ id: existing.id, email, existed: true }); continue;
        }
        const name = String(row.from_name || "").trim();
        const signature = name ? ["Beste Grüße", name, [position, company].filter(Boolean).join(" – ")].filter(Boolean).join("\n") : "";
        const data = readMailbox({
          email, from_name: name, provider, smtp_host: base.smtp_host, smtp_port: base.smtp_port, smtp_secure: base.smtp_secure,
          smtp_user: row.user || email, smtp_pass: String(row.password || "").replace(/\s+/g, ""), imap_host: base.imap_host, imap_port: base.imap_port, imap_secure: base.imap_secure,
          imap_same_pass: true, warmup_enabled: mb.warmup !== false, signature, daily_limit: Math.min(200, Math.max(1, Number(mb.daily_limit) || 30))
        });
        const now = Date.now();
        const id = insert("mailboxes", { ...data, status: "active", ramp_started_at: now, warmup_started_at: data.warmup_enabled ? now : null, created_at: now, updated_at: now });
        created.push({ id, email });
      } catch (err) {
        report.mailboxes.push({ email, result: `Fehler: ${err.message}` });
      }
    }
  }

  // Produkt + Zielgruppe + Kampagne (Entwurf, NICHT freigegeben – Freigabe und Start bleiben Handarbeit in der App).
  const c = cfg.campaign;
  if (c && c.name && !q.get("SELECT 1 FROM campaigns WHERE name = ?", c.name)) {
    const now = Date.now();
    const projectId = c.project ? q.get("SELECT id FROM projects WHERE name = ?", c.project)?.id ?? null : null;
    let productId = null, groupId = null;
    if (c.product?.name) {
      productId = q.get("SELECT id FROM products WHERE name = ?", c.product.name)?.id
        ?? insert("products", { name: c.product.name, description: c.product.description || "", offer: c.product.offer || "", icp: c.product.icp || "", proof: c.product.proof || "", booking_url: c.product.booking_url || "", project_id: projectId, created_at: now, updated_at: now });
    }
    if (c.target_group?.name) {
      groupId = q.get("SELECT id FROM target_groups WHERE name = ?", c.target_group.name)?.id
        ?? insert("target_groups", { name: c.target_group.name, description: c.target_group.description || "", offer: c.target_group.offer || "", tone: c.target_group.tone || "", cta: c.target_group.cta || "", language: "de", project_id: projectId, created_at: now, updated_at: now });
    }
    const mailboxIds = q.all("SELECT id FROM mailboxes WHERE status = 'active' ORDER BY id").map(m => m.id);
    const campaignId = insert("campaigns", {
      name: c.name, target_group_id: groupId, product_id: productId, status: "draft", timezone: "Europe/Berlin", days: "1,2,3,4,5",
      window_start: "08:00", window_end: "17:00", daily_limit: Number(c.daily_limit) || 50, legal_basis: c.legal_basis || "consent",
      mailbox_ids: JSON.stringify(mailboxIds), ramp_enabled: 1, created_at: now, updated_at: now
    });
    (c.steps || []).forEach((s, i) => insert("campaign_steps", {
      campaign_id: campaignId, position: i, delay_days: i === 0 ? 0 : Number(s.delay_days) || 3,
      variants: JSON.stringify([{ key: "A", subject: s.subject || "", body: s.body || "", enabled: true }])
    }));
    if (c.list_name) {
      const listId = q.get("SELECT id FROM lead_lists WHERE name = ?", c.list_name)?.id
        ?? insert("lead_lists", { name: c.list_name, target_group_id: groupId, project_id: projectId, created_at: now });
      report.list = c.list_name + ` (#${listId})`;
    }
    report.campaign = `${c.name} (#${campaignId}, ${(c.steps || []).length} Mails, ${mailboxIds.length} Postfächer, Entwurf – noch nicht freigegeben)`;
  }
  if (report.campaign) log("BOOTSTRAP: Kampagne " + report.campaign + (report.list ? ` · Liste ${report.list}` : ""));

  log("BOOTSTRAP: Postfächer werden getestet …");
  for (const { id, email, existed } of created) {
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("Zeitüberschreitung (45 s)")), 45000));
    const test = await Promise.race([testConnection(getMailbox(id)), timeout]).catch(err => ({ smtp: { ok: false, error: err.message }, imap: { ok: false, error: err.message } }));
    if (!test.smtp.ok) q.run("UPDATE mailboxes SET last_error = ?, updated_at = ? WHERE id = ?", String(test.smtp.error || "SMTP-Test fehlgeschlagen").slice(0, 500), Date.now(), id);
    if (test.smtp.ok) q.run("UPDATE mailboxes SET last_error = NULL, updated_at = ? WHERE id = ?", Date.now(), id);
    const result = `${existed ? "vorhanden" : "angelegt"} · SMTP ${test.smtp.ok ? "ok" : "FEHLER " + test.smtp.error} · IMAP ${test.imap?.ok ? "ok" : "FEHLER " + (test.imap?.error || "")}`;
    log(`BOOTSTRAP: ${email} – ${result}`);
  }

  log("BOOTSTRAP: Einstellungen " + (report.settings.join(", ") || "–"));
  log("BOOTSTRAP: Projekte entfernt " + (report.projects_removed.join(", ") || "–") + " · angelegt " + (report.projects_added.join(", ") || "–"));
  for (const m of report.mailboxes) log(`BOOTSTRAP: ${m.email} – ${m.result}`); // nur Fehler beim Anlegen
  log("BOOTSTRAP fertig – Variable BOOTSTRAP_JSON jetzt wieder entfernen.");
  return report;
}
