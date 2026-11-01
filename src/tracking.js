// Öffentliche Endpunkte: Öffnungs-Pixel, Klick-Weiterleitung, Abmelden (inkl. RFC-8058-One-Click).
import { q } from "./db.js";
import { hmac, safeEqual } from "./crypto.js";
import { recordEvent } from "./events.js";
import { markUnsubscribed } from "./mail/inbound.js";
import { escapeHtml } from "./lib/text.js";
import { getSettings } from "./settings.js";
import { readBody } from "./http.js";

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const BOT_UA = /(googleimageproxy|bot|crawler|spider|preview|scanner|barracuda|proofpoint|mimecast|symantec|microsoft office|outlook-ios-linkpreview|slackbot|python-requests|curl|wget)/i;

function messageByToken(token) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
  return q.get("SELECT * FROM messages WHERE token = ?", token);
}

export function handleOpen(req, res, token) {
  const msg = messageByToken(token);
  res.writeHead(200, { "Content-Type": "image/gif", "Content-Length": PIXEL.length, "Cache-Control": "no-store, no-cache, must-revalidate, private", "Pragma": "no-cache" });
  res.end(PIXEL);
  if (!msg) return;
  const ua = String(req.headers["user-agent"] || "");
  // Sicherheits-Scanner öffnen Mails oft Sekunden nach Versand – das zählt nicht als Öffnung.
  if (Date.now() - msg.created_at < 8000 || (BOT_UA.test(ua) && !/googleimageproxy/i.test(ua))) return;
  q.run("UPDATE messages SET opens = opens + 1, first_open_at = COALESCE(first_open_at, ?) WHERE id = ?", Date.now(), msg.id);
  if (!msg.first_open_at) recordEvent("open", { campaign_id: msg.campaign_id, lead_id: msg.lead_id, mailbox_id: msg.mailbox_id, message_id: msg.id, step: msg.step, variant: msg.variant });
}

export function handleClick(req, res, token, url) {
  const target = String(url || "");
  const valid = /^https?:\/\//i.test(target) && safeEqual(String(new URL(req.url, "http://x").searchParams.get("s") || ""), hmac(`${token}|${target}`, "click"));
  if (!valid) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Ungültiger Link");
  }
  res.writeHead(302, { Location: target, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  res.end();
  const msg = messageByToken(token);
  if (!msg) return;
  const ua = String(req.headers["user-agent"] || "");
  if (Date.now() - msg.created_at < 8000 || BOT_UA.test(ua)) return;
  q.run("UPDATE messages SET clicks = clicks + 1, first_click_at = COALESCE(first_click_at, ?) WHERE id = ?", Date.now(), msg.id);
  if (!msg.first_click_at) {
    recordEvent("click", { campaign_id: msg.campaign_id, lead_id: msg.lead_id, mailbox_id: msg.mailbox_id, message_id: msg.id, step: msg.step, variant: msg.variant, data: { url: target.slice(0, 500) } });
  }
}

function page(title, body) {
  const s = getSettings();
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/public.css"></head><body><main class="card"><h1>${escapeHtml(title)}</h1>${body}
<p class="small">${escapeHtml(s.company_name || "")}${s.privacy_url ? ` · <a href="${escapeHtml(s.privacy_url)}">Datenschutz</a>` : ""}</p></main></body></html>`;
}

export async function handleUnsubscribe(req, res, token) {
  const msg = messageByToken(token);
  const lead = msg?.lead_id ? q.get("SELECT * FROM leads WHERE id = ?", msg.lead_id) : null;
  const html = (status, title, body) => {
    const out = page(title, body);
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
    res.end(out);
  };
  if (req.method === "POST") {
    // One-Click (RFC 8058): Body "List-Unsubscribe=One-Click" – oder Formular-Bestätigung.
    await readBody(req, 4096).catch(() => Buffer.alloc(0));
    if (lead) markUnsubscribed(lead.id, { source: "link", campaignId: msg.campaign_id });
    return html(200, "Abgemeldet", `<p>Sie erhalten von uns keine weiteren E-Mails${lead ? ` an <strong>${escapeHtml(lead.email)}</strong>` : ""}.</p><p>Entschuldigen Sie die Störung.</p>`);
  }
  if (!lead) return html(404, "Link ungültig", "<p>Dieser Abmelde-Link ist nicht (mehr) gültig. Antworten Sie einfach auf die E-Mail mit „Abmelden“ – wir tragen Sie sofort aus.</p>");
  if (lead.status === "unsubscribed") return html(200, "Bereits abgemeldet", `<p><strong>${escapeHtml(lead.email)}</strong> erhält keine weiteren E-Mails von uns.</p>`);
  return html(200, "Von E-Mails abmelden", `<p>Möchten Sie keine weiteren E-Mails an <strong>${escapeHtml(lead.email)}</strong> erhalten?</p>
<form method="post" action="/u/${escapeHtml(token)}"><button type="submit">Ja, abmelden</button></form>`);
}
