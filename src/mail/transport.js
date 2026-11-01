// SMTP-Versand über nodemailer. Nachrichten werden einmal als Rohdaten gebaut, damit dieselben Bytes versendet
// und (optional) im IMAP-Ordner "Gesendet" abgelegt werden.
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { config } from "../config.js";
import { decrypt } from "../crypto.js";

function heloName() {
  try { return new URL(config.appUrl).hostname || undefined; } catch { return undefined; }
}

export function smtpOptions(mb) {
  const secure = !!mb.smtp_secure;
  return {
    host: mb.smtp_host,
    port: Number(mb.smtp_port),
    secure,
    requireTLS: !secure && !config.allowInsecureTls,
    auth: { user: mb.smtp_user, pass: mb.smtp_pass_plain ?? decrypt(mb.smtp_pass) },
    name: heloName(),
    connectionTimeout: config.smtpTimeoutMs,
    greetingTimeout: Math.min(config.smtpTimeoutMs, 20000),
    socketTimeout: config.smtpTimeoutMs * 2,
    tls: { rejectUnauthorized: !config.allowInsecureTls, minVersion: "TLSv1.2" },
    disableFileAccess: true,
    disableUrlAccess: true
  };
}

let transportFactory = options => nodemailer.createTransport(options);
// Für Tests austauschbar.
export function setTransportFactory(fn) { transportFactory = fn || (options => nodemailer.createTransport(options)); }

export async function buildRaw(mail) {
  const composer = new MailComposer({ ...mail, disableFileAccess: true, disableUrlAccess: true });
  return composer.compile().build();
}

export async function sendRaw(mb, { from, to, raw }) {
  const transport = transportFactory(smtpOptions(mb));
  try {
    const info = await transport.sendMail({ envelope: { from, to: Array.isArray(to) ? to : [to] }, raw });
    return info;
  } finally {
    if (typeof transport.close === "function") transport.close();
  }
}

export async function verifySmtp(mb) {
  const transport = transportFactory(smtpOptions(mb));
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeSmtpError(err) };
  } finally {
    if (typeof transport.close === "function") transport.close();
  }
}

// Fehler in verständliche Kategorien einordnen – steuert Bounce-Markierung und Pausieren des Postfachs.
// err.command (nodemailer) unterscheidet Absender- (MAIL FROM) von Empfängerproblemen (RCPT TO).
const RECIPIENT_UNKNOWN = /user unknown|unknown user|no such user|does not exist|not exist|recipient.*(rejected|unknown|invalid)|mailbox (unavailable|not found)|invalid recipient|recipient address rejected|unbekannt|existiert nicht|undeliverable/i;
const SENDER_PROBLEM = /sender address rejected|not owned by user|bad sender|sender (verify|address|domain)|from address|envelope from|absender/i;
const RECIPIENT_FULL = /mailbox (is )?full|mailbox.*(over|exceeded).*quota|(user|recipient|account).*(over|exceeded).*quota|insufficient storage|postfach.*voll|speicherplatz/i;
const SENDER_QUOTA = /sending limit|sending quota|too many messages|daily.*limit|rate limit|limit exceeded|message limit|throttl|4\.7\.0.*limit|5\.4\.5/i;

export function classifySmtpError(err) {
  const code = err && err.code;
  const rc = Number(err && err.responseCode) || 0;
  const command = String((err && err.command) || "").toUpperCase();
  const text = String((err && (err.response || err.message)) || "");
  const enhanced = (/\b([245])\.(\d{1,3})\.(\d{1,3})\b/.exec(text) || []).slice(1).join(".");
  const atRcpt = command.startsWith("RCPT");
  const atMailFrom = command.startsWith("MAIL");
  if (code === "EAUTH" || rc === 535 || rc === 534 || rc === 530 || command.startsWith("AUTH")) return { type: "auth", permanent: true };
  // Postfach des Empfängers voll: Problem des Empfängers, nicht unseres Postfachs.
  if (/^[45]\.2\.2$/.test(enhanced) || RECIPIENT_FULL.test(text)) return { type: "recipient_temp", permanent: false };
  if (SENDER_QUOTA.test(text) && (rc >= 400 || code === "EENVELOPE" || code === "EMESSAGE")) return { type: "quota", permanent: false };
  if (rc >= 400 && (atMailFrom || /^5\.1\.[78]$/.test(enhanced) || SENDER_PROBLEM.test(text))) return { type: "sender", permanent: rc >= 500 };
  if (rc >= 500 && rc < 600) {
    if (!atMailFrom && (/^5\.1\.[0-6]$/.test(enhanced) || RECIPIENT_UNKNOWN.test(text) || rc === 551 || (rc === 553 && atRcpt))) {
      return { type: "recipient", permanent: true };
    }
    if (/^5\.7\./.test(enhanced) || /spam|blocked|blacklist|block list|reputation|policy|denied/i.test(text)) return { type: "policy", permanent: false };
    return code === "EENVELOPE" && atRcpt ? { type: "recipient", permanent: true } : { type: "message", permanent: true };
  }
  if (rc >= 400 && rc < 500) return atRcpt ? { type: "recipient_temp", permanent: false } : { type: "temporary", permanent: false };
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "EPROTOCOL", "ETLS"].includes(code)) return { type: "connection", permanent: false };
  return { type: "connection", permanent: false };
}

export function describeSmtpError(err) {
  const c = classifySmtpError(err);
  const raw = String((err && (err.response || err.message)) || "Unbekannter Fehler").slice(0, 300);
  const hint = {
    auth: "Anmeldung fehlgeschlagen – Benutzername/Passwort prüfen. Bei Google Workspace ein App-Passwort verwenden.",
    connection: "Verbindung zum Mailserver fehlgeschlagen – Host, Port und Verschlüsselung prüfen.",
    quota: "Versandlimit des Anbieters erreicht.",
    policy: "Der Empfängerserver lehnt ab (Richtlinie/Spamverdacht).",
    recipient: "Empfängeradresse existiert nicht.",
    recipient_temp: "Empfänger vorübergehend nicht erreichbar (z. B. Postfach voll) – wird später erneut versucht.",
    sender: "Der Mailserver lehnt die Absenderadresse ab – Postfach-Einstellungen (Absender, SPF/DKIM) prüfen.",
    temporary: "Vorübergehender Fehler – wird später erneut versucht.",
    message: "Nachricht wurde abgelehnt."
  }[c.type];
  return `${hint} (${raw})`;
}
