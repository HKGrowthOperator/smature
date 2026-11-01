// Tages-Autopilot: Kapazität auf Projekte verteilen (Folge-Mails zuerst, Rest nach Anteil mit Umverteilung), Versand-Takt
// nutzt den Tagesplan, Pools werden automatisch nachgefüllt, nie angeschriebene alte Pool-Leads werden aufgeräumt.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupDb, makeMailbox, makeLead, makeCampaign, enroll, fakeTransport } from "./helpers.js";
import { q, insert } from "../src/db.js";
import { tick } from "../src/engine/scheduler.js";
import { setTransportFactory } from "../src/mail/transport.js";
import { saveSettings } from "../src/settings.js";
import { poolList } from "../src/intel/sourcing.js";
import { planDay, waterFill, refillPools, cleanupLeads, runAutopilotTick } from "../src/engine/autopilot.js";
import { DAY_MS } from "../src/lib/time.js";

let cleanup;
before(() => { cleanup = setupDb(); saveSettings({ footer_text: "Musterfirma GmbH · Musterstadt", autopilot_enabled: true, autopilot_shares: {}, sourcing_regions: ["Köln", "Bonn"] }); });
after(() => { setTransportFactory(null); cleanup(); });
beforeEach(() => {
  for (const t of ["campaign_leads", "campaign_steps", "campaigns", "messages", "conversations", "events", "lead_list_members", "lead_lists", "leads", "accounts", "mailboxes", "sourcing_candidates", "sourcing_runs", "projects"]) q.run(`DELETE FROM ${t}`);
  saveSettings({ autopilot_enabled: true, autopilot_shares: {}, sourcing_regions: ["Köln", "Bonn"], autopilot_buffer_days: 7, autopilot_last_cleanup: null });
});

function project(name, position = 0) {
  return insert("projects", { name, slug: `${name.toLowerCase().replace(/\W+/g, "-")}-${Math.random().toString(36).slice(2, 6)}`, position, created_at: Date.now(), updated_at: Date.now() });
}
// Projekt mit Pool und laufender Autopilot-Kampagne; newLeads warten auf die erste Mail.
function autopilotProject(name, mailboxIds, { newLeads = 0, dailyLimit = 1, ...overrides } = {}) {
  const pid = project(name);
  const list = poolList(pid);
  const cid = makeCampaign({ mailboxIds, name: `${name} · Autopilot`, daily_limit: dailyLimit, auto_list_id: list.id, min_gap_sec: 0, max_gap_sec: 0, ...overrides });
  for (let i = 0; i < newLeads; i++) addPoolLead(list.id, cid);
  return { pid, list, cid };
}
function addPoolLead(listId, cid, overrides = {}) {
  const lead = makeLead({ source: "Leadquelle: OpenStreetMap + Website", ...overrides });
  q.run("INSERT INTO lead_list_members (list_id, lead_id, added_at) VALUES (?, ?, ?)", listId, lead, Date.now());
  if (cid) enroll(cid, lead);
  return lead;
}

test("waterFill verteilt nach Gewicht und gibt ungenutzte Plätze weiter", () => {
  const out = waterFill(100, [{ key: "a", weight: 1, cap: 10 }, { key: "b", weight: 1, cap: 500 }, { key: "c", weight: 2, cap: 500 }]);
  assert.equal(out.get("a"), 10);
  assert.equal(out.get("a") + out.get("b") + out.get("c"), 100);
  assert.ok(out.get("c") > out.get("b"), "doppelter Anteil bekommt mehr");
  assert.equal([...waterFill(5, [{ key: "a", weight: 1, cap: 2 }]).values()][0], 2, "nie mehr als vorhanden");
});

test("Tagesplan: Kapazität voll ausnutzen, Folge-Mails zuerst, Rest zum Projekt mit Leads", () => {
  const boxes = [makeMailbox({ daily_limit: 50 }), makeMailbox({ daily_limit: 50 })];
  const small = autopilotProject("Webseite", boxes, { newLeads: 10 });
  const big = autopilotProject("Software Mittelstand", boxes, { newLeads: 200 });
  // Fünf Leads im kleinen Projekt warten auf Stufe 2.
  for (let i = 0; i < 5; i++) {
    const lead = makeLead();
    enroll(small.cid, lead, { status: "active", step: 1, next_at: Date.now() - 1000, mailbox_id: boxes[0] });
  }
  const plan = planDay();
  assert.equal(plan.capacity.available, 100);
  const s = plan.projects.find(p => p.campaign_id === small.cid), b = plan.projects.find(p => p.campaign_id === big.cid);
  assert.equal(s.quota_follow, 5, "fällige Stufe-2-Mails eingeplant");
  assert.equal(s.quota_new, 10, "kleiner Pool: alle 10 Erst-Mails");
  assert.equal(b.quota_new, 85, "der Rest geht an das Projekt mit genug Leads");
  assert.equal(plan.planned, 100);
  assert.equal(plan.unused, 0);
  assert.equal(s.by_step[1].due, 5);
});

test("Tagesplan: Anteile je Projekt und nicht freigegebene Kampagnen", () => {
  const boxes = [makeMailbox({ daily_limit: 90 })];
  const a = autopilotProject("A", boxes, { newLeads: 300 });
  const b = autopilotProject("B", boxes, { newLeads: 300 });
  const c = autopilotProject("C", boxes, { newLeads: 300, approved: false });
  saveSettings({ autopilot_shares: { [a.pid]: 2, [b.pid]: 1 } });
  const plan = planDay();
  assert.equal(plan.projects.find(p => p.campaign_id === a.cid).quota_new, 60);
  assert.equal(plan.projects.find(p => p.campaign_id === b.cid).quota_new, 30);
  const pc = plan.projects.find(p => p.campaign_id === c.cid);
  assert.equal(pc.ready, false);
  assert.match(pc.problem, /freigegeben/);
});

test("Versand-Takt hält sich an den Tagesplan statt an das feste Kampagnenlimit", async () => {
  const ft = fakeTransport(); setTransportFactory(ft.factory);
  const boxes = [makeMailbox(), makeMailbox(), makeMailbox()];
  autopilotProject("Webseite", boxes, { newLeads: 10, dailyLimit: 1 });
  const r = await tick();
  assert.equal(r.sent, 3, "alle drei Postfächer senden, obwohl das Kampagnenlimit 1 ist");
  saveSettings({ autopilot_enabled: false });
  q.run("UPDATE mailboxes SET next_send_at = 0");
  assert.equal((await tick()).sent, 0, "ohne Autopilot gilt wieder das Kampagnenlimit");
});

test("Pool nachfüllen: automatischer Lauf, wenn der Bestand unter den Puffer fällt – nur einer je Projekt", () => {
  const boxes = [makeMailbox({ daily_limit: 40 })];
  const { pid } = autopilotProject("Webseite", boxes, { newLeads: 20 });
  const started = refillPools(planDay());
  assert.equal(started.length, 1);
  const run = q.get("SELECT * FROM sourcing_runs WHERE id = ?", started[0].run_id);
  assert.equal(run.project_id, pid);
  assert.equal(run.auto, 1);
  assert.equal(run.status, "queued");
  assert.equal(started[0].target, 40 * 7);
  assert.equal(run.max_candidates, (280 - 20) * 4);
  assert.equal(refillPools(planDay()).length, 0, "läuft schon ein Lauf, startet kein zweiter");
});

test("Aufräumen: nur nie angeschriebene, nicht mehr gebrauchte Leads aus den Leadquellen", () => {
  const box = makeMailbox();
  const { list, cid } = autopilotProject("Webseite", [box]);
  const old = Date.now() - 90 * DAY_MS;
  const stale = addPoolLead(list.id, cid, { created_at: old, updated_at: old });
  const fresh = addPoolLead(list.id, cid);
  const outOfPool = makeLead({ source: "Leadquelle: OpenStreetMap + Website", updated_at: Date.now() - 5 * DAY_MS });
  const csvOld = makeLead({ source: "CSV", created_at: old, updated_at: old });
  const contacted = addPoolLead(list.id, null, { created_at: old, updated_at: old });
  insert("messages", { lead_id: contacted, direction: "out", kind: "campaign", created_at: old });
  const unsub = makeLead({ source: "Leadquelle: OpenStreetMap + Website", status: "unsubscribed", created_at: old, updated_at: old });
  insert("sourcing_candidates", { run_id: insert("sourcing_runs", { created_at: old, updated_at: old }), domain: "x.de", status: "imported", lead_id: stale, created_at: old });

  const preview = cleanupLeads(Date.now(), { dryRun: true });
  assert.equal(preview.leads, 2);
  assert.ok(q.get("SELECT 1 FROM leads WHERE id = ?", stale), "Vorschau löscht nichts");
  const res = cleanupLeads();
  assert.deepEqual(res.by, { stale: 1, not_in_pool: 1 });
  const left = new Set(q.all("SELECT id FROM leads").map(r => r.id));
  assert.ok(!left.has(stale) && !left.has(outOfPool));
  for (const keep of [fresh, csvOld, contacted, unsub]) assert.ok(left.has(keep));
  assert.equal(q.value("SELECT COUNT(*) FROM sourcing_candidates WHERE domain = 'x.de'"), 0, "Firma darf später neu gefunden werden");
});

test("Autopilot-Takt räumt einmal am Tag auf und macht ohne Schalter nichts", () => {
  saveSettings({ autopilot_enabled: false });
  assert.deepEqual(runAutopilotTick(), { enabled: false });
  saveSettings({ autopilot_enabled: true });
  const first = runAutopilotTick();
  assert.ok(first.cleanup, "erster Takt des Tages räumt auf");
  assert.equal(runAutopilotTick().cleanup, null, "zweiter Takt am selben Tag nicht");
});
