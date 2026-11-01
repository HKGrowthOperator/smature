// API: Produkte mit Info-Kit, Termin-Link, Wissen (Info-Blätter), Mail-Vorlagen (freigebbar) und KI-Qualitätsprüfung der Leads.
import { q, tx, insert, update, parseJson } from "../db.js";
import { fail, v } from "../http.js";
import { distillKnowledge, generateSequence, qualifyLead, suggestEntryOffers, aiAvailable, FIT_LABELS, OFFER_TYPES } from "../ai/features.js";
import { registerDocRoutes, listDocs } from "./docs.js";
import { loadSteps } from "../mail/compose.js";
import { campaignFull } from "./campaigns.js";
import { LEGAL_BASES, nurtureTexts } from "../engine/rules.js";
import { startJob, getJob, cancelJob, listJobs } from "../engine/jobs.js";
import { projectId } from "../intel/projects.js";

const AI_MISSING = "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN für das Max-Abo fehlt).";

function url(value, name) {
  const s = v.str(value, { max: 1000, name });
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { fail(400, `${name}: keine gültige Adresse (mit https://)`); }
  if (!["http:", "https:"].includes(u.protocol)) fail(400, `${name}: nur http(s)-Links`);
  return u.toString();
}

function readNurture(raw) {
  const list = Array.isArray(raw) ? raw : parseJson(raw, []) || [];
  return JSON.stringify(list.slice(0, 5).map(t => ({ body: v.text(typeof t === "string" ? t : t?.body, { max: 5000, name: "Nachfass-Text" }) })).filter(t => t.body.trim()));
}

function readProduct(body, existing = {}) {
  const get = k => (body[k] !== undefined ? body[k] : existing[k]);
  return {
    name: v.str(get("name"), { max: 160, required: true, name: "Name" }),
    description: v.text(get("description") ?? "", { max: 5000 }),
    offer: v.text(get("offer") ?? "", { max: 5000 }),
    icp: v.text(get("icp") ?? "", { max: 5000 }),
    proof: v.text(get("proof") ?? "", { max: 5000 }),
    booking_url: url(get("booking_url"), "Termin-Link"),
    kit_url: url(get("kit_url"), "Info-Kit-Link"),
    kit_label: v.str(get("kit_label") ?? "", { max: 120 }),
    nurture_texts: readNurture(get("nurture_texts")),
    profile: v.text(get("profile") ?? "", { max: 60000 }),
    project_id: projectId(get("project_id"))
  };
}

function fitStats(productId) {
  const rows = q.all("SELECT fit, COUNT(*) AS n FROM lead_fit WHERE product_id = ? GROUP BY fit", productId);
  return Object.fromEntries(Object.keys(FIT_LABELS).map(k => [k, rows.find(r => r.fit === k)?.n || 0]));
}

function productFull(id) {
  const p = q.get("SELECT * FROM products WHERE id = ?", id);
  if (!p) return null;
  const templates = q.all("SELECT id FROM campaigns WHERE product_id = ? AND is_template = 1 ORDER BY name", id).map(t => campaignFull(t.id));
  const campaigns = q.all(`SELECT c.id, c.name, c.status, c.legal_basis, c.created_at, (SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = c.id) AS leads
    FROM campaigns c WHERE c.product_id = ? AND c.is_template = 0 ORDER BY c.created_at DESC`, id);
  return { ...p, nurture_texts: nurtureTexts(p), docs: listDocs("product_id", id), templates, campaigns, fit: fitStats(id) };
}

function stepsFromSequence(seq) {
  return (seq.steps || []).map((s, i) => ({
    delay_days: i === 0 ? 0 : s.delay_days,
    variants: [
      { subject: s.subject || "", body: s.body || "", enabled: true },
      ...(String(s.variant_b_body || "").trim() ? [{ subject: s.variant_b_subject || "", body: s.variant_b_body, enabled: true }] : [])
    ]
  }));
}

const LETTERS = "ABCDEFGH";
function writeSteps(campaignId, steps) {
  q.run("DELETE FROM campaign_steps WHERE campaign_id = ?", campaignId);
  steps.forEach((s, i) => insert("campaign_steps", {
    campaign_id: campaignId, position: i, delay_days: i === 0 ? 0 : Math.max(0, Math.min(90, Number(s.delay_days) || 0)),
    variants: JSON.stringify((s.variants || []).slice(0, LETTERS.length).map((x, j) => ({ key: LETTERS[j], subject: String(x.subject || "").slice(0, 300), body: String(x.body || "").slice(0, 20000), enabled: x.enabled !== false })))
  }));
}

function createTemplate(product, { name, targetGroupId = null, legalBasis = "consent", steps, nurture = [] }) {
  const now = Date.now();
  return tx(() => {
    const id = insert("campaigns", {
      name, target_group_id: targetGroupId, product_id: product.id, is_template: 1, legal_basis: legalBasis, status: "draft",
      mailbox_ids: "[]", nurture_texts: JSON.stringify(nurture.filter(t => String(t.body || "").trim())), created_at: now, updated_at: now
    });
    writeSteps(id, steps.length ? steps : [{ delay_days: 0, variants: [{ subject: "", body: "{{anrede}},\n\n\n\nViele Grüße" }] }]);
    return id;
  });
}

export function register(r) {
  r.get("/api/products", () => q.all(`SELECT p.*, (SELECT COUNT(*) FROM knowledge_docs WHERE product_id = p.id) AS doc_count,
    (SELECT COUNT(*) FROM campaigns WHERE product_id = p.id AND is_template = 1) AS template_count,
    (SELECT COUNT(*) FROM campaigns WHERE product_id = p.id AND is_template = 1 AND approved_hash IS NOT NULL) AS approved_template_count,
    (SELECT COUNT(*) FROM campaigns WHERE product_id = p.id AND is_template = 0) AS campaign_count FROM products p ORDER BY p.name`)
    .map(p => ({ ...p, nurture_texts: nurtureTexts(p), profile: undefined, has_profile: !!p.profile })));

  r.post("/api/products", ({ body }) => {
    const now = Date.now();
    const id = insert("products", { ...readProduct(body), created_at: now, updated_at: now });
    return productFull(id);
  });

  r.get("/api/products/:id", ({ params }) => productFull(v.id(params.id)) || fail(404, "Produkt nicht gefunden"));

  r.put("/api/products/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const existing = q.get("SELECT * FROM products WHERE id = ?", id) || fail(404, "Produkt nicht gefunden");
    update("products", id, { ...readProduct(body, existing), updated_at: Date.now() });
    return productFull(id);
  });

  r.delete("/api/products/:id", ({ params }) => {
    const id = v.id(params.id);
    tx(() => {
      q.run("DELETE FROM campaigns WHERE product_id = ? AND is_template = 1", id);
      q.run("DELETE FROM products WHERE id = ?", id);
    });
    return { ok: true };
  });

  registerDocRoutes(r, { base: "/api/products", table: "products", column: "product_id", label: "Produkt" });

  r.post("/api/products/:id/distill", async ({ params }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    const id = v.id(params.id);
    await distillKnowledge("product", id);
    return productFull(id);
  });

  // KI schreibt Sequenz + Nachfass-Texte; mit save=true direkt als (noch nicht freigegebene) Vorlage speichern.
  r.post("/api/products/:id/generate", async ({ params, body }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    const product = q.get("SELECT * FROM products WHERE id = ?", v.id(params.id)) || fail(404, "Produkt nicht gefunden");
    const targetGroupId = body.target_group_id ? v.id(body.target_group_id, "Zielgruppe") : null;
    const legalBasis = v.oneOf(body.legal_basis || "consent", Object.keys(LEGAL_BASES), "consent");
    const seq = await generateSequence({ productId: product.id, targetGroupId }, {
      steps: v.int(body.steps, { min: 1, max: 6, fallback: 3 }),
      goal: v.text(body.goal ?? "", { max: 2000 }),
      notes: v.text(body.notes ?? "", { max: 4000 }),
      legalBasis: legalBasis === "cold" ? "cold" : "consent",
      offerType: OFFER_TYPES[body.offer_type] ? body.offer_type : "",
      entryOffer: v.text(body.entry_offer ?? "", { max: 2000 })
    });
    if (!body.save) return seq;
    const name = v.str(body.name || seq.campaign_name || `${product.name} – Vorlage`, { max: 160 });
    const id = createTemplate(product, { name, targetGroupId, legalBasis, steps: stepsFromSequence(seq), nurture: seq.nurture || [] });
    return { ...seq, template: campaignFull(id) };
  });

  // KI schlägt Einstiegsangebote für die erste Mail vor (zum Übernehmen in den Vorlagen-Dialog).
  r.post("/api/products/:id/offer-ideas", async ({ params, body }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    const product = q.get("SELECT * FROM products WHERE id = ?", v.id(params.id)) || fail(404, "Produkt nicht gefunden");
    const offers = await suggestEntryOffers(product, { targetGroupId: body.target_group_id ? v.id(body.target_group_id, "Zielgruppe") : null, notes: v.text(body.notes ?? "", { max: 2000 }) });
    return { offers, types: OFFER_TYPES };
  });

  r.post("/api/products/:id/templates", ({ params, body }) => {
    const product = q.get("SELECT * FROM products WHERE id = ?", v.id(params.id)) || fail(404, "Produkt nicht gefunden");
    const id = createTemplate(product, {
      name: v.str(body.name || `${product.name} – Vorlage`, { max: 160, required: true, name: "Name" }),
      targetGroupId: body.target_group_id ? v.id(body.target_group_id, "Zielgruppe") : null,
      legalBasis: v.oneOf(body.legal_basis || "consent", Object.keys(LEGAL_BASES), "consent"),
      steps: Array.isArray(body.steps) ? body.steps : [],
      nurture: (Array.isArray(body.nurture_texts) ? body.nurture_texts : nurtureTexts(product)).map(t => ({ body: String(typeof t === "string" ? t : t?.body || "") }))
    });
    return campaignFull(id);
  });

  // Aus einer (freigegebenen) Vorlage eine Kampagne erstellen. Die Freigabe bleibt gültig, solange die Texte gleich bleiben.
  r.post("/api/products/:id/templates/:tid/campaign", ({ params, body }) => {
    const pid = v.id(params.id);
    const tpl = q.get("SELECT * FROM campaigns WHERE id = ? AND product_id = ? AND is_template = 1", v.id(params.tid), pid) || fail(404, "Vorlage nicht gefunden");
    const now = Date.now();
    const { id: _, status, launched_at, completed_at, created_at, updated_at, is_template, name, mailbox_ids, ...rest } = tpl;
    const boxes = Array.isArray(body.mailbox_ids) ? body.mailbox_ids.map(Number).filter(Number.isInteger) : q.all("SELECT id FROM mailboxes WHERE status = 'active'").map(m => m.id);
    const id = tx(() => {
      const newId = insert("campaigns", {
        ...rest, name: v.str(body.name || `${tpl.name} ${new Date().toLocaleDateString("de-DE")}`, { max: 160 }),
        is_template: 0, status: "draft", mailbox_ids: JSON.stringify(boxes), created_at: now, updated_at: now
      });
      writeSteps(newId, loadSteps(tpl.id).map(s => ({ delay_days: s.delay_days, variants: s.variants })));
      return newId;
    });
    return campaignFull(id);
  });

  // Qualitätsprüfung: KI bewertet Passung A–D und den konkreten Anlass – läuft im Hintergrund.
  r.post("/api/products/:id/qualify", ({ params, body }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    const product = q.get("SELECT * FROM products WHERE id = ?", v.id(params.id)) || fail(404, "Produkt nicht gefunden");
    let ids = Array.isArray(body.lead_ids) ? body.lead_ids.map(Number).filter(Number.isInteger) : [];
    if (body.list_id) ids = ids.concat(q.all("SELECT lead_id FROM lead_list_members WHERE list_id = ?", v.id(body.list_id)).map(r => r.lead_id));
    ids = [...new Set(ids)];
    if (body.only_unchecked !== false) {
      const checked = new Set(q.all("SELECT lead_id FROM lead_fit WHERE product_id = ?", product.id).map(r => r.lead_id));
      ids = ids.filter(id => !checked.has(id));
    }
    if (!ids.length) fail(400, "Keine (ungeprüften) Leads ausgewählt");
    if (ids.length > 2000) fail(400, "Maximal 2000 Leads pro Prüfung");
    return startJob("qualify", ids, async leadId => {
      const lead = q.get("SELECT * FROM leads WHERE id = ? AND status = 'active'", leadId);
      if (!lead) return "übersprungen";
      const current = q.get("SELECT * FROM products WHERE id = ?", product.id);
      if (!current) throw Object.assign(new Error("Produkt gelöscht"), { stopJob: true });
      return (await qualifyLead(lead, current)).fit;
    }, { label: `Qualität prüfen: ${product.name}` });
  });

  r.get("/api/jobs", () => listJobs());
  r.get("/api/jobs/:id", ({ params }) => getJob(params.id) || fail(404, "Auftrag nicht gefunden"));
  r.post("/api/jobs/:id/cancel", ({ params }) => cancelJob(params.id) || fail(404, "Auftrag nicht gefunden"));
}
