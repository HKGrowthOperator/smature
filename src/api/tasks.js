// API: Aufgaben / Anrufliste – anrufen, antworten, Nachfass-Entwürfe prüfen und senden, Ergebnis festhalten.
import { q, update } from "../db.js";
import { fail, v } from "../http.js";
import { DAY_MS } from "../lib/time.js";
import { getSettings } from "../settings.js";
import { token as newToken } from "../crypto.js";
import { sendManualReply } from "../engine/sender.js";
import { describeSmtpError } from "../mail/transport.js";
import { markUnsubscribed } from "../mail/inbound.js";
import { draftReply, aiAvailable } from "../ai/features.js";
import { TASK_TYPES, CALL_OUTCOMES, CALL_TYPES, createTask, closeTasks, markMeetingBooked, armNurture, stopNurture, renderNurture } from "../engine/followup.js";
import { advance, sideState } from "../intel/lifecycle.js";
import { ensureOpportunityForMeeting } from "../conversion/opportunities.js";
import { applyNoteTags, noteTags } from "../engine/noteTags.js";

const STATUSES = ["open", "done", "dismissed"];

function taskRow(id) {
  const t = q.get(`SELECT t.*, l.email, l.salutation, l.first_name, l.last_name, l.company, l.position, l.phone, l.website, l.city, l.reason AS lead_reason,
    l.consent_status, l.meeting_at AS lead_meeting_at, c.label AS conversation_label, c.ai_summary, c.mailbox_id, cp.name AS campaign_name, p.name AS product_name,
    p.booking_url AS product_booking_url, p.kit_url AS product_kit_url, a.name AS account_name, a.domain AS account_domain, a.why_now AS account_why_now,
    a.website AS account_website, ap.name AS person_name, ap.role AS person_role, ap.phone AS person_phone
    FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN conversations c ON c.id = t.conversation_id
    LEFT JOIN campaigns cp ON cp.id = t.campaign_id LEFT JOIN products p ON p.id = t.product_id
    LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN account_people ap ON ap.id = t.person_id WHERE t.id = ?`, id);
  if (!t) return t;
  // Firmen-Aufgaben ohne Lead (z. B. „Neuer Anlass“): Telefon, Firma und Website aus dem Firmenprofil.
  return { ...t, phone: t.phone || t.person_phone || "", company: t.company || t.account_name || "", website: t.website || t.account_website || "", lead_reason: t.lead_reason || t.account_why_now || "" };
}

function nextWorkday(ts, days) {
  let d = new Date(ts + days * DAY_MS);
  while ([0, 6].includes(d.getDay())) d = new Date(d.getTime() + DAY_MS);
  return d.getTime();
}

export function register(r) {
  r.get("/api/tasks", ({ query }) => {
    const where = [], args = [];
    const status = query.get("status") || "open";
    if (STATUSES.includes(status)) { where.push("t.status = ?"); args.push(status); }
    const type = query.get("type");
    if (type === "calls") where.push("t.type IN ('call','call_sequence')");
    else if (type && TASK_TYPES[type]) { where.push("t.type = ?"); args.push(type); }
    const due = query.get("due");
    if (due === "due") { where.push("t.due_at <= ?"); args.push(Date.now()); }
    if (query.get("lead")) { where.push("t.lead_id = ?"); args.push(v.id(query.get("lead"))); }
    if (query.get("account")) { where.push("t.account_id = ?"); args.push(v.id(query.get("account"))); }
    if (query.get("conversation")) { where.push("t.conversation_id = ?"); args.push(v.id(query.get("conversation"))); }
    const limit = v.int(query.get("limit"), { min: 1, max: 500, fallback: 200 });
    const sql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const ids = q.all(`SELECT t.id FROM tasks t ${sql} ORDER BY CASE WHEN t.status = 'open' THEN t.due_at ELSE -COALESCE(t.done_at, 0) END LIMIT ?`, ...args, limit).map(x => x.id);
    const counts = q.get(`SELECT COUNT(*) AS open, TOTAL(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due, TOTAL(CASE WHEN type IN ('call','call_sequence') THEN 1 ELSE 0 END) AS calls
      FROM tasks WHERE status = 'open'`, Date.now());
    return { items: ids.map(taskRow), counts, types: TASK_TYPES, outcomes: CALL_OUTCOMES };
  });

  r.get("/api/tasks/counts", () => q.get("SELECT COUNT(*) AS open, TOTAL(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due FROM tasks WHERE status = 'open'", Date.now()));

  r.post("/api/tasks", ({ body, user }) => {
    const leadId = v.id(body.lead_id, "Lead");
    const lead = q.get("SELECT * FROM leads WHERE id = ?", leadId) || fail(404, "Lead nicht gefunden");
    const type = v.oneOf(body.type || "todo", Object.keys(TASK_TYPES), "todo");
    if (CALL_TYPES.includes(type)) fail(400, "Anrufe laufen in eurer Sales App – hier nur Cold Mailing. Leads mit „Export → Warm“ übergeben.");
    const id = createTask({
      type, lead_id: lead.id, title: v.str(body.title || `${TASK_TYPES[type]}: ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email}`, { max: 300 }),
      due_at: body.due_at ? v.int(body.due_at, { min: 0 }) : Date.now(), notes: v.text(body.notes ?? "", { max: 5000 }),
      product_id: body.product_id ? v.id(body.product_id) : null, user_id: user.id
    });
    return taskRow(id);
  });

  // Mehrere Leads auf die Anrufliste setzen (z. B. aus der Lead-Liste).
  r.post("/api/tasks/bulk", ({ body, user }) => {
    const ids = (Array.isArray(body.lead_ids) ? body.lead_ids : []).map(Number).filter(Number.isInteger).slice(0, 2000);
    if (!ids.length) fail(400, "Keine Leads ausgewählt");
    const type = v.oneOf(body.type || "todo", Object.keys(TASK_TYPES), "todo");
    if (CALL_TYPES.includes(type)) fail(400, "Anrufe laufen in eurer Sales App – hier nur Cold Mailing. Leads mit „Export → Warm“ übergeben.");
    const notes = v.text(body.notes ?? "", { max: 2000 });
    const productId = body.product_id ? v.id(body.product_id) : null;
    let created = 0, skipped = 0;
    for (const id of ids) {
      const lead = q.get("SELECT * FROM leads WHERE id = ?", id);
      if (!lead || lead.status === "unsubscribed" || lead.consent_status === "revoked" || (lead.hold_until && lead.hold_until > Date.now())) { skipped++; continue; }
      createTask({ type, lead_id: id, title: `${TASK_TYPES[type]}: ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email}${lead.company ? ` (${lead.company})` : ""}`, notes: notes || lead.reason || "", product_id: productId, user_id: user.id });
      created++;
    }
    return { created, skipped };
  });

  r.get("/api/tasks/:id", ({ params }) => taskRow(v.id(params.id)) || fail(404, "Aufgabe nicht gefunden"));

  r.put("/api/tasks/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const t = q.get("SELECT * FROM tasks WHERE id = ?", id) || fail(404, "Aufgabe nicht gefunden");
    const row = {};
    if (body.title !== undefined) row.title = v.str(body.title, { max: 300, required: true, name: "Titel" });
    if (body.notes !== undefined) row.notes = v.text(body.notes, { max: 5000 });
    if (body.draft !== undefined) row.draft = v.text(body.draft, { max: 20000 });
    if (body.due_at !== undefined) row.due_at = v.int(body.due_at, { min: 0 });
    if (body.status !== undefined) {
      row.status = v.oneOf(body.status, STATUSES, t.status);
      row.done_at = row.status === "open" ? null : Date.now();
    }
    update("tasks", id, row);
    // Schlagwörter nur auslösen, wenn sie neu in die Notiz gekommen sind.
    let tags = [];
    if (row.notes !== undefined) {
      const before = noteTags(t.notes), now = noteTags(row.notes);
      if ((now.nomail && !before.nomail) || (now.blacklist && !before.blacklist)) tags = applyNoteTags(row.notes, { leadId: t.lead_id, accountId: t.account_id, personId: t.person_id });
    }
    return { ...taskRow(id), note_tags: tags };
  });

  r.delete("/api/tasks/:id", ({ params }) => {
    q.run("DELETE FROM tasks WHERE id = ?", v.id(params.id));
    return { ok: true };
  });

  // Ergebnis eines Anrufs (oder einer Aufgabe) festhalten – steuert die nächsten Schritte automatisch.
  r.post("/api/tasks/:id/outcome", ({ params, body }) => {
    const id = v.id(params.id);
    const t = q.get("SELECT * FROM tasks WHERE id = ?", id) || fail(404, "Aufgabe nicht gefunden");
    const outcome = v.oneOf(body.outcome, Object.keys(CALL_OUTCOMES), null) || fail(400, "Ergebnis fehlt");
    const notes = v.text(body.notes ?? "", { max: 5000 });
    const now = Date.now();
    const noteLine = notes ? `${new Date(now).toLocaleString("de-DE", { timeZone: getSettings().timezone || "Europe/Berlin" })}: ${CALL_OUTCOMES[outcome]} – ${notes}` : "";
    const allNotes = [t.notes, noteLine].filter(Boolean).join("\n");
    const done = (status = "done") => q.run("UPDATE tasks SET status = ?, outcome = ?, notes = ?, attempts = attempts + 1, done_at = ? WHERE id = ?", status, outcome, allNotes, now, id);
    const lead = t.lead_id ? q.get("SELECT * FROM leads WHERE id = ?", t.lead_id) : null;
    switch (outcome) {
      case "meeting":
        done();
        if (lead) markMeetingBooked(lead.id, { at: body.meeting_at ? v.int(body.meeting_at, { min: 0 }) : null, source: "call" });
        break;
      case "interested":
        done();
        if (t.conversation_id) {
          q.run("UPDATE conversations SET label = 'interested', label_by = 'user' WHERE id = ?", t.conversation_id);
          armNurture(t.conversation_id);
        }
        if (lead) createTask({ type: "todo", title: `Infos senden: ${lead.first_name || lead.email}${lead.company ? ` (${lead.company})` : ""}`, lead_id: lead.id, conversation_id: t.conversation_id, campaign_id: t.campaign_id, product_id: t.product_id, notes });
        break;
      case "callback": {
        const at = v.int(body.callback_at, { min: now - DAY_MS, name: "Rückruf-Zeitpunkt" });
        q.run("UPDATE tasks SET due_at = ?, attempts = attempts + 1, notes = ?, outcome = 'callback' WHERE id = ?", at, allNotes, id);
        break;
      }
      case "no_answer": {
        const attempts = (t.attempts || 0) + 1;
        if (attempts >= 3) done();
        else q.run("UPDATE tasks SET due_at = ?, attempts = ?, notes = ?, outcome = 'no_answer' WHERE id = ?", nextWorkday(now, attempts === 1 ? 1 : 2), attempts, allNotes, id);
        break;
      }
      case "not_interested":
        done();
        if (lead) {
          q.run("UPDATE leads SET hold_until = ?, updated_at = ? WHERE id = ?", now + (Number(getSettings().not_interested_hold_days) || 365) * DAY_MS, now, lead.id);
          q.run("UPDATE campaign_leads SET status = 'stopped', last_error = 'Kein Interesse (Telefon)', next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", lead.id);
          for (const c of q.all("SELECT id FROM conversations WHERE lead_id = ?", lead.id)) {
            q.run("UPDATE conversations SET label = 'not_interested', label_by = 'user' WHERE id = ?", c.id);
            stopNurture(c.id, "not_interested");
          }
          closeTasks({ leadId: lead.id, outcome: "not_interested", status: "dismissed" });
        }
        break;
      case "wrong_number":
        done();
        if (lead && body.clear_phone) q.run("UPDATE leads SET phone = '', updated_at = ? WHERE id = ?", now, lead.id);
        break;
      case "do_not_contact":
        done();
        if (lead) {
          q.run("UPDATE leads SET consent_status = 'revoked', updated_at = ? WHERE id = ?", now, lead.id);
          markUnsubscribed(lead.id, { source: "phone" });
          for (const c of q.all("SELECT id FROM conversations WHERE lead_id = ?", lead.id)) stopNurture(c.id, "unsubscribe");
          closeTasks({ leadId: lead.id, outcome: "do_not_contact", status: "dismissed" });
        }
        break;
      default:
        done();
    }
    // Firmen-Ebene: Ergebnis auch im Account Brain festhalten (Anrufe bei Personen ohne E-Mail, z. B. aus dem Impressum).
    const accountId = t.account_id || lead?.account_id || null;
    if (accountId) {
      const who = t.person_id ? q.value("SELECT name FROM account_people WHERE id = ?", t.person_id) : "";
      if (outcome === "meeting" && !lead) {
        advance(accountId, "meeting", "Termin am Telefon vereinbart");
        ensureOpportunityForMeeting({ accountId, meetingAt: body.meeting_at ? v.int(body.meeting_at, { min: 0 }) : null, source: "call" });
      } else if (outcome === "interested") advance(accountId, "engaged", "Interesse am Telefon");
      else if (outcome === "not_interested") {
        sideState(accountId, "not_now", "Kein Interesse (Telefon)");
        q.run("UPDATE accounts SET next_check_at = ? WHERE id = ?", now + (Number(getSettings().not_interested_hold_days) || 365) * DAY_MS, accountId);
        q.run("INSERT INTO account_memory (account_id, kind, text, source, meta, lead_id, created_at) VALUES (?, 'objection', ?, 'call', ?, ?, ?)", accountId, `Kein Interesse${who ? ` (${who})` : ""}${notes ? `: ${notes}` : ""}`, JSON.stringify({ type: "no_interest" }), lead?.id || null, now);
      } else if (outcome === "do_not_contact") {
        if (t.person_id) q.run("UPDATE account_people SET do_not_contact = 1, updated_at = ? WHERE id = ?", now, t.person_id);
        q.run("INSERT INTO account_memory (account_id, kind, text, source, lead_id, created_at) VALUES (?, 'note', ?, 'call', ?, ?)", accountId, `${who || "Kontakt"} möchte nicht mehr kontaktiert werden`, lead?.id || null, now);
      }
      if (notes && !["not_interested", "do_not_contact"].includes(outcome)) {
        q.run("INSERT INTO account_memory (account_id, kind, text, source, lead_id, created_at) VALUES (?, 'note', ?, 'call', ?, ?)", accountId, `${CALL_OUTCOMES[outcome]}${who ? ` (${who})` : ""}: ${notes}`, lead?.id || null, now);
      }
    }
    // #nomail / #blacklist in der Gesprächsnotiz sperren sofort (ersetzt das Close-→-Instantly-Szenario).
    const tags = applyNoteTags(notes, { leadId: lead?.id || null, accountId, personId: t.person_id || null });
    return { ...taskRow(id), note_tags: tags };
  });

  // KI-Entwurf für Antwort/Nachfassen erzeugen.
  r.post("/api/tasks/:id/draft", async ({ params, body }) => {
    const id = v.id(params.id);
    const t = q.get("SELECT * FROM tasks WHERE id = ?", id) || fail(404, "Aufgabe nicht gefunden");
    if (!t.conversation_id) fail(400, "Diese Aufgabe gehört zu keinem Gespräch");
    if (!aiAvailable()) fail(400, "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN fehlt).");
    const d = await draftReply(t.conversation_id, { instructions: v.text(body.instructions ?? "", { max: 2000 }), nurture: t.type === "nurture_draft" });
    q.run("UPDATE tasks SET draft = ? WHERE id = ?", d.body, id);
    return taskRow(id);
  });

  // Entwurf prüfen und im Gespräch senden (mit Signatur, Abmelde-Hinweis und Impressum).
  r.post("/api/tasks/:id/send", async ({ params, body }) => {
    const id = v.id(params.id);
    const t = q.get("SELECT * FROM tasks WHERE id = ?", id) || fail(404, "Aufgabe nicht gefunden");
    if (!t.conversation_id) fail(400, "Diese Aufgabe gehört zu keinem Gespräch");
    const conv = q.get("SELECT * FROM conversations WHERE id = ?", t.conversation_id) || fail(404, "Gespräch nicht gefunden");
    const text = v.text(body.text ?? t.draft ?? "", { max: 20000, name: "Text" });
    if (!text.trim()) fail(400, "Text ist leer");
    const mailbox = conv.mailbox_id ? q.get("SELECT * FROM mailboxes WHERE id = ?", conv.mailbox_id) : null;
    if (!mailbox) fail(400, "Kein Postfach für dieses Gespräch");
    const lead = q.get("SELECT * FROM leads WHERE id = ?", conv.lead_id);
    if (lead.status !== "active" || lead.consent_status === "revoked") fail(400, "Dieser Kontakt darf nicht mehr angeschrieben werden.");
    const campaign = conv.campaign_id ? q.get("SELECT * FROM campaigns WHERE id = ?", conv.campaign_id) : null;
    // Variablen ({{termin_link}} …) wie bei Kampagnen-Mails auflösen; Fußzeile hängt sendManualReply nicht an – daher hier.
    const nurture = t.type === "nurture_draft";
    const tok = nurture ? newToken(18) : null;
    const rendered = nurture ? renderNurture({ body: text, lead, mailbox: { ...mailbox, signature: "" }, campaign, token: tok }).text : text;
    try {
      await sendManualReply({ conversation: conv, mailbox, lead, text: rendered, kind: nurture ? "nurture" : "manual", token: tok });
    } catch (err) {
      fail(502, describeSmtpError(err));
    }
    q.run("UPDATE tasks SET status = 'done', outcome = 'sent', draft = ?, done_at = ? WHERE id = ?", text, Date.now(), id);
    if (t.type === "nurture_draft") q.run("UPDATE conversations SET nurture_count = nurture_count + 1 WHERE id = ?", conv.id);
    closeTasks({ conversationId: conv.id, types: ["reply"], outcome: "sent" });
    armNurture(conv.id);
    return taskRow(id);
  });
}
