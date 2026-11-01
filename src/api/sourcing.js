// API: Leadquellen – Läufe anlegen und steuern, Kandidaten einsehen, Pool je Projekt, Einstellungen.
import { q, tx, update, parseJson } from "../db.js";
import { deleteLeadCompletely } from "./leads.js";
import { fail, v } from "../http.js";
import { requireAdmin } from "../auth.js";
import { getSettings, saveSettings } from "../settings.js";
import { listProjects } from "../intel/projects.js";
import { PROFILES, CATEGORIES, profileFor, poolList, createRun, runSourcingTick, sourcingState, dailyUsed, workUnits } from "../intel/sourcing.js";
import { insert } from "../db.js";
import { campaignFull, autoEnrollTick } from "./campaigns.js";
import { planDay, refillPools, cleanupLeads, cleanupCandidates, autopilotState, autopilotSettings } from "../engine/autopilot.js";

function publicPlan() {
  const { quotas, ...plan } = planDay();
  const preview = {};
  for (const r of cleanupCandidates()) preview[r.reason] = (preview[r.reason] || 0) + 1;
  return { ...plan, state: autopilotState, last_cleanup: getSettings().autopilot_last_cleanup || null, cleanup_preview: preview,
    sourcing: { used: dailyUsed(), limit: getSettings().sourcing_daily_limit, regions: getSettings().sourcing_regions.length } };
}

const CANDIDATE_STATUS = ["new", "imported", "rejected", "duplicate", "error"];

function publicRun(r) {
  return r ? { ...r, regions: parseJson(r.regions, []), categories: parseJson(r.categories, []), profile_label: PROFILES[r.profile]?.label || r.profile, units_total: workUnits(r).total } : null;
}
function runOr404(id) {
  return q.get(`SELECT r.*, p.name AS project_name, l.name AS list_name FROM sourcing_runs r LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN lead_lists l ON l.id = r.list_id WHERE r.id = ?`, id)
    || fail(404, "Lauf nicht gefunden");
}
function runStats(id) {
  const by = {};
  for (const r of q.all("SELECT status, COUNT(*) AS n FROM sourcing_candidates WHERE run_id = ? GROUP BY status", id)) by[r.status] = r.n;
  const fits = {};
  for (const r of q.all("SELECT fit, COUNT(*) AS n FROM sourcing_candidates WHERE run_id = ? AND status = 'imported' GROUP BY fit", id)) fits[r.fit || "-"] = r.n;
  const reasons = q.all("SELECT reason, COUNT(*) AS n FROM sourcing_candidates WHERE run_id = ? AND status IN ('rejected','duplicate','error') AND reason != '' GROUP BY reason ORDER BY n DESC LIMIT 8", id);
  return { by_status: by, fits, reasons };
}
const regionList = raw => [...new Set((Array.isArray(raw) ? raw : String(raw || "").split(/[\n,;]+/)).map(x => String(x).trim()).filter(Boolean))].slice(0, 50).map(x => x.slice(0, 80));

// Die Autopilot-Kampagne eines Projekts: die Kampagne, die den Pool automatisch nachlädt (auto_list_id = Pool-Liste).
function autopilotCampaign(project, list) {
  const c = q.get("SELECT * FROM campaigns WHERE is_template = 0 AND auto_list_id = ? ORDER BY id DESC LIMIT 1", list.id);
  if (!c) return null;
  const leads = q.value("SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = ?", c.id);
  const sent = q.value("SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = ? AND step > 0", c.id);
  return { id: c.id, name: c.name, status: c.status, leads, sent, approved: !!c.approved_hash, cold_ack: !!c.cold_ack_at };
}

// Pool → Kampagne: legt für ein Projekt die Autopilot-Kampagne an (aus der Vorlage des Projekt-Produkts) oder verbindet die
// vorhandene Kampagne des Produkts mit dem Pool. Danach landen neue Pool-Leads automatisch in der Kampagne.
function ensureAutopilot(projectId) {
  const project = listProjects().find(p => p.id === projectId) || fail(404, "Projekt nicht gefunden");
  const list = poolList(projectId);
  let c = q.get("SELECT * FROM campaigns WHERE is_template = 0 AND auto_list_id = ? ORDER BY id DESC LIMIT 1", list.id);
  if (c) return { campaign: campaignFull(c.id), created: false };
  const product = q.get(`SELECT p.* FROM products p WHERE p.project_id = ? ORDER BY (SELECT COUNT(*) FROM campaigns c WHERE c.product_id = p.id AND c.is_template = 1) DESC, p.id LIMIT 1`, projectId) || fail(400, "Das Projekt hat noch kein Produkt mit Vorlage.");
  // Vorhandene Kampagne des Produkts (Entwurf/aktiv) übernehmen, sonst aus der Vorlage anlegen.
  c = q.get("SELECT * FROM campaigns WHERE is_template = 0 AND product_id = ? AND status IN ('draft','active','paused') ORDER BY id DESC LIMIT 1", product.id);
  const now = Date.now();
  if (c) {
    q.run("UPDATE campaigns SET auto_list_id = ?, updated_at = ? WHERE id = ?", list.id, now, c.id);
  } else {
    const tpl = q.get("SELECT * FROM campaigns WHERE is_template = 1 AND product_id = ? ORDER BY id LIMIT 1", product.id) || fail(400, `Für „${product.name}“ gibt es noch keine Vorlage.`);
    const { id: _, status, launched_at, completed_at, created_at, updated_at, is_template, name, mailbox_ids, approved_hash, approved_at, approved_by, cold_ack_at, cold_ack_by, ...rest } = tpl;
    const boxes = q.all("SELECT id FROM mailboxes WHERE status = 'active'").map(m => m.id);
    const id = insert("campaigns", { ...rest, name: `${project.name} · Autopilot`, is_template: 0, status: "draft", legal_basis: "cold", auto_list_id: list.id, daily_limit: 60, mailbox_ids: JSON.stringify(boxes), created_at: now, updated_at: now });
    q.run("INSERT INTO campaign_steps (campaign_id, position, delay_days, variants, created_at) SELECT ?, position, delay_days, variants, ? FROM campaign_steps WHERE campaign_id = ? ORDER BY position, id", id, now, tpl.id);
    c = q.get("SELECT * FROM campaigns WHERE id = ?", id);
  }
  autoEnrollTick();
  return { campaign: campaignFull(c.id), created: !q.get("SELECT 1 FROM campaign_leads WHERE campaign_id = ? AND step > 0", c.id) };
}

export function register(r) {
  // Tages-Autopilot: Tagesplan, Einstellungen, Pools jetzt nachfüllen, Aufräumen.
  r.get("/api/autopilot", () => publicPlan());

  r.put("/api/autopilot", ({ body, user }) => {
    requireAdmin(user);
    const patch = {};
    if (body.enabled !== undefined) patch.autopilot_enabled = !!body.enabled;
    if (body.refill !== undefined) patch.autopilot_refill = !!body.refill;
    if (body.cleanup !== undefined) patch.autopilot_cleanup = !!body.cleanup;
    if (body.buffer_days !== undefined) patch.autopilot_buffer_days = v.int(body.buffer_days, { min: 1, max: 60, name: "Puffer (Tage)" });
    if (body.max_age_days !== undefined) patch.autopilot_lead_max_age_days = v.int(body.max_age_days, { min: 7, max: 730, name: "Höchstalter (Tage)" });
    if (body.shares && typeof body.shares === "object") {
      const ids = new Set(listProjects().map(p => p.id));
      patch.autopilot_shares = Object.fromEntries(Object.entries(body.shares).filter(([k]) => ids.has(Number(k))).map(([k, n]) => [Number(k), v.int(n, { min: 0, max: 100, name: "Anteil" })]));
    }
    saveSettings(patch);
    return { settings: autopilotSettings(), plan: publicPlan() };
  });

  r.post("/api/autopilot/refill", ({ user }) => {
    requireAdmin(user);
    return { started: refillPools(planDay()) };
  });

  r.post("/api/autopilot/cleanup", ({ user, query }) => {
    requireAdmin(user);
    return cleanupLeads(Date.now(), { dryRun: query.get("dry") === "1" });
  });

  r.post("/api/sourcing/projects/:id/campaign", ({ params }) => ensureAutopilot(v.id(params.id)));

  r.get("/api/sourcing/meta", () => {
    const s = getSettings();
    return {
      profiles: Object.entries(PROFILES).map(([key, p]) => ({ key, label: p.label, description: p.description, categories: p.categories })),
      categories: Object.entries(CATEGORIES).map(([key, c]) => ({ key, label: c.label })),
      default_regions: s.sourcing_regions, daily: { used: dailyUsed(), limit: s.sourcing_daily_limit }, state: sourcingState,
      projects: listProjects().map(p => {
        const list = poolList(p.id, { create: false });
        return {
          id: p.id, name: p.name, color: p.color, profile: profileFor(p),
          pool: list ? { id: list.id, name: list.name, leads: q.value("SELECT COUNT(*) FROM lead_list_members WHERE list_id = ?", list.id) } : null,
          campaign: list ? autopilotCampaign(p, list) : null,
          last_run: publicRun(q.get("SELECT * FROM sourcing_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1", p.id))
        };
      })
    };
  });

  r.get("/api/sourcing/runs", () => q.all(`SELECT r.*, p.name AS project_name, l.name AS list_name,
    (SELECT COUNT(*) FROM sourcing_candidates WHERE run_id = r.id AND status = 'new') AS pending
    FROM sourcing_runs r LEFT JOIN projects p ON p.id = r.project_id LEFT JOIN lead_lists l ON l.id = r.list_id ORDER BY r.created_at DESC LIMIT 100`).map(publicRun));

  r.post("/api/sourcing/runs", ({ body, user }) => {
    const project = q.get("SELECT * FROM projects WHERE id = ?", Number(body.project_id) || 0) || fail(400, "Projekt wählen");
    const profile = v.oneOf(body.profile, Object.keys(PROFILES), null) || profileFor(project);
    const regions = regionList(body.regions);
    if (!regions.length) fail(400, "Mindestens eine Region (Verwaltungsname wie bei OpenStreetMap, z. B. „Oberbergischer Kreis“)");
    const categories = (Array.isArray(body.categories) && body.categories.length ? body.categories : PROFILES[profile].categories).map(String).filter(k => CATEGORIES[k]);
    if (!categories.length) fail(400, "Mindestens eine Kategorie");
    const max = v.int(body.max_candidates, { min: 10, max: 5000, fallback: 300 });
    return publicRun(createRun({ project_id: project.id, profile, regions, categories, max_candidates: max, user_id: user.id }));
  });

  r.get("/api/sourcing/runs/:id", ({ params }) => {
    const run = runOr404(v.id(params.id));
    return { ...publicRun(run), stats: runStats(run.id) };
  });

  r.get("/api/sourcing/runs/:id/candidates", ({ params, query }) => {
    const id = v.id(params.id);
    runOr404(id);
    const status = v.oneOf(query.get("status"), CANDIDATE_STATUS, null);
    const limit = v.int(query.get("limit"), { min: 1, max: 200, fallback: 50 });
    const page = v.int(query.get("page"), { min: 1, max: 10000, fallback: 1 });
    const where = status ? "AND status = ?" : "";
    const args = status ? [id, status] : [id];
    const total = q.value(`SELECT COUNT(*) FROM sourcing_candidates WHERE run_id = ? ${where}`, ...args);
    const items = q.all(`SELECT id, name, website, email, phone, city, plz, category, region, status, fit, reason, lead_id, account_id, checked_at, data
      FROM sourcing_candidates WHERE run_id = ? ${where} ORDER BY checked_at DESC, id LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit)
      .map(c => ({ ...c, data: parseJson(c.data, {}) }));
    return { items, total, page, limit };
  });

  r.post("/api/sourcing/runs/:id/pause", ({ params }) => {
    const run = runOr404(v.id(params.id));
    if (!["queued", "running"].includes(run.status)) fail(400, "Lauf läuft nicht");
    update("sourcing_runs", run.id, { status: "paused", updated_at: Date.now() });
    return publicRun(runOr404(run.id));
  });

  // Weiter bzw. fehlgeschlagene Websites erneut prüfen.
  r.post("/api/sourcing/runs/:id/resume", ({ params }) => {
    const run = runOr404(v.id(params.id));
    if (!["paused", "done", "failed"].includes(run.status)) fail(400, "Lauf ist nicht pausiert oder beendet");
    const retried = Number(q.run("UPDATE sourcing_candidates SET status = 'new', reason = '', checked_at = NULL WHERE run_id = ? AND status = 'error'", run.id).changes);
    update("sourcing_runs", run.id, { status: "running", error: null, finished_at: null, errors: Math.max(0, run.errors - retried), checked: Math.max(0, run.checked - retried), updated_at: Date.now() });
    return { ...publicRun(runOr404(run.id)), retried };
  });

  // Lauf löschen; mit ?leads=1 auch die daraus angelegten Leads (und Firmen ohne weitere Leads) verwerfen.
  r.delete("/api/sourcing/runs/:id", ({ params, query, user }) => {
    const run = runOr404(v.id(params.id));
    let removed = 0;
    if (query.get("leads") === "1") {
      requireAdmin(user);
      const rows = q.all("SELECT lead_id, account_id FROM sourcing_candidates WHERE run_id = ? AND status = 'imported' AND lead_id IS NOT NULL", run.id);
      tx(() => {
        for (const row of rows) {
          if (!q.get("SELECT 1 FROM leads WHERE id = ?", row.lead_id)) continue;
          if (q.get("SELECT 1 FROM messages WHERE lead_id = ? AND direction = 'out' AND kind = 'campaign'", row.lead_id)) continue; // schon angeschrieben → behalten
          deleteLeadCompletely(row.lead_id);
          removed++;
          if (row.account_id && !q.get("SELECT 1 FROM leads WHERE account_id = ?", row.account_id) && !q.get("SELECT 1 FROM opportunities WHERE account_id = ?", row.account_id)) {
            q.run("DELETE FROM accounts WHERE id = ?", row.account_id);
          }
        }
      });
    }
    q.run("DELETE FROM sourcing_runs WHERE id = ?", run.id);
    return { ok: true, removed };
  });

  r.post("/api/sourcing/tick", async ({ user }) => {
    requireAdmin(user);
    return runSourcingTick();
  });

  r.put("/api/sourcing/settings", ({ body, user }) => {
    requireAdmin(user);
    const patch = {};
    if (body.sourcing_daily_limit !== undefined) patch.sourcing_daily_limit = v.int(body.sourcing_daily_limit, { min: 0, max: 20000, name: "Prüfungen pro Tag" });
    if (body.sourcing_regions !== undefined) patch.sourcing_regions = regionList(body.sourcing_regions);
    saveSettings(patch);
    const s = getSettings();
    return { sourcing_daily_limit: s.sourcing_daily_limit, sourcing_regions: s.sourcing_regions };
  });
}
