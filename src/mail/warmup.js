// Internes Warmup: eigene Postfächer schreiben sich gegenseitig natürliche Mails, öffnen sie, holen sie aus dem Spam,
// markieren sie und antworten teilweise. Daraus entsteht ein Zustellbarkeits-Wert (Posteingang vs. Spam) je Postfach.
import { q, insert } from "../db.js";
import { token as newToken, randomBetween } from "../crypto.js";
import { spin } from "../lib/template.js";
import { zonedParts, zonedTime } from "../lib/time.js";
import { buildRaw, sendRaw } from "./transport.js";
import { newMessageId } from "./compose.js";
import { warmupSentToday, warmupTarget, appTimezone } from "./mailboxes.js";
import { getSettings } from "../settings.js";
import { moveToFolder } from "./imap.js";

const SUBJECTS = [
  "{Kurze Frage|Frage} zu {nächster Woche|Donnerstag|dem Termin|Freitag}",
  "{Unterlagen|Dokumente|Notizen} von {gestern|heute|unserem Gespräch}",
  "{Re: |}Abstimmung {Projektplan|Zeitplan|Budget}",
  "{Danke|Vielen Dank} {für die Rückmeldung|für das Update|für gestern}",
  "{Treffen|Call|Telefonat} {verschieben|bestätigt|am Mittwoch}?",
  "{Idee|Gedanke} zum {Workshop|Angebot|Konzept}",
  "{Update|Stand} {Website|Kampagne|Projekt}",
  "{Rückfrage|Kurze Rückfrage} {Rechnung|Angebot|Vertrag}",
  "{Feedback|Meinung} gefragt",
  "{Termin|Meeting} {nächste Woche|im Oktober|im November}"
];
const BODIES = [
  "{Hallo|Hi|Guten Morgen} {{to_first}},\n\n{wollte kurz nachfragen|kurze Frage}, ob {der Termin|unser Call} {am Donnerstag|nächste Woche|am Freitag} {noch passt|weiterhin steht}? {Bei mir hat sich etwas verschoben|Ich plane gerade die Woche}.\n\n{Viele Grüße|Beste Grüße|Grüße}\n{{from_first}}",
  "{Hallo|Hi} {{to_first}},\n\n{anbei wie besprochen|hier wie versprochen} {die Notizen|die Punkte|die Zusammenfassung} von {gestern|unserem Gespräch}. {Sag Bescheid, wenn etwas fehlt|Ergänze gern, falls ich etwas vergessen habe}.\n\n{Danke dir|Danke} und {beste Grüße|viele Grüße}\n{{from_first}}",
  "{Guten Tag|Hallo} {{to_first}},\n\n{ich habe mir|wir haben uns} {den Zeitplan|die Planung} {noch einmal angeschaut|nochmal angesehen}. {Passt es, wenn wir|Können wir} {die Abstimmung|das Thema} {auf Mittwoch|auf nächste Woche} {legen|schieben}?\n\n{Grüße|Viele Grüße}\n{{from_first}}",
  "{Hi|Hallo} {{to_first}},\n\n{danke für|vielen Dank für} {das schnelle Update|die Rückmeldung}! {Das hilft mir sehr|Damit kann ich gut weiterarbeiten}. {Ich melde mich|Ich gebe dir} {bis Ende der Woche|morgen} {Bescheid|ein kurzes Update}.\n\n{Beste Grüße|LG}\n{{from_first}}",
  "{Hallo|Hi} {{to_first}},\n\n{hast du|hättest du} {kurz Zeit|diese Woche 15 Minuten} für {einen kurzen Call|eine kurze Abstimmung}? {Es geht um|Thema ist} {das Angebot|den Workshop|die neue Website}.\n\n{Danke|Danke dir} und {viele Grüße|Grüße}\n{{from_first}}",
  "{Guten Morgen|Hallo} {{to_first}},\n\n{kurzes Update|nur ein kurzes Update}: {wir liegen gut im Plan|alles läuft nach Plan|der erste Teil ist fertig}. {Nächster Schritt ist|Als Nächstes kommt} {die Abstimmung mit dem Team|das Feedback|die Freigabe}.\n\n{Viele Grüße|Beste Grüße}\n{{from_first}}"
];
const REPLIES = [
  "{Hallo|Hi} {{to_first}},\n\n{danke dir|vielen Dank}, {passt|das passt} {gut|super|perfekt}. {Ich melde mich|Ich komme} {später|morgen|Anfang nächster Woche} {nochmal|dazu} {auf dich zu|zurück}.\n\n{Grüße|Viele Grüße}\n{{from_first}}",
  "{Hi|Hallo} {{to_first}},\n\n{klingt gut|sehr gut|alles klar}! {Lass uns das so machen|So machen wir es}. {Danke für die Info|Danke fürs Bescheid geben}.\n\n{Beste Grüße|LG}\n{{from_first}}",
  "{Hallo|Hi} {{to_first}},\n\n{danke für die Nachricht|danke dir}. {Donnerstag geht bei mir|Mittwoch würde passen|Das passt mir}, {gern am Vormittag|gern ab 10 Uhr|am besten nachmittags}.\n\n{Viele Grüße|Grüße}\n{{from_first}}"
];

const first = name => String(name || "").trim().split(/\s+/)[0] || "";
function fillNames(text, from, to) {
  return text.replace(/\{\{from_first\}\}/g, first(from.from_name) || from.email.split("@")[0]).replace(/\{\{to_first\}\}/g, first(to.from_name) || "");
}

export function warmupContent(from, to, { reply = false, subject = "" } = {}) {
  const body = fillNames(spin(reply ? REPLIES[randomBetween(0, REPLIES.length - 1)] : BODIES[randomBetween(0, BODIES.length - 1)]), from, to).replace(/ ,/g, ",");
  const subj = reply ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`) : spin(SUBJECTS[randomBetween(0, SUBJECTS.length - 1)]);
  return { subject: subj.trim(), text: body };
}

export async function sendWarmup(from, to, { reply = false, parent = null } = {}) {
  const token = newToken(12);
  const content = warmupContent(from, to, { reply, subject: parent?.subject || "" });
  const messageId = newMessageId(from.email);
  const mail = {
    from: { name: from.from_name || "", address: from.email },
    to: { name: to.from_name || "", address: to.email },
    subject: content.subject,
    text: content.text,
    messageId,
    date: new Date(),
    headers: { "X-Coldmail-Warmup": token }
  };
  if (parent?.message_id) { mail.inReplyTo = parent.message_id; mail.references = parent.message_id; }
  const raw = await buildRaw(mail);
  await sendRaw(from, { from: from.email, to: to.email, raw });
  insert("warmup", { token, from_mailbox_id: from.id, to_mailbox_id: to.id, parent_id: parent?.id || null, message_id: messageId, subject: content.subject, sent_at: Date.now() });
  return token;
}

// Wird vom Scheduler aufgerufen: verteilt die Warmup-Mails gleichmäßig über den Tag (07–19 Uhr).
export async function runWarmupTick(now = Date.now()) {
  const pool = q.all("SELECT * FROM mailboxes WHERE warmup_enabled = 1 AND status = 'active'");
  if (pool.length < 2) return 0;
  const tz = appTimezone();
  const p = zonedParts(now, tz);
  if (p.hour < 7 || p.hour >= 19) return 0;
  const dayEnd = zonedTime(p.year, p.month, p.day, 19, 0, tz);
  let sent = 0;
  for (const mb of pool) {
    if (!mb.warmup_started_at) q.run("UPDATE mailboxes SET warmup_started_at = ? WHERE id = ?", now, mb.id);
    if ((mb.warmup_next_at || 0) > now) continue;
    const target = warmupTarget({ ...mb, warmup_started_at: mb.warmup_started_at || now }, now);
    const done = warmupSentToday(mb.id, now);
    if (done >= target) continue;
    const peers = pool.filter(x => x.id !== mb.id);
    const to = peers[randomBetween(0, peers.length - 1)];
    try {
      await sendWarmup(mb, to);
      sent++;
      const spacing = Math.max(10 * 60 * 1000, ((dayEnd - now) / Math.max(1, target - done - 1)) * (0.6 + Math.random() * 0.8));
      q.run("UPDATE mailboxes SET warmup_next_at = ? WHERE id = ?", now + spacing, mb.id);
    } catch (err) {
      q.run("UPDATE mailboxes SET warmup_next_at = ?, last_error = ? WHERE id = ?", now + 30 * 60 * 1000, `Warmup: ${err.message}`.slice(0, 300), mb.id);
    }
  }
  return sent;
}

// Empfangsseite (aus dem IMAP-Abgleich): als gelesen markieren, ggf. antworten, in Warmup-Ordner verschieben.
export async function handleWarmupReceived({ client, mailbox, uid, token }) {
  const row = q.get("SELECT * FROM warmup WHERE token = ?", token);
  if (row && row.to_mailbox_id === mailbox.id) {
    q.run("UPDATE warmup SET landed = COALESCE(landed, 'inbox'), checked_at = COALESCE(checked_at, ?) WHERE id = ?", Date.now(), row.id);
  }
  const flags = ["\\Seen"];
  if (Math.random() < 0.25) flags.push("\\Flagged");
  await client.messageFlagsAdd(String(uid), flags, { uid: true }).catch(() => {});
  if (row && row.to_mailbox_id === mailbox.id && !row.parent_id && !row.replied && Math.random() * 100 < (mailbox.warmup_reply_rate ?? 35)) {
    const sender = q.get("SELECT * FROM mailboxes WHERE id = ? AND warmup_enabled = 1 AND status = 'active'", row.from_mailbox_id);
    if (sender) {
      try {
        await sendWarmup(mailbox, sender, { reply: true, parent: row });
        q.run("UPDATE warmup SET replied = 1 WHERE id = ?", row.id);
      } catch { /* nächster Versuch beim nächsten Warmup */ }
    }
  }
  const folder = getSettings().warmup_folder;
  if (folder) await moveToFolder(client, uid, folder).catch(() => {});
}
