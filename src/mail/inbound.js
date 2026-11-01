// Eingehende Mails einordnen (Antwort, Abwesenheitsnotiz, Bounce, Warmup) und verarbeiten.
import { q, tx } from "../db.js";
import { htmlToText, stripQuoted, snippet } from "../lib/text.js";
import { FREEMAIL } from "../lib/verify.js";
import { addMessage, ensureConversation } from "../engine/conversations.js";
import { recordEvent, emitWebhook, leadPayload } from "../events.js";
import { advance, sideState } from "../intel/lifecycle.js";
import { ensureAccountForLead } from "../intel/accounts.js";

// Folge-Schritte aus Modulen, die selbst auf diese Datei zugreifen (Kreis-Importe vermeiden):
// „not_interested“ (Sperrfrist/Firmen-Gedächtnis, engine/followup.js) und „legal“ (ganze Firma sperren, engine/noteTags.js).
const handlers = {};
export function setInboundHandler(kind, fn) { handlers[kind] = fn; }

export const WARMUP_HEADER = "x-coldmail-warmup";

const AUTO_SUBJECT = /(abwesenheit|außer haus|ausser haus|nicht im büro|nicht erreichbar|automatische antwort|automatic reply|auto[- ]?reply|autoreply|out of (the )?office|\booo\b|abwesend|urlaub|vacation|on leave|elternzeit|abwesenheitsnotiz|réponse automatique|risposta automatica|empfangsbestätigung|eingangsbestätigung|ticket.*(erstellt|created|received))/i;
const AUTO_BODY = /(ich bin (derzeit|zurzeit|momentan|bis)\b.{0,80}(abwesend|nicht (im büro|erreichbar)|im urlaub)|vielen dank für ihre (e-?mail|nachricht)[.,!]?\s*(ich|wir) (bin|sind) (derzeit|zurzeit|bis)|i am (currently )?out of (the )?office|i('m| am) (away|on vacation|on leave)|this is an automated (reply|response)|diese (e-?mail|nachricht) wurde automatisch)/i;
// Nur eindeutige Abmelde-Wünsche. „keine Werbung“ o. Ä. allein zählt nicht (z. B. „wir machen keine Werbung bei Google“).
const UNSUB_RE = /(\b(abmelden|abbestellen|austragen|unsubscribe)\b|(bitte|möchte|wünsche|will)\s+(ich\s+|wir\s+)?keine\s+(weiteren\s+)?(e-?mails|mails|nachrichten|werbung|kontaktaufnahme|zusendungen)|keine\s+weiteren\s+(e-?mails|mails|nachrichten|zusendungen)|(mich|uns)\s+(bitte\s+)?nicht\s+mehr\s+(kontaktieren|anschreiben|anmailen|schreiben)|bitte\s+nicht\s+mehr\s+(kontaktieren|anschreiben|anmailen|schreiben)|bitte (streichen|entfernen|löschen) sie mich|aus (dem|ihrem|eurem) verteiler|remove me|stop (emailing|contacting)|do not (contact|email) me|take me off)/i;
// Weitere eindeutige „nie wieder“-Wünsche.
const NEVER_RE = /((schreiben|mailen|melden|kontaktieren)\s+sie\s+(mir|uns|mich)\s+(bitte\s+)?(nie(mals)?|nicht)\s+(wieder|mehr)|nie(mals)?\s+(wieder|mehr)\s+(\w+\s+){0,3}(schreiben|kontaktieren|anschreiben|anmailen|melden|e-?mails?|mails?|nachrichten)|lassen\s+sie\s+(mich|uns)\s+(bitte\s+)?in\s+ruhe|unterlassen\s+sie|(unerwünschte|unverlangte|unaufgeforderte)\s+(werbung|e-?mails?|mails?|zusendung)|\b(ist|sind|das\s+ist)\s+(doch\s+)?spam\b)/i;
// Rechtliche Reaktion oder Datenschutz-Anfrage: sofort alles sperren und eine dringende Aufgabe anlegen.
const LEGAL_RE = /(abmahn|unterlassungs|strafbewehrt|rechtliche(n)?\s+schritte|anwalt|anwält|rechtsanw|§\s*7\s*uwg|\buwg\b|\bdsgvo\b|datenschutz-?grundverordnung|art(ikel|\.)?\s*15\b|auskunft\s+(über|zu|nach)\s+(meine|unsere|die\s+(bei\s+ihnen\s+)?gespeicherten|art)|woher\s+haben\s+sie\s+(meine|unsere|die)\s+(daten|adresse|e-?mail|kontakt)|beschwerde\s+(bei|an)\s+(der\s+|die\s+)?(datenschutz|aufsicht|landesdatenschutz))/i;
// Klare Absage – danach nie wieder eine Mail (Anrufe ruhen laut Einstellung).
const NO_INTEREST_RE = /(kein(en|erlei)?\s+(interesse|bedarf)|nicht\s+interessiert|(brauchen|benötigen)\s+wir\s+nicht|no\s+interest|not\s+interested)/i;

const UNSUB_SUBJECT = /^\s*((re|aw|wg|fw|fwd)\s*:\s*)*(abmelden|abmeldung|austragen|abbestellen|unsubscribe|remove)\b/i;

// Betreff ohne unseren zurückzitierten Betreff: alles ab dem ersten „Re:“/„AW:“ ist ein Echo unserer Mail
// (z. B. „Re: Mehr Buchungen – Urlaub neu gedacht“) und darf nicht als Abwesenheitsnotiz gelten.
function ownSubjectPart(subject) {
  const s = String(subject || "");
  const m = /\b(re|aw|wg|fw|fwd|antw)\s*:/i.exec(s);
  return m ? s.slice(0, m.index) : s;
}

function header(parsed, name) {
  const h = parsed.headers?.get?.(name);
  if (h === undefined || h === null) return "";
  if (typeof h === "string") return h;
  if (h.value) return String(h.value);
  if (h.text) return String(h.text);
  return String(h);
}

export function addressList(field) {
  if (!field) return [];
  const values = Array.isArray(field) ? field.flatMap(f => f.value || []) : (field.value || []);
  return values.map(v => String(v.address || "").toLowerCase()).filter(Boolean);
}

export function messageIdsFrom(parsed) {
  const ids = new Set();
  const add = v => { for (const m of String(v || "").match(/<[^<>\s]+>/g) || []) ids.add(m); };
  add(parsed.inReplyTo);
  const refs = parsed.references;
  if (Array.isArray(refs)) refs.forEach(add); else add(refs);
  return [...ids];
}

function bodyText(parsed) {
  if (parsed.text && parsed.text.trim()) return parsed.text;
  if (parsed.html) return htmlToText(parsed.html);
  return "";
}

// Bounce-Details aus DSN (multipart/report) oder Text der Fehlermeldung lesen.
export function parseBounce(parsed) {
  const from = addressList(parsed.from)[0] || "";
  const subject = String(parsed.subject || "");
  const ct = parsed.headers?.get?.("content-type");
  const contentType = ct && typeof ct === "object" ? `${ct.value || ""}; ${Object.entries(ct.params || {}).map(([k, val]) => `${k}=${val}`).join("; ")}` : String(ct || "");
  const hasDsnPart = (parsed.attachments || []).some(a => /^message\/delivery-status$/i.test(String(a.contentType || "")));
  const isReport = (/multipart\/report/i.test(contentType) && /delivery-status/i.test(contentType)) || hasDsnPart;
  const fromDaemon = /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon|bounce|bounces|noreply-dmarc)@/i.test(from) || /^mailer-daemon/i.test(from);
  const subjectHit = /(undeliver|delivery status notification|delivery (has )?failed|returned mail|mail delivery (failed|subsystem)|unzustellbar|nicht zugestellt|zustellung fehlgeschlagen|unable to deliver|failure notice|non[- ]?delivery|rückläufer|zurückgeschickt)/i.test(subject);
  if (!isReport && !(fromDaemon && subjectHit) && !(fromDaemon && /undeliver|not delivered|nicht zugestellt|5\.\d\.\d/i.test(parsed.text || ""))) return null;

  let statusText = "";
  const recipients = new Set();
  let originalMessageId = null;
  for (const att of parsed.attachments || []) {
    const type = String(att.contentType || "").toLowerCase();
    const content = att.content ? att.content.toString("utf8") : "";
    if (type === "message/delivery-status") {
      statusText += content;
      for (const m of content.matchAll(/^(?:final|original)-recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?/gim)) recipients.add(m[1].toLowerCase());
    }
    if (type === "message/rfc822" || type === "text/rfc822-headers" || type === "message/rfc822-headers") {
      const mid = /^message-id:\s*(<[^>]+>)/im.exec(content);
      if (mid) originalMessageId = mid[1];
    }
  }
  const text = parsed.text || "";
  if (!originalMessageId) {
    const mid = /^message-id:\s*(<[^>]+>)/im.exec(text);
    if (mid) originalMessageId = mid[1];
  }
  if (!recipients.size) {
    for (const m of text.matchAll(/(?:final-recipient|original-recipient|<|\s)([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?(?=[\s:,;>]|$)/gim)) {
      const addr = m[1].toLowerCase();
      if (!/^(mailer-daemon|postmaster)@/.test(addr)) recipients.add(addr);
    }
  }
  // mailparser liefert den delivery-status-Teil je nach Aufbau als Anhang oder als Text – beides auswerten.
  const report = `${statusText}\n${text}`;
  const statusMatch = /^status:\s*([245])\.(\d+)\.(\d+)/im.exec(report) || /\b([45])\.(\d)\.(\d{1,3})\b/.exec(text);
  const status = statusMatch ? `${statusMatch[1]}.${statusMatch[2]}.${statusMatch[3]}` : "";
  const action = (/^action:\s*(\w+)/im.exec(report) || [])[1] || "";
  if (/^delayed$/i.test(action) || /^(relayed|delivered|expanded)$/i.test(action)) return { kind: "delay", recipients: [...recipients], originalMessageId, status };
  const hard = status ? status.startsWith("5") : !/(temporar|vorübergehend|delay|verzögert|will retry|retry)/i.test(text);
  const diag = (/^diagnostic-code:\s*(?:smtp;)?\s*(.+)$/im.exec(report) || [])[1] || snippet(stripQuoted(text), 200);
  return { kind: hard ? "hard" : "soft", recipients: [...recipients], originalMessageId, status, reason: diag };
}

export function isAutoReply(parsed) {
  const autoSubmitted = header(parsed, "auto-submitted").toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  if (header(parsed, "x-autoreply") || header(parsed, "x-autorespond") || header(parsed, "x-autoresponder")) return true;
  const subject = ownSubjectPart(parsed.subject);
  if (/auto_reply|autoreply/i.test(header(parsed, "x-auto-response-suppress")) && AUTO_SUBJECT.test(subject)) return true;
  const precedence = header(parsed, "precedence").toLowerCase();
  if (["auto_reply", "auto-reply"].includes(precedence)) return true;
  if (AUTO_SUBJECT.test(subject)) return true;
  const text = stripQuoted(bodyText(parsed)).slice(0, 1500);
  return AUTO_BODY.test(text);
}

export function wantsUnsubscribe(text, subject = "") {
  // Abmelde-Link per mailto: Betreff „Abmelden“, Text oft leer.
  if (UNSUB_SUBJECT.test(String(subject || ""))) return true;
  // Zeilen mit Links ignorieren (z. B. unser eigener Abmelde-Hinweis, falls das Zitat nicht erkannt wurde).
  const own = ownText(text);
  return UNSUB_RE.test(own) || NEVER_RE.test(own);
}
const ownText = text => String(text || "").split("\n").filter(line => !/https?:\/\//i.test(line)).join("\n").slice(0, 1500);
export const legalThreat = text => LEGAL_RE.test(ownText(text));
export const noInterest = text => NO_INTEREST_RE.test(ownText(text));

export function analyzeInbound(parsed) {
  if (header(parsed, WARMUP_HEADER)) return { type: "warmup", token: header(parsed, WARMUP_HEADER).trim() };
  const bounce = parseBounce(parsed);
  if (bounce) return { type: "bounce", bounce };
  const text = stripQuoted(bodyText(parsed));
  if (isAutoReply(parsed)) return { type: "auto_reply", text };
  const legal = legalThreat(text);
  return { type: "reply", text, legal, unsubscribe: legal || wantsUnsubscribe(text, parsed.subject), not_interested: noInterest(text) };
}

// Ordnet eine eingehende Nachricht einem Gespräch zu: zuerst über Message-ID-Bezüge, sonst über Absender = Lead.
function findOutboundFor(parsed, mailboxId) {
  const ids = messageIdsFrom(parsed);
  for (const id of ids.reverse()) {
    const m = q.get("SELECT * FROM messages WHERE message_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", id);
    if (m) return m;
  }
  const from = addressList(parsed.from)[0];
  if (!from) return null;
  return q.get(`SELECT m.* FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.email = ? AND m.direction = 'out' AND (m.mailbox_id = ? OR ? IS NULL)
    ORDER BY m.created_at DESC LIMIT 1`, from, mailboxId, mailboxId);
}

function stopForReply(cl, leadId, now) {
  // Lead hat geantwortet: in allen Kampagnen mit "Stopp bei Antwort" anhalten.
  q.run(`UPDATE campaign_leads SET replied_at = COALESCE(replied_at, ?), status = CASE WHEN status IN ('queued','active','paused') THEN 'replied' ELSE status END, next_at = NULL
    WHERE lead_id = ? AND campaign_id IN (SELECT id FROM campaigns WHERE stop_on_reply = 1)`, now, leadId);
  q.run("UPDATE campaign_leads SET replied_at = COALESCE(replied_at, ?) WHERE lead_id = ?", now, leadId);
  // Firma stoppen: andere Kontakte derselben Firmen-Domain in derselben Kampagne nicht weiter anschreiben.
  if (cl) {
    const campaign = q.get("SELECT * FROM campaigns WHERE id = ?", cl.campaign_id);
    const lead = q.get("SELECT email FROM leads WHERE id = ?", leadId);
    const domain = String(lead?.email || "").split("@")[1];
    if (campaign?.stop_company_on_reply && domain && !FREEMAIL.has(domain)) {
      q.run(`UPDATE campaign_leads SET status = 'stopped', last_error = 'Firma hat geantwortet', next_at = NULL
        WHERE campaign_id = ? AND status IN ('queued','active') AND lead_id IN (SELECT id FROM leads WHERE email LIKE ? ESCAPE '\\')`,
        cl.campaign_id, `%@${domain.replace(/[%_\\]/g, c => "\\" + c)}`);
    }
  }
}

export function markUnsubscribed(leadId, { source = "link", campaignId = null } = {}) {
  const lead = q.get("SELECT * FROM leads WHERE id = ?", leadId);
  if (!lead) return false;
  const already = lead.status === "unsubscribed";
  tx(() => {
    q.run("UPDATE leads SET status = 'unsubscribed', updated_at = ? WHERE id = ?", Date.now(), leadId);
    q.run("UPDATE campaign_leads SET status = 'unsubscribed', next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", leadId);
    q.run("INSERT INTO blocklist (value, kind, reason, created_at) VALUES (?, 'email', ?, ?) ON CONFLICT(value) DO NOTHING", lead.email, `Abgemeldet (${source})`, Date.now());
    // Kaltkontakt sagt „nie wieder“ → niemand in dieser Firma bekommt mehr Mails (Kollegen eingeschlossen).
    const domain = lead.email.split("@")[1];
    if (domain && !FREEMAIL.has(domain) && !["granted", "customer"].includes(lead.consent_status)) {
      q.run("INSERT INTO blocklist (value, kind, reason, created_at) VALUES (?, 'domain', ?, ?) ON CONFLICT(value) DO NOTHING", domain, `Abgemeldet (${source}): ${lead.email}`, Date.now());
      stopDomain(domain, `Abgemeldet (${lead.email})`);
    }
    if (!already) recordEvent("unsubscribe", { campaign_id: campaignId, lead_id: leadId, data: { source } });
  });
  if (!already) emitWebhook("lead.unsubscribed", { lead: leadPayload(leadId), source, campaign_id: campaignId });
  if (lead.account_id) {
    q.run("UPDATE account_people SET do_not_contact = 1, updated_at = ? WHERE lead_id = ?", Date.now(), leadId);
    if (!already) {
      const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || "Ein Kontakt";
      q.run("INSERT INTO account_memory (account_id, kind, text, source, lead_id, created_at) VALUES (?, 'note', ?, 'system', ?, ?)", lead.account_id, `${name} hat sich abgemeldet (${source}) – nie wieder anschreiben.`, leadId, Date.now());
    }
    // Niemand mehr bei der Firma erreichbar → Firma sperren.
    if (!q.get("SELECT 1 FROM account_people WHERE account_id = ? AND do_not_contact = 0 AND lead_id IS NOT NULL AND lead_id != ?", lead.account_id, leadId)) sideState(lead.account_id, "suppressed", "Abmeldung");
  }
  return true;
}

// Domain gesperrt: alle noch geplanten Mails an diese Firma stoppen.
function stopDomain(domain, reason) {
  if (!domain || FREEMAIL.has(domain)) return;
  q.run(`UPDATE campaign_leads SET status = 'stopped', last_error = ?, next_at = NULL WHERE status IN ('queued','active','paused')
    AND lead_id IN (SELECT id FROM leads WHERE email LIKE ? ESCAPE '\\')`, reason, `%@${domain.replace(/[\\%_]/g, c => "\\" + c)}`);
}

// Absage per Mail: nie wieder eine Mail an diese Firma, Anrufe ruhen (Einstellung „Sperre nach kein Interesse“).
function handleNoInterest(lead, conversation, now) {
  const domain = lead.email.split("@")[1];
  tx(() => {
    q.run("UPDATE conversations SET label = 'not_interested', label_by = 'rule', ai_pending = 0 WHERE id = ?", conversation.id);
    q.run("INSERT INTO blocklist (value, kind, reason, created_at) VALUES (?, 'email', ?, ?) ON CONFLICT(value) DO NOTHING", lead.email, "Kein Interesse (Antwort)", now);
    if (domain && !FREEMAIL.has(domain) && !["granted", "customer"].includes(lead.consent_status)) {
      q.run("INSERT INTO blocklist (value, kind, reason, created_at) VALUES (?, 'domain', ?, ?) ON CONFLICT(value) DO NOTHING", domain, `Kein Interesse (Antwort): ${lead.email}`, now);
    }
    q.run("UPDATE campaign_leads SET status = 'stopped', last_error = 'Kein Interesse', next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", lead.id);
    if (!["granted", "customer"].includes(lead.consent_status)) stopDomain(domain, `Kein Interesse (${lead.email})`);
  });
  // Gleicher Weg wie die KI-Einordnung: Sperrfrist für Anrufe, Einwand im Firmen-Gedächtnis.
  const holdDays = 365;
  q.run("UPDATE leads SET hold_until = MAX(COALESCE(hold_until, 0), ?), updated_at = ? WHERE id = ?", now + holdDays * 86400000, now, lead.id);
  handlers.not_interested?.(q.get("SELECT * FROM conversations WHERE id = ?", conversation.id));
}

// Abmahnung, Anwalt, DSGVO-Auskunft: ganze Firma sperren und eine dringende Aufgabe anlegen (Auskunft binnen eines Monats).
function handleLegal(lead, conversation, text, now) {
  q.run("UPDATE conversations SET label = 'unsubscribe', label_by = 'rule', ai_pending = 0 WHERE id = ?", conversation.id);
  q.run("UPDATE leads SET consent_status = 'revoked', updated_at = ? WHERE id = ?", now, lead.id);
  markUnsubscribed(lead.id, { source: "Rechtliche Reaktion", campaignId: conversation.campaign_id });
  handlers.legal?.(lead);
  // Erst nach dem Sperren anlegen – die Sperre schließt alle offenen Aufgaben der Firma.
  q.run(`INSERT INTO tasks (type, title, lead_id, account_id, conversation_id, campaign_id, due_at, status, notes, priority, created_at) VALUES ('reply', ?, ?, ?, ?, ?, ?, 'open', ?, 500, ?)`,
    `Rechtliche Reaktion / Datenschutz-Anfrage: ${lead.company || lead.email} – sofort prüfen`, lead.id, lead.account_id || null, conversation.id, conversation.campaign_id || null, now,
    `Firma ist gesperrt. Nicht verkaufen, sachlich antworten. Bei Auskunft (Art. 15 DSGVO) binnen eines Monats antworten: welche Daten, Herkunft, Zweck, Löschung anbieten.\n\n„${snippet(text, 400)}“`, now);
  recordEvent("legal_reply", { campaign_id: conversation.campaign_id, lead_id: lead.id, mailbox_id: conversation.mailbox_id });
}

// Newsletter, Benachrichtigungen und Systemmails gehören nicht in den Posteingang der App.
const SYSTEM_SENDER = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|notify|newsletter|news|alerts?|system|daemon)([+._-].*)?@/i;
export function isBulkOrSystem(parsed, fromAddr) {
  if (SYSTEM_SENDER.test(fromAddr)) return true;
  // mailparser fasst List-Unsubscribe/List-Id unter „list“ zusammen.
  const list = parsed.headers?.get?.("list");
  if ((list && (list.unsubscribe || list.id)) || header(parsed, "list-unsubscribe") || header(parsed, "list-id")) return true;
  return ["bulk", "list", "junk"].includes(header(parsed, "precedence").toLowerCase());
}

// Direkte Mail von jemandem, der noch kein Lead ist: als Kontakt anlegen, damit alles in der App landet.
function leadFromInbound(parsed, fromAddr, mailbox, now) {
  const display = (Array.isArray(parsed.from) ? parsed.from[0] : parsed.from)?.value?.[0]?.name || "";
  const name = String(display).replace(/["']/g, "").trim();
  const parts = /@/.test(name) ? [] : name.split(/\s+/).filter(Boolean);
  const id = q.run(`INSERT INTO leads (email, first_name, last_name, source, notes, custom, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    fromAddr, parts.length > 1 ? parts.slice(0, -1).join(" ").slice(0, 100) : "", parts.length > 1 ? parts[parts.length - 1].slice(0, 100) : (parts[0] || "").slice(0, 100),
    "Posteingang", `Hat direkt an ${mailbox.email} geschrieben`, JSON.stringify({ posteingang: mailbox.email }), now, now).lastInsertRowid;
  ensureAccountForLead(Number(id));
  return q.get("SELECT * FROM leads WHERE id = ?", Number(id));
}

// Verarbeitet eine geparste Nachricht. Gibt eine Beschreibung des Ergebnisses zurück.
export function processInbound(mailbox, parsed, { uid = null, now = Date.now() } = {}) {
  const analysis = analyzeInbound(parsed);
  const messageId = parsed.messageId ? (String(parsed.messageId).startsWith("<") ? parsed.messageId : `<${parsed.messageId}>`) : null;
  if (analysis.type === "warmup") return { type: "warmup", token: analysis.token };

  if (messageId && q.get("SELECT 1 FROM messages WHERE message_id = ? AND direction = 'in' AND mailbox_id = ?", messageId, mailbox.id)) return { type: "duplicate" };

  if (analysis.type === "bounce") {
    const b = analysis.bounce;
    let original = b.originalMessageId ? q.get("SELECT * FROM messages WHERE message_id = ? AND direction = 'out'", b.originalMessageId) : null;
    if (!original) {
      for (const r of b.recipients) {
        original = q.get("SELECT * FROM messages WHERE to_addr = ? AND direction = 'out' AND (mailbox_id = ? OR ? IS NULL) ORDER BY created_at DESC LIMIT 1", r, mailbox.id, mailbox.id);
        if (original) break;
      }
    }
    if (!original || b.kind === "delay") return { type: "bounce", matched: !!original, ignored: true };
    // Dieselbe Meldung kann nach einem Neu-Abgleich (UIDVALIDITY) erneut eintreffen.
    if (q.get("SELECT 1 FROM events WHERE type = ? AND message_id = ?", b.kind === "hard" ? "bounce" : "soft_bounce", original.id)) return { type: "bounce", matched: true, duplicate: true };
    tx(() => {
      if (b.kind === "hard") {
        q.run("UPDATE messages SET status = 'bounced', error = ? WHERE id = ?", String(b.reason || b.status).slice(0, 500), original.id);
        if (original.lead_id) {
          q.run("UPDATE leads SET status = 'bounced', updated_at = ? WHERE id = ? AND status = 'active'", now, original.lead_id);
          q.run("UPDATE campaign_leads SET status = 'bounced', last_error = ?, next_at = NULL WHERE lead_id = ? AND status IN ('queued','active','paused')", String(b.reason || "Bounce").slice(0, 300), original.lead_id);
        }
      }
      recordEvent(b.kind === "hard" ? "bounce" : "soft_bounce", { campaign_id: original.campaign_id, lead_id: original.lead_id, mailbox_id: mailbox.id, message_id: original.id, step: original.step, variant: original.variant, data: { status: b.status, reason: b.reason } });
    });
    if (b.kind === "hard" && original.lead_id) emitWebhook("lead.bounced", { lead: leadPayload(original.lead_id), campaign_id: original.campaign_id, reason: b.reason });
    return { type: "bounce", matched: true, hard: b.kind === "hard", leadId: original.lead_id };
  }

  const fromAddr = addressList(parsed.from)[0] || "";
  const original = findOutboundFor(parsed, mailbox.id);
  let lead = original?.lead_id ? q.get("SELECT * FROM leads WHERE id = ?", original.lead_id) : null;
  if (!lead && fromAddr) lead = q.get("SELECT * FROM leads WHERE email = ?", fromAddr);
  if (!lead) {
    if (!fromAddr || analysis.type === "auto_reply" || isBulkOrSystem(parsed, fromAddr)) return { type: "ignored", reason: "Newsletter/System-Mail oder Abwesenheitsnotiz" };
    if (q.get("SELECT 1 FROM mailboxes WHERE lower(email) = ?", fromAddr)) return { type: "ignored", reason: "Eigenes Postfach" };
    lead = leadFromInbound(parsed, fromAddr, mailbox, now);
  }

  const cl = original?.campaign_lead_id ? q.get("SELECT * FROM campaign_leads WHERE id = ?", original.campaign_lead_id) : null;
  let conversation = original?.conversation_id ? q.get("SELECT * FROM conversations WHERE id = ?", original.conversation_id) : null;
  if (!conversation) conversation = q.get("SELECT * FROM conversations WHERE lead_id = ? AND mailbox_id = ? ORDER BY last_at DESC LIMIT 1", lead.id, mailbox.id);
  if (!conversation) conversation = ensureConversation({ mailbox_id: mailbox.id, lead_id: lead.id, campaign_id: cl?.campaign_id || null, campaign_lead_id: cl?.id || null, subject: parsed.subject || "", now });

  const isAuto = analysis.type === "auto_reply";
  const fullText = bodyText(parsed);
  const result = tx(() => {
    const msgId = addMessage({
      conversation_id: conversation.id, mailbox_id: mailbox.id, lead_id: lead.id, campaign_id: conversation.campaign_id, campaign_lead_id: conversation.campaign_lead_id,
      step: original?.step ?? null, variant: original?.variant ?? null, direction: "in", kind: isAuto ? "auto_reply" : "reply",
      message_id: messageId, in_reply_to: parsed.inReplyTo || null, refs: messageIdsFrom(parsed).join(" "),
      from_addr: fromAddr, to_addr: addressList(parsed.to)[0] || mailbox.email, subject: parsed.subject || "",
      text: fullText.slice(0, 200000), html: parsed.html ? String(parsed.html).slice(0, 500000) : null, status: "received", imap_uid: uid, created_at: now
    });
    const ctx = { campaign_id: conversation.campaign_id, lead_id: lead.id, mailbox_id: mailbox.id, message_id: msgId, step: original?.step ?? null, variant: original?.variant ?? null };
    if (isAuto) {
      q.run("UPDATE conversations SET label = COALESCE(label, 'ooo'), label_by = CASE WHEN label IS NULL THEN 'rule' ELSE label_by END WHERE id = ?", conversation.id);
      recordEvent("auto_reply", ctx);
      const campaign = cl ? q.get("SELECT stop_on_auto_reply FROM campaigns WHERE id = ?", cl.campaign_id) : null;
      if (campaign?.stop_on_auto_reply) stopForReply(cl, lead.id, now);
    } else {
      // Echte Antwort: Label zurücksetzen, damit die KI neu einordnet.
      q.run("UPDATE conversations SET label = CASE WHEN label = 'ooo' THEN NULL ELSE label END, label_by = CASE WHEN label = 'ooo' THEN NULL ELSE label_by END, ai_pending = 1 WHERE id = ?", conversation.id);
      const firstReply = !q.get("SELECT 1 FROM events WHERE type = 'reply' AND lead_id = ? AND (campaign_id = ? OR (campaign_id IS NULL AND ? IS NULL))", lead.id, conversation.campaign_id, conversation.campaign_id);
      if (firstReply) recordEvent("reply", ctx);
      stopForReply(cl, lead.id, now);
      // Lead hat sich gemeldet: geplantes Nachfassen ruht (KI/Nutzer ordnen neu ein), Anruf „nach Sequenz“ entfällt.
      q.run("UPDATE conversations SET nurture_next_at = NULL WHERE id = ?", conversation.id);
      q.run("UPDATE tasks SET status = 'dismissed', outcome = 'replied', done_at = ? WHERE lead_id = ? AND type = 'call_sequence' AND status = 'open'", now, lead.id);
      if (analysis.unsubscribe) {
        q.run("UPDATE conversations SET label = 'unsubscribe', label_by = 'rule', ai_pending = 0 WHERE id = ?", conversation.id);
      }
    }
    return { msgId };
  });
  if (!isAuto && !analysis.unsubscribe && !analysis.not_interested && lead.account_id) advance(lead.account_id, "engaged", "Antwort erhalten", { allowFromSide: ["disqualified", "lost"] });
  if (!isAuto && analysis.legal) handleLegal(lead, conversation, analysis.text, now);
  else if (!isAuto && analysis.unsubscribe) markUnsubscribed(lead.id, { source: "reply", campaignId: conversation.campaign_id });
  else if (!isAuto && analysis.not_interested) handleNoInterest(lead, conversation, now);
  if (!isAuto) emitWebhook("reply.received", { lead: leadPayload(lead.id), campaign_id: conversation.campaign_id, conversation_id: conversation.id, subject: parsed.subject || "", text: snippet(analysis.text, 1000) });
  return { type: analysis.type, conversationId: conversation.id, messageId: result.msgId, leadId: lead.id, unsubscribe: !!analysis.unsubscribe };
}
