// API: Firmen (Account Brain) mit Fakten, Anlässen, Hypothesen, Gedächtnis, Personen, Recherche und Plays.
import { q, tx, insert, update, likeAny } from "../db.js";
import { fail, v } from "../http.js";
import { createAccount, normalizeDomain, mergeAccounts, backfillAccounts } from "../intel/accounts.js";
import { accountBrain } from "../intel/brain.js";
import { LIFECYCLE, setLifecycle } from "../intel/lifecycle.js";
import { researchAccount, opportunityScore, SIGNAL_TYPES, COMMITTEE_ROLES } from "../intel/research.js";
import { projectId } from "../intel/projects.js";
import { startJob } from "../engine/jobs.js";
import { createTask, TASK_TYPES, CALL_TYPES } from "../engine/followup.js";
import { createOpportunity, STAGES, QUALITY_KEYS, LOSS_REASONS } from "../conversion/opportunities.js";
import { aiAvailable } from "../ai/claude.js";
import { DAY_MS } from "../lib/time.js";
import { getSettings } from "../settings.js";
import { applyNoteTags } from "../engine/noteTags.js";

const AI_MISSING = "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN für das Max-Abo fehlt).";
export const MEMORY_KINDS = {
  note: "Notiz", objection: "Einwand", timing: "Zeitpunkt", system: "System / Software", next_step: "Nächster Schritt",
  promise: "Zusage", do_not_claim: "Nicht behaupten", rejected_assumption: "Widerlegte Annahme"
};
const HYPOTHESIS_KINDS = { pain: "Pain", why_now: "Why now", value: "Nutzen" };
const SORTS = {
  opportunity: "COALESCE(a.opportunity_score, -1) DESC, a.updated_at DESC",
  recent: "a.updated_at DESC",
  name: "a.name COLLATE NOCASE",
  check: "a.next_check_at IS NULL, a.next_check_at"
};

function account(id) {
  return q.get("SELECT * FROM accounts WHERE id = ?", id) || fail(404, "Firma nicht gefunden");
}

function optionalRef(table, value, name) {
  if (value === undefined || value === null || value === "" || Number(value) === 0) return null;
  const id = v.id(value, name);
  if (!q.get(`SELECT 1 FROM ${table} WHERE id = ?`, id)) fail(400, `${name} nicht gefunden`);
  return id;
}

function url(value, name = "Quelle") {
  const s = v.str(value ?? "", { max: 1000, name });
  if (!s) return "";
  try {
    const u = new URL(s);
    if (!["http:", "https:"].includes(u.protocol)) throw new Error();
    return u.toString();
  } catch {
    fail(400, `${name}: keine gültige Adresse (mit https://)`);
  }
}

function researchJob(ids, userId, label) {
  return startJob("research", ids, async id => {
    const r = await researchAccount(id, { userId });
    return r.state || "recherchiert";
  }, { label });
}

function readPerson(body, existing = {}) {
  const get = k => (body[k] !== undefined ? body[k] : existing[k]);
  return {
    name: v.str(get("name") ?? "", { max: 160 }),
    role: v.str(get("role") ?? "", { max: 160 }),
    committee_role: v.oneOf(get("committee_role") || "", ["", ...Object.keys(COMMITTEE_ROLES)], ""),
    decision_power: v.oneOf(get("decision_power") || "", ["", "high", "medium", "low"], ""),
    pain_influence: v.oneOf(get("pain_influence") || "", ["", "very_high", "high", "medium", "low"], ""),
    phone: v.str(get("phone") ?? "", { max: 60 }),
    email: v.str(get("email") ?? "", { max: 254 }),
    notes: v.text(get("notes") ?? "", { max: 4000 }),
    do_not_contact: v.bool(get("do_not_contact"), false) ? 1 : 0
  };
}

export function register(r) {
  r.get("/api/revenue/meta", () => ({
    lifecycle: LIFECYCLE, stages: STAGES, quality_keys: QUALITY_KEYS, loss_reasons: LOSS_REASONS, signal_types: SIGNAL_TYPES,
    committee_roles: COMMITTEE_ROLES, memory_kinds: MEMORY_KINDS, hypothesis_kinds: HYPOTHESIS_KINDS, task_types: TASK_TYPES
  }));

  r.get("/api/accounts", ({ query }) => {
    const where = [], args = [];
    const pid = query.get("project");
    if (pid === "none") where.push("a.project_id IS NULL");
    else if (pid) { where.push("a.project_id = ?"); args.push(v.id(pid)); }
    const lc = query.get("lifecycle");
    if (lc && LIFECYCLE[lc]) { where.push("a.lifecycle = ?"); args.push(lc); }
    else if (lc === "active") where.push("a.lifecycle NOT IN ('disqualified','suppressed','lost','won')");
    const search = String(query.get("q") || "").trim();
    if (search) { where.push("(a.name LIKE ? ESCAPE '\\' OR a.domain LIKE ? ESCAPE '\\' OR a.city LIKE ? ESCAPE '\\' OR a.industry LIKE ? ESCAPE '\\')"); args.push(...Array(4).fill(likeAny(search))); }
    if (query.get("min_score")) { where.push("a.opportunity_score >= ?"); args.push(v.int(query.get("min_score"), { min: 0, max: 100, fallback: 0 })); }
    const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = v.int(query.get("limit"), { min: 1, max: 500, fallback: 50 });
    const page = v.int(query.get("page"), { min: 1, max: 100000, fallback: 1 });
    const order = SORTS[query.get("sort")] || SORTS.opportunity;
    const total = q.value(`SELECT COUNT(*) FROM accounts a ${sql}`, ...args);
    const items = q.all(`SELECT a.id, a.name, a.domain, a.city, a.industry, a.lifecycle, a.lifecycle_at, a.fit_score, a.pain_score, a.timing_score, a.contactability_score,
        a.opportunity_score, a.why_now, a.researched_at, a.research_error, a.next_check_at, a.project_id, pj.name AS project_name, pj.color AS project_color, a.updated_at,
        (SELECT COUNT(*) FROM account_people WHERE account_id = a.id) AS people, (SELECT COUNT(*) FROM account_signals WHERE account_id = a.id AND status = 'active') AS signals,
        (SELECT COUNT(*) FROM opportunities WHERE account_id = a.id AND stage NOT IN ('won','lost')) AS open_opps
      FROM accounts a LEFT JOIN projects pj ON pj.id = a.project_id ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit)
      .map(a => ({ ...a, lifecycle_label: LIFECYCLE[a.lifecycle] }));
    const counts = Object.fromEntries(q.all(`SELECT a.lifecycle, COUNT(*) AS n FROM accounts a ${pid === "none" ? "WHERE a.project_id IS NULL" : pid ? "WHERE a.project_id = ?" : ""} GROUP BY a.lifecycle`, ...(pid && pid !== "none" ? [v.id(pid)] : [])).map(c => [c.lifecycle, c.n]));
    return { items, total, page, limit, counts };
  });

  // Firma per Domain/Website anlegen (z. B. aus einer Messe-Liste) und optional gleich recherchieren.
  r.post("/api/accounts", ({ body, user }) => {
    const domain = normalizeDomain(body.domain || body.website);
    if (!domain && !String(body.name || "").trim()) fail(400, "Domain oder Website angeben");
    if (domain && q.get("SELECT 1 FROM accounts WHERE domain = ?", domain)) fail(409, "Diese Firma gibt es schon");
    // Eine eingefügte Adresse mit http(s):// gilt zugleich als Website (Pfad und Protokoll bleiben erhalten).
    const site = body.website || (/^https?:\/\//i.test(String(body.domain || "").trim()) ? String(body.domain).trim() : "");
    const a = createAccount({
      domain, name: v.str(body.name ?? "", { max: 200 }), website: site ? url(site, "Website") : "",
      industry: v.str(body.industry ?? "", { max: 200 }), city: v.str(body.city ?? "", { max: 200 }),
      project_id: projectId(body.project_id), product_id: optionalRef("products", body.product_id, "Produkt"), owner_id: user.id
    });
    let job = null;
    if (body.research && aiAvailable() && (a.domain || a.website)) job = researchJob([a.id], user.id, `Recherche: ${a.name}`);
    return { account: a, job };
  });

  // Mehrere Firmen recherchieren (Auswahl oder alle eines Status).
  r.post("/api/accounts/research", ({ body, user }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    let ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length && body.lifecycle && LIFECYCLE[body.lifecycle]) {
      ids = q.all(`SELECT id FROM accounts WHERE lifecycle = ? ${body.project_id ? "AND project_id = ?" : ""} AND (domain IS NOT NULL OR website != '') ORDER BY id LIMIT 200`, body.lifecycle, ...(body.project_id ? [v.id(body.project_id)] : [])).map(r => r.id);
    }
    if (body.only_new !== false) ids = ids.filter(id => !q.value("SELECT researched_at FROM accounts WHERE id = ?", id));
    if (!ids.length) fail(400, "Keine (unrecherchierten) Firmen ausgewählt");
    if (ids.length > 200) fail(400, "Maximal 200 Firmen pro Auftrag – die Recherche nutzt das Max-Abo");
    return researchJob(ids, user.id, `Recherche: ${ids.length} Firmen`);
  });

  r.post("/api/accounts/backfill", () => ({ linked: backfillAccounts(20000) }));

  r.get("/api/accounts/:id", ({ params }) => accountBrain(v.id(params.id)) || fail(404, "Firma nicht gefunden"));

  r.put("/api/accounts/:id", ({ params, body }) => {
    const a = account(v.id(params.id));
    const row = {};
    for (const [k, max] of [["name", 200], ["industry", 200], ["city", 200], ["employees", 60]]) if (body[k] !== undefined) row[k] = v.str(body[k], { max });
    if (body.summary !== undefined) row.summary = v.text(body.summary, { max: 4000 });
    if (body.why_now !== undefined) row.why_now = v.text(body.why_now, { max: 2000 });
    if (body.website !== undefined) row.website = url(body.website, "Website");
    if (body.domain !== undefined) {
      const d = normalizeDomain(body.domain);
      if (String(body.domain || "").trim() && !d) fail(400, "Domain ungültig (z. B. beispiel.de)");
      if (d && d !== a.domain && q.get("SELECT 1 FROM accounts WHERE domain = ? AND id != ?", d, a.id)) fail(409, "Diese Domain gehört schon zu einer anderen Firma – „Zusammenführen“ nutzen");
      row.domain = d || null;
    }
    if (body.project_id !== undefined) row.project_id = projectId(body.project_id);
    if (body.product_id !== undefined) row.product_id = optionalRef("products", body.product_id, "Produkt");
    if (body.play_id !== undefined) row.play_id = optionalRef("plays", body.play_id, "Play");
    if (body.owner_id !== undefined) row.owner_id = optionalRef("users", body.owner_id, "Verantwortliche Person");
    if (body.next_check_at !== undefined) row.next_check_at = body.next_check_at ? v.int(body.next_check_at, { min: 0 }) : null;
    update("accounts", a.id, { ...row, updated_at: Date.now() });
    if (body.project_id !== undefined) q.run("UPDATE opportunities SET project_id = ? WHERE account_id = ? AND stage NOT IN ('won','lost')", row.project_id, a.id);
    return accountBrain(a.id);
  });

  r.delete("/api/accounts/:id", ({ params }) => {
    const id = v.id(params.id);
    if (q.get("SELECT 1 FROM opportunities WHERE account_id = ?", id)) fail(409, "Die Firma hat Chancen – für die Auswertung bitte nicht löschen, sondern sperren oder als verloren markieren.");
    tx(() => {
      // Aufgaben der Leads bleiben erhalten (nur die Firmen-Zuordnung entfällt).
      q.run("UPDATE tasks SET account_id = NULL, person_id = NULL WHERE account_id = ? AND lead_id IS NOT NULL", id);
      q.run("UPDATE leads SET account_id = NULL WHERE account_id = ?", id);
      q.run("DELETE FROM accounts WHERE id = ?", id);
    });
    return { ok: true };
  });

  r.post("/api/accounts/:id/lifecycle", ({ params, body, user }) => {
    const a = account(v.id(params.id));
    const state = v.oneOf(body.state, Object.keys(LIFECYCLE), null) || fail(400, "Unbekannter Status");
    const reason = v.text(body.reason ?? "", { max: 1000 });
    setLifecycle(a.id, state, { reason, by: "user" });
    const days = state === "not_now" ? v.int(body.days, { min: 1, max: 730, fallback: 90 }) : state === "watching" ? Number(getSettings().watch_interval_days) || 30 : null;
    if (days) q.run("UPDATE accounts SET next_check_at = ? WHERE id = ?", Date.now() + days * DAY_MS, a.id);
    if (reason) q.run("INSERT INTO account_memory (account_id, kind, text, source, user_id, created_at) VALUES (?, ?, ?, 'user', ?, ?)", a.id, state === "not_now" ? "timing" : "note", `${LIFECYCLE[state]}: ${reason}`, user.id, Date.now());
    if (state === "suppressed") {
      q.run("UPDATE account_people SET do_not_contact = 1 WHERE account_id = ?", a.id);
      q.run("UPDATE campaign_leads SET status = 'stopped', last_error = 'Firma gesperrt', next_at = NULL WHERE lead_id IN (SELECT id FROM leads WHERE account_id = ?) AND status IN ('queued','active','paused')", a.id);
      q.run("UPDATE tasks SET status = 'dismissed', done_at = ? WHERE account_id = ? AND status = 'open'", Date.now(), a.id);
    }
    return accountBrain(a.id);
  });

  r.post("/api/accounts/:id/research", ({ params, user }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    const a = account(v.id(params.id));
    if (!a.domain && !a.website) fail(400, "Keine Website/Domain hinterlegt");
    return researchJob([a.id], user.id, `Recherche: ${a.name}`);
  });

  r.post("/api/accounts/:id/merge", ({ params, body }) => {
    const target = account(v.id(params.id));
    const source = account(v.id(body.source_id, "Firma"));
    mergeAccounts(target.id, source.id);
    return accountBrain(target.id);
  });

  // Fakten (vom Nutzer bestätigt) – mit Quelle als „verifiziert“, sonst als Schätzung.
  r.post("/api/accounts/:id/facts", ({ params, body }) => {
    const a = account(v.id(params.id));
    const source = url(body.source_url);
    insert("account_facts", {
      account_id: a.id, key: v.str(body.key ?? "", { max: 80 }), statement: v.str(body.statement, { max: 1000, required: true, name: "Aussage" }),
      type: source || body.type === "verified" ? "verified" : "estimate", confidence: v.int(body.confidence, { min: 0, max: 100, fallback: source ? 95 : 70 }),
      source_type: source ? "website" : "user", source_url: source, quote: v.text(body.quote ?? "", { max: 1000 }), observed_at: Date.now(),
      status: "active", created_by: "user", created_at: Date.now()
    });
    return accountBrain(a.id);
  });

  r.delete("/api/accounts/:id/facts/:fid", ({ params }) => {
    const a = account(v.id(params.id));
    q.run("UPDATE account_facts SET status = 'outdated' WHERE id = ? AND account_id = ?", v.id(params.fid), a.id);
    return accountBrain(a.id);
  });

  // Anlass von Hand (z. B. aus dem Gespräch, Zeitung, Messe). Eine passende Firma springt auf „Anlass erkannt“.
  r.post("/api/accounts/:id/signals", ({ params, body, user }) => {
    const a = account(v.id(params.id));
    const now = Date.now();
    const title = v.str(body.title, { max: 300, required: true, name: "Anlass" });
    insert("account_signals", {
      account_id: a.id, type: v.oneOf(body.type || "other", Object.keys(SIGNAL_TYPES), "other"), title, detail: v.text(body.detail ?? "", { max: 2000 }),
      source_url: url(body.source_url), quote: v.text(body.quote ?? "", { max: 1000 }), strength: v.int(body.strength, { min: 0, max: 100, fallback: 70 }),
      confidence: 90, observed_at: now, first_seen_at: now, status: "active", created_by: "user", created_at: now
    });
    if (["discovered", "researched", "qualified", "watching", "no_response", "not_now"].includes(a.lifecycle) && (a.fit_score === null || a.fit_score >= 50)) {
      setLifecycle(a.id, "triggered", { reason: title, by: "user" });
      q.run("UPDATE accounts SET timing_score = MAX(COALESCE(timing_score, 0), ?), why_now = CASE WHEN why_now = '' THEN ? ELSE why_now END, updated_at = ? WHERE id = ?", 75, title, now, a.id);
      const s = q.get("SELECT fit_score, pain_score, timing_score, contactability_score FROM accounts WHERE id = ?", a.id);
      const score = opportunityScore({ fit: s.fit_score, pain: s.pain_score, timing: s.timing_score, contactability: s.contactability_score });
      if (score !== null) q.run("UPDATE accounts SET opportunity_score = ? WHERE id = ?", score, a.id);
      createTask({ type: "todo", account_id: a.id, title: `Neuer Anlass: ${a.name} – ${title} – in eine Kampagne aufnehmen`, priority: 400, user_id: user.id });
    }
    return accountBrain(a.id);
  });

  r.put("/api/accounts/:id/signals/:sid", ({ params, body }) => {
    const a = account(v.id(params.id));
    q.run("UPDATE account_signals SET status = ? WHERE id = ? AND account_id = ?", v.oneOf(body.status, ["active", "expired", "wrong"], "active"), v.id(params.sid), a.id);
    return accountBrain(a.id);
  });

  r.post("/api/accounts/:id/hypotheses", ({ params, body }) => {
    const a = account(v.id(params.id));
    const now = Date.now();
    insert("account_hypotheses", {
      account_id: a.id, kind: v.oneOf(body.kind || "pain", Object.keys(HYPOTHESIS_KINDS), "pain"), statement: v.str(body.statement, { max: 1000, required: true, name: "Hypothese" }),
      interpretation: v.text(body.interpretation ?? "", { max: 2000 }), confidence: v.int(body.confidence, { min: 0, max: 100, fallback: 50 }), evidence: "{}",
      status: "open", rank: 0, created_by: "user", created_at: now, updated_at: now
    });
    return accountBrain(a.id);
  });

  // Hypothese bestätigen oder widerlegen – widerlegte Annahmen nutzt die KI nie wieder.
  r.put("/api/accounts/:id/hypotheses/:hid", ({ params, body, user }) => {
    const a = account(v.id(params.id));
    const h = q.get("SELECT * FROM account_hypotheses WHERE id = ? AND account_id = ?", v.id(params.hid), a.id) || fail(404, "Hypothese nicht gefunden");
    const status = v.oneOf(body.status, ["open", "confirmed", "rejected"], h.status);
    const note = v.text(body.note ?? "", { max: 1000 });
    const now = Date.now();
    update("account_hypotheses", h.id, { status, resolved_note: note, resolved_at: status === "open" ? null : now, updated_at: now, ...(body.statement !== undefined ? { statement: v.str(body.statement, { max: 1000, required: true, name: "Hypothese" }) } : {}) });
    if (status === "rejected" && h.status !== "rejected") {
      q.run("INSERT INTO account_memory (account_id, kind, text, source, user_id, created_at) VALUES (?, 'rejected_assumption', ?, 'user', ?, ?)", a.id, `${h.statement}${note ? ` (${note})` : ""}`, user.id, now);
    }
    return accountBrain(a.id);
  });

  r.post("/api/accounts/:id/memory", ({ params, body, user }) => {
    const a = account(v.id(params.id));
    insert("account_memory", {
      account_id: a.id, kind: v.oneOf(body.kind || "note", Object.keys(MEMORY_KINDS), "note"), text: v.str(body.text, { max: 2000, required: true, name: "Text" }),
      source: "user", meta: "{}", lead_id: body.lead_id ? v.id(body.lead_id) : null, user_id: user.id, created_at: Date.now()
    });
    const tags = applyNoteTags(body.text, { accountId: a.id, leadId: body.lead_id ? v.id(body.lead_id) : null });
    return { ...accountBrain(a.id), note_tags: tags };
  });

  r.delete("/api/accounts/:id/memory/:mid", ({ params }) => {
    const a = account(v.id(params.id));
    q.run("DELETE FROM account_memory WHERE id = ? AND account_id = ?", v.id(params.mid), a.id);
    return accountBrain(a.id);
  });

  // Personen im Buying Committee – auch ohne E-Mail (z. B. Geschäftsführung aus dem Impressum für einen Anruf).
  r.post("/api/accounts/:id/people", ({ params, body }) => {
    const a = account(v.id(params.id));
    const row = readPerson(body);
    if (!row.name && !row.role) fail(400, "Name oder Rolle angeben");
    const now = Date.now();
    insert("account_people", { account_id: a.id, ...row, source: "user", source_url: "", created_at: now, updated_at: now });
    return accountBrain(a.id);
  });

  r.put("/api/accounts/:id/people/:pid", ({ params, body }) => {
    const a = account(v.id(params.id));
    const p = q.get("SELECT * FROM account_people WHERE id = ? AND account_id = ?", v.id(params.pid), a.id) || fail(404, "Person nicht gefunden");
    const row = readPerson(body, p);
    update("account_people", p.id, { ...row, updated_at: Date.now() });
    // „Nicht kontaktieren“: laufende Sequenzen und offene Aufgaben dieser Person sofort stoppen.
    if (row.do_not_contact && !p.do_not_contact && p.lead_id) {
      q.run("UPDATE campaign_leads SET status = 'stopped', last_error = 'Nicht kontaktieren (Firmenprofil)', next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", p.lead_id);
      q.run("UPDATE tasks SET status = 'dismissed', done_at = ? WHERE lead_id = ? AND status = 'open'", Date.now(), p.lead_id);
      q.run("UPDATE conversations SET nurture_next_at = NULL, nurture_stopped = 'do_not_contact' WHERE lead_id = ?", p.lead_id);
    }
    if (row.do_not_contact && !p.do_not_contact) q.run("UPDATE tasks SET status = 'dismissed', done_at = ? WHERE person_id = ? AND status = 'open'", Date.now(), p.id);
    if (p.lead_id && body.phone !== undefined) q.run("UPDATE leads SET phone = ?, updated_at = ? WHERE id = ?", v.str(body.phone, { max: 60 }), Date.now(), p.lead_id);
    return accountBrain(a.id);
  });

  r.delete("/api/accounts/:id/people/:pid", ({ params }) => {
    const a = account(v.id(params.id));
    q.run("DELETE FROM account_people WHERE id = ? AND account_id = ?", v.id(params.pid), a.id);
    return accountBrain(a.id);
  });

  // Aufgabe/Anruf für die Firma (optional für eine bestimmte Person).
  r.post("/api/accounts/:id/tasks", ({ params, body, user }) => {
    const a = account(v.id(params.id));
    const person = body.person_id ? q.get("SELECT * FROM account_people WHERE id = ? AND account_id = ?", v.id(body.person_id), a.id) || fail(404, "Person nicht gefunden") : null;
    const type = v.oneOf(body.type || "todo", Object.keys(TASK_TYPES), "todo");
    if (CALL_TYPES.includes(type)) fail(400, "Anrufe laufen in eurer Sales App – hier nur Cold Mailing.");
    createTask({
      type, account_id: a.id, person_id: person?.id || null, lead_id: person?.lead_id || null,
      title: v.str(body.title || `${TASK_TYPES[type]}: ${person?.name || person?.role || a.name}`, { max: 300 }),
      due_at: body.due_at ? v.int(body.due_at, { min: 0 }) : Date.now(), notes: v.text(body.notes ?? "", { max: 5000 }),
      product_id: a.product_id || null, user_id: user.id, priority: v.int(body.priority, { min: 0, max: 1000, fallback: 0 })
    });
    return accountBrain(a.id);
  });

  r.post("/api/accounts/:id/opportunities", ({ params, body, user }) => {
    const a = account(v.id(params.id));
    const person = body.person_id ? q.get("SELECT * FROM account_people WHERE id = ? AND account_id = ?", v.id(body.person_id), a.id) || fail(404, "Person nicht gefunden") : null;
    const id = createOpportunity({
      accountId: a.id, leadId: person?.lead_id || null, personId: person?.id || null, title: v.str(body.title ?? "", { max: 200 }),
      stage: v.oneOf(body.stage || "meeting", ["meeting", "qualified", "proposal"], "meeting"), meetingAt: body.meeting_at ? v.int(body.meeting_at, { min: 0 }) : null,
      valueEur: body.value_eur ? v.int(body.value_eur, { min: 0, max: 100000000 }) : null, ownerId: user.id
    });
    return { opportunity_id: id, brain: accountBrain(a.id) };
  });

  // Plays: Branche × Anlass × Persona × Pain × Angle × Beleg × Kanal × CTA.
  const readPlay = (body, existing = {}) => {
    const get = k => (body[k] !== undefined ? body[k] : existing[k]);
    return {
      name: v.str(get("name"), { max: 160, required: true, name: "Name" }),
      project_id: projectId(get("project_id")), product_id: optionalRef("products", get("product_id"), "Produkt"),
      industry: v.str(get("industry") ?? "", { max: 300 }), trigger_type: v.oneOf(get("trigger_type") || "", ["", ...Object.keys(SIGNAL_TYPES)], ""),
      persona: v.str(get("persona") ?? "", { max: 300 }), pain: v.text(get("pain") ?? "", { max: 1000 }), angle: v.text(get("angle") ?? "", { max: 1000 }),
      proof: v.text(get("proof") ?? "", { max: 1000 }), channel: v.oneOf(get("channel") || "call", ["call", "email", "call_email"], "call"),
      cta: v.text(get("cta") ?? "", { max: 500 }), status: v.oneOf(get("status") || "active", ["active", "paused"], "active")
    };
  };
  const playRow = id => q.get(`SELECT p.*, pj.name AS project_name, pr.name AS product_name, (SELECT COUNT(*) FROM accounts WHERE play_id = p.id) AS accounts,
    (SELECT COUNT(*) FROM opportunities WHERE play_id = p.id) AS opportunities, (SELECT COUNT(*) FROM opportunities WHERE play_id = p.id AND stage = 'won') AS won
    FROM plays p LEFT JOIN projects pj ON pj.id = p.project_id LEFT JOIN products pr ON pr.id = p.product_id WHERE p.id = ?`, id);

  r.get("/api/plays", ({ query }) => q.all(`SELECT id FROM plays ${query.get("project") ? "WHERE project_id = ?" : ""} ORDER BY status = 'active' DESC, name`, ...(query.get("project") ? [v.id(query.get("project"))] : [])).map(p => playRow(p.id)));
  r.post("/api/plays", ({ body }) => {
    const now = Date.now();
    return playRow(insert("plays", { ...readPlay(body), created_at: now, updated_at: now }));
  });
  r.put("/api/plays/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const existing = q.get("SELECT * FROM plays WHERE id = ?", id) || fail(404, "Play nicht gefunden");
    update("plays", id, { ...readPlay(body, existing), updated_at: Date.now() });
    return playRow(id);
  });
  r.delete("/api/plays/:id", ({ params }) => {
    q.run("DELETE FROM plays WHERE id = ?", v.id(params.id));
    return { ok: true };
  });
}
