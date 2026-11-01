// Baut aus Kampagnen-Schritt + Lead die konkrete E-Mail (Betreff, Text, optional HTML mit Tracking, Header).
import crypto from "node:crypto";
import { q, parseJson } from "../db.js";
import { config } from "../config.js";
import { hmac } from "../crypto.js";
import { buildVars, render, productVars } from "../lib/template.js";
import { textToHtml, escapeHtml } from "../lib/text.js";
import { getSettings } from "../settings.js";

export function loadSteps(campaignId) {
  return q.all("SELECT * FROM campaign_steps WHERE campaign_id = ? ORDER BY position, id", campaignId).map(s => ({
    ...s,
    variants: parseJson(s.variants, []).filter(v => v && typeof v === "object")
  }));
}

export function enabledVariants(step) {
  const list = (step?.variants || []).filter(v => v.enabled !== false && (String(v.body || "").trim() || String(v.subject || "").trim()));
  return list.length ? list : (step?.variants || []).slice(0, 1);
}

export function chooseVariant(step, rnd = Math.random) {
  const list = enabledVariants(step);
  if (!list.length) return null;
  return list[Math.floor(rnd() * list.length)].key;
}

export function newMessageId(email) {
  const domain = String(email || "").split("@")[1] || "localhost";
  return `<${crypto.randomBytes(12).toString("hex")}.${Date.now().toString(36)}@${domain}>`;
}

export const unsubscribeUrl = token => `${config.trackingUrl}/u/${token}`;
export const openPixelUrl = token => `${config.trackingUrl}/t/o/${token}.gif`;
export const clickUrl = (token, url) => `${config.trackingUrl}/t/c/${token}?u=${encodeURIComponent(url)}&s=${hmac(`${token}|${url}`, "click")}`;

export function campaignProduct(campaign) {
  return campaign?.product_id ? q.get("SELECT * FROM products WHERE id = ?", campaign.product_id) : null;
}

export function targetLanguage(campaign) {
  if (!campaign?.target_group_id) return "de";
  return q.value("SELECT language FROM target_groups WHERE id = ?", campaign.target_group_id) || "de";
}

// Rendert einen Schritt für einen Lead. Ergebnis wird für Vorschau und Versand identisch erzeugt (deterministische Spintax).
// freshThread: Folge-Mail von einem anderen Postfach – dann als neue Mail (ohne „Re:“) statt als Antwort.
export function renderStep({ campaign, steps, stepIndex, variantKey, lead, mailbox, cl = null, token = null, settings = getSettings(), freshThread = false }) {
  const step = steps[stepIndex];
  if (!step) throw new Error("Schritt existiert nicht");
  const variants = enabledVariants(step);
  const variant = variants.find(v => v.key === variantKey) || variants[0];
  if (!variant) throw new Error(`Schritt ${stepIndex + 1} hat keinen Inhalt`);
  const language = targetLanguage(campaign);
  const ai = parseJson(cl?.ai, {}) || {};
  let subjectTpl = String(variant.subject || "");
  let bodyTpl = String(variant.body || "");
  const aiStep = campaign.ai_mode === "full" ? ai.steps?.[stepIndex] : null;
  if (aiStep && aiStep.body) {
    bodyTpl = aiStep.body;
    if (stepIndex === 0 || subjectTpl.trim()) subjectTpl = aiStep.subject || subjectTpl;
  }
  const unsub = unsubscribeUrl(token || "vorschau");
  const vars = buildVars({ lead, mailbox, ai, extra: { unsubscribe_url: unsub, privacy_url: settings.privacy_url, ...productVars(campaignProduct(campaign), lead, settings) }, language });
  const seed = `${cl?.id ?? `lead${lead.id}`}:${stepIndex}:${variant.key}`;
  const subj = render(subjectTpl, vars, `${seed}:s`);
  const body = render(bodyTpl, vars, `${seed}:b`);
  const missing = new Set([...subj.missing, ...body.missing]);

  const threadReply = stepIndex > 0 && !subj.text.trim();
  let subject = subj.text.trim();
  if (threadReply) {
    let base = cl?.thread_subject;
    if (!base) {
      // Vorschau ohne bisherigen Versand: Betreff von Schritt 1 rendern.
      const first = enabledVariants(steps[0])[0];
      base = first ? render(first.subject, vars, `${cl?.id ?? `lead${lead.id}`}:0:${first.key}:s`).text.trim() : "";
    }
    subject = freshThread ? base.replace(/^\s*((re|aw)\s*:\s*)+/i, "") : (/^(re|aw):/i.test(base) ? base : `Re: ${base}`);
  }

  // Eine leere Variable (z. B. KI-Einstiegssatz ohne Beleg) darf keine doppelte Leerzeile hinterlassen.
  const parts = [body.text.replace(/\n{3,}/g, "\n\n").trim()];
  if (mailbox?.signature) parts.push(render(mailbox.signature, vars).text.trim());
  if (campaign.unsubscribe && !/unsubscribe_url/.test(bodyTpl) && settings.unsubscribe_text) parts.push(render(settings.unsubscribe_text, vars).text.trim());
  if (settings.footer_text) parts.push(render(settings.footer_text, vars).text.trim());
  const text = parts.filter(Boolean).join("\n\n");
  return { subject, text, missing: [...missing], threadReply, variant: variant.key, aiUsed: !!aiStep, fall: vars.fall };
}

export function composeMail({ mailbox, lead, subject, text, token, messageId, inReplyTo, references, trackOpens = false, trackClicks = false, listUnsubscribe = true, extraHeaders = {} }) {
  const headers = { ...extraHeaders };
  if (listUnsubscribe && token) {
    headers["List-Unsubscribe"] = `<${unsubscribeUrl(token)}>, <mailto:${mailbox.email}?subject=Abmelden>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const mail = {
    from: { name: mailbox.from_name || "", address: mailbox.email },
    to: lead.first_name || lead.last_name ? { name: [lead.first_name, lead.last_name].filter(Boolean).join(" "), address: lead.email } : lead.email,
    subject,
    text,
    messageId,
    date: new Date(),
    headers
  };
  if (mailbox.reply_to) mail.replyTo = mailbox.reply_to;
  if (inReplyTo) mail.inReplyTo = inReplyTo;
  if (references) mail.references = references;
  if (token && (trackOpens || trackClicks)) {
    let html = textToHtml(text, url => (trackClicks && !url.startsWith(`${config.trackingUrl}/u/`) ? clickUrl(token, url) : url));
    if (trackOpens) html = html.replace("</body>", `<img src="${escapeHtml(openPixelUrl(token))}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0"></body>`);
    mail.html = html;
  }
  return mail;
}
