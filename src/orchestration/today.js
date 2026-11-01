// „Heute“: die Handvoll Aktionen, die heute wirklich Umsatz bewegen – sortiert nach Wichtigkeit statt nach Menge.
// Reihenfolge: positive Antworten (Ziel < 30 Min.), Termine vorbereiten, fällige Aufgaben/Anrufe, neue Anlässe,
// Angebote nachfassen, beste noch unberührte Firmen.
import { q } from "../db.js";
import { getSettings } from "../settings.js";
import { DAY_MS, startOfDay } from "../lib/time.js";
import { nextBestAction } from "../intel/brain.js";
import { LIFECYCLE } from "../intel/lifecycle.js";
import { weightedValue } from "../conversion/opportunities.js";

const person = r => [r.first_name, r.last_name].filter(Boolean).join(" ") || r.email || "";

export function todayActions({ projectId = null, limit = 25, now = Date.now(), userId = null } = {}) {
  const settings = getSettings();
  const tz = settings.timezone || "Europe/Berlin";
  const sla = Number(settings.reply_sla_minutes) || 30;
  const endOfDay = startOfDay(now, tz) + DAY_MS;
  const items = new Map();
  const add = item => {
    const prev = items.get(item.key);
    if (!prev || prev.priority < item.priority) items.set(item.key, item);
  };
  const inProject = pid => !projectId || pid === projectId;

  // 1) Positive Antworten, auf die wir noch nicht reagiert haben.
  for (const c of q.all(`SELECT c.id, c.label, c.last_inbound_at, c.ai_summary, c.subject, l.id AS lead_id, l.first_name, l.last_name, l.email, l.company, l.account_id,
      a.project_id AS a_project, pr.project_id AS p_project
    FROM conversations c JOIN leads l ON l.id = c.lead_id LEFT JOIN accounts a ON a.id = l.account_id
    LEFT JOIN campaigns cp ON cp.id = c.campaign_id LEFT JOIN products pr ON pr.id = cp.product_id
    WHERE c.label IN ('interested','meeting','question') AND c.status != 'done'
    AND (SELECT direction FROM messages WHERE conversation_id = c.id AND kind != 'auto_reply' ORDER BY created_at DESC, id DESC LIMIT 1) = 'in'`)) {
    const pid = c.a_project || c.p_project || null;
    if (!inProject(pid)) continue;
    const minutes = Math.max(0, Math.round((now - (c.last_inbound_at || now)) / 60000));
    add({
      key: `conv:${c.id}`, kind: "reply", priority: 1000 + Math.min(minutes, 2000), overdue: minutes > sla, minutes, sla,
      title: `${person(c)}${c.company ? ` (${c.company})` : ""} antworten`,
      reason: `${c.label === "question" ? "Rückfrage" : c.label === "meeting" ? "Will einen Termin" : "Interesse"} seit ${minutes < 120 ? `${minutes} Min.` : `${Math.round(minutes / 60)} Std.`}${c.ai_summary ? ` – ${c.ai_summary}` : ""}`,
      conversation_id: c.id, lead_id: c.lead_id, account_id: c.account_id, project_id: pid, link: `#/unibox/${c.id}`
    });
  }

  // 2) Termine: heute anstehende und solche ohne Vorbereitung in den nächsten 48 Stunden.
  for (const o of q.all(`SELECT o.*, a.name AS account_name, a.project_id AS a_project FROM opportunities o JOIN accounts a ON a.id = o.account_id
    WHERE o.stage IN ('meeting','qualified','proposal') AND o.meeting_at IS NOT NULL AND o.meeting_at BETWEEN ? AND ?`, now - 3 * 3600 * 1000, now + 2 * DAY_MS)) {
    const pid = o.project_id || o.a_project || null;
    if (!inProject(pid)) continue;
    const today = o.meeting_at < endOfDay;
    add({
      key: `opp:${o.id}`, kind: "meeting", priority: o.prep ? (today ? 650 : 200) : 700 + (today ? 100 : 0),
      title: o.prep ? `Termin ${today ? "heute" : "morgen"}: ${o.account_name}` : `Termin vorbereiten: ${o.account_name}`,
      reason: `${new Date(o.meeting_at).toLocaleString("de-DE", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" })}${o.prep ? " – Briefing liegt vor" : " – noch kein Briefing (Fakten, Hypothesen, 5 Fragen)"}`,
      opportunity_id: o.id, account_id: o.account_id, project_id: pid, link: `#/pipeline/${o.id}`
    });
  }

  // 3) Fällige Aufgaben und Anrufe (bis Tagesende).
  for (const t of q.all(`SELECT t.*, l.first_name, l.last_name, l.email, l.company, l.phone AS lead_phone, a.name AS account_name, a.project_id AS a_project,
      pr.project_id AS p_project, p.name AS person_name, p.phone AS person_phone
    FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN accounts a ON a.id = t.account_id LEFT JOIN products pr ON pr.id = t.product_id
    LEFT JOIN account_people p ON p.id = t.person_id
    WHERE t.status = 'open' AND t.due_at <= ? ORDER BY t.priority DESC, t.due_at LIMIT 200`, endOfDay)) {
    const pid = t.a_project || t.p_project || null;
    if (!inProject(pid)) continue;
    if (t.conversation_id && items.has(`conv:${t.conversation_id}`) && t.type === "reply") continue;
    const isCall = ["call", "call_sequence"].includes(t.type);
    const overdueDays = Math.floor((now - t.due_at) / DAY_MS);
    add({
      key: `task:${t.id}`, kind: isCall ? "call" : "task", priority: 500 + (t.priority || 0) + Math.min(overdueDays, 10) * 5,
      title: t.title,
      reason: [t.type === "call_sequence" ? "Anruf nach Sequenz" : isCall ? "Anruf" : "Aufgabe", overdueDays > 0 ? `seit ${overdueDays} Tag(en) fällig` : "heute fällig", t.notes ? t.notes.split("\n").pop().slice(0, 140) : ""].filter(Boolean).join(" · "),
      phone: t.person_phone || t.lead_phone || "", task_id: t.id, lead_id: t.lead_id, account_id: t.account_id, project_id: pid, link: t.account_id && !t.lead_id ? `#/firmen/${t.account_id}` : "#/aufgaben"
    });
  }

  // 4) Firmen mit Handlungsbedarf (neuer Anlass, Angebot, beste qualifizierte Firmen ohne Kontakt).
  const accounts = q.all(`SELECT a.* FROM accounts a WHERE a.lifecycle IN ('triggered','qualified','outreach_ready','proposal','opportunity','meeting','researched')
    ${projectId ? "AND a.project_id = ?" : ""} ORDER BY a.lifecycle = 'triggered' DESC, COALESCE(a.opportunity_score, 0) DESC LIMIT 120`, ...(projectId ? [projectId] : []));
  for (const a of accounts) {
    if (a.lifecycle === "researched" && (a.opportunity_score || 0) < 60) continue;
    const nba = nextBestAction(a, { now });
    if (["none", "wait", "watch"].includes(nba.type)) continue;
    const key = nba.conversation_id ? `conv:${nba.conversation_id}` : nba.task_id ? `task:${nba.task_id}` : nba.opportunity_id ? `opp:${nba.opportunity_id}` : `acc:${a.id}`;
    if (items.has(key)) continue;
    add({
      key, kind: nba.type, priority: nba.priority || 0, title: `${nba.label}: ${a.name || a.domain}`,
      reason: [LIFECYCLE[a.lifecycle], a.opportunity_score !== null ? `Opportunity ${a.opportunity_score}` : "", nba.reason].filter(Boolean).join(" · "),
      goal: nba.goal || "", phone: nba.phone || "", account_id: a.id, person_id: nba.person_id || null, opportunity_id: nba.opportunity_id || null,
      project_id: a.project_id || null, link: `#/firmen/${a.id}`
    });
  }

  const all = [...items.values()].sort((x, y) => y.priority - x.priority);
  const openOpps = q.all(`SELECT o.stage, o.value_eur, o.probability, o.quality FROM opportunities o JOIN accounts a ON a.id = o.account_id
    WHERE o.stage NOT IN ('won','lost') ${projectId ? "AND COALESCE(o.project_id, a.project_id) = ?" : ""}`, ...(projectId ? [projectId] : []));
  const monthStart = new Date(now); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const won = q.get(`SELECT COUNT(*) AS n, TOTAL(o.value_eur) AS value FROM opportunities o JOIN accounts a ON a.id = o.account_id
    WHERE o.stage = 'won' AND o.closed_at >= ? ${projectId ? "AND COALESCE(o.project_id, a.project_id) = ?" : ""}`, monthStart.getTime(), ...(projectId ? [projectId] : []));
  return {
    items: all.slice(0, limit),
    more: Math.max(0, all.length - limit),
    stats: {
      replies_waiting: all.filter(i => i.kind === "reply").length,
      replies_overdue: all.filter(i => i.kind === "reply" && i.overdue).length,
      meetings_soon: all.filter(i => i.kind === "meeting").length,
      calls_due: all.filter(i => i.kind === "call").length,
      triggered: q.value(`SELECT COUNT(*) FROM accounts WHERE lifecycle = 'triggered' ${projectId ? "AND project_id = ?" : ""}`, ...(projectId ? [projectId] : [])),
      pipeline_open: openOpps.length,
      pipeline_weighted: Math.round(openOpps.reduce((sum, o) => sum + weightedValue(o), 0)),
      won_month: won?.n || 0, won_month_value: Math.round(won?.value || 0)
    },
    sla_minutes: sla,
    user_id: userId
  };
}
