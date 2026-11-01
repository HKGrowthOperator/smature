// Leads: Liste mit Filtern, CSV-Import mit Spaltenzuordnung, Prüfung, Listen, Blockliste, Detail mit DSGVO-Löschung.
import { h, clear, api, modal, drawer, field, input, textarea, select, checkbox, busy, toast, confirmDialog, badge, num, dateTime, relTime, icon, emptyState, pager, readFileAs, debounce, skeletonRows, state, waitForJob, aiMissingText, noteTagToast } from "../lib.js";

const FIELD_LABELS = { email: "E-Mail", salutation: "Anrede", first_name: "Vorname", last_name: "Nachname", company: "Firma", position: "Position", website: "Website", phone: "Telefon", city: "Stadt", country: "Land", industry: "Branche", linkedin: "LinkedIn", source: "Datenquelle", notes: "Notizen" };

export async function render(el, [tab]) {
  const current = ["listen", "blockliste"].includes(tab) ? tab : "leads";
  const presetList = /^liste-(\d+)$/.exec(tab || "")?.[1] || "";
  const body = h("div");
  clear(el,
    h("div", { class: "page-head" }, h("h1", null, "Leads"),
      h("div", { class: "actions" },
        h("button", { class: "btn", onclick: () => openImport(() => { location.hash = "#/leads"; drawTab(); }) }, icon("upload"), "CSV importieren"),
        h("button", { class: "btn btn-primary", onclick: () => openLead(null, drawTab) }, icon("plus"), "Lead"))),
    h("div", { class: "content" },
      h("div", { class: "tabs", role: "tablist" }, [["leads", "Alle Leads", "#/leads"], ["listen", "Listen", "#/leads/listen"], ["blockliste", "Blockliste", "#/leads/blockliste"]]
        .map(([k, label, href]) => h("a", { class: ["tab", k === current && "active"], href, role: "tab" }, label))),
      body));
  async function drawTab() {
    clear(body, skeletonRows(6));
    if (current === "listen") return drawLists(body);
    if (current === "blockliste") return drawBlocklist(body);
    return drawLeads(body, presetList);
  }
  await drawTab();
}

// ---------- Alle Leads ----------
async function drawLeads(body, presetList = "") {
  const [lists, campaigns, products] = await Promise.all([api("/api/lists"), api("/api/campaigns"), api("/api/products")]);
  const st = { q: "", list: presetList, project: "", status: "", verify: "", consent: "", product: products[0]?.id ? String(products[0].id) : "", fit: "", page: 1, selected: new Set() };
  const projectSel = select([["", "Alle Projekte"], ...(state.projects || []).map(p => [p.id, p.name]), ["none", "Ohne Projekt"]], "");
  const search = input({ placeholder: "Suchen (E-Mail, Name, Firma)", type: "search", class: "input", style: { maxWidth: "280px" } });
  const listSel = select([["", "Alle Listen"], ...lists.map(l => [l.id, `${l.name} (${l.lead_count})`])], presetList);
  const statusSel = select([["", "Alle Status"], ["active", "Aktiv"], ["unsubscribed", "Abgemeldet"], ["bounced", "Bounce"], ["blocked", "Gesperrt"], ["warm", "Warm (Interesse, Termin, Klick) – für die Sales App"]], "");
  const verifySel = select([["", "Alle Prüfungen"], ["valid", "Gültig"], ["risky", "Riskant"], ["invalid", "Ungültig"], ["unknown", "Ungeprüft"]], "");
  const consentSel = select([["", "Einwilligung: alle"], ...Object.entries(state.meta?.consent_statuses || {})], "");
  const productSel = select([["", "Produkt (Qualität) –"], ...products.map(p => [p.id, p.name])], st.product);
  const fitSel = select([["", "Qualität: alle"], ["AB", "A/B – passend"], ["A", "nur A"], ["C", "C – unklar"], ["D", "D – passt nicht"], ["unchecked", "ungeprüft"]], "");
  const tableBox = h("div");
  const exportLink = h("a", { class: "btn", href: "/api/leads/export", title: "CSV mit den aktuellen Filtern – z. B. „Warm“ für die Übergabe an die Sales App (dort Datei hochladen und Spalten zuordnen)" }, icon("download"), "Export");

  const reload = async () => {
    const qs = new URLSearchParams({ page: st.page, limit: 50 });
    for (const k of ["q", "list", "project", "status", "verify", "consent", "product"]) if (st[k]) qs.set(k, st[k]);
    if (st.fit && st.product) qs.set("fit", st.fit);
    exportLink.href = `/api/leads/export?${new URLSearchParams([...qs].filter(([k]) => !["page", "limit"].includes(k)))}`;
    const res = await api(`/api/leads?${qs}`);
    const allBox = h("input", { type: "checkbox", "aria-label": "Alle auswählen", checked: res.items.length && res.items.every(l => st.selected.has(l.id)), onchange: e => { for (const l of res.items) e.target.checked ? st.selected.add(l.id) : st.selected.delete(l.id); reload(); } });
    const bulk = st.selected.size ? h("div", { class: "bulkbar" }, h("strong", null, `${st.selected.size} ausgewählt`),
      h("button", { class: "btn btn-sm", onclick: () => bulkToList([...st.selected], lists, reload) }, "Zu Liste"),
      h("button", { class: "btn btn-sm", onclick: () => bulkToCampaign([...st.selected], campaigns) }, "Zu Kampagne"),
      h("button", { class: "btn btn-sm", onclick: () => bulkConsent([...st.selected], reload) }, "Einwilligung setzen"),
      h("button", { class: "btn btn-sm", title: "Firmen fest einem Projekt zuordnen – Kampagnen anderer Projekte nehmen sie nicht auf", onclick: () => bulkProject([...st.selected], reload) }, "Projekt zuordnen"),
      h("button", { class: "btn btn-sm", onclick: () => bulkQualify([...st.selected], products, reload) }, icon("sparkles"), "Qualität prüfen"),
      h("button", { class: "btn btn-sm", title: "KI prüft jeden Lead gegen alle Projekte und legt ihn in den passenden Pool – oder markiert ihn als „nicht passend“", onclick: e => busy(e.currentTarget, () => assignAll({ ids: [...st.selected] }, reload)) }, icon("sparkles"), "Recherchieren & zuordnen"),
      h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { const r = await api("/api/leads/verify", { method: "POST", body: { ids: [...st.selected] } }); toast(`Geprüft: ${r.valid} gültig, ${r.risky} riskant, ${r.invalid} ungültig`); reload(); }) }, "Prüfen"),
      h("button", { class: "btn btn-sm", title: "Chef-Adresse ermitteln: Name aus dem Impressum, E-Mail veröffentlicht oder aus dem Namen und dem Firmenmuster gebildet", onclick: e => busy(e.currentTarget, () => findManagers({ ids: [...st.selected] }, reload)) }, icon("users"), "Chef-Adresse suchen"),
      h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { if (!(await confirmDialog(`${st.selected.size} Leads sperren? Sie werden nie wieder angeschrieben.`, { confirm: "Sperren", danger: true }))) return; await api("/api/leads/bulk", { method: "POST", body: { action: "block", ids: [...st.selected] } }); st.selected.clear(); reload(); }) }, "Sperren"),
      h("button", { class: "btn btn-sm btn-danger", onclick: e => busy(e.currentTarget, async () => { if (!(await confirmDialog(`${st.selected.size} Leads endgültig löschen (inkl. Nachrichten)?`, { confirm: "Löschen", danger: true }))) return; await api("/api/leads/bulk", { method: "POST", body: { action: "delete", ids: [...st.selected] } }); st.selected.clear(); reload(); }) }, "Löschen"),
      h("button", { class: "btn btn-sm btn-ghost", onclick: () => { st.selected.clear(); reload(); } }, "Auswahl aufheben")) : null;
    clear(tableBox, h("div", { class: "card" }, bulk,
      res.items.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", { class: "check-col" }, allBox), h("th", null, "E-Mail"), h("th", null, "Name"), h("th", null, "Firma"), h("th", null, "Status"), h("th", null, "Einwilligung"), st.product ? h("th", null, "Qualität") : null, h("th", null, "Prüfung"), h("th", { class: "num" }, "Kampagnen"), h("th", null, "Angelegt"))),
        h("tbody", null, res.items.map(l => h("tr", { class: "clickable", onclick: e => { if (e.target.type !== "checkbox") openLead(l.id, reload); } },
          h("td", { class: "check-col" }, h("input", { type: "checkbox", checked: st.selected.has(l.id), "aria-label": "Auswählen", onchange: e => { e.target.checked ? st.selected.add(l.id) : st.selected.delete(l.id); reload(); } })),
          h("td", { class: "strong" }, l.email),
          h("td", null, [l.salutation, l.first_name, l.last_name].filter(Boolean).join(" ") || "–"),
          h("td", null, l.company || "–"),
          h("td", null, badge("lead", l.status), l.hold_until && l.hold_until > Date.now() ? h("span", { class: "badge warn", title: `gesperrt bis ${dateTime(l.hold_until)}`, style: { marginLeft: "4px" } }, "Sperrfrist") : null, l.meeting_at ? h("span", { class: "badge ok", style: { marginLeft: "4px" } }, "Termin") : null),
          h("td", { title: l.consent_source || "" }, badge("consent", l.consent_status)),
          st.product ? h("td", { title: l.fit_reason || "" }, l.fit ? badge("fit", l.fit) : h("span", { class: "muted small" }, "–")) : null,
          h("td", { title: l.verify_reason || "" }, badge("verify", l.verify_status)),
          h("td", { class: "num" }, num(l.campaign_count)),
          h("td", { class: "small muted nowrap" }, dateTime(l.created_at)))))),
        pager({ page: res.page, limit: res.limit, total: res.total, onPage: p => { st.page = p; reload(); } }))
        : emptyState(st.q || st.list || st.status || st.verify ? "Keine Treffer" : "Noch keine Leads", "Importiere eine CSV-Datei (z. B. aus Apollo, Sales Navigator, Excel). Die Spalten ordnest du im nächsten Schritt zu.",
          h("button", { class: "btn btn-primary", onclick: () => openImport(reload) }, icon("upload"), "CSV importieren"))));
  };
  const onFilter = () => { st.q = search.value.trim(); st.list = listSel.value; st.project = projectSel.value; st.status = statusSel.value; st.verify = verifySel.value; st.consent = consentSel.value; st.product = productSel.value; st.fit = fitSel.value; st.page = 1; reload(); };
  search.addEventListener("input", debounce(onFilter, 300));
  for (const s of [listSel, projectSel, statusSel, verifySel, consentSel, productSel, fitSel]) s.addEventListener("change", onFilter);
  clear(body, h("div", { class: "stack" },
    h("div", { class: "row", style: { flexWrap: "wrap" } }, search, listSel, (state.projects || []).length ? projectSel : null, statusSel, verifySel, consentSel, products.length ? productSel : null, products.length ? fitSel : null, h("div", { class: "grow" }),
      h("button", { class: "btn", onclick: e => busy(e.currentTarget, async () => {
        const r = await api("/api/leads/verify", { method: "POST", body: st.list ? { list_id: Number(st.list) } : {} });
        toast(`${num(r.checked)} geprüft: ${r.valid} gültig, ${r.risky} riskant, ${r.invalid} ungültig, ${r.unknown} unklar`);
        reload();
      }) }, icon("shield"), "Ungeprüfte prüfen"),
      st.list ? h("button", { class: "btn", title: "Für alle noch nicht geprüften Leads der Liste: Chef und dessen E-Mail-Adresse ermitteln", onclick: e => busy(e.currentTarget, () => findManagers({ list_id: Number(st.list) }, reload)) }, icon("users"), "Chef-Adresse suchen") : null,
      st.list ? h("button", { class: "btn", title: "Alle Leads der Liste per KI recherchieren und dem passenden Projekt-Pool zuordnen (nicht passende fliegen aus den Pools)", onclick: e => busy(e.currentTarget, () => assignAll({ list_id: Number(st.list) }, reload)) }, icon("sparkles"), "Alle recherchieren & zuordnen") : null, exportLink),
    tableBox));
  await reload();
}

function bulkProject(ids, done) {
  const sel = select([...(state.projects || []).map(p => [p.id, p.name]), ["", "– kein Projekt –"]], (state.projects || [])[0]?.id ?? "");
  const dlg = modal({
    title: `${ids.length} Leads einem Projekt zuordnen`,
    body: h("div", { class: "stack" }, field("Projekt", sel, "Gilt für die ganze Firma. Kampagnen anderer Projekte nehmen diese Firmen nicht mehr auf – so bleiben die Geschäftsbereiche sauber getrennt.")),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const r = await api("/api/leads/bulk", { method: "POST", body: { action: "set_project", ids, project_id: sel.value || null } });
      toast(`${num(r.affected)} Firmen zugeordnet`);
      dlg.close();
      done();
    }) }, "Zuordnen")]
  });
}

// Impressum lesen – in Paketen, bis die Auswahl/Liste durch ist.
async function findManagers(target, done) {
  const total = { checked: 0, named: 0, email_switched: 0, email_published: 0, email_guessed: 0, not_found: 0 };
  for (let round = 0; round < 200; round++) {
    const r = await api("/api/leads/imprint-contacts", { method: "POST", body: target });
    for (const k of Object.keys(total)) total[k] += r[k] || 0;
    if (r.remaining > 0) toast(`Websites: ${num(total.checked)} gelesen, noch ${num(r.remaining)} …`);
    if (!r.remaining || target.ids) break;
  }
  toast(`${num(total.checked)} Websites gelesen: ${total.email_switched} Chef-Adressen (${total.email_published} veröffentlicht, ${total.email_guessed} aus dem Namen gebildet), ${total.named} Namen ergänzt`);
  done();
}

function bulkToList(ids, lists, done) {
  const sel = select([["", "– neue Liste –"], ...lists.map(l => [l.id, l.name])], "");
  const name = input({ placeholder: "Name der neuen Liste" });
  const dlg = modal({
    title: `${ids.length} Leads zu Liste hinzufügen`,
    body: h("div", { class: "stack" }, field("Liste", sel), field("Neue Liste", name)),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      let listId = sel.value;
      if (!listId) listId = (await api("/api/lists", { method: "POST", body: { name: name.value || "Neue Liste" } })).id;
      const r = await api("/api/leads/bulk", { method: "POST", body: { action: "add_to_list", list_id: Number(listId), ids } });
      toast(`${r.affected} hinzugefügt`); dlg.close(); done();
    }) }, "Hinzufügen")]
  });
}

function bulkToCampaign(ids, campaigns) {
  if (!campaigns.length) return toast("Zuerst eine Kampagne anlegen", "error");
  const sel = select(campaigns.map(c => [c.id, c.name]), campaigns[0].id);
  const dlg = modal({
    title: `${ids.length} Leads zu Kampagne hinzufügen`,
    body: field("Kampagne", sel, "Abgemeldete, gesperrte, gebouncte und ungültige Leads werden automatisch übersprungen."),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const r = await api(`/api/campaigns/${sel.value}/leads`, { method: "POST", body: { lead_ids: ids } });
      toast(`${r.added} hinzugefügt, ${r.already} bereits enthalten, ${r.skipped} übersprungen`); dlg.close();
    }) }, "Hinzufügen")]
  });
}

function consentFields(defaultStatus = "granted") {
  const status = select(Object.entries(state.meta?.consent_statuses || { none: "Keine", granted: "Einwilligung", customer: "Bestandskunde", revoked: "Widerspruch" }), defaultStatus);
  const source = input({ placeholder: "z. B. Anfrageformular Website 03.10.2026 (Double-Opt-In)" });
  return { status, source, el: h("div", { class: "stack" }, field("Status", status), field("Quelle / Nachweis", source, "Pflicht bei Einwilligung: Wo, wann und wie wurde zugestimmt? Im Streitfall müsst ihr das nachweisen.")) };
}

function bulkConsent(ids, done) {
  const c = consentFields();
  const dlg = modal({
    title: `Einwilligung für ${ids.length} Leads setzen`,
    body: h("div", { class: "stack" }, h("div", { class: "alert warn" }, "Nur setzen, wenn die Einwilligung wirklich vorliegt und nachweisbar ist (z. B. Formular mit Häkchen, schriftliche Anfrage, Zusage im Telefonat mit Notiz)."), c.el),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const r = await api("/api/leads/bulk", { method: "POST", body: { action: "set_consent", ids, consent_status: c.status.value, consent_source: c.source.value } });
      toast(`${r.affected} aktualisiert`); dlg.close(); done();
    }) }, "Speichern")]
  });
}

function bulkQualify(ids, products, done) {
  if (!state.meta?.ai_available) return toast(aiMissingText, "error");
  if (!products.length) return toast("Zuerst ein Produkt anlegen", "error");
  const product = select(products.map(p => [p.id, p.name]), products[0].id);
  const onlyNew = checkbox("Nur noch nicht geprüfte", true);
  const progress = h("div");
  const dlg = modal({
    title: `${ids.length} Leads per KI prüfen`,
    body: h("div", { class: "stack" }, field("Produkt", product), onlyNew, h("div", { class: "hint" }, "Bewertung A–D und konkreter Anlass je Firma. Jede Prüfung zählt gegen das Kontingent des Max-Abos."), progress),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Schließen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const job = await api(`/api/products/${product.value}/qualify`, { method: "POST", body: { lead_ids: ids, only_unchecked: onlyNew.input.checked } });
      const fin = await waitForJob(job.id, j => clear(progress, h("div", { class: "small muted" }, `${num(j.done)} von ${num(j.total)} geprüft${j.failed ? ` · ${j.failed} Fehler` : ""}`)));
      clear(progress, h("div", { class: ["alert", fin.status === "done" ? "ok" : "warn"] }, `${fin.status === "done" ? "Fertig" : `Angehalten: ${fin.error || fin.status}`} · ${Object.entries(fin.results).map(([k, n]) => `${k}: ${n}`).join(" · ")}`));
      done();
    }) }, "Prüfen")]
  });
}

// ---------- Import ----------
export function openImport(done, { listId = null } = {}) {
  const fileInput = h("input", { type: "file", accept: ".csv,text/csv,text/plain", class: "input" });
  const step = h("div", { class: "stack" });
  let csv = "", preview = null;
  const footer = h("div", { class: "row", style: { justifyContent: "flex-end", width: "100%" } });
  const dlg = modal({ title: "Leads importieren", wide: true, body: step, footer });

  const showPick = () => {
    clear(step,
      field("CSV-Datei", fileInput, "Erste Zeile = Spaltennamen. Komma, Semikolon oder Tab werden automatisch erkannt (Excel: „CSV UTF-8“ speichern)."),
      h("div", { class: "alert info" }, "Rechtlicher Hinweis: Notiere die Datenquelle (z. B. „Website-Recherche“, „Messe 2026“). Sie wird je Lead gespeichert und hilft bei der Auskunftspflicht nach Art. 14 DSGVO."));
    clear(footer, h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"));
  };
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    if (!file) return;
    csv = await readFileAs(file);
    try {
      preview = await api("/api/leads/import/preview", { method: "POST", body: { csv } });
      showMapping();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  const showMapping = async () => {
    const lists = await api("/api/lists");
    const groups = await api("/api/target-groups");
    const mappingSelects = preview.headers.map((hd, i) => select([["ignore", "– ignorieren –"], ...preview.fields.map(fld => [fld, FIELD_LABELS[fld] || fld]), [`custom:${hd}`, `Eigenes Feld „${hd}“`]], preview.mapping[i] || "ignore"));
    const listSel = select([["new", "Neue Liste anlegen"], ["", "Keiner Liste zuordnen"], ...lists.map(l => [l.id, l.name])], listId || "new");
    const listName = input({ value: `Import ${new Date().toLocaleDateString("de-DE")}` });
    const groupSel = select([["", "– keine –"], ...groups.map(g => [g.id, g.name])], "");
    const source = input({ placeholder: "z. B. Website-Recherche Oktober 2026" });
    const update = checkbox("Bestehende Leads aktualisieren", false, "Sonst werden vorhandene E-Mail-Adressen übersprungen (aber der Liste hinzugefügt).");
    const consent = consentFields("none");
    const verify = checkbox("E-Mails direkt prüfen (MX, Wegwerf-Adressen, Rollen-Adressen)", true);
    listSel.addEventListener("change", () => { listName.parentElement.hidden = listSel.value !== "new"; groupSel.parentElement.hidden = listSel.value !== "new"; });
    clear(step,
      h("div", { class: "row" }, h("strong", null, `${num(preview.total)} Zeilen erkannt`), h("span", { class: "muted small" }, `Trennzeichen „${preview.delimiter === "\t" ? "Tab" : preview.delimiter}“`)),
      h("div", { class: "card" }, h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", null, "Spalte in der Datei"), h("th", null, "Beispiel"), h("th", null, "Zuordnung"))),
        h("tbody", null, preview.headers.map((hd, i) => h("tr", null, h("td", { class: "strong" }, hd), h("td", { class: "small muted ellipsis", style: { maxWidth: "260px" } }, preview.sample.map(r => r[i]).filter(Boolean).slice(0, 2).join(" · ") || "–"), h("td", null, mappingSelects[i]))))))),
      h("div", { class: "form-grid" }, field("Liste", listSel), field("Name der neuen Liste", listName), field("Zielgruppe der Liste", groupSel), field("Datenquelle", source)),
      h("div", { class: "card card-pad stack-sm" }, h("strong", null, "Einwilligung dieser Kontakte"), h("div", { class: "hint" }, "Nur wenn alle Kontakte der Datei nachweisbar eingewilligt haben (z. B. Export aus eurem Anfrage-Formular). Sonst „Keine Einwilligung“ lassen – dann sind sie nur für Anrufe mit konkretem Anlass bzw. bewusst gewählte Kaltakquise nutzbar."), consent.el),
      update, verify);
    clear(footer,
      h("button", { class: "btn", onclick: showPick }, "Zurück"),
      h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
        const mapping = Object.fromEntries(mappingSelects.map((s, i) => [i, s.value]));
        if (!Object.values(mapping).includes("email")) throw new Error("Bitte eine Spalte als E-Mail zuordnen.");
        const body = { csv, delimiter: preview.delimiter, mapping, update_existing: update.input.checked, verify: verify.input.checked, source: source.value };
        if (consent.status.value !== "none") Object.assign(body, { consent_status: consent.status.value, consent_source: consent.source.value });
        if (listSel.value === "new") { body.new_list_name = listName.value || "Import"; if (groupSel.value) body.target_group_id = Number(groupSel.value); }
        else if (listSel.value) body.list_id = Number(listSel.value);
        const r = await api("/api/leads/import", { method: "POST", body });
        clear(step, h("div", { class: "stack" },
          h("div", { class: "alert ok" }, `${num(r.imported)} neu importiert, ${num(r.updated)} aktualisiert, ${num(r.skipped)} bereits vorhanden, ${num(r.invalid)} ungültig, ${num(r.duplicates_in_file)} doppelt in der Datei.`),
          r.verification ? h("div", { class: "alert info" }, `Prüfung: ${num(r.verification.valid)} gültig, ${num(r.verification.risky)} riskant, ${num(r.verification.invalid)} ungültig, ${num(r.verification.unknown)} unklar.`) : null,
          r.errors.length ? h("div", { class: "alert warn" }, h("div", null, "Hinweise:", h("ul", null, r.errors.map(x => h("li", null, x))))) : null));
        clear(footer, h("button", { class: "btn btn-primary", onclick: () => { dlg.close(); done?.(r); } }, "Fertig"));
      }) }, "Importieren"));
  };
  showPick();
}

// ---------- Lead-Detail ----------
async function openLead(id, onChange) {
  const d = drawer(h("div", { class: "modal-body" }, skeletonRows(4)));
  const data = id ? await api(`/api/leads/${id}`) : { lead: { email: "", custom: {} }, campaigns: [], messages: [], lists: [] };
  const l = data.lead;
  const f = {};
  for (const k of ["email", "salutation", "first_name", "last_name", "company", "position", "website", "phone", "city", "country", "industry", "linkedin", "source"]) f[k] = input({ value: l[k] || "", type: k === "email" ? "email" : "text" });
  f.salutation = select([["", "–"], ["Herr", "Herr"], ["Frau", "Frau"], ["Herr Dr.", "Herr Dr."], ["Frau Dr.", "Frau Dr."]], l.salutation || "");
  f.notes = textarea({ value: l.notes || "", rows: 3 });
  f.reason = input({ value: l.reason || "", placeholder: "Konkreter Anlass, warum das Angebot für diese Firma relevant ist" });
  f.consent_status = select(Object.entries(state.meta?.consent_statuses || {}), l.consent_status || "none");
  f.consent_source = input({ value: l.consent_source || "", placeholder: "Wo/wann/wie zugestimmt?" });
  f.custom = textarea({ value: Object.entries(l.custom || {}).map(([k, v]) => `${k}: ${v}`).join("\n"), rows: 3, class: "textarea code", placeholder: "feld: wert (eine Zeile pro Feld)" });
  const collect = () => {
    const body = {};
    for (const [k, el] of Object.entries(f)) if (k !== "custom") body[k] = el.value;
    body.custom = Object.fromEntries(f.custom.value.split("\n").map(line => line.split(/:(.*)/s)).filter(p => p[0]?.trim()).map(([k, v]) => [k.trim(), (v || "").trim()]));
    return body;
  };
  d.set(
    h("div", { class: "modal-head" }, h("h2", { class: "grow ellipsis" }, id ? l.email : "Neuer Lead"), id ? badge("lead", l.status) : null, id ? badge("verify", l.verify_status) : null,
      h("button", { class: "btn btn-ghost btn-icon", "aria-label": "Schließen", onclick: d.close }, icon("x"))),
    h("div", { class: "modal-body stack" },
      id && l.verify_reason ? h("div", { class: "small muted" }, `Prüfung: ${l.verify_reason}`) : null,
      h("div", { class: "form-grid" },
        h("div", { class: "full" }, field("E-Mail", f.email)),
        field("Anrede", f.salutation), field("Vorname", f.first_name), field("Nachname", f.last_name), field("Firma", f.company), field("Position", f.position), field("Website", f.website),
        field("Telefon", f.phone), field("Stadt", f.city), field("Branche", f.industry), field("LinkedIn", f.linkedin),
        h("div", { class: "full" }, field("Datenquelle", f.source, "Art. 14 DSGVO: Woher stammen die Daten?")),
        field("Einwilligung", f.consent_status), field("Nachweis der Einwilligung", f.consent_source),
        h("div", { class: "full" }, field("Anlass / Relevanz", f.reason, "Wird bei KI-Qualitätsprüfung automatisch gefüllt und fließt in die Personalisierung ein.")),
        h("div", { class: "full" }, field("Eigene Felder", f.custom, "Nutzbar als Variable, z. B. {{mitarbeiter}}")),
        h("div", { class: "full" }, field("Notizen", f.notes))),
      id && l.hold_until && l.hold_until > Date.now() ? h("div", { class: "alert warn" }, `Sperrfrist bis ${dateTime(l.hold_until)} (z. B. nach „kein Interesse“).`, h("button", { class: "btn btn-sm", style: { marginLeft: "auto" }, onclick: e => busy(e.currentTarget, async () => { await api("/api/leads/bulk", { method: "POST", body: { action: "clear_hold", ids: [id] } }); toast("Sperrfrist aufgehoben"); d.close(); onChange?.(); }) }, "Aufheben")) : null,
      id && l.meeting_at ? h("div", { class: "alert ok" }, `Termin gebucht: ${dateTime(l.meeting_at)}`) : null,
      id && data.fits?.length ? h("div", null, h("h3", null, "Qualität je Produkt"), h("div", { class: "stack-sm", style: { marginTop: "8px" } }, data.fits.map(x => h("div", { class: "row small" }, badge("fit", x.fit), h("strong", null, x.product_name), h("span", { class: "muted grow" }, x.reason))))) : null,
      id && data.tasks?.length ? h("div", null, h("h3", null, "Aufgaben"), h("div", { class: "stack-sm", style: { marginTop: "8px" } }, data.tasks.map(t => h("div", { class: "row small" }, badge("task", t.status), h("a", { href: "#/aufgaben/open", onclick: d.close, class: "grow" }, t.title), h("span", { class: "muted" }, relTime(t.due_at)))))) : null,
      id && data.campaigns.length ? h("div", null, h("h3", null, "Kampagnen"), h("div", { class: "stack-sm", style: { marginTop: "8px" } }, data.campaigns.map(c => h("div", { class: "row small" },
        h("a", { href: `#/kampagnen/${c.campaign_id}`, onclick: d.close }, c.campaign_name), badge("cl", c.status), h("span", { class: "muted" }, `Schritt ${c.step}`), c.last_error ? h("span", { style: { color: "var(--danger)" } }, c.last_error) : null)))) : null,
      id && data.messages.length ? h("div", null, h("h3", null, "Verlauf"), h("div", { class: "stack-sm", style: { marginTop: "8px" } }, data.messages.slice(0, 30).map(m => h("div", { class: "row small" },
        h("span", { class: "muted nowrap" }, dateTime(m.created_at)), h("span", { class: ["badge", m.direction === "in" ? "ok" : ""] }, m.direction === "in" ? (m.kind === "auto_reply" ? "Auto-Antwort" : "Antwort") : m.kind === "manual" ? "Manuell" : m.kind === "nurture" ? "Nachfassen" : `Schritt ${(m.step ?? 0) + 1}`),
        m.conversation_id && m.direction === "in" ? h("a", { href: `#/unibox/${m.conversation_id}`, onclick: d.close, class: "ellipsis" }, m.subject) : h("span", { class: "ellipsis" }, m.subject),
        m.status === "bounced" ? h("span", { class: "badge danger" }, "Bounce") : m.opens ? h("span", { class: "muted" }, `${m.opens}× geöffnet`) : null)))) : null),
    h("div", { class: "modal-foot" },
      id ? h("button", { class: "btn btn-danger left", onclick: e => busy(e.currentTarget, async () => {
        if (!(await confirmDialog("Lead mit allen Nachrichten, Gesprächen und Ereignissen endgültig löschen (DSGVO Art. 17)? Abgemeldete Adressen bleiben zum Schutz auf der Blockliste.", { danger: true, confirm: "Endgültig löschen" }))) return;
        await api(`/api/leads/${id}`, { method: "DELETE" });
        toast("Lead gelöscht"); d.close(); onChange?.();
      }) }, "Löschen") : null,
      h("button", { class: "btn", onclick: d.close }, "Abbrechen"),
      h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
        const r = await api(id ? `/api/leads/${id}` : "/api/leads", { method: id ? "PUT" : "POST", body: collect() });
        toast("Gespeichert"); noteTagToast(r); d.close(); onChange?.();
      }) }, "Speichern")));
}

// ---------- Listen ----------
async function drawLists(body) {
  const [lists, groups] = await Promise.all([api("/api/lists"), api("/api/target-groups")]);
  const reload = () => drawLists(body);
  const name = input({ placeholder: "Name der neuen Liste" });
  const group = select([["", "Zielgruppe (optional)"], ...groups.map(g => [g.id, g.name])], "");
  clear(body, h("div", { class: "stack" },
    h("div", { class: "row" }, name, group, h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => { await api("/api/lists", { method: "POST", body: { name: name.value, target_group_id: group.value ? Number(group.value) : null } }); reload(); }) }, "Liste anlegen")),
    h("div", { class: "card" }, lists.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "Liste"), h("th", null, "Zielgruppe"), h("th", { class: "num" }, "Leads"), h("th", null, "Angelegt"), h("th", null, ""))),
      h("tbody", null, lists.map(l => h("tr", null,
        h("td", { class: "strong" }, l.name), h("td", null, l.target_group_name || "–"), h("td", { class: "num" }, num(l.lead_count)), h("td", { class: "small muted" }, relTime(l.created_at)),
        h("td", { class: "right nowrap" },
          h("a", { class: "btn btn-sm btn-ghost", href: `#/leads/liste-${l.id}` }, "Anzeigen"),
          h("button", { class: "btn btn-sm btn-ghost", onclick: () => openImport(reload, { listId: l.id }) }, "Importieren"),
          h("button", { class: "btn btn-sm btn-ghost btn-danger", onclick: e => busy(e.currentTarget, async () => {
            if (!(await confirmDialog(`Liste „${l.name}“ löschen? Die Leads bleiben erhalten.`, { danger: true, confirm: "Löschen" }))) return;
            await api(`/api/lists/${l.id}`, { method: "DELETE" }); reload();
          }) }, icon("trash"))))))))
      : emptyState("Noch keine Listen", "Listen gruppieren Leads, z. B. pro Zielgruppe oder Import. Kampagnen bekommen ihre Leads aus Listen."))));
}

// ---------- Blockliste ----------
async function drawBlocklist(body) {
  const items = await api("/api/blocklist");
  const reload = () => drawBlocklist(body);
  const values = textarea({ rows: 3, placeholder: "E-Mails oder Domains (eine pro Zeile), z. B.\nwettbewerber.de\nkein-kontakt@firma.de" });
  clear(body, h("div", { class: "stack" },
    h("div", { class: "card card-pad stack-sm" }, h("div", { class: "hint" }, "Gesperrte Adressen und Domains werden in keiner Kampagne angeschrieben. Abmeldungen landen automatisch hier."), values,
      h("div", null, h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => { const r = await api("/api/blocklist", { method: "POST", body: { values: values.value } }); toast(`${r.added} hinzugefügt`); reload(); }) }, "Sperren"))),
    h("div", { class: "card" }, items.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "Eintrag"), h("th", null, "Art"), h("th", null, "Grund"), h("th", null, "Seit"), h("th", null, ""))),
      h("tbody", null, items.map(b => h("tr", null, h("td", { class: "strong" }, b.value), h("td", null, b.kind === "domain" ? "Domain" : "E-Mail"), h("td", { class: "small" }, b.reason), h("td", { class: "small muted" }, dateTime(b.created_at)),
        h("td", { class: "right" }, h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, async () => {
          if (!(await confirmDialog(`„${b.value}“ von der Blockliste entfernen?${b.reason.startsWith("Abgemeldet") ? "\n\nAchtung: Diese Person hat sich abgemeldet." : ""}`, { confirm: "Entfernen", danger: true }))) return;
          await api(`/api/blocklist/${b.id}`, { method: "DELETE" }); reload();
        }) }, "Entfernen")))))))
      : emptyState("Blockliste ist leer", "Abmeldungen und manuell gesperrte Adressen erscheinen hier."))));
}


// „Recherchieren & zuordnen“: Hintergrund-Auftrag starten und Fortschritt melden.
async function assignAll(body, reload) {
  const label = body.list_id ? "alle Leads dieser Liste" : `${body.ids.length} Leads`;
  if (!(await confirmDialog(`${label} per KI recherchieren und den Projekten zuordnen? Leads, die zu keinem Projekt passen, werden aus den Pools genommen und als „nicht passend“ markiert.`, { confirm: "Starten" }))) return;
  let job;
  try { job = await api("/api/leads/assign", { method: "POST", body }); } catch (err) { toast(err.message || aiMissingText, "error"); return; }
  toast(`Auftrag gestartet: ${job.total} Leads. Läuft im Hintergrund, das Ergebnis steht an jedem Lead unter „zuordnung“.`);
  const done = await waitForJob(job.id, j => { if (j.done % 25 === 0 && j.done) toast(`Zuordnung: ${j.done}/${j.total}`); });
  const parts = Object.entries(done.results || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => `${n}× ${k}`).join(", ");
  toast(`Zuordnung ${done.status === "done" ? "fertig" : done.status}: ${parts || "keine Änderungen"}${done.failed ? ` (${done.failed} Fehler)` : ""}`, done.failed ? "error" : "success", 12000);
  reload();
}
