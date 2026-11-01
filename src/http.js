// Kleiner Router + Hilfen für Anfragen/Antworten. Keine Framework-Abhängigkeit.
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, sep } from "node:path";
import { config } from "./config.js";

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
export const fail = (status, message, details) => { throw new HttpError(status, message, details); };

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, options = {}) {
    const keys = [];
    const regex = new RegExp("^" + pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; }) + "/?$");
    this.routes.push({ method, regex, keys, handler, options });
    return this;
  }
  get(p, h, o) { return this.add("GET", p, h, o); }
  post(p, h, o) { return this.add("POST", p, h, o); }
  put(p, h, o) { return this.add("PUT", p, h, o); }
  patch(p, h, o) { return this.add("PATCH", p, h, o); }
  delete(p, h, o) { return this.add("DELETE", p, h, o); }
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      } catch {
        throw new HttpError(400, "Ungültige Adresse");
      }
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export function clientIp(req) {
  if (config.trustProxy) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || "unknown";
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    // Kaputte Cookies anderer Apps derselben Domain (z. B. „100%“) dürfen die Anmeldung nicht lahmlegen.
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

export function cookie(name, value, { maxAge, httpOnly = true, sameSite = "Lax", path = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  if (config.cookieSecure) parts.push("Secure");
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge / 1000)}`);
  return parts.join("; ");
}

export async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Anfrage zu groß");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 2 * 1024 * 1024) {
  const type = String(req.headers["content-type"] || "");
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  if (!type.includes("application/json")) throw new HttpError(415, "Erwartet application/json");
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object") throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, "Ungültiges JSON");
  }
}

export function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
  res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (config.cookieSecure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}

export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function sendText(res, status, text, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".json": "application/json"
};

// Statische Dateien aus public/ – mit Pfadprüfung gegen Directory Traversal.
export async function serveStatic(res, root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return false; }
  const clean = normalize(decoded).replace(/^([/\\])+/, "");
  const file = join(root, clean);
  if (!file.startsWith(root + sep) && file !== root) return false;
  const type = TYPES[extname(file)];
  if (!type) return false;
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    const data = await readFile(file);
    const cache = extname(file) === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache";
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length, "Cache-Control": cache });
    res.end(data);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// Einfaches Rate-Limit pro Schlüssel (z. B. IP) im Speicher.
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      const entry = hits.get(key);
      if (!entry || entry.reset < now) {
        hits.set(key, { count: 1, reset: now + windowMs });
        if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
        return true;
      }
      entry.count++;
      return entry.count <= max;
    },
    reset(key) { hits.delete(key); }
  };
}

// Helfer zum Validieren von Eingaben.
export const v = {
  str(value, { max = 1000, required = false, name = "Feld" } = {}) {
    const s = value === undefined || value === null ? "" : String(value).trim();
    if (required && !s) fail(400, `${name} fehlt`);
    if (s.length > max) fail(400, `${name} ist zu lang (max. ${max} Zeichen)`);
    return s;
  },
  text(value, { max = 100000, name = "Feld" } = {}) {
    const s = value === undefined || value === null ? "" : String(value);
    if (s.length > max) fail(400, `${name} ist zu lang`);
    return s;
  },
  int(value, { min = -Infinity, max = Infinity, fallback, name = "Zahl" } = {}) {
    if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) fail(400, `${name} ist keine Zahl`);
    return Math.min(max, Math.max(min, Math.round(n)));
  },
  num(value, { min = -Infinity, max = Infinity, fallback, name = "Zahl" } = {}) {
    if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) fail(400, `${name} ist keine Zahl`);
    return Math.min(max, Math.max(min, n));
  },
  bool(value, fallback = false) {
    if (value === undefined || value === null) return fallback ? 1 : 0;
    return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
  },
  oneOf(value, options, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    if (!options.includes(value)) fail(400, `Ungültiger Wert: ${value}`);
    return value;
  },
  email(value, { required = true, name = "E-Mail" } = {}) {
    const s = String(value || "").trim().toLowerCase();
    if (!s && !required) return "";
    if (!/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/.test(s) || s.length > 254) fail(400, `${name} ist ungültig`);
    return s;
  },
  id(value, name = "ID") {
    const n = Number(value);
    if (!Number.isInteger(n) || n <= 0) fail(400, `${name} ist ungültig`);
    return n;
  }
};
