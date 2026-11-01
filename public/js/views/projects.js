// Projekte-Board: eine Spalte je Geschäftsbereich (Webseite, Software Sales App, Software Mittelstand, Webseite/Automation …)
// mit Produkten, Zielgruppen, Plays, Kampagnen, Firmen nach Status, Pipeline und den wichtigsten Aktionen.
import { h, clear, api, icon, busy, toast, modal, field, input, textarea, euro, num, skeletonRows, lifecycleBadge, badge, confirmDialog, reloadProjects } from "../lib.js";

let meta = null;

export async function render(el) {
  clear(el, head(), h("div", { class: "content" }, skeletonRows(6)));
  meta = meta || await api("/api/revenue/meta");
  const board = await api("/api/projects/board");
  const reload = () => render(el);
  clear(el, head(reload),
    h("div", { class: "content stack" },
      h("div", { class: "board", style: { "--cols": board.columns.length } }, board.columns.map(c => column(c, reload))),
      h("div", { class: "hint" }, "Produkte, Zielgruppen, Listen und Plays ordnest du im jeweiligen Formular einem Projekt zu. Firmen übernehmen das Projekt beim Anlegen oder im Firmenprofil.")));
}

function head(reload) {
  return h("div", { class: "page-head" }, h("h1", null, "Projekte"), h("span", { class: "sub" }, "Welche Produkte und Zielgruppen wir wo ansprechen"),
    reload ? h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => editProject(null, reload) }, icon("plus"), "Projekt")) : null);
}

function column(c, reload) {
  const p = c.project;
  const sec = (title, action, ...content) => h("div", { class: "board-sec" }, h("h3", null, title, action || null), ...content);
  const add = (label, href) => h("a", { class: "btn btn-ghost btn-sm", href, title: label }, icon("plus"));
  const empty = text => h("div", { class: "small muted" }, text);
  const lc = c.accounts.lifecycle;
  const order = ["triggered", "qualified", "outreach_ready", "contacted", "engaged", "meeting", "opportunity", "proposal", "won", "watching", "researched", "discovered", "no_response", "not_now", "disqualified", "lost", "suppressed"];
  return h("section", { class: "board-col", style: { "--col": p.color || "var(--line-2)" } },
    h("div", { class: "board-col-head" },
      h("div", { class: "row-tight" }, h("h2", { class: "grow" }, p.name),
        p.id ? h("button", { class: "btn btn-ghost btn-icon btn-sm", title: "Projekt bearbeiten", "aria-label": "Projekt bearbeiten", onclick: () => editProject(p, reload) }, icon("edit")) : null),
      p.description ? h("div", { class: "desc" }, p.description) : null,
      h("div", { class: "board-stats" },
        h("div", null, h("b", null, num(c.accounts.total)), h("span", null, "Firmen")),
        h("div", null, h("b", null, num(c.pipeline.open)), h("span", null, "Chancen")),
        h("div", null, h("b", null, euro(c.pipeline.weighted)), h("span", null, "gewichtet")))),
    c.actions ? sec("Heute", h("a", { class: "btn btn-ghost btn-sm", href: "#/" }, "alle"),
      c.actions.items.length ? h("div", { class: "mini-list" }, c.actions.items.map(a => h("a", { href: a.link || "#/" }, h("span", { class: "name" }, a.title), a.overdue ? h("span", { class: "badge danger" }, "SLA") : null))) : empty("Keine offenen Aktionen")) : null,
    sec("Produkte", p.id ? add("Produkt anlegen", `#/produkte?projekt=${p.id}`) : null,
      c.products.length ? h("div", { class: "mini-list" }, c.products.map(x => h("a", { href: `#/produkte/${x.id}` }, icon("box", "icon icon-xs"), h("span", { class: "name" }, x.name),
        h("span", { class: "meta" }, x.approved_templates ? `${x.approved_templates} freigegeben` : "keine Freigabe", x.active_campaigns ? ` · ${x.active_campaigns} aktiv` : "")))) : empty("Noch kein Produkt")),
    sec("Zielgruppen", p.id ? add("Zielgruppe anlegen", `#/zielgruppen?projekt=${p.id}`) : null,
      c.target_groups.length ? h("div", { class: "mini-list" }, c.target_groups.map(x => h("a", { href: `#/zielgruppen/${x.id}` }, icon("target", "icon icon-xs"), h("span", { class: "name" }, x.name), h("span", { class: "meta" }, x.shared ? `geteilt · ${x.docs} Blätter` : `${x.docs} Blätter`)))) : empty("Noch keine Zielgruppe")),
    sec("Plays", p.id ? add("Play anlegen", `#/lernen?neu=${p.id}`) : null,
      c.plays.length ? h("div", { class: "mini-list" }, c.plays.map(x => h("a", { href: "#/lernen" }, icon("zap", "icon icon-xs"), h("span", { class: "name" }, x.name), h("span", { class: "meta" }, x.status === "active" ? x.persona || "" : "pausiert")))) : empty("Branche × Anlass × Persona × Angle")),
    sec("Kampagnen", null,
      c.campaigns.length ? h("div", { class: "mini-list" }, c.campaigns.map(x => h("a", { href: `#/kampagnen/${x.id}` }, h("span", { class: "name" }, x.name), h("span", { class: "meta" }, badge("campaign", x.status), ` ${num(x.leads)}`)))) : empty("Keine laufende Kampagne")),
    sec("Firmen", h("a", { class: "btn btn-ghost btn-sm", href: `#/firmen?projekt=${p.id ?? "none"}` }, "alle"),
      Object.keys(lc).length ? h("div", { class: "lc-bars" }, order.filter(k => lc[k]).map(k => h("a", { href: `#/firmen?projekt=${p.id ?? "none"}&status=${k}` }, lifecycleBadge(k, `${meta.lifecycle[k]} ${lc[k]}`)))) : empty("Noch keine Firmen"),
      c.accounts.top.length ? h("div", { class: "mini-list", style: { marginTop: "8px" } }, c.accounts.top.map(a => h("a", { href: `#/firmen/${a.id}` }, icon("building", "icon icon-xs"), h("span", { class: "name" }, a.name || a.domain), h("span", { class: "meta" }, a.opportunity_score ?? "–")))) : null),
    sec("Pipeline", h("a", { class: "btn btn-ghost btn-sm", href: `#/pipeline${p.id ? `?projekt=${p.id}` : ""}` }, "öffnen"),
      h("div", { class: "small" }, `Termine ${c.pipeline.by_stage.meeting} · Qualifiziert ${c.pipeline.by_stage.qualified} · Angebot ${c.pipeline.by_stage.proposal}`),
      h("div", { class: "small muted" }, `Gewonnen: ${c.pipeline.won} (${euro(c.pipeline.won_value)})`)));
}

function editProject(p, reload) {
  const name = input({ value: p?.name || "", maxlength: 80 });
  const description = textarea({ value: p?.description || "", rows: 2 });
  const color = input({ type: "color", value: p?.color || "#2b7353", style: { width: "64px", padding: "2px" } });
  const dlg = modal({
    title: p ? `Projekt „${p.name}“` : "Neues Projekt",
    body: h("div", { class: "stack" }, field("Name", name), field("Beschreibung", description, "z. B. „Websites für Handwerk und Industrie“"), field("Farbe", color)),
    footer: [
      p ? h("button", { class: "btn btn-ghost btn-danger", onclick: e => busy(e.currentTarget, async () => {
        if (!(await confirmDialog(`Projekt „${p.name}“ löschen? Produkte, Zielgruppen und Firmen bleiben erhalten und landen unter „Ohne Projekt“.`, { danger: true, confirm: "Löschen" }))) return;
        await api(`/api/projects/${p.id}`, { method: "DELETE" }); await reloadProjects(); dlg.close(); reload();
      }) }, "Löschen") : null,
      h("div", { class: "grow" }),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"),
      h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
        const body = { name: name.value, description: description.value, color: color.value };
        await api(p ? `/api/projects/${p.id}` : "/api/projects", { method: p ? "PUT" : "POST", body });
        await reloadProjects(); toast("Gespeichert"); dlg.close(); reload();
      }) }, "Speichern")
    ]
  });
}
