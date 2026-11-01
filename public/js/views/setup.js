// Einrichtung: Schritt für Schritt von den Versand-Domains bis zur ersten Kampagne – alles in der eigenen App,
// mit Live-Prüfung (DNS, Postfächer, Warmup, Signaturen, Kampagnen-Einstellungen, Start-Bereitschaft).
import { h, clear, api, icon, busy, toast, modal, field, input, textarea, select, checkbox, num, dateTime, skeletonRows, state, aiMissingText } from "../lib.js";

const MARK = { ok: ["✓", "ok"], warn: ["!", "warn"], bad: ["✕", "danger"], todo: ["○", ""] };
const STEP_LABEL = { ok: "erledigt", warn: "teilweise", bad: "Problem", todo: "offen" };

export async function render(el) {
  clear(el, head(), h("div", { class: "content" }, skeletonRows(6)));
  draw(el, await api("/api/setup"));
}

function head() {
  return h("div", { class: "page-head" }, h("h1", null, "Einrichtung"), h("span", { class: "sub" }, "Von den Versand-Domains bis zur ersten Kampagne – alles in der App, ohne Zusatz-Tools"));
}

const isAdmin = () => state.user?.role === "admin";
const checkList = checks => h("div", { class: "setup-checks" }, checks.map(c => h("div", { class: ["setup-check", c.status] },
  h("span", { class: ["mark", MARK[c.status][1]] }, MARK[c.status][0]),
  h("div", { class: "grow" }, h("div", { class: "strong" }, c.label), c.detail ? h("div", { class: "small muted" }, c.detail) : null),
  c.link ? h("a", { class: "btn btn-sm btn-ghost", href: c.link }, "Öffnen") : null)));

function draw(el, s) {
  const reload = async next => draw(el, next || await api("/api/setup"));
  const stepCard = (n, step, ...content) => h("details", { class: "card setup-step", open: step.status !== "ok" },
    h("summary", { class: "card-head" }, h("span", { class: ["step-no", step.status] }, step.status === "ok" ? "✓" : String(n)), h("h2", { class: "grow" }, step.title), h("span", { class: ["badge", MARK[step.status][1]] }, STEP_LABEL[step.status])),
    h("div", { class: "card-body stack" }, checkList(step.checks), ...content));
  const [s1, s2, s3, s4, s5] = s.steps;
  clear(el, head(),
    h("div", { class: "content stack" },
      h("div", { class: "setup-progress" }, s.steps.map((st, i) => h("a", { href: `#step-${st.key}`, class: ["setup-pill", st.status], onclick: e => { e.preventDefault(); el.querySelector(`#step-${st.key}`)?.scrollIntoView({ behavior: "smooth" }); } }, h("b", null, st.status === "ok" ? "✓" : i + 1), st.title))),
      modeSwitch(s, reload),
      s.mode === "main" ? h("div", { class: "kpis" },
        tile("Versand-Domain", s.main_domain || "–", "Hauptdomain, kein Domainkauf", true),
        tile("Postfächer", String(s.mailboxes.length), "1–2 reichen"),
        tile("Heute möglich", `${num(s.capacity.today)} Mails`, s.capacity.per_day ? `steigt je Postfach um 3/Tag bis ${num(s.capacity.per_day)}` : "nach dem Verbinden des Postfachs"),
        tile("Start", s.mailboxes.length ? "sofort" : "–", "sanft, ohne 14 Tage Warten"),
        tile("Kosten", "0 €", "keine Domains, keine Zusatz-Tools"))
      : h("div", { class: "kpis" },
        tile("Versand-Domains", `${s.domains.filter(d => !d.is_main).length} / 5`),
        tile("Postfächer", `${s.mailboxes.length} / 10`, "2 je Domain"),
        tile("Kapazität", `${num(s.capacity.per_day)} / Tag`, `${s.capacity.mailboxes} aktive Postfächer`),
        tile("Warmup bereit", s.warmup_ready_at ? dateTime(s.warmup_ready_at).slice(0, 8) : s.mailboxes.length && s.mailboxes.every(m => m.warmup_ready) ? "jetzt" : "–", "14 Tage Minimum"),
        tile("Tool-Kosten", "0 €", "eigene App statt Zapmail + Instantly")),
      h("div", { id: "step-domains" }, stepCard(1, s1, domainsSection(s, reload))),
      h("div", { id: "step-mailboxes" }, stepCard(2, s2, mailboxesSection(s, reload))),
      h("div", { id: "step-warmup" }, stepCard(3, s3, warmupSection(s, reload))),
      h("div", { id: "step-campaign" }, stepCard(4, s4, campaignSection(s))),
      h("div", { id: "step-launch" }, stepCard(5, s5, launchSection(s))),
      troubleshooting(),
      askBox(),
      h("div", { class: "hint" }, s.costs.note)));
}

// Weg wählen: eigene Hauptdomain (schnell, klein) oder separate Versand-Domains (Leitfaden, viel Menge).
function modeSwitch(s, reload) {
  const opt = (key, title, text) => h("button", { type: "button", class: ["card", "card-pad", "setup-mode", s.mode === key ? "active" : ""], disabled: !isAdmin() || s.mode === key,
    onclick: e => busy(e.currentTarget, async () => { reload(await api("/api/setup", { method: "PUT", body: { setup_mode: key } })); toast("Weg umgestellt"); }) },
    h("div", { class: "row-tight" }, h("span", { class: ["mark", s.mode === key ? "ok" : ""] }, s.mode === key ? "●" : "○"), h("strong", null, title)), h("div", { class: "small muted" }, text));
  return h("div", { class: "grid-2" },
    opt("main", "Über meine Hauptdomain", "Kein Domainkauf, gern ein Postfach je Projekt, Start sofort mit sanftem Hochfahren. Alle zusammen höchstens 60 Mails am Tag."),
    opt("separate", "Separate Versand-Domains", "5 Domains nur für die Akquise, 10 Postfächer, 14 Tage Warmup. Für viel Menge (300 Mails am Tag) und Schutz der Hauptdomain."));
}

const tile = (label, value, meta, small = false) => h("div", { class: "card kpi" }, h("div", { class: "label" }, label), h("div", { class: "value", style: small ? { fontSize: "17px", overflowWrap: "anywhere" } : null }, value), meta ? h("div", { class: "meta" }, meta) : null);

// ---------- Schritt 1: Domains ----------
function domainsSection(s, reload) {
  const mainMode = s.mode === "main";
  const main = input({ value: s.main_domain, placeholder: "z. B. musterfirma.de" });
  const company = input({ value: s.company_name || "" });
  const planned = textarea({ rows: 5, value: s.planned_domains.join("\n"), placeholder: "eine Domain pro Zeile, z. B.\ngetmusterfirma.com\nmusterfirmateam.com" });
  const save = () => api("/api/setup", { method: "PUT", body: { main_domain: main.value, company_name: company.value, ...(mainMode ? {} : { domains: planned.value }) } });
  const sending = s.domains.filter(d => (mainMode ? d.is_main : !d.is_main));
  return h("div", { class: "stack" },
    mainMode ? h("div", { class: "guide small" },
      h("p", null, "Du versendest über deine eigene Domain. ", h("strong", null, "Rechtlich ändert das nichts"), ": Ob eine Mail abmahnfähig ist, hängt an der Einwilligung, nicht an der Domain. Das Impressum muss so oder so drinstehen."),
      h("p", null, "Der Unterschied ist technisch: Akquise und normale Geschäftspost teilen sich den Ruf der Domain. Häufen sich Spam-Beschwerden, landen auch Angebote und Rechnungen eher im Spam. Darum: ", h("strong", null, "kleine Menge"), " (bis ~30 je Postfach, ~60 am Tag), geprüfte Listen, Abmeldungen sofort. Wer später deutlich mehr verschicken will, stellt oben auf separate Domains um.")) :
    h("div", { class: "guide small" }, h("p", null, "Die Hauptdomain ist euer wertvollstes Asset – landet sie auf einer Blockliste, funktioniert die ganze Firmen-Mail nicht mehr. Deshalb ", h("strong", null, "5 eigene Domains nur für die Akquise"), ". „Verbrennt“ eine, wird sie ersetzt. Nah am Firmennamen, Endung .com (sonst .de/.net/.info, nie .xyz/.biz), ", h("strong", null, "keine Website und keine Weiterleitung"), " auf die Hauptdomain. Kaufen beim Registrar oder im vorhandenen Hosting-Paket (z. B. ALL-INKL KAS) – Upsells ignorieren.")),
    h("div", { class: "grid-2" }, field(mainMode ? "Hauptdomain (Versand-Domain)" : "Hauptdomain (wird nie für Akquise genutzt)", main), field(mainMode ? "Firmenname (für Signaturen)" : "Firmenname (für Namensvorschläge)", company)),
    mainMode ? null : field("Gekaufte / geplante Versand-Domains", planned, "Domains mit Postfächern werden automatisch erkannt."),
    !mainMode && s.suggestions.length ? h("div", null, h("div", { class: "small muted", style: { marginBottom: "6px" } }, "Vorschläge (Verfügbarkeit beim Registrar prüfen):"),
      h("div", { class: "chips" }, s.suggestions.slice(0, 16).map(d => h("button", { type: "button", class: "chip", onclick: () => { planned.value = [...new Set([...planned.value.split(/\s+/).filter(Boolean), d])].join("\n"); } }, d)))) : null,
    h("div", { class: "row" }, h("div", { class: "grow" }), h("button", { class: "btn btn-primary", disabled: !isAdmin(), onclick: e => busy(e.currentTarget, async () => { reload(await save()); toast("Gespeichert"); }) }, "Speichern")),
    sending.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "Domain"), h("th", null, "Endung"), h("th", { class: "num" }, "Postfächer"), h("th", null, "DNS (SPF/DKIM/DMARC)"), mainMode ? null : h("th", null, "Website"), h("th", null, ""))),
      h("tbody", null, sending.map(d => h("tr", null,
        h("td", { class: "strong" }, d.domain, d.near_company || mainMode ? null : h("div", { class: "small muted" }, "weit weg vom Firmennamen")),
        h("td", null, h("span", { class: ["badge", d.tld_level === "ok" ? "ok" : d.tld_level === "bad" ? "danger" : "warn"] }, `.${d.tld}`)),
        h("td", { class: "num" }, mainMode ? String(d.mailboxes.length) : h("span", { class: d.mailboxes.length >= 2 ? "" : "danger-text" }, `${d.mailboxes.length} / 2`)),
        h("td", null, d.dns ? h("span", { class: ["badge", !d.dns.errors && !d.dns.warnings ? "ok" : d.dns.errors ? "danger" : "warn"] }, `${d.dns.score} %`) : h("span", { class: "small muted" }, "nicht geprüft"),
          d.dns ? h("details", { class: "small" }, h("summary", null, "Details"), h("div", { class: "stack-sm", style: { marginTop: "6px" } }, d.dns.checks.map(c => h("div", null, h("strong", null, `${c.label}: `), c.detail, c.fix ? h("div", { class: "muted" }, `→ ${c.fix}`) : null)),
            d.dns.checks.some(c => c.key === "dkim" && c.status !== "ok") ? dkimSelector(d.domain, reload) : null)) : null),
        mainMode ? null : h("td", { class: "small" }, !d.web ? h("span", { class: "muted" }, "–") : d.web.redirects_to_main ? h("span", { class: "danger-text" }, "leitet auf Hauptdomain weiter") : d.web.redirect ? `Weiterleitung → ${d.web.redirect}` : d.web.page ? h("span", { class: "muted" }, "Seite vorhanden") : "keine Website ✓"),
        h("td", null, h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => { await api("/api/setup/check-domain", { method: "POST", body: { domain: d.domain } }); reload(); }) }, icon("refresh"), "Prüfen"))))))) : null,
    h("details", { class: "small" }, h("summary", null, "DNS-Einträge bei ALL-INKL (KAS) setzen"),
      h("ul", { class: "guide" },
        h("li", null, "SPF: KAS → Tools → DNS-Einstellungen. ALL-INKL legt meist schon einen SPF-Eintrag an – sonst den Wert aus der KAS-Hilfe übernehmen (in der Regel mit ", h("code", null, "include:spf.kasserver.com"), " und ", h("code", null, "~all"), "). Nur ein SPF-Eintrag pro Domain."),
        h("li", null, "DKIM: im KAS bei der Domain DKIM aktivieren. Gängige Selektoren erkennt der Check selbst; sonst den Selektor aus dem KAS (oder aus „DKIM-Signature: s=…“ im Header einer gesendeten Mail) bei den DNS-Details eintragen."),
        h("li", null, "DMARC: TXT auf ", h("code", null, "_dmarc.<domain>"), ": ", h("code", null, "v=DMARC1; p=none; rua=mailto:dmarc@<domain>")),
        h("li", null, "Änderungen brauchen 30 Min. bis 48 Std. – danach hier „Prüfen“."))));
}

// Eigener DKIM-Selektor (z. B. ALL-INKL „kas2024…“), wenn die gängigen nicht passen.
function dkimSelector(domain, reload) {
  const sel = input({ placeholder: "DKIM-Selektor, z. B. kas2024…", class: "input input-sm", style: { maxWidth: "220px" } });
  return h("div", { class: "row-tight" }, sel, h("button", { class: "btn btn-sm", onclick: e => busy(e.currentTarget, async () => {
    if (!sel.value.trim()) throw new Error("Selektor eintragen");
    await api("/api/setup/check-domain", { method: "POST", body: { domain, selector: sel.value.trim() } }); reload();
  }) }, "Mit Selektor prüfen"));
}

// ---------- Schritt 2: Postfächer ----------
function mailboxesSection(s, reload) {
  return h("div", { class: "stack" },
    s.mode === "main" ? h("div", { class: "guide small" }, h("p", null, h("strong", null, "Ein neues Postfach reicht"), ", mit deinem Namen (z. B. ", h("code", null, "max@"), " oder ", h("code", null, "l.kummer@"), "), keine ", h("code", null, "info@"), "/", h("code", null, "sales@"), ". Ein eigenes Postfach für die Akquise hält dein normales Postfach sauber. Ein zweites bringt nur wenig mehr Menge, weil der Ruf an der Domain hängt, nicht am Postfach. Im Hosting anlegen (KAS → E-Mail → Postfach) und hier verbinden. IMAP ist Pflicht, sonst erkennt die App keine Antworten.")) :
    h("div", { class: "guide small" }, h("p", null, h("strong", null, "2 Postfächer je Domain"), " mit echten Namen (", h("code", null, "v.nachname@"), ", ", h("code", null, "vorname@"), ") – keine ", h("code", null, "info@"), "/", h("code", null, "sales@"), ". Klarnamen wirken persönlich, Funktionsadressen wie Massenmail. Im Hosting-Paket anlegen (KAS → E-Mail → Postfach), dann hier verbinden. IMAP ist Pflicht: Nur so werden Antworten erkannt und das Warmup funktioniert.")),
    h("div", { class: "row" },
      h("button", { class: "btn btn-primary", disabled: !isAdmin(), onclick: () => bulkMailboxes(s, reload) }, icon("plus"), s.mode === "main" ? "Postfach verbinden" : "Mehrere Postfächer verbinden"),
      h("a", { class: "btn", href: "#/postfaecher" }, "Einzeln verwalten")),
    s.mailboxes.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "Postfach"), h("th", null, "Name"), h("th", null, "Status"), h("th", null, "IMAP"))),
      h("tbody", null, s.mailboxes.map(m => h("tr", null,
        h("td", null, h("span", { class: "strong" }, m.email), m.name_ok ? null : h("div", { class: "small danger-text" }, "Funktionsadresse – besser Klarname")),
        h("td", null, m.from_name || h("span", { class: "danger-text small" }, "fehlt")),
        h("td", null, m.last_error ? h("span", { class: "badge danger", title: m.last_error }, "Fehler") : h("span", { class: ["badge", m.status === "active" ? "ok" : "warn"] }, m.status === "active" ? "aktiv" : m.status)),
        h("td", null, m.imap ? "✓" : h("span", { class: "danger-text" }, "fehlt"))))))) : null);
}

function bulkMailboxes(s, reload) {
  const presets = { allinkl: "ALL-INKL (KAS)", ionos: "IONOS", strato: "STRATO", google: "Google Workspace (App-Passwort)", hetzner: "Hetzner", zoho: "Zoho (EU)", microsoft: "Microsoft 365 (nur mit SMTP AUTH)", custom: "Eigener Server" };
  const provider = select(Object.entries(presets), "allinkl");
  const host = input({ placeholder: "w0123456.kasserver.com" });
  const hostField = field("Server (SMTP + IMAP)", host, "ALL-INKL: steht im KAS unter E-Mail → Postfach (wXXXXXXX.kasserver.com).");
  const toggle = () => { hostField.hidden = !["allinkl", "custom"].includes(provider.value); };
  provider.addEventListener("change", toggle); toggle();
  const first = input({ placeholder: "Max" }), last = input({ placeholder: "Mustermann" });
  const lines = textarea({ rows: 8, class: "textarea code", placeholder: "E-Mail;Passwort;Vorname Nachname – eine Zeile je Postfach\nm.mustermann@getmusterfirma.com;geheim;Max Mustermann\nmax@getmusterfirma.com;geheim;Max Mustermann" });
  const position = input({ placeholder: "z. B. Geschäftsführer" });
  const mainMode = s.mode === "main";
  const warm = mainMode ? checkbox("Warmup zusätzlich einschalten", s.mailboxes.length >= 1, "Wirkt erst ab 2 Postfächern. Starten kannst du trotzdem sofort – das sanfte Hochfahren (5, dann +3 pro Tag) läuft immer.")
    : checkbox("Warmup sofort einschalten", true, "Erste Kampagne frühestens nach 14 Tagen.");
  const limit = input({ type: "number", min: 1, max: 200, value: 30 });
  const sending = mainMode ? (s.main_domain ? [s.main_domain] : []) : s.domains.filter(d => !d.is_main).map(d => d.domain);
  const gen = h("button", { type: "button", class: "btn btn-sm", onclick: () => {
    const f = first.value.trim(), l = last.value.trim();
    if (!f || !l || !sending.length) { toast("Vor- und Nachname eintragen und in Schritt 1 Domains speichern", "error"); return; }
    const norm = x => x.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]/g, "");
    lines.value = mainMode ? `${norm(f)}@${sending[0]};;${f} ${l}` : sending.flatMap(d => [`${norm(f)[0]}.${norm(l)}@${d};;${f} ${l}`, `${norm(f)}@${d};;${f} ${l}`]).join("\n");
  } }, mainMode ? "Zeile erzeugen" : "Zeilen aus Domains erzeugen (2 je Domain)");
  const out = h("div");
  const dlg = modal({
    title: mainMode ? "Postfach verbinden" : "Mehrere Postfächer verbinden", wide: true,
    body: h("div", { class: "stack" },
      h("div", { class: "grid-2" }, field("Anbieter", provider), hostField),
      h("div", { class: "grid-2" }, field("Vorname", first), field("Nachname", last)), gen,
      field("Postfächer", lines, "Passwort nach dem zweiten Semikolon eintragen. Die Postfächer müssen beim Anbieter bereits angelegt sein."),
      h("div", { class: "grid-2" }, field("Position (für die Signatur)", position), field("Tageslimit je Postfach", limit, mainMode ? "Empfehlung 30 – mehr nicht über die Hauptdomain" : "Empfehlung 30 – 10 Postfächer × 30 = 300 Mails/Tag")),
      warm, out),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Schließen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const rows = lines.value.split("\n").map(x => x.trim()).filter(Boolean).map(x => { const [email, password, name] = x.split(";"); return { email: (email || "").trim(), password: (password || "").trim(), from_name: (name || "").trim() }; });
      if (!rows.length) throw new Error("Keine Zeilen");
      const missing = rows.filter(r => !r.password);
      if (missing.length) throw new Error(`Passwort fehlt bei ${missing.map(r => r.email).join(", ")}`);
      const preset = { provider: provider.value, ...(["allinkl", "custom"].includes(provider.value) ? { smtp_host: host.value.trim(), imap_host: host.value.trim() } : {}) };
      if (["allinkl", "custom"].includes(provider.value) && !host.value.trim()) throw new Error("Server eintragen");
      const r = await api("/api/setup/mailboxes", { method: "POST", body: { preset, rows, position: position.value, warmup: warm.input.checked, daily_limit: Number(limit.value) } });
      clear(out, h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", null, "Postfach"), h("th", null, "Ergebnis"))),
        h("tbody", null, r.results.map(x => h("tr", null, h("td", null, x.email), h("td", null, !x.ok ? h("span", { class: "danger-text" }, x.error) : x.error ? h("span", { class: "badge warn", title: x.error }, `angelegt – ${x.error}`) : h("span", { class: "badge ok" }, "verbunden ✓"))))))));
      lines.value = r.results.filter(x => !x.ok).map(x => rows.find(y => y.email === x.email)).filter(Boolean).map(y => `${y.email};${y.password};${y.from_name}`).join("\n");
      toast(`${r.results.filter(x => x.ok).length} von ${r.results.length} angelegt`);
      reload(r.status);
    }) }, "Verbinden & testen")]
  });
}

// ---------- Schritt 3: Warmup & Signaturen ----------
function warmupSection(s, reload) {
  const position = input({ placeholder: "Position, z. B. Geschäftsführer", style: { maxWidth: "260px" } });
  const sigBtn = h("button", { class: "btn", disabled: !isAdmin(), onclick: e => busy(e.currentTarget, async () => { const r = await api("/api/setup/signatures", { method: "POST", body: { position: position.value } }); toast(`${r.changed} Signatur(en) gesetzt`); reload(r.status); }) }, "Fehlende Signaturen setzen");
  if (s.mode === "main") return h("div", { class: "stack" },
    h("div", { class: "guide small" },
      h("p", null, h("strong", null, "Warum sonst 14 Tage?"), " Neue Domains haben noch keinen Ruf. Gmail, Outlook & Co. misstrauen Absendern, die aus dem Nichts viele Mails verschicken. Das Warmup baut diesen Ruf erst auf."),
      h("p", null, "Deine Hauptdomain verschickt schon lange Mails und hat einen Ruf. Deshalb kannst du ", h("strong", null, "sofort starten"), ", nur eben sanft: Tag 1 gehen 5 Mails raus, dann jeden Tag 3 mehr bis 30. Das hält die App automatisch ein, auch wenn die Kampagne mehr erlaubt. Signatur schlank: Grüße, Name, Position – Firma.")),
    h("div", { class: "row" }, position, sigBtn,
      s.mailboxes.length >= 2 ? h("button", { class: "btn", disabled: !isAdmin(), onclick: e => busy(e.currentTarget, async () => { const r = await api("/api/setup/warmup-all", { method: "POST" }); toast(`Warmup bei ${r.changed} Postfach/Postfächern eingeschaltet`); reload(r.status); }) }, icon("flame"), "Warmup zusätzlich einschalten") : null),
    s.mailboxes.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "Postfach"), h("th", { class: "num" }, "Heute"), h("th", null, "Volles Limit"), h("th", null, "Signatur"))),
      h("tbody", null, s.mailboxes.map(m => h("tr", null,
        h("td", { class: "strong" }, m.email),
        h("td", { class: "num" }, `${m.today_limit} Mails`),
        h("td", { class: "small" }, !m.gentle ? h("span", { class: "danger-text" }, `Hochfahren aus oder Limit über 30 – unter „Postfächer“ anpassen`) : m.full_at && m.today_limit < m.daily_limit ? `${m.daily_limit}/Tag ab ${dateTime(m.full_at).slice(0, 8)}` : `${m.daily_limit}/Tag erreicht`),
        h("td", { class: "small" }, m.signature.ok ? "✓ schlank" : h("span", { class: "danger-text" }, m.signature.text))))))) : null);
  return h("div", { class: "stack" },
    h("div", { class: "guide small" }, h("p", null, "Das Warmup schickt automatisch Mails zwischen euren Postfächern, öffnet und beantwortet sie und holt sie aus dem Spam – das baut Reputation auf. ", h("strong", null, "Mindestens 14 Tage vor der ersten Kampagne"), " und danach nicht ausschalten. In der Zeit Listen beschaffen und Texte schreiben. Signatur schlank: Grüße, Name, Position – Firma; keine Banner, Icons oder Award-Listen.")),
    h("div", { class: "row" },
      h("button", { class: "btn btn-primary", disabled: !isAdmin(), onclick: e => busy(e.currentTarget, async () => { const r = await api("/api/setup/warmup-all", { method: "POST" }); toast(`Warmup bei ${r.changed} Postfach/Postfächern eingeschaltet`); reload(r.status); }) }, icon("flame"), "Warmup für alle einschalten"),
      position, sigBtn),
    s.mailboxes.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "Postfach"), h("th", null, "Warmup"), h("th", null, "Fortschritt"), h("th", null, "Signatur"))),
      h("tbody", null, s.mailboxes.map(m => h("tr", null,
        h("td", { class: "strong" }, m.email),
        h("td", null, m.warmup_enabled ? h("span", { class: "badge ok" }, "an") : h("span", { class: "badge warn" }, "aus")),
        h("td", null, h("div", { class: "row-tight" }, h("div", { class: ["bar", m.warmup_ready ? "" : "warn"], style: { width: "120px" } }, h("span", { style: { width: `${Math.min(100, Math.round(m.warmup_days / 14 * 100))}%` } })), h("span", { class: "small muted" }, m.warmup_ready ? "bereit" : `Tag ${m.warmup_days} von 14${m.ready_at ? ` · ab ${dateTime(m.ready_at).slice(0, 8)}` : ""}`))),
        h("td", { class: "small" }, m.signature.ok ? "✓ schlank" : h("span", { class: "danger-text" }, m.signature.text))))))) : null);
}

// ---------- Schritt 4: Kampagne ----------
function campaignSection(s) {
  return h("div", { class: "stack" },
    h("div", { class: "guide small" },
      h("p", null, "Kampagne nach Zielgruppe benennen (z. B. „Sanitär NRW ab 20 MA“). Leads per CSV (Vorname, Nachname, Firma, E-Mail, Website), 20 Stichproben von Hand prüfen, E-Mails prüfen lassen. Im Sequenz-Editor erzeugt ", h("strong", null, "„Standard-Gerüst“"), " die bewährte Struktur: erste Mail mit Einstiegsangebot und A/B-Variante, dann Nachhaken (3 Tage), ein neuer Aspekt (5 Tage), Relevanz-Frage (7 Tage) im selben Thread und eine Abschluss-Mail. Zeitzone Europe/Berlin, Mo–Fr 08–17 Uhr, alle Postfächer zuweisen."),
      s.mode === "main" ? h("p", null, "Über die Hauptdomain: Tageslimit der Kampagne höchstens 60 (bei einem Postfach 30). Das sanfte Hochfahren je Postfach begrenzt die ersten Tage zusätzlich – „Langsam hochfahren“ in der Kampagne ist dafür nicht nötig.") : h("div", { class: "table-wrap" }, h("table", { class: "table", style: { maxWidth: "460px" } },
        h("thead", null, h("tr", null, h("th", null, "Hochfahren"), h("th", { class: "num" }, "Mails pro Tag"))),
        h("tbody", null, [["Woche 1", "100–150"], ["Woche 2", "200–250"], ["ab Woche 3", "300"]].map(([a, b]) => h("tr", null, h("td", null, a), h("td", { class: "num" }, b)))))),
      s.mode === "main" ? null : h("p", { class: "muted" }, "In den Kampagnen-Einstellungen „Langsam hochfahren“ aktivieren – die App hält die Grenzen automatisch ein.")),
    s.campaigns.length ? s.campaigns.map(c => h("div", { class: "card card-pad stack-sm" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, c.name), h("span", { class: "badge" }, c.status), h("a", { class: "btn btn-sm", href: `#/kampagnen/${c.id}/einstellungen` }, "Einstellungen"), h("a", { class: "btn btn-sm", href: `#/kampagnen/${c.id}/sequenz` }, "Sequenz")),
      checkList(c.checks)))
      : h("a", { class: "btn btn-primary", href: "#/produkte" }, icon("plus"), "Vorlage & Kampagne erstellen"),
    h("div", { class: "alert info" }, "Recht in Deutschland: E-Mail-Werbung braucht vorher eine ausdrückliche Einwilligung – auch bei Firmen (§ 7 UWG). Ohne Einwilligung ist sie abmahnfähig; die App erlaubt Kaltakquise nur nach Bestätigung, mit max. 3 Mails und ohne Tracking. Risiko klein halten: nur passende Firmen, wenig Menge, Widerspruch sofort sperren. ", h("a", { href: "#/richtlinien" }, "Richtlinien")));
}

// ---------- Schritt 5: Start & Routine ----------
function launchSection(s) {
  return h("div", { class: "stack" },
    s.campaigns.slice(0, 5).map(c => h("div", { class: "card card-pad stack-sm" },
      h("div", { class: "row" }, h("strong", { class: "grow" }, `Start-Check: ${c.name}`), c.ready_at ? h("span", { class: "small muted" }, `frühestens ${dateTime(c.ready_at).slice(0, 8)}`) : null, h("a", { class: "btn btn-sm btn-primary", href: `#/kampagnen/${c.id}` }, c.status === "active" ? "Läuft" : "Zur Kampagne")),
      checkList(c.launch))),
    h("div", { class: "grid-2" },
      h("div", { class: "guide small" }, h("strong", null, "Täglich"), h("ul", null,
        h("li", null, h("a", { href: "#/" }, "Heute"), " öffnen: positive Antworten zuerst – am selben Tag, Ziel unter 30 Minuten."),
        h("li", null, h("a", { href: "#/unibox" }, "Unibox"), ": ", h("span", { class: "badge ok" }, "Interessiert"), " sofort antworten · ", h("span", { class: "badge danger" }, "Kein Interesse"), " bedanken, erledigt · ", h("span", { class: "badge info" }, "Abwesend / falsche Person"), " nichts tun."),
        h("li", null, "Warme Leads sofort übergeben – ", h("a", { href: "#/leads" }, "Leads → Status „Warm“ → Export"), " (mit Telefonnummer) in die Sales App, dort wird telefoniert."))),
      h("div", { class: "guide small" }, h("strong", null, "Wöchentlich"), h("ul", null,
        h("li", null, h("a", { href: "#/dashboard" }, "Versand-Übersicht"), ": Antwortquote, Bounce-Rate (Ziel < 2 %), Postfach-Gesundheit."),
        h("li", null, h("a", { href: "#/pipeline" }, "Pipeline"), " und ", h("a", { href: "#/lernen" }, "Plays & Lernen"), ": Welche Ansprache bringt Termine und Aufträge?"),
        h("li", null, "Öffnungsraten misst die App bewusst nicht (Tracking nur mit Einwilligung) – Antworten und Termine sind die Kennzahl.")))));
}

function troubleshooting() {
  const item = (q, a) => h("details", null, h("summary", { class: "strong" }, q), h("p", { class: "small", style: { margin: "6px 0 0" } }, a));
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Wenn es hakt")),
    h("div", { class: "card-body stack-sm" },
      item("DNS-Check bleibt rot", "Änderungen brauchen bis zu 48 Stunden (whatsmydns.net). Nur einen SPF-Eintrag pro Domain, DKIM beim Anbieter aktivieren, DMARC-Eintrag auf _dmarc.<domain>. Danach „Prüfen“."),
      item("Postfach verbindet nicht", "Server, Port (465 SSL oder 587 STARTTLS) und Passwort prüfen. Google: 2-Schritt-Verifizierung und App-Passwort. Microsoft 365: SMTP AUTH muss im Tenant erlaubt sein. ALL-INKL: Server wXXXXXXX.kasserver.com, Benutzer = E-Mail-Adresse."),
      item("Warmup-Wert niedrig", "Nicht nervös werden: 14 Tage laufen lassen. Mit mindestens 4–5 Postfächern wird das interne Warmup deutlich wirksamer. Bleibt der Posteingangs-Wert unter 70 %, Tageslimit senken und DNS prüfen."),
      item("Mails landen im Spam / kaum Antworten", "Warmup weiterlaufen lassen, Tageslimit senken, reinen Text ohne Links in der ersten Mail, neue Betreffzeilen testen. Bounce-Rate über 3 %: Liste prüfen. Im schlimmsten Fall Domain ersetzen."),
      item("Kampagne startet nicht", "Der Start-Check oben zeigt den Grund: Texte nicht freigegeben, Rechts-Check (Impressum, Abmeldung), keine Leads mit passender Einwilligung oder Postfach mit Fehler.")));
}

function askBox() {
  const q = textarea({ rows: 2, placeholder: "z. B. „Wie setze ich DKIM bei ALL-INKL?“ oder „Warum ist mein DNS-Check gelb?“" });
  const out = h("div", { class: "markdown" });
  const aiOn = state.meta?.ai_available;
  return h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Setup-Assistent fragen"), h("span", { class: "muted small" }, "kennt den Leitfaden und euren aktuellen Stand")),
    h("div", { class: "card-body stack-sm" }, q,
      h("div", { class: "row" }, h("div", { class: "grow hint" }, aiOn ? "Antwort über das Claude-Max-Abo." : aiMissingText),
        h("button", { class: "btn btn-primary", disabled: !aiOn, onclick: e => busy(e.currentTarget, async () => { out.textContent = (await api("/api/setup/ask", { method: "POST", body: { question: q.value } })).answer; }) }, icon("sparkles"), "Fragen")),
      out));
}
