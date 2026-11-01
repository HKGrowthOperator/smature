// Produkte-Übersicht: für jedes Produkt eigene Mail-Vorlagen mit Info-Kit und Termin-Link.
import { h, clear, api, modal, field, input, textarea, busy, icon, emptyState, skeletonRows, relTime, state, projectSelect, projectDot } from "../lib.js";

export async function render(el) {
  clear(el, header(), h("div", { class: "content" }, skeletonRows(3)));
  const list = await api("/api/products");
  const preset = state.query?.get("projekt");
  if (preset) setTimeout(() => openCreate(preset), 0);
  const project = id => (state.projects || []).find(p => p.id === id);
  clear(el, header(), h("div", { class: "content stack" },
    h("div", { class: "alert info" }, "Pro Produkt hinterlegst du Angebot, ideale Kunden, Info-Kit und Termin-Link. Daraus entstehen Mail-Vorlagen, die du prüfst und freigibst – erst dann können Kampagnen damit starten."),
    list.length ? h("div", { class: "grid-3" }, list.map(p => h("a", { class: "card card-pad stack-sm", href: `#/produkte/${p.id}`, style: { color: "inherit", textDecoration: "none" } },
      h("div", { class: "row" }, icon("box"), h("h2", { class: "grow" }, p.name)),
      projectDot(project(p.project_id)?.color, project(p.project_id)?.name),
      h("p", { class: "muted small", style: { minHeight: "38px" } }, p.description ? p.description.slice(0, 160) : "Keine Beschreibung"),
      h("div", { class: "row small muted", style: { flexWrap: "wrap" } },
        p.booking_url ? h("span", { class: "badge ok" }, "Termin-Link") : h("span", { class: "badge warn" }, "kein Termin-Link"),
        p.kit_url ? h("span", { class: "badge ok" }, "Info-Kit") : h("span", { class: "badge" }, "kein Kit"),
        h("span", null, `${p.approved_template_count}/${p.template_count} Vorlagen freigegeben`),
        h("span", null, `${p.campaign_count} Kampagne${p.campaign_count === 1 ? "" : "n"}`)),
      h("div", { class: "small muted" }, `Geändert ${relTime(p.updated_at)}`))))
      : h("div", { class: "card" }, emptyState("Noch kein Produkt", "Lege für jedes Angebot (z. B. „Website-Paket“, „SEO-Betreuung“, „Recruiting-Kampagne“) ein Produkt an – mit Info-Kit, Termin-Link und Wissen.", h("button", { class: "btn btn-primary", onclick: () => openCreate() }, icon("plus"), "Produkt anlegen")))));
}

function header() {
  return h("div", { class: "page-head" }, h("h1", null, "Produkte"), h("div", { class: "actions" }, h("button", { class: "btn btn-primary", onclick: () => openCreate() }, icon("plus"), "Produkt anlegen")));
}

function openCreate(presetProject = "") {
  const name = input({ placeholder: "z. B. Website-Paket für Handwerker" });
  const project = projectSelect(typeof presetProject === "string" || typeof presetProject === "number" ? presetProject : "");
  const description = textarea({ rows: 3, placeholder: "Was ist es, in 1–2 Sätzen?" });
  const booking = input({ type: "url", placeholder: "https://… (Calendly, Cal.com, eigene Sales App)" });
  const dlg = modal({
    title: "Produkt anlegen",
    body: h("div", { class: "stack" }, field("Name", name), field("Projekt", project, "In welcher Spalte des Projekte-Boards erscheint das Produkt?"), field("Kurzbeschreibung", description), field("Termin-Link (optional)", booking, "Landet als {{termin_link}} in Mails und Antwortentwürfen.")),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const p = await api("/api/products", { method: "POST", body: { name: name.value, project_id: project.value || null, description: description.value, booking_url: booking.value } });
      dlg.close();
      location.hash = `#/produkte/${p.id}`;
    }) }, "Anlegen")]
  });
}
