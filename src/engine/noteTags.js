// Schlagwörter in Notizen – übernommen aus dem Close-Ablauf „Notiz #blacklist / #nomail“, aber ohne Make und ohne zweites
// Tool: Wer beim Telefonieren, im Firmenprofil oder am Lead eine Notiz schreibt, sperrt direkt in der App.
//   #nomail    → an diese Person keine Mails mehr (Sequenzen und Nachfassen stoppen, Adresse gesperrt). Anrufen bleibt möglich.
//   #blacklist → die ganze Firma nie wieder kontaktieren: alle Personen „nicht kontaktieren“, Domain gesperrt, Firma gesperrt.
import { q, tx } from "../db.js";
import { isFreemail } from "../lib/verify.js";
import { markUnsubscribed, setInboundHandler } from "../mail/inbound.js";
import { closeTasks, stopNurture } from "./followup.js";
import { sideState } from "../intel/lifecycle.js";

export const NOTE_TAGS = {
  nomail: "#nomail – keine Mails mehr an diese Person (Anrufen bleibt möglich)",
  blacklist: "#blacklist – ganze Firma nie wieder kontaktieren"
};

export function noteTags(text) {
  const t = String(text || "");
  return {
    nomail: /(^|[\s(,;])#(nomail|keinemail|keine-mail|keinemails)\b/i.test(t),
    blacklist: /(^|[\s(,;])#(blacklist|sperre|sperren)\b/i.test(t)
  };
}

const blocked = value => !!value && !!q.get("SELECT 1 FROM blocklist WHERE value = ?", value.toLowerCase());
const block = (value, kind, reason) => value && q.run("INSERT INTO blocklist (value, kind, reason, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(value) DO NOTHING", value.toLowerCase(), kind, reason, Date.now());
const memo = (accountId, text, leadId = null) => accountId && q.run("INSERT INTO account_memory (account_id, kind, text, source, lead_id, created_at) VALUES (?, 'note', ?, 'system', ?, ?)", accountId, text, leadId, Date.now());

function stopMails(leadId, reason) {
  q.run("UPDATE campaign_leads SET status = 'stopped', last_error = ?, next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", reason, leadId);
  for (const c of q.all("SELECT id FROM conversations WHERE lead_id = ?", leadId)) stopNurture(c.id, "nomail");
  closeTasks({ leadId, types: ["reply", "nurture_draft"], outcome: "nomail", status: "dismissed" });
}

// Wendet die Schlagwörter an. Gibt zurück, was ausgelöst wurde (für Hinweise in der Oberfläche).
export function applyNoteTags(text, { leadId = null, accountId = null, personId = null } = {}) {
  const tags = noteTags(text);
  const applied = [];
  if (!tags.nomail && !tags.blacklist) return applied;
  let lead = leadId ? q.get("SELECT * FROM leads WHERE id = ?", leadId) : null;
  if (!lead && personId) {
    const pid = q.value("SELECT lead_id FROM account_people WHERE id = ?", personId);
    lead = pid ? q.get("SELECT * FROM leads WHERE id = ?", pid) : null;
  }
  const acc = accountId || lead?.account_id || (personId ? q.value("SELECT account_id FROM account_people WHERE id = ?", personId) : null);

  if (tags.blacklist) {
    const account = acc ? q.get("SELECT * FROM accounts WHERE id = ?", acc) : null;
    const domain = account?.domain || (lead && !isFreemail(lead.email) ? lead.email.split("@")[1] : "");
    // Schon gesperrt (z. B. Notiz erneut gespeichert) → nichts doppelt protokollieren.
    const again = domain ? blocked(domain) && (!account || account.lifecycle === "suppressed") : account?.lifecycle === "suppressed";
    tx(() => {
      block(domain, "domain", "#blacklist (Notiz)");
      const leads = acc ? q.all("SELECT * FROM leads WHERE account_id = ?", acc) : lead ? [lead] : [];
      for (const l of leads) {
        q.run("UPDATE leads SET consent_status = 'revoked', updated_at = ? WHERE id = ?", Date.now(), l.id);
        markUnsubscribed(l.id, { source: "#blacklist" });
        closeTasks({ leadId: l.id, outcome: "do_not_contact", status: "dismissed" });
      }
      if (acc) {
        q.run("UPDATE account_people SET do_not_contact = 1, updated_at = ? WHERE account_id = ?", Date.now(), acc);
        q.run("UPDATE tasks SET status = 'dismissed', done_at = ? WHERE account_id = ? AND status = 'open'", Date.now(), acc);
      }
    });
    if (acc && !again) {
      sideState(acc, "suppressed", "#blacklist");
      memo(acc, `#blacklist: Firma gesperrt${domain ? ` (${domain})` : ""} – keine Mails, keine Anrufe.`, lead?.id || null);
    }
    applied.push("blacklist");
    return applied;
  }

  if (tags.nomail && lead) {
    const again = blocked(lead.email);
    tx(() => {
      block(lead.email, "email", "#nomail (Notiz)");
      stopMails(lead.id, "#nomail (Notiz)");
    });
    const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email;
    if (!again) memo(acc, `#nomail: keine Mails mehr an ${name} – anrufen ist weiter möglich.`, lead.id);
    applied.push("nomail");
  }
  return applied;
}

// Rechtliche Reaktion per Mail (Abmahnung, Anwalt, DSGVO-Auskunft): wie #blacklist – ganze Firma nie wieder kontaktieren.
setInboundHandler("legal", lead => applyNoteTags("Rechtliche Reaktion oder Datenschutz-Anfrage auf unsere Mail #blacklist", { leadId: lead.id, accountId: lead.account_id }));
