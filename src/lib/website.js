// Holt den Text der Lead-Website für die KI-Personalisierung. Schutz gegen SSRF: nur öffentliche IP-Adressen,
// DNS-Ergebnis wird für die Verbindung fest verwendet, max. 3 Weiterleitungen, Größen- und Zeitlimit.
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";
import net from "node:net";
import { q } from "../db.js";
import { config } from "../config.js";
import { htmlToText, decodeEntities, dropBlocks } from "./text.js";

const MAX_BYTES = 600 * 1024;
const MAX_PARSE = 200 * 1024;
const TIMEOUT_MS = 8000;
const TOTAL_TIMEOUT_MS = 12000;
const CACHE_MS = 21 * 24 * 60 * 60 * 1000;
const FAIL_CACHE_MS = 24 * 60 * 60 * 1000;

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  // IPv6 in die kanonische Kurzform bringen (z. B. „0:0:0:0:0:ffff:7f00:1“ → „::ffff:7f00:1“).
  let x = String(ip).toLowerCase();
  try { x = new URL(`http://[${x}]/`).hostname.slice(1, -1); } catch { return true; }
  if (x === "::" || x === "::1") return true;
  // IPv4-gemappt (auch in Hex-Form ::ffff:7f00:1) → eingebettete IPv4-Adresse prüfen.
  const mapped = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16);
    return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (x.startsWith("::ffff:")) return isPrivateIp(x.slice(7));
  // IPv4-kompatibel (::/96), NAT64, 6to4 und Teredo können auf interne IPv4-Adressen zeigen → sperren.
  if (/^::[0-9a-f]{1,4}(:[0-9a-f]{1,4})?$/.test(x) || x.startsWith("2002:") || x.startsWith("2001:0:") || x.startsWith("2001::")) return true;
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || x.startsWith("64:ff9b:") || x.startsWith("2001:db8");
}

async function resolvePublic(host) {
  if (net.isIP(host)) {
    if (isPrivateIp(host) && !config.allowPrivateFetch) throw new Error("Private Adresse");
    return { address: host, family: net.isIP(host) };
  }
  const records = await dns.lookup(host, { all: true });
  const ok = records.filter(r => config.allowPrivateFetch || !isPrivateIp(r.address));
  if (!ok.length) throw new Error("Keine öffentliche Adresse");
  return ok[0];
}

function request(url, pinned) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, {
      method: "GET",
      timeout: TIMEOUT_MS,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; SmatureColdmail/1.0)", "Accept": "text/html,application/xhtml+xml", "Accept-Language": "de,en;q=0.8" },
      lookup: (_host, opts, cb) => opts && opts.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, url) });
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const type = String(res.headers["content-type"] || "");
      if (type && !/text\/html|xhtml|text\/plain/i.test(type)) { res.resume(); return reject(new Error("Kein HTML")); }
      const chunks = []; let size = 0;
      res.on("data", c => { size += c.length; if (size > MAX_BYTES) { req.destroy(); resolve({ body: Buffer.concat(chunks).toString("utf8") }); } else chunks.push(c); });
      res.on("end", () => resolve({ body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    // Gesamtfrist pro Anfrage – auch bei Servern, die nur tröpfchenweise Daten senden.
    const hard = setTimeout(() => req.destroy(new Error("Zeitüberschreitung")), TIMEOUT_MS);
    hard.unref?.();
    req.on("close", () => clearTimeout(hard));
    req.on("timeout", () => req.destroy(new Error("Zeitüberschreitung")));
    req.on("error", reject);
    req.end();
  });
}

// Prüft eine Versand-Domain: Gibt es eine Website oder eine Weiterleitung (z. B. auf die Hauptdomain)?
export async function probeSite(domain) {
  for (const proto of ["https:", "http:"]) {
    try {
      const url = new URL(`${proto}//${domain}/`);
      const pinned = await resolvePublic(url.hostname);
      const res = await withDeadline(request(url, pinned), TIMEOUT_MS + 1000);
      if (res.redirect) return { reachable: true, redirect: res.redirect.toString(), page: false, url: url.toString() };
      return { reachable: true, redirect: null, page: !!String(res.body || "").trim(), url: url.toString() };
    } catch (err) {
      if (proto === "http:") return { reachable: false, redirect: null, page: false, error: err.message };
    }
  }
  return { reachable: false, redirect: null, page: false };
}

export function extractSiteText(rawHtml, limit = 4000) {
  const html = String(rawHtml || "").slice(0, MAX_PARSE);
  const lower = html.toLowerCase();
  const t1 = lower.indexOf("<title"), t2 = t1 >= 0 ? lower.indexOf("</title>", t1) : -1;
  const titleRaw = t1 >= 0 && t2 > t1 ? html.slice(html.indexOf(">", t1) + 1, t2) : "";
  const title = decodeEntities(titleRaw.replace(/<[^<>]*>/g, "")).trim().slice(0, 300);
  const desc = decodeEntities((/<meta[^<>]+name=["']description["'][^<>]*content=["']([^"'<>]*)["']/i.exec(html) || /<meta[^<>]+content=["']([^"'<>]*)["'][^<>]*name=["']description["']/i.exec(html) || [])[1] || "").trim();
  const body = htmlToText(dropBlocks(html, ["nav", "footer", "form"]));
  const text = [title && `Titel: ${title}`, desc && `Beschreibung: ${desc}`, body].filter(Boolean).join("\n");
  return text.slice(0, limit);
}

async function fetchRawChain(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const pinned = await resolvePublic(current.hostname);
    const res = await request(current, pinned);
    if (res.redirect) {
      if (!["http:", "https:"].includes(res.redirect.protocol)) return null;
      current = res.redirect;
      continue;
    }
    return { url: current.toString(), html: res.body };
  }
  return null;
}

async function fetchChain(url) {
  const page = await fetchRawChain(url);
  return page ? extractSiteText(page.html) : null;
}

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Zeitüberschreitung")), ms); timer.unref?.(); })
  ]).finally(() => clearTimeout(timer));
}

export function toUrl(raw) {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.port && !["80", "443"].includes(url.port) && !config.allowPrivateFetch) return null;
    return url;
  } catch {
    return null;
  }
}

// Eine Seite als HTML holen (SSRF-geschützt, ohne Cache) – für die Firmen-Recherche.
export async function fetchPage(rawUrl, { timeoutMs = TOTAL_TIMEOUT_MS } = {}) {
  const url = toUrl(rawUrl);
  if (!url) return null;
  try {
    return await withDeadline(fetchRawChain(url), timeoutMs);
  } catch {
    return null;
  }
}

// Interne Links einer Seite (gleiche Domain), mit Linktext – für die Auswahl von Impressum, Karriere, News …
export function extractLinks(rawHtml, baseUrl) {
  const html = String(rawHtml || "").slice(0, MAX_PARSE);
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const host = base.hostname.replace(/^www\./, "");
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^<>]*href=["']([^"'<>#]+)["'][^<>]*>([^<]{0,120})/gi)) {
    let u;
    try { u = new URL(decodeEntities(m[1]), base); } catch { continue; }
    if (!["http:", "https:"].includes(u.protocol) || u.hostname.replace(/^www\./, "") !== host) continue;
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4)$/i.test(u.pathname)) continue;
    u.hash = "";
    const key = u.toString();
    if (!out.has(key)) out.set(key, { url: key, text: decodeEntities(m[2]).replace(/\s+/g, " ").trim() });
  }
  return [...out.values()].slice(0, 300);
}

export async function fetchWebsiteText(rawUrl, { useCache = true } = {}) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (url.port && !["80", "443"].includes(url.port) && !config.allowPrivateFetch) return null;
  const host = url.hostname.toLowerCase();
  if (useCache) {
    const cached = q.get("SELECT text, fetched_at FROM website_cache WHERE host = ?", host);
    // Erfolgreiche Abrufe 21 Tage merken, Fehlschläge nur einen Tag (Server kann kurz weg gewesen sein).
    if (cached && cached.fetched_at > Date.now() - (cached.text ? CACHE_MS : FAIL_CACHE_MS)) return cached.text || null;
  }
  let text = null;
  let timer;
  try {
    text = await Promise.race([
      fetchChain(url),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Zeitüberschreitung")), TOTAL_TIMEOUT_MS); timer.unref?.(); })
    ]);
  } catch {
    text = null;
  } finally {
    clearTimeout(timer);
  }
  q.run("INSERT INTO website_cache (host, text, fetched_at) VALUES (?, ?, ?) ON CONFLICT(host) DO UPDATE SET text = excluded.text, fetched_at = excluded.fetched_at", host, text || "", Date.now());
  return text;
}
