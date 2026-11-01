// Pipeline: Termine → qualifiziert → Angebot, darunter gewonnene/verlorene Chancen. Gewichtet nach Gesprächsqualität.
import { h, clear, api, icon, euro, num, dateTime, relTime, skeletonRows, emptyState, select, state, projectDot } from "../lib.js";

let projectFilter = "";

export async function render(el) {
  if (state.query?.has("projekt")) projectFilter = state.query.get("projekt");
  clear(el, head(), h("div", { class: "content" }, skeletonRows(5)));
  const d = await api(`/api/opportunities${projectFilter ? `?project=${projectFilter}` : ""}`);
  const filter = select([["", "Alle Projekte"], ...(state.projects || []).map(p => [p.id, p.name])], projectFilter, { onchange: e => { projectFilter = e.target.value; render(el); } });
  const s = d.summary;
  const card = o => h("div", { class: "opp-card", onclick: () => { location.hash = `#/pipeline/${o.id}`; } },
    h("div", { class: "t" }, o.title),
    h("div", { class: "m" }, h("span", null, o.account_name), o.project_name ? projectDot(o.project_color, o.project_name) : null),
    h("div", { class: "m" },
      o.value_eur ? h("span", { class: "strong" }, euro(o.value_eur)) : h("span", null, "Wert offen"),
      h("span", null, `${o.probability ?? 0} %`),
      o.quality_overall !== null ? h("span", null, `Qualität ${o.quality_overall}`) : null),
    o.meeting_at ? h("div", { class: "m" }, icon("calendar", "icon icon-xs"), dateTime(o.meeting_at), o.stage === "meeting" && !o.prep && o.meeting_at > Date.now() ? h("span", { class: "badge warn" }, "Briefing fehlt") : null) : null,
    o.next_step ? h("div", { class: "m" }, `→ ${o.next_step}${o.next_step_at ? ` (${relTime(o.next_step_at)})` : ""}`) : null);
  const col = stage => {
    const items = d.items.filter(o => o.stage === stage);
    return h("div", { class: "kanban-col" }, h("h3", null, d.stages[stage], h("span", { class: "muted" }, `${items.length} · ${euro(s.by_stage[stage].value)}`)),
      items.length ? items.map(card) : h("div", { class: "small muted", style: { padding: "4px" } }, "–"));
  };
  const closed = d.items.filter(o => ["won", "lost"].includes(o.stage));
  clear(el, head(filter),
    h("div", { class: "content stack" },
      h("div", { class: "kpis" },
        h("div", { class: "card kpi" }, h("div", { class: "label" }, "Offene Chancen"), h("div", { class: "value" }, num(s.open)), h("div", { class: "meta" }, `Volumen ${euro(s.open_value)}`)),
        h("div", { class: "card kpi" }, h("div", { class: "label" }, "Gewichtet"), h("div", { class: "value" }, euro(s.weighted)), h("div", { class: "meta" }, "Wert × Wahrscheinlichkeit")),
        h("div", { class: "card kpi" }, h("div", { class: "label" }, "Gewonnen"), h("div", { class: "value" }, num(s.by_stage.won.n)), h("div", { class: "meta" }, euro(s.by_stage.won.value))),
        h("div", { class: "card kpi" }, h("div", { class: "label" }, "Verloren"), h("div", { class: "value" }, num(s.by_stage.lost.n)), h("div", { class: "meta" }, h("a", { href: "#/lernen" }, "Gründe ansehen")))),
      d.items.length ? h("div", { class: "kanban" }, col("meeting"), col("qualified"), col("proposal"))
        : h("div", { class: "card" }, emptyState("Noch keine Chancen", "Ein gebuchter Termin (Webhook oder Label „Termin“) legt automatisch eine Chance an. Du kannst sie auch im Firmenprofil anlegen.", h("a", { class: "btn", href: "#/firmen" }, "Zu den Firmen"))),
      closed.length ? h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Abgeschlossen")),
        h("div", { class: "table-wrap" }, h("table", { class: "table" },
          h("thead", null, h("tr", null, h("th", null, "Chance"), h("th", null, "Ergebnis"), h("th", { class: "num" }, "Wert"), h("th", null, "Grund / Play"), h("th", null, "Abgeschlossen"))),
          h("tbody", null, closed.map(o => h("tr", { class: "clickable", onclick: () => { location.hash = `#/pipeline/${o.id}`; } },
            h("td", null, h("div", { class: "strong" }, o.title), h("div", { class: "small muted" }, o.account_name)),
            h("td", null, h("span", { class: ["badge", o.stage === "won" ? "ok" : "danger"] }, d.stages[o.stage])),
            h("td", { class: "num" }, euro(o.value_eur)),
            h("td", { class: "small" }, o.stage === "lost" ? d.loss_reasons[o.loss.primary] || "–" : o.play_name || o.attribution.angle || "–"),
            h("td", { class: "small muted" }, dateTime(o.closed_at)))))))) : null));
}

function head(filter) {
  return h("div", { class: "page-head" }, h("h1", null, "Pipeline"), h("span", { class: "sub" }, "Vom Termin bis zum Auftrag"), filter ? h("div", { class: "actions" }, filter) : null);
}
