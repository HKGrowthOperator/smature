// Übersicht: Einrichtungs-Checkliste, Kennzahlen, Verlauf, Postfach-Gesundheit, laufende Kampagnen.
import { h, clear, api, num, pct, badge, barChart, relTime, icon, skeletonRows, emptyState } from "../lib.js";

export async function render(el) {
  clear(el, h("div", { class: "page-head" }, h("h1", null, "Übersicht")), h("div", { class: "content" }, skeletonRows(5)));
  const d = await api("/api/dashboard");
  const k = d.kpis;
  const steps = [
    ["mailbox", "Postfach verbinden (SMTP + IMAP) – eigene Versand-Domain", "#/postfaecher"],
    ["footer", "Impressum / Pflichtangaben für die Fußzeile hinterlegen", "#/einstellungen"],
    ["privacy", "Link zur Datenschutzerklärung hinterlegen", "#/einstellungen"],
    ["product", "Produkt mit Termin-Link und Info-Kit anlegen", "#/produkte"],
    ["knowledge", "Wissen (Info-Blätter) zu Produkt/Zielgruppe hochladen", "#/produkte"],
    ["template", "Mail-Texte prüfen und freigeben", "#/produkte"],
    ["leads", "Leads importieren, Einwilligung/Qualität prüfen", "#/leads"],
    ["campaign", "Erste Kampagne starten", "#/kampagnen"]
  ];
  const setupDone = steps.every(([key]) => d.setup[key]);
  const tile = (label, value, meta) => h("div", { class: "card kpi" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), meta ? h("div", { class: "meta" }, meta) : null);

  clear(el,
    h("div", { class: "page-head" }, h("h1", null, "Übersicht"), h("span", { class: "sub" }, "Letzte 7 Tage"),
      h("div", { class: "actions" }, h("a", { class: "btn btn-primary", href: "#/kampagnen" }, icon("plus"), "Kampagne"))),
    h("div", { class: "content stack" },
      setupDone ? null : h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", null, "Einrichtung"), h("span", { class: "muted small" }, `${steps.filter(([key]) => d.setup[key]).length} von ${steps.length} erledigt`), h("div", { class: "actions" }, h("a", { class: "btn btn-sm btn-primary", href: "#/einrichtung" }, "Geführte Einrichtung"))),
        h("div", { class: "card-body checklist" }, steps.map(([key, title, href]) => h("a", { href, class: d.setup[key] ? "done" : "" }, h("span", { class: "tick" }, d.setup[key] ? icon("check") : null), h("span", { class: "title" }, title)))),
        d.setup.ai ? null : h("div", { class: "card-body", style: { paddingTop: 0 } }, h("div", { class: "alert info" }, "KI ist noch nicht aktiv. Für Profile, KI-Vorlagen, Qualitätsprüfung, Personalisierung und Antwort-Einordnung CLAUDE_CODE_OAUTH_TOKEN (Claude-Max-Abo) setzen – siehe Einstellungen → KI & Abo."))),
      h("div", { class: "kpis" },
        tile("Heute gesendet", num(k.sent_today), `${num(k.sent_week)} in 7 Tagen`),
        tile("Antworten", num(k.replies_week), `Antwortquote ${pct(k.reply_rate_week)}`),
        tile("Interessiert", num(k.interested_week), "positive Antworten"),
        tile("Termine", num(k.meetings_week), `${num(k.nurture_week)} Nachfass-Mails`),
        tile("Aufgaben fällig", num(k.tasks_due), h("a", { href: "#/aufgaben" }, `${num(k.tasks_open)} offen – zu den Aufgaben`)),
        tile("Bounce-Rate", pct(k.bounce_rate_week), `${num(k.bounces_week)} Bounces · Ziel < 2 %`),
        tile("Ungelesen", num(k.unread), h("a", { href: "#/unibox" }, "Zur Unibox")),
        tile("In Warteschlange", num(k.leads_queued), `${num(k.leads_total)} Leads gesamt`)),
      h("div", { class: "split" },
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Versand & Antworten"), h("span", { class: "muted small" }, "14 Tage")), h("div", { class: "card-body" }, barChart(d.series))),
        h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Laufende Kampagnen"), h("div", { class: "actions" }, h("a", { href: "#/kampagnen", class: "small" }, "Alle"))),
          d.campaigns.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
            h("thead", null, h("tr", null, h("th", null, "Kampagne"), h("th", { class: "num" }, "Gesendet"), h("th", { class: "num" }, "Antw."), h("th", null, "Fortschritt"))),
            h("tbody", null, d.campaigns.map(c => h("tr", { class: "clickable", onclick: () => { location.hash = `#/kampagnen/${c.id}`; } },
              h("td", null, h("div", { class: "strong ellipsis" }, c.name), badge("campaign", c.status)),
              h("td", { class: "num" }, num(c.sent)), h("td", { class: "num" }, num(c.replies)),
              h("td", null, h("div", { class: "bar" }, h("span", { style: { width: `${c.leads ? Math.round((1 - c.pending / c.leads) * 100) : 0}%` } }))))))))
            : emptyState("Keine laufende Kampagne", "Lege eine Kampagne an, füge Leads hinzu und starte sie.", h("a", { class: "btn", href: "#/kampagnen" }, "Zu den Kampagnen")))),
      h("div", { class: "card" },
        h("div", { class: "card-head" }, h("h2", null, "Postfächer"), h("div", { class: "actions" }, h("a", { href: "#/postfaecher", class: "small" }, "Verwalten"))),
        d.mailboxes.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
          h("thead", null, h("tr", null, h("th", null, "Postfach"), h("th", null, "Status"), h("th", null, "Heute"), h("th", { class: "num" }, "Bounce 30 T"), h("th", null, "Warmup"), h("th", null, "Abgleich"))),
          h("tbody", null, d.mailboxes.map(m => h("tr", null,
            h("td", null, h("div", { class: "strong" }, m.email), m.last_error ? h("div", { class: "small", style: { color: "var(--danger)" } }, m.last_error) : null),
            h("td", null, badge("mailbox", m.status)),
            h("td", null, h("div", { class: "row-tight" }, h("div", { class: "bar", style: { width: "80px" } }, h("span", { style: { width: `${Math.min(100, m.limit_today ? m.sent_today / m.limit_today * 100 : 0)}%` } })), h("span", { class: "small muted" }, `${m.sent_today}/${m.limit_today}`))),
            h("td", { class: "num" }, h("span", { style: { color: m.bounce_rate_30d > 3 ? "var(--danger)" : "inherit" } }, pct(m.bounce_rate_30d))),
            h("td", null, m.warmup_enabled ? (m.warmup_health.score === null ? h("span", { class: "small muted" }, "läuft …") : h("span", { class: ["badge", m.warmup_health.score >= 90 ? "ok" : m.warmup_health.score >= 70 ? "warn" : "danger"] }, `${m.warmup_health.score} % Posteingang`)) : h("span", { class: "small muted" }, "aus")),
            h("td", { class: "small muted" }, m.imap_configured ? (m.sync_error ? h("span", { style: { color: "var(--danger)" } }, m.sync_error) : relTime(m.last_sync_at)) : "kein IMAP"))))))
          : emptyState("Noch kein Postfach", "Verbinde mindestens ein Postfach. Mehrere Postfächer werden automatisch rotiert.", h("a", { class: "btn btn-primary", href: "#/postfaecher" }, "Postfach verbinden")))));
}
