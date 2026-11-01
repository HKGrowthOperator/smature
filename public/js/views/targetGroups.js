// Zielgruppen-Übersicht.
import { h, clear, api, modal, field, input, textarea, select, busy, icon, emptyState, skeletonRows, relTime, state, projectSelect, projectDot } from "../lib.js";

export async function render(el) {
  clear(el, header(), h("div", { class: "content" }, skeletonRows(3)));
  const list = await api("/api/target-groups");
  const preset = state.query?.get("projekt");
  if (preset) setTimeout(() => openCreate(preset), 0);
  const project = id => (state.projects || []).find(p => p.id === id);
  clear(el, header(), h("div", { class: "content stack" },
    h("div", { class: "alert info" }, "Pro Zielgruppe hinterlegst du Wissen (Info-Blätter als PDF, Text oder Markdown). Die KI verdichtet es zu einem Profil und schreibt daraus Sequenzen und personalisierte Mails."),
    list.length ? h("div", { class: "grid-3" }, list.map(tg => h("a", { class: "card card-pad stack-sm", href: `#/zielgruppen/${tg.id}`, style: { color: "inherit", textDecoration: "none" } },
      h("div", { class: "row" }, h("h2", { class: "grow" }, tg.name), h("span", { class: "badge plain" }, tg.language === "en" ? "EN" : "DE")),
      h("div", { class: "row-tight" }, projectDot(project(tg.project_id)?.color, project(tg.project_id)?.name),
        (tg.also_project_ids || []).map(id => projectDot(project(id)?.color, project(id)?.name))),
      h("p", { class: "muted small", style: { minHeight: "38px" } }, tg.description ? tg.description.slice(0, 160) : "Keine Beschreibung"),
      h("div", { class: "row small muted" },
        h("span", null, `${tg.doc_count} Dokument${tg.doc_count === 1 ? "" : "e"}`), h("span", null, `${tg.campaign_count} Kampagne${tg.campaign_count === 1 ? "" : "n"}`),
        tg.profile ? h("span", { class: "badge ok" }, "Profil vorhanden") : h("span", { class: "badge warn" }, "kein Profil")),
      h("div", { class: "small muted" }, `Geändert ${relTime(tg.updated_at)}`))))
      : h("div", { class: "card" }, emptyState("Noch keine Zielgruppe", "Lege für jede Zielgruppe (z. B. „Handwerksbetriebe Oberberg“, „Steuerberater“, „Vereine“) eine eigene Seite an und lade deine Info-Blätter hoch.", h("button", { class: "btn btn-primary", onclick: () => openCreate() }, icon("plus"), "Zielgruppe anlegen")))));
}

function header() {
  return h("div", { class: "page-head" }, h("h1", null, "Zielgruppen & Wissen"), h("div", { class: "actions" }, h("button", { class: "btn btn-primary", onclick: () => openCreate() }, icon("plus"), "Zielgruppe anlegen")));
}

function openCreate(presetProject = "") {
  const name = input({ placeholder: "z. B. Handwerksbetriebe im Oberbergischen" });
  const project = projectSelect(typeof presetProject === "string" || typeof presetProject === "number" ? presetProject : "");
  const description = textarea({ rows: 3, placeholder: "Wer genau? Branche, Größe, Region, Entscheider" });
  const language = select([["de", "Deutsch"], ["en", "Englisch"]], "de");
  const dlg = modal({
    title: "Zielgruppe anlegen",
    body: h("div", { class: "stack" }, field("Name", name), field("Projekt", project), field("Beschreibung", description), field("Sprache der Mails", language)),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const tg = await api("/api/target-groups", { method: "POST", body: { name: name.value, project_id: project.value || null, description: description.value, language: language.value } });
      dlg.close();
      location.hash = `#/zielgruppen/${tg.id}`;
    }) }, "Anlegen")]
  });
}
