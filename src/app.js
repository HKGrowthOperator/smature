// HTTP-Anwendung: öffentliche Tracking-/Abmelde-Endpunkte, API mit Login + CSRF, Single-Page-App aus public/.
import http from "node:http";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { Router, HttpError, sendJson, sendText, readJson, securityHeaders, serveStatic, rateLimiter, clientIp } from "./http.js";
import { login, logout, authenticate, checkCsrf, sessionCookie, clearCookie, publicUser } from "./auth.js";
import { handleOpen, handleClick, handleUnsubscribe } from "./tracking.js";
import { AiError } from "./ai/claude.js";
import * as mailboxes from "./api/mailboxes.js";
import * as leads from "./api/leads.js";
import * as targetGroups from "./api/targetGroups.js";
import * as campaigns from "./api/campaigns.js";
import * as unibox from "./api/unibox.js";
import * as system from "./api/system.js";
import * as products from "./api/products.js";
import * as tasks from "./api/tasks.js";
import * as projects from "./api/projects.js";
import * as accounts from "./api/accounts.js";
import * as pipeline from "./api/pipeline.js";
import * as setup from "./api/setup.js";
import * as sourcing from "./api/sourcing.js";
import { backfillAccounts } from "./intel/accounts.js";
import { ensureBookingSecret } from "./api/system.js";
import { handleBooking } from "./engine/followup.js";
import { getSettings } from "./settings.js";
import { safeEqual } from "./crypto.js";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const BIG_BODY = new Set(["/api/leads/import", "/api/leads/import/preview"]);

export function createApp() {
  const router = new Router();
  for (const mod of [mailboxes, leads, targetGroups, products, campaigns, unibox, tasks, projects, accounts, pipeline, setup, sourcing, system]) mod.register(router);
  const loginLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
  const hookLimiter = rateLimiter({ windowMs: 60 * 1000, max: 60 });
  ensureBookingSecret();
  // Bestehende Leads (z. B. aus der Zeit vor den Firmen-Profilen) ihren Firmen zuordnen.
  try { backfillAccounts(); } catch (err) { console.error("[accounts] Zuordnung fehlgeschlagen", err); }

  // Buchungs-Webhook (Calendly, Cal.com, Sales App …): Termin gebucht → Lead stoppen, Ereignis + Webhook.
  async function bookingHook(req, res, secret) {
    if (!hookLimiter.hit(clientIp(req))) throw new HttpError(429, "Zu viele Anfragen");
    const expected = getSettings().booking_hook_secret;
    if (!expected || !safeEqual(secret, expected)) throw new HttpError(404, "Nicht gefunden");
    if (req.method === "GET") return sendJson(res, 200, { ok: true });
    const body = await readJson(req, 256 * 1024);
    return sendJson(res, 200, handleBooking(body));
  }
  let indexHtml = null;

  async function api(req, res, url) {
    const path = url.pathname;
    if (path === "/api/auth/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (!loginLimiter.hit(ip)) throw new HttpError(429, "Zu viele Anmeldeversuche. Bitte 15 Minuten warten.");
      const body = await readJson(req, 10 * 1024);
      const result = login(body.email, body.password);
      if (!result) throw new HttpError(401, "E-Mail oder Passwort falsch");
      loginLimiter.reset(ip);
      res.setHeader("Set-Cookie", sessionCookie(result.session));
      return sendJson(res, 200, { user: publicUser(result.user), csrf: result.session.csrf });
    }
    const auth = authenticate(req);
    if (path === "/api/auth/logout" && req.method === "POST") {
      if (auth) { checkCsrf(req, auth.session); logout(auth.session.id); }
      res.setHeader("Set-Cookie", clearCookie());
      return sendJson(res, 200, { ok: true });
    }
    if (!auth) throw new HttpError(401, "Bitte anmelden");
    if (path === "/api/me" && req.method === "GET") return sendJson(res, 200, { user: publicUser(auth.user), csrf: auth.session.csrf });

    const match = router.match(req.method, path);
    if (!match) throw new HttpError(404, "Nicht gefunden");
    if (match.methodNotAllowed) throw new HttpError(405, "Methode nicht erlaubt");
    if (req.method !== "GET" && req.method !== "HEAD") checkCsrf(req, auth.session);
    const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readJson(req, BIG_BODY.has(path) || /\/docs$/.test(path) ? 40 * 1024 * 1024 : 4 * 1024 * 1024) : {};
    let rawResponse = null;
    const ctx = { req, res, params: match.params, query: url.searchParams, body, user: auth.user, session: auth.session, raw: r => { rawResponse = r; } };
    const result = await match.route.handler(ctx);
    if (rawResponse) {
      const data = Buffer.isBuffer(rawResponse.body) ? rawResponse.body : Buffer.from(String(rawResponse.body));
      res.writeHead(rawResponse.status || 200, { "Content-Type": rawResponse.type, "Content-Length": data.length, "Cache-Control": "no-store", ...(rawResponse.headers || {}) });
      return res.end(data);
    }
    return sendJson(res, 200, result === undefined ? { ok: true } : result);
  }

  return http.createServer(async (req, res) => {
    securityHeaders(res);
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return sendText(res, 400, "Bad Request");
    }
    const path = url.pathname;
    try {
      if (path === "/healthz") return sendJson(res, 200, { ok: true });
      let m;
      if (req.method === "GET" && (m = /^\/t\/o\/([A-Za-z0-9_-]{8,64})\.gif$/.exec(path))) return handleOpen(req, res, m[1]);
      if (req.method === "GET" && (m = /^\/t\/c\/([A-Za-z0-9_-]{8,64})$/.exec(path))) return handleClick(req, res, m[1], url.searchParams.get("u"));
      if ((req.method === "GET" || req.method === "POST") && (m = /^\/u\/([A-Za-z0-9_-]{4,64})$/.exec(path))) return await handleUnsubscribe(req, res, m[1]);
      if ((req.method === "POST" || req.method === "GET") && (m = /^\/hooks\/booking\/([A-Za-z0-9_-]{16,64})$/.exec(path))) return await bookingHook(req, res, m[1]);
      if (path.startsWith("/api/")) return await api(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method Not Allowed");
      if (path === "/robots.txt") return sendText(res, 200, "User-agent: *\nDisallow: /\n");
      if (await serveStatic(res, PUBLIC_DIR, path === "/" ? "/index.html" : path)) return;
      if (!extname(path)) {
        indexHtml = indexHtml || await readFile(join(PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
        return res.end(indexHtml);
      }
      return sendText(res, 404, "Nicht gefunden");
    } catch (err) {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message, details: err.details });
      if (err instanceof AiError) return sendJson(res, 502, { error: err.message });
      console.error(`[http] ${req.method} ${path}`, err);
      return sendJson(res, 500, { error: "Interner Fehler" });
    }
  });
}
