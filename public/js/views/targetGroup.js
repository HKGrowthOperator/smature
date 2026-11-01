// Zielgruppe im Detail: Angaben, Wissen (Info-Blätter), KI-Profil, KI-Sequenz → neue Kampagne.
import { h, clear, api, modal, field, input, textarea, select, busy, toast, confirmDialog, icon, relTime, state, skeletonRows, aiMissingText, LEGAL_OPTIONS, projectSelect, checkbox } from "../lib.js";
import { docsCard } from "../components/knowledge.js";

export async function render(el, [id]) {
  clear(el, h("div", { class: "content" }, skeletonRows(5)));
  const reload = async () => draw(el, await api(`/api/target-groups/${id}`));
  await reload();
}

function draw(el, tg) {
  const reload = async () => draw(el, await api(`/api/target-groups/${tg.id}`));
  const f = {
    name: input({ value: tg.name }),
    language: select([["de", "Deutsch"], ["en", "Englisch"]], tg.language),
    project_id: projectSelect(tg.project_id),
    description: textarea({ value: tg.description, rows: 3, placeholder: "Wer genau? Branche, Größe, Region, Entscheider-Rollen" }),
    offer: textarea({ value: tg.offer, rows: 3, placeholder: "Was bieten wir genau dieser Zielgruppe an? Welches Ergebnis?" }),
    tone: textarea({ value: tg.tone, rows: 2, placeholder: "z. B. Sie-Form, bodenständig, keine Anglizismen" }),
    cta: input({ value: tg.cta, placeholder: "z. B. 15-minütiges Kennenlern-Telefonat" }),
    profile: textarea({ value: tg.profile, rows: 18, class: "textarea code", placeholder: "Wird von der KI aus dem Wissen erzeugt – oder selbst schreiben." })
  };
  // Geteilte Zielgruppe: gilt zusätzlich in weiteren Projekten (Kampagnen laufen dort trotzdem getrennt).
  const also = (state.projects || []).map(p => ({ id: p.id, box: checkbox(p.name, (tg.also_project_ids || []).includes(p.id)) }));
  const syncAlso = () => also.forEach(a => { const main = String(a.id) === String(f.project_id.value); a.box.style.display = main ? "none" : ""; if (main) a.box.input.checked = false; });
  f.project_id.addEventListener("change", syncAlso);
  syncAlso();
  const save = () => api(`/api/target-groups/${tg.id}`, { method: "PUT", body: { name: f.name.value, project_id: f.project_id.value || null, also_project_ids: also.filter(a => a.box.input.checked).map(a => a.id), language: f.language.value, description: f.description.value, offer: f.offer.value, tone: f.tone.value, cta: f.cta.value, profile: f.profile.value } });

  const aiOn = state.meta?.ai_available;
  clear(el,
    h("div", { class: "page-head" },
      h("div", null, h("div", { class: "crumb" }, h("a", { href: "#/zielgruppen" }, "Zielgruppen"), " / "), h("h1", null, tg.name)),
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: e => busy(e.currentTarget, async () => { await save(); toast("Gespeichert"); }) }, "Speichern"),
        h("button", { class: "btn btn-primary", disabled: !aiOn, title: aiOn ? "" : aiMissingText, onclick: e => busy(e.currentTarget, () => openGenerate(tg, save)) }, icon("sparkles"), "Sequenz mit KI erstellen"))),
    h("div", { class: "content" }, h("div", { class: "split" },
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Angaben")),
          h("div", { class: "card-body form-grid" },
            field("Name", f.name), field("Sprache", f.language), field("Projekt", f.project_id),
            also.length > 1 ? h("div", { class: "full" }, field("Gilt auch in", h("div", { class: "row-tight" }, also.map(a => a.box)), "Gleiche Zielgruppe für mehrere Projekte, z. B. Webseite und Webseite/Automation. Kampagnen und Produkte bleiben je Projekt getrennt.")) : null,
            h("div", { class: "full" }, field("Beschreibung", f.description)),
            h("div", { class: "full" }, field("Angebot für diese Zielgruppe", f.offer)),
            field("Tonalität & Ansprache", f.tone), field("Gewünschter nächster Schritt (CTA)", f.cta))),
        h("div", { class: "card" },
          h("div", { class: "card-head" }, h("h2", null, "Zielgruppen-Profil"), tg.profile_updated_at ? h("span", { class: "muted small" }, `aktualisiert ${relTime(tg.profile_updated_at)}`) : null,
            h("div", { class: "actions" }, h("button", { class: "btn btn-sm", disabled: !aiOn || !tg.docs.length, title: !tg.docs.length ? "Zuerst Wissen hochladen" : "", onclick: e => busy(e.currentTarget, async () => {
              if (f.profile.value.trim() && !(await confirmDialog("Das bestehende Profil wird durch eine neue KI-Fassung ersetzt.", { confirm: "Neu erstellen" }))) return;
              await save();
              const updated = await api(`/api/target-groups/${tg.id}/distill`, { method: "POST" });
              toast("Profil erstellt");
              draw(el, updated);
            }) }, icon("sparkles"), "Aus Wissen erstellen"))),
          h("div", { class: "card-body stack-sm" },
            h("div", { class: "hint" }, "Das Profil ist die kompakte Grundlage für alle KI-Texte dieser Zielgruppe (Schmerzpunkte, Nutzen, Belege, Einwände, Tonalität). Du kannst es jederzeit von Hand anpassen."),
            f.profile))),
      h("div", { class: "stack" },
        docsCard({ base: `/api/target-groups/${tg.id}`, docs: tg.docs, reload }),
        h("div", { class: "card card-pad small muted" }, `Verwendet in ${tg.campaigns} Kampagne${tg.campaigns === 1 ? "" : "n"} und ${tg.lists} Lead-Liste${tg.lists === 1 ? "" : "n"}.`,
          h("div", { style: { marginTop: "8px" } }, h("button", { class: "btn btn-sm btn-danger", onclick: e => busy(e.currentTarget, async () => {
            if (!(await confirmDialog(`Zielgruppe „${tg.name}“ samt Wissen löschen? Kampagnen bleiben erhalten.`, { danger: true, confirm: "Löschen" }))) return;
            await api(`/api/target-groups/${tg.id}`, { method: "DELETE" });
            location.hash = "#/zielgruppen";
          }) }, "Zielgruppe löschen")))))));
}

async function openGenerate(tg, save) {
  const products = await api("/api/products");
  const product = select([["", "– ohne Produkt –"], ...products.map(p => [p.id, p.name])], products[0]?.id || "");
  const legal = select(LEGAL_OPTIONS, "consent");
  const steps = select([1, 2, 3, 4, 5, 6].map(n => [n, `${n} Mail${n === 1 ? "" : "s"}`]), 3);
  const goal = input({ placeholder: "z. B. Kennenlern-Telefonat vereinbaren" });
  const notes = textarea({ rows: 3, placeholder: "Optional: Anlass, Aufhänger, was vermieden werden soll …" });
  const out = h("div");
  let result = null;
  const createBtn = h("button", { class: "btn btn-primary", disabled: true, onclick: e => busy(e.currentTarget, async () => {
    const campaign = await api("/api/campaigns", { method: "POST", body: {
      name: result.campaign_name || `${tg.name} – Sequenz`, target_group_id: tg.id, product_id: product.value ? Number(product.value) : null, legal_basis: legal.value,
      nurture_texts: result.nurture || [],
      steps: result.steps.map(s => ({ delay_days: s.delay_days, variants: [{ subject: s.subject, body: s.body }, ...(s.variant_b_body ? [{ subject: s.variant_b_subject, body: s.variant_b_body }] : [])] }))
    } });
    toast("Kampagne angelegt");
    dlg.close();
    location.hash = `#/kampagnen/${campaign.id}/sequenz`;
  }) }, "Als neue Kampagne anlegen");
  const dlg = modal({
    title: `Sequenz für „${tg.name}“ erstellen`, wide: true,
    body: h("div", { class: "stack" },
      h("div", { class: "form-grid" }, field("Produkt", product), field("Rechtsgrundlage", legal), field("Anzahl Mails", steps), field("Ziel der Kampagne", goal), h("div", { class: "full" }, field("Hinweise", notes))),
      h("div", { class: "hint" }, tg.profile ? "Grundlage: Zielgruppen-Profil, Angebot und deine Absender-Beschreibung (Einstellungen)." : "Tipp: Erst „Profil aus Wissen erstellen“ – dann werden die Mails deutlich konkreter."),
      out),
    footer: [
      h("button", { class: "btn left", onclick: e => busy(e.currentTarget, async () => {
        await save();
        clear(out, h("div", { class: "stack-sm" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "small muted" }, "Die KI schreibt … (ca. 20–60 Sekunden)")));
        try {
          result = await api(`/api/target-groups/${tg.id}/generate-sequence`, { method: "POST", body: { steps: Number(steps.value), goal: goal.value, notes: notes.value, product_id: product.value ? Number(product.value) : null, legal_basis: legal.value } });
          clear(out, h("div", { class: "stack" }, result.steps.map((s, i) => h("div", { class: "card" },
            h("div", { class: "card-head" }, h("span", { class: "step-num" }, String(i + 1)), h("strong", null, i === 0 ? s.subject : (s.subject || "Antwort im Thread")), i > 0 ? h("span", { class: "muted small" }, `nach ${s.delay_days} Tagen`) : null),
            h("div", { class: "card-body grid-2" },
              h("div", null, h("div", { class: "label" }, "Variante A"), h("div", { class: "pre small", style: { marginTop: "4px" } }, s.body)),
              h("div", null, h("div", { class: "label" }, `Variante B${s.variant_b_subject ? ` – ${s.variant_b_subject}` : ""}`), h("div", { class: "pre small", style: { marginTop: "4px" } }, s.variant_b_body)))))));
          createBtn.disabled = false;
        } catch (err) {
          clear(out, h("div", { class: "alert danger" }, err.message));
        }
      }) }, icon("sparkles"), "Generieren"),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Schließen"),
      createBtn
    ]
  });
}
