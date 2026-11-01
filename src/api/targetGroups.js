// API: Zielgruppen mit Wissen (Info-Blätter als Text/Markdown/PDF), KI-Profil und Sequenz-Generator.
import { q, insert, update, parseJson } from "../db.js";
import { fail, v } from "../http.js";
import { distillKnowledge, generateSequence, aiAvailable } from "../ai/features.js";
import { registerDocRoutes, listDocs } from "./docs.js";
import { projectId } from "../intel/projects.js";

function readGroup(body, existing = {}) {
  return {
    name: v.str(body.name ?? existing.name, { max: 120, required: true, name: "Name" }),
    description: v.text(body.description ?? existing.description ?? "", { max: 5000 }),
    language: v.oneOf(body.language ?? existing.language ?? "de", ["de", "en"], "de"),
    tone: v.text(body.tone ?? existing.tone ?? "", { max: 2000 }),
    offer: v.text(body.offer ?? existing.offer ?? "", { max: 5000 }),
    cta: v.text(body.cta ?? existing.cta ?? "", { max: 1000 }),
    profile: v.text(body.profile ?? existing.profile ?? "", { max: 60000 }),
    project_id: projectId(body.project_id !== undefined ? body.project_id : existing.project_id)
  };
}

// Weitere Projekte, in denen die Zielgruppe ebenfalls gilt (ohne das Hauptprojekt, ohne Dubletten).
function alsoProjects(body, existing, mainId) {
  const raw = body.also_project_ids !== undefined ? body.also_project_ids : parseJson(existing.also_project_ids, []);
  if (!Array.isArray(raw)) fail(400, "Weitere Projekte als Liste angeben");
  const ids = [...new Set(raw.map(projectId).filter(id => id && id !== mainId))];
  return JSON.stringify(ids);
}

function readGroupRow(body, existing = {}) {
  const row = readGroup(body, existing);
  return { ...row, also_project_ids: alsoProjects(body, existing, row.project_id) };
}

const withProjects = tg => tg && { ...tg, also_project_ids: parseJson(tg.also_project_ids, []) };

function groupWithDocs(id) {
  const tg = q.get("SELECT * FROM target_groups WHERE id = ?", id);
  if (!tg) return null;
  const docs = listDocs("target_group_id", id);
  const stats = q.get(`SELECT (SELECT COUNT(*) FROM campaigns WHERE target_group_id = ?) AS campaigns, (SELECT COUNT(*) FROM lead_lists WHERE target_group_id = ?) AS lists`, id, id);
  return { ...withProjects(tg), docs, ...stats };
}

export function register(r) {
  r.get("/api/target-groups", () => q.all(`SELECT tg.*, (SELECT COUNT(*) FROM knowledge_docs WHERE target_group_id = tg.id) AS doc_count,
    (SELECT COUNT(*) FROM campaigns WHERE target_group_id = tg.id) AS campaign_count FROM target_groups tg ORDER BY tg.name`).map(withProjects));

  r.post("/api/target-groups", ({ body }) => {
    const now = Date.now();
    const id = insert("target_groups", { ...readGroupRow(body), created_at: now, updated_at: now });
    return groupWithDocs(id);
  });

  r.get("/api/target-groups/:id", ({ params }) => groupWithDocs(v.id(params.id)) || fail(404, "Zielgruppe nicht gefunden"));

  r.put("/api/target-groups/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const existing = q.get("SELECT * FROM target_groups WHERE id = ?", id) || fail(404, "Zielgruppe nicht gefunden");
    const row = readGroupRow(body, existing);
    if (row.profile !== existing.profile) row.profile_updated_at = Date.now();
    update("target_groups", id, { ...row, updated_at: Date.now() });
    return groupWithDocs(id);
  });

  r.delete("/api/target-groups/:id", ({ params }) => {
    q.run("DELETE FROM target_groups WHERE id = ?", v.id(params.id));
    return { ok: true };
  });

  registerDocRoutes(r, { base: "/api/target-groups", table: "target_groups", column: "target_group_id", label: "Zielgruppe" });

  r.post("/api/target-groups/:id/distill", async ({ params }) => {
    if (!aiAvailable()) fail(400, "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN fehlt).");
    const id = v.id(params.id);
    await distillKnowledge("target_group", id);
    return groupWithDocs(id);
  });

  r.post("/api/target-groups/:id/generate-sequence", async ({ params, body }) => {
    if (!aiAvailable()) fail(400, "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN fehlt).");
    return generateSequence({ targetGroupId: v.id(params.id), productId: body.product_id ? v.id(body.product_id) : null }, {
      steps: v.int(body.steps, { min: 1, max: 6, fallback: 3 }),
      goal: v.text(body.goal ?? "", { max: 2000 }),
      notes: v.text(body.notes ?? "", { max: 4000 }),
      legalBasis: body.legal_basis === "cold" ? "cold" : "consent"
    });
  });
}
