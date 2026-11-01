// Ereignisse (für Statistik) und signierte Webhooks an CRM / Sales App / n8n / Make / Zapier.
import crypto from "node:crypto";
import { q, insert } from "./db.js";
import { getSettings } from "./settings.js";

export function recordEvent(type, { campaign_id = null, lead_id = null, mailbox_id = null, message_id = null, step = null, variant = null, data = null } = {}) {
  return insert("events", { type, campaign_id, lead_id, mailbox_id, message_id, step, variant, data: data ? JSON.stringify(data) : null, created_at: Date.now() });
}

const queue = [];
let flushing = false;
let fetchImpl = (...args) => fetch(...args);
export function setWebhookFetch(fn) { fetchImpl = fn || ((...args) => fetch(...args)); }

export function signPayload(body, secret) {
  return "sha256=" + crypto.createHmac("sha256", secret || "").update(body).digest("hex");
}

export function emitWebhook(event, data, { force = false } = {}) {
  const s = getSettings();
  if (!s.webhook_url) return false;
  if (!force && Array.isArray(s.webhook_events) && !s.webhook_events.includes(event)) return false;
  queue.push({ event, data, attempts: 0, url: s.webhook_url, secret: s.webhook_secret });
  flush();
  return true;
}

async function deliver(job) {
  const body = JSON.stringify({ event: job.event, sentAt: new Date().toISOString(), source: "hk-coldmail", data: job.data });
  const res = await fetchImpl(job.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Smature-Coldmail-Webhook/1.0", "X-Coldmail-Event": job.event, "X-Coldmail-Signature": signPayload(body, job.secret) },
    body,
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status;
}

async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await deliver(job);
      } catch (err) {
        job.attempts++;
        if (job.attempts < 3) setTimeout(() => { queue.push(job); flush(); }, job.attempts * 30000).unref();
        else console.warn(`[webhook] ${job.event} nicht zugestellt: ${err.message}`);
      }
    }
  } finally {
    flushing = false;
  }
}

export async function testWebhook() {
  const s = getSettings();
  if (!s.webhook_url) return { ok: false, error: "Keine Webhook-URL hinterlegt" };
  try {
    const status = await deliver({ event: "test", data: { message: "Testereignis aus Smature Coldmail" }, url: s.webhook_url, secret: s.webhook_secret });
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export function leadPayload(leadId) {
  const lead = q.get("SELECT id, email, salutation, first_name, last_name, company, position, website, phone, city, industry, status FROM leads WHERE id = ?", leadId);
  return lead || { id: leadId };
}
