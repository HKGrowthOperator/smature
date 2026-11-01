// Chance im Detail: Phase, Wert, nächster Schritt, Termin-Briefing, Gesprächsauswertung (Discovery), Qualität,
// Herkunft (was hat zur Chance geführt) und Verlust-Analyse.
import { h, clear, api, icon, busy, toast, modal, field, input, textarea, select, checkbox, euro, dateTime, skeletonRows, state, aiMissingText, confirmDialog } from "../lib.js";

export async function render(el, [id]) {
  clear(el, h("div", { class: "content" }, skeletonRows(6)));
  draw(el, await api(`/api/opportunities/${id}`));
}

const toLocal = ts => (ts ? new Date(ts - new Date(ts).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
const fromLocal = v => (v ? new Date(v).getTime() : null);

function draw(el, d) {
  const o = d.opportunity;
  const reload = async () => draw(el, await api(`/api/opportunities/${o.id}`));
  const aiOn = state.meta?.ai_available;
  const f = {
    title: input({ value: o.title }), value: input({ type: "number", min: 0, value: o.value_eur ?? "" }), meeting: input({ type: "datetime-local", value: toLocal(o.meeting_at) }),
    next_step: input({ value: o.next_step || "", placeholder: "z. B. Angebot bis Freitag, Demo mit IT-Leitung" }), next_at: input({ type: "datetime-local", value: toLocal(o.next_step_at) }),
    probability: input({ type: "number", min: 0, max: 100, value: o.probability ?? "" })
  };
  const save = () => api(`/api/opportunities/${o.id}`, { method: "PUT", body: {
    title: f.title.value, value_eur: f.value.value === "" ? null : Number(f.value.value), meeting_at: fromLocal(f.meeting.value), next_step: f.next_step.value,
    next_step_at: fromLocal(f.next_at.value), probability: f.probability.value === "" ? null : Number(f.probability.value)
  } });
  const stageBtn = (stage, label, primary) => h("button", { class: ["btn btn-sm", primary && "btn-primary"], disabled: o.stage === stage, onclick: e => busy(e.currentTarget, async () => {
    await save();
    if (stage === "lost") return lostDialog(o, d, reload);
    if (stage === "won") return wonDialog(o, reload);
    await api(`/api/opportunities/${o.id}/stage`, { method: "POST", body: { stage } });
    toast(`Phase: ${d.stages[stage]}`); reload();
  }) }, label);

  clear(el,
    h("div", { class: "page-head" },
      h("div", null, h("div", { class: "crumb" }, h("a", { href: "#/pipeline" }, "Pipeline"), " / ", h("a", { href: `#/firmen/${o.account_id}` }, o.account_name)),
        h("div", { class: "row-tight" }, h("h1", null, o.title), h("span", { class: ["badge", o.stage === "won" ? "ok" : o.stage === "lost" ? "danger" : "info"] }, d.stages[o.stage]))),
      h("div", { class: "actions" },
        stageBtn("meeting", "Termin"), stageBtn("qualified", "Qualifiziert"), stageBtn("proposal", "Angebot"), stageBtn("won", "Gewonnen", true), stageBtn("lost", "Verloren"))),
    h("div", { class: "content" }, h("div", { class: "split" },
      h("div", { class: "stack" },
        briefCard(o, aiOn, reload, d.pain_guide || []),
        discoveryCard(o, d, aiOn, reload),
        o.stage === "lost" ? lossCard(o, d) : null),
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Eckdaten")),
          h("div", { class: "card-body stack-sm" },
            field("Titel", f.title),
            h("div", { class: "grid-2" }, field("Wert (€)", f.value), field("Wahrscheinlichkeit (%)", f.probability, `gewichtet: ${euro(o.weighted)}`)),
            field("Termin", f.meeting),
            field("Nächster Schritt", f.next_step), field("Bis wann", f.next_at),
            h("div", { class: "small muted" }, [o.person_name || [o.first_name, o.last_name].filter(Boolean).join(" "), o.person_role || o.position, o.product_name ? `Produkt: ${o.product_name}` : "", o.play_name ? `Play: ${o.play_name}` : ""].filter(Boolean).join(" · ")),
            h("div", { class: "row" },
              h("button", { class: "btn btn-sm btn-ghost btn-danger", onclick: e => busy(e.currentTarget, async () => {
                if (!(await confirmDialog("Chance löschen? Für das Lernen besser „Verloren“ mit Grund setzen.", { danger: true, confirm: "Löschen" }))) return;
                await api(`/api/opportunities/${o.id}`, { method: "DELETE" }); location.hash = "#/pipeline";
              }) }, "Löschen"),
              h("div", { class: "grow" }), h("button", { class: "btn btn-sm btn-primary", onclick: e => busy(e.currentTarget, async () => { await save(); toast("Gespeichert"); reload(); }) }, "Speichern")))),
        qualityCard(o, d, reload),
        attributionCard(o),
        hypothesesCard(d)))));
}

function list(items, empty = "–") {
  return items?.length ? h("ul", { style: { margin: 0, paddingLeft: "18px" } }, items.map(x => h("li", null, x))) : h("div", { class: "small muted" }, empty);
}

function briefCard(o, aiOn, reload, guide = []) {
  const p = o.prep;
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Termin-Briefing"), p ? h("span", { class: "muted small" }, dateTime(p.created_at)) : null,
    h("div", { class: "actions" }, h("button", { class: ["btn btn-sm", !p && "btn-primary"], disabled: !aiOn, title: aiOn ? "" : aiMissingText, onclick: e => busy(e.currentTarget, async () => { await api(`/api/opportunities/${o.id}/brief`, { method: "POST" }); toast("Briefing erstellt"); reload(); }) }, icon("sparkles"), p ? "Neu erstellen" : "Briefing erstellen"))),
    h("div", { class: "card-body stack-sm" }, p ? [
      h("div", null, h("div", { class: "strong small" }, "Ziel"), h("div", null, p.goal || "–"), p.next_step ? h("div", { class: "small muted" }, `Gewünschter nächster Schritt: ${p.next_step}`) : null),
      h("div", { class: "grid-2" },
        h("div", null, h("div", { class: "strong small" }, "Was wir wissen"), list(p.known_facts)),
        h("div", null, h("div", { class: "strong small" }, "Was wir vermuten (prüfen)"), list(p.hypotheses))),
      h("div", null, h("div", { class: "strong small" }, "Nicht unterstellen"), list(p.do_not_assume)),
      h("div", null, h("div", { class: "strong small" }, `${(p.questions || []).length} Fragen`), h("ol", { style: { margin: 0, paddingLeft: "18px" } }, (p.questions || []).map(q => h("li", null, q)))),
      p.risks?.length ? h("div", null, h("div", { class: "strong small" }, "Risiken / Einwände"), list(p.risks)) : null
    ] : h("div", { class: "small muted" }, "5-Minuten-Vorbereitung aus dem Account Brain: bekannte Fakten, Vermutungen, was wir nicht unterstellen dürfen und die Fragen für dieses Gespräch."),
      // Fester Leitfaden – funktioniert auch ohne KI.
      guide.length ? h("details", { class: "small", open: !p }, h("summary", { class: "strong" }, "Gesprächsleitfaden: Schmerz finden"),
        h("ol", { style: { margin: "6px 0 0", paddingLeft: "18px" } }, guide.map(g => h("li", null, h("strong", null, `${g.step}: `), g.question))),
        h("div", { class: "muted", style: { marginTop: "6px" } }, "Erst verstehen, dann anbieten. So konkret wie möglich nachfragen (Zahlen, Beispiele), keine Preise vor dem Schmerz.")) : null));
}

function discoveryCard(o, d, aiOn, reload) {
  const disc = o.discovery;
  const notes = textarea({ rows: 7, value: disc?.notes || "", placeholder: "Stichpunkte aus dem Gespräch: Was läuft heute wie? Welche Probleme wurden genannt? Wer entscheidet? Zeitplan? Budget? Nächster Schritt?" });
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Gesprächsauswertung")),
    h("div", { class: "card-body stack-sm" },
      notes,
      h("div", { class: "row" }, h("div", { class: "hint grow" }, "Die KI ordnet die Notizen ein: bestätigte/widerlegte Hypothesen, Systeme, Entscheidungsweg, Einwände und Gesprächsqualität – alles landet im Gedächtnis der Firma."),
        h("button", { class: "btn btn-sm btn-primary", disabled: !aiOn, title: aiOn ? "" : aiMissingText, onclick: e => busy(e.currentTarget, async () => { await api(`/api/opportunities/${o.id}/discovery`, { method: "POST", body: { notes: notes.value } }); toast("Ausgewertet"); reload(); }) }, icon("sparkles"), "Auswerten")),
      disc ? h("dl", { class: "kv" },
        h("dt", null, "Bestätigte Pains"), h("dd", null, list((disc.confirmed_pains || []).map(p => `${p.statement} (${p.severity})`))),
        h("dt", null, "Systeme"), h("dd", null, (disc.systems || []).join(", ") || "–"),
        h("dt", null, "Entscheidung"), h("dd", null, disc.decision_process || "–"),
        h("dt", null, "Zeitpunkt"), h("dd", null, disc.timing || "–"),
        h("dt", null, "Budget"), h("dd", null, disc.budget || "–"),
        h("dt", null, "Einwände"), h("dd", null, list((disc.objections || []).map(x => x.statement))),
        h("dt", null, "Nächster Schritt"), h("dd", null, disc.next_step || "–")) : null));
}

function qualityCard(o, d, reload) {
  const sliders = Object.entries(d.quality_keys).map(([k, label]) => {
    const val = h("span", { class: "strong" }, String(o.quality[k] ?? 0));
    const range = h("input", { type: "range", min: 0, max: 100, step: 5, value: o.quality[k] ?? 0, oninput: e => { val.textContent = e.target.value; } });
    return { k, el: h("div", null, h("label", null, label, val), range), range };
  });
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Gesprächsqualität"), o.quality_overall !== null ? h("span", { class: "muted small" }, `gesamt ${o.quality_overall}`) : null),
    h("div", { class: "card-body stack-sm" },
      h("div", { class: "quality-grid" }, sliders.map(s => s.el)),
      h("div", { class: "row" }, h("div", { class: "hint grow" }, "Ein Termin ist nicht gleich ein Termin: Entscheider, bestätigter Pain und Zeitpunkt bestimmen die Wahrscheinlichkeit."),
        h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => {
          await api(`/api/opportunities/${o.id}`, { method: "PUT", body: { quality: Object.fromEntries(sliders.map(s => [s.k, Number(s.range.value)])) } });
          toast("Gespeichert"); reload();
        }) }, "Übernehmen"))));
}

function attributionCard(o) {
  const a = o.attribution || {};
  const rows = [
    ["Erster Kontakt", a.first_touch_at ? `${dateTime(a.first_touch_at)} per ${a.first_channel === "call" ? "Telefon" : "E-Mail"}` : null],
    ["Erste Persona", a.first_persona], ["Termin mit", a.meeting_persona], ["Anlass", a.trigger], ["Anfangs-Pain", a.initial_pain],
    ["Angle", a.angle], ["Beleg", a.proof], ["Branche", a.industry], ["Bestätigte Pains", (a.confirmed_pains || []).join("; ")], ["Verkaufszyklus", a.sales_cycle_days !== null && a.sales_cycle_days !== undefined ? `${a.sales_cycle_days} Tage` : null],
    ["Scores beim Start", a.scores_at_start ? `Fit ${a.scores_at_start.fit ?? "–"} · Pain ${a.scores_at_start.pain ?? "–"} · Timing ${a.scores_at_start.timing ?? "–"}` : null]
  ].filter(([, v]) => v);
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Herkunft")),
    h("div", { class: "card-body" }, rows.length ? h("dl", { class: "kv small" }, rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)])) : h("div", { class: "small muted" }, "Wird beim Anlegen automatisch festgehalten.")));
}

function hypothesesCard(d) {
  const open = d.hypotheses.filter(x => x.status !== "rejected");
  if (!open.length) return null;
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Hypothesen der Firma"), h("a", { class: "small", href: `#/firmen/${d.opportunity.account_id}`, style: { marginLeft: "auto" } }, "im Profil prüfen")),
    h("div", { class: "card-body" }, list(open.map(x => `${x.status === "confirmed" ? "✓ " : ""}${x.statement}`))));
}

function lossCard(o, d) {
  const l = o.loss || {};
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Verlust")),
    h("div", { class: "card-body" }, h("dl", { class: "kv" },
      h("dt", null, "Hauptgrund"), h("dd", null, d.loss_reasons[l.primary] || "–"),
      h("dt", null, "Nebengrund"), h("dd", null, d.loss_reasons[l.secondary] || "–"),
      h("dt", null, "Eigentliche Ursache"), h("dd", null, l.underlying || "–"),
      h("dt", null, "Früher erkennbar?"), h("dd", null, l.detectable_earlier ? `Ja – ${l.signal || ""}` : "Nein"),
      h("dt", null, "Erkenntnis"), h("dd", null, l.learning || "–"))));
}

function wonDialog(o, reload) {
  const value = input({ type: "number", min: 1, value: o.value_eur ?? "" });
  const dlg = modal({
    title: "Gewonnen",
    body: h("div", { class: "stack" }, field("Auftragswert (€)", value, "Nur mit Wert lernt das System, welche Plays und Anlässe wirklich Umsatz bringen.")),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      await api(`/api/opportunities/${o.id}/stage`, { method: "POST", body: { stage: "won", value_eur: Number(value.value) } });
      dlg.close(); toast("Gewonnen gespeichert"); reload();
    }) }, "Speichern")]
  });
}

function lostDialog(o, d, reload) {
  const reasons = Object.entries(d.loss_reasons);
  const f = {
    primary: select([["", "– Hauptgrund –"], ...reasons], ""), secondary: select([["", "– Nebengrund (optional) –"], ...reasons], ""),
    notes: textarea({ rows: 3, placeholder: "Was wurde gesagt? Was ist passiert?" }), underlying: input({ placeholder: "Eigentliche Ursache in einem Satz" }),
    earlier: checkbox("Hätte man das früher erkennen können?", false), signal: input({ placeholder: "Welches Signal hätte es gezeigt?" }), learning: input({ placeholder: "Regel für die Zukunft, z. B. „Firmen mit neuem ERP-Projekt < 6 Monate nicht ansprechen“" })
  };
  const aiBtn = h("button", { class: "btn btn-sm", disabled: !state.meta?.ai_available, title: state.meta?.ai_available ? "" : aiMissingText, onclick: e => busy(e.currentTarget, async () => {
    const r = await api(`/api/opportunities/${o.id}/loss-analysis`, { method: "POST", body: { notes: f.notes.value } });
    f.primary.value = r.primary; f.secondary.value = r.secondary; f.underlying.value = r.underlying; f.earlier.input.checked = !!r.detectable_earlier; f.signal.value = r.signal; f.learning.value = r.learning;
  }) }, icon("sparkles"), "KI-Vorschlag");
  const dlg = modal({
    title: "Verloren – was lernen wir?", wide: true,
    body: h("div", { class: "stack" }, field("Notizen", f.notes), h("div", null, aiBtn), h("div", { class: "grid-2" }, field("Hauptgrund", f.primary), field("Nebengrund", f.secondary)), field("Eigentliche Ursache", f.underlying), f.earlier, field("Signal", f.signal), field("Erkenntnis", f.learning)),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-danger", onclick: e => busy(e.currentTarget, async () => {
      await api(`/api/opportunities/${o.id}/stage`, { method: "POST", body: { stage: "lost", loss: { primary: f.primary.value, secondary: f.secondary.value, notes: f.notes.value, underlying: f.underlying.value, detectable_earlier: f.earlier.input.checked, signal: f.signal.value, learning: f.learning.value } } });
      dlg.close(); toast("Gespeichert"); reload();
    }) }, "Als verloren speichern")]
  });
}
