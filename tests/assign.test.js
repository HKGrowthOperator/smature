import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeLead } from "./helpers.js";
import { q, insert } from "../src/db.js";
import { assignLead, candidateProfiles, poolTargets, setAssignHooks } from "../src/intel/assign.js";
import { poolList, profileFor } from "../src/intel/sourcing.js";
import { listProjects } from "../src/intel/projects.js";

let cleanup;
before(() => { cleanup = setupDb().cleanup; });
after(() => { setAssignHooks(); cleanup?.(); });

function project(profile) { const p = listProjects().find(x => profileFor(x) === profile); return p ? p.id : insert("projects", { name: profile, slug: profile, position: 9, created_at: Date.now(), updated_at: Date.now() }); }
function product(name, project_id) { return insert("products", { name, project_id, created_at: Date.now(), updated_at: Date.now() }); }

test("Recherchieren & zuordnen: Bowlingcenter fliegt aus dem DealUno-Pool, Agentur wandert zu DealUno, Rest bleibt", async () => {
  const pWeb = project("website"), pDeal = project("dealuno"), pOs = project("growth_os");
  q.run("DELETE FROM products");
  product("Unternehmenswebsite", pWeb); product("DealUno", pDeal); product("Software Mittelstand", pOs);
  const targets = poolTargets();
  assert.deepEqual([...new Set(targets.map(t => t.profile))].sort().filter(p => ["dealuno", "growth_os", "website"].includes(p)), ["dealuno", "growth_os", "website"]);
  assert.ok(!candidateProfiles("freizeit").has("dealuno") && !candidateProfiles("freizeit").has("growth_os"));
  assert.ok(candidateProfiles("agentur").has("dealuno") && !candidateProfiles("agentur").has("growth_os"));
  assert.ok(candidateProfiles("sonst").has("growth_os"));
  const dealList = poolList(pDeal), webList = poolList(pWeb);
  const bowling = makeLead({ email: "info@bowling-world.de", company: "Bowling World GmbH", industry: "Bowlingcenter", website: "bowling-world.de" });
  const agency = makeLead({ email: "hi@pixel-agentur.de", company: "Pixel Agentur GmbH", industry: "Werbeagentur", website: "pixel-agentur.de" });
  const roofer = makeLead({ email: "info@mueller-dach.de", company: "Müller Bedachungen", industry: "Dachdeckerei", website: "mueller-dach.de" });
  for (const id of [bowling, agency]) q.run("INSERT INTO lead_list_members (list_id, lead_id, added_at) VALUES (?, ?, ?)", dealList.id, id, Date.now());
  q.run("INSERT INTO lead_list_members (list_id, lead_id, added_at) VALUES (?, ?, ?)", webList.id, roofer, Date.now());
  const calls = [];
  setAssignHooks({
    research: async () => "Website-Text",
    qualify: async (lead, prod) => {
      calls.push(`${lead.company}→${prod.name}`);
      if (lead.company.startsWith("Pixel") && prod.name === "DealUno") return { fit: "A", reason: "Agentur mit B2B-Vertrieb" };
      if (lead.company.startsWith("Pixel")) return { fit: "C", reason: "unklar" };
      if (lead.company.startsWith("Müller") && prod.name === "Unternehmenswebsite") return { fit: "B", reason: "Website schwach" };
      return { fit: "D", reason: "passt nicht" };
    }
  });
  assert.equal(await assignLead(bowling, { targets }), "nicht passend");
  assert.equal(q.value("SELECT COUNT(*) FROM lead_list_members WHERE lead_id = ?", bowling), 0);
  assert.match(JSON.parse(q.value("SELECT custom FROM leads WHERE id = ?", bowling)).zuordnung, /nicht passend/);
  // DealUno und Growth OS wurden für das Bowlingcenter gar nicht erst per KI geprüft.
  assert.ok(!calls.some(c => c.startsWith("Bowling") && /DealUno|Growth/.test(c)));
  assert.match(await assignLead(agency, { targets }), /\(A\)/);
  assert.equal(q.value("SELECT list_id FROM lead_list_members WHERE lead_id = ?", agency), dealList.id);
  assert.match(await assignLead(roofer, { targets }), /\(B\)/);
  assert.equal(q.value("SELECT project_id FROM accounts WHERE id = (SELECT account_id FROM leads WHERE id = ?)", roofer), pWeb);
});

test("Autopilot: Kampagne lädt neue Pool-Leads nach und trägt rausgeflogene vor der ersten Mail wieder aus", async () => {
  const { makeMailbox, makeCampaign } = await import("./helpers.js");
  const { autoEnrollTick } = await import("../src/api/campaigns.js");
  const mb = makeMailbox();
  const listId = insert("lead_lists", { name: "Pool · Test", created_at: Date.now() });
  const cid = makeCampaign({ mailboxIds: [mb], steps: [{ delay_days: 0, variants: [{ subject: "Hi {{company}}", body: "{{anrede}},\n\nTest\n\nViele Grüße" }] }], legal_basis: "consent" });
  q.run("UPDATE campaigns SET auto_list_id = ? WHERE id = ?", listId, cid);
  const a = makeLead({ email: "a@firma-a.de" }), b = makeLead({ email: "b@firma-b.de" });
  for (const id of [a, b]) q.run("INSERT INTO lead_list_members (list_id, lead_id, added_at) VALUES (?, ?, ?)", listId, id, Date.now());
  assert.equal(autoEnrollTick().added, 2);
  assert.equal(q.value("SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = ?", cid), 2);
  // b fliegt aus dem Pool (z. B. „nicht passend“) → vor der ersten Mail wieder raus
  q.run("DELETE FROM lead_list_members WHERE list_id = ? AND lead_id = ?", listId, b);
  const r = autoEnrollTick();
  assert.equal(r.removed, 1);
  assert.equal(q.value("SELECT COUNT(*) FROM campaign_leads WHERE campaign_id = ?", cid), 1);
});
