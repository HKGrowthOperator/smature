// API: Pipeline (Chancen), „Heute“-Aktionen und Lern-Auswertung bis zum Umsatz.
import { q, update, parseJson } from "../db.js";
import { fail, v } from "../http.js";
import { STAGES, QUALITY_KEYS, LOSS_REASONS, setStage, weightedValue, qualityOverall, defaultProbability } from "../conversion/opportunities.js";
import { meetingBrief, captureDiscovery, analyzeLoss, PAIN_GUIDE } from "../conversion/meeting.js";
import { accountBrain } from "../intel/brain.js";
import { todayActions } from "../orchestration/today.js";
import { learningReport } from "../learning/report.js";
import { aiAvailable } from "../ai/claude.js";

const AI_MISSING = "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN für das Max-Abo fehlt).";

function parseOpp(o) {
  const quality = parseJson(o.quality, {}) || {};
  return {
    ...o, quality, quality_overall: qualityOverall(quality), prep: parseJson(o.prep, null), discovery: parseJson(o.discovery, null),
    attribution: parseJson(o.attribution, {}) || {}, loss: parseJson(o.loss, {}) || {}, weighted: weightedValue(o), stage_label: STAGES[o.stage]
  };
}

function oppRow(id) {
  const o = q.get(`SELECT o.*, a.name AS account_name, a.domain AS account_domain, COALESCE(o.project_id, a.project_id) AS project_id, pj.name AS project_name, pj.color AS project_color,
      pr.name AS product_name, pl.name AS play_name, l.first_name, l.last_name, l.position, l.email, p.name AS person_name, p.role AS person_role, u.name AS owner_name
    FROM opportunities o JOIN accounts a ON a.id = o.account_id LEFT JOIN projects pj ON pj.id = COALESCE(o.project_id, a.project_id)
    LEFT JOIN products pr ON pr.id = o.product_id LEFT JOIN plays pl ON pl.id = o.play_id LEFT JOIN leads l ON l.id = o.lead_id
    LEFT JOIN account_people p ON p.id = o.person_id LEFT JOIN users u ON u.id = o.owner_id WHERE o.id = ?`, id);
  return o ? parseOpp(o) : null;
}

const opp = id => q.get("SELECT * FROM opportunities WHERE id = ?", id) || fail(404, "Chance nicht gefunden");
const projectFilter = query => (query.get("project") ? v.id(query.get("project")) : null);

export function register(r) {
  r.get("/api/today", ({ query, user }) => todayActions({ projectId: projectFilter(query), limit: v.int(query.get("limit"), { min: 5, max: 100, fallback: 25 }), userId: user.id }));

  r.get("/api/learning", ({ query }) => learningReport({ projectId: projectFilter(query) }));

  r.get("/api/opportunities", ({ query }) => {
    const where = [], args = [];
    const pid = projectFilter(query);
    if (pid) { where.push("COALESCE(o.project_id, a.project_id) = ?"); args.push(pid); }
    const stage = query.get("stage");
    if (stage === "open") where.push("o.stage NOT IN ('won','lost')");
    else if (stage && STAGES[stage]) { where.push("o.stage = ?"); args.push(stage); }
    const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const ids = q.all(`SELECT o.id FROM opportunities o JOIN accounts a ON a.id = o.account_id ${sql}
      ORDER BY CASE o.stage WHEN 'proposal' THEN 0 WHEN 'qualified' THEN 1 WHEN 'meeting' THEN 2 WHEN 'won' THEN 3 ELSE 4 END, COALESCE(o.meeting_at, o.updated_at) DESC LIMIT 500`, ...args).map(x => x.id);
    const items = ids.map(oppRow);
    const open = items.filter(o => !["won", "lost"].includes(o.stage));
    return {
      items,
      summary: {
        by_stage: Object.fromEntries(Object.keys(STAGES).map(s => [s, { n: items.filter(o => o.stage === s).length, value: items.filter(o => o.stage === s).reduce((t, o) => t + (o.value_eur || 0), 0) }])),
        open: open.length, weighted: open.reduce((t, o) => t + o.weighted, 0), open_value: open.reduce((t, o) => t + (o.value_eur || 0), 0)
      },
      stages: STAGES, quality_keys: QUALITY_KEYS, loss_reasons: LOSS_REASONS
    };
  });

  r.get("/api/opportunities/:id", ({ params }) => {
    const o = oppRow(v.id(params.id)) || fail(404, "Chance nicht gefunden");
    const brain = accountBrain(o.account_id);
    return { opportunity: o, account: brain.account, people: brain.people, hypotheses: brain.hypotheses, facts: brain.facts, signals: brain.signals, memory: brain.memory.slice(0, 30), stages: STAGES, quality_keys: QUALITY_KEYS, loss_reasons: LOSS_REASONS, pain_guide: PAIN_GUIDE };
  });

  r.put("/api/opportunities/:id", ({ params, body }) => {
    const o = opp(v.id(params.id));
    const row = { updated_at: Date.now() };
    if (body.title !== undefined) row.title = v.str(body.title, { max: 200, required: true, name: "Titel" });
    if (body.value_eur !== undefined) row.value_eur = body.value_eur === null || body.value_eur === "" ? null : v.int(body.value_eur, { min: 0, max: 100000000, name: "Wert" });
    if (body.meeting_at !== undefined) row.meeting_at = body.meeting_at ? v.int(body.meeting_at, { min: 0 }) : null;
    if (body.next_step !== undefined) row.next_step = v.text(body.next_step, { max: 1000 });
    if (body.next_step_at !== undefined) row.next_step_at = body.next_step_at ? v.int(body.next_step_at, { min: 0 }) : null;
    if (body.person_id !== undefined) row.person_id = body.person_id ? (q.get("SELECT id FROM account_people WHERE id = ? AND account_id = ?", v.id(body.person_id), o.account_id) || fail(404, "Person nicht gefunden")).id : null;
    if (body.quality && typeof body.quality === "object") {
      const quality = { ...(parseJson(o.quality, {}) || {}) };
      for (const k of Object.keys(QUALITY_KEYS)) if (body.quality[k] !== undefined) quality[k] = v.int(body.quality[k], { min: 0, max: 100, fallback: 0 });
      row.quality = JSON.stringify(quality);
      if (body.probability === undefined) row.probability = defaultProbability(o.stage, quality);
    }
    if (body.probability !== undefined) row.probability = body.probability === null || body.probability === "" ? null : v.int(body.probability, { min: 0, max: 100 });
    update("opportunities", o.id, row);
    return oppRow(o.id);
  });

  r.delete("/api/opportunities/:id", ({ params }) => {
    q.run("DELETE FROM opportunities WHERE id = ?", v.id(params.id));
    return { ok: true };
  });

  // Phase ändern. Bei „verloren“ Grund + Erkenntnis, bei „gewonnen“ Auftragswert.
  r.post("/api/opportunities/:id/stage", ({ params, body }) => {
    const o = opp(v.id(params.id));
    const stage = v.oneOf(body.stage, Object.keys(STAGES), null) || fail(400, "Unbekannte Phase");
    let lost = null;
    if (stage === "lost") {
      const l = body.loss || {};
      lost = {
        primary: v.oneOf(l.primary, Object.keys(LOSS_REASONS), null) || fail(400, "Hauptgrund für den Verlust angeben"),
        secondary: v.oneOf(l.secondary || "", ["", ...Object.keys(LOSS_REASONS)], ""), underlying: v.text(l.underlying ?? "", { max: 1000 }),
        detectable_earlier: v.bool(l.detectable_earlier, false), signal: v.text(l.signal ?? "", { max: 1000 }), learning: v.text(l.learning ?? "", { max: 1000 }),
        notes: v.text(l.notes ?? "", { max: 5000 })
      };
    }
    const valueEur = body.value_eur === undefined || body.value_eur === "" ? undefined : v.int(body.value_eur, { min: 0, max: 100000000, name: "Wert" });
    if (stage === "won" && !(valueEur ?? o.value_eur)) fail(400, "Auftragswert angeben – sonst lernt das System nicht, was Umsatz bringt");
    setStage(o.id, stage, { valueEur, lost });
    return oppRow(o.id);
  });

  r.post("/api/opportunities/:id/brief", async ({ params }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    const o = opp(v.id(params.id));
    await meetingBrief(o.id);
    return oppRow(o.id);
  });

  r.post("/api/opportunities/:id/discovery", async ({ params, body, user }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    const o = opp(v.id(params.id));
    const notes = v.text(body.notes, { max: 20000, name: "Gesprächsnotizen" });
    if (notes.trim().length < 20) fail(400, "Bitte die Gesprächsnotizen eintragen (Stichpunkte reichen)");
    await captureDiscovery(o.id, notes, { userId: user.id });
    return oppRow(o.id);
  });

  r.post("/api/opportunities/:id/loss-analysis", async ({ params, body }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    const o = opp(v.id(params.id));
    return analyzeLoss(o.id, v.text(body.notes ?? "", { max: 6000 }));
  });
}
