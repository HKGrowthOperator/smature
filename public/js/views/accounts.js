// Firmen: alle Accounts mit Status, Scores und Why-now. Neue Firmen per Domain anlegen und recherchieren lassen.
import { h, clear, api, icon, busy, toast, modal, field, input, textarea, select, checkbox, num, relTime, skeletonRows, emptyState, pager, debounce, lifecycleBadge, projectDot, projectSelect, state, aiMissingText, waitForJob } from "../lib.js";

let meta = null;
const view = { project: "", lifecycle: "active", q: "", sort: "opportunity", page: 1 };

export async function render(el) {
  if (state.query?.has("projekt")) { view.project = state.query.get("projekt"); view.page = 1; }
  if (state.query?.has("status")) { view.lifecycle = state.query.get("status"); view.page = 1; }
  meta = meta || await api("/api/revenue/meta");
  clear(el, head(el), h("div", { class: "content" }, skeletonRows(6)));
  await draw(el);
}

function head(el) {
  return h("div", { class: "page-head" }, h("h1", null, "Firmen"), h("span", { class: "sub" }, "Account Brain: belegte Fakten, Anlässe, Personen, nächster Schritt"),
    h("div", { class: "actions" },
      h("button", { class: "btn", onclick: () => bulkResearch(el) }, icon("sparkles"), "Neue recherchieren"),
      h("button", { class: "btn btn-primary", onclick: () => openCreate(el) }, icon("plus"), "Firma hinzufügen")));
}

async function draw(el) {
  const qs = new URLSearchParams({ sort: view.sort, page: String(view.page), limit: "50" });
  if (view.project) qs.set("project", view.project);
  if (view.lifecycle) qs.set("lifecycle", view.lifecycle);
  if (view.q) qs.set("q", view.q);
  const res = await api(`/api/accounts?${qs}`);
  const refresh = () => draw(el);
  const search = input({ type: "search", placeholder: "Name, Domain, Ort, Branche", value: view.q, oninput: debounce(e => { view.q = e.target.value; view.page = 1; refresh(); }, 350) });
  const project = select([["", "Alle Projekte"], ["none", "Ohne Projekt"], ...(state.projects || []).map(p => [p.id, p.name])], view.project, { onchange: e => { view.project = e.target.value; view.page = 1; refresh(); } });
  const sort = select([["opportunity", "Beste Chance zuerst"], ["recent", "Zuletzt geändert"], ["check", "Nächste Prüfung"], ["name", "Name"]], view.sort, { onchange: e => { view.sort = e.target.value; refresh(); } });
  const counts = res.counts || {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const chip = (key, label, n) => h("button", { class: ["chip", view.lifecycle === key && "active"], onclick: () => { view.lifecycle = key; view.page = 1; refresh(); } }, label, n !== undefined ? h("span", { class: "count" }, num(n)) : null);
  const order = ["triggered", "qualified", "outreach_ready", "contacted", "engaged", "meeting", "opportunity", "proposal", "watching", "researched", "discovered", "no_response", "not_now", "won", "lost", "disqualified", "suppressed"];
  const inactive = ["disqualified", "suppressed", "lost", "won"].reduce((s, k) => s + (counts[k] || 0), 0);
  clear(el, head(el), h("div", { class: "content stack" },
    h("div", { class: "row" }, search, project, sort),
    h("div", { class: "chips" }, chip("active", "Aktiv", total - inactive), chip("", "Alle", total), order.filter(k => counts[k]).map(k => chip(k, meta.lifecycle[k], counts[k]))),
    h("div", { class: "card" },
      res.items.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", null, "Firma"), h("th", null, "Status"), h("th", { class: "num" }, "Chance"), h("th", null, "Why now"), h("th", null, "Projekt"), h("th", null, "Recherche"))),
        h("tbody", null, res.items.map(a => h("tr", { class: "clickable", onclick: () => { location.hash = `#/firmen/${a.id}`; } },
          h("td", null, h("div", { class: "strong ellipsis" }, a.name || a.domain), h("div", { class: "small muted ellipsis" }, [a.domain, a.city, a.industry].filter(Boolean).join(" · "))),
          h("td", null, lifecycleBadge(a.lifecycle, a.lifecycle_label), a.open_opps ? h("div", { class: "small muted" }, `${a.open_opps} Chance(n)`) : null),
          h("td", { class: "num" }, h("span", { class: "strong" }, a.opportunity_score ?? "–"), a.fit_score !== null ? h("div", { class: "small muted" }, `Fit ${a.fit_score} · Timing ${a.timing_score}`) : null),
          h("td", { class: "small", style: { maxWidth: "340px" } }, a.why_now ? h("div", { class: "ellipsis", title: a.why_now }, a.why_now) : h("span", { class: "muted" }, a.signals ? `${a.signals} Anlässe` : "–")),
          h("td", null, projectDot(a.project_color, a.project_name)),
          h("td", { class: "small muted" }, a.research_error ? h("span", { class: "danger-text", title: a.research_error }, "Fehler") : a.researched_at ? relTime(a.researched_at) : "offen",
            a.next_check_at ? h("div", null, `Prüfung ${relTime(a.next_check_at)}`) : null))))),
        pager({ page: res.page, limit: res.limit, total: res.total, onPage: p => { view.page = p; refresh(); } }))
        : total ? emptyState("Keine Firmen mit diesem Filter", `Insgesamt ${num(total)} Firmen – Filter oder Suche ändern.`, h("button", { class: "btn", onclick: () => { view.lifecycle = ""; view.q = ""; view.project = ""; view.page = 1; refresh(); } }, "Alle anzeigen"))
        : emptyState("Keine Firmen", "Firmen entstehen automatisch aus importierten Leads (über die Domain) oder du legst sie hier per Website an – z. B. aus einer Messe- oder Branchenliste.", h("button", { class: "btn btn-primary", onclick: () => openCreate(el) }, icon("plus"), "Firma hinzufügen"))),
    h("div", { class: "hint" }, "Recherche liest nur die öffentliche Firmen-Website (Start, Impressum, Über uns, Karriere, News). Personen werden nur übernommen, wenn sie dort genannt sind – keine privaten Profile, kein LinkedIn-Scraping.")));
}

function openCreate(el) {
  const domains = textarea({ rows: 5, placeholder: "eine Website oder Domain pro Zeile, z. B.\nmueller-metallbau.de\nhttps://www.beispiel-gmbh.de" });
  const project = projectSelect(view.project && view.project !== "none" ? view.project : "");
  const product = select([["", "– Produkt später wählen –"]], "");
  api("/api/products").then(list => list.forEach(p => product.append(h("option", { value: p.id }, p.name)))).catch(() => {});
  const research = checkbox("Direkt recherchieren (KI, Max-Abo)", !!state.meta?.ai_available, state.meta?.ai_available ? "Liest die Website, bewertet Fit/Pain/Timing und schlägt den Einstieg vor." : aiMissingText, { disabled: !state.meta?.ai_available });
  const dlg = modal({
    title: "Firmen hinzufügen",
    body: h("div", { class: "stack" }, field("Websites / Domains", domains, "Bis zu 200 auf einmal. Doppelte werden übersprungen."), h("div", { class: "grid-2" }, field("Projekt", project), field("Produkt", product)), research),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const lines = [...new Set(domains.value.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean))].slice(0, 200);
      if (!lines.length) throw new Error("Mindestens eine Website angeben");
      const ids = [];
      let skipped = 0;
      for (const line of lines) {
        try {
          const r = await api("/api/accounts", { method: "POST", body: { domain: line, project_id: project.value || null, product_id: product.value || null } });
          ids.push(r.account.id);
        } catch { skipped++; }
      }
      dlg.close();
      toast(`${ids.length} Firma(en) angelegt${skipped ? `, ${skipped} übersprungen` : ""}`);
      if (research.input.checked && ids.length) {
        const job = await api("/api/accounts/research", { method: "POST", body: { ids } });
        toast("Recherche läuft im Hintergrund");
        waitForJob(job.id).then(j => { toast(`Recherche fertig: ${j.done} von ${j.total}${j.failed ? `, ${j.failed} Fehler` : ""}`); draw(el); }).catch(() => {});
      }
      if (ids.length === 1) location.hash = `#/firmen/${ids[0]}`; else draw(el);
    }) }, "Hinzufügen")]
  });
}

async function bulkResearch(el) {
  if (!state.meta?.ai_available) { toast(aiMissingText, "error"); return; }
  const lifecycle = view.lifecycle && meta.lifecycle[view.lifecycle] ? view.lifecycle : "discovered";
  try {
    const job = await api("/api/accounts/research", { method: "POST", body: { lifecycle, project_id: view.project && view.project !== "none" ? view.project : undefined } });
    toast(`Recherche gestartet: ${job.total} Firmen („${meta.lifecycle[lifecycle]}“)`);
    waitForJob(job.id).then(j => { toast(`Recherche fertig: ${j.done} von ${j.total}${j.failed ? `, ${j.failed} Fehler${j.error ? ` (${j.error})` : ""}` : ""}`); draw(el); }).catch(() => {});
  } catch (err) {
    toast(err.message, "error");
  }
}
