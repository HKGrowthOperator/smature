// Kampagne im Detail: Übersicht/Statistik, Sequenz-Editor mit A/B-Varianten und Live-Vorschau, Leads, Einstellungen.
import { h, clear, api, modal, field, input, textarea, select, checkbox, busy, toast, confirmDialog, badge, num, pct, dateTime, relTime, icon, emptyState, pager, barChart, debounce, scoreView, issuesList, state, skeletonRows, approvalBadge, aiMissingText, LEGAL_OPTIONS } from "../lib.js";

const TABS = [["uebersicht", "Übersicht"], ["sequenz", "Sequenz"], ["leads", "Leads"], ["einstellungen", "Einstellungen"]];
const TEMPLATE_TABS = [["sequenz", "Texte"], ["einstellungen", "Einstellungen"]];
const DAYS = [[1, "Mo"], [2, "Di"], [3, "Mi"], [4, "Do"], [5, "Fr"], [6, "Sa"], [7, "So"]];

export async function render(el, [id, tab]) {
  clear(el, h("div", { class: "content" }, skeletonRows(5)));
  const c = await api(`/api/campaigns/${id}`);
  const tabs = c.is_template ? TEMPLATE_TABS : TABS;
  const current = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  const body = h("div");
  const rerender = () => render(el, [id, current]);
  // Vorlagen gehören zu „Produkte & Vorlagen“.
  if (c.is_template) for (const a of document.querySelectorAll(".nav a[data-nav]")) a.classList.toggle("active", a.dataset.nav === "produkte");
  const statusBtn = () => {
    if (c.is_template) return h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const camp = await api(`/api/products/${c.product_id}/templates/${c.id}/campaign`, { method: "POST", body: {} });
      toast("Kampagne erstellt");
      location.hash = `#/kampagnen/${camp.id}/leads`;
    }) }, icon("plus"), "Kampagne daraus erstellen");
    if (c.status === "active") return h("button", { class: "btn", onclick: e => busy(e.currentTarget, async () => { await api(`/api/campaigns/${id}/status`, { method: "POST", body: { action: "pause" } }); toast("Pausiert"); rerender(); }) }, icon("pause"), "Pausieren");
    return h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, () => launch(c, rerender)) }, icon("play"), c.status === "paused" ? "Fortsetzen" : c.status === "completed" ? "Erneut starten" : "Starten");
  };
  const crumb = c.is_template
    ? [h("a", { href: "#/produkte" }, "Produkte"), " / ", c.product ? h("a", { href: `#/produkte/${c.product.id}` }, c.product.name) : "–", " / Vorlage"]
    : [h("a", { href: "#/kampagnen" }, "Kampagnen"), " / ", c.product ? h("a", { href: `#/produkte/${c.product.id}` }, c.product.name) : (c.target_group ? h("a", { href: `#/zielgruppen/${c.target_group.id}` }, c.target_group.name) : "ohne Produkt")];
  clear(el,
    h("div", { class: "page-head" },
      h("div", null, h("div", { class: "crumb" }, crumb),
        h("div", { class: "row", style: { flexWrap: "wrap" } }, h("h1", null, c.name), c.is_template ? h("span", { class: "badge info" }, "Vorlage") : badge("campaign", c.status), badge("legal", c.legal_basis), approvalBadge(c.approval))),
      h("div", { class: "actions" },
        statusBtn(),
        c.is_template ? null : h("button", { class: "btn", title: "Duplizieren", "aria-label": "Duplizieren", onclick: e => busy(e.currentTarget, async () => { const copy = await api(`/api/campaigns/${id}/duplicate`, { method: "POST" }); location.hash = `#/kampagnen/${copy.id}/sequenz`; }) }, icon("copy")),
        h("button", { class: "btn btn-danger", title: "Löschen", "aria-label": "Löschen", onclick: e => busy(e.currentTarget, async () => {
          if (!(await confirmDialog(c.is_template ? `Vorlage „${c.name}“ löschen? Daraus erstellte Kampagnen bleiben erhalten.` : `Kampagne „${c.name}“ löschen? Gesendete Nachrichten und Gespräche bleiben in der Unibox erhalten.`, { danger: true, confirm: "Löschen" }))) return;
          await api(`/api/campaigns/${id}`, { method: "DELETE" }); location.hash = c.is_template && c.product ? `#/produkte/${c.product.id}` : "#/kampagnen";
        }) }, icon("trash")))),
    h("div", { class: "content" },
      h("div", { class: "tabs" }, tabs.map(([k, label]) => h("a", { class: ["tab", k === current && "active"], href: `#/kampagnen/${id}/${k}` }, label))),
      body));
  if (current === "sequenz") return drawSequence(body, c, rerender);
  if (current === "leads") return drawLeads(body, c);
  if (current === "einstellungen") return drawSettings(body, c, rerender);
  return drawOverview(body, c);
}

// Kaltakquise: ausdrückliche Bestätigung des Risikos (wird dokumentiert).
function coldAckBox(c, onDone) {
  if (c.legal_basis !== "cold") return null;
  if (c.cold_ack_at) return h("div", { class: "alert warn" }, `Kaltakquise bestätigt von ${c.cold_ack_by} am ${dateTime(c.cold_ack_at)}.`);
  const cb = checkbox("Ich weiß, dass E-Mail-Werbung ohne Einwilligung auch an Firmen abgemahnt werden kann (§ 7 UWG), und schreibe nur sorgfältig ausgewählte Firmenkontakte mit konkretem Anlass an.", false);
  return h("div", { class: "alert warn stack-sm", style: { flexDirection: "column" } },
    h("strong", null, "Kaltakquise ohne Einwilligung"), cb,
    h("div", null, h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => {
      if (!cb.input.checked) throw new Error("Bitte zuerst ankreuzen.");
      await api(`/api/campaigns/${c.id}/cold-ack`, { method: "POST", body: { confirm: true } });
      toast("Bestätigt");
      onDone();
    }) }, "Bestätigen"), " ", h("a", { href: "#/richtlinien", class: "small" }, "Richtlinien lesen")));
}

async function launch(c, done) {
  const check = await api(`/api/campaigns/${c.id}/check`);
  const list = (items, tone) => items.length ? h("div", { class: ["alert", tone] }, h("ul", { style: { margin: 0 } }, items.map(x => h("li", null, x)))) : null;
  if (!check.ok) {
    const dlg = modal({ title: "Noch nicht startklar", body: h("div", { class: "stack-sm" }, list(check.errors, "danger"), coldAckBox(c, () => { dlg.close(); done(); }), list(check.warnings, "warn")) });
    return;
  }
  const dlg = modal({
    title: "Kampagne starten",
    body: h("div", { class: "stack-sm" }, h("p", null, `${num(check.leads)} Leads werden innerhalb der Versandzeiten nach und nach angeschrieben.`), list(check.warnings, "warn")),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      await api(`/api/campaigns/${c.id}/status`, { method: "POST", body: { action: c.status === "paused" ? "resume" : "launch" } });
      toast("Kampagne läuft"); dlg.close(); done();
    }) }, "Jetzt starten")]
  });
}

// ---------- Übersicht ----------
async function drawOverview(body, c) {
  const [stats, check] = await Promise.all([api(`/api/campaigns/${c.id}/stats`), api(`/api/campaigns/${c.id}/check`)]);
  const t = stats.totals;
  const tile = (label, value, meta) => h("div", { class: "card kpi" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), meta ? h("div", { class: "meta" }, meta) : null);
  const leadStates = Object.entries(stats.leads).sort((a, b) => b[1] - a[1]);
  clear(body, h("div", { class: "stack" },
    c.status !== "active" && (check.errors.length || check.warnings.length) ? h("div", { class: "stack-sm" },
      check.errors.length ? h("div", { class: "alert danger" }, h("div", null, h("strong", null, "Vor dem Start erledigen:"), h("ul", null, check.errors.map(x => h("li", null, x))))) : null,
      check.warnings.length ? h("div", { class: "alert warn" }, h("div", null, h("strong", null, "Hinweise:"), h("ul", null, check.warnings.map(x => h("li", null, x))))) : null) : null,
    c.status === "active" && c.next_window_at && c.next_window_at > Date.now() + 60000 ? h("div", { class: "alert info" }, `Außerhalb der Versandzeiten – nächster Versand ${relTime(c.next_window_at)} (${dateTime(c.next_window_at)}).`) : null,
    h("div", { class: "kpis" },
      tile("Leads", num(t.leads), `${num(t.contacted)} angeschrieben`),
      tile("Gesendet", num(t.sent)),
      tile("Antwortquote", pct(t.reply_rate), `${num(t.replied)} Antworten`),
      tile("Interessiert", num(t.interested), pct(t.interest_rate)),
      tile("Bounce-Rate", pct(t.bounce_rate), `${num(t.bounced)} Bounces`),
      c.track_opens ? tile("Öffnungsrate", pct(t.open_rate), "eingeschränkt aussagekräftig (Apple/Proxy)") : tile("Abmeldungen", num(t.unsubscribed))),
    h("div", { class: "split" },
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Verlauf"), h("span", { class: "muted small" }, "30 Tage")), h("div", { class: "card-body" }, barChart(stats.series))),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Lead-Status")),
        h("div", { class: "card-body stack-sm" }, leadStates.length ? leadStates.map(([s, n]) => h("div", { class: "row" }, h("span", { style: { width: "120px" } }, badge("cl", s)), h("div", { class: "bar grow" }, h("span", { style: { width: `${t.leads ? n / t.leads * 100 : 0}%` } })), h("span", { class: "small nowrap", style: { width: "48px", textAlign: "right" } }, num(n))))
          : h("p", { class: "muted small" }, "Noch keine Leads – im Tab „Leads“ hinzufügen.")))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Schritte & Varianten (A/B-Test)")),
      stats.variants.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", null, "Schritt"), h("th", null, "Variante"), h("th", { class: "num" }, "Gesendet"), h("th", { class: "num" }, "Antworten"), h("th", { class: "num" }, "Antwortquote"), h("th", { class: "num" }, "Interessiert"), c.track_opens ? h("th", { class: "num" }, "Geöffnet") : null, h("th", { class: "num" }, "Bounces"))),
        h("tbody", null, stats.variants.map(v => h("tr", null, h("td", null, `Mail ${v.step + 1}`), h("td", null, h("span", { class: "badge plain" }, v.variant)), h("td", { class: "num" }, num(v.sent)), h("td", { class: "num" }, num(v.replied)), h("td", { class: "num strong" }, pct(v.reply_rate)), h("td", { class: "num" }, num(v.interested)), c.track_opens ? h("td", { class: "num" }, pct(v.open_rate)) : null, h("td", { class: "num" }, num(v.bounced)))))))
        : h("div", { class: "card-body muted small" }, "Statistik erscheint, sobald die ersten Mails gesendet wurden."))));
}

// ---------- Sequenz ----------
async function drawSequence(body, c, rerender) {
  let steps = (c.steps.length ? c.steps : [{ delay_days: 0, variants: [{ key: "A", subject: "", body: "", enabled: true }] }]).map(s => ({ delay_days: s.delay_days, variants: s.variants.map(v => ({ ...v })) }));
  const nurture = (c.nurture_texts || []).map(t => t.body);
  let active = { step: 0, variant: 0 };
  let dirty = false;
  let previewLead = "";
  const leadsRes = await api(`/api/campaigns/${c.id}/leads?limit=50`).catch(() => ({ items: [] }));
  const editor = h("div", { class: "stack" });
  const preview = h("div", { class: "stack" });
  const saveBtn = h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, save) }, "Speichern");
  const approvalBar = h("div");
  const markDirty = () => { dirty = true; saveBtn.textContent = "Speichern •"; drawApproval(); refreshPreview(); };
  async function save() {
    const r = await api(`/api/campaigns/${c.id}`, { method: "PUT", body: { steps, nurture_texts: nurture.map(b => ({ body: b })) } });
    dirty = false; saveBtn.textContent = "Speichern";
    Object.assign(c, { approval: r.approval, status: r.status });
    drawApproval();
    toast(r.paused_for_approval ? "Gespeichert – Kampagne pausiert, bis die geänderten Texte freigegeben sind" : "Gespeichert", r.paused_for_approval ? "error" : "info");
  }
  function drawApproval() {
    const a = c.approval || {};
    const text = dirty ? "Ungespeicherte Änderungen – speichern und anschließend freigeben."
      : a.approved ? `Freigegeben von ${a.approved_by} am ${dateTime(a.approved_at)}. Jede Änderung an Texten, Abständen oder Nachfass-Texten hebt die Freigabe auf.`
      : a.outdated ? "Seit der letzten Freigabe geändert. Bitte alle Mails in der Vorschau prüfen und erneut freigeben."
      : "Noch nicht freigegeben. Erst prüfen (Vorschau mit echten Leads, Testmail an dich), dann freigeben – vorher kann nichts gesendet werden.";
    clear(approvalBar, h("div", { class: ["approval-bar", a.approved && !dirty ? "ok" : "warn"] },
      approvalBadge(dirty ? {} : a), h("span", { class: "grow small" }, text),
      a.approved && !dirty ? h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, async () => {
        if (!(await confirmDialog("Freigabe zurückziehen? Eine laufende Kampagne wird pausiert.", { confirm: "Zurückziehen" }))) return;
        const r = await api(`/api/campaigns/${c.id}/approve`, { method: "POST", body: { revoke: true } });
        Object.assign(c, { approval: r.approval, status: r.status }); drawApproval();
      }) }, "Freigabe zurückziehen")
        : h("button", { class: "btn btn-sm btn-primary", onclick: e => busy(e.currentTarget, async () => {
          if (dirty) await save();
          if (!(await confirmDialog("Alle Mails und Nachfass-Texte geprüft? Mit der Freigabe dürfen sie an die Leads dieser Kampagne gehen.", { confirm: "Texte freigeben" }))) return;
          const r = await api(`/api/campaigns/${c.id}/approve`, { method: "POST", body: {} });
          Object.assign(c, { approval: r.approval });
          drawApproval();
          toast("Texte freigegeben");
        }) }, icon("check"), "Texte freigeben")));
  }
  const vars = state.meta?.variables || [];

  const drawEditor = () => {
    clear(editor, steps.map((s, i) => {
      const vIdx = active.step === i ? Math.min(active.variant, s.variants.length - 1) : 0;
      const v = s.variants[vIdx];
      const subject = input({ value: v.subject, placeholder: i === 0 ? "Betreff, z. B. Frage zu {{company}}" : "Leer lassen = Antwort im selben Thread (empfohlen)" });
      const text = textarea({ value: v.body, rows: 11, placeholder: "{{anrede}},\n\n…" });
      const score = h("span");
      const checkCopy = debounce(async () => {
        try {
          const r = await api("/api/copy/check", { method: "POST", body: { subject: subject.value, body: text.value } });
          clear(score, scoreView(r.score), h("span", { class: "muted small" }, ` · ${r.words} Wörter`));
        } catch { /* ignorieren */ }
      }, 500);
      checkCopy();
      const focus = () => { if (active.step !== i || active.variant !== vIdx) { active = { step: i, variant: vIdx }; refreshPreview(); } };
      subject.addEventListener("focus", focus);
      text.addEventListener("focus", focus);
      subject.addEventListener("input", () => { v.subject = subject.value; checkCopy(); markDirty(); });
      text.addEventListener("input", () => { v.body = text.value; checkCopy(); markDirty(); });
      let lastField = text;
      subject.addEventListener("focus", () => { lastField = subject; });
      text.addEventListener("focus", () => { lastField = text; });
      const varSel = select([["", "Variable einfügen …"], ...vars.map(x => [x.key, `{{${x.key}}} – ${x.label}`])], "");
      varSel.addEventListener("change", () => {
        if (!varSel.value) return;
        const token = `{{${varSel.value}}}`;
        const el = lastField;
        const pos = el.selectionStart ?? el.value.length;
        el.value = el.value.slice(0, pos) + token + el.value.slice(el.selectionEnd ?? pos);
        el.dispatchEvent(new Event("input"));
        el.focus();
        el.selectionStart = el.selectionEnd = pos + token.length;
        varSel.value = "";
      });
      const variantTabs = h("div", { class: "variant-tabs" },
        s.variants.map((vv, j) => h("button", { class: ["variant-tab", j === vIdx && "active", vv.enabled === false && "off"], title: vv.enabled === false ? "Variante deaktiviert" : `Variante ${vv.key || "ABCDEFGH"[j]}`, onclick: () => { active = { step: i, variant: j }; drawEditor(); refreshPreview(); } }, "ABCDEFGH"[j])),
        s.variants.length < 6 ? h("button", { class: "variant-tab", title: "Variante hinzufügen (A/B-Test)", onclick: () => { s.variants.push({ subject: v.subject, body: v.body, enabled: true }); active = { step: i, variant: s.variants.length - 1 }; markDirty(); drawEditor(); } }, "+") : null);
      const wait = i > 0 ? h("div", { class: "step-wait" }, "Warten", input({ type: "number", min: 0, max: 90, step: 1, value: s.delay_days, class: "input input-sm", oninput: e => { s.delay_days = Number(e.target.value); markDirty(); } }), "Tage nach der vorherigen Mail, dann:") : null;
      return h("div", null, wait, h("div", { class: "card step" },
        h("div", { class: "step-head" },
          h("span", { class: "step-num" }, String(i + 1)),
          h("strong", null, i === 0 ? "Erste Mail" : `Follow-up ${i}`),
          variantTabs,
          h("div", { class: "grow" }),
          score,
          s.variants.length > 1 ? h("button", { class: "btn btn-sm btn-ghost", onclick: () => { v.enabled = v.enabled === false; markDirty(); drawEditor(); } }, v.enabled === false ? "Variante aktivieren" : "Variante pausieren") : null,
          s.variants.length > 1 ? h("button", { class: "btn btn-sm btn-ghost", title: "Variante löschen", onclick: () => { s.variants.splice(vIdx, 1); active = { step: i, variant: 0 }; markDirty(); drawEditor(); } }, icon("trash")) : null,
          i > 0 ? h("button", { class: "btn btn-sm btn-ghost", title: "Nach oben", onclick: () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; markDirty(); drawEditor(); } }, "↑") : null,
          steps.length > 1 ? h("button", { class: "btn btn-sm btn-ghost btn-danger", title: "Schritt löschen", onclick: async () => { if (await confirmDialog(`Schritt ${i + 1} löschen?`, { danger: true, confirm: "Löschen" })) { steps.splice(i, 1); active = { step: 0, variant: 0 }; markDirty(); drawEditor(); } } }, "Schritt löschen") : null),
        h("div", { class: "card-body stack-sm" },
          field("Betreff", subject),
          field("Text", text),
          h("div", { class: "row" }, varSel, h("span", { class: "hint grow" }, "Spintax: {Hallo|Guten Tag} · Fallback: {{first_name|zusammen}} · Signatur, Abmelde-Link und Impressum werden automatisch angefügt.")))));
    }),
    h("button", { class: "btn btn-ghost", title: "Erste Mail mit Einstiegsangebot und A/B-Variante, dann Nachhaken → neuer Aspekt → Relevanz-Frage im selben Thread, zum Schluss Abschluss-Mail", onclick: async () => {
      const hasText = steps.some(st => st.variants.some(v => String(v.subject || "").trim() || String(v.body || "").replace(/\{\{\s*(anrede|hallo)\s*\}\},?/gi, "").replace(/(viele|beste|freundliche)\s+grü(ß|ss)e,?/gi, "").trim()));
      if (hasText && !(await confirmDialog("Die Sequenz durch das Standard-Gerüst ersetzen? Bestehende Texte gehen verloren.", { confirm: "Ersetzen", danger: true }))) return;
      steps = sequenceSkeleton(c.legal_basis === "cold");
      active = { step: 0, variant: 0 }; markDirty(); drawEditor();
    } }, icon("list"), "Standard-Gerüst"),
    h("button", { class: "btn", disabled: c.legal_basis === "cold" && steps.length >= 3, title: c.legal_basis === "cold" && steps.length >= 3 ? "Kaltakquise: höchstens 3 Mails" : "", onclick: () => { steps.push({ delay_days: c.legal_basis === "cold" ? 5 : 3, variants: [{ subject: "", body: "{{anrede}},\n\n", enabled: true }] }); active = { step: steps.length - 1, variant: 0 }; markDirty(); drawEditor(); } }, icon("plus"), "Follow-up hinzufügen"),
    nurtureCard());
  };
  const nurtureCard = () => h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", null, "Nachfassen bei Interesse"), h("span", { class: "muted small" }, c.nurture_enabled ? `nach ${c.nurture_days} Tagen ohne Antwort, max. ${c.nurture_max}× · ${c.nurture_mode === "auto" ? "automatisch" : "als Entwurf"}` : "ausgeschaltet")),
    h("div", { class: "card-body stack-sm" },
      h("div", { class: "hint" }, "Gesendet im selben Gespräch, wenn jemand Interesse gezeigt hat, ihr geantwortet habt und danach nichts mehr kam. Danach: in die Sales App übergeben (Leads → Export, Filter „Warm“). Einstellungen im Tab „Einstellungen“."),
      nurture.map((text, i) => h("div", { class: "stack-sm" },
        h("div", { class: "row" }, h("strong", { class: "grow small" }, `Nachfassen ${i + 1}`), h("button", { class: "btn btn-sm btn-ghost btn-danger", "aria-label": "Entfernen", onclick: () => { nurture.splice(i, 1); markDirty(); drawEditor(); } }, icon("trash"))),
        textarea({ value: text, rows: 5, oninput: e => { nurture[i] = e.target.value; markDirty(); } }))),
      nurture.length < 5 ? h("button", { class: "btn btn-sm", onclick: () => { nurture.push("{{anrede}},\n\nich wollte kurz nachhaken – passt ein kurzes Gespräch? Hier können Sie direkt einen Termin wählen: {{termin_link}}\n\nViele Grüße"); markDirty(); drawEditor(); } }, icon("plus"), "Nachfass-Text hinzufügen") : null));

  const leadSel = select([["", leadsRes.items.length ? "Lead für Vorschau wählen" : "Beispiel-Lead (Max Mustermann)"], ...leadsRes.items.map(l => [l.lead_id, `${l.email}${l.company ? ` – ${l.company}` : ""}`])], "");
  leadSel.addEventListener("change", () => { previewLead = leadSel.value; refreshPreview(); });
  const testTo = input({ type: "email", placeholder: "an deine Adresse", class: "input input-sm" });
  const previewBody = h("div");
  async function doPreview(opts = {}) {
    try {
      const r = await api(`/api/campaigns/${c.id}/preview`, { method: "POST", body: { steps, step: active.step, variant: "ABCDEFGH"[active.variant], lead_id: previewLead ? Number(previewLead) : undefined, generate_ai: !!opts.ai, force: !!opts.force } });
      clear(previewBody,
        r.ai_error ? h("div", { class: "alert danger" }, `KI: ${r.ai_error}`) : null,
        r.missing.length ? h("div", { class: "alert warn" }, `Fehlende Werte für: ${r.missing.join(", ")} – solche Leads werden übersprungen. Fallback setzen, z. B. {{${r.missing[0]}|…}}`) : null,
        h("div", { class: "preview-mail" },
          h("div", { class: "meta" }, h("div", null, h("span", { class: "muted" }, "Von: "), `${r.mailbox.from_name || ""} <${r.mailbox.email}>`), h("div", null, h("span", { class: "muted" }, "An: "), `${r.lead.name || ""} <${r.lead.email}>`), h("div", null, h("span", { class: "muted" }, "Betreff: "), h("strong", null, r.subject || "–"), r.threadReply ? h("span", { class: "badge info", style: { marginLeft: "6px" } }, "im Thread") : null), r.aiUsed ? h("div", null, h("span", { class: "badge ok" }, "KI-personalisiert")) : null),
          h("div", { class: "body" }, r.text)),
        h("div", { class: "card card-pad stack-sm" }, h("div", { class: "row" }, h("strong", null, "Copy-Check"), scoreView(r.copy.score), h("span", { class: "muted small" }, `${r.copy.words} Wörter · ${r.copy.links} Links`)), issuesList(r.copy.issues)));
    } catch (err) {
      clear(previewBody, h("div", { class: "alert danger" }, err.message));
    }
  }
  const refreshPreview = debounce(doPreview, 350);
  const aiOn = c.ai_mode !== "off";
  clear(preview, h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", null, "Vorschau"), h("span", { class: "muted small" }, "aktiver Schritt")),
    h("div", { class: "card-body stack-sm" }, leadSel,
      aiOn ? h("div", { class: "row-tight" }, h("button", { class: "btn btn-sm", disabled: !leadsRes.items.length, title: leadsRes.items.length ? "" : "Zuerst Leads hinzufügen", onclick: e => busy(e.currentTarget, async () => { if (!previewLead && leadsRes.items[0]) { previewLead = String(leadsRes.items[0].lead_id); leadSel.value = previewLead; } if (dirty) await save(); await doPreview({ ai: true }); }) }, icon("sparkles"), "KI-Version erzeugen"),
        h("button", { class: "btn btn-sm btn-ghost", disabled: !leadsRes.items.length, onclick: e => busy(e.currentTarget, async () => { if (dirty) await save(); await doPreview({ ai: true, force: true }); }) }, "Neu generieren"),
        h("span", { class: "hint" }, c.ai_mode === "full" ? "Volltext je Lead" : "Einstiegssatz {{ai_first_line}}")) : null,
      previewBody,
      h("div", { class: "row-tight" }, testTo, h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { if (dirty) await save(); const r = await api(`/api/campaigns/${c.id}/test`, { method: "POST", body: { to: testTo.value, step: active.step, lead_id: previewLead ? Number(previewLead) : undefined } }); toast(`Testmail gesendet: ${r.subject}`); }) }, icon("send"), "Testmail")),
      state.meta?.ai_available ? h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, () => aiReview(c, steps, active, () => { drawEditor(); markDirty(); })) }, icon("sparkles"), "KI-Feedback zu diesem Text") : null)));

  clear(body, h("div", { class: "stack" },
    approvalBar,
    h("div", { class: "row" }, h("span", { class: "muted small grow" }, c.legal_basis === "cold" ? "Kaltakquise: höchstens 3 kurze Mails, mind. 4 Tage Abstand, keine Links in der ersten Mail, kein „Re:“." : "Tipp: Erste Mail kurz und persönlich, Follow-ups ohne Betreff im selben Thread. {{termin_link}} und {{kit_link}} kommen aus dem Produkt."), saveBtn),
    h("div", { class: "split" }, editor, h("div", { style: { position: "sticky", top: "16px" } }, preview))));
  drawApproval();
  drawEditor();
  refreshPreview();
  const guard = e => { if (dirty) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", guard);
  return () => window.removeEventListener("beforeunload", guard);
}

async function aiReview(c, steps, active, onApply) {
  const v = steps[active.step].variants[active.variant];
  const r = await api("/api/copy/review", { method: "POST", body: { subject: v.subject, body: v.body, target_group_id: c.target_group_id, product_id: c.product_id, legal_basis: c.legal_basis } });
  const dlg = modal({
    title: `KI-Feedback – Mail ${active.step + 1}, Variante ${"ABCDEFGH"[active.variant]}`, wide: true,
    body: h("div", { class: "stack" },
      h("div", { class: "row" }, scoreView(r.score), h("span", null, r.verdict)),
      h("div", { class: "row-tight" }, h("span", { class: ["badge", r.creepy_score > (r.creepy_threshold || 35) ? "danger" : r.creepy_score > 20 ? "warn" : "ok"] }, `Creepy-Score ${r.creepy_score}`),
        h("span", { class: "small muted" }, r.creepy_score > (r.creepy_threshold || 35) ? "wirkt aufdringlich/überwachend – so nicht senden" : "wirkt nicht aufdringlich")),
      r.unsupported_claims?.length ? h("div", { class: "alert warn" }, h("div", null, h("strong", null, "Ohne Beleg: "), r.unsupported_claims.join(" · "))) : null,
      r.checks?.length ? h("ul", { class: "small" }, r.checks.map(c => h("li", null, c.text))) : null,
      h("ul", null, r.suggestions.map(s => h("li", null, s))),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("strong", null, "Verbesserte Fassung")), h("div", { class: "card-body stack-sm" }, r.improved_subject ? h("div", null, h("span", { class: "muted" }, "Betreff: "), h("strong", null, r.improved_subject)) : null, h("div", { class: "pre" }, r.improved_body)))),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Schließen"),
      h("button", { class: "btn", onclick: () => { steps[active.step].variants.push({ subject: active.step === 0 ? r.improved_subject : v.subject, body: r.improved_body, enabled: true }); dlg.close(); onApply(); } }, "Als neue Variante (A/B)"),
      h("button", { class: "btn btn-primary", onclick: () => { if (active.step === 0 || v.subject) v.subject = r.improved_subject || v.subject; v.body = r.improved_body; dlg.close(); onApply(); } }, "Übernehmen")]
  });
}

// ---------- Leads ----------
async function drawLeads(body, c) {
  const lists = await api("/api/lists");
  const st = { status: "", q: "", page: 1, selected: new Set() };
  const listSel = select([["", lists.length ? "Liste wählen …" : "Noch keine Listen"], ...lists.map(l => [l.id, `${l.name} (${l.lead_count})`])], "");
  const statusSel = select([["", "Alle Status"], ...Object.entries({ queued: "Wartet", active: "Läuft", paused: "Pausiert", completed: "Fertig", replied: "Geantwortet", bounced: "Bounce", unsubscribed: "Abgemeldet", stopped: "Gestoppt", error: "Fehler", skipped: "Übersprungen", blocked: "Gesperrt", invalid: "Ungültig" })], "");
  const search = input({ type: "search", placeholder: "Suchen", style: { maxWidth: "220px" } });
  const tableBox = h("div");
  const reload = async () => {
    const qs = new URLSearchParams({ page: st.page, limit: 50 });
    if (st.status) qs.set("status", st.status);
    if (st.q) qs.set("q", st.q);
    const res = await api(`/api/campaigns/${c.id}/leads?${qs}`);
    const act = action => e => busy(e.currentTarget, async () => {
      if (["remove", "restart"].includes(action) && !(await confirmDialog(action === "remove" ? "Ausgewählte Leads aus der Kampagne entfernen?" : "Sequenz für die Auswahl von vorn beginnen (auch bereits angeschriebene)?", { danger: true, confirm: "Ja" }))) return;
      const r = await api(`/api/campaigns/${c.id}/leads/action`, { method: "POST", body: { action, ids: [...st.selected] } });
      toast(`${r.changes} geändert`); st.selected.clear(); reload();
    });
    clear(tableBox, h("div", { class: "card" },
      st.selected.size ? h("div", { class: "bulkbar" }, h("strong", null, `${st.selected.size} ausgewählt`),
        h("button", { class: "btn btn-sm", onclick: act("pause") }, "Pausieren"), h("button", { class: "btn btn-sm", onclick: act("resume") }, "Fortsetzen"),
        h("button", { class: "btn btn-sm", onclick: act("stop") }, "Stoppen"), c.ai_mode !== "off" ? h("button", { class: "btn btn-sm", onclick: act("regenerate_ai") }, "KI neu erzeugen") : null,
        h("button", { class: "btn btn-sm", onclick: act("restart") }, "Neu starten"), h("button", { class: "btn btn-sm btn-danger", onclick: act("remove") }, "Entfernen")) : null,
      res.items.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", { class: "check-col" }, h("input", { type: "checkbox", "aria-label": "Alle", checked: res.items.every(x => st.selected.has(x.id)), onchange: e => { for (const x of res.items) e.target.checked ? st.selected.add(x.id) : st.selected.delete(x.id); reload(); } })),
          h("th", null, "Lead"), h("th", null, "Status"), h("th", null, "Schritt"), h("th", null, "Nächste Mail"), h("th", null, "Postfach"), h("th", null, "Hinweis"))),
        h("tbody", null, res.items.map(x => h("tr", null,
          h("td", { class: "check-col" }, h("input", { type: "checkbox", checked: st.selected.has(x.id), onchange: e => { e.target.checked ? st.selected.add(x.id) : st.selected.delete(x.id); reload(); } })),
          h("td", null, h("div", { class: "strong" }, x.email), h("div", { class: "small muted" }, [x.first_name, x.last_name].filter(Boolean).join(" "), x.company ? ` · ${x.company}` : "")),
          h("td", null, badge("cl", x.status), x.interest ? h("span", { class: "small muted" }, ` ${state.meta?.labels?.[x.interest] || x.interest}`) : null),
          h("td", null, `${x.step}/${c.steps.length}`, x.has_ai ? h("span", { class: "badge ok", style: { marginLeft: "6px" }, title: "KI-Text vorhanden" }, "KI") : null),
          h("td", { class: "small" }, ["queued", "active"].includes(x.status) ? (x.next_at ? relTime(x.next_at) : "sofort (im Zeitfenster)") : "–"),
          h("td", { class: "small muted" }, x.mailbox_email || "–"),
          h("td", { class: "small", style: { color: x.last_error ? "var(--danger)" : "inherit", maxWidth: "280px" } }, x.last_error || ""))))),
        pager({ page: res.page, limit: res.limit, total: res.total, onPage: p => { st.page = p; reload(); } }))
        : emptyState(st.status || st.q ? "Keine Treffer" : "Noch keine Leads in dieser Kampagne", "Füge eine Lead-Liste hinzu. Abgemeldete, gesperrte und ungültige Adressen werden automatisch übersprungen.")));
  };
  statusSel.addEventListener("change", () => { st.status = statusSel.value; st.page = 1; reload(); });
  search.addEventListener("input", debounce(() => { st.q = search.value.trim(); st.page = 1; reload(); }, 300));
  clear(body, h("div", { class: "stack" },
    h("div", { class: "card card-pad" }, h("div", { class: "row" }, h("strong", null, "Leads hinzufügen:"), listSel,
      h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
        if (!listSel.value) throw new Error("Bitte eine Liste wählen");
        const r = await api(`/api/campaigns/${c.id}/leads`, { method: "POST", body: { list_id: Number(listSel.value) } });
        const reasons = Object.entries(r.reasons || {});
        if (reasons.length) {
          modal({ title: "Leads hinzugefügt", body: h("div", { class: "stack-sm" },
            h("p", null, `${num(r.added)} hinzugefügt, ${num(r.already)} schon enthalten, ${num(r.skipped)} nicht aufgenommen:`),
            h("ul", null, reasons.map(([why, n]) => h("li", null, `${num(n)} × ${why}`))),
            reasons.some(([why]) => /Einwilligung/.test(why)) ? h("div", { class: "alert info" }, "Einwilligung mit Quelle unter „Leads“ setzen (Auswahl → „Einwilligung setzen“) – oder eine Kampagne mit anderer Rechtsgrundlage wählen.") : null) });
        } else toast(`${num(r.added)} hinzugefügt, ${num(r.already)} schon enthalten`);
        reload();
      }) }, "Liste hinzufügen"),
      h("a", { class: "btn", href: "#/leads" }, "Leads importieren"))),
    h("div", { class: "row" }, search, statusSel),
    tableBox));
  await reload();
}

// ---------- Einstellungen ----------
async function drawSettings(body, c, onSaved) {
  const [mailboxes, groups, products, plays, autoLists] = await Promise.all([api("/api/mailboxes"), api("/api/target-groups"), api("/api/products"), api("/api/plays").catch(() => []), api("/api/lists").catch(() => [])]);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["Europe/Berlin", "Europe/Vienna", "Europe/Zurich", "UTC"];
  const f = {
    name: input({ value: c.name }),
    target_group_id: select([["", "– ohne Zielgruppe –"], ...groups.map(g => [g.id, g.name])], c.target_group_id || ""),
    product_id: select([["", "– ohne Produkt –"], ...products.map(x => [x.id, x.name])], c.product_id || ""),
    play_id: select([["", "– ohne Play –"], ...plays.map(x => [x.id, x.name])], c.play_id || ""),
    legal_basis: select(LEGAL_OPTIONS, c.legal_basis),
    min_fit: select([["", "Alle Leads (ohne Qualitätsfilter)"], ["A", "Nur A (sehr gut passend)"], ["B", "A und B (passend)"], ["C", "A bis C (alles außer „passt nicht“)"]], c.min_fit || ""),
    auto_list: select([["", "– nicht automatisch nachladen –"], ...autoLists.map(l => [l.id, `${l.name} (${l.lead_count})`])], c.auto_list_id || ""),
    nurture_enabled: checkbox("Bei Interesse automatisch nachfassen", c.nurture_enabled, "Wenn jemand Interesse gezeigt hat und auf eure Antwort nicht reagiert."),
    nurture_days: input({ type: "number", min: 1, max: 30, value: c.nurture_days }),
    nurture_max: input({ type: "number", min: 0, max: 5, value: c.nurture_max }),
    nurture_mode: select([["auto", "Automatisch senden (nur freigegebene Texte)"], ["draft", "Als Entwurf in die Aufgaben – ich sende selbst"]], c.nurture_mode),
    timezone: select(zones.map(z => [z, z]), c.timezone),
    window_start: input({ type: "time", value: c.window_start }),
    window_end: input({ type: "time", value: c.window_end }),
    daily_limit: input({ type: "number", min: 1, value: c.daily_limit }),
    ramp_enabled: checkbox("Langsam hochfahren", !!c.ramp_enabled, "Woche 1 und 2 mit niedrigerem Limit, danach das volle Tageslimit (ab Kampagnenstart)."),
    ramp_week1: input({ type: "number", min: 1, value: c.ramp_week1 ?? 150 }),
    ramp_week2: input({ type: "number", min: 1, value: c.ramp_week2 ?? 250 }),
    min_gap: input({ type: "number", min: 1, value: Math.round(c.min_gap_sec / 60) }),
    max_gap: input({ type: "number", min: 1, value: Math.round(c.max_gap_sec / 60) }),
    start_at: input({ type: "datetime-local", value: c.start_at ? new Date(c.start_at - new Date(c.start_at).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "" }),
    stop_on_reply: checkbox("Bei Antwort stoppen", c.stop_on_reply, "Lead bekommt keine Follow-ups mehr, sobald er antwortet (empfohlen)."),
    stop_company_on_reply: checkbox("Ganze Firma stoppen, wenn jemand antwortet", c.stop_company_on_reply, "Gilt für Kollegen mit derselben Firmen-Domain in dieser Kampagne."),
    stop_on_auto_reply: checkbox("Auch bei Abwesenheitsnotiz stoppen", c.stop_on_auto_reply, "Standard: aus – Abwesenheitsnotizen zählen nicht als Antwort."),
    skip_missing_vars: checkbox("Leads mit fehlenden Variablen überspringen", c.skip_missing_vars, "Verhindert Mails wie „Hallo ,“. Alternativ Fallbacks setzen."),
    skip_risky: checkbox("Riskante Adressen überspringen (z. B. info@)", c.skip_risky),
    unsubscribe: checkbox("Abmelde-Link und List-Unsubscribe-Header", c.unsubscribe, "Empfohlen: rechtlich sinnvoll und Pflicht bei Gmail/Yahoo für größere Volumen."),
    track_opens: checkbox("Öffnungen tracken", c.track_opens, "Fügt ein Pixel ein (HTML-Mail). Senkt die Zustellbarkeit leicht; Werte durch Apple Mail Privacy ungenau."),
    track_clicks: checkbox("Klicks tracken", c.track_clicks, "Links laufen über die Tracking-Domain."),
    ai_mode: select([["off", "Aus – nur Vorlage"], ["first_line", "Einstiegssatz je Lead ({{ai_first_line}})"], ["full", "Volltext je Lead (Vorlage als Leitplanke)"]], c.ai_mode),
    ai_instructions: textarea({ value: c.ai_instructions, rows: 3, placeholder: "z. B. „Immer auf regionale Nähe (Oberberg) eingehen“, „keine Duz-Form“" })
  };
  const days = new Set(String(c.days).split(",").map(Number));
  const dayBoxes = DAYS.map(([n, label]) => h("button", { type: "button", class: ["chip", days.has(n) && "active"], onclick: e => { days.has(n) ? days.delete(n) : days.add(n); e.currentTarget.classList.toggle("active"); } }, label));
  const chosen = new Set(c.mailbox_ids);
  const boxList = mailboxes.length ? mailboxes.map(m => checkbox(`${m.email}${m.from_name ? ` (${m.from_name})` : ""}`, chosen.has(m.id), `${m.status === "active" ? "aktiv" : m.status} · ${m.daily_limit}/Tag${m.imap_configured ? "" : " · ohne IMAP!"}`, { value: m.id })) : [h("div", { class: "alert warn" }, "Noch kein Postfach verbunden. ", h("a", { href: "#/postfaecher" }, "Jetzt verbinden"))];
  const aiHint = h("div", { class: "hint" }, state.meta?.ai_available ? "Die KI nutzt Produkt- und Zielgruppen-Profil, den Anlass des Leads und seine Website. Text wird vor dem Versand erzeugt und ist in der Vorschau sichtbar; jede Anfrage zählt gegen das Kontingent des Max-Abos." : aiMissingText);
  const legalHint = h("div", { class: "hint" });
  const updateLegal = () => {
    const cold = f.legal_basis.value === "cold";
    legalHint.textContent = f.legal_basis.value === "consent" ? "Nur Leads mit dokumentierter Einwilligung (Quelle + Datum) werden angeschrieben." : f.legal_basis.value === "customer" ? "Nur Bestandskunden: eigene ähnliche Produkte, Widerspruchsrecht wurde bei der Erhebung genannt." : "Riskant: E-Mail-Werbung ohne Einwilligung kann abgemahnt werden. Höchstens 3 Mails, nur Firmenadressen, kein Tracking, Bestätigung nötig.";
    for (const cb of [f.track_opens, f.track_clicks]) { cb.input.disabled = f.legal_basis.value !== "consent"; if (cb.input.disabled) cb.input.checked = false; }
    if (cold && !f.min_fit.value) f.min_fit.value = "B";
  };
  f.legal_basis.addEventListener("change", updateLegal);
  updateLegal();
  clear(body, h("div", { class: "stack", style: { maxWidth: "920px" } },
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Allgemein")), h("div", { class: "card-body form-grid" }, field("Name", f.name), field("Produkt", f.product_id, "Liefert {{termin_link}}, {{kit_link}} und das Produktwissen."), field("Zielgruppe", f.target_group_id), field("Play", f.play_id, "Für das Lernen: Welcher Ansatz (Anlass, Persona, Angle) steckt hinter dieser Kampagne?"))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Rechtsgrundlage & Qualität")), h("div", { class: "card-body stack-sm" },
      h("div", { class: "form-grid" }, field("Rechtsgrundlage", f.legal_basis), field("Qualitätsfilter (KI-Prüfung je Produkt)", f.min_fit), h("div", { class: "full" }, field("Leads automatisch aus Liste nachladen (Autopilot)", f.auto_list, "Neue Leads dieser Liste (z. B. der Projekt-Pool) kommen von selbst in die Kampagne; wer vor der ersten Mail aus der Liste fliegt, wird wieder ausgetragen."))), legalHint,
      coldAckBox(c, onSaved),
      h("div", { class: "hint" }, "Unabhängig davon gelten die Kontaktregeln aus den Einstellungen (Sperrfristen, max. Kontakte je Firma, Widersprüche). ", h("a", { href: "#/richtlinien" }, "Richtlinien")))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Postfächer (Rotation)")), h("div", { class: "card-body stack-sm" }, h("div", { class: "hint" }, "Neue Leads werden auf die gewählten Postfächer verteilt; Follow-ups gehen immer vom selben Postfach wie die erste Mail."), boxList)),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Zeitplan & Limits")), h("div", { class: "card-body form-grid" },
      h("div", { class: "full field" }, h("span", { class: "label" }, "Versandtage"), h("div", { class: "chips" }, dayBoxes)),
      field("Von", f.window_start), field("Bis", f.window_end),
      field("Zeitzone", f.timezone), field("Start ab (optional)", f.start_at),
      field("Max. Mails pro Tag (Kampagne)", f.daily_limit, "Zusätzlich gilt das Tageslimit jedes Postfachs (z. B. 10 Postfächer × 30 = 300)."), h("div", { class: "field" }, f.ramp_enabled),
      field("Limit Woche 1", f.ramp_week1, "Empfehlung 100–150"), field("Limit Woche 2", f.ramp_week2, "Empfehlung 200–250"),
      field("Abstand min. (Minuten)", f.min_gap, "Zufälliger Abstand zwischen zwei Mails eines Postfachs."), field("Abstand max. (Minuten)", f.max_gap))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Verhalten")), h("div", { class: "card-body stack-sm" }, f.stop_on_reply, f.stop_company_on_reply, f.stop_on_auto_reply, f.skip_missing_vars, f.skip_risky, f.unsubscribe)),
    c.is_template ? null : h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Nachfassen")), h("div", { class: "card-body stack-sm" },
      f.nurture_enabled, h("div", { class: "form-grid" }, field("Nachfassen nach (Tagen ohne Antwort)", f.nurture_days), field("Max. Nachfass-Mails", f.nurture_max), h("div", { class: "full" }, field("Modus", f.nurture_mode))),
      h("div", { class: "hint" }, "Die Nachfass-Texte stehen im Tab „Sequenz“ und gehören zur Freigabe."))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Tracking")), h("div", { class: "card-body stack-sm" }, h("div", { class: "alert info" }, "Für Cold Mails empfehlen wir reinen Text ohne Tracking – Antworten sind die Kennzahl, die zählt."), f.track_opens, f.track_clicks)),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "KI-Personalisierung")), h("div", { class: "card-body stack-sm" }, field("Modus", f.ai_mode), aiHint, field("Hinweise für die KI", f.ai_instructions))),
    h("div", { class: "row" }, h("div", { class: "grow" }), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const mailboxIds = mailboxes.length ? boxList.filter(b => b.input?.checked).map(b => Number(b.input.value)) : [];
      await api(`/api/campaigns/${c.id}`, { method: "PUT", body: {
        name: f.name.value, target_group_id: f.target_group_id.value ? Number(f.target_group_id.value) : null, timezone: f.timezone.value,
        product_id: f.product_id.value ? Number(f.product_id.value) : null, play_id: f.play_id.value ? Number(f.play_id.value) : null, legal_basis: f.legal_basis.value, min_fit: f.min_fit.value,
        auto_list_id: f.auto_list.value ? Number(f.auto_list.value) : null,
        nurture_enabled: f.nurture_enabled.input.checked, nurture_days: Number(f.nurture_days.value), nurture_max: Number(f.nurture_max.value), nurture_mode: f.nurture_mode.value,
        days: [...days].sort(), window_start: f.window_start.value, window_end: f.window_end.value, daily_limit: Number(f.daily_limit.value),
        ramp_enabled: f.ramp_enabled.input.checked, ramp_week1: Number(f.ramp_week1.value), ramp_week2: Number(f.ramp_week2.value),
        min_gap_sec: Number(f.min_gap.value) * 60, max_gap_sec: Number(f.max_gap.value) * 60, start_at: f.start_at.value ? new Date(f.start_at.value).getTime() : null,
        stop_on_reply: f.stop_on_reply.input.checked, stop_company_on_reply: f.stop_company_on_reply.input.checked, stop_on_auto_reply: f.stop_on_auto_reply.input.checked,
        skip_missing_vars: f.skip_missing_vars.input.checked, skip_risky: f.skip_risky.input.checked, unsubscribe: f.unsubscribe.input.checked,
        track_opens: f.track_opens.input.checked, track_clicks: f.track_clicks.input.checked, ai_mode: f.ai_mode.value, ai_instructions: f.ai_instructions.value,
        mailbox_ids: mailboxIds
      } });
      const r = await api(`/api/campaigns/${c.id}`);
      toast(r.legal_basis !== c.legal_basis ? "Gespeichert – Rechtsgrundlage geändert, Texte bitte erneut freigeben" : "Einstellungen gespeichert");
      onSaved();
    }) }, "Speichern"))));
}

// Bewährtes Gerüst: Entry-Mail (A/B), Follow-ups im selben Thread (leerer Betreff), am Ende eine Break-up-Mail.
// Kaltakquise: höchstens 3 Mails (Entry, 1 Follow-up, Break-up).
function sequenceSkeleton(cold) {
  // Eskalation: erste Mail mit Einstiegsangebot → Nachhaken → ein neuer Aspekt → Relevanz-Frage → Abschluss.
  const v = (subject, body) => ({ subject, body, enabled: true });
  const entry = { delay_days: 0, variants: [
    v("Frage zu {{company}}", "{{anrede}},\n\n[Individueller Bezug: etwas Konkretes über {{company}} – Kundenstimme, Leistung, Region]\n\n[Einstiegsangebot: Was bekommt der Empfänger konkret, ohne Aufwand für ihn?]\n\n[Eine leichte Handlung, z. B. „Soll ich Ihnen das kurz schicken?“]\n\nViele Grüße"),
    v("{{first_name}}, kurze Frage", "{{anrede}},\n\n[Variante B: nur EINE Sache anders – anderer Einstieg, gleiches Angebot]\n\n[Eine leichte Handlung]\n\nViele Grüße")
  ] };
  const step = (delay, text) => ({ delay_days: delay, variants: [v("", `{{anrede}},\n\n${text}\n\nViele Grüße`)] });
  const reminder = step(3, "[Nachhaken, 30–50 Wörter: Ist meine Nachricht im Alltag untergegangen? Kein neues Argument.]");
  const aspect = delay => step(delay, "[Mehrwert, 50–80 Wörter: GENAU EIN neuer Aspekt – belegtes Beispiel oder Ergebnis. Angebot nicht wiederholen.]");
  const relevance = step(7, "[Relevanz-Frage, 40–60 Wörter: Ist das Thema gerade überhaupt dran, oder lieber später?]");
  const breakup = delay => ({ delay_days: delay, variants: [v("Letzter Versuch", "{{anrede}},\n\nda ich nichts von Ihnen gehört habe, passt das Thema vermutlich gerade nicht, völlig in Ordnung. Ich melde mich nicht weiter. Falls es später relevant wird, antworten Sie einfach auf diese Mail.\n\nViele Grüße")] });
  return cold ? [entry, aspect(5), breakup(7)] : [entry, reminder, aspect(5), relevance, breakup(7)];
}
