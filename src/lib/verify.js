// E-Mail-Prüfung ohne Versand: Syntax, MX/A-Record, Wegwerf-Domains, Rollen-Adressen, Freemail.
import dns from "node:dns/promises";

const DISPOSABLE = new Set(`
10minutemail.com 10minutemail.de 20minutemail.com 33mail.com anonbox.net byom.de dispostable.com discard.email
dropmail.me emailondeck.com fakeinbox.com getairmail.com getnada.com guerrillamail.com guerrillamail.de guerrillamail.net
guerrillamail.org harakirimail.com inboxbear.com mailcatch.com maildrop.cc mailinator.com mailinator.net mailnesia.com
mailnull.com mailpoof.com mailsac.com mintemail.com mohmal.com moakt.com mytemp.email nada.email nwytg.net sharklasers.com
spam4.me spambog.com spamgourmet.com spamex.com temp-mail.org temp-mail.io tempail.com tempmail.com tempmail.de tempmailo.com
tempr.email throwawaymail.com trashmail.com trashmail.de trashmail.net wegwerfmail.de wegwerfmail.net wegwerfmail.org
yopmail.com yopmail.fr yopmail.net emailfake.com einrot.com sofort-mail.de spoofmail.de trash-mail.com mailtemp.info
burnermail.io 1secmail.com 1secmail.net 1secmail.org tmpmail.org tmpmail.net mail.tm emailnator.com
`.split(/\s+/).filter(Boolean));

const ROLE = new Set(`
info kontakt contact office mail email hello hallo hi support service kundenservice sales vertrieb verkauf admin administrator
buchhaltung rechnung rechnungen billing accounting invoice noreply no-reply donotreply postmaster webmaster hostmaster abuse
team jobs job karriere career careers bewerbung bewerbungen hr personal presse press marketing newsletter datenschutz privacy
legal zentrale empfang reception anfrage anfragen order bestellung shop
`.split(/\s+/).filter(Boolean));

export const FREEMAIL = new Set(`
gmail.com googlemail.com outlook.com outlook.de hotmail.com hotmail.de live.com live.de msn.com yahoo.com yahoo.de ymail.com
icloud.com me.com mac.com aol.com aol.de gmx.de gmx.net gmx.at gmx.ch gmx.com web.de t-online.de freenet.de posteo.de mailbox.org
arcor.de online.de 1und1.de vodafone.de proton.me protonmail.com tutanota.com tutanota.de tuta.io zoho.com
`.split(/\s+/).filter(Boolean));

const EMAIL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

export function normalizeEmail(email) {
  return String(email || "").trim().replace(/^mailto:/i, "").replace(/[<>]/g, "").toLowerCase();
}

export function syntaxValid(email) {
  const e = normalizeEmail(email);
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) return false;
  const [local, domain] = e.split("@");
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  const tld = domain.split(".").pop();
  return /^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(tld);
}

export const domainOf = email => normalizeEmail(email).split("@")[1] || "";
export const isFreemail = email => FREEMAIL.has(domainOf(email));
export const isRole = email => ROLE.has(normalizeEmail(email).split("@")[0]);

const mxCache = new Map();
const MX_TTL = 6 * 60 * 60 * 1000;

export async function domainAcceptsMail(domain, resolver = dns) {
  const cached = mxCache.get(domain);
  if (cached && cached.at > Date.now() - MX_TTL) return cached.result;
  let result;
  try {
    const mx = await resolver.resolveMx(domain);
    const real = mx.filter(r => r.exchange && r.exchange !== ".");
    if (mx.length && !real.length) result = { ok: false, reason: "Domain nimmt keine E-Mails an (Null-MX)" };
    else if (real.length) result = { ok: true, mx: real.sort((a, b) => a.priority - b.priority).map(r => r.exchange) };
  } catch (err) {
    if (!["ENODATA", "ENOTFOUND", "ENOENT"].includes(err.code)) {
      return { ok: null, reason: `DNS-Fehler (${err.code || err.message})` };
    }
  }
  if (!result) {
    try {
      const a = await resolver.resolve4(domain);
      result = a.length ? { ok: true, mx: [domain], implicit: true } : { ok: false, reason: "Kein MX-Eintrag" };
    } catch {
      result = { ok: false, reason: "Domain existiert nicht oder hat keinen Mailserver" };
    }
  }
  mxCache.set(domain, { at: Date.now(), result });
  return result;
}

// Ergebnis: valid | risky | invalid | unknown
export async function verifyEmail(email, resolver) {
  const e = normalizeEmail(email);
  if (!syntaxValid(e)) return { status: "invalid", reason: "Ungültiges Format" };
  const domain = domainOf(e);
  if (DISPOSABLE.has(domain)) return { status: "invalid", reason: "Wegwerf-Adresse" };
  const mx = await domainAcceptsMail(domain, resolver);
  if (mx.ok === false) return { status: "invalid", reason: mx.reason };
  if (mx.ok === null) return { status: "unknown", reason: mx.reason };
  if (isRole(e)) return { status: "risky", reason: "Rollen-Adresse (z. B. info@) – geringere Antwortquote" };
  if (isFreemail(e)) return { status: "valid", reason: "Freemail-Adresse" };
  return { status: "valid", reason: mx.implicit ? "Kein MX, aber A-Record vorhanden" : "" };
}

export function clearMxCache() { mxCache.clear(); }
