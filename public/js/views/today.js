// Heute: die Aktionen, die heute wirklich zählen – positive Antworten zuerst, dann Termine und neue Anlässe (nur Cold Mailing).
import { h, clear, api, icon, busy, toast, modal, euro, num, skeletonRows, emptyState, select, projectOptions } from "../lib.js";
import { taskCard } from "./tasks.js";

const KIND_ICON = { reply: "reply", meeting: "calendar", prep: "calendar", call: "phone", task: "list", email: "mail", research: "search", find_contact: "users", proposal: "file" };
let projectFilter = "";

export async function render(el) {
  clear(el, head(), h("div", { class: "content" }, skeletonRows(6)));
  const [{ options }, d] = await Promise.all([projectOptions(), api(`/api/today${projectFilter ? `?project=${projectFilter}` : ""}`)]);
  const reload = () => render(el);
  const filter = select([["", "Alle Projekte"], ...options.slice(1)], projectFilter, { onchange: e => { projectFilter = e.target.value; reload(); } });
  const s = d.stats;
  const tile = (label, value, meta, tone) => h("div", { class: "card kpi" }, h("div", { class: "label" }, label), h("div", { class: "value", style: tone ? { color: `var(--${tone})` } : null }, value), meta ? h("div", { class: "meta" }, meta) : null);
  clear(el,
    head(filter),
    h("div", { class: "content stack" },
      h("div", { class: "kpis" },
        tile("Antworten warten", num(s.replies_waiting), s.replies_overdue ? `${s.replies_overdue} über ${d.sla_minutes} Min.` : `Ziel: < ${d.sla_minutes} Min.`, s.replies_overdue ? "danger" : null),
        tile("Termine (48 Std.)", num(s.meetings_soon), "mit Briefing vorbereiten"),
        tile("Neue Anlässe", num(s.triggered), "Firmen mit Why-now"),
        tile("Pipeline gewichtet", euro(s.pipeline_weighted), `${num(s.pipeline_open)} offene Chancen`),
        tile("Gewonnen (Monat)", euro(s.won_month_value), `${num(s.won_month)} Aufträge`)),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", null, `${d.items.length} Aktionen für heute`), d.more ? h("span", { class: "muted small" }, `+ ${d.more} weitere`) : null,
          h("div", { class: "actions" }, h("a", { class: "btn btn-sm", href: "#/firmen" }, icon("building"), "Firmen"), h("a", { class: "btn btn-sm", href: "#/aufgaben" }, icon("list"), "Alle Aufgaben"))),
        d.items.length ? h("div", { class: "actions-list" }, d.items.map(item => actionRow(item, reload)))
          : emptyState("Heute ist nichts offen", "Firmen hinzufügen und recherchieren lassen – passende Firmen mit Anlass erscheinen dann hier. Antworten und Termine ebenfalls.", h("a", { class: "btn btn-primary", href: "#/firmen" }, icon("plus"), "Firmen hinzufügen"))),
      h("div", { class: "hint" }, "Sortiert nach Wirkung, nicht nach Menge: Wer Interesse zeigt, bekommt zuerst eine Antwort. Firmen werden nicht mehrfach parallel bearbeitet (Kontakt-Sättigung).")));
}

function head(filter) {
  return h("div", { class: "page-head" }, h("h1", null, "Heute"), h("span", { class: "sub" }, new Date().toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" })),
    filter ? h("div", { class: "actions" }, filter) : null);
}

function actionRow(item, reload) {
  const btns = [];
  if (item.kind === "reply") btns.push(h("a", { class: "btn btn-sm btn-primary", href: item.link }, icon("reply"), "Antworten"));
  else if (item.kind === "meeting" || item.kind === "prep") btns.push(h("a", { class: "btn btn-sm btn-primary", href: item.link }, item.title.startsWith("Termin vorbereiten") ? "Briefing" : "Öffnen"));
  else if (item.task_id) {
    if (item.phone) btns.push(h("span", { class: "badge plain", title: "Telefonnummer – für die Übergabe an die Sales App" }, icon("phone", "icon icon-xs"), item.phone));
    btns.push(h("button", { class: "btn btn-sm btn-primary", onclick: e => busy(e.currentTarget, () => openTask(item.task_id, reload)) }, "Öffnen"));
  } else if (item.kind === "research" && item.account_id) {
    btns.push(h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { await api(`/api/accounts/${item.account_id}/research`, { method: "POST" }); toast("Recherche läuft im Hintergrund"); }) }, icon("sparkles"), "Recherchieren"));
  } else if (item.kind === "email" && item.account_id) {
    btns.push(h("a", { class: "btn btn-sm btn-primary", href: "#/kampagnen" }, icon("send"), "Zur Kampagne"));
  }
  if (item.link && !btns.some(b => b.getAttribute?.("href") === item.link)) btns.push(h("a", { class: "btn btn-sm btn-ghost", href: item.link }, "Öffnen"));
  return h("div", { class: ["action-item", item.kind, item.overdue && "overdue"] },
    h("div", { class: "kind" }, icon(KIND_ICON[item.kind] || "zap")),
    h("div", { style: { minWidth: 0 } },
      h("div", { class: "title" }, item.title, item.overdue ? h("span", { class: "badge danger", style: { marginLeft: "8px" } }, `über ${item.sla} Min.`) : null),
      item.reason ? h("div", { class: "reason" }, item.reason) : null,
      item.goal ? h("div", { class: "goal" }, `Ziel: ${item.goal}`) : null),
    h("div", { class: "btns" }, btns));
}

async function openTask(id, reload) {
  const [t, meta] = await Promise.all([api(`/api/tasks/${id}`), api("/api/tasks?status=open&limit=1")]);
  const dlg = modal({ title: "Aufgabe", wide: true, body: taskCard(t, meta, () => { dlg.close(); window.dispatchEvent(new Event("tasks:changed")); reload(); }) });
}
