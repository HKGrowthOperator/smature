// Gespräche (Unibox) und Nachrichten-Datensätze.
import { q, insert } from "../db.js";
import { snippet } from "../lib/text.js";

export function findConversation({ mailbox_id, lead_id, campaign_lead_id = null }) {
  if (campaign_lead_id) {
    const c = q.get("SELECT * FROM conversations WHERE campaign_lead_id = ?", campaign_lead_id);
    if (c) return c;
  }
  return q.get("SELECT * FROM conversations WHERE lead_id = ? AND (mailbox_id = ? OR ? IS NULL) ORDER BY last_at DESC LIMIT 1", lead_id, mailbox_id, mailbox_id);
}

export function ensureConversation({ mailbox_id, lead_id, campaign_id = null, campaign_lead_id = null, subject = "", now = Date.now() }) {
  if (campaign_lead_id) {
    const existing = q.get("SELECT * FROM conversations WHERE campaign_lead_id = ?", campaign_lead_id);
    if (existing) return existing;
  }
  const id = insert("conversations", { mailbox_id, lead_id, campaign_id, campaign_lead_id, subject, snippet: "", last_at: now, created_at: now });
  return q.get("SELECT * FROM conversations WHERE id = ?", id);
}

export function addMessage(row) {
  const now = row.created_at || Date.now();
  const id = insert("messages", { ...row, created_at: now });
  if (row.conversation_id) {
    if (row.direction === "in") {
      q.run(`UPDATE conversations SET last_at = ?, last_inbound_at = ?, has_inbound = 1, unread = unread + 1, snippet = ?, status = 'open',
             mailbox_id = COALESCE(mailbox_id, ?) WHERE id = ?`, now, now, snippet(row.text), row.mailbox_id, row.conversation_id);
    } else {
      q.run("UPDATE conversations SET last_at = ?, snippet = CASE WHEN has_inbound = 1 THEN snippet ELSE ? END, subject = CASE WHEN subject = '' THEN ? ELSE subject END WHERE id = ?",
        now, snippet(row.text), row.subject || "", row.conversation_id);
    }
  }
  return id;
}

export function isBlocked(email) {
  const e = String(email || "").toLowerCase();
  const domain = e.split("@")[1] || "";
  return !!q.get("SELECT 1 FROM blocklist WHERE value = ? OR value = ?", e, domain);
}
