// Firmen (Accounts): eine Firma = ein dauerhaftes „Account Brain“. Zuordnung der Leads über die Domain
// (Entity Resolution), Personen der Firma (Buying Committee) inkl. Kontakte ohne E-Mail.
import { q, tx, insert, update } from "../db.js";
import { isFreemail } from "../lib/verify.js";

export function normalizeDomain(input) {
  let s = String(input || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@") && !s.includes("/")) s = s.split("@").pop();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0].replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : "";
}

// Plattformen, die keine Firmen-Domain sind (Profil-Links in der Website-Spalte).
const PLATFORM_DOMAINS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|linkedin\.com|xing\.com|twitter\.com|x\.com|youtube\.com|tiktok\.com|linktr\.ee|google\.com|goo\.gl|maps\.app\.goo\.gl|wix\.com|wixsite\.com|jimdo\.com|jimdosite\.com|business\.site|gelbeseiten\.de|dasoertliche\.de|11880\.com|yelp\.de|yelp\.com|kununu\.com|indeed\.com|stepstone\.de|wordpress\.com|blogspot\.com|t-online\.de|web\.de|gmx\.de)$/i;
const usableSite = d => d && !isFreemail(`x@${d}`) && !PLATFORM_DOMAINS.test(d);

// Domain eines Leads: Website, sonst die Firmen-Domain der E-Mail (nie Freemail wie gmail.com, nie Facebook & Co.).
export function domainForLead(lead) {
  const site = normalizeDomain(lead.website);
  if (usableSite(site)) return site;
  const mail = normalizeDomain(lead.email);
  return mail && !isFreemail(lead.email) && !PLATFORM_DOMAINS.test(mail) ? mail : "";
}

// Website nur übernehmen, wenn sie eine gültige http(s)-Adresse auf genau dieser Domain ist – sonst https://<domain>.
export function websiteFor(domain, raw) {
  const d = normalizeDomain(domain);
  const value = String(raw || "").trim();
  if (value) {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
      if (["http:", "https:"].includes(u.protocol) && normalizeDomain(u.hostname) === d) return u.toString();
    } catch { /* keine gültige Adresse */ }
  }
  return d ? `https://${d}` : "";
}

export function findAccountByDomain(domain) {
  return domain ? q.get("SELECT * FROM accounts WHERE domain = ?", domain) : null;
}

export function createAccount({ domain, name = "", website = "", industry = "", city = "", project_id = null, product_id = null, owner_id = null }) {
  const d = normalizeDomain(domain);
  if (d) {
    const existing = findAccountByDomain(d);
    if (existing) return existing;
  }
  const now = Date.now();
  const id = insert("accounts", {
    domain: d || null, name: String(name || d || "Unbekannte Firma").slice(0, 200), website: websiteFor(d, website),
    industry, city, project_id, product_id, owner_id, lifecycle: "discovered", lifecycle_at: now, created_at: now, updated_at: now
  });
  return q.get("SELECT * FROM accounts WHERE id = ?", id);
}

// Person im Buying Committee für einen Lead anlegen bzw. aktuell halten.
export function syncPersonForLead(lead, accountId) {
  if (!accountId) return null;
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
  const existing = q.get("SELECT * FROM account_people WHERE lead_id = ?", lead.id);
  const now = Date.now();
  if (existing) {
    if (existing.account_id !== accountId) q.run("UPDATE account_people SET account_id = ?, updated_at = ? WHERE id = ?", accountId, now, existing.id);
    const patch = {};
    if (!existing.name && name) patch.name = name;
    if (!existing.role && lead.position) patch.role = lead.position;
    if (lead.phone && existing.phone !== lead.phone) patch.phone = lead.phone;
    if (existing.email !== lead.email) patch.email = lead.email;
    if (Object.keys(patch).length) update("account_people", existing.id, { ...patch, updated_at: now });
    return existing.id;
  }
  // Gleiche Person ohne E-Mail schon bekannt (z. B. aus dem Impressum)? Dann verknüpfen statt doppelt anlegen.
  const byName = name ? q.get("SELECT * FROM account_people WHERE account_id = ? AND lead_id IS NULL AND LOWER(name) = LOWER(?)", accountId, name) : null;
  if (byName) {
    update("account_people", byName.id, { lead_id: lead.id, email: lead.email, phone: byName.phone || lead.phone || "", role: byName.role || lead.position || "", updated_at: now });
    return byName.id;
  }
  return insert("account_people", {
    account_id: accountId, lead_id: lead.id, name, role: lead.position || "", phone: lead.phone || "", email: lead.email,
    source: "lead", created_at: now, updated_at: now
  });
}

// Lead → Firma (anlegen, wenn neu). Gibt die account_id zurück oder null (Freemail ohne Website).
export function ensureAccountForLead(leadOrId) {
  const lead = typeof leadOrId === "object" ? leadOrId : q.get("SELECT * FROM leads WHERE id = ?", leadOrId);
  if (!lead) return null;
  let accountId = lead.account_id || null;
  if (!accountId) {
    const domain = domainForLead(lead);
    if (!domain) return null;
    const account = findAccountByDomain(domain) || createAccount({ domain, name: lead.company || domain, website: lead.website || "", industry: lead.industry || "", city: lead.city || "" });
    accountId = account.id;
    q.run("UPDATE leads SET account_id = ? WHERE id = ?", accountId, lead.id);
    // Firmendaten aus dem Lead übernehmen, solange die Firma noch leer ist.
    const a = q.get("SELECT * FROM accounts WHERE id = ?", accountId);
    const patch = {};
    if ((!a.name || a.name === a.domain) && lead.company) patch.name = lead.company;
    if (!a.industry && lead.industry) patch.industry = lead.industry;
    if (!a.city && lead.city) patch.city = lead.city;
    if (Object.keys(patch).length) update("accounts", accountId, { ...patch, updated_at: Date.now() });
  }
  syncPersonForLead({ ...lead, account_id: accountId }, accountId);
  return accountId;
}

// Leads ohne Firma zuordnen (idempotent). Mit ids nur diese (z. B. frisch importierte), sonst die neuesten zuerst –
// Leads ohne Firmen-Domain (Freemail) bleiben ohne Firma und blockieren so keine neuen.
export function backfillAccounts(limit = 50000, { ids = null } = {}) {
  const leads = ids
    ? ids.map(id => q.get("SELECT * FROM leads WHERE id = ? AND account_id IS NULL", id)).filter(Boolean)
    : q.all("SELECT * FROM leads WHERE account_id IS NULL ORDER BY id DESC LIMIT ?", limit);
  let linked = 0;
  tx(() => { for (const l of leads) if (ensureAccountForLead(l)) linked++; });
  return linked;
}

// Zwei Firmen zusammenführen (z. B. Tochterfirma unter anderer Domain). Alles wandert zu target.
export function mergeAccounts(targetId, sourceId) {
  if (targetId === sourceId) return false;
  tx(() => {
    for (const table of ["leads", "account_people", "account_facts", "account_signals", "account_hypotheses", "account_memory", "opportunities", "tasks"]) {
      q.run(`UPDATE ${table} SET account_id = ? WHERE account_id = ?`, targetId, sourceId);
    }
    const src = q.get("SELECT * FROM accounts WHERE id = ?", sourceId);
    q.run("INSERT INTO account_memory (account_id, kind, text, source, created_at) VALUES (?, 'note', ?, 'system', ?)", targetId, `Zusammengeführt mit ${src?.name || "Firma"} (${src?.domain || "ohne Domain"})`, Date.now());
    q.run("DELETE FROM accounts WHERE id = ?", sourceId);
  });
  return true;
}
