// Lernen bis zum Umsatz (Learning Engine): Welche Plays, Angles, Personas, Anlässe und Kanäle führen zu
// qualifizierten Terminen, Angeboten und Aufträgen – nicht nur zu Antworten. Sortiert wird nach Umsatz je Firma.
import { q, parseJson } from "../db.js";
import { LOSS_REASONS } from "../conversion/opportunities.js";
import { SIGNAL_TYPES } from "../intel/research.js";

const OBJECTION_TYPES = { existing_system: "Bestehendes System / Anbieter", too_expensive: "Zu teuer", no_time: "Keine Zeit", no_need: "Kein Bedarf", no_budget: "Kein Budget", no_interest: "Kein Interesse (ohne Grund)", other: "Sonstiges" };
const REACHED = ["contacted", "engaged", "meeting", "opportunity", "proposal", "won", "lost", "no_response", "not_now"];
const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function oppsFor(projectId) {
  return q.all(`SELECT o.*, a.industry AS account_industry, COALESCE(o.project_id, a.project_id) AS pid FROM opportunities o JOIN accounts a ON a.id = o.account_id
    ${projectId ? "WHERE COALESCE(o.project_id, a.project_id) = ?" : ""}`, ...(projectId ? [projectId] : []))
    .map(o => ({ ...o, attribution: parseJson(o.attribution, {}) || {}, loss: parseJson(o.loss, {}) || {}, quality: parseJson(o.quality, {}) || {} }));
}

function summarize(opps) {
  const won = opps.filter(o => o.stage === "won");
  const lost = opps.filter(o => o.stage === "lost");
  return {
    opportunities: opps.length,
    qualified: opps.filter(o => ["qualified", "proposal", "won"].includes(o.stage) || (o.stage === "lost" && Object.keys(o.quality).length)).length,
    proposals: opps.filter(o => ["proposal", "won"].includes(o.stage)).length,
    won: won.length, lost: lost.length,
    revenue: won.reduce((s, o) => s + (o.value_eur || 0), 0),
    win_rate: rate(won.length, won.length + lost.length),
    avg_cycle_days: won.length ? Math.round(won.reduce((s, o) => s + (o.attribution.sales_cycle_days || 0), 0) / won.length) : null
  };
}

function breakdown(opps, keyFn, labelFn = k => k) {
  const groups = new Map();
  for (const o of opps) {
    const k = keyFn(o);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  return [...groups.entries()].map(([k, list]) => ({ key: k, label: labelFn(k), ...summarize(list) }))
    .sort((a, b) => b.revenue - a.revenue || b.won - a.won || b.opportunities - a.opportunities).slice(0, 15);
}

export function learningReport({ projectId = null } = {}) {
  const where = projectId ? "WHERE a.project_id = ?" : "";
  const args = projectId ? [projectId] : [];
  const opps = oppsFor(projectId);

  const plays = q.all(`SELECT p.*, pj.name AS project_name FROM plays p LEFT JOIN projects pj ON pj.id = p.project_id ${projectId ? "WHERE p.project_id = ?" : ""} ORDER BY p.name`, ...args);
  const accountsByPlay = q.all(`SELECT a.play_id, a.lifecycle, a.id,
      EXISTS (SELECT 1 FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.account_id = a.id AND m.direction = 'in' AND m.kind != 'auto_reply') AS replied
    FROM accounts a ${where}`, ...args);
  const playRows = [...plays, { id: null, name: "Ohne Play", persona: "", angle: "", pain: "" }].map(p => {
    const acc = accountsByPlay.filter(a => (a.play_id || null) === p.id);
    const po = opps.filter(o => (o.play_id || o.attribution.play_id || null) === p.id);
    const s = summarize(po);
    return {
      id: p.id, name: p.name, project_name: p.project_name || "", persona: p.persona, angle: p.angle, pain: p.pain, status: p.status || "",
      accounts: acc.length, reached: acc.filter(a => REACHED.includes(a.lifecycle)).length, replied: acc.filter(a => a.replied).length,
      meetings: po.length, ...s,
      revenue_per_account: acc.length ? Math.round(s.revenue / acc.length) : 0,
      meeting_rate: rate(po.length, acc.filter(a => REACHED.includes(a.lifecycle)).length)
    };
  }).filter(p => p.id !== null || p.accounts || p.meetings)
    .sort((a, b) => b.revenue_per_account - a.revenue_per_account || b.won - a.won || b.qualified - a.qualified || b.meetings - a.meetings);

  const lossCounts = {};
  for (const o of opps.filter(x => x.stage === "lost")) {
    const k = o.loss.primary || "other";
    lossCounts[k] = (lossCounts[k] || 0) + 1;
  }
  // Einwände nach Art bündeln (bestehendes System, zu teuer, keine Zeit …) – mit den letzten Beispielen.
  const objRows = q.all(`SELECT COALESCE(json_extract(m.meta, '$.type'), 'other') AS type, m.text, m.created_at FROM account_memory m JOIN accounts a ON a.id = m.account_id
    WHERE m.kind = 'objection' ${projectId ? "AND a.project_id = ?" : ""} ORDER BY m.created_at DESC LIMIT 2000`, ...args);
  const objGroups = new Map();
  for (const o of objRows) {
    const g = objGroups.get(o.type) || { key: o.type, text: OBJECTION_TYPES[o.type] || o.type, n: 0, examples: [] };
    g.n++;
    if (g.examples.length < 3) g.examples.push(o.text);
    objGroups.set(o.type, g);
  }
  const objections = [...objGroups.values()].sort((a, b) => b.n - a.n).slice(0, 10);
  const funnel = q.all(`SELECT a.lifecycle, COUNT(*) AS n FROM accounts a ${where} GROUP BY a.lifecycle`, ...args);
  const earlierSignals = opps.filter(o => o.stage === "lost" && o.loss.detectable_earlier).map(o => ({ opportunity_id: o.id, title: o.title, signal: o.loss.signal || "", learning: o.loss.learning || "" })).slice(0, 10);

  return {
    totals: summarize(opps),
    plays: playRows,
    by_angle: breakdown(opps, o => o.attribution.angle),
    by_persona: breakdown(opps, o => o.attribution.meeting_persona || o.attribution.first_persona),
    by_pain: breakdown(opps, o => (o.attribution.confirmed_pains || [])[0] || o.attribution.initial_pain),
    by_trigger: breakdown(opps, o => o.attribution.trigger_type, k => SIGNAL_TYPES[k] || k),
    by_channel: breakdown(opps, o => o.attribution.first_channel, k => ({ email: "E-Mail", call: "Telefon" })[k] || k),
    by_industry: breakdown(opps, o => o.attribution.industry || o.account_industry),
    loss_reasons: Object.entries(lossCounts).map(([k, n]) => ({ key: k, label: LOSS_REASONS[k] || k, n })).sort((a, b) => b.n - a.n),
    objections,
    detectable_earlier: earlierSignals,
    funnel: Object.fromEntries(funnel.map(f => [f.lifecycle, f.n]))
  };
}
