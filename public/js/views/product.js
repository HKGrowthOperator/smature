// Produkt im Detail: Angebot, Info-Kit, Termin-Link, Wissen, Profil, Nachfass-Texte, Mail-Vorlagen und Qualitätsprüfung der Leads.
import { h, clear, api, modal, field, input, textarea, select, busy, toast, confirmDialog, icon, relTime, state, skeletonRows, badge, approvalBadge, waitForJob, num, aiMissingText, checkbox, LEGAL_OPTIONS, projectSelect } from "../lib.js";
import { docsCard } from "../components/knowledge.js";

export async function render(el, [id]) {
  clear(el, h("div", { class: "content" }, skeletonRows(5)));
  draw(el, await api(`/api/products/${id}`));
}

function draw(el, p) {
  const reload = async () => draw(el, await api(`/api/products/${p.id}`));
  const aiOn = state.meta?.ai_available;
  const f = {
    name: input({ value: p.name }),
    project_id: projectSelect(p.project_id),
    description: textarea({ value: p.description, rows: 3, placeholder: "Was ist das Produkt? Was bekommt der Kunde?" }),
    offer: textarea({ value: p.offer, rows: 3, placeholder: "Nutzenversprechen: welches Ergebnis, in welcher Zeit?" }),
    icp: textarea({ value: p.icp, rows: 3, placeholder: "Wer passt (Branche, Größe, Region, Rolle) – und wer ausdrücklich nicht?" }),
    proof: textarea({ value: p.proof, rows: 3, placeholder: "Referenzen, Zahlen, Beispiele – nur Belegtes. Die KI erfindet nichts dazu." }),
    booking_url: input({ type: "url", value: p.booking_url, placeholder: "https://cal.com/… oder Sales-App-Link" }),
    kit_url: input({ type: "url", value: p.kit_url, placeholder: "https://…/info-kit.pdf" }),
    kit_label: input({ value: p.kit_label, placeholder: "z. B. Preisliste & Ablauf (PDF)" }),
    profile: textarea({ value: p.profile, rows: 14, class: "textarea code", placeholder: "Wird von der KI aus dem Wissen erzeugt – oder selbst schreiben." })
  };
  const nurture = p.nurture_texts.map(t => t.body);
  const nurtureBox = h("div", { class: "stack-sm" });
  const drawNurture = () => clear(nurtureBox,
    nurture.length ? nurture.map((text, i) => h("div", { class: "stack-sm" },
      h("div", { class: "row" }, h("strong", { class: "grow small" }, `Nachfassen ${i + 1}`), h("button", { class: "btn btn-sm btn-ghost btn-danger", "aria-label": "Entfernen", onclick: () => { nurture.splice(i, 1); drawNurture(); } }, icon("trash"))),
      textarea({ value: text, rows: 5, oninput: e => { nurture[i] = e.target.value; } })))
      : h("p", { class: "muted small" }, "Noch keine Nachfass-Texte. Sie werden gesendet, wenn jemand Interesse gezeigt hat, sich danach aber nicht mehr meldet."),
    nurture.length < 5 ? h("button", { class: "btn btn-sm", onclick: () => { nurture.push("{{anrede}},\n\nich wollte kurz nachhaken – passt ein kurzes Gespräch? Hier können Sie direkt einen Termin wählen: {{termin_link}}\n\nViele Grüße"); drawNurture(); } }, icon("plus"), "Nachfass-Text hinzufügen") : null);
  drawNurture();

  const save = () => api(`/api/products/${p.id}`, { method: "PUT", body: {
    name: f.name.value, project_id: f.project_id.value || null, description: f.description.value, offer: f.offer.value, icp: f.icp.value, proof: f.proof.value,
    booking_url: f.booking_url.value, kit_url: f.kit_url.value, kit_label: f.kit_label.value, profile: f.profile.value, nurture_texts: nurture.map(body => ({ body }))
  } });

  const fitTotal = Object.values(p.fit).reduce((a, b) => a + b, 0);
  clear(el,
    h("div", { class: "page-head" },
      h("div", null, h("div", { class: "crumb" }, h("a", { href: "#/produkte" }, "Produkte"), " / "), h("h1", null, p.name)),
      h("div", { class: "actions" },
        h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => { await save(); toast("Gespeichert"); reload(); }) }, "Speichern"))),
    h("div", { class: "content" }, h("div", { class: "split" },
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Angebot")),
          h("div", { class: "card-body form-grid" },
            field("Name", f.name), field("Projekt", f.project_id),
            h("div", { class: "full" }, field("Beschreibung", f.description)),
            h("div", { class: "full" }, field("Nutzen / Angebot", f.offer)),
            h("div", { class: "full" }, field("Ideale Kunden (und Ausschlüsse)", f.icp, "Grundlage der KI-Qualitätsprüfung (A–D).")),
            h("div", { class: "full" }, field("Belege", f.proof)))),
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Termin-Link & Info-Kit")),
          h("div", { class: "card-body form-grid" },
            h("div", { class: "full" }, field("Termin-Link", f.booking_url, "In Mails als {{termin_link}}. Buchungen per Webhook zurückmelden (Einstellungen → Termine), dann stoppt alles automatisch.")),
            field("Info-Kit-Link", f.kit_url, "In Mails als {{kit_link}} – z. B. PDF auf eurer Website."), field("Bezeichnung des Kits", f.kit_label, "{{kit_name}}"))),
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Nachfass-Texte (Standard)")),
          h("div", { class: "card-body stack-sm" }, h("div", { class: "hint" }, "Vorschlag für neue Vorlagen. Automatisch gesendet werden nur die Nachfass-Texte einer freigegebenen Kampagne."), nurtureBox)),
        h("div", { class: "card" },
          h("div", { class: "card-head" }, h("h2", null, "Produkt-Profil"),
            h("div", { class: "actions" }, h("button", { class: "btn btn-sm", disabled: !aiOn || (!p.docs.length && !p.description), title: aiOn ? "" : aiMissingText, onclick: e => busy(e.currentTarget, async () => {
              if (f.profile.value.trim() && !(await confirmDialog("Das bestehende Profil wird durch eine neue KI-Fassung ersetzt.", { confirm: "Neu erstellen" }))) return;
              await save();
              draw(el, await api(`/api/products/${p.id}/distill`, { method: "POST" }));
              toast("Profil erstellt");
            }) }, icon("sparkles"), "Aus Wissen erstellen"))),
          h("div", { class: "card-body stack-sm" }, h("div", { class: "hint" }, "Kompakte Grundlage für alle KI-Texte zu diesem Produkt: Nutzen, Belege, Einwände, was im Kit steht."), f.profile))),
      h("div", { class: "stack" },
        h("div", { class: "card" },
          h("div", { class: "card-head" }, h("h2", null, "Mail-Vorlagen"),
            h("div", { class: "actions" },
              h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { await save(); const t = await api(`/api/products/${p.id}/templates`, { method: "POST", body: {} }); location.hash = `#/kampagnen/${t.id}/sequenz`; }) }, icon("plus"), "Leer"),
              h("button", { class: "btn btn-sm btn-primary", disabled: !aiOn, title: aiOn ? "" : aiMissingText, onclick: () => openGenerate(p, save) }, icon("sparkles"), "Mit KI"))),
          h("div", { class: "card-body stack-sm" },
            p.templates.length ? p.templates.map(t => h("div", { class: "row", style: { borderBottom: "1px solid var(--line)", paddingBottom: "8px", flexWrap: "wrap" } },
              h("div", { class: "grow", style: { minWidth: "180px" } },
                h("a", { class: "strong", href: `#/kampagnen/${t.id}/sequenz` }, t.name),
                h("div", { class: "small muted" }, `${t.steps.length} Mail${t.steps.length === 1 ? "" : "s"} · ${t.nurture_texts.length} Nachfass-Text${t.nurture_texts.length === 1 ? "" : "e"}`, t.target_group ? ` · ${t.target_group.name}` : "")),
              badge("legal", t.legal_basis), approvalBadge(t.approval),
              h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, () => createCampaign(p, t)) }, "Kampagne erstellen")))
              : h("p", { class: "muted small" }, "Noch keine Vorlage. Lass die KI aus Produkt- und Zielgruppenwissen eine Sequenz samt Nachfass-Texten schreiben – danach prüfen, anpassen und freigeben."))),
        h("div", { class: "card" },
          h("div", { class: "card-head" }, h("h2", null, "Qualität der Leads"), h("span", { class: "muted small" }, `${num(fitTotal)} geprüft`),
            h("div", { class: "actions" }, h("button", { class: "btn btn-sm", disabled: !aiOn, title: aiOn ? "" : aiMissingText, onclick: () => openQualify(p, reload) }, icon("sparkles"), "Leads prüfen"))),
          h("div", { class: "card-body stack-sm" },
            h("div", { class: "row", style: { flexWrap: "wrap" } }, ["A", "B", "C", "D"].map(k => h("span", null, badge("fit", k), " ", h("strong", null, num(p.fit[k]))))),
            h("div", { class: "hint" }, "Die KI vergleicht Firma, Website und Notizen mit den idealen Kunden und dokumentiert den konkreten Anlass. In Kampagnen lässt sich festlegen, dass nur A/B-Leads angeschrieben werden."))),
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Kampagnen")),
          h("div", { class: "card-body stack-sm" }, p.campaigns.length ? p.campaigns.map(c => h("div", { class: "row" }, h("a", { class: "grow", href: `#/kampagnen/${c.id}` }, c.name), badge("legal", c.legal_basis), badge("campaign", c.status), h("span", { class: "small muted" }, `${num(c.leads)} Leads`)))
            : h("p", { class: "muted small" }, "Noch keine Kampagne – aus einer freigegebenen Vorlage erstellen."))),
        docsCard({ base: `/api/products/${p.id}`, docs: p.docs, reload }),
        h("div", { class: "card card-pad" }, h("button", { class: "btn btn-sm btn-danger", onclick: e => busy(e.currentTarget, async () => {
          if (!(await confirmDialog(`Produkt „${p.name}“ samt Wissen und Vorlagen löschen? Kampagnen bleiben erhalten.`, { danger: true, confirm: "Löschen" }))) return;
          await api(`/api/products/${p.id}`, { method: "DELETE" });
          location.hash = "#/produkte";
        }) }, "Produkt löschen"))))));
}

async function createCampaign(p, t) {
  const mailboxes = await api("/api/mailboxes");
  const name = input({ value: `${t.name} ${new Date().toLocaleDateString("de-DE")}` });
  const boxes = mailboxes.map(m => checkbox(m.email, m.status === "active", `${m.daily_limit}/Tag${m.imap_configured ? "" : " · ohne IMAP"}`, { value: m.id }));
  const dlg = modal({
    title: "Kampagne aus Vorlage erstellen",
    body: h("div", { class: "stack" },
      t.approval.approved ? h("div", { class: "alert ok" }, "Die Vorlage ist freigegeben – die Kampagne übernimmt die Freigabe, solange die Texte unverändert bleiben.") : h("div", { class: "alert warn" }, "Die Vorlage ist noch nicht freigegeben. Die Kampagne kann erst starten, wenn die Texte freigegeben sind."),
      field("Name", name),
      h("div", { class: "field" }, h("span", { class: "label" }, "Postfächer"), mailboxes.length ? boxes : h("div", { class: "alert warn" }, "Noch kein Postfach verbunden."))),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const c = await api(`/api/products/${p.id}/templates/${t.id}/campaign`, { method: "POST", body: { name: name.value, mailbox_ids: boxes.filter(b => b.input.checked).map(b => Number(b.input.value)) } });
      dlg.close();
      location.hash = `#/kampagnen/${c.id}/leads`;
    }) }, "Erstellen")]
  });
}

async function openGenerate(p, save) {
  const groups = await api("/api/target-groups");
  const group = select([["", "– ohne Zielgruppe –"], ...groups.map(g => [g.id, g.name])], groups[0]?.id || "");
  const legal = select(LEGAL_OPTIONS, "consent");
  const steps = select([1, 2, 3, 4, 5, 6].map(n => [n, `${n} Mail${n === 1 ? "" : "s"}`]), 3);
  const goal = input({ placeholder: "z. B. Erstgespräch über den Termin-Link buchen" });
  const notes = textarea({ rows: 3, placeholder: "Optional: Anlass, Aufhänger, was vermieden werden soll …" });
  const name = input({ placeholder: `${p.name} – Vorlage` });
  // Einstiegsangebot: was der Empfänger in der ersten Mail konkret bekommt (nur antworten nötig).
  const types = state.meta?.offer_types || {};
  const offerType = select([["", "– KI wählt passend –"], ...Object.entries(types).map(([k, o]) => [k, o.label])], "");
  const offerHint = h("div", { class: "hint" });
  const updateOffer = () => { offerHint.textContent = types[offerType.value]?.hint || "Die erste Mail bietet etwas Konkretes, für das der Empfänger nur antworten muss – kein Verkaufsangebot, keine Preise."; };
  offerType.addEventListener("change", updateOffer); updateOffer();
  const entryOffer = textarea({ rows: 2, placeholder: "z. B. „Kurze Einschätzung Ihrer Startseite mit drei konkreten Hebeln – schicke ich Ihnen gern, wenn Sie kurz antworten.“" });
  const ideas = h("div", { class: "stack-sm" });
  const ideaBtn = h("button", { type: "button", class: "btn btn-sm", disabled: !state.meta?.ai_available, onclick: e => busy(e.currentTarget, async () => {
    clear(ideas, h("div", { class: "skeleton" }), h("div", { class: "small muted" }, "Die KI sucht Einstiegsangebote … (ca. 20–40 Sekunden)"));
    try {
      const r = await api(`/api/products/${p.id}/offer-ideas`, { method: "POST", body: { target_group_id: group.value ? Number(group.value) : null, notes: notes.value } });
      clear(ideas, ...r.offers.map(o => h("button", { type: "button", class: "card card-pad offer-idea", onclick: ev => { offerType.value = o.type; updateOffer(); entryOffer.value = o.text; ideas.querySelectorAll(".offer-idea").forEach(x => x.classList.remove("active")); ev.currentTarget.classList.add("active"); } },
        h("div", { class: "row-tight" }, h("span", { class: "badge" }, types[o.type]?.label || o.type), h("strong", null, o.title)),
        h("div", null, o.text),
        h("div", { class: "small muted" }, o.why, o.effort ? ` · Aufwand je Antwort: ${o.effort}` : ""),
        o.caution ? h("div", { class: "small warn-text" }, `Achtung: ${o.caution}`) : null)));
    } catch (err) { clear(ideas, h("div", { class: "alert danger" }, err.message)); }
  }) }, icon("sparkles"), "Einstiegsangebote vorschlagen");
  const legalHint = h("div", { class: "hint" });
  const updateHint = () => { legalHint.textContent = legal.value === "cold" ? "Kaltakquise: höchstens 3 Mails, mind. 4 Tage Abstand, besonders zurückhaltend. Rechtlich riskant – siehe Richtlinien." : "Für Kontakte mit dokumentierter Einwilligung bzw. Bestandskunden."; };
  legal.addEventListener("change", updateHint); updateHint();
  const out = h("div");
  const dlg = modal({
    title: `Vorlage für „${p.name}“ mit KI erstellen`, wide: true,
    body: h("div", { class: "stack" },
      h("div", { class: "form-grid" }, field("Zielgruppe", group), field("Rechtsgrundlage", legal), h("div", { class: "full" }, legalHint), field("Anzahl Mails", steps), field("Ziel", goal),
        field("Einstiegsangebot", offerType), h("div", { class: "full" }, offerHint),
        h("div", { class: "full" }, field("Was bekommt der Empfänger konkret? (optional)", entryOffer)),
        h("div", { class: "full" }, h("div", { class: "row" }, ideaBtn, h("span", { class: "small muted" }, "Ideen mit der Prüfung: Würde man antworten? Nur antworten nötig? Konkret? Können wir das liefern?"))),
        h("div", { class: "full" }, ideas),
        h("div", { class: "full" }, field("Hinweise", notes)), h("div", { class: "full" }, field("Name der Vorlage", name))),
      h("div", { class: "hint" }, p.profile ? "Grundlage: Produkt-Profil, Zielgruppen-Profil, Termin-Link und Info-Kit." : "Tipp: Erst „Produkt-Profil aus Wissen erstellen“ – dann werden die Mails deutlich konkreter."),
      out),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Schließen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      await save();
      clear(out, h("div", { class: "stack-sm" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" }), h("div", { class: "small muted" }, "Die KI schreibt Sequenz und Nachfass-Texte … (ca. 30–90 Sekunden)")));
      try {
        const r = await api(`/api/products/${p.id}/generate`, { method: "POST", body: { save: true, name: name.value, target_group_id: group.value ? Number(group.value) : null, legal_basis: legal.value, steps: Number(steps.value), goal: goal.value, notes: notes.value, offer_type: offerType.value, entry_offer: entryOffer.value } });
        toast("Vorlage erstellt – bitte prüfen und freigeben");
        dlg.close();
        location.hash = `#/kampagnen/${r.template.id}/sequenz`;
      } catch (err) {
        clear(out, h("div", { class: "alert danger" }, err.message));
      }
    }) }, icon("sparkles"), "Vorlage erstellen")]
  });
}

async function openQualify(p, reload) {
  const lists = await api("/api/lists");
  const list = select([["", "Liste wählen …"], ...lists.map(l => [l.id, `${l.name} (${l.lead_count})`])], "");
  const onlyNew = checkbox("Nur noch nicht geprüfte Leads", true);
  const progress = h("div");
  const dlg = modal({
    title: `Leads für „${p.name}“ prüfen`,
    body: h("div", { class: "stack" },
      h("p", { class: "small" }, "Die KI bewertet jede Firma (A sehr gut – D passt nicht) und notiert den konkreten Anlass. Das schützt vor Streuversand: Kaltakquise nur an Firmen mit erkennbarem Bedarf."),
      field("Lead-Liste", list), onlyNew,
      h("div", { class: "hint" }, "Jede Prüfung ist eine KI-Anfrage und zählt gegen das Kontingent des Max-Abos (Tageslimit in den Einstellungen)."),
      progress),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Schließen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      if (!list.value) throw new Error("Bitte eine Liste wählen");
      const job = await api(`/api/products/${p.id}/qualify`, { method: "POST", body: { list_id: Number(list.value), only_unchecked: onlyNew.input.checked } });
      const done = await waitForJob(job.id, j => clear(progress, h("div", { class: "stack-sm" }, h("div", { class: "bar" }, h("span", { style: { width: `${j.total ? (j.done + j.failed) / j.total * 100 : 0}%` } })), h("div", { class: "small muted" }, `${num(j.done)} von ${num(j.total)} geprüft${j.failed ? ` · ${j.failed} Fehler` : ""}`))));
      const res = Object.entries(done.results).map(([k, n]) => `${k}: ${n}`).join(" · ");
      clear(progress, h("div", { class: ["alert", done.status === "done" ? "ok" : "warn"] }, done.status === "done" ? `Fertig. ${res}` : `Angehalten: ${done.error || done.status}. ${res}`));
      reload();
    }) }, "Prüfung starten")]
  });
}
