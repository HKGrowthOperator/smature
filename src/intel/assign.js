// „Alle recherchieren & zuordnen“: Jeder Lead wird per KI gegen die vier Projekte geprüft (Website einmal gelesen) und in den
// Pool des Projekts gelegt, zu dem er wirklich passt. Passt er nirgends (nur C/D), fliegt er aus allen Pools und bekommt
// die Markierung „nicht passend“ – so steht in keiner Kampagne ein Bowlingcenter für Sales-Software.
import { q, tx, update, parseJson } from "../db.js";
import { qualifyLead, leadResearch } from "../ai/features.js";
import { listProjects } from "./projects.js";
import { profileFor, poolList } from "./sourcing.js";
import { leadCase } from "../lib/cases.js";
import { ensureAccountForLead } from "./accounts.js";

const RANK = { A: 3, B: 2, C: 1, D: 0 };
const PRIORITY = ["dealuno", "growth_os", "automation", "website"];
const B2C = new Set(["gastro", "freizeit", "laden", "praxis", "werkstatt"]);
const SERVICE = new Set(["agentur", "it", "personal", "beratung", "immobilien"]);
const INDUSTRY = new Set(["bau", "technik", "metall", "industrie", "logistik", "handwerk"]);

let qualifier = qualifyLead;
let researcher = leadResearch;
export function setAssignHooks({ qualify, research } = {}) { qualifier = qualify || qualifyLead; researcher = research || leadResearch; }

// Je Projekt das Produkt, mit dem die Kampagnen laufen (Vorlage vorhanden), sonst das erste Produkt – plus die Pool-Liste.
export function poolTargets() {
  const out = [];
  for (const project of listProjects()) {
    const product = q.get(`SELECT p.* FROM products p WHERE p.project_id = ? ORDER BY (SELECT COUNT(*) FROM campaigns c WHERE c.product_id = p.id AND c.is_template = 1) DESC, p.id LIMIT 1`, project.id);
    if (!product) continue;
    out.push({ project, product, profile: profileFor(project), list: poolList(project.id) });
  }
  return out;
}

// Welche Projekte für diesen Fall überhaupt in Frage kommen – spart KI-Aufrufe und verhindert Unsinn (Bowling bei Sales-Software).
export function candidateProfiles(fall) {
  const out = new Set(["website", "automation"]);
  if (!B2C.has(fall) && !INDUSTRY.has(fall)) out.add("dealuno");
  if (!B2C.has(fall) && !SERVICE.has(fall)) out.add("growth_os");
  return out;
}

function setCustom(lead, patch) {
  const custom = parseJson(lead.custom, {}) || {};
  Object.assign(custom, patch);
  for (const k of Object.keys(custom)) if (custom[k] === "" || custom[k] === null) delete custom[k];
  update("leads", lead.id, { custom: JSON.stringify(custom), updated_at: Date.now() });
}

export async function assignLead(leadId, { targets = poolTargets() } = {}) {
  const lead = q.get("SELECT * FROM leads WHERE id = ?", leadId);
  if (!lead || lead.status !== "active") return "übersprungen";
  const fall = leadCase(lead);
  const allowed = candidateProfiles(fall);
  const accountId = lead.account_id || ensureAccountForLead(lead);
  const account = accountId ? q.get("SELECT * FROM accounts WHERE id = ?", accountId) : null;
  const current = targets.find(t => t.project.id === account?.project_id)?.profile || null;
  const research = await researcher(lead);
  const results = {};
  // Aktuelles Projekt zuerst: ein klares „A“ dort spart die übrigen Prüfungen.
  const order = [...targets].sort((a, b) => (a.profile === current ? -1 : b.profile === current ? 1 : PRIORITY.indexOf(a.profile) - PRIORITY.indexOf(b.profile)));
  for (const t of order) {
    if (!allowed.has(t.profile)) { results[t.profile] = { fit: "D", reason: `Fall „${fall}“ passt nicht zu ${t.project.name}` }; continue; }
    results[t.profile] = await qualifier(lead, t.product, { research });
    if (t.profile === current && results[t.profile].fit === "A") break;
  }
  const best = order
    .filter(t => results[t.profile])
    .sort((a, b) => (RANK[results[b.profile].fit] - RANK[results[a.profile].fit]) || (a.profile === current ? -1 : b.profile === current ? 1 : 0) || (PRIORITY.indexOf(a.profile) - PRIORITY.indexOf(b.profile)))[0];
  const fit = best ? results[best.profile].fit : "D";
  const now = Date.now();
  const poolIds = targets.map(t => t.list.id);
  return tx(() => {
    if (!best || RANK[fit] < RANK.B) {
      for (const id of poolIds) q.run("DELETE FROM lead_list_members WHERE list_id = ? AND lead_id = ?", id, lead.id);
      const why = best ? `${best.project.name}: ${results[best.profile].reason || fit}` : "kein Projekt";
      setCustom(lead, { zuordnung: "nicht passend", zuordnung_grund: why.slice(0, 300), zuordnung_am: new Date(now).toISOString().slice(0, 10) });
      return "nicht passend";
    }
    for (const id of poolIds) if (id !== best.list.id) q.run("DELETE FROM lead_list_members WHERE list_id = ? AND lead_id = ?", id, lead.id);
    q.run("INSERT OR IGNORE INTO lead_list_members (list_id, lead_id, added_at) VALUES (?, ?, ?)", best.list.id, lead.id, now);
    if (accountId) q.run("UPDATE accounts SET project_id = ?, updated_at = ? WHERE id = ?", best.project.id, now, accountId);
    setCustom(lead, { zuordnung: `${best.project.name} (${fit})`, zuordnung_grund: String(results[best.profile].reason || "").slice(0, 300), zuordnung_am: new Date(now).toISOString().slice(0, 10) });
    return `${best.profile === current ? "bleibt" : "→"} ${best.project.name} (${fit})`;
  });
}

// Lead-Ids für „alle“: eine Liste, eine Auswahl oder alle Pool-Listen.
export function assignTargetsIds({ ids = [], listId = null, pools = false, force = false } = {}) {
  let out = [...ids];
  if (listId) out = out.concat(q.all("SELECT lead_id FROM lead_list_members WHERE list_id = ?", listId).map(r => r.lead_id));
  if (pools) for (const t of poolTargets()) out = out.concat(q.all("SELECT lead_id FROM lead_list_members WHERE list_id = ?", t.list.id).map(r => r.lead_id));
  out = [...new Set(out)];
  // Heute schon zugeordnete Leads nicht noch einmal prüfen (ein Neustart des Servers verliert laufende Aufträge).
  if (!force) {
    const today = new Date().toISOString().slice(0, 10);
    out = out.filter(id => parseJson(q.value("SELECT custom FROM leads WHERE id = ?", id), {})?.zuordnung_am !== today);
  }
  return out;
}
