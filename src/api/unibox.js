// API: Unibox – alle Antworten aus allen Postfächern, Labels, Antworten direkt aus der App, KI-Entwurf.
import { q, likeAny } from "../db.js";
import { fail, v } from "../http.js";
import { sendManualReply } from "../engine/sender.js";
import { describeSmtpError } from "../mail/transport.js";
import { draftReply, classifyConversation, aiAvailable, LABELS, onLabel } from "../ai/features.js";
import { stripQuoted } from "../lib/text.js";
import { closeTasks, armNurture, markMeetingBooked } from "../engine/followup.js";

export function register(r) {
  r.get("/api/conversations", ({ query }) => {
    const filter = query.get("filter") || "all";
    // „Gesendet“: alles, was rausging – auch ohne Antwort. Sonst nur Gespräche mit eingegangener Mail.
    const where = [filter === "sent" ? "EXISTS (SELECT 1 FROM messages mo WHERE mo.conversation_id = c.id AND mo.direction = 'out')" : "c.has_inbound = 1"], args = [];
    if (filter === "unread") where.push("c.unread > 0");
    else if (filter === "direct") where.push("c.campaign_id IS NULL");
    else if (filter === "done") where.push("c.status = 'done'");
    else if (filter === "open") where.push("c.status = 'open'");
    else if (filter === "positive") where.push("c.label IN ('interested','meeting')");
    else if (LABELS[filter]) { where.push("c.label = ?"); args.push(filter); }
    if (!["done", "all", "sent"].includes(filter)) where.push("c.status != 'done' OR c.unread > 0");
    const mailbox = Number(query.get("mailbox") || 0);
    if (mailbox) { where.push("c.mailbox_id = ?"); args.push(mailbox); }
    const campaign = Number(query.get("campaign") || 0);
    if (campaign) { where.push("c.campaign_id = ?"); args.push(campaign); }
    const search = String(query.get("q") || "").trim();
    if (search) { const like = likeAny(search); where.push("(l.email LIKE ? ESCAPE '\\' OR l.company LIKE ? ESCAPE '\\' OR l.last_name LIKE ? ESCAPE '\\' OR c.subject LIKE ? ESCAPE '\\' OR c.snippet LIKE ? ESCAPE '\\')"); args.push(like, like, like, like, like); }
    const limit = v.int(query.get("limit"), { min: 1, max: 200, fallback: 50 });
    const page = v.int(query.get("page"), { min: 1, fallback: 1 });
    const sql = where.map(w => `(${w})`).join(" AND ");
    const total = q.value(`SELECT COUNT(*) FROM conversations c JOIN leads l ON l.id = c.lead_id WHERE ${sql}`, ...args);
    const items = q.all(`SELECT c.*, l.email AS lead_email, l.first_name, l.last_name, l.company, m.email AS mailbox_email, cp.name AS campaign_name
      FROM conversations c JOIN leads l ON l.id = c.lead_id LEFT JOIN mailboxes m ON m.id = c.mailbox_id LEFT JOIN campaigns cp ON cp.id = c.campaign_id
      WHERE ${sql} ORDER BY ${filter === "sent" ? "c.last_at" : "COALESCE(c.last_inbound_at, c.last_at)"} DESC LIMIT ? OFFSET ?`, ...args, limit, (page - 1) * limit);
    const counts = q.get(`SELECT TOTAL(CASE WHEN unread > 0 THEN 1 ELSE 0 END) AS unread, TOTAL(CASE WHEN label IN ('interested','meeting') AND status != 'done' THEN 1 ELSE 0 END) AS positive,
      COUNT(*) AS total FROM conversations WHERE has_inbound = 1`);
    return { items, total, page, limit, counts, labels: LABELS };
  });

  r.get("/api/conversations/:id", ({ params }) => {
    const id = v.id(params.id);
    const conv = q.get(`SELECT c.*, cp.name AS campaign_name, m.email AS mailbox_email, m.from_name AS mailbox_name FROM conversations c
      LEFT JOIN campaigns cp ON cp.id = c.campaign_id LEFT JOIN mailboxes m ON m.id = c.mailbox_id WHERE c.id = ?`, id) || fail(404, "Gespräch nicht gefunden");
    const lead = q.get("SELECT * FROM leads WHERE id = ?", conv.lead_id);
    const messages = q.all("SELECT id, direction, kind, from_addr, to_addr, subject, text, status, error, opens, clicks, step, variant, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, id", id)
      .map(m => ({ ...m, text_clean: m.direction === "in" ? stripQuoted(m.text) : m.text }));
    if (conv.unread) q.run("UPDATE conversations SET unread = 0 WHERE id = ?", id);
    const tasks = q.all("SELECT id, type, title, due_at, status, outcome FROM tasks WHERE lead_id = ? AND status = 'open' ORDER BY due_at", conv.lead_id);
    return { conversation: { ...conv, unread: 0 }, lead, messages, tasks, ai_available: aiAvailable() };
  });

  r.patch("/api/conversations/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const conv = q.get("SELECT * FROM conversations WHERE id = ?", id) || fail(404, "Gespräch nicht gefunden");
    if (body.label !== undefined) {
      const label = body.label === null || body.label === "" ? null : v.oneOf(body.label, Object.keys(LABELS), null);
      q.run("UPDATE conversations SET label = ?, label_by = 'user' WHERE id = ?", label, id);
      if (label) onLabel({ ...conv, label_by: "user" }, label);
    }
    if (body.status !== undefined) q.run("UPDATE conversations SET status = ? WHERE id = ?", v.oneOf(body.status, ["open", "done"], "open"), id);
    if (body.unread !== undefined) q.run("UPDATE conversations SET unread = ? WHERE id = ?", body.unread ? 1 : 0, id);
    return q.get("SELECT * FROM conversations WHERE id = ?", id);
  });

  r.post("/api/conversations/:id/reply", async ({ params, body }) => {
    const id = v.id(params.id);
    const conv = q.get("SELECT * FROM conversations WHERE id = ?", id) || fail(404, "Gespräch nicht gefunden");
    const text = v.text(body.text, { max: 20000, name: "Antwort" });
    if (!text.trim()) fail(400, "Antwort ist leer");
    const mailboxId = body.mailbox_id ? v.id(body.mailbox_id) : conv.mailbox_id;
    const mailbox = mailboxId ? q.get("SELECT * FROM mailboxes WHERE id = ?", mailboxId) : null;
    if (!mailbox) fail(400, "Kein Postfach für die Antwort vorhanden");
    const lead = q.get("SELECT * FROM leads WHERE id = ?", conv.lead_id);
    try {
      await sendManualReply({ conversation: conv, mailbox, lead, text, subject: body.subject });
    } catch (err) {
      fail(502, describeSmtpError(err));
    }
    if (body.mark_done) q.run("UPDATE conversations SET status = 'done' WHERE id = ?", id);
    // Geantwortet: offene „Antworten“-Aufgaben erledigt; Nachfassen startet ab jetzt neu.
    closeTasks({ conversationId: id, types: ["reply", "nurture_draft"], outcome: "sent" });
    armNurture(id);
    return { ok: true };
  });

  r.post("/api/conversations/:id/meeting", ({ params, body }) => {
    const id = v.id(params.id);
    const conv = q.get("SELECT * FROM conversations WHERE id = ?", id) || fail(404, "Gespräch nicht gefunden");
    markMeetingBooked(conv.lead_id, { at: body.at ? v.int(body.at, { min: 0 }) : null, source: "manual", conversationId: id });
    return q.get("SELECT * FROM conversations WHERE id = ?", id);
  });

  r.post("/api/conversations/:id/nurture", ({ params, body }) => {
    const id = v.id(params.id);
    q.get("SELECT 1 FROM conversations WHERE id = ?", id) || fail(404, "Gespräch nicht gefunden");
    if (body.stop) q.run("UPDATE conversations SET nurture_stopped = 'user', nurture_next_at = NULL WHERE id = ?", id);
    else { q.run("UPDATE conversations SET nurture_stopped = NULL WHERE id = ?", id); armNurture(id); }
    return q.get("SELECT * FROM conversations WHERE id = ?", id);
  });

  r.post("/api/conversations/:id/draft", async ({ params, body }) => {
    if (!aiAvailable()) fail(400, "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN fehlt).");
    return draftReply(v.id(params.id), { instructions: v.text(body.instructions ?? "", { max: 2000 }), nurture: !!body.nurture });
  });

  r.post("/api/conversations/:id/classify", async ({ params }) => {
    if (!aiAvailable()) fail(400, "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN fehlt).");
    const id = v.id(params.id);
    const conv = q.get("SELECT * FROM conversations WHERE id = ?", id) || fail(404, "Gespräch nicht gefunden");
    if (conv.label_by === "user") q.run("UPDATE conversations SET label_by = NULL WHERE id = ?", id);
    return classifyConversation(id);
  });
}
