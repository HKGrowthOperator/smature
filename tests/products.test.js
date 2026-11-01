// Produkte: Info-Kit, Termin-Link, Wissen, KI-Vorlagen mit Nachfass-Texten, Freigabe, Kampagne aus Vorlage, Qualitätsprüfung.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeMailbox, makeLead } from "./helpers.js";
import { createApp } from "../src/app.js";
import { ensureAdmin } from "../src/auth.js";
import { q } from "../src/db.js";
import { setAiClientFactory } from "../src/ai/claude.js";
import { saveSettings } from "../src/settings.js";
import { renderStep, loadSteps } from "../src/mail/compose.js";
import { ensurePersonalization } from "../src/ai/features.js";

let cleanup, server, base, api;
let responder = () => ({});
const prompts = [];

function fakeClient() {
  const respond = p => {
    prompts.push(p);
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(responder(p)) }], usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const stream = run => ({ finalMessage: async () => run() });
  return { messages: { stream: p => stream(() => respond(p)) }, beta: { messages: { stream: p => stream(() => respond(p)) } } };
}

before(async () => {
  cleanup = setupDb({ ADMIN_EMAIL: "admin@test.de", ADMIN_PASSWORD: "ein-langes-passwort" });
  ensureAdmin();
  setAiClientFactory(() => fakeClient());
  saveSettings({ footer_text: "Musterfirma UG · Datenschutz: {{privacy_url}}", privacy_url: "https://hk.example/datenschutz", booking_prefill: true });
  server = createApp();
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "admin@test.de", password: "ein-langes-passwort" }) });
  const session = { cookie: (res.headers.get("set-cookie") || "").split(";")[0], csrf: (await res.json()).csrf };
  api = async (path, { method = "GET", body } = {}) => {
    const r = await fetch(base + path, { method, headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, text };
  };
});
after(async () => { setAiClientFactory(null); await new Promise(r => server.close(r)); cleanup(); });

let productId, templateId;

test("Produkt anlegen: Links werden geprüft, Info-Blatt hochladen, Wissen verdichten", async () => {
  assert.equal((await api("/api/products", { method: "POST", body: { name: "Website-Paket", booking_url: "javascript:alert(1)" } })).status, 400);
  const created = await api("/api/products", { method: "POST", body: {
    name: "Website-Paket", description: "Moderne Website für Handwerksbetriebe in 14 Tagen", offer: "Mehr Anfragen über Google",
    icp: "Handwerk, 5–50 MA, DACH. Nicht: Konzerne, Agenturen", proof: "Dachbau Kremer: +40 % Anfragen in 3 Monaten",
    booking_url: "https://cal.example/website-erstgespraech", kit_url: "https://hk.example/website-kit.pdf", kit_label: "Website-Kit (PDF)",
    nurture_texts: [{ body: "{{anrede}},\n\nkurz nachgehakt: {{termin_link}}" }]
  } });
  assert.equal(created.status, 200, created.text);
  productId = created.json.id;
  assert.equal(created.json.nurture_texts.length, 1);
  const doc = await api(`/api/products/${productId}/docs`, { method: "POST", body: { title: "Leistungsblatt", kind: "text", content: "Pakete: Start, Pro. Laufzeit 12 Monate." } });
  assert.equal(doc.status, 200, doc.text);
  responder = () => ({ profile_markdown: "## Was das Produkt ist\n- Website in 14 Tagen", suggested_tone: "Sie", suggested_cta: "Erstgespräch" });
  const distilled = await api(`/api/products/${productId}/distill`, { method: "POST", body: {} });
  assert.equal(distilled.status, 200, distilled.text);
  assert.match(distilled.json.profile, /14 Tagen/);
  assert.match(JSON.stringify(prompts.at(-1).messages), /Laufzeit 12 Monate/);
  assert.equal((await api("/api/products")).json[0].doc_count, 1);
});

test("KI-Vorlage: Produktwissen, Termin-/Kit-Platzhalter, Nachfass-Texte; Kaltakquise max. 3 Mails ohne „Re:“", async () => {
  responder = p => {
    const sys = p.system.map(s => s.text).join("\n");
    assert.match(sys, /Produkt: Website-Paket/);
    assert.match(sys, /\{\{termin_link\}\}/);
    assert.match(sys, /Dachbau Kremer/);
    assert.match(sys, /kennen uns nicht/, "Szenario Kaltakquise");
    return {
      campaign_name: "Website Handwerk",
      steps: [
        { delay_days: 0, subject: "Re: kurze frage", body: "{{anrede}},\n\nMail 1", variant_b_subject: "AW: idee", variant_b_body: "{{anrede}},\n\nB" },
        { delay_days: 1, subject: "", body: "{{anrede}},\n\nHier das Kit: {{kit_link}}", variant_b_subject: "", variant_b_body: "" },
        { delay_days: 6, subject: "", body: "{{anrede}},\n\nTermin? {{termin_link}}", variant_b_subject: "", variant_b_body: "" },
        { delay_days: 6, subject: "", body: "zu viel", variant_b_subject: "", variant_b_body: "" }
      ],
      nurture: [{ body: "{{anrede}},\n\nnachgehakt {{termin_link}}" }, { body: "{{anrede}},\n\nletzte Nachfrage" }]
    };
  };
  const res = await api(`/api/products/${productId}/generate`, { method: "POST", body: { steps: 5, legal_basis: "cold", save: true, goal: "Erstgespräch" } });
  assert.equal(res.status, 200, res.text);
  const tpl = res.json.template;
  templateId = tpl.id;
  assert.equal(tpl.is_template, 1);
  assert.equal(tpl.legal_basis, "cold");
  assert.equal(tpl.steps.length, 3, "Kaltakquise: höchstens 3 Mails");
  assert.equal(tpl.steps[0].variants[0].subject, "kurze frage", "kein „Re:“ im ersten Betreff");
  assert.equal(tpl.steps[0].variants[1].subject, "idee");
  assert.equal(tpl.steps[1].delay_days, 4, "Kaltakquise: mind. 4 Tage Abstand");
  assert.equal(tpl.nurture_texts.length, 2);
  assert.equal(tpl.approval.approved, false, "KI-Texte sind nie automatisch freigegeben");
  assert.equal((await api("/api/campaigns")).json.some(c => c.id === templateId), false, "Vorlagen erscheinen nicht in der Kampagnenliste");
});

test("Vorlage prüfen, freigeben, Kampagne daraus erstellen – Freigabe bleibt, Vorschau löst Links auf", async () => {
  const mb = makeMailbox();
  const approve = await api(`/api/campaigns/${templateId}/approve`, { method: "POST", body: {} });
  assert.equal(approve.status, 200, approve.text);
  const camp = await api(`/api/products/${productId}/templates/${templateId}/campaign`, { method: "POST", body: { name: "Website Q4", mailbox_ids: [mb] } });
  assert.equal(camp.status, 200, camp.text);
  assert.equal(camp.json.is_template, 0);
  assert.equal(camp.json.approval.approved, true, "gleiche Texte → Freigabe gilt weiter");
  assert.equal(camp.json.product.name, "Website-Paket");
  const c = q.get("SELECT * FROM campaigns WHERE id = ?", camp.json.id);
  const lead = q.get("SELECT * FROM leads WHERE id = ?", makeLead({ email: "inhaber@dachdecker-test.de", first_name: "Jana", last_name: "Kraus", salutation: "Frau" }));
  const r3 = renderStep({ campaign: c, steps: loadSteps(c.id), stepIndex: 2, lead, mailbox: q.get("SELECT * FROM mailboxes WHERE id = ?", mb) });
  assert.match(r3.text, /Sehr geehrte Frau Kraus/);
  assert.match(r3.text, /https:\/\/cal\.example\/website-erstgespraech\?email=inhaber%40dachdecker-test\.de&name=Jana\+Kraus/, "Termin-Link mit Vorbelegung");
  const r2 = renderStep({ campaign: c, steps: loadSteps(c.id), stepIndex: 1, lead, mailbox: q.get("SELECT * FROM mailboxes WHERE id = ?", mb) });
  assert.match(r2.text, /https:\/\/hk\.example\/website-kit\.pdf/);
  assert.match(r2.text, /Datenschutz: https:\/\/hk\.example\/datenschutz/);
  const check = (await api(`/api/campaigns/${c.id}/check`)).json;
  assert.ok(check.errors.some(e => /Risiko/.test(e)), "Kaltakquise braucht die ausdrückliche Bestätigung");
  assert.equal((await api(`/api/campaigns/${c.id}/cold-ack`, { method: "POST", body: {} })).status, 400);
  const ack = await api(`/api/campaigns/${c.id}/cold-ack`, { method: "POST", body: { confirm: true } });
  assert.equal(ack.json.cold_ack_by, "Admin");
});

test("Qualitätsprüfung im Hintergrund und Filter: nur passende Firmen kommen in die Kaltakquise", async () => {
  const good = makeLead({ email: "chef@zimmerei-gut.de", consent_status: "none" });
  const bad = makeLead({ email: "info@konzern-gross.de", consent_status: "none" });
  const freemail = makeLead({ email: "handwerker.max@gmail.com", consent_status: "none" });
  responder = p => {
    const text = JSON.stringify(p.messages);
    if (/zimmerei-gut/.test(text)) return { fit: "A", reason: "Zimmerei mit 8 MA, Website von 2012." };
    return { fit: "D", reason: "Konzern – passt nicht." };
  };
  const job = await api(`/api/products/${productId}/qualify`, { method: "POST", body: { lead_ids: [good, bad] } });
  assert.equal(job.status, 200, job.text);
  let state;
  for (let i = 0; i < 50; i++) {
    state = (await api(`/api/jobs/${job.json.id}`)).json;
    if (state.status !== "running") break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(state.status, "done");
  assert.deepEqual(state.results, { A: 1, D: 1 });
  const list = await api(`/api/leads?product=${productId}&fit=AB`);
  assert.deepEqual(list.json.items.map(l => l.id), [good]);
  assert.equal(list.json.items[0].fit, "A");

  const camp = (await api("/api/campaigns")).json.find(c => c.name === "Website Q4");
  await api(`/api/campaigns/${camp.id}`, { method: "PUT", body: { min_fit: "B" } });
  const en = await api(`/api/campaigns/${camp.id}/leads`, { method: "POST", body: { lead_ids: [good, bad, freemail] } });
  assert.equal(en.json.added, 1);
  assert.equal(en.json.skipped, 2);
  assert.ok(Object.keys(en.json.reasons).some(r => /Passt nicht gut genug \(D\)/.test(r)));
  assert.ok(Object.keys(en.json.reasons).some(r => /Freemail/.test(r)));
});

test("KI-Personalisierung behält Termin- und Kit-Links bei", async () => {
  const c = q.get("SELECT * FROM campaigns WHERE name = 'Website Q4'");
  q.run("UPDATE campaigns SET ai_mode = 'full' WHERE id = ?", c.id);
  const cl = q.get("SELECT * FROM campaign_leads WHERE campaign_id = ?", c.id);
  const lead = q.get("SELECT * FROM leads WHERE id = ?", cl.lead_id);
  responder = p => {
    assert.match(p.messages[0].content, /\[\[TERMIN_LINK\]\]/, "Link wird als geschützter Platzhalter übergeben");
    return { subject: "", body: "Sehr geehrter Herr Müller,\n\nfür Ihre Zimmerei: kurzes Gespräch? [[TERMIN_LINK]]" };
  };
  const ai = await ensurePersonalization({ campaign: { ...c, ai_mode: "full" }, steps: loadSteps(c.id), cl, lead, mailbox: { email: "a@b.de", from_name: "Max" }, stepIndex: 2, variantKey: "A" });
  assert.equal(ai.steps[2].body, "Sehr geehrter Herr Müller,\n\nfür Ihre Zimmerei: kurzes Gespräch? {{termin_link}}");
  responder = () => ({ subject: "", body: "Text ohne Link" });
  const again = await ensurePersonalization({ campaign: { ...c, ai_mode: "full" }, steps: loadSteps(c.id), cl: { ...cl, ai: "{}" }, lead, mailbox: { email: "a@b.de" }, stepIndex: 2, variantKey: "A", force: true });
  assert.match(again.steps[2].body, /\{\{termin_link\}\}$/, "vergessener Link wird angehängt");
});
