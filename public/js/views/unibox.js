// Unibox: alle Antworten aus allen Postfächern – filtern, lesen, labeln, antworten (mit KI-Entwurf).
import { h, clear, api, select, textarea, busy, toast, dateTime, relTime, icon, labelBadge, state, emptyState, debounce, input, confirmDialog } from "../lib.js";

const NURTURE_STOP = { meeting: "Termin gebucht", exhausted: "alle Nachfass-Mails gesendet – jetzt in die Sales App übergeben", not_interested: "kein Interesse", unsubscribe: "abgemeldet", later: "später melden", user: "manuell gestoppt", wrong_person: "falscher Kontakt", bounce: "Bounce" };

// Status von Termin, Nachfassen und offenen Aufgaben – mit Schnellaktionen.
function followupBar(conv, lead, tasks, refresh) {
  const id = conv.id;
  const nurtureText = conv.meeting_at ? null
    : conv.nurture_next_at ? `Nachfassen geplant ${relTime(conv.nurture_next_at)} (${conv.nurture_count || 0} bisher)`
    : conv.nurture_stopped ? `Nachfassen beendet: ${NURTURE_STOP[conv.nurture_stopped] || conv.nurture_stopped}`
    : ["interested", "meeting", "question"].includes(conv.label) ? "Nachfassen startet nach eurer Antwort" : null;
  return h("div", { class: "followup-bar" },
    conv.meeting_at || lead.meeting_at ? h("span", { class: "badge ok" }, icon("calendar", "icon icon-xs"), `Termin: ${dateTime(conv.meeting_at || lead.meeting_at)}`)
      : h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => {
        if (!(await confirmDialog("Termin gebucht? Alle Mails und Nachfass-Schritte für diesen Kontakt stoppen.", { confirm: "Termin gebucht" }))) return;
        await api(`/api/conversations/${id}/meeting`, { method: "POST", body: {} });
        toast("Termin vermerkt – alles gestoppt"); window.dispatchEvent(new Event("tasks:changed")); refresh();
      }) }, icon("calendar"), "Termin gebucht"),
    nurtureText ? h("span", { class: "small muted" }, nurtureText) : null,
    !conv.meeting_at && conv.nurture_next_at ? h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, async () => { await api(`/api/conversations/${id}/nurture`, { method: "POST", body: { stop: true } }); refresh(); }) }, "Nachfassen stoppen") : null,
    !conv.meeting_at && conv.nurture_stopped === "user" ? h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, async () => { await api(`/api/conversations/${id}/nurture`, { method: "POST", body: { stop: false } }); refresh(); }) }, "Nachfassen fortsetzen") : null,
    h("span", { class: "grow" }),
    tasks.length ? h("a", { class: "small", href: "#/aufgaben/open" }, icon("phone", "icon icon-xs"), ` ${tasks.length} offene Aufgabe${tasks.length === 1 ? "" : "n"}: ${tasks[0].title}`) : null,
    lead.phone ? h("span", { class: "badge plain", title: "Telefonnummer – für die Übergabe an die Sales App" }, icon("phone", "icon icon-xs"), lead.phone) : null);
}

const FILTERS = [
  ["open", "Offen"], ["unread", "Ungelesen"], ["direct", "Direkt geschrieben"], ["positive", "Positiv"], ["interested", "Interessiert"], ["meeting", "Termin gewünscht"], ["question", "Rückfrage"],
  ["later", "Später melden"], ["not_interested", "Kein Interesse"], ["wrong_person", "Falscher Kontakt"], ["unsubscribe", "Abmeldung"], ["ooo", "Abwesend"], ["done", "Erledigt"], ["sent", "Gesendet"], ["all", "Alle Eingänge"]
];

export async function render(el, [convId]) {
  const st = { filter: "open", q: "", selected: convId ? Number(convId) : null, mailbox: "" };
  const filtersBox = h("nav", { class: "unibox-filters", "aria-label": "Filter" });
  const listBox = h("div", { class: "unibox-list" });
  const threadBox = h("section", { class: "unibox-thread" });
  const search = input({ type: "search", placeholder: "Suchen …", style: { maxWidth: "260px" } });
  const mailboxes = await api("/api/mailboxes").catch(() => []);
  const mbSel = select([["", "Alle Postfächer"], ...mailboxes.map(m => [m.id, m.email])], "");
  clear(el,
    h("div", { class: "page-head" }, h("h1", null, "Unibox"), h("span", { class: "sub" }, "Alle Antworten aus allen Postfächern"),
      h("div", { class: "actions" }, search, mbSel, h("button", { class: "btn", title: "Postfächer jetzt abgleichen", onclick: e => busy(e.currentTarget, async () => { await api("/api/system/run", { method: "POST", body: { job: "sync" } }); toast("Abgeglichen"); loadList(); }) }, icon("refresh"), "Abrufen"))),
    h("div", { class: "content", style: { maxWidth: "none" } }, h("div", { class: "unibox" }, filtersBox, listBox, threadBox)));

  let counts = {};
  const drawFilters = () => clear(filtersBox, FILTERS.map(([k, label]) => h("button", { class: st.filter === k ? "active" : "", onclick: () => { st.filter = k; drawFilters(); loadList(); } },
    h("span", null, label), k === "unread" && counts.unread ? h("span", { class: "badge accent" }, String(counts.unread)) : k === "positive" && counts.positive ? h("span", { class: "badge ok plain" }, String(counts.positive)) : null)));

  async function loadList() {
    const qs = new URLSearchParams({ filter: st.filter, limit: 100 });
    if (st.q) qs.set("q", st.q);
    if (st.mailbox) qs.set("mailbox", st.mailbox);
    const res = await api(`/api/conversations?${qs}`);
    counts = res.counts || {};
    drawFilters();
    clear(listBox, res.items.length ? res.items.map(c => h("div", { class: ["conv-item", c.unread && "unread", c.id === st.selected && "active"], tabindex: "0", role: "button",
      onclick: () => openThread(c.id), onkeydown: e => { if (e.key === "Enter") openThread(c.id); } },
      h("div", { class: "who" }, h("span", { class: "ellipsis" }, [c.first_name, c.last_name].filter(Boolean).join(" ") || c.lead_email), h("span", { class: "small muted nowrap" }, relTime(c.last_inbound_at || c.last_at))),
      h("div", { class: "row-tight small" }, h("span", { class: "muted ellipsis", style: { maxWidth: "180px" } }, c.company || c.lead_email), labelBadge(c.label)),
      h("div", { class: "small strong ellipsis" }, c.subject),
      h("div", { class: "snip" }, c.snippet)))
      : emptyState(st.filter === "open" ? "Alles erledigt" : "Keine Gespräche", st.filter === "open" ? "Neue Antworten erscheinen hier automatisch (Abgleich alle 2 Minuten)." : null));
    if (!st.selected) clear(threadBox, emptyState("Gespräch auswählen", "Links ein Gespräch öffnen, um zu lesen und zu antworten."));
  }

  async function openThread(id) {
    st.selected = id;
    history.replaceState(null, "", `#/unibox/${id}`);
    for (const item of listBox.querySelectorAll(".conv-item")) item.classList.remove("active");
    clear(threadBox, h("div", { class: "thread-msgs" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" })));
    const d = await api(`/api/conversations/${id}`);
    const conv = d.conversation, lead = d.lead;
    window.dispatchEvent(new Event("unread:changed"));
    const labels = state.meta?.labels || {};
    const labelSel = select([["", "Kein Label"], ...Object.entries(labels)], conv.label || "");
    labelSel.addEventListener("change", async () => {
      await api(`/api/conversations/${id}`, { method: "PATCH", body: { label: labelSel.value || null } });
      toast("Label gespeichert");
      loadList();
    });
    const reply = textarea({ rows: 6, placeholder: `Antwort an ${lead.first_name || lead.email} …` });
    const sendReply = done => e => busy(e.currentTarget, async () => {
      if (!reply.value.trim()) throw new Error("Antwort ist leer");
      await api(`/api/conversations/${id}/reply`, { method: "POST", body: { text: reply.value, mark_done: done } });
      toast("Antwort gesendet");
      await openThread(id);
      loadList();
    });
    const msgs = h("div", { class: "thread-msgs" }, d.messages.map(m => h("article", { class: ["msg", m.direction === "out" ? "out" : "in"] },
      h("div", { class: "meta" },
        h("strong", null, m.direction === "out" ? m.from_addr : `${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || m.from_addr}`),
        h("span", null, dateTime(m.created_at)),
        m.direction === "out" && m.kind === "campaign" ? h("span", { class: "badge plain" }, `Mail ${(m.step ?? 0) + 1}${m.variant ? ` · ${m.variant}` : ""}`) : null,
        m.kind === "nurture" ? h("span", { class: "badge info" }, "Nachfassen") : null,
        m.kind === "auto_reply" ? h("span", { class: "badge" }, "Abwesenheitsnotiz") : null,
        m.status === "bounced" ? h("span", { class: "badge danger" }, "Bounce") : null,
        m.opens ? h("span", null, `${m.opens}× geöffnet`) : null,
        h("span", { class: "grow" }), h("span", { class: "ellipsis", style: { maxWidth: "320px" } }, m.subject)),
      h("div", { class: "text" }, m.text_clean || m.text))));
    clear(threadBox,
      h("div", { class: "thread-head" },
        h("div", { class: "grow", style: { minWidth: "200px" } },
          h("div", { class: "strong" }, [lead.salutation, lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email, lead.company ? h("span", { class: "muted" }, ` · ${lead.company}`) : null),
          h("div", { class: "small muted ellipsis" }, lead.email, conv.campaign_name ? ` · Kampagne „${conv.campaign_name}“` : "", conv.mailbox_email ? ` · über ${conv.mailbox_email}` : "")),
        labelSel,
        h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { await api(`/api/conversations/${id}`, { method: "PATCH", body: { status: conv.status === "done" ? "open" : "done" } }); toast(conv.status === "done" ? "Wieder geöffnet" : "Erledigt"); loadList(); openThread(id); }) }, icon("check"), conv.status === "done" ? "Wieder öffnen" : "Erledigt"),
        d.ai_available ? h("button", { class: "btn btn-sm btn-ghost", title: "KI neu einordnen", onclick: e => busy(e.currentTarget, async () => { await api(`/api/conversations/${id}/classify`, { method: "POST" }); openThread(id); loadList(); }) }, icon("sparkles")) : null),
      conv.ai_summary ? h("div", { class: "alert info", style: { margin: "10px 16px 0" } }, icon("sparkles"), h("span", { class: "text-body" }, conv.ai_summary)) : null,
      followupBar(conv, lead, d.tasks || [], () => { openThread(id); loadList(); }),
      msgs,
      h("div", { class: "thread-reply" }, reply,
        h("div", { class: "hint" }, "Wird im selben Thread vom ursprünglichen Postfach gesendet – mit Signatur."),
        h("div", { class: "row", style: { flexWrap: "wrap" } },
          d.ai_available ? h("button", { class: "btn", onclick: e => busy(e.currentTarget, async () => { const r = await api(`/api/conversations/${id}/draft`, { method: "POST", body: {} }); reply.value = r.body; reply.focus(); }) }, icon("sparkles"), "KI-Entwurf") : null,
          d.ai_available && d.messages.at(-1)?.direction === "out" ? h("button", { class: "btn btn-ghost", title: "Kurze, freundliche Nachfass-Mail mit Termin-Link", onclick: e => busy(e.currentTarget, async () => { const r = await api(`/api/conversations/${id}/draft`, { method: "POST", body: { nurture: true } }); reply.value = r.body; reply.focus(); }) }, "Nachfass-Entwurf") : null,
          h("span", { class: "grow" }),
          h("button", { class: "btn", onclick: sendReply(true) }, "Senden & erledigt"),
          h("button", { class: "btn btn-primary", onclick: sendReply(false) }, icon("reply"), "Senden"))));
    msgs.scrollTop = msgs.scrollHeight;
  }

  search.addEventListener("input", debounce(() => { st.q = search.value.trim(); loadList(); }, 300));
  mbSel.addEventListener("change", () => { st.mailbox = mbSel.value; loadList(); });
  drawFilters();
  await loadList();
  if (st.selected) openThread(st.selected);
  const timer = setInterval(() => { if (!document.hidden) loadList(); }, 60000);
  return () => clearInterval(timer);
}
