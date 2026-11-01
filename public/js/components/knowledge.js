// Wissen (Info-Blätter) für Zielgruppen und Produkte: Hochladen (PDF/Text/HTML), Liste, Text bearbeiten.
import { h, api, modal, field, input, textarea, busy, toast, confirmDialog, icon, readFileAs, fileSize, relTime } from "../lib.js";

// base: z. B. "/api/products/3"
export function docsCard({ base, docs, reload, empty = "Noch kein Wissen. Lade z. B. Info-Blätter, Preislisten, Referenzen, FAQs oder Gesprächsleitfäden hoch." }) {
  const drop = h("div", { class: "dropzone", tabindex: "0", role: "button" }, icon("upload"), h("div", { class: "strong", style: { marginTop: "6px" } }, "Info-Blätter hierher ziehen oder klicken"), h("div", { class: "small" }, "PDF, TXT, MD, HTML, CSV – bis 20 MB pro Datei"));
  const fileInput = h("input", { type: "file", multiple: true, accept: ".pdf,.txt,.md,.markdown,.html,.htm,.csv,text/*,application/pdf", hidden: true });
  const upload = async files => {
    for (const file of files) {
      const ext = file.name.split(".").pop().toLowerCase();
      try {
        if (ext === "pdf") await api(`${base}/docs`, { method: "POST", body: { kind: "pdf", title: file.name.replace(/\.pdf$/i, ""), file_name: file.name, data: await readFileAs(file, "base64") } });
        else await api(`${base}/docs`, { method: "POST", body: { kind: ["html", "htm"].includes(ext) ? "html" : "text", title: file.name.replace(/\.[^.]+$/, ""), file_name: file.name, content: await readFileAs(file) } });
        toast(`${file.name} hinzugefügt`);
      } catch (err) {
        toast(`${file.name}: ${err.message}`, "error");
      }
    }
    reload();
  };
  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); upload([...e.dataTransfer.files]); });
  fileInput.addEventListener("change", () => upload([...fileInput.files]));

  return h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", null, "Wissen"), h("span", { class: "muted small" }, `${docs.length} Dokument${docs.length === 1 ? "" : "e"}`),
      h("div", { class: "actions" }, h("button", { class: "btn btn-sm", onclick: () => openText(base, reload) }, icon("plus"), "Text einfügen"))),
    h("div", { class: "card-body stack" }, drop, fileInput,
      docs.length ? h("div", { class: "stack-sm" }, docs.map(d => h("div", { class: "row", style: { borderBottom: "1px solid var(--line)", paddingBottom: "8px" } },
        icon("file"),
        h("div", { class: "grow", style: { minWidth: 0 } }, h("div", { class: "strong ellipsis" }, d.title), h("div", { class: "small muted" }, d.kind === "pdf" ? `PDF · ${fileSize(d.size)}` : `Text · ${Number(d.chars || 0).toLocaleString("de-DE")} Zeichen`, " · ", relTime(d.created_at))),
        d.kind === "pdf"
          ? h("a", { class: "btn btn-sm btn-ghost", href: `${base}/docs/${d.id}`, download: d.file_name || "dokument.pdf", "aria-label": "Herunterladen" }, icon("download"))
          : h("button", { class: "btn btn-sm btn-ghost", "aria-label": "Bearbeiten", onclick: () => openText(base, reload, d) }, icon("edit")),
        h("button", { class: "btn btn-sm btn-ghost btn-danger", "aria-label": "Löschen", onclick: e => busy(e.currentTarget, async () => {
          if (!(await confirmDialog(`„${d.title}“ löschen?`, { danger: true, confirm: "Löschen" }))) return;
          await api(`${base}/docs/${d.id}`, { method: "DELETE" });
          reload();
        }) }, icon("trash")))))
        : h("p", { class: "muted small" }, empty)));
}

export async function openText(base, reload, doc = null) {
  const title = input({ value: doc?.title || "", placeholder: "z. B. Info-Blatt Handwerk" });
  const content = textarea({ rows: 16, placeholder: "Text einfügen …" });
  if (doc) content.value = (await api(`${base}/docs/${doc.id}`)).content;
  const dlg = modal({
    title: doc ? "Text bearbeiten" : "Text als Wissen einfügen", wide: true,
    body: h("div", { class: "stack" }, field("Titel", title), field("Inhalt", content)),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      if (doc) await api(`${base}/docs/${doc.id}`, { method: "PUT", body: { title: title.value, content: content.value } });
      else await api(`${base}/docs`, { method: "POST", body: { kind: "text", title: title.value || "Notiz", content: content.value } });
      dlg.close();
      reload();
    }) }, "Speichern")]
  });
}
