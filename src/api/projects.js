// API: Projekte (Themenordner) und das Board mit einer Spalte je Projekt – Produkte, Zielgruppen, Plays,
// Kampagnen, Firmen nach Status, Pipeline und offene Aktionen auf einen Blick.
import { q, insert, update } from "../db.js";
import { fail, v } from "../http.js";
import { listProjects } from "../intel/projects.js";
import { LIFECYCLE } from "../intel/lifecycle.js";
import { weightedValue } from "../conversion/opportunities.js";
import { todayActions } from "../orchestration/today.js";

const COLOR = /^#[0-9a-f]{6}$/i;

function slugify(name) {
  return String(name).toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "projekt";
}

function readProject(body, existing = {}) {
  const color = String(body.color ?? existing.color ?? "");
  return {
    name: v.str(body.name ?? existing.name, { max: 80, required: true, name: "Name" }),
    description: v.text(body.description ?? existing.description ?? "", { max: 2000 }),
    color: COLOR.test(color) ? color : existing.color || "#555555",
    position: v.int(body.position ?? existing.position, { min: 0, max: 1000, fallback: 0 })
  };
}

// Eine Spalte des Boards. projectId = null → alles ohne Projekt.
function column(project) {
  const pid = project?.id ?? null;
  const eq = col => (pid === null ? `${col} IS NULL` : `${col} = ${Number(pid)}`);
  const products = q.all(`SELECT p.id, p.name, p.booking_url != '' AS has_booking, p.kit_url != '' AS has_kit,
      (SELECT COUNT(*) FROM campaigns WHERE product_id = p.id AND is_template = 1 AND approved_hash IS NOT NULL) AS approved_templates,
      (SELECT COUNT(*) FROM campaigns WHERE product_id = p.id AND is_template = 0 AND status = 'active') AS active_campaigns
    FROM products p WHERE ${eq("p.project_id")} ORDER BY p.name`);
  // Zielgruppen gelten im Hauptprojekt und in den zusätzlich gewählten Projekten (geteilte Zielgruppen).
  const inGroup = col => (pid === null ? `${col} IS NULL` : `(${col} = ${Number(pid)} OR ${Number(pid)} IN (SELECT value FROM json_each(tg.also_project_ids)))`);
  const groups = q.all(`SELECT tg.id, tg.name, ${pid === null ? "0" : `COALESCE(tg.project_id, 0) != ${Number(pid)}`} AS shared,
      (SELECT COUNT(*) FROM knowledge_docs WHERE target_group_id = tg.id) AS docs FROM target_groups tg WHERE ${inGroup("tg.project_id")} ORDER BY tg.name`);
  const groupIds = groups.map(g => Number(g.id));
  const plays = q.all(`SELECT id, name, persona, angle, status FROM plays WHERE ${eq("project_id")} ORDER BY status = 'active' DESC, name`);
  const campaigns = q.all(`SELECT c.id, c.name, c.status, (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id) AS leads,
      (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id AND replied_at IS NOT NULL) AS replied
    FROM campaigns c LEFT JOIN products p ON p.id = c.product_id LEFT JOIN target_groups tg ON tg.id = c.target_group_id
    WHERE c.is_template = 0 AND c.status IN ('active','paused','draft') AND ${pid === null ? "p.project_id IS NULL AND tg.project_id IS NULL" : `(p.project_id = ${Number(pid)} OR (p.project_id IS NULL AND tg.project_id = ${Number(pid)}))`}
    ORDER BY c.status = 'active' DESC, c.created_at DESC LIMIT 12`);
  // Listen des Projekts plus Listen der geteilten Zielgruppen (Liste ohne Projekt oder im Hauptprojekt der Zielgruppe).
  const sharedLists = pid !== null && groupIds.length
    ? ` OR ll.target_group_id IN (SELECT tg2.id FROM target_groups tg2 WHERE tg2.id IN (${groupIds.join(",")}) AND (ll.project_id IS NULL OR ll.project_id = tg2.project_id))` : "";
  const lists = q.all(`SELECT ll.id, ll.name, (SELECT COUNT(*) FROM lead_list_members WHERE list_id = ll.id) AS leads FROM lead_lists ll WHERE (${eq("ll.project_id")}${sharedLists}) ORDER BY ll.created_at DESC LIMIT 8`);
  const lifecycle = Object.fromEntries(q.all(`SELECT lifecycle, COUNT(*) AS n FROM accounts WHERE ${eq("project_id")} GROUP BY lifecycle`).map(r => [r.lifecycle, r.n]));
  const topAccounts = q.all(`SELECT id, name, domain, lifecycle, opportunity_score, why_now FROM accounts WHERE ${eq("project_id")}
    AND lifecycle IN ('triggered','qualified','outreach_ready','engaged','meeting','opportunity','proposal') ORDER BY lifecycle = 'triggered' DESC, COALESCE(opportunity_score, 0) DESC LIMIT 5`)
    .map(a => ({ ...a, lifecycle_label: LIFECYCLE[a.lifecycle] }));
  const opps = q.all(`SELECT o.stage, o.value_eur, o.probability, o.quality, o.closed_at FROM opportunities o JOIN accounts a ON a.id = o.account_id WHERE ${pid === null ? "o.project_id IS NULL AND a.project_id IS NULL" : `COALESCE(o.project_id, a.project_id) = ${Number(pid)}`}`);
  const open = opps.filter(o => !["won", "lost"].includes(o.stage));
  const actions = pid === null ? null : todayActions({ projectId: pid, limit: 5 });
  return {
    project: project || { id: null, name: "Ohne Projekt", color: "#888888", description: "Noch keinem Projekt zugeordnet" },
    products, target_groups: groups, plays, campaigns, lists,
    accounts: { total: Object.values(lifecycle).reduce((a, b) => a + b, 0), lifecycle, top: topAccounts },
    pipeline: {
      open: open.length, weighted: open.reduce((s, o) => s + weightedValue(o), 0),
      by_stage: Object.fromEntries(["meeting", "qualified", "proposal"].map(st => [st, open.filter(o => o.stage === st).length])),
      won: opps.filter(o => o.stage === "won").length, won_value: opps.filter(o => o.stage === "won").reduce((s, o) => s + (o.value_eur || 0), 0)
    },
    actions: actions ? { items: actions.items, total: actions.items.length + actions.more, replies_waiting: actions.stats.replies_waiting } : null
  };
}

export function register(r) {
  r.get("/api/projects", () => listProjects().map(p => ({
    ...p,
    products: q.value("SELECT COUNT(*) FROM products WHERE project_id = ?", p.id),
    target_groups: q.value("SELECT COUNT(*) FROM target_groups WHERE project_id = ? OR ? IN (SELECT value FROM json_each(also_project_ids))", p.id, p.id),
    accounts: q.value("SELECT COUNT(*) FROM accounts WHERE project_id = ?", p.id)
  })));

  r.post("/api/projects", ({ body }) => {
    const row = readProject(body);
    let slug = slugify(row.name), n = 2;
    while (q.get("SELECT 1 FROM projects WHERE slug = ?", slug)) slug = `${slugify(row.name)}-${n++}`;
    const now = Date.now();
    const id = insert("projects", { ...row, position: row.position || (q.value("SELECT COALESCE(MAX(position), 0) + 1 FROM projects")), slug, created_at: now, updated_at: now });
    return q.get("SELECT * FROM projects WHERE id = ?", id);
  });

  r.put("/api/projects/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const existing = q.get("SELECT * FROM projects WHERE id = ?", id) || fail(404, "Projekt nicht gefunden");
    update("projects", id, { ...readProject(body, existing), updated_at: Date.now() });
    return q.get("SELECT * FROM projects WHERE id = ?", id);
  });

  r.delete("/api/projects/:id", ({ params }) => {
    // Zuordnungen werden per ON DELETE SET NULL gelöst – nichts geht verloren, es landet unter „Ohne Projekt“.
    q.run("DELETE FROM projects WHERE id = ?", v.id(params.id));
    return { ok: true };
  });

  r.get("/api/projects/board", () => {
    const columns = listProjects().map(column);
    const unassigned = column(null);
    const hasUnassigned = unassigned.products.length || unassigned.target_groups.length || unassigned.plays.length || unassigned.campaigns.length || unassigned.accounts.total;
    return { columns: hasUnassigned ? [...columns, unassigned] : columns };
  });

  r.get("/api/projects/:id/board", ({ params }) => {
    const p = q.get("SELECT * FROM projects WHERE id = ?", v.id(params.id)) || fail(404, "Projekt nicht gefunden");
    return column(p);
  });
}
