// Firmenprofil (Account Brain): nächster Schritt, Why now, belegte Fakten, Anlässe, Hypothesen, Personen,
// Gedächtnis, Scores, Chancen und Verlauf – alles, was wir über die Firma wissen, an einer Stelle.
import { h, clear, api, icon, busy, toast, modal, field, input, textarea, select, checkbox, num, relTime, dateTime, euro, skeletonRows, emptyState, lifecycleBadge, scoreBar, projectSelect, state, aiMissingText, waitForJob, confirmDialog, badge, noteTagToast } from "../lib.js";

let meta = null;

export async function render(el, [id]) {
  meta = meta || await api("/api/revenue/meta");
  clear(el, h("div", { class: "content" }, skeletonRows(6)));
  const [b, products, plays] = await Promise.all([api(`/api/accounts/${id}`), api("/api/products").catch(() => []), api("/api/plays").catch(() => [])]);
  draw(el, b, { products, plays });
}

function draw(el, b, ctx) {
  const a = b.account;
  const set = next => draw(el, next, ctx);
  const call = (method, path, body) => api(`/api/accounts/${a.id}${path}`, { method, body }).then(r => { set(r); return r; });
  const aiOn = state.meta?.ai_available;

  const research = e => busy(e.currentTarget, async () => {
    const job = await api(`/api/accounts/${a.id}/research`, { method: "POST" });
    toast("Recherche läuft – liest die Website (dauert meist unter einer Minute)");
    const j = await waitForJob(job.id);
    if (j.failed) toast(`Recherche fehlgeschlagen: ${j.error || "unbekannt"}`, "error"); else toast("Recherche fertig");
    set(await api(`/api/accounts/${a.id}`));
  });

  clear(el,
    h("div", { class: "page-head" },
      h("div", { style: { minWidth: 0 } },
        h("div", { class: "crumb" }, h("a", { href: "#/firmen" }, "Firmen"), " / "),
        h("div", { class: "row-tight" }, h("h1", null, a.name || a.domain), lifecycleBadge(a.lifecycle, a.lifecycle_label)),
        h("div", { class: "small muted" }, [a.domain ? h("a", { href: a.website || `https://${a.domain}`, target: "_blank", rel: "noopener noreferrer" }, a.domain) : null, a.city, a.industry, a.employees ? `${a.employees} MA` : null].filter(Boolean).flatMap((x, i) => (i ? [" · ", x] : [x])))),
      h("div", { class: "actions" },
        h("button", { class: "btn", disabled: !aiOn, title: aiOn ? "Website lesen, Fakten/Anlässe/Personen aktualisieren" : aiMissingText, onclick: research }, icon("sparkles"), a.researched_at ? "Neu recherchieren" : "Recherchieren"),
        h("button", { class: "btn", onclick: () => statusDialog(a, call) }, "Status ändern"),
        h("button", { class: "btn", onclick: () => taskDialog(a, b.people, call) }, icon("list"), "Aufgabe"),
        h("button", { class: "btn btn-primary", onclick: () => oppDialog(a, b.people, call) }, icon("plus"), "Chance"))),
    h("div", { class: "content" }, h("div", { class: "split" },
      h("div", { class: "stack" },
        nextAction(b, a, call, research),
        a.research_error ? h("div", { class: "alert warn" }, `Letzte Recherche: ${a.research_error}`) : null,
        whyNowCard(b, a),
        factsCard(b, call),
        signalsCard(b, call),
        hypothesesCard(b, call),
        memoryCard(b, call)),
      h("div", { class: "stack" },
        scoresCard(b, a),
        masterCard(a, ctx, call),
        peopleCard(b, a, call),
        oppsCard(b),
        timelineCard(b)))));
}

// ---------- Linke Spalte ----------

function nextAction(b, a, call, research) {
  const n = b.next_action;
  if (!n || n.type === "none") return null;
  const btns = [];
  if (n.type === "reply") btns.push(h("a", { class: "btn btn-sm btn-primary", href: `#/unibox/${n.conversation_id}` }, icon("reply"), "Antworten"));
  if (n.type === "prep" || n.type === "proposal") btns.push(h("a", { class: "btn btn-sm btn-primary", href: `#/pipeline/${n.opportunity_id}` }, "Öffnen"));
  if (n.type === "task") btns.push(h("a", { class: "btn btn-sm btn-primary", href: "#/aufgaben" }, "Zur Aufgabe"));
  if (n.type === "research") btns.push(h("button", { class: "btn btn-sm btn-primary", disabled: !state.meta?.ai_available, onclick: research }, icon("sparkles"), "Recherchieren"));
  if (n.type === "email") btns.push(h("a", { class: "btn btn-sm btn-primary", href: "#/kampagnen" }, icon("send"), "Zur Kampagne"));
  if (n.type === "find_contact") btns.push(h("button", { class: "btn btn-sm btn-primary", onclick: () => personDialog(a, null, call) }, icon("plus"), "Person eintragen"));
  return h("div", { class: "nba" },
    h("div", { class: "small muted" }, "Nächster sinnvoller Schritt"),
    h("div", { class: "t" }, n.label),
    n.reason ? h("div", { class: "small" }, n.reason) : null,
    n.goal ? h("div", { class: "small muted" }, `Ziel: ${n.goal}`) : null,
    b.saturation.level !== "none" ? h("div", { class: "small muted" }, `Kontakt-Sättigung: ${b.saturation.touches} Kontakte / ${b.saturation.people} Personen in 14 Tagen${b.saturation.recommendation ? ` – ${b.saturation.recommendation}` : ""}`) : null,
    btns.length ? h("div", { class: "row-tight", style: { marginTop: "8px" } }, btns) : null);
}

function whyNowCard(b, a) {
  const s = a.strategy || {};
  const play = a.suggested_play || {};
  const rows = [
    ["Einstieg", s.primary_entry], ["Alternativ", s.secondary], ["Fürsprecher", s.champion], ["Entscheider", s.economic_buyer], ["Technik/IT", s.technical], ["Nicht kontaktieren", s.do_not_contact]
  ].filter(([, v]) => v);
  const playRows = [["Persona", play.persona], ["Anlass", play.trigger], ["Pain", play.pain], ["Angle", play.angle], ["Beleg", play.proof], ["Kanal", play.channel], ["CTA", play.cta]].filter(([, v]) => v);
  if (!a.why_now && !a.summary && !rows.length && !playRows.length) return null;
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Why now & Strategie"), a.why_now_confidence ? h("span", { class: "muted small" }, `Konfidenz ${a.why_now_confidence} %`) : null),
    h("div", { class: "card-body stack-sm" },
      a.why_now ? h("p", { class: "strong", style: { margin: 0 } }, a.why_now) : null,
      a.summary ? h("p", { class: "small muted", style: { margin: 0 } }, a.summary) : null,
      rows.length ? h("dl", { class: "kv" }, rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)])) : null,
      playRows.length ? h("div", null, h("div", { class: "small muted", style: { margin: "6px 0 4px" } }, b.play ? `Play: ${b.play.name}` : "Vorgeschlagener Play"), h("dl", { class: "kv" }, playRows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]))) : null,
      h("div", { class: "hint" }, "Why now und Strategie sind Interpretation – in Mails nur Fakten als Tatsache nennen, Vermutungen als Frage.")));
}

function factsCard(b, call) {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Fakten"), h("span", { class: "muted small" }, "nur mit Quelle verifiziert"),
    h("div", { class: "actions" }, h("button", { class: "btn btn-sm", onclick: () => factDialog(call) }, icon("plus"), "Fakt"))),
    h("div", { class: "card-body" }, b.facts.length ? h("div", { class: "evidence" }, b.facts.map(f => h("div", { class: "ev" },
      h("div", { style: { minWidth: 0 } },
        h("div", null, f.statement),
        f.quote ? h("div", { class: "quote" }, `„${f.quote}“`) : null,
        h("div", { class: "src" }, h("span", { class: ["badge", f.type === "verified" ? "ok" : "warn"] }, f.type === "verified" ? "verifiziert" : "Schätzung"), ` ${f.confidence} % · `,
          f.source_url ? h("a", { href: f.source_url, target: "_blank", rel: "noopener noreferrer" }, new URL(f.source_url).pathname === "/" ? new URL(f.source_url).host : new URL(f.source_url).pathname) : f.source_type === "user" ? "von euch eingetragen" : f.source_type)),
      h("button", { class: "btn btn-ghost btn-icon btn-sm", title: "Als veraltet markieren", "aria-label": "Entfernen", onclick: e => busy(e.currentTarget, () => call("DELETE", `/facts/${f.id}`)) }, icon("x")))))
      : h("div", { class: "small muted" }, "Noch keine Fakten – „Recherchieren“ liest die Website.")));
}

function signalsCard(b, call) {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Anlässe (Why now)"),
    h("div", { class: "actions" }, h("button", { class: "btn btn-sm", onclick: () => signalDialog(call) }, icon("plus"), "Anlass"))),
    h("div", { class: "card-body" }, b.signals.length ? h("div", { class: "evidence" }, b.signals.map(s => h("div", { class: "ev" },
      h("div", { style: { minWidth: 0 } },
        h("div", { class: "strong" }, s.title, " ", h("span", { class: "badge plain" }, meta.signal_types[s.type] || s.type)),
        s.detail ? h("div", { class: "small" }, s.detail) : null,
        s.quote ? h("div", { class: "quote" }, `„${s.quote}“`) : null,
        h("div", { class: "src" }, `Stärke ${s.strength} · seit ${relTime(s.first_seen_at)}`, s.source_url ? [" · ", h("a", { href: s.source_url, target: "_blank", rel: "noopener noreferrer" }, "Quelle")] : null)),
      h("button", { class: "btn btn-ghost btn-sm", title: "Anlass stimmt nicht / ist vorbei", onclick: e => busy(e.currentTarget, () => call("PUT", `/signals/${s.id}`, { status: "wrong" })) }, "stimmt nicht"))))
      : h("div", { class: "small muted" }, "Kein aktueller Anlass bekannt. Ohne Anlass bleibt die Firma unter Beobachtung und wird regelmäßig neu geprüft.")));
}

function hypothesesCard(b, call) {
  const tone = { confirmed: "ok", rejected: "danger", open: "info" };
  const label = { confirmed: "bestätigt", rejected: "widerlegt", open: "Vermutung" };
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Hypothesen"), h("span", { class: "muted small" }, "im Gespräch prüfen"),
    h("div", { class: "actions" }, h("button", { class: "btn btn-sm", onclick: () => hypothesisDialog(call) }, icon("plus"), "Hypothese"))),
    h("div", { class: "card-body" }, b.hypotheses.length ? h("div", { class: "evidence" }, b.hypotheses.map(x => h("div", { class: "ev" },
      h("div", { style: { minWidth: 0 } },
        h("div", { style: x.status === "rejected" ? { textDecoration: "line-through", color: "var(--text-3)" } : null }, x.statement),
        x.interpretation ? h("div", { class: "small muted" }, x.interpretation) : null,
        h("div", { class: "src" }, h("span", { class: ["badge", tone[x.status]] }, label[x.status]), ` ${meta.hypothesis_kinds[x.kind] || x.kind} · ${x.confidence} %`,
          (x.evidence.facts || []).length || (x.evidence.signals || []).length ? ` · ${(x.evidence.facts || []).length} Fakten, ${(x.evidence.signals || []).length} Anlässe als Beleg` : " · ohne direkten Beleg",
          x.resolved_note ? ` · ${x.resolved_note}` : "")),
      x.status === "open" ? h("div", { class: "row-tight" },
        h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, () => call("PUT", `/hypotheses/${x.id}`, { status: "confirmed" })) }, icon("check"), "stimmt"),
        h("button", { class: "btn btn-sm btn-ghost", onclick: () => rejectDialog(x, call) }, "widerlegt"))
        : h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, () => call("PUT", `/hypotheses/${x.id}`, { status: "open" })) }, "zurücksetzen"))))
      : h("div", { class: "small muted" }, "Noch keine Hypothesen.")));
}

function memoryCard(b, call) {
  const kind = select(Object.entries(meta.memory_kinds), "note");
  const text = input({ placeholder: "z. B. „nutzt seit 2023 ein ERP von XY“ – #nomail / #blacklist sperren", title: "#nomail: keine Mails mehr (Anruf bleibt möglich) · #blacklist: ganze Firma nie wieder kontaktieren" });
  const tone = { do_not_claim: "danger", rejected_assumption: "danger", objection: "warn", promise: "ok", next_step: "info" };
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Gedächtnis"), h("span", { class: "muted small" }, "fließt in jeden KI-Text")),
    h("div", { class: "card-body stack-sm" },
      h("div", { class: "row-tight" }, kind, text, h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { if (!text.value.trim()) throw new Error("Text fehlt"); noteTagToast(await call("POST", "/memory", { kind: kind.value, text: text.value })); }) }, "Merken")),
      b.memory.length ? h("div", null, b.memory.map(m => h("div", { class: "memo" },
        h("span", { class: ["badge", tone[m.kind] || ""] }, meta.memory_kinds[m.kind] || m.kind),
        h("div", { class: "grow" }, m.text, h("div", { class: "small muted" }, `${relTime(m.created_at)}${m.user_name ? ` · ${m.user_name}` : m.source && m.source !== "user" ? ` · ${m.source}` : ""}`)),
        h("button", { class: "btn btn-ghost btn-icon btn-sm", "aria-label": "Löschen", onclick: e => busy(e.currentTarget, () => call("DELETE", `/memory/${m.id}`)) }, icon("x")))))
        : h("div", { class: "small muted" }, "Einwände, Zeitpunkte, Systeme, Zusagen und „nicht behaupten“ landen hier – auch automatisch aus Gesprächen und Antworten.")));
}

// ---------- Rechte Spalte ----------

function scoresCard(b, a) {
  const r = a.score_reasons || {};
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Einschätzung"), a.researched_at ? h("span", { class: "muted small" }, `recherchiert ${relTime(a.researched_at)}`) : null),
    h("div", { class: "card-body stack-sm" },
      h("div", { class: "row" }, h("div", { class: "score-big" }, b.scores.opportunity ?? "–"), h("div", { class: "small muted" }, "Opportunity-Score", h("br"), "35 % Fit · 25 % Pain · 25 % Timing · 15 % Erreichbarkeit")),
      scoreBar("Fit", b.scores.fit, r.fit), scoreBar("Pain", b.scores.pain, r.pain), scoreBar("Timing", b.scores.timing, r.timing), scoreBar("Erreichbarkeit", b.scores.contactability, r.contactability),
      Object.values(r).some(Boolean) ? h("details", null, h("summary", { class: "small" }, "Begründungen"),
        h("dl", { class: "kv small", style: { marginTop: "6px" } }, [["Fit", r.fit], ["Pain", r.pain], ["Timing", r.timing], ["Erreichbarkeit", r.contactability]].filter(([, v]) => v).flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]))) : null,
      a.next_check_at ? h("div", { class: "small muted" }, `Nächste automatische Prüfung: ${dateTime(a.next_check_at)}`) : null));
}

function masterCard(a, ctx, call) {
  const f = {
    name: input({ value: a.name || "" }), project_id: projectSelect(a.project_id),
    product_id: select([["", "– kein Produkt –"], ...ctx.products.map(p => [p.id, p.name])], a.product_id ?? ""),
    play_id: select([["", "– kein Play –"], ...ctx.plays.map(p => [p.id, p.name])], a.play_id ?? ""),
    industry: input({ value: a.industry || "" }), city: input({ value: a.city || "" }), employees: input({ value: a.employees || "" }), website: input({ type: "url", value: a.website || "" })
  };
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Stammdaten")),
    h("div", { class: "card-body stack-sm" },
      field("Name", f.name), field("Projekt", f.project_id), field("Produkt", f.product_id), field("Play", f.play_id),
      h("div", { class: "grid-2" }, field("Branche", f.industry), field("Ort", f.city)),
      h("div", { class: "grid-2" }, field("Mitarbeitende", f.employees), field("Website", f.website)),
      h("div", { class: "row" }, h("div", { class: "grow" }), h("button", { class: "btn btn-sm btn-primary", onclick: e => busy(e.currentTarget, async () => {
        await call("PUT", "", { name: f.name.value, project_id: f.project_id.value || null, product_id: f.product_id.value || null, play_id: f.play_id.value || null, industry: f.industry.value, city: f.city.value, employees: f.employees.value, website: f.website.value });
        toast("Gespeichert");
      }) }, "Speichern"))));
}

function peopleCard(b, a, call) {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Personen"), h("span", { class: "muted small" }, "Buying Committee"),
    h("div", { class: "actions" }, h("button", { class: "btn btn-sm", onclick: () => personDialog(a, null, call) }, icon("plus"), "Person"))),
    h("div", { class: "card-body" }, b.people.length ? h("div", { class: "evidence" }, b.people.map(p => h("div", { class: "ev" },
      h("div", { style: { minWidth: 0 } },
        h("div", { class: "strong" }, p.name || p.role || "Unbekannt", p.do_not_contact ? h("span", { class: "badge danger", style: { marginLeft: "6px" } }, "nicht kontaktieren") : null),
        h("div", { class: "small muted" }, [p.role, meta.committee_roles[p.committee_role]].filter(Boolean).join(" · ")),
        h("div", { class: "small row-tight" },
          p.phone ? h("span", { title: "Telefonnummer – für die Übergabe an die Sales App" }, icon("phone", "icon icon-xs"), p.phone) : null,
          p.lead_email || p.email ? h("span", { class: "muted" }, p.lead_email || p.email) : null,
          p.lead_id ? badge("consent", p.consent_status || "none") : null,
          p.source_url ? h("a", { href: p.source_url, target: "_blank", rel: "noopener noreferrer", class: "muted" }, "Quelle") : null)),
      h("div", { class: "row-tight" },
        h("button", { class: "btn btn-sm btn-ghost", "aria-label": "Bearbeiten", onclick: () => personDialog(a, p, call) }, icon("edit"))))))
      : h("div", { class: "small muted" }, "Noch keine Personen. Aus importierten Leads und dem Impressum werden sie automatisch übernommen.")));
}

function oppsCard(b) {
  if (!b.opportunities.length) return null;
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Chancen")),
    h("div", { class: "card-body" }, h("div", { class: "mini-list" }, b.opportunities.map(o => h("a", { href: `#/pipeline/${o.id}` }, h("span", { class: "name" }, o.title), h("span", { class: "meta" }, meta.stages[o.stage], o.value_eur ? ` · ${euro(o.value_eur)}` : ""))))));
}

function timelineCard(b) {
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Verlauf")),
    h("div", { class: "card-body" }, b.timeline.length ? h("div", { class: "timeline" }, b.timeline.map(t => h("div", { class: "ti" }, h("span", { class: "when" }, dateTime(t.at)), h("span", null, t.text))))
      : h("div", { class: "small muted" }, "Noch kein Kontakt.")));
}

// ---------- Dialoge ----------

function simpleDialog(title, fields, onSave, saveLabel = "Speichern") {
  const dlg = modal({
    title, body: h("div", { class: "stack" }, fields),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => { await onSave(); dlg.close(); }) }, saveLabel)]
  });
  return dlg;
}

function factDialog(call) {
  const statement = input({ placeholder: "z. B. „Betreibt zwei Standorte (Gummersbach, Köln)“" });
  const source = input({ type: "url", placeholder: "https://… (optional – mit Quelle gilt der Fakt als verifiziert)" });
  const quote = input({ placeholder: "Wörtliches Zitat aus der Quelle (optional)" });
  simpleDialog("Fakt eintragen", [field("Aussage", statement), field("Quelle", source), field("Zitat", quote)], () => call("POST", "/facts", { statement: statement.value, source_url: source.value, quote: quote.value }));
}

function signalDialog(call) {
  const title = input({ placeholder: "z. B. „Sucht 3 Servicetechniker“ oder „Neue Halle in Wiehl“" });
  const type = select(Object.entries(meta.signal_types), "hiring");
  const detail = textarea({ rows: 2 });
  const source = input({ type: "url", placeholder: "https://… (optional)" });
  const strength = input({ type: "number", min: 0, max: 100, value: 70 });
  simpleDialog("Anlass eintragen", [field("Anlass", title), h("div", { class: "grid-2" }, field("Art", type), field("Stärke (0–100)", strength)), field("Details", detail), field("Quelle", source),
    h("div", { class: "hint" }, "Passt die Firma, springt sie auf „Anlass erkannt“ und erscheint in „Heute“ – zum Aufnehmen in eine Kampagne.")],
  () => call("POST", "/signals", { title: title.value, type: type.value, detail: detail.value, source_url: source.value, strength: Number(strength.value) }));
}

function hypothesisDialog(call) {
  const statement = textarea({ rows: 2, placeholder: "z. B. „Einsatzplanung läuft vermutlich über Excel“" });
  const kind = select(Object.entries(meta.hypothesis_kinds), "pain");
  const confidence = input({ type: "number", min: 0, max: 100, value: 50 });
  simpleDialog("Hypothese", [field("Vermutung", statement), h("div", { class: "grid-2" }, field("Art", kind), field("Konfidenz (%)", confidence))],
    () => call("POST", "/hypotheses", { statement: statement.value, kind: kind.value, confidence: Number(confidence.value) }));
}

function rejectDialog(x, call) {
  const note = input({ placeholder: "z. B. „Sie nutzen bereits Software XY“" });
  simpleDialog("Hypothese widerlegt", [h("p", null, x.statement), field("Was stimmt stattdessen? (optional)", note), h("div", { class: "hint" }, "Widerlegte Annahmen verwendet die KI für diese Firma nie wieder.")],
    () => call("PUT", `/hypotheses/${x.id}`, { status: "rejected", note: note.value }), "Widerlegt");
}

function personDialog(a, p, call) {
  const f = {
    name: input({ value: p?.name || "" }), role: input({ value: p?.role || "", placeholder: "z. B. Geschäftsführer, Leitung Service" }),
    committee_role: select([["", "– Rolle im Kaufprozess –"], ...Object.entries(meta.committee_roles)], p?.committee_role || ""),
    decision_power: select([["", "–"], ["high", "hoch"], ["medium", "mittel"], ["low", "gering"]], p?.decision_power || ""),
    phone: input({ value: p?.phone || "", type: "tel" }), email: input({ value: p?.email || "", type: "email", disabled: !!p?.lead_id }),
    notes: textarea({ value: p?.notes || "", rows: 2 }), dnc: checkbox("Nicht kontaktieren", !!p?.do_not_contact)
  };
  const dlg = simpleDialog(p ? "Person bearbeiten" : "Person hinzufügen", [
    h("div", { class: "grid-2" }, field("Name", f.name), field("Funktion", f.role)),
    h("div", { class: "grid-2" }, field("Rolle im Kaufprozess", f.committee_role), field("Entscheidungsmacht", f.decision_power)),
    h("div", { class: "grid-2" }, field("Telefon (geschäftlich)", f.phone), field("E-Mail", f.email, p?.lead_id ? "Kommt aus dem Lead" : "E-Mails nur mit Einwilligung – sonst anrufen")),
    field("Notizen", f.notes), f.dnc,
    h("div", { class: "hint" }, "Nur berufliche Angaben speichern (Art. 6 Abs. 1 f DSGVO). Keine privaten Informationen.")
  ], () => call(p ? "PUT" : "POST", p ? `/people/${p.id}` : "/people", {
    name: f.name.value, role: f.role.value, committee_role: f.committee_role.value, decision_power: f.decision_power.value, phone: f.phone.value,
    ...(p?.lead_id ? {} : { email: f.email.value }), notes: f.notes.value, do_not_contact: f.dnc.input.checked
  }));
  if (p) dlg.foot.prepend(h("button", { class: "btn btn-ghost btn-danger", onclick: e => busy(e.currentTarget, async () => {
    if (!(await confirmDialog(`${p.name || "Person"} aus der Firma entfernen?`, { danger: true, confirm: "Entfernen" }))) return;
    await call("DELETE", `/people/${p.id}`); dlg.close();
  }) }, "Entfernen"), h("div", { class: "grow" }));
}

function statusDialog(a, call) {
  const state_ = select(Object.entries(meta.lifecycle), a.lifecycle);
  const reason = input({ placeholder: "Grund (optional, landet im Gedächtnis)" });
  const days = input({ type: "number", min: 1, max: 730, value: 90 });
  const daysField = field("Wieder vorlegen nach (Tagen)", days);
  const toggle = () => { daysField.hidden = state_.value !== "not_now"; };
  state_.addEventListener("change", toggle);
  toggle();
  simpleDialog("Status ändern", [field("Status", state_), daysField, field("Grund", reason),
    h("div", { class: "hint" }, "„Gesperrt“ stoppt alle Sequenzen und Aufgaben der Firma und markiert alle Personen als „nicht kontaktieren“.")],
  () => call("POST", "/lifecycle", { state: state_.value, reason: reason.value, days: Number(days.value) }));
}

function taskDialog(a, people, call) {
  const type = select([["todo", "Aufgabe"]], "todo");
  const person = select([["", "– Firma allgemein –"], ...people.filter(p => !p.do_not_contact).map(p => [p.id, `${p.name || p.role}${p.phone ? ` (${p.phone})` : ""}`])], "");
  const title = input({ placeholder: "optional" });
  const due = input({ type: "datetime-local" });
  const notes = textarea({ rows: 3 });
  simpleDialog("Aufgabe", [h("div", { class: "grid-2" }, field("Art", type), field("Person", person)), field("Titel", title), field("Fällig", due, "leer = sofort"), field("Notizen", notes)],
    () => call("POST", "/tasks", { type: type.value, person_id: person.value || undefined, title: title.value || undefined, due_at: due.value ? new Date(due.value).getTime() : undefined, notes: notes.value }).then(() => toast("Angelegt")));
}

function oppDialog(a, people, call) {
  const title = input({ value: `${a.name || a.domain} – Erstgespräch` });
  const stage = select([["meeting", "Termin"], ["qualified", "Qualifiziert"], ["proposal", "Angebot"]], "meeting");
  const person = select([["", "– Ansprechpartner –"], ...people.map(p => [p.id, p.name || p.role])], "");
  const when = input({ type: "datetime-local" });
  const value = input({ type: "number", min: 0, placeholder: "€ (optional)" });
  simpleDialog("Chance anlegen", [field("Titel", title), h("div", { class: "grid-2" }, field("Phase", stage), field("Ansprechpartner", person)), h("div", { class: "grid-2" }, field("Termin", when), field("Wert (€)", value)),
    h("div", { class: "hint" }, "Herkunft (erster Kontakt, Anlass, Pain, Play) wird automatisch festgehalten – Grundlage für „Lernen“.")],
  async () => {
    const r = await api(`/api/accounts/${a.id}/opportunities`, { method: "POST", body: { title: title.value, stage: stage.value, person_id: person.value || undefined, meeting_at: when.value ? new Date(when.value).getTime() : undefined, value_eur: value.value ? Number(value.value) : undefined } });
    location.hash = `#/pipeline/${r.opportunity_id}`;
  }, "Anlegen");
}
