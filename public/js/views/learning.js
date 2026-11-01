// Plays & Lernen: Plays pflegen (Branche × Anlass × Persona × Pain × Angle × Beleg × Kanal × CTA) und sehen,
// was bis zum Umsatz funktioniert – nicht nur bis zur Antwort.
import { h, clear, api, icon, busy, toast, modal, field, input, textarea, select, euro, num, pct, skeletonRows, emptyState, state, projectSelect, confirmDialog } from "../lib.js";

let meta = null;
let projectFilter = "";

export async function render(el) {
  meta = meta || await api("/api/revenue/meta");
  clear(el, head(), h("div", { class: "content" }, skeletonRows(6)));
  const qs = projectFilter ? `?project=${projectFilter}` : "";
  const [plays, r, products] = await Promise.all([api(`/api/plays${qs}`), api(`/api/learning${qs}`), api("/api/products").catch(() => [])]);
  const reload = () => render(el);
  const preset = state.query?.get("neu");
  if (preset) { history.replaceState(null, "", "#/lernen"); setTimeout(() => playDialog(null, products, reload, preset), 0); }
  const filter = select([["", "Alle Projekte"], ...(state.projects || []).map(p => [p.id, p.name])], projectFilter, { style: { width: "220px", flex: "none" }, onchange: e => { projectFilter = e.target.value; reload(); } });
  const t = r.totals;
  const table = (title, rows, hint) => h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, title), hint ? h("span", { class: "muted small" }, hint) : null),
    rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, ""), h("th", { class: "num" }, "Chancen"), h("th", { class: "num" }, "Qualifiziert"), h("th", { class: "num" }, "Gewonnen"), h("th", { class: "num" }, "Umsatz"), h("th", { class: "num" }, "Win-Rate"))),
      h("tbody", null, rows.map(x => h("tr", null, h("td", { class: "strong", style: { maxWidth: "320px" } }, x.label), h("td", { class: "num" }, num(x.opportunities)), h("td", { class: "num" }, num(x.qualified)), h("td", { class: "num" }, num(x.won)), h("td", { class: "num" }, euro(x.revenue)), h("td", { class: "num" }, x.win_rate === null ? "–" : pct(x.win_rate)))))))
      : h("div", { class: "card-body small muted" }, "Noch keine Daten – entsteht mit den ersten Chancen."));

  clear(el, head(filter, () => playDialog(null, products, reload)),
    h("div", { class: "content stack" },
      h("div", { class: "kpis" },
        h("div", { class: "card kpi" }, h("div", { class: "label" }, "Chancen gesamt"), h("div", { class: "value" }, num(t.opportunities)), h("div", { class: "meta" }, `${num(t.qualified)} qualifiziert`)),
        h("div", { class: "card kpi" }, h("div", { class: "label" }, "Angebote"), h("div", { class: "value" }, num(t.proposals))),
        h("div", { class: "card kpi" }, h("div", { class: "label" }, "Gewonnen"), h("div", { class: "value" }, num(t.won)), h("div", { class: "meta" }, euro(t.revenue))),
        h("div", { class: "card kpi" }, h("div", { class: "label" }, "Win-Rate"), h("div", { class: "value" }, t.win_rate === null ? "–" : pct(t.win_rate)), h("div", { class: "meta" }, t.avg_cycle_days !== null ? `Ø ${t.avg_cycle_days} Tage bis Auftrag` : "")),
        h("div", { class: "card kpi" }, h("div", { class: "label" }, "Verloren"), h("div", { class: "value" }, num(t.lost)))),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Plays"), h("span", { class: "muted small" }, "sortiert nach Umsatz je Firma")),
        r.plays.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
          h("thead", null, h("tr", null, h("th", null, "Play"), h("th", { class: "num" }, "Firmen"), h("th", { class: "num" }, "Erreicht"), h("th", { class: "num" }, "Antw."), h("th", { class: "num" }, "Termine"), h("th", { class: "num" }, "Qualif."), h("th", { class: "num" }, "Angebote"), h("th", { class: "num" }, "Gewonnen"), h("th", { class: "num" }, "€ / Firma"), h("th", null, ""))),
          h("tbody", null, r.plays.map(p => {
            const full = plays.find(x => x.id === p.id);
            return h("tr", null,
              h("td", null, h("div", { class: "strong" }, p.name, p.status === "paused" ? h("span", { class: "badge", style: { marginLeft: "6px" } }, "pausiert") : null), h("div", { class: "small muted" }, [p.project_name, p.persona, p.angle].filter(Boolean).join(" · "))),
              h("td", { class: "num" }, num(p.accounts)), h("td", { class: "num" }, num(p.reached)), h("td", { class: "num" }, num(p.replied)), h("td", { class: "num" }, num(p.meetings)),
              h("td", { class: "num" }, num(p.qualified)), h("td", { class: "num" }, num(p.proposals)), h("td", { class: "num" }, num(p.won)), h("td", { class: "num strong" }, euro(p.revenue_per_account)),
              h("td", null, full ? h("button", { class: "btn btn-ghost btn-icon btn-sm", "aria-label": "Bearbeiten", onclick: () => playDialog(full, products, reload) }, icon("edit")) : null));
          }))))
          : emptyState("Noch keine Plays", "Ein Play beschreibt, wen wir mit welchem Anlass und welchem Argument ansprechen – z. B. „Metallbau · sucht Monteure · Geschäftsführer · Einsatzplanung per Excel · ‚Disposition bei Wachstum‘ · Anruf“.", h("button", { class: "btn btn-primary", onclick: () => playDialog(null, products, reload) }, icon("plus"), "Play anlegen"))),
      h("div", { class: "grid-2" },
        table("Nach Angle", r.by_angle), table("Nach Persona", r.by_persona),
        table("Nach Pain", r.by_pain), table("Nach Anlass", r.by_trigger),
        table("Nach Kanal (erster Kontakt)", r.by_channel), table("Nach Branche", r.by_industry)),
      h("div", { class: "grid-2" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Verlustgründe")),
          h("div", { class: "card-body" }, r.loss_reasons.length ? h("div", { class: "mini-list" }, r.loss_reasons.map(x => h("div", { class: "item" }, h("span", { class: "name" }, x.label), h("span", { class: "meta" }, num(x.n))))) : h("div", { class: "small muted" }, "Noch keine verlorenen Chancen."),
            r.detectable_earlier.length ? h("div", { style: { marginTop: "10px" } }, h("div", { class: "strong small" }, "Früher erkennbar gewesen"), h("ul", { class: "small", style: { margin: "4px 0 0", paddingLeft: "18px" } }, r.detectable_earlier.map(x => h("li", null, h("a", { href: `#/pipeline/${x.opportunity_id}` }, x.title), x.signal ? ` – ${x.signal}` : "", x.learning ? h("div", { class: "muted" }, `Regel: ${x.learning}`) : null)))) : null)),
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Häufigste Einwände")),
          h("div", { class: "card-body" }, r.objections.length ? h("div", { class: "mini-list" }, r.objections.map(x => h("div", { class: "item", title: (x.examples || []).join("\n") }, h("span", { class: "name" }, x.text), h("span", { class: "meta" }, `${x.n}×`)))) : h("div", { class: "small muted" }, "Einwände aus Gesprächen und Antworten erscheinen hier.")))),
      h("div", { class: "hint" }, "Wir optimieren auf qualifizierte Termine und Umsatz je Firma – nicht auf Antwort- oder Öffnungsraten. Ein Play mit wenigen Antworten, aber vielen Aufträgen ist besser als umgekehrt.")));
}

function head(filter, onNew) {
  return h("div", { class: "page-head" }, h("h1", null, "Plays & Lernen"), h("span", { class: "sub" }, "Was bringt wirklich Aufträge?"),
    filter ? h("div", { class: "actions" }, filter, h("button", { class: "btn btn-primary", onclick: onNew }, icon("plus"), "Play")) : null);
}

function playDialog(p, products, reload, presetProject = "") {
  const f = {
    name: input({ value: p?.name || "", placeholder: "z. B. Metallbau – Monteure gesucht" }),
    project_id: projectSelect(p?.project_id ?? presetProject),
    product_id: select([["", "– Produkt –"], ...products.map(x => [x.id, x.name])], p?.product_id ?? ""),
    industry: input({ value: p?.industry || "", placeholder: "z. B. Metallbau, Maschinenbau (50–250 MA)" }),
    trigger_type: select([["", "– Anlass –"], ...Object.entries(meta.signal_types)], p?.trigger_type || ""),
    persona: input({ value: p?.persona || "", placeholder: "z. B. Geschäftsführer, Leitung Service" }),
    pain: textarea({ value: p?.pain || "", rows: 2, placeholder: "z. B. Einsatzplanung per Excel/Telefon wird bei Wachstum unübersichtlich" }),
    angle: textarea({ value: p?.angle || "", rows: 2, placeholder: "Der Gedanke, mit dem wir einsteigen – als Frage, nicht als Behauptung" }),
    proof: textarea({ value: p?.proof || "", rows: 2, placeholder: "Belegtes Beispiel/Referenz" }),
    channel: select([["email", "E-Mail (Cold Mailing)"]], "email"),
    cta: input({ value: p?.cta || "", placeholder: "z. B. 15 Minuten Prozess-Check" }),
    status: select([["active", "Aktiv"], ["paused", "Pausiert"]], p?.status || "active")
  };
  const dlg = modal({
    title: p ? `Play „${p.name}“` : "Neuer Play", wide: true,
    body: h("div", { class: "stack" },
      h("div", { class: "grid-2" }, field("Name", f.name), field("Status", f.status)),
      h("div", { class: "grid-2" }, field("Projekt", f.project_id), field("Produkt", f.product_id)),
      h("div", { class: "grid-2" }, field("Branche / Größe", f.industry), field("Anlass", f.trigger_type)),
      h("div", { class: "grid-2" }, field("Persona", f.persona), field("Kanal", f.channel, "Diese App macht nur Cold Mailing – telefoniert wird in der Sales App.")),
      field("Pain", f.pain), field("Angle", f.angle), field("Beleg", f.proof), field("CTA", f.cta),
      h("div", { class: "hint" }, "Die Recherche ordnet passende Firmen automatisch einem Play zu; Kampagnen lassen sich einem Play zuweisen. Das Lernen zeigt dann, welcher Play bis zum Auftrag führt.")),
    footer: [
      p ? h("button", { class: "btn btn-ghost btn-danger", onclick: e => busy(e.currentTarget, async () => {
        if (!(await confirmDialog(`Play „${p.name}“ löschen? Firmen und Chancen bleiben erhalten.`, { danger: true, confirm: "Löschen" }))) return;
        await api(`/api/plays/${p.id}`, { method: "DELETE" }); dlg.close(); reload();
      }) }, "Löschen") : null,
      h("div", { class: "grow" }),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"),
      h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.value]));
        body.project_id = body.project_id || null; body.product_id = body.product_id || null;
        await api(p ? `/api/plays/${p.id}` : "/api/plays", { method: p ? "PUT" : "POST", body });
        toast("Gespeichert"); dlg.close(); reload();
      }) }, "Speichern")
    ]
  });
}
