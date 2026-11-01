// Einstellungen: Pflichtangaben/Fußzeile, Absender-Kontext für die KI, Webhook, Benutzer, System, Rechtliches.
import { h, clear, api, modal, field, input, textarea, select, checkbox, busy, toast, confirmDialog, dateTime, relTime, num, state, skeletonRows, icon } from "../lib.js";

const TABS = [["allgemein", "Allgemein"], ["kontaktregeln", "Kontaktregeln"], ["termine", "Termine"], ["ki", "KI & Abo"], ["integration", "Webhook"], ["benutzer", "Benutzer"], ["system", "System"], ["recht", "Recht & DSGVO"]];
const EVENTS = { "reply.received": "Antwort eingegangen", "lead.interested": "Lead interessiert", "lead.meeting": "Termin gebucht", "lead.unsubscribed": "Lead abgemeldet", "lead.bounced": "Bounce", "campaign.completed": "Kampagne abgeschlossen", "task.created": "Aufgabe angelegt (z. B. Anruf)", "account.triggered": "Neuer Anlass bei einer Firma", "opportunity.won": "Auftrag gewonnen" };
const DAYS = [[1, "Mo"], [2, "Di"], [3, "Mi"], [4, "Do"], [5, "Fr"], [6, "Sa"], [7, "So"]];

export async function render(el, [tab]) {
  const current = TABS.some(([k]) => k === tab) ? tab : "allgemein";
  const body = h("div", { style: { maxWidth: "920px" } }, skeletonRows(4));
  clear(el, h("div", { class: "page-head" }, h("h1", null, "Einstellungen")),
    h("div", { class: "content" }, h("div", { class: "tabs" }, TABS.map(([k, label]) => h("a", { class: ["tab", k === current && "active"], href: `#/einstellungen/${k}` }, label))), body));
  const s = await api("/api/settings");
  const isAdmin = state.user?.role === "admin";
  const save = patch => api("/api/settings", { method: "PUT", body: patch }).then(r => { toast("Gespeichert"); return r; });
  if (current === "allgemein") return drawGeneral(body, s, save, isAdmin);
  if (current === "kontaktregeln") return drawRules(body, s, save, isAdmin);
  if (current === "termine") return drawBooking(body, s, save, isAdmin);
  if (current === "ki") return drawAi(body, s, save, isAdmin);
  if (current === "integration") return drawWebhook(body, s, save, isAdmin);
  if (current === "benutzer") return drawUsers(body, isAdmin);
  if (current === "system") return drawSystem(body, isAdmin);
  return drawLegal(body);
}

function drawGeneral(body, s, save, isAdmin) {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["Europe/Berlin"];
  const f = {
    company_name: input({ value: s.company_name }),
    footer_text: textarea({ value: s.footer_text, rows: 3, placeholder: "Firma GmbH · Musterstraße 1 · 12345 Musterstadt · Geschäftsführer: … · HRB … · AG …" }),
    unsubscribe_text: textarea({ value: s.unsubscribe_text, rows: 2 }),
    privacy_url: input({ value: s.privacy_url, placeholder: "https://musterfirma.de/datenschutz" }),
    timezone: select(zones.map(z => [z, z]), s.timezone),
    warmup_folder: input({ value: s.warmup_folder, placeholder: "leer = im Posteingang lassen" })
  };
  clear(body, h("div", { class: "stack" },
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Absender & Pflichtangaben")), h("div", { class: "card-body stack" },
      field("Firmenname", f.company_name),
      field("Fußzeile / Impressum (unter jeder Mail)", f.footer_text, "Pflichtangaben (Firma, Rechtsform, Sitz, Registergericht, HRB, Geschäftsführung). Mit {{privacy_url}} den Link zur Datenschutzerklärung einfügen – Pflicht für die Information nach Art. 14 DSGVO."),
      field("Abmelde-Hinweis", f.unsubscribe_text, "Muss {{unsubscribe_url}} enthalten. Wird angefügt, wenn die Kampagne Abmelde-Links nutzt."),
      field("Link zur Datenschutzerklärung", f.privacy_url, "Als {{privacy_url}} in Fußzeile und Abmelde-Hinweis nutzbar; erscheint auch auf der Abmelde-Seite. Sie sollte die Datenquelle und das Widerspruchsrecht nennen."))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Allgemein")), h("div", { class: "card-body form-grid" },
      field("Zeitzone (Tageslimits, Warmup)", f.timezone), field("Ordner für Warmup-Mails", f.warmup_folder, "Empfangene Warmup-Mails werden nach dem Lesen dorthin verschoben."))),
    h("div", { class: "row" }, h("div", { class: "grow" }), h("button", { class: "btn btn-primary", disabled: !isAdmin, onclick: e => busy(e.currentTarget, () => save(Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])))) }, "Speichern"))));
}

function drawRules(body, s, save, isAdmin) {
  const f = {
    cooldown_days: input({ type: "number", min: 0, max: 730, value: s.cooldown_days }),
    not_interested_hold_days: input({ type: "number", min: 30, max: 1825, value: s.not_interested_hold_days }),
    company_cap_30d: input({ type: "number", min: 0, max: 50, value: s.company_cap_30d }),
    skip_freemail_cold: checkbox("Kaltakquise nie an Freemail-Adressen (Gmail, GMX, Web.de …)", s.skip_freemail_cold, "Privatpersonen dürfen ohne Einwilligung weder angemailt noch angerufen werden."),
    guess_chief_emails: checkbox("Chef-Adressen aus Name und Firmenmuster bilden (riskant)", s.guess_chief_emails, "Aus = nur Adressen, die wörtlich auf der Website stehen. Gebildete Adressen sind ungeprüft und als „riskant“ markiert."),
    cold_exclude_terms: textarea({ value: s.cold_exclude_terms || "", rows: 2, placeholder: "z. B. versicherung, makler" }),
    nurture_window_start: input({ type: "time", value: s.nurture_window_start }),
    nurture_window_end: input({ type: "time", value: s.nurture_window_end })
  };
  const days = new Set(String(s.nurture_weekdays || "1,2,3,4,5").split(",").map(Number));
  const dayChips = DAYS.map(([n, label]) => h("button", { type: "button", class: ["chip", days.has(n) && "active"], onclick: e => { days.has(n) ? days.delete(n) : days.add(n); e.currentTarget.classList.toggle("active"); } }, label));
  clear(body, h("div", { class: "stack" },
    h("div", { class: "alert info" }, "Diese Regeln gelten für alle Kampagnen und Produkte und schützen vor Überkontakt. Gründe für übersprungene Leads stehen in der Kampagne beim jeweiligen Lead."),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Kontaktregeln")), h("div", { class: "card-body form-grid" },
      field("Sperrfrist zwischen Kampagnen (Tage)", f.cooldown_days, "Wer von einer anderen Kampagne angeschrieben wurde, bekommt so lange keine neue erste Mail. 0 = aus."),
      field("Sperre nach „kein Interesse“ (Tage)", f.not_interested_hold_days, "Abmeldungen sind dauerhaft."),
      field("Max. Kontakte je Firma in 30 Tagen", f.company_cap_30d, "Personen mit derselben Firmen-Domain. 0 = unbegrenzt."), h("div"),
      h("div", { class: "full" }, f.skip_freemail_cold),
      h("div", { class: "full" }, f.guess_chief_emails),
      h("div", { class: "full" }, field("Weitere Ausschluss-Begriffe für Kaltakquise", f.cold_exclude_terms, "Immer ausgeschlossen: Anwälte, Kanzleien, Notare, Steuerberater, Abmahn- und Verbraucherschutz-Vereine, Datenschutz, Inkasso, Kammern, Behörden und Gerichte. Geprüft werden Firma, Branche, Position, Website und E-Mail. Begriffe mit Komma trennen.")))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Nachfassen bei Interesse")), h("div", { class: "card-body form-grid" },
      h("div", { class: "full field" }, h("span", { class: "label" }, "Wochentage"), h("div", { class: "chips" }, dayChips)),
      field("Von", f.nurture_window_start), field("Bis", f.nurture_window_end),
      h("div", { class: "full hint" }, "Abstand und Anzahl der Nachfass-Mails stellt ihr je Kampagne ein. Gesendet wird nur mit freigegebenen Texten."))),
    h("div", { class: "row" }, h("div", { class: "grow" }), h("button", { class: "btn btn-primary", disabled: !isAdmin, onclick: e => busy(e.currentTarget, () => save({
      cooldown_days: Number(f.cooldown_days.value), not_interested_hold_days: Number(f.not_interested_hold_days.value), company_cap_30d: Number(f.company_cap_30d.value),
      skip_freemail_cold: f.skip_freemail_cold.input.checked, guess_chief_emails: f.guess_chief_emails.input.checked, cold_exclude_terms: f.cold_exclude_terms.value, nurture_window_start: f.nurture_window_start.value, nurture_window_end: f.nurture_window_end.value, nurture_weekdays: [...days].sort()
    })) }, "Speichern"))));
}

function drawBooking(body, s, save, isAdmin) {
  const f = {
    booking_url: input({ type: "url", value: s.booking_url, placeholder: "https://cal.com/…" }),
    booking_prefill: checkbox("E-Mail und Name im Termin-Link vorbelegen (?email=…&name=…)", s.booking_prefill, "Bequemer für den Kunden und die Buchung lässt sich sicher zuordnen. Die Adresse steht dann im Link.")
  };
  const hook = s.booking_hook_url;
  clear(body, h("div", { class: "stack" },
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Termin-Link")), h("div", { class: "card-body stack" },
      field("Standard-Termin-Link", f.booking_url, "Gilt, wenn das Produkt keinen eigenen Link hat. In Mails als {{termin_link}}."), f.booking_prefill)),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Buchungen zurückmelden (Webhook)")), h("div", { class: "card-body stack-sm" },
      h("p", { class: "small" }, "Trage diese Adresse in eurem Buchungstool als Webhook ein (Calendly: „Invitee Created/Canceled“, Cal.com: „Booking Created/Cancelled“, eigene Sales App: POST mit JSON { email, start_time }). Bei einer Buchung stoppt die App sofort alle Mails, das Nachfassen und offene Anrufe für diesen Kontakt und meldet „Termin gebucht“."),
      hook ? h("div", { class: "input-group" }, input({ value: hook, readonly: true, onfocus: e => e.target.select() }), h("button", { class: "btn", onclick: () => navigator.clipboard?.writeText(hook).then(() => toast("Kopiert")) }, icon("copy"), "Kopieren"))
        : h("div", { class: "alert warn" }, "Nur Administratoren sehen die Webhook-Adresse."),
      isAdmin ? h("div", null, h("button", { class: "btn btn-sm btn-ghost", onclick: e => busy(e.currentTarget, async () => {
        if (!(await confirmDialog("Neue Adresse erzeugen? Die alte funktioniert danach nicht mehr – im Buchungstool austauschen.", { confirm: "Neu erzeugen", danger: true }))) return;
        await api("/api/settings/booking-secret", { method: "POST" });
        toast("Neue Adresse erzeugt");
        drawBooking(body, await api("/api/settings"), save, isAdmin);
      }) }, "Neue Adresse erzeugen")) : null)),
    h("div", { class: "row" }, h("div", { class: "grow" }), h("button", { class: "btn btn-primary", disabled: !isAdmin, onclick: e => busy(e.currentTarget, () => save({ booking_url: f.booking_url.value, booking_prefill: f.booking_prefill.input.checked })) }, "Speichern"))));
}

async function drawAi(body, s, save, isAdmin) {
  const ai = await api("/api/system/ai");
  const f = {
    sender_context: textarea({ value: s.sender_context, rows: 10, placeholder: "Wer wir sind, was wir anbieten, für wen, Ergebnisse/Referenzen, wie wir arbeiten …" }),
    ai_daily_limit: input({ type: "number", min: 0, max: 5000, value: s.ai_daily_limit }),
    auto_classify: checkbox("Neue Antworten automatisch mit KI einordnen", s.auto_classify, "Labels: Interessiert, Termin gewünscht, Rückfrage, Kein Interesse, Abmeldung … – steuern Aufgaben und Nachfassen."),
    watch_interval_days: input({ type: "number", min: 7, max: 365, value: s.watch_interval_days }),
    watch_daily_limit: input({ type: "number", min: 0, max: 500, value: s.watch_daily_limit }),
    reply_sla_minutes: input({ type: "number", min: 5, max: 1440, value: s.reply_sla_minutes }),
    creepy_threshold: input({ type: "number", min: 10, max: 90, value: s.creepy_threshold })
  };
  const provider = ai.provider === "subscription" ? "Claude-Max-Abo (Claude Code, Abrechnung über die Nutzungslimits des Abos)" : ai.provider === "api" ? "Anthropic-API (Abrechnung pro Token)" : "nicht eingerichtet";
  const paused = ai.paused_until && ai.paused_until > Date.now();
  clear(body, h("div", { class: "stack" },
    h("div", { class: ["alert", !ai.available ? "warn" : paused ? "warn" : "ok"] }, h("div", { class: "stack-sm" },
      h("div", null, h("strong", null, "KI: "), provider, ai.available ? ` · Modell ${ai.model}` : ""),
      ai.available ? h("div", null, `Heute ${num(ai.today)} von ${ai.daily_limit ? num(ai.daily_limit) : "∞"} Anfragen · seit Neustart ${num(ai.requests)} Anfragen${ai.errors ? `, ${num(ai.errors)} Fehler` : ""}${ai.last_error ? ` · Letzter Fehler: ${ai.last_error}` : ""}`) : null,
      paused ? h("div", null, h("strong", null, `Pausiert bis ${dateTime(ai.paused_until)}`), " – das Nutzungslimit des Abos ist erreicht. Versand mit KI-Personalisierung wartet automatisch; Mails ohne KI laufen weiter.") : null,
      paused && isAdmin ? h("div", null, h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { await api("/api/system/ai/resume", { method: "POST" }); toast("KI wieder freigegeben"); drawAi(body, s, save, isAdmin); }) }, "Pause aufheben")) : null,
      !ai.available ? h("div", { class: "text-body small" }, "Einrichtung (einmalig): Auf einem Rechner mit Browser „claude setup-token“ ausführen, mit dem Max-Konto anmelden und den Token als CLAUDE_CODE_OAUTH_TOKEN in Coolify eintragen; App neu starten. In claude.ai unter Einstellungen → Nutzung die Zusatznutzung ausgeschaltet lassen, dann wird nie mehr als das Abo verbraucht.") : null)),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Kontingent")), h("div", { class: "card-body form-grid" },
      field("Max. KI-Anfragen pro Tag", f.ai_daily_limit, "Schützt das Abo-Kontingent für eure übrige Arbeit mit Claude. 0 = ohne eigenes Limit (das Abo-Limit gilt trotzdem)."),
      h("div", { class: "hint" }, "Eine Anfrage = ein Profil, eine Vorlage, eine Lead-Prüfung, eine Personalisierung, eine Einordnung oder ein Antwortentwurf."))),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Unser Angebot (für alle KI-Texte)")), h("div", { class: "card-body stack" },
      field("Absender-Beschreibung", f.sender_context, "Wird mit Produkt- und Zielgruppen-Wissen kombiniert. Je konkreter (Ergebnisse, Referenzen, Arbeitsweise), desto besser die Mails."),
      f.auto_classify)),
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Firmen beobachten & Qualität")), h("div", { class: "card-body form-grid" },
      field("Erneut prüfen nach (Tagen)", f.watch_interval_days, "Passende Firmen ohne Anlass werden in diesem Abstand neu recherchiert (neue Stellen, Standorte, Führung …)."),
      field("Recherchen pro Tag (automatisch)", f.watch_daily_limit, "Jede Recherche ist eine KI-Anfrage aus dem Max-Abo. 0 = keine automatische Beobachtung."),
      field("Antwortziel bei Interesse (Minuten)", f.reply_sla_minutes, "Positive Antworten stehen in „Heute“ ganz oben; ab dieser Zeit rot markiert."),
      field("Creepy-Grenze (0–100)", f.creepy_threshold, "KI-Texte, die aufdringlich oder überwachend wirken, werden darüber nicht verschickt (dann geht die freigegebene Vorlage raus)."))),
    h("div", { class: "row" }, h("div", { class: "grow" }), h("button", { class: "btn btn-primary", disabled: !isAdmin, onclick: e => busy(e.currentTarget, () => save({
      sender_context: f.sender_context.value, ai_daily_limit: Number(f.ai_daily_limit.value), auto_classify: f.auto_classify.input.checked,
      watch_interval_days: Number(f.watch_interval_days.value), watch_daily_limit: Number(f.watch_daily_limit.value), reply_sla_minutes: Number(f.reply_sla_minutes.value), creepy_threshold: Number(f.creepy_threshold.value)
    })) }, "Speichern"))));
}

function drawWebhook(body, s, save, isAdmin) {
  const url = input({ value: s.webhook_url, placeholder: "https://… (CRM, Sales App, n8n, Make, Zapier)" });
  const secret = input({ value: s.webhook_secret, placeholder: "Geheimnis für die Signatur" });
  const chosen = new Set(s.webhook_events || []);
  const boxes = Object.entries(EVENTS).map(([k, label]) => checkbox(label, chosen.has(k), k, { value: k }));
  clear(body, h("div", { class: "stack" },
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Webhook")), h("div", { class: "card-body stack" },
      h("div", { class: "hint" }, "Bei jedem Ereignis wird ein POST mit JSON { event, sentAt, data } gesendet. Signatur im Header X-Coldmail-Signature: sha256=HMAC(Body, Geheimnis)."),
      field("URL", url), field("Geheimnis", secret), h("div", { class: "stack-sm" }, h("span", { class: "label" }, "Ereignisse"), boxes))),
    h("div", { class: "row" }, h("button", { class: "btn", onclick: e => busy(e.currentTarget, async () => { const r = await api("/api/settings/test-webhook", { method: "POST" }); toast(r.ok ? `Test erfolgreich (HTTP ${r.status})` : `Test fehlgeschlagen: ${r.error}`, r.ok ? "info" : "error"); }) }, "Test senden"), h("div", { class: "grow" }),
      h("button", { class: "btn btn-primary", disabled: !isAdmin, onclick: e => busy(e.currentTarget, () => save({ webhook_url: url.value, webhook_secret: secret.value, webhook_events: boxes.filter(b => b.input.checked).map(b => b.input.value) })) }, "Speichern"))));
}

async function drawUsers(body, isAdmin) {
  const pw = { current: input({ type: "password", autocomplete: "current-password" }), next: input({ type: "password", autocomplete: "new-password" }) };
  const own = h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Eigenes Passwort ändern")), h("div", { class: "card-body form-grid" },
    field("Aktuelles Passwort", pw.current), field("Neues Passwort (mind. 12 Zeichen)", pw.next),
    h("div", null, h("button", { class: "btn", onclick: e => busy(e.currentTarget, async () => { await api("/api/me/password", { method: "POST", body: { current: pw.current.value, password: pw.next.value } }); pw.current.value = pw.next.value = ""; toast("Passwort geändert"); }) }, "Ändern"))));
  if (!isAdmin) return clear(body, own);
  const users = await api("/api/users");
  const reload = () => drawUsers(body, isAdmin);
  clear(body, h("div", { class: "stack" },
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Benutzer"), h("div", { class: "actions" }, h("button", { class: "btn btn-sm btn-primary", onclick: () => userForm(null, reload) }, icon("plus"), "Benutzer"))),
      h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "E-Mail"), h("th", null, "Rolle"), h("th", null, "Letzte Anmeldung"), h("th", null, ""))),
        h("tbody", null, users.map(u => h("tr", null, h("td", { class: "strong" }, u.name || "–"), h("td", null, u.email), h("td", null, u.role === "admin" ? "Administrator" : "Mitarbeiter"), h("td", { class: "small muted" }, u.last_login_at ? relTime(u.last_login_at) : "nie"),
          h("td", { class: "right nowrap" }, h("button", { class: "btn btn-sm btn-ghost", onclick: () => userForm(u, reload) }, "Bearbeiten"),
            u.id !== state.user.id ? h("button", { class: "btn btn-sm btn-ghost btn-danger", onclick: e => busy(e.currentTarget, async () => { if (!(await confirmDialog(`${u.email} löschen?`, { danger: true, confirm: "Löschen" }))) return; await api(`/api/users/${u.id}`, { method: "DELETE" }); reload(); }) }, icon("trash")) : null))))))),
    own));
}

function userForm(u, done) {
  const f = { name: input({ value: u?.name || "" }), email: input({ type: "email", value: u?.email || "", disabled: !!u }), role: select([["member", "Mitarbeiter"], ["admin", "Administrator"]], u?.role || "member"), password: input({ type: "password", autocomplete: "new-password", placeholder: u ? "leer = unverändert" : "mind. 12 Zeichen" }) };
  const dlg = modal({
    title: u ? "Benutzer bearbeiten" : "Benutzer anlegen",
    body: h("div", { class: "form-grid" }, field("Name", f.name), field("E-Mail", f.email), field("Rolle", f.role, "Administratoren können Einstellungen und Benutzer verwalten."), field("Passwort", f.password)),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const body = { name: f.name.value, role: f.role.value, password: f.password.value || undefined };
      if (!u) body.email = f.email.value;
      await api(u ? `/api/users/${u.id}` : "/api/users", { method: u ? "PUT" : "POST", body });
      dlg.close(); done();
    }) }, "Speichern")]
  });
}

async function drawSystem(body, isAdmin) {
  const sys = await api("/api/system");
  const row = (k, v) => [h("dt", null, k), h("dd", null, v)];
  clear(body, h("div", { class: "stack" },
    h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Status")), h("div", { class: "card-body" }, h("dl", { class: "kv" },
      row("Version", sys.version), row("App-URL", sys.app_url), row("Tracking-URL", sys.tracking_url), row("Zeitzone", sys.timezone),
      row("Versand-Takt", `${sys.scheduler.workers ? "aktiv" : "deaktiviert"} · alle ${Math.round(sys.scheduler.interval_ms / 1000)} s · letzter Lauf ${relTime(sys.scheduler.lastTickAt)}${sys.scheduler.lastError ? ` · Fehler: ${sys.scheduler.lastError}` : ""}`),
      row("IMAP-Abgleich", `alle ${Math.round(sys.sync.interval_ms / 60000)} Min. · letzter Lauf ${relTime(sys.sync.lastRunAt)}${sys.sync.lastError ? ` · ${sys.sync.lastError}` : ""}`),
      row("KI", sys.ai.available ? `${sys.ai.model} · ${sys.ai.provider === "subscription" ? "Claude-Max-Abo" : "Anthropic-API"}` : "nicht eingerichtet"),
      row("Datenbank", `${num(sys.db.leads)} Leads · ${num(sys.db.messages)} Nachrichten · ${num(sys.db.events)} Ereignisse`)))),
    isAdmin ? h("div", { class: "row" },
      h("button", { class: "btn", onclick: e => busy(e.currentTarget, async () => { const r = await api("/api/system/run", { method: "POST", body: { job: "send" } }); toast(r.skipped ? "Versand läuft bereits" : `${r.sent} Mails gesendet`); drawSystem(body, isAdmin); }) }, icon("send"), "Versand-Takt jetzt ausführen"),
      h("button", { class: "btn", onclick: e => busy(e.currentTarget, async () => { await api("/api/system/run", { method: "POST", body: { job: "sync" } }); toast("Abgleich fertig"); drawSystem(body, isAdmin); }) }, icon("refresh"), "Postfächer jetzt abgleichen")) : null,
    h("div", { class: "small muted" }, `Stand: ${dateTime(Date.now())}`)));
}

function drawLegal(body) {
  clear(body, h("div", { class: "stack" },
    h("div", { class: "alert warn" }, h("div", { class: "text-body" },
      h("strong", null, "Wichtig – keine Rechtsberatung. "),
      "E-Mail-Werbung braucht in Deutschland nach § 7 Abs. 2 Nr. 2 UWG eine vorherige ausdrückliche Einwilligung – auch gegenüber Firmen. Ausnahme: Bestandskunden nach § 7 Abs. 3 UWG. Für B2B-Anrufe genügt eine mutmaßliche Einwilligung (konkreter Anlass). Details und der empfohlene Ablauf stehen in den ",
      h("a", { href: "#/richtlinien" }, "Richtlinien"), ".")),
    h("div", { class: "card card-pad stack-sm" },
      h("h3", null, "Was die App für euch erledigt"),
      h("ul", { style: { margin: 0, paddingLeft: "18px" } },
        h("li", null, "Einwilligung je Lead mit Quelle und Datum; Kampagnen mit Rechtsgrundlage „Einwilligung“ schreiben nur solche Kontakte an."),
        h("li", null, "Texte müssen freigegeben werden; der Rechts-Check vor dem Start blockiert fehlendes Impressum, fehlende Abmeldung, Tracking ohne Einwilligung und irreführende Betreffs."),
        h("li", null, "Abmelde-Link + One-Click-Abmeldung (RFC 8058) und sofortige Sperre über alle Kampagnen; „bitte keine Mails mehr“ in Antworten wird erkannt."),
        h("li", null, "Sperrfristen nach „kein Interesse“, zwischen Kampagnen und je Firma (Einstellungen → Kontaktregeln)."),
        h("li", null, "Datenquelle je Lead (Art. 14 DSGVO) beim Import erfassbar; vollständige Löschung eines Leads (Art. 17 DSGVO) – die Adresse bleibt nur auf der Sperrliste."),
        h("li", null, "Alle Daten liegen auf eurem eigenen Server. Für KI-Funktionen werden Lead-Daten und Gesprächsinhalte an Anthropic (Claude) übermittelt – bitte im Verzeichnis der Verarbeitungstätigkeiten und in der Datenschutzerklärung berücksichtigen.")))));
}
