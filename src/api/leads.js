// API: Leads, Listen, CSV-Import/-Export, E-Mail-Prüfung, Blockliste, DSGVO-Löschung.
import { q, tx, insert, update, parseJson, likeAny } from "../db.js";
import { fail, v } from "../http.js";
import { parseCsv, guessMapping, toCsv, LEAD_FIELDS } from "../lib/csv.js";
import { normalizeEmail, syntaxValid, verifyEmail } from "../lib/verify.js";
import { CONSENT_STATUSES } from "../engine/rules.js";
import { ensureAccountForLead, backfillAccounts } from "../intel/accounts.js";
import { projectId } from "../intel/projects.js";
import { applyNoteTags, noteTags } from "../engine/noteTags.js";
import { imprintContacts } from "../intel/imprint.js";
import { leadCase } from "../lib/cases.js";
import { assignLead, assignTargetsIds, poolTargets } from "../intel/assign.js";
import { startJob } from "../engine/jobs.js";
import { aiAvailable } from "../ai/claude.js";

const EDITABLE = ["salutation", "first_name", "last_name", "company", "position", "website", "phone", "city", "country", "industry", "linkedin", "source", "notes"];
const STATUSES = ["active", "unsubscribed", "bounced", "blocked"];

function readLead(body, existing = {}) {
  const row = {};
  for (const f of EDITABLE) if (body[f] !== undefined) row[f] = v.str(body[f], { max: f === "notes" ? 5000 : 500, name: f });
  if (body.custom !== undefined) {
    const custom = typeof body.custom === "string" ? parseJson(body.custom, null) : body.custom;
    if (!custom || typeof custom !== "object" || Array.isArray(custom)) fail(400, "Eigene Felder müssen ein Objekt sein");
    const clean = {};
    for (const [k, val] of Object.entries(custom)) {
      const key = String(k).trim().slice(0, 60);
      if (key) clean[key] = String(val ?? "").slice(0, 2000);
    }
    row.custom = JSON.stringify(clean);
  }
  if (body.status !== undefined) row.status = v.oneOf(body.status, STATUSES, existing.status || "active");
  if (body.reason !== undefined) row.reason = v.str(body.reason, { max: 500, name: "Anlass" });
  if (body.consent_source !== undefined) row.consent_source = v.str(body.consent_source, { max: 300, name: "Quelle der Einwilligung" });
  if (body.consent_status !== undefined) {
    row.consent_status = v.oneOf(body.consent_status, Object.keys(CONSENT_STATUSES), existing.consent_status || "none");
    if (row.consent_status !== existing.consent_status) row.consent_at = ["granted", "customer", "revoked"].includes(row.consent_status) ? Date.now() : null;
    if (row.consent_status !== existing.consent_status && ["granted", "customer"].includes(row.consent_status) && !String(row.consent_source ?? existing.consent_source ?? "").trim()) fail(400, "Bitte die Quelle der Einwilligung angeben (z. B. „Anfrage über Website am 03.10.2026“) – sie muss nachweisbar sein.");
  }
  if (body.hold_until !== undefined) row.hold_until = body.hold_until ? v.int(body.hold_until, { min: 0 }) : null;
  return row;
}

function consentPatch(body) {
  if (!body.consent_status) return null;
  const status = v.oneOf(body.consent_status, Object.keys(CONSENT_STATUSES), null);
  const source = v.str(body.consent_source, { max: 300, name: "Quelle der Einwilligung" });
  if (["granted", "customer"].includes(status) && !source) fail(400, "Bitte die Quelle der Einwilligung angeben – sie muss nachweisbar sein.");
  return { consent_status: status, consent_source: source, consent_at: status === "none" ? null : Date.now() };
}

function publicLead(l) {
  return l ? { ...l, custom: parseJson(l.custom, {}), fall: leadCase(l) } : null;
}

function leadFilter(query) {
  const where = [], args = [];
  const search = String(query.get("q") || "").trim();
  if (search) {
    where.push("(l.email LIKE ? ESCAPE '\\' OR l.first_name LIKE ? ESCAPE '\\' OR l.last_name LIKE ? ESCAPE '\\' OR l.company LIKE ? ESCAPE '\\')");
    const like = likeAny(search);
    args.push(like, like, like, like);
  }
  const project = query.get("project");
  if (project === "none") where.push("(l.account_id IS NULL OR l.account_id IN (SELECT id FROM accounts WHERE project_id IS NULL))");
  else if (Number(project)) { where.push("l.account_id IN (SELECT id FROM accounts WHERE project_id = ?)"); args.push(Number(project)); }
  const list = Number(query.get("list") || 0);
  if (list) { where.push("l.id IN (SELECT lead_id FROM lead_list_members WHERE list_id = ?)"); args.push(list); }
  const status = query.get("status");
  // „Warm“: Interesse gezeigt, Termin/Chance oder Link geklickt – für die Übergabe per CSV an die Sales App (dort wird telefoniert).
  if (status === "warm") where.push(`l.status != 'unsubscribed' AND l.consent_status != 'revoked' AND (l.id IN (SELECT lead_id FROM conversations WHERE label = 'interested' AND lead_id IS NOT NULL)
    OR l.id IN (SELECT lead_id FROM opportunities WHERE lead_id IS NOT NULL) OR l.id IN (SELECT lead_id FROM events WHERE type = 'click' AND lead_id IS NOT NULL))`);
  else if (status && STATUSES.includes(status)) { where.push("l.status = ?"); args.push(status); }
  const verify = query.get("verify");
  if (verify && ["valid", "risky", "invalid", "unknown"].includes(verify)) { where.push("l.verify_status = ?"); args.push(verify); }
  const consent = query.get("consent");
  if (consent && CONSENT_STATUSES[consent]) { where.push("l.consent_status = ?"); args.push(consent); }
  const product = Number(query.get("product") || 0);
  const fit = query.get("fit");
  if (product && fit === "unchecked") { where.push("l.id NOT IN (SELECT lead_id FROM lead_fit WHERE product_id = ?)"); args.push(product); }
  else if (product && /^[ABCD]+$/.test(fit || "")) { where.push("l.id IN (SELECT lead_id FROM lead_fit WHERE product_id = ? AND fit IN (SELECT value FROM json_each(?)))"); args.push(product, JSON.stringify([...fit])); }
  const campaign = Number(query.get("campaign") || 0);
  if (campaign) { where.push("l.id IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = ?)"); args.push(campaign); }
  if (query.get("not_in_campaign")) { where.push("l.id NOT IN (SELECT lead_id FROM campaign_leads WHERE campaign_id = ?)"); args.push(Number(query.get("not_in_campaign"))); }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

// Prüfung mit begrenzter Parallelität (DNS-Abfragen werden je Domain zwischengespeichert).
export async function verifyLeads(ids, { concurrency = 8 } = {}) {
  const counts = { valid: 0, risky: 0, invalid: 0, unknown: 0 };
  let index = 0;
  async function worker() {
    while (index < ids.length) {
      const id = ids[index++];
      const lead = q.get("SELECT id, email FROM leads WHERE id = ?", id);
      if (!lead) continue;
      const res = await verifyEmail(lead.email).catch(() => ({ status: "unknown", reason: "Prüfung fehlgeschlagen" }));
      counts[res.status] = (counts[res.status] || 0) + 1;
      q.run("UPDATE leads SET verify_status = ?, verify_reason = ?, updated_at = ? WHERE id = ?", res.status, res.reason || "", Date.now(), id);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return counts;
}

export function importLeads({ rows, mapping, listId, updateExisting = false, source = "", consent = null }) {
  const now = Date.now();
  const result = { imported: 0, updated: 0, skipped: 0, invalid: 0, duplicates_in_file: 0, added_to_list: 0, errors: [] };
  const touched = [];
  const seen = new Set();
  const emailCol = Object.entries(mapping).find(([, f]) => f === "email")?.[0];
  if (emailCol === undefined) fail(400, "Keine Spalte als E-Mail zugeordnet");
  tx(() => {
    rows.forEach((r, i) => {
      const email = normalizeEmail(r[emailCol]);
      if (!email) { result.skipped++; return; }
      if (!syntaxValid(email)) { result.invalid++; if (result.errors.length < 20) result.errors.push(`Zeile ${i + 2}: ungültige E-Mail „${String(r[emailCol]).slice(0, 80)}“`); return; }
      if (seen.has(email)) { result.duplicates_in_file++; return; }
      seen.add(email);
      const row = {}, custom = {};
      for (const [col, field] of Object.entries(mapping)) {
        const value = String(r[col] ?? "").trim();
        if (!field || field === "ignore" || field === "email" || !value) continue;
        if (field.startsWith("custom:")) custom[field.slice(7).slice(0, 60)] = value.slice(0, 2000);
        else if (LEAD_FIELDS.includes(field)) row[field] = value.slice(0, field === "notes" ? 5000 : 500);
      }
      if (source && !row.source) row.source = source.slice(0, 200);
      if (consent) Object.assign(row, consent);
      const existing = q.get("SELECT * FROM leads WHERE email = ?", email);
      let leadId;
      if (existing) {
        leadId = existing.id;
        if (updateExisting) {
          const mergedCustom = { ...parseJson(existing.custom, {}), ...custom };
          update("leads", existing.id, { ...row, custom: JSON.stringify(mergedCustom), updated_at: now });
          result.updated++;
        } else result.skipped++;
      } else {
        leadId = insert("leads", { email, ...row, custom: JSON.stringify(custom), created_at: now, updated_at: now });
        result.imported++;
      }
      touched.push(leadId);
      if (listId) {
        const added = q.run("INSERT OR IGNORE INTO lead_list_members (list_id, lead_id, added_at) VALUES (?, ?, ?)", listId, leadId, now);
        result.added_to_list += Number(added.changes);
      }
    });
  });
  // Firmen zuordnen (nach dem Import, außerhalb der Import-Transaktion) – genau die importierten/aktualisierten Leads.
  result.accounts_linked = backfillAccounts(0, { ids: touched });
  // Liste mit Projekt: Firmen ohne Projekt gehören ab jetzt zu diesem Projekt (saubere Trennung der Geschäftsbereiche).
  const listProject = listId ? q.value("SELECT project_id FROM lead_lists WHERE id = ?", listId) : null;
  if (listProject && touched.length) {
    result.accounts_assigned = Number(q.run(`UPDATE accounts SET project_id = ?, updated_at = ? WHERE project_id IS NULL
      AND id IN (SELECT account_id FROM leads WHERE id IN (SELECT value FROM json_each(?)))`, listProject, now, JSON.stringify(touched)).changes);
  }
  return result;
}

export function deleteLeadCompletely(id) {
  // DSGVO Art. 17: Lead inkl. Nachrichten, Gesprächen und Ereignissen löschen. Abgemeldete Adressen bleiben auf der Blockliste,
  // damit sie nie wieder angeschrieben werden (berechtigtes Interesse, nur die Adresse).
  tx(() => {
    // Auch die Kopien im Firmenprofil (Person, Notizen zu diesem Kontakt) löschen.
    q.run("DELETE FROM account_memory WHERE lead_id = ?", id);
    q.run("DELETE FROM account_people WHERE lead_id = ?", id);
    q.run("DELETE FROM events WHERE lead_id = ?", id);
    q.run("DELETE FROM messages WHERE lead_id = ?", id);
    q.run("DELETE FROM conversations WHERE lead_id = ?", id);
    q.run("DELETE FROM leads WHERE id = ?", id);
  });
}

export function register(r) {
  r.get("/api/leads", ({ query }) => {
    const { sql, args } = leadFilter(query);
    const limit = v.int(query.get("limit"), { min: 1, max: 500, fallback: 50 });
    const page = v.int(query.get("page"), { min: 1, max: 100000, fallback: 1 });
    const total = q.value(`SELECT COUNT(*) FROM leads l ${sql}`, ...args);
    const productId = Number(query.get("product") || 0) || null;
    const items = q.all(`SELECT l.*, (SELECT GROUP_CONCAT(list_id) FROM lead_list_members WHERE lead_id = l.id) AS list_ids,
      (SELECT COUNT(*) FROM campaign_leads WHERE lead_id = l.id) AS campaign_count,
      (SELECT fit FROM lead_fit WHERE lead_id = l.id AND product_id = ?) AS fit, (SELECT reason FROM lead_fit WHERE lead_id = l.id AND product_id = ?) AS fit_reason
      FROM leads l ${sql} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`, productId, productId, ...args, limit, (page - 1) * limit)
      .map(l => ({ ...publicLead(l), list_ids: String(l.list_ids || "").split(",").filter(Boolean).map(Number) }));
    return { items, total, page, limit };
  });

  r.post("/api/leads", ({ body }) => {
    const email = v.email(body.email);
    if (q.get("SELECT 1 FROM leads WHERE email = ?", email)) fail(409, "Lead mit dieser E-Mail existiert bereits");
    const now = Date.now();
    const id = insert("leads", { email, ...readLead(body), created_at: now, updated_at: now });
    if (body.list_id) q.run("INSERT OR IGNORE INTO lead_list_members (list_id, lead_id, added_at) VALUES (?, ?, ?)", v.id(body.list_id), id, now);
    ensureAccountForLead(id);
    return publicLead(q.get("SELECT * FROM leads WHERE id = ?", id));
  });

  r.get("/api/leads/export", ({ query, raw }) => {
    const { sql, args } = leadFilter(query);
    const leads = q.all(`SELECT l.* FROM leads l ${sql} ORDER BY l.id`, ...args);
    const customKeys = [...new Set(leads.flatMap(l => Object.keys(parseJson(l.custom, {}))))];
    const headers = ["email", ...EDITABLE, "status", "verify_status", "consent_status", "consent_source", "reason", ...customKeys];
    const rows = leads.map(l => {
      const custom = parseJson(l.custom, {});
      return [l.email, ...EDITABLE.map(f => l[f]), l.status, l.verify_status, l.consent_status, l.consent_source, l.reason, ...customKeys.map(k => custom[k] ?? "")];
    });
    raw({ type: "text/csv; charset=utf-8", body: toCsv(headers, rows), headers: { "Content-Disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"` } });
  });

  r.post("/api/leads/import/preview", ({ body }) => {
    const csv = v.text(body.csv, { max: 30 * 1024 * 1024, name: "CSV" });
    const parsed = parseCsv(csv, body.delimiter || undefined);
    if (!parsed.headers.length) fail(400, "Die Datei enthält keine Daten");
    return { delimiter: parsed.delimiter, headers: parsed.headers, total: parsed.rows.length, sample: parsed.rows.slice(0, 5), mapping: guessMapping(parsed.headers), fields: LEAD_FIELDS };
  });

  r.post("/api/leads/import", async ({ body }) => {
    const csv = v.text(body.csv, { max: 30 * 1024 * 1024, name: "CSV" });
    const parsed = parseCsv(csv, body.delimiter || undefined);
    const mapping = body.mapping && typeof body.mapping === "object" ? body.mapping : guessMapping(parsed.headers);
    let listId = body.list_id ? v.id(body.list_id) : null;
    if (!listId && body.new_list_name) {
      listId = insert("lead_lists", { name: v.str(body.new_list_name, { max: 120, required: true, name: "Listenname" }), target_group_id: body.target_group_id ? v.id(body.target_group_id) : null, project_id: projectId(body.project_id), created_at: Date.now() });
    }
    if (listId && !q.get("SELECT 1 FROM lead_lists WHERE id = ?", listId)) fail(404, "Liste nicht gefunden");
    const result = importLeads({ rows: parsed.rows, mapping, listId, updateExisting: !!body.update_existing, source: v.str(body.source, { max: 200 }), consent: consentPatch(body) });
    if (body.verify && listId) {
      const ids = q.all("SELECT lead_id FROM lead_list_members WHERE list_id = ?", listId).map(r => r.lead_id);
      result.verification = await verifyLeads(ids);
    }
    return { ...result, list_id: listId };
  });

  // Geschäftsführer aus dem Impressum (Name, Anrede, nur veröffentlichte persönliche Adresse). Bis 40 Leads je Aufruf.
  r.post("/api/leads/imprint-contacts", async ({ body }) => {
    let ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
    if (!ids.length && body.list_id) ids = q.all("SELECT lead_id FROM lead_list_members WHERE list_id = ? ORDER BY lead_id", v.id(body.list_id)).map(r => r.lead_id);
    if (!ids.length) fail(400, "Keine Leads ausgewählt");
    const force = !!body.force;
    // Bei einer ganzen Liste immer die nächsten noch ungeprüften Leads nehmen.
    const todo = force ? ids : ids.filter(id => !(parseJson(q.value("SELECT custom FROM leads WHERE id = ?", id), {}) || {}).impressum_geprueft);
    const batch = todo.slice(0, 40);
    const result = await imprintContacts(batch, { force });
    return { ...result, remaining: todo.length - batch.length };
  });

  r.post("/api/leads/verify", async ({ body }) => {
    let ids = [];
    if (Array.isArray(body.ids)) ids = body.ids.map(Number).filter(Number.isInteger);
    else if (body.list_id) ids = q.all("SELECT lead_id AS id FROM lead_list_members WHERE list_id = ?", v.id(body.list_id)).map(r => r.id);
    else ids = q.all("SELECT id FROM leads WHERE verify_status = 'unknown'").map(r => r.id);
    if (ids.length > 20000) fail(400, "Maximal 20.000 Leads pro Prüfung");
    return { checked: ids.length, ...(await verifyLeads(ids)) };
  });

  r.post("/api/leads/bulk", ({ body }) => {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger).slice(0, 50000);
    if (!ids.length) fail(400, "Keine Leads ausgewählt");
    const action = v.oneOf(body.action, ["delete", "add_to_list", "remove_from_list", "block", "set_status", "set_consent", "clear_hold", "set_project"], null);
    const targetProject = action === "set_project" ? projectId(body.project_id) : null;
    const consent = action === "set_consent" ? (consentPatch(body) || fail(400, "Einwilligungs-Status fehlt")) : null;
    let affected = 0;
    tx(() => {
      for (const id of ids) {
        if (action === "delete") { deleteLeadCompletely(id); affected++; }
        else if (action === "add_to_list") affected += Number(q.run("INSERT OR IGNORE INTO lead_list_members (list_id, lead_id, added_at) VALUES (?, ?, ?)", v.id(body.list_id), id, Date.now()).changes);
        else if (action === "remove_from_list") affected += Number(q.run("DELETE FROM lead_list_members WHERE list_id = ? AND lead_id = ?", v.id(body.list_id), id).changes);
        else if (action === "block") {
          const lead = q.get("SELECT email FROM leads WHERE id = ?", id);
          if (!lead) continue;
          q.run("INSERT INTO blocklist (value, kind, reason, created_at) VALUES (?, 'email', 'Manuell gesperrt', ?) ON CONFLICT(value) DO NOTHING", lead.email, Date.now());
          q.run("UPDATE leads SET status = 'blocked', updated_at = ? WHERE id = ?", Date.now(), id);
          q.run("UPDATE campaign_leads SET status = 'blocked', next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", id);
          affected++;
        } else if (action === "set_consent") {
          affected += Number(q.run("UPDATE leads SET consent_status = ?, consent_source = ?, consent_at = ?, updated_at = ? WHERE id = ?", consent.consent_status, consent.consent_source, consent.consent_at, Date.now(), id).changes);
        } else if (action === "clear_hold") {
          affected += Number(q.run("UPDATE leads SET hold_until = NULL, updated_at = ? WHERE id = ?", Date.now(), id).changes);
        } else if (action === "set_project") {
          // Die Firma gehört dann genau zu diesem Projekt – Kampagnen anderer Projekte nehmen sie nicht auf.
          const accountId = q.value("SELECT account_id FROM leads WHERE id = ?", id);
          if (accountId) affected += Number(q.run("UPDATE accounts SET project_id = ?, updated_at = ? WHERE id = ?", targetProject, Date.now(), accountId).changes);
        } else if (action === "set_status") {
          affected += Number(q.run("UPDATE leads SET status = ?, updated_at = ? WHERE id = ?", v.oneOf(body.status, STATUSES, "active"), Date.now(), id).changes);
        }
      }
    });
    return { affected };
  });

  r.get("/api/leads/:id", ({ params }) => {
    const id = v.id(params.id);
    const lead = q.get("SELECT * FROM leads WHERE id = ?", id) || fail(404, "Lead nicht gefunden");
    const campaigns = q.all("SELECT cl.*, c.name AS campaign_name FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id WHERE cl.lead_id = ? ORDER BY cl.created_at DESC", id)
      .map(cl => ({ id: cl.id, campaign_id: cl.campaign_id, campaign_name: cl.campaign_name, status: cl.status, step: cl.step, next_at: cl.next_at, last_error: cl.last_error, interest: cl.interest, replied_at: cl.replied_at }));
    const messages = q.all("SELECT id, conversation_id, direction, kind, subject, status, opens, clicks, created_at, step, campaign_id FROM messages WHERE lead_id = ? ORDER BY created_at DESC LIMIT 100", id);
    const lists = q.all("SELECT ll.id, ll.name FROM lead_lists ll JOIN lead_list_members m ON m.list_id = ll.id WHERE m.lead_id = ?", id);
    const fits = q.all("SELECT f.product_id, p.name AS product_name, f.fit, f.reason, f.checked_at FROM lead_fit f JOIN products p ON p.id = f.product_id WHERE f.lead_id = ? ORDER BY p.name", id);
    const tasks = q.all("SELECT id, type, title, due_at, status, outcome, notes FROM tasks WHERE lead_id = ? ORDER BY status = 'open' DESC, due_at DESC LIMIT 50", id);
    return { lead: publicLead(lead), campaigns, messages, lists, fits, tasks };
  });

  // Alle recherchieren & zuordnen: KI prüft jeden Lead gegen die vier Projekte und legt ihn in den passenden Pool (Hintergrund-Auftrag).
  r.post("/api/leads/assign", ({ body }) => {
    if (!aiAvailable()) fail(400, "KI nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN für das Max-Abo).");
    const ids = assignTargetsIds({ ids: (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger), listId: body.list_id ? v.id(body.list_id) : null, pools: body.pools === true, force: body.force === true });
    if (!ids.length) fail(400, "Keine Leads ausgewählt (oder alle heute schon zugeordnet)");
    if (ids.length > 5000) fail(400, "Maximal 5000 Leads pro Auftrag");
    const targets = poolTargets();
    if (targets.length < 2) fail(400, "Mindestens zwei Projekte mit Produkt nötig");
    return startJob("assign", ids, leadId => assignLead(leadId, { targets }), { label: `Recherchieren & zuordnen (${ids.length} Leads)` });
  });

  r.put("/api/leads/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const existing = q.get("SELECT * FROM leads WHERE id = ?", id) || fail(404, "Lead nicht gefunden");
    const row = readLead(body, existing);
    if (body.email !== undefined) {
      const email = v.email(body.email);
      if (email !== existing.email && q.get("SELECT 1 FROM leads WHERE email = ? AND id != ?", email, id)) fail(409, "E-Mail wird bereits verwendet");
      row.email = email;
      if (email !== existing.email) { row.verify_status = "unknown"; row.verify_reason = ""; }
    }
    update("leads", id, { ...row, updated_at: Date.now() });
    const fresh = q.get("SELECT * FROM leads WHERE id = ?", id);
    ensureAccountForLead(fresh);
    let tags = [];
    if (body.notes !== undefined) {
      const before = noteTags(existing.notes), now = noteTags(fresh.notes);
      if ((now.nomail && !before.nomail) || (now.blacklist && !before.blacklist)) tags = applyNoteTags(fresh.notes, { leadId: id });
    }
    return { ...publicLead(q.get("SELECT * FROM leads WHERE id = ?", id)), note_tags: tags };
  });

  r.delete("/api/leads/:id", ({ params }) => {
    deleteLeadCompletely(v.id(params.id));
    return { ok: true };
  });

  // Listen
  r.get("/api/lists", () => q.all(`SELECT ll.*, tg.name AS target_group_name, pj.name AS project_name, (SELECT COUNT(*) FROM lead_list_members WHERE list_id = ll.id) AS lead_count
    FROM lead_lists ll LEFT JOIN target_groups tg ON tg.id = ll.target_group_id LEFT JOIN projects pj ON pj.id = ll.project_id ORDER BY ll.created_at DESC`));
  r.post("/api/lists", ({ body }) => {
    const id = insert("lead_lists", { name: v.str(body.name, { max: 120, required: true, name: "Name" }), target_group_id: body.target_group_id ? v.id(body.target_group_id) : null, project_id: projectId(body.project_id), created_at: Date.now() });
    return q.get("SELECT * FROM lead_lists WHERE id = ?", id);
  });
  r.put("/api/lists/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const existing = q.get("SELECT * FROM lead_lists WHERE id = ?", id) || fail(404, "Liste nicht gefunden");
    update("lead_lists", id, { name: v.str(body.name, { max: 120, required: true, name: "Name" }), target_group_id: body.target_group_id ? v.id(body.target_group_id) : null, project_id: body.project_id !== undefined ? projectId(body.project_id) : existing.project_id });
    return q.get("SELECT * FROM lead_lists WHERE id = ?", id);
  });
  r.delete("/api/lists/:id", ({ params, query }) => {
    const id = v.id(params.id);
    if (query.get("with_leads") === "1") {
      const ids = q.all("SELECT lead_id FROM lead_list_members WHERE list_id = ?", id).map(r => r.lead_id);
      for (const leadId of ids) deleteLeadCompletely(leadId);
    }
    q.run("DELETE FROM lead_lists WHERE id = ?", id);
    return { ok: true };
  });

  // Blockliste (E-Mail oder ganze Domain)
  r.get("/api/blocklist", () => q.all("SELECT * FROM blocklist ORDER BY created_at DESC LIMIT 5000"));
  r.post("/api/blocklist", ({ body }) => {
    const values = String(body.values || body.value || "").split(/[\s,;]+/).map(s => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean).slice(0, 10000);
    if (!values.length) fail(400, "Keine Einträge");
    let added = 0;
    tx(() => {
      for (const value of values) {
        const kind = value.includes("@") ? "email" : "domain";
        if (kind === "email" && !syntaxValid(value)) continue;
        if (kind === "domain" && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) continue;
        added += Number(q.run("INSERT INTO blocklist (value, kind, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(value) DO NOTHING", value, kind, v.str(body.reason, { max: 200 }) || "Manuell", Date.now()).changes);
        const match = kind === "email" ? "SELECT id FROM leads WHERE email = ?" : "SELECT id FROM leads WHERE email LIKE ?";
        for (const l of q.all(match, kind === "email" ? value : `%@${value}`)) {
          q.run("UPDATE campaign_leads SET status = 'blocked', next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", l.id);
        }
      }
    });
    return { added };
  });
  r.delete("/api/blocklist/:id", ({ params }) => {
    q.run("DELETE FROM blocklist WHERE id = ?", v.id(params.id));
    return { ok: true };
  });
}
