// Leadquellen: Firmen je Projekt aus OpenStreetMap finden, Website + Impressum prüfen, passende in den Pool legen.
import { h, clear, api, icon, busy, toast, modal, drawer, field, input, textarea, select, checkbox, projectDot, num, relTime, skeletonRows, pager, confirmDialog, state, waitForJob } from "../lib.js";

const RUN_STATUS = { queued: ["Wartet", ""], running: ["Läuft", "accent"], paused: ["Pausiert", "warn"], done: ["Fertig", "ok"], failed: ["Fehler", "danger"] };
const CAND_STATUS = { new: "Offen", imported: "Im Pool", rejected: "Aussortiert", duplicate: "Schon vorhanden", error: "Fehler" };
const statusBadge = s => h("span", { class: ["badge", RUN_STATUS[s]?.[1]] }, RUN_STATUS[s]?.[0] || s);

export async function render(el) {
  const body = h("div", { class: "content stack" }, skeletonRows(5));
  clear(el,
    h("div", { class: "page-head" }, h("h1", null, "Leadquellen"), h("span", { class: "sub" }, "Firmen je Projekt finden, prüfen und in den Pool legen"),
      h("button", { class: "btn", title: "Alle Leads aus allen Pools per KI recherchieren und dem passenden Projekt zuordnen – nicht passende fliegen aus den Pools", onclick: e => busy(e.currentTarget, async () => {
        if (!(await confirmDialog("Alle Pool-Leads per KI recherchieren und neu zuordnen? Das dauert je nach Menge eine Weile und läuft im Hintergrund.", { confirm: "Starten" }))) return;
        let job; try { job = await api("/api/leads/assign", { method: "POST", body: { pools: true } }); } catch (err) { toast(err.message, "error"); return; }
        toast(`Auftrag gestartet: ${job.total} Leads`);
        const done = await waitForJob(job.id, j => { if (j.done % 25 === 0 && j.done) toast(`Zuordnung: ${j.done}/${j.total}`); });
        toast(`Zuordnung ${done.status}: ${Object.entries(done.results || {}).map(([k, n]) => `${n}× ${k}`).join(", ") || "–"}`, done.failed ? "error" : "success", 12000);
        reload?.();
      }) }, icon("sparkles"), "Alle Pools recherchieren & zuordnen"),
      h("div", { class: "actions" }, h("button", { class: "btn", onclick: () => openSettings(() => draw(body)) }, icon("settings"), "Regionen & Limit"))),
    body);
  await draw(body);
}

async function draw(body) {
  const [meta, runs, plan] = await Promise.all([api("/api/sourcing/meta"), api("/api/sourcing/runs"), api("/api/autopilot")]);
  const reload = () => draw(body);
  const live = runs.some(r => ["queued", "running"].includes(r.status));
  clear(body,
    autopilotCard(plan, reload),
    h("div", { class: "alert" }, h("div", { class: "text-body" },
      "So läuft es: Firmen mit Website oder E-Mail aus OpenStreetMap (je Region und Kategorie) → Website und Impressum der Firma lesen → Qualität der Website, Anfrage-Signale, Mitarbeiterzahl, Geschäftsführung, Chef-Adresse und belegte Fakten fürs Lob → passende Firmen landen als Leads im Pool des Projekts. ",
      h("b", null, `Heute geprüft: ${num(meta.daily.used)} von ${num(meta.daily.limit || 0) || "∞"}`),
      meta.state?.lastError ? h("span", { class: "danger" }, ` · Letzter Fehler: ${meta.state.lastError}`) : null)),
    h("div", { class: "grid-2" }, meta.projects.map(p => projectCard(p, meta, reload))),
    h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h2", null, "Läufe"),
        h("div", { class: "actions" },
          live ? h("button", { class: "btn btn-sm btn-ghost", onclick: reload }, icon("refresh"), "Aktualisieren") : null,
          state.user?.role === "admin" ? h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => {
            const r = await api("/api/sourcing/tick", { method: "POST" });
            toast(r.skipped ? "Ein Takt läuft gerade" : `Takt: ${num(r.collected)} gefunden · ${num(r.processed)} geprüft · ${num(r.imported)} in den Pool${r.limit_reached ? " · Tageslimit erreicht" : ""}`);
            reload();
          }) }, icon("zap"), "Jetzt einen Takt ausführen") : null)),
      runs.length ? runsTable(runs, reload) : h("div", { class: "card-body small muted" }, "Noch kein Lauf – oben bei einem Projekt „Suche starten“. Der Worker arbeitet dann alle 20 Sekunden ein Paket ab.")));
}

function projectCard(p, meta, reload) {
  const profile = meta.profiles.find(x => x.key === p.profile);
  const last = p.last_run;
  return h("section", { class: "card card-pad stack-sm", style: { borderTop: `3px solid ${p.color || "var(--line-2)"}` } },
    h("div", { class: "row-tight" }, h("h2", { class: "grow" }, p.name), h("span", { class: "badge" }, profile?.label || p.profile)),
    h("div", { class: "small muted" }, profile?.description || ""),
    h("div", { class: "small" }, p.pool ? [h("a", { href: `#/leads/liste-${p.pool.id}` }, p.pool.name), ` · ${num(p.pool.leads)} Leads im Pool`] : "Noch kein Pool – er entsteht mit dem ersten Lauf"),
    last ? h("div", { class: "small muted" }, `Letzter Lauf: ${RUN_STATUS[last.status]?.[0] || last.status} · ${num(last.imported)} in den Pool von ${num(last.checked)} geprüft · ${relTime(last.updated_at)}`) : null,
    p.campaign ? h("div", { class: "small" }, h("a", { href: `#/kampagnen/${p.campaign.id}` }, p.campaign.name), ` · ${p.campaign.status === "active" ? "läuft" : p.campaign.status === "paused" ? "pausiert" : "Entwurf"} · ${num(p.campaign.leads)} Leads, ${num(p.campaign.sent)} angeschrieben`,
      p.campaign.approved && p.campaign.cold_ack ? "" : h("span", { class: "badge warn", style: { marginLeft: "6px" } }, "Freigabe fehlt")) : null,
    h("div", { class: "row" }, h("button", { class: "btn btn-primary", onclick: () => openRun(p, meta, reload) }, icon("search"), "Suche starten"),
      h("button", { class: "btn", title: "Pool → Kampagne: Kampagne aus der Vorlage anlegen, die den Pool automatisch nachlädt. Freigeben und starten, dann gehen neue Pool-Leads von allein raus.", onclick: e => busy(e.currentTarget, async () => {
        const r = await api(`/api/sourcing/projects/${p.id}/campaign`, { method: "POST" });
        toast(r.created ? "Autopilot-Kampagne angelegt – jetzt freigeben und starten" : "Kampagne mit dem Pool verbunden");
        location.hash = `#/kampagnen/${r.campaign.id}`;
      }) }, icon("send"), p.campaign ? "Zur Kampagne" : "Pool → Kampagne")));
}

function openRun(p, meta, reload) {
  const profileSel = select(meta.profiles.map(x => [x.key, x.label]), p.profile);
  const regions = textarea({ rows: 6, value: (meta.default_regions || []).join("\n") });
  const max = input({ type: "number", min: 10, max: 5000, value: 300, style: { maxWidth: "120px" } });
  const chipsBox = h("div", { class: "chips" });
  let chosen = new Set();
  const drawChips = () => {
    const prof = meta.profiles.find(x => x.key === profileSel.value) || meta.profiles[0];
    chosen = new Set(prof.categories);
    clear(chipsBox, ...prof.categories.map(k => h("button", { type: "button", class: ["chip", "active"], onclick: e => { chosen.has(k) ? chosen.delete(k) : chosen.add(k); e.currentTarget.classList.toggle("active"); } },
      meta.categories.find(x => x.key === k)?.label || k)));
  };
  profileSel.onchange = drawChips;
  drawChips();
  const dlg = modal({
    title: `Suche für „${p.name}“`, wide: true,
    body: h("div", { class: "stack" },
      field("Profil (so werden die Firmen bewertet)", profileSel, meta.profiles.find(x => x.key === p.profile)?.description),
      field("Regionen (eine je Zeile)", regions, "Verwaltungsname wie bei OpenStreetMap: „Oberbergischer Kreis“, „Köln“, „Kreis Olpe“ – je Region eine Abfrage."),
      field("Kategorien", chipsBox),
      field("Höchstens so viele Firmen prüfen", max, "Jede Firma kostet etwa 5 Seitenabrufe. Das Tageslimit steht unter „Regionen & Limit“."),
      h("div", { class: "hint" }, "Automatisch aussortiert: Firmen, die schon in Coldmail sind, rechtliches Umfeld (Kanzleien, Kammern, Behörden …), Sperrliste, nur Freemail-Adressen (je nach Kontaktregeln).")),
    footer: [
      h("div", { class: "grow" }),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"),
      h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
        await api("/api/sourcing/runs", { method: "POST", body: { project_id: p.id, profile: profileSel.value, regions: regions.value, categories: [...chosen], max_candidates: Number(max.value) } });
        toast("Suche gestartet – läuft im Hintergrund"); dlg.close(); reload();
      }) }, "Suche starten")
    ]
  });
}

function runsTable(runs, reload) {
  const pct = r => (r.found ? Math.round(Math.min(100, (r.checked / r.found) * 100)) : 0);
  return h("div", { class: "table-wrap" }, h("table", { class: "table" },
    h("thead", null, h("tr", null, ["Projekt", "Profil", "Regionen", "Status", "Fortschritt", "Im Pool", "Aussortiert", "Vorhanden", "Fehler", ""].map(t => h("th", null, t)))),
    h("tbody", null, runs.map(r => h("tr", null,
      h("td", null, r.project_name || "–", h("div", { class: "small muted" }, relTime(r.created_at))),
      h("td", null, r.profile_label),
      h("td", { class: "small" }, r.regions.slice(0, 3).join(", ") + (r.regions.length > 3 ? ` +${r.regions.length - 3}` : "")),
      h("td", null, statusBadge(r.status), r.error ? h("div", { class: "small muted", title: r.error }, r.error.slice(0, 70)) : null),
      h("td", null, h("div", { class: "bar" }, h("span", { style: { width: `${pct(r)}%` } })), h("div", { class: "small muted" }, `${num(r.checked)} von ${num(r.found)} geprüft${r.pending ? ` · ${num(r.pending)} offen` : ""} · Abfragen ${num(r.region_index)}/${num(r.units_total)}`)),
      h("td", null, h("b", null, num(r.imported))), h("td", null, num(r.rejected)), h("td", null, num(r.duplicates)), h("td", null, num(r.errors)),
      h("td", null, h("div", { class: "row-tight" },
        h("button", { class: "btn btn-sm", onclick: () => openCandidates(r) }, "Details"),
        ["queued", "running"].includes(r.status) ? h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { await api(`/api/sourcing/runs/${r.id}/pause`, { method: "POST" }); reload(); }) }, "Pause") : null,
        ["paused", "done", "failed"].includes(r.status) ? h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => {
          const res = await api(`/api/sourcing/runs/${r.id}/resume`, { method: "POST" });
          toast(res.retried ? `${num(res.retried)} Websites werden erneut geprüft` : "Lauf läuft weiter"); reload();
        }) }, r.status === "done" ? "Fehler erneut" : "Weiter") : null,
        h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, async () => {
          if (!(await confirmDialog("Lauf löschen? Bereits angelegte Leads bleiben im Pool.", { danger: true, confirm: "Löschen" }))) return;
          await api(`/api/sourcing/runs/${r.id}`, { method: "DELETE" }); reload();
        }) }, "Löschen"),
        state.user?.role === "admin" ? h("button", { class: "btn btn-sm btn-ghost btn-danger", onclick: e => busy(e.currentTarget, async () => {
          if (!(await confirmDialog(`Lauf und die daraus angelegten ${num(r.imported)} Leads verwerfen? Bereits angeschriebene Leads bleiben.`, { danger: true, confirm: "Mit Leads löschen" }))) return;
          const res = await api(`/api/sourcing/runs/${r.id}?leads=1`, { method: "DELETE" }); toast(`${num(res.removed)} Leads entfernt`); reload();
        }) }, "Mit Leads löschen") : null)))))));
}

async function openCandidates(run) {
  const box = h("div", { class: "stack" });
  const st = { status: "", page: 1 };
  drawer(h("div", { class: "stack" }, h("h2", null, `${run.project_name || "Lauf"} · ${run.profile_label}`), h("div", { class: "small muted" }, run.regions.join(", ")), box));
  async function load() {
    clear(box, skeletonRows(4));
    const [detail, res] = await Promise.all([api(`/api/sourcing/runs/${run.id}`), api(`/api/sourcing/runs/${run.id}/candidates?page=${st.page}&limit=50${st.status ? `&status=${st.status}` : ""}`)]);
    const by = detail.stats.by_status || {};
    clear(box,
      h("div", { class: "chips" }, [["", "Alle"], ...Object.entries(CAND_STATUS)].map(([k, label]) => h("button", { type: "button", class: ["chip", st.status === k && "active"], onclick: () => { st.status = k; st.page = 1; load(); } },
        label, k ? h("span", { class: "count" }, ` ${num(by[k] || 0)}`) : null))),
      Object.keys(detail.stats.fits || {}).length ? h("div", { class: "small" }, "Qualität im Pool: ", Object.entries(detail.stats.fits).map(([f, n]) => `${f}: ${num(n)}`).join(" · ")) : null,
      detail.stats.reasons.length ? h("div", { class: "small muted" }, "Gründe: ", detail.stats.reasons.map(x => `${x.reason} (${x.n})`).join(" · ")) : null,
      h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, ["Firma", "Kategorie", "Website", "Adresse", "Ergebnis", "Fit", "Begründung"].map(t => h("th", null, t)))),
        h("tbody", null, res.items.map(c => h("tr", null,
          h("td", null, c.name, h("div", { class: "small muted" }, [c.plz, c.city].filter(Boolean).join(" "))),
          h("td", { class: "small" }, c.category),
          h("td", { class: "small" }, c.website ? h("a", { href: c.website, target: "_blank", rel: "noopener" }, c.website.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)) : "–"),
          h("td", { class: "small" }, c.email || "–"),
          h("td", null, CAND_STATUS[c.status] || c.status),
          h("td", null, c.fit || "–"),
          h("td", { class: "small" }, c.reason, c.data?.facts?.length ? h("div", { class: "small muted" }, `Belege: ${c.data.facts.slice(0, 2).join(" · ")}`) : null)))))),
      pager({ page: st.page, limit: 50, total: res.total, onPage: p => { st.page = p; load(); } }));
  }
  await load();
}

function openSettings(reload) {
  api("/api/settings").then(s => {
    const limit = input({ type: "number", min: 0, max: 20000, value: s.sourcing_daily_limit ?? 800, style: { maxWidth: "140px" } });
    const regions = textarea({ rows: 8, value: (s.sourcing_regions || []).join("\n") });
    const dlg = modal({
      title: "Leadquellen – Regionen & Limit",
      body: h("div", { class: "stack" },
        field("Website-Prüfungen pro Tag", limit, "Jede geprüfte Firma zählt einmal (etwa 5 Seitenabrufe). 0 = kein Limit."),
        field("Standard-Regionen (eine je Zeile)", regions, "Verwaltungsnamen wie bei OpenStreetMap: „Oberbergischer Kreis“, „Köln“, „Kreis Olpe“, „Rhein-Sieg-Kreis“ …")),
      footer: [
        h("div", { class: "grow" }),
        h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"),
        h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
          await api("/api/sourcing/settings", { method: "PUT", body: { sourcing_daily_limit: Number(limit.value), sourcing_regions: regions.value } });
          toast("Gespeichert"); dlg.close(); reload();
        }) }, "Speichern")
      ]
    });
  });
}

// ---------- Tages-Autopilot ----------
const CLEANUP_REASONS = { stale: "zu alt, nie angeschrieben", not_in_pool: "aus dem Pool geflogen", invalid: "Adresse ungültig", finished_unsent: "Kampagne beendet, nie gesendet" };
const reasonsText = by => Object.entries(by || {}).map(([k, n]) => `${num(n)} ${CLEANUP_REASONS[k] || k}`).join(" · ");

function autopilotCard(plan, reload) {
  const admin = state.user?.role === "admin";
  const cap = plan.capacity;
  const toggle = async enabled => { await api("/api/autopilot", { method: "PUT", body: { enabled } }); toast(enabled ? "Autopilot an – versendet ab jetzt nach Tagesplan" : "Autopilot aus – es gelten wieder die Kampagnenlimits"); reload(); };
  const stepText = p => (p.by_step || []).filter(s => s.sent || s.due).map(s => `S${s.step}: ${num(s.sent)}${s.due ? ` + ${num(s.due)} fällig` : ""}`).join(" · ") || "–";
  const poolText = p => {
    if (!p.pool_list_id) return "–";
    const days = p.pool_days === null || p.pool_days === undefined ? "" : ` (${String(p.pool_days).replace(".", ",")} Tage)`;
    return h("span", { class: p.pool_target && p.pool_stock < p.pool_target ? "warn" : "" }, `${num(p.pool_stock)}${days}`);
  };
  const last = plan.last_cleanup;
  const preview = reasonsText(plan.cleanup_preview);
  return h("section", { class: "card" },
    h("div", { class: "card-head" },
      h("h2", null, "Tages-Autopilot"),
      h("span", { class: ["badge", plan.enabled ? "ok" : ""] }, plan.enabled ? "An" : "Aus"),
      h("div", { class: "actions" },
        admin ? h("button", { class: ["btn", "btn-sm", !plan.enabled && "btn-primary"], onclick: e => busy(e.currentTarget, () => toggle(!plan.enabled)) }, icon(plan.enabled ? "pause" : "play"), plan.enabled ? "Ausschalten" : "Einschalten") : null,
        admin ? h("button", { class: "btn btn-sm", onclick: () => openAutopilotSettings(plan, reload) }, icon("settings"), "Anteile & Regeln") : null,
        admin ? h("button", { class: "btn btn-sm", title: "Für jedes Projekt, dessen Pool unter dem Puffer liegt, sofort einen Leadquellen-Lauf starten", onclick: e => busy(e.currentTarget, async () => {
          const r = await api("/api/autopilot/refill", { method: "POST" });
          toast(r.started.length ? `Nachfüllen gestartet: ${r.started.map(x => `${x.project} (bis ${num(x.max_candidates)} Firmen)`).join(", ")}` : "Alle Pools sind voll genug (oder es läuft schon ein Lauf)"); reload();
        }) }, icon("search"), "Pools jetzt nachfüllen") : null,
        admin ? h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, async () => {
          const dry = await api("/api/autopilot/cleanup?dry=1", { method: "POST" });
          if (!dry.leads) { toast("Nichts aufzuräumen"); return; }
          if (!(await confirmDialog(`${num(dry.leads)} nie angeschriebene Leads aus den Leadquellen löschen? (${reasonsText(dry.by)}) Angeschriebene, abgemeldete und importierte Leads bleiben.`, { danger: true, confirm: "Löschen" }))) return;
          const r = await api("/api/autopilot/cleanup", { method: "POST" });
          toast(`${num(r.leads)} Leads und ${num(r.accounts)} leere Firmen gelöscht`); reload();
        }) }, icon("trash"), "Aufräumen") : null)),
    h("div", { class: "card-body stack-sm" },
      h("div", { class: "small" },
        "Jeden Tag: Kapazität aller Postfächer der Autopilot-Kampagnen → zuerst die fälligen Folge-Mails (Stufe 2, 3, 4 …) → der Rest als Erst-Mails nach Anteil auf die Projekte; fehlen einem Projekt Leads, bekommen die anderen seinen Platz. Fällt ein Pool unter ",
        h("b", null, `${num(plan.settings.buffer_days)} Versandtage`), " Vorrat, startet automatisch ein Leadquellen-Lauf. Einmal am Tag werden nie angeschriebene Pool-Leads gelöscht, die älter als ",
        h("b", null, `${num(plan.settings.max_age_days)} Tage`), " sind oder nicht mehr gebraucht werden."),
      h("div", { class: "row" },
        h("b", null, `Kapazität heute: ${num(cap.available)} Mails`), h("span", { class: "small muted" }, `(${num(cap.mailboxes)} Postfächer, ${num(cap.total)} Tageslimit${cap.used_other ? `, ${num(cap.used_other)} schon für andere Kampagnen/Nachfassen` : ""})`),
        h("span", null, `· eingeplant ${num(plan.planned)}`),
        plan.unused ? h("span", { class: "badge warn" }, `${num(plan.unused)} ungenutzt – es fehlen Leads oder freigegebene Kampagnen`) : cap.available ? h("span", { class: "badge ok" }, "voll ausgenutzt") : null),
      h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, ["Projekt", "Anteil", "Heute geplant", "Folge / Neu", "Je Stufe (gesendet + fällig)", "Heute gesendet", "Pool-Vorrat", "Status"].map(t => h("th", null, t)))),
        h("tbody", null, plan.projects.map(p => h("tr", null,
          h("td", null, p.campaign_id ? h("a", { href: `#/kampagnen/${p.campaign_id}` }, projectDot(p.color, p.project)) : projectDot(p.color, p.project)),
          h("td", null, num(p.weight)),
          h("td", null, h("b", null, p.ready ? num(p.quota) : "–")),
          h("td", { class: "small" }, p.ready ? `${num(p.quota_follow)} / ${num(p.quota_new)}` : "–"),
          h("td", { class: "small" }, p.ready ? stepText(p) : "–"),
          h("td", null, p.ready ? num(p.sent_today) : "–"),
          h("td", null, poolText(p), p.ready && p.pool_target ? h("div", { class: "small muted" }, `Ziel ${num(p.pool_target)}`) : null),
          h("td", { class: "small" }, p.ready ? h("span", { class: "badge ok" }, "läuft") : h("span", { class: "badge warn" }, p.problem || "nicht bereit"))))))),
      h("div", { class: "small muted" },
        `Leadquellen heute: ${num(plan.sourcing.used)} von ${num(plan.sourcing.limit || 0) || "∞"} Websites geprüft`,
        plan.state?.lastRefill?.length ? ` · zuletzt automatisch nachgefüllt: ${plan.state.lastRefill.map(x => x.project).join(", ")}` : "",
        last ? ` · Aufgeräumt ${relTime(last.at)}: ${num(last.leads)} Leads` : "",
        preview ? ` · Beim nächsten Aufräumen: ${preview}` : "",
        plan.state?.lastError ? h("span", { class: "danger" }, ` · Fehler: ${plan.state.lastError}`) : null)));
}

function openAutopilotSettings(plan, reload) {
  const shares = new Map(plan.projects.map(p => [p.project_id, input({ type: "number", min: 0, max: 100, value: p.weight, style: { maxWidth: "90px" } })]));
  const buffer = input({ type: "number", min: 1, max: 60, value: plan.settings.buffer_days, style: { maxWidth: "90px" } });
  const age = input({ type: "number", min: 7, max: 730, value: plan.settings.max_age_days, style: { maxWidth: "90px" } });
  const refill = checkbox("Pools automatisch nachfüllen", plan.settings.refill, "Startet einen Leadquellen-Lauf, sobald der Vorrat eines Projekts unter den Puffer fällt (Regionen aus „Regionen & Limit“, jeder Lauf beginnt in einer anderen Region).");
  const clean = checkbox("Alte, nie angeschriebene Pool-Leads täglich löschen", plan.settings.cleanup, "Nur Leads aus den Leadquellen, die nie eine Mail bekommen haben. Angeschriebene bleiben (Sperrfristen, Abmeldungen).");
  const dlg = modal({
    title: "Tages-Autopilot: Anteile & Regeln",
    body: h("div", { class: "stack" },
      h("div", { class: "hint" }, "Anteil = Gewicht beim Verteilen der Erst-Mails (1 = gleich viel, 2 = doppelt so viel, 0 = keine neuen Leads). Folge-Mails gehen immer zuerst raus."),
      h("div", { class: "grid-2" }, plan.projects.map(p => field(p.project, shares.get(p.project_id), p.ready ? null : p.problem))),
      field("Pool-Puffer (Versandtage)", buffer, "So viele Tage Erst-Mails soll jeder Pool vorrätig haben."),
      field("Höchstalter nie angeschriebener Pool-Leads (Tage)", age),
      refill, clean),
    footer: [
      h("div", { class: "grow" }),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"),
      h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
        await api("/api/autopilot", { method: "PUT", body: {
          shares: Object.fromEntries([...shares].map(([id, el]) => [id, Number(el.value) || 0])),
          buffer_days: Number(buffer.value), max_age_days: Number(age.value), refill: refill.input.checked, cleanup: clean.input.checked
        } });
        toast("Gespeichert"); dlg.close(); reload();
      }) }, "Speichern")
    ]
  });
}
