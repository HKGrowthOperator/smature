// IMAP-Anbindung (imapflow): Posteingang abgleichen, Spam-Ordner für Warmup prüfen, Kopie in "Gesendet" ablegen.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { q } from "../db.js";
import { config } from "../config.js";
import { decrypt } from "../crypto.js";
import { processInbound, WARMUP_HEADER } from "./inbound.js";
import { handleWarmupReceived } from "./warmup.js";

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const FIRST_SYNC_DAYS = 7;
const MAX_PER_SYNC = 150;
const SENT_NAMES = ["sent", "gesendet", "gesendete elemente", "gesendete objekte", "sent items", "sent messages", "inbox.sent", "inbox.gesendet", "[gmail]/sent mail", "[gmail]/gesendet"];
const SPAM_NAMES = ["spam", "junk", "junk-e-mail", "junk e-mail", "junk email", "inbox.spam", "inbox.junk", "[gmail]/spam", "bulk mail", "unerwünscht"];

export function imapOptions(mb) {
  return {
    host: mb.imap_host,
    port: Number(mb.imap_port) || 993,
    secure: !!mb.imap_secure,
    auth: { user: mb.imap_user || mb.smtp_user, pass: mb.imap_pass_plain ?? decrypt(mb.imap_pass) },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 120000,
    tls: { rejectUnauthorized: !config.allowInsecureTls, minVersion: "TLSv1.2" },
    clientInfo: { name: "Smature Coldmail", version: "1.0" }
  };
}

export const imapConfigured = mb => !!(mb && mb.imap_host && (mb.imap_user || mb.smtp_user) && (mb.imap_pass || mb.imap_pass_plain));

export async function withImap(mb, fn) {
  const client = new ImapFlow(imapOptions(mb));
  client.on("error", () => {}); // Fehler kommen über die Promises; verhindert unbehandelte 'error'-Events
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export async function verifyImap(mb) {
  try {
    await withImap(mb, async client => {
      const lock = await client.getMailboxLock("INBOX");
      lock.release();
    });
    return { ok: true };
  } catch (err) {
    const msg = err.authenticationFailed || /auth/i.test(err.responseText || err.message || "")
      ? "Anmeldung fehlgeschlagen – Benutzername/Passwort (bei Google: App-Passwort) prüfen."
      : `Verbindung fehlgeschlagen – Host, Port und SSL prüfen. (${err.responseText || err.message})`;
    return { ok: false, error: msg };
  }
}

async function findFolder(client, specialUse, names) {
  const list = await client.list();
  const bySpecial = list.find(f => f.specialUse === specialUse);
  if (bySpecial) return bySpecial.path;
  const byName = list.find(f => names.includes(String(f.path).toLowerCase()) || names.includes(String(f.name).toLowerCase()));
  return byName ? byName.path : null;
}

const AUTO_SAVES_SENT = /(^|\.)(gmail\.com|googlemail\.com|office365\.com|outlook\.com|outlook\.office365\.com)$/i;
export const providerSavesSent = mb => AUTO_SAVES_SENT.test(String(mb.smtp_host || ""));

export async function appendToSent(mb, raw) {
  if (!imapConfigured(mb) || providerSavesSent(mb)) return false;
  return withImap(mb, async client => {
    let folder = mb.sent_folder;
    if (!folder) {
      folder = await findFolder(client, "\\Sent", SENT_NAMES);
      if (folder) q.run("UPDATE mailboxes SET sent_folder = ? WHERE id = ?", folder, mb.id);
    }
    if (!folder) return false;
    await client.append(folder, raw, ["\\Seen"], new Date());
    return true;
  });
}

// Rohdaten holen. Netzwerk-/Protokollfehler werden geworfen (Abgleich bricht ab und setzt beim nächsten Mal hier fort),
// eine inzwischen gelöschte Nachricht ergibt null.
async function fetchRaw(client, uid) {
  const meta = await client.fetchOne(String(uid), { uid: true, size: true }, { uid: true });
  if (!meta) return null;
  if (meta.size > MAX_MESSAGE_BYTES) {
    const head = await client.fetchOne(String(uid), { uid: true, headers: true }, { uid: true });
    return head?.headers || null;
  }
  const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  return msg?.source || null;
}

export const syncState = new Map(); // mailboxId → { running, lastResult }

// Neue Nachrichten im Posteingang verarbeiten; Warmup-Mails im Spam-Ordner retten.
export async function syncMailbox(mb, { now = Date.now() } = {}) {
  if (!imapConfigured(mb)) return { skipped: "IMAP nicht konfiguriert" };
  const state = syncState.get(mb.id) || {};
  if (state.running) return { skipped: "läuft bereits" };
  state.running = true;
  syncState.set(mb.id, state);
  const stats = { processed: 0, replies: 0, bounces: 0, autoReplies: 0, warmup: 0, ignored: 0, rescued: 0 };
  try {
    await withImap(mb, async client => {
      const warmupActions = [];
      const lock = await client.getMailboxLock("INBOX");
      let lastUid = mb.imap_last_uid || 0;
      try {
        const box = client.mailbox;
        const validity = String(box.uidValidity);
        let uids;
        if (validity !== mb.imap_uidvalidity || !mb.imap_last_uid) {
          uids = (await client.search({ since: new Date(now - FIRST_SYNC_DAYS * 86400000) }, { uid: true })) || [];
          lastUid = 0;
        } else {
          uids = ((await client.search({ uid: `${lastUid + 1}:*` }, { uid: true })) || []).filter(u => u > lastUid);
        }
        uids.sort((a, b) => a - b);
        for (const uid of uids.slice(0, MAX_PER_SYNC)) {
          let raw;
          try {
            raw = await fetchRaw(client, uid);
          } catch (err) {
            // Verbindung weg o. Ä.: nicht weiterzählen, sonst gingen die restlichen Nachrichten verloren.
            stats.fetch_error = err.message || "Abruf fehlgeschlagen";
            break;
          }
          lastUid = Math.max(lastUid, uid);
          if (!raw) continue;
          let parsed;
          try {
            parsed = await simpleParser(raw);
          } catch (err) {
            console.error(`[imap] ${mb.email}: Nachricht ${uid} nicht lesbar`, err.message);
            continue;
          }
          stats.processed++;
          let result;
          try {
            result = processInbound(mb, parsed, { uid, now: Date.now() });
          } catch (err) {
            console.error(`[imap] ${mb.email}: Nachricht ${uid} konnte nicht verarbeitet werden`, err);
            stats.ignored++;
            continue;
          }
          if (result.type === "warmup") {
            stats.warmup++;
            warmupActions.push({ uid, parsed, token: result.token, folder: "INBOX" });
          } else if (result.type === "reply") stats.replies++;
          else if (result.type === "auto_reply") stats.autoReplies++;
          else if (result.type === "bounce") stats.bounces++;
          else stats.ignored++;
        }
        if (!uids.length && validity !== mb.imap_uidvalidity) lastUid = Math.max(0, (box.uidNext || 1) - 1);
        q.run("UPDATE mailboxes SET imap_uidvalidity = ?, imap_last_uid = ?, last_sync_at = ?, sync_error = ? WHERE id = ?", validity, lastUid, Date.now(), stats.fetch_error ? `Abgleich unterbrochen: ${stats.fetch_error}`.slice(0, 300) : null, mb.id);
        for (const action of warmupActions) await handleWarmupReceived({ client, mailbox: mb, ...action }).catch(() => {});
      } finally {
        lock.release();
      }
      // Warmup: Spam-Ordner nach eigenen Warmup-Mails durchsuchen und in den Posteingang verschieben.
      const inPool = q.value("SELECT COUNT(*) FROM warmup WHERE to_mailbox_id = ? AND checked_at IS NULL", mb.id);
      if (inPool > 0) stats.rescued = await rescueWarmupFromSpam(client, mb).catch(() => 0);
    });
    state.lastResult = { ok: true, at: Date.now(), ...stats };
    return stats;
  } catch (err) {
    const message = err.authenticationFailed ? "IMAP-Anmeldung fehlgeschlagen" : (err.responseText || err.message || "IMAP-Fehler");
    q.run("UPDATE mailboxes SET sync_error = ?, last_sync_at = ? WHERE id = ?", String(message).slice(0, 300), Date.now(), mb.id);
    state.lastResult = { ok: false, at: Date.now(), error: message };
    return { error: message };
  } finally {
    state.running = false;
  }
}

async function rescueWarmupFromSpam(client, mb) {
  const spamPath = await findFolder(client, "\\Junk", SPAM_NAMES);
  if (!spamPath) return 0;
  const lock = await client.getMailboxLock(spamPath);
  let rescued = 0;
  try {
    const uids = (await client.search({ header: { [WARMUP_HEADER]: true } }, { uid: true })) || [];
    for (const uid of uids.slice(0, 50)) {
      const head = await client.fetchOne(String(uid), { uid: true, headers: [WARMUP_HEADER] }, { uid: true });
      const tokenMatch = head?.headers ? /x-coldmail-warmup:\s*(\S+)/i.exec(head.headers.toString("utf8")) : null;
      if (tokenMatch) {
        q.run("UPDATE warmup SET landed = 'spam', checked_at = ? WHERE token = ? AND to_mailbox_id = ?", Date.now(), tokenMatch[1], mb.id);
      }
      await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }).catch(() => {});
      // "Kein Spam"-Signal: zurück in den Posteingang verschieben.
      await client.messageMove(String(uid), "INBOX", { uid: true });
      rescued++;
    }
  } finally {
    lock.release();
  }
  return rescued;
}

export async function moveToFolder(client, uid, folder) {
  if (!folder) return false;
  try {
    await client.mailboxCreate(folder);
  } catch { /* existiert bereits */ }
  await client.messageMove(String(uid), folder, { uid: true });
  return true;
}
