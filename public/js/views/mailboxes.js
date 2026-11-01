// Postfächer: verbinden (Anbieter-Vorlagen), testen, Limits/Ramp-up/Warmup, DNS-Check, Testmail.
import { h, clear, api, modal, field, input, textarea, select, checkbox, busy, toast, toastError, confirmDialog, badge, relTime, num, pct, icon, emptyState, skeletonRows } from "../lib.js";

let providers = null;

export async function render(el) {
  clear(el, head(() => load(el)), h("div", { class: "content" }, skeletonRows(4)));
  providers = providers || await api("/api/mailboxes/providers");
  await load(el);
}

function head(reload) {
  return h("div", { class: "page-head" }, h("h1", null, "Postfächer"), h("span", { class: "sub" }, "Versand-Postfächer mit Rotation, Ramp-up und Warmup"),
    h("div", { class: "actions" }, h("button", { class: "btn btn-primary", onclick: () => openForm(null, reload) }, icon("plus"), "Postfach verbinden")));
}

async function load(el) {
  const list = await api("/api/mailboxes");
  const reload = () => load(el);
  clear(el, head(reload), h("div", { class: "content stack" },
    list.length ? h("div", { class: "card" }, h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "Postfach"), h("th", null, "Status"), h("th", null, "Heute / Limit"), h("th", { class: "num" }, "Bounce 30 T"), h("th", null, "Warmup"), h("th", null, "IMAP-Abgleich"), h("th", null, ""))),
      h("tbody", null, list.map(m => h("tr", null,
        h("td", null, h("div", { class: "strong" }, m.email), h("div", { class: "small muted" }, m.from_name || "–"), m.last_error ? h("div", { class: "small", style: { color: "var(--danger)" } }, m.last_error) : null),
        h("td", null, badge("mailbox", m.status)),
        h("td", null, h("div", null, `${num(m.sent_today)} / ${num(m.limit_today)}`), m.ramp_enabled && m.limit_today < m.daily_limit ? h("div", { class: "small muted" }, `Ramp-up → ${m.daily_limit}/Tag`) : null),
        h("td", { class: "num" }, pct(m.bounce_rate_30d)),
        h("td", null, m.warmup_enabled ? h("div", null, `${m.warmup_sent_today}/${m.warmup_target_today} heute`, h("div", { class: "small muted" }, m.warmup_health.score === null ? "noch keine Daten" : `${m.warmup_health.score} % im Posteingang`)) : h("span", { class: "muted small" }, "aus")),
        h("td", { class: "small" }, m.imap_configured ? (m.sync_error ? h("span", { style: { color: "var(--danger)" } }, m.sync_error) : relTime(m.last_sync_at)) : h("span", { class: "badge warn" }, "nicht verbunden")),
        h("td", { class: "right nowrap" }, rowActions(m, reload))))))))
      : h("div", { class: "card" }, emptyState("Noch kein Postfach verbunden", "Jedes Postfach sendet über SMTP und liest Antworten über IMAP. Am besten 2–5 Postfächer auf einer eigenen Versand-Domain (z. B. musterfirma-mail.de statt musterfirma.de) nutzen.",
        h("button", { class: "btn btn-primary", onclick: () => openForm(null, reload) }, icon("plus"), "Postfach verbinden"))),
    h("div", { class: "card card-pad stack-sm" },
      h("h3", null, "Empfehlungen für gute Zustellbarkeit"),
      h("ul", { class: "small", style: { margin: 0, paddingLeft: "18px" } },
        h("li", null, "Eigene Versand-Domain verwenden, damit die Hauptdomain geschützt bleibt."),
        h("li", null, "SPF, DKIM und DMARC einrichten – „DNS prüfen“ zeigt, was fehlt."),
        h("li", null, "Neue Postfächer 2–3 Wochen mit Ramp-up und Warmup einfahren, dann 30–50 Mails pro Tag und Postfach."),
        h("li", null, "Bounce-Rate unter 2 % halten: Leads vor dem Start prüfen.")))));
}

function rowActions(m, reload) {
  const more = async action => {
    if (action === "edit") return openForm(m, reload);
    if (action === "test") {
      const res = await api(`/api/mailboxes/${m.id}/test`, { method: "POST" });
      return showTestResult(res);
    }
    if (action === "send") return openTestSend(m);
    if (action === "sync") {
      const res = await api(`/api/mailboxes/${m.id}/sync`, { method: "POST" });
      toast(res.skipped ? `Übersprungen: ${res.skipped}` : `Abgleich: ${res.processed} neue Mails (${res.replies} Antworten, ${res.bounces} Bounces)`);
      return reload();
    }
    if (action === "dns") return openDns(m);
    if (action === "toggle") {
      await api(`/api/mailboxes/${m.id}/status`, { method: "POST", body: { status: m.status === "active" ? "paused" : "active" } });
      return reload();
    }
    if (action === "delete") {
      if (!(await confirmDialog(`Postfach ${m.email} entfernen? Versendete Nachrichten bleiben erhalten.`, { danger: true, confirm: "Entfernen" }))) return;
      await api(`/api/mailboxes/${m.id}`, { method: "DELETE" });
      toast("Postfach entfernt");
      return reload();
    }
  };
  const btn = (label, action, ic) => h("button", { class: "btn btn-sm btn-ghost", title: label, onclick: e => busy(e.currentTarget, () => more(action)) }, ic ? icon(ic) : null, label);
  return h("div", { class: "row-tight", style: { justifyContent: "flex-end" } },
    btn("Bearbeiten", "edit"), btn("Testen", "test"), btn("Testmail", "send"), btn("DNS", "dns"), btn("Abgleich", "sync"),
    btn(m.status === "active" ? "Pausieren" : "Aktivieren", "toggle"), h("button", { class: "btn btn-sm btn-ghost btn-danger", title: "Entfernen", "aria-label": "Entfernen", onclick: e => busy(e.currentTarget, () => more("delete")) }, icon("trash")));
}

function showTestResult(res) {
  const line = (label, r) => h("div", { class: ["alert", r.ok ? "ok" : r.ok === null ? "warn" : "danger"] }, h("strong", null, label + ": "), r.ok ? "Verbindung erfolgreich" : r.error);
  modal({ title: "Verbindungstest", body: h("div", { class: "stack-sm" }, line("SMTP (Versand)", res.smtp), line("IMAP (Antworten)", res.imap)) });
}

function openTestSend(m) {
  const to = input({ type: "email", placeholder: "deine@adresse.de" });
  const dlg = modal({
    title: `Testmail von ${m.email}`,
    body: h("div", { class: "stack" }, field("Empfänger", to, "Am besten an ein Gmail- und ein Outlook-Postfach senden und prüfen, ob die Mail im Posteingang landet.")),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => { await api(`/api/mailboxes/${m.id}/test-send`, { method: "POST", body: { to: to.value } }); toast("Testmail gesendet"); dlg.close(); }) }, "Senden")]
  });
}

async function openDns(m, selector = "") {
  const body = h("div", { class: "stack-sm" }, h("div", { class: "skeleton" }), h("div", { class: "skeleton" }));
  const dlg = modal({ title: `DNS-Check: ${m.email.split("@")[1]}`, body, wide: true });
  try {
    const res = await api(`/api/mailboxes/${m.id}/dns${selector ? `?selector=${encodeURIComponent(selector)}` : ""}`);
    const sel = input({ placeholder: "eigener DKIM-Selektor", value: selector, class: "input input-sm" });
    clear(body,
      h("div", { class: "row" }, h("strong", null, `Bewertung: ${res.score}/100`), h("span", { class: "muted small" }, "SPF, DKIM und DMARC sind Voraussetzung für den Posteingang bei Gmail und Outlook.")),
      h("div", null, res.checks.map(c => h("div", { class: "dns-row" },
        h("strong", null, c.label),
        h("span", { class: ["badge", c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : "danger"] }, c.status === "ok" ? "OK" : c.status === "warn" ? "Hinweis" : "Fehlt"),
        h("div", { class: "small" }, h("div", { class: "mono", style: { overflowWrap: "anywhere" } }, c.detail), c.fix ? h("div", { class: "muted" }, c.fix) : null)))),
      h("div", { class: "row-tight" }, sel, h("button", { class: "btn btn-sm", onclick: () => { dlg.close(); openDns(m, sel.value.trim()); } }, "Mit Selektor prüfen")));
  } catch (err) {
    clear(body, h("div", { class: "alert danger" }, err.message));
  }
}

function openForm(existing, onSaved) {
  const m = existing || {};
  const f = {
    provider: select(Object.entries(providers).map(([k, p]) => [k, p.label]), m.provider || "google"),
    email: input({ type: "email", value: m.email || "", placeholder: "max@musterfirma-mail.de", autocomplete: "off" }),
    from_name: input({ value: m.from_name || "", placeholder: "Max Mustermann" }),
    smtp_pass: input({ type: "password", placeholder: existing ? "unverändert lassen" : "Passwort bzw. App-Passwort", autocomplete: "new-password" }),
    smtp_host: input({ value: m.smtp_host || "" }),
    smtp_port: input({ type: "number", value: m.smtp_port || 465 }),
    smtp_secure: checkbox("SSL/TLS (Port 465)", m.smtp_secure ?? 1, "Aus = STARTTLS (Port 587)"),
    smtp_user: input({ value: m.smtp_user || "", placeholder: "meist die E-Mail-Adresse" }),
    imap_host: input({ value: m.imap_host || "" }),
    imap_port: input({ type: "number", value: m.imap_port || 993 }),
    imap_secure: checkbox("SSL/TLS", m.imap_secure ?? 1),
    imap_user: input({ value: m.imap_user || "", placeholder: "wie SMTP" }),
    imap_pass: input({ type: "password", placeholder: "leer = wie SMTP", autocomplete: "new-password" }),
    daily_limit: input({ type: "number", value: m.daily_limit ?? 30, min: 1 }),
    min_gap_sec: input({ type: "number", value: Math.round((m.min_gap_sec ?? 120) / 60), min: 0 }),
    ramp_enabled: checkbox("Ramp-up aktiv", m.ramp_enabled ?? 1, "Startet mit wenigen Mails und steigert täglich bis zum Tageslimit."),
    ramp_start: input({ type: "number", value: m.ramp_start ?? 5, min: 1 }),
    ramp_step: input({ type: "number", value: m.ramp_step ?? 3, min: 0 }),
    signature: textarea({ value: m.signature || "", rows: 4, placeholder: "Max Mustermann\nMusterfirma GmbH\nTel. 0123 …" }),
    reply_to: input({ type: "email", value: m.reply_to || "", placeholder: "optional" }),
    save_sent: checkbox("Kopie in „Gesendet“ ablegen (IMAP)", m.save_sent ?? 1, "Bei Google Workspace und Microsoft 365 nicht nötig – das macht der Anbieter selbst."),
    warmup_enabled: checkbox("Warmup aktiv", m.warmup_enabled ?? 0, "Postfächer schreiben sich gegenseitig, öffnen, antworten und holen Mails aus dem Spam. Mindestens 2 Postfächer nötig."),
    warmup_daily: input({ type: "number", value: m.warmup_daily ?? 10, min: 1, max: 60 }),
    warmup_reply_rate: input({ type: "number", value: m.warmup_reply_rate ?? 35, min: 0, max: 100 })
  };
  const hint = h("div", { class: "alert info", hidden: true });
  const applyProvider = () => {
    const p = providers[f.provider.value];
    if (!p) return;
    if (!existing || existing.provider !== f.provider.value) {
      f.smtp_host.value = p.smtp_host; f.smtp_port.value = p.smtp_port; f.smtp_secure.input.checked = !!p.smtp_secure;
      f.imap_host.value = p.imap_host; f.imap_port.value = p.imap_port; f.imap_secure.input.checked = !!p.imap_secure;
      f.save_sent.input.checked = !["google", "microsoft"].includes(f.provider.value);
    }
    hint.hidden = !p.hint; hint.textContent = p.hint;
  };
  f.provider.addEventListener("change", applyProvider);
  if (!existing) applyProvider(); else { const p = providers[m.provider]; hint.hidden = !p?.hint; hint.textContent = p?.hint || ""; }
  const result = h("div");

  const collect = () => ({
    id: existing?.id,
    provider: f.provider.value, email: f.email.value, from_name: f.from_name.value,
    smtp_host: f.smtp_host.value, smtp_port: Number(f.smtp_port.value), smtp_secure: f.smtp_secure.input.checked, smtp_user: f.smtp_user.value || f.email.value,
    smtp_pass: f.smtp_pass.value || undefined,
    imap_host: f.imap_host.value, imap_port: Number(f.imap_port.value), imap_secure: f.imap_secure.input.checked, imap_user: f.imap_user.value || f.smtp_user.value || f.email.value,
    imap_pass: f.imap_pass.value || undefined, imap_same_pass: !f.imap_pass.value,
    daily_limit: Number(f.daily_limit.value), min_gap_sec: Number(f.min_gap_sec.value) * 60,
    ramp_enabled: f.ramp_enabled.input.checked, ramp_start: Number(f.ramp_start.value), ramp_step: Number(f.ramp_step.value),
    signature: f.signature.value, reply_to: f.reply_to.value, save_sent: f.save_sent.input.checked,
    warmup_enabled: f.warmup_enabled.input.checked, warmup_daily: Number(f.warmup_daily.value), warmup_reply_rate: Number(f.warmup_reply_rate.value)
  });

  const advanced = h("details", null, h("summary", { class: "label", style: { cursor: "pointer" } }, "Server-Einstellungen"),
    h("div", { class: "form-grid", style: { marginTop: "12px" } },
      field("SMTP-Server", f.smtp_host), h("div", { class: "row" }, field("SMTP-Port", f.smtp_port), f.smtp_secure),
      field("SMTP-Benutzer", f.smtp_user), h("div"),
      field("IMAP-Server", f.imap_host), h("div", { class: "row" }, field("IMAP-Port", f.imap_port), f.imap_secure),
      field("IMAP-Benutzer", f.imap_user), field("IMAP-Passwort", f.imap_pass)));
  if (!existing || !m.smtp_host) advanced.open = !["google", "microsoft", "ionos", "strato", "hetzner", "zoho"].includes(f.provider.value);

  const dlg = modal({
    title: existing ? `Postfach bearbeiten: ${m.email}` : "Postfach verbinden",
    wide: true,
    body: h("div", { class: "stack" },
      h("div", { class: "form-grid" },
        field("Anbieter", f.provider), field("E-Mail-Adresse", f.email),
        field("Absendername", f.from_name, "So erscheint der Absender beim Empfänger."), field("Passwort", f.smtp_pass, "Bei Google: App-Passwort, nicht das normale Passwort."),
        h("div", { class: "full" }, hint)),
      advanced,
      h("hr"),
      h("h3", null, "Versand"),
      h("div", { class: "form-grid" },
        field("Tageslimit (Kampagnen-Mails)", f.daily_limit, "Empfehlung: 30–50 pro Postfach und Tag."), field("Mindestabstand (Minuten)", f.min_gap_sec, "Zusätzlich zum zufälligen Abstand der Kampagne."),
        h("div", { class: "full" }, f.ramp_enabled),
        field("Ramp-up Start (Mails/Tag)", f.ramp_start), field("Steigerung pro Tag", f.ramp_step),
        h("div", { class: "full" }, field("Signatur", f.signature, "Wird unter jede Mail gesetzt. Variablen wie {{sender_name}} sind möglich.")),
        field("Antwort-an (optional)", f.reply_to), h("div", { style: { alignSelf: "end" } }, f.save_sent)),
      h("hr"),
      h("h3", null, "Warmup"),
      h("div", { class: "form-grid" }, h("div", { class: "full" }, f.warmup_enabled), field("Warmup-Mails pro Tag (Ziel)", f.warmup_daily), field("Antwortquote im Warmup (%)", f.warmup_reply_rate)),
      result),
    footer: [
      h("button", { class: "btn left", onclick: e => busy(e.currentTarget, async () => {
        const res = await api("/api/mailboxes/test", { method: "POST", body: collect() });
        const line = (label, r) => h("div", { class: ["alert", r.ok ? "ok" : r.ok === null ? "warn" : "danger"] }, h("strong", null, label + ": "), r.ok ? "Verbindung erfolgreich" : r.error);
        clear(result, h("div", { class: "stack-sm" }, line("SMTP", res.smtp), line("IMAP", res.imap)));
        result.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }) }, "Verbindung testen"),
      h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"),
      h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
        const body = collect();
        await api(existing ? `/api/mailboxes/${existing.id}` : "/api/mailboxes", { method: existing ? "PUT" : "POST", body });
        toast(existing ? "Gespeichert" : "Postfach verbunden");
        dlg.close();
        onSaved?.();
      }) }, existing ? "Speichern" : "Verbinden")
    ]
  });
}

export { openForm as openMailboxForm, toastError };
