// Aufgaben: Antworten schreiben, Nachfass-Entwürfe prüfen und senden. Telefoniert wird in der Sales App (nur Cold Mailing hier).
import { h, clear, api, modal, field, input, textarea, busy, toast, confirmDialog, icon, relTime, dateTime, state, skeletonRows, badge, labelBadge, emptyState, aiMissingText, noteTagToast } from "../lib.js";

const FILTERS = [["due", "Fällig"], ["open", "Alle offenen"], ["drafts", "Entwürfe prüfen"], ["done", "Erledigt"]];
const CALL_TYPES = ["call", "call_sequence"];
const OTHER_OUTCOMES = { sent: "Gesendet", replied: "Lead hat geantwortet", unsubscribe: "Abgemeldet", not_interested: "Kein Interesse", meeting: "Termin vereinbart", do_not_contact: "Kein Kontakt mehr gewünscht" };
const outcomeLabel = (res, key) => res.outcomes[key] || OTHER_OUTCOMES[key] || key;

export async function render(el, [filter]) {
  const current = FILTERS.some(([k]) => k === filter) ? filter : "due";
  clear(el, header(current), h("div", { class: "content" }, skeletonRows(4)));
  const qs = new URLSearchParams();
  if (current === "done") qs.set("status", "done");
  else qs.set("status", "open");
  if (current === "due") qs.set("due", "due");
  if (current === "calls") qs.set("type", "calls");
  if (current === "drafts") qs.set("type", "nurture_draft");
  const res = await api(`/api/tasks?${qs}`);
  const reload = () => { window.dispatchEvent(new Event("tasks:changed")); render(el, [current]); };
  clear(el, header(current, res.counts),
    h("div", { class: "content stack" },
      current === "due" ? h("div", { class: "alert info" }, "Hier nur Cold Mailing: antworten, Nachfass-Entwürfe prüfen. Telefoniert wird in eurer Sales App – warme Leads mit „Leads → Export (Filter Warm)“ übergeben.") : null,
      res.items.length ? h("div", { class: "stack-sm" }, res.items.map(t => taskCard(t, res, reload)))
        : h("div", { class: "card" }, emptyState(current === "due" ? "Nichts fällig" : "Keine Aufgaben", current === "due" ? "Neue Aufgaben entstehen automatisch, wenn jemand antwortet oder ein Nachfass-Entwurf zur Prüfung bereitsteht." : null))));
}

function header(current, counts) {
  return h("div", { class: "page-head" },
    h("div", null, h("h1", null, "Aufgaben"), counts ? h("div", { class: "sub muted small" }, `${counts.open} offen · ${counts.due} fällig`) : null),
    h("div", { class: "tabs", style: { marginBottom: 0 } }, FILTERS.map(([k, label]) => h("a", { class: ["tab", k === current && "active"], href: `#/aufgaben/${k}` }, label))));
}

function leadName(t) {
  return [t.first_name, t.last_name].filter(Boolean).join(" ") || t.person_name || t.email || t.account_name || "Kontakt";
}

export function taskCard(t, res, reload) {
  const isCall = CALL_TYPES.includes(t.type);
  const isDraft = ["nurture_draft", "reply"].includes(t.type) && t.conversation_id;
  const overdue = t.status === "open" && t.due_at < Date.now() - 60 * 60 * 1000;
  return h("div", { class: "card task" },
    h("div", { class: "card-body stack-sm" },
      h("div", { class: "row", style: { flexWrap: "wrap" } },
        icon(isCall ? "phone" : isDraft ? "reply" : "list"),
        h("strong", { class: "grow" }, t.title),
        h("span", { class: "badge plain" }, res.types[t.type] || t.type),
        t.status !== "open" ? badge("task", t.status) : h("span", { class: ["small", overdue ? "danger-text" : "muted"], title: dateTime(t.due_at) }, `fällig ${relTime(t.due_at)}`)),
      h("div", { class: "task-lead" },
        h("div", null, h("div", { class: "strong" }, leadName(t), t.company ? h("span", { class: "muted" }, ` · ${t.company}`) : null, (t.position || t.person_role) ? h("span", { class: "muted small" }, ` (${t.position || t.person_role})`) : null,
          t.account_id ? h("a", { href: `#/firmen/${t.account_id}`, class: "small", style: { marginLeft: "6px" } }, "Firmenprofil") : null),
          h("div", { class: "small row-tight", style: { flexWrap: "wrap" } },
            t.phone ? h("span", { class: "badge plain", title: "Telefonnummer – für die Übergabe an die Sales App" }, icon("phone", "icon icon-xs"), t.phone) : null,
            t.email ? h("a", { href: `mailto:${t.email}`, class: "muted" }, t.email) : null,
            t.website ? h("a", { href: /^https?:/.test(t.website) ? t.website : `https://${t.website}`, target: "_blank", rel: "noopener noreferrer", class: "muted" }, t.website) : null)),
        h("div", { class: "small stack-sm" },
          t.conversation_label ? h("div", null, labelBadge(t.conversation_label), t.conversation_id ? h("a", { href: `#/unibox/${t.conversation_id}`, style: { marginLeft: "6px" } }, "Gespräch öffnen") : null) : null,
          t.product_name ? h("div", { class: "muted" }, "Produkt: ", h("strong", null, t.product_name), t.product_booking_url ? h("span", null, " · ", h("a", { href: t.product_booking_url, target: "_blank", rel: "noopener noreferrer" }, "Termin-Link")) : null) : null,
          t.campaign_name ? h("div", { class: "muted" }, `Kampagne: ${t.campaign_name}`) : null)),
      t.ai_summary ? h("div", { class: "small" }, h("span", { class: "muted" }, "Zusammenfassung: "), t.ai_summary) : null,
      t.lead_reason ? h("div", { class: "small" }, h("span", { class: "muted" }, "Anlass: "), t.lead_reason) : null,
      t.notes ? h("div", { class: "small pre" }, t.notes) : null,
      t.status === "open" ? (isCall ? callActions(t, res, reload) : isDraft ? draftActions(t, reload) : genericActions(t, reload)) : (t.outcome ? h("div", { class: "small muted" }, `Ergebnis: ${outcomeLabel(res, t.outcome)} · ${dateTime(t.done_at)}`) : null)));
}

function callActions(t, res, reload) {
  const notes = input({ placeholder: "Notiz zum Anruf (optional) – #nomail = keine Mails mehr, #blacklist = Firma sperren", class: "input input-sm", title: "#nomail: keine Mails mehr an diese Person (Anruf bleibt möglich) · #blacklist: ganze Firma nie wieder kontaktieren" });
  const outcome = (key, body = {}) => e => busy(e.currentTarget, async () => {
    if (key === "do_not_contact" && !(await confirmDialog("Kontakt wünscht keinen Kontakt mehr: Lead wird abgemeldet und gesperrt.", { danger: true, confirm: "Sperren" }))) return;
    const r = await api(`/api/tasks/${t.id}/outcome`, { method: "POST", body: { outcome: key, notes: notes.value, ...body } });
    toast(outcomeLabel(res, key));
    noteTagToast(r);
    reload();
  });
  const callback = e => {
    const when = input({ type: "datetime-local" });
    const dlg = modal({
      title: "Rückruf vereinbart",
      body: field("Wann?", when),
      footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: ev => busy(ev.currentTarget, async () => {
        if (!when.value) throw new Error("Bitte Zeitpunkt wählen");
        await api(`/api/tasks/${t.id}/outcome`, { method: "POST", body: { outcome: "callback", callback_at: new Date(when.value).getTime(), notes: notes.value } });
        dlg.close(); reload();
      }) }, "Speichern")]
    });
  };
  return h("div", { class: "stack-sm" }, notes,
    h("div", { class: "row-tight", style: { flexWrap: "wrap" } },
      h("button", { class: "btn btn-sm btn-primary", onclick: outcome("meeting") }, icon("calendar"), "Termin vereinbart"),
      h("button", { class: "btn btn-sm", onclick: outcome("interested") }, "Interesse – Infos senden"),
      h("button", { class: "btn btn-sm", onclick: callback }, "Rückruf vereinbart"),
      h("button", { class: "btn btn-sm", onclick: outcome("no_answer") }, `Nicht erreicht${t.attempts ? ` (${t.attempts}×)` : ""}`),
      h("button", { class: "btn btn-sm", onclick: outcome("not_interested") }, "Kein Interesse"),
      h("button", { class: "btn btn-sm btn-ghost", onclick: outcome("wrong_number") }, "Falsche Nummer"),
      h("button", { class: "btn btn-sm btn-ghost btn-danger", onclick: outcome("do_not_contact") }, "Kein Kontakt mehr")));
}

function draftActions(t, reload) {
  const text = textarea({ value: t.draft || "", rows: 8, placeholder: t.type === "reply" ? "Antwort schreiben …" : "Nachfass-Text …" });
  const aiOn = state.meta?.ai_available;
  return h("div", { class: "stack-sm" },
    t.type === "nurture_draft" ? h("div", { class: "hint" }, "Variablen wie {{anrede}}, {{termin_link}} und {{kit_link}} werden beim Senden ersetzt. Abmelde-Hinweis und Impressum werden angehängt.") : null,
    text,
    h("div", { class: "row-tight", style: { flexWrap: "wrap" } },
      h("button", { class: "btn btn-sm", disabled: !aiOn, title: aiOn ? "" : aiMissingText, onclick: e => busy(e.currentTarget, async () => {
        const r = await api(`/api/tasks/${t.id}/draft`, { method: "POST", body: {} });
        text.value = r.draft || "";
      }) }, icon("sparkles"), "KI-Entwurf"),
      h("button", { class: "btn btn-sm btn-primary", onclick: e => busy(e.currentTarget, async () => {
        if (!text.value.trim()) throw new Error("Text ist leer");
        await api(`/api/tasks/${t.id}/send`, { method: "POST", body: { text: text.value } });
        toast("Gesendet");
        reload();
      }) }, icon("send"), "Prüfen & senden"),
      h("a", { class: "btn btn-sm btn-ghost", href: `#/unibox/${t.conversation_id}` }, "Im Gespräch öffnen"),
      h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, async () => { await api(`/api/tasks/${t.id}`, { method: "PUT", body: { status: "dismissed" } }); reload(); }) }, "Verwerfen")));
}

function genericActions(t, reload) {
  return h("div", { class: "row-tight" },
    h("button", { class: "btn btn-sm btn-primary", onclick: e => busy(e.currentTarget, async () => { await api(`/api/tasks/${t.id}/outcome`, { method: "POST", body: { outcome: "done" } }); reload(); }) }, icon("check"), "Erledigt"),
    h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { await api(`/api/tasks/${t.id}`, { method: "PUT", body: { due_at: Date.now() + 7 * 24 * 3600 * 1000 } }); reload(); }) }, "1 Woche später"),
    h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, async () => { await api(`/api/tasks/${t.id}`, { method: "PUT", body: { status: "dismissed" } }); reload(); }) }, "Verwerfen"));
}
