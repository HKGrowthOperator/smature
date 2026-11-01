// Einrichtungs-Assistent: prüft live, wie weit das technische Setup ist – Versand-Domains, Postfächer (2 je Domain,
// Klarnamen), Warmup (14 Tage) + Signaturen, Kampagnen-Einstellungen und Start-Bereitschaft. Alles läuft über die
// eigene App mit eigenen Postfächern (z. B. ALL-INKL, IONOS, Google Workspace) – keine Kosten für Zusatz-Tools.
// Zwei Wege: „separate“ (Leitfaden: 5 Versand-Domains, Warmup, viel Menge) oder „main“ (Hauptdomain, Postfächer teilen sich 60 Mails/Tag,
// kein Domainkauf, Start sofort mit sanftem Hochfahren je Postfach und kleiner Menge).
import { q, parseJson } from "../db.js";
import { getSettings } from "../settings.js";
import { DAY_MS } from "../lib/time.js";
import { loadSteps } from "../mail/compose.js";
import { approvalState, complianceIssues } from "../engine/rules.js";
import { imapConfigured } from "../mail/imap.js";
import { effectiveDailyLimit, MAIN_PER_MAILBOX, MAIN_PER_DAY } from "../mail/mailboxes.js";

export const WARMUP_DAYS = 14;
export const TARGET_DOMAINS = 5;
export const MAILBOXES_PER_DOMAIN = 2;
export { MAIN_PER_MAILBOX, MAIN_PER_DAY };
export const SETUP_MODES = { separate: "Separate Versand-Domains", main: "Über die Hauptdomain" };
const GOOD_TLDS = new Set(["com", "de", "net", "info", "at", "ch", "eu", "io", "co"]);
const BAD_TLDS = new Set(["xyz", "biz", "top", "click", "online", "site", "live", "shop", "store", "club", "icu", "work", "buzz", "loan", "win", "vip"]);
const ROLE_LOCALS = /^(info|sales|contact|kontakt|office|mail|hello|hallo|team|vertrieb|service|support|noreply|no-reply|admin|marketing|news|newsletter|anfrage|buero|büro)$/i;

const domainOf = email => String(email || "").toLowerCase().split("@")[1] || "";
const tldOf = d => String(d).split(".").pop();
const slug = s => String(s || "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/\b(gmbh|ug|ag|kg|ohg|gbr|mbh|haftungsbeschränkt|haftungsbeschraenkt|e\.?k\.?|co)\b/g, "").replace(/[^a-z0-9]+/g, "");

export function normalizeDomainInput(s) {
  const d = String(s || "").trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:\s]/)[0].replace(/\.$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : "";
}

export function tldLevel(domain) {
  const t = tldOf(domain);
  return BAD_TLDS.has(t) ? "bad" : GOOD_TLDS.has(t) ? "ok" : "warn";
}

// Namensvorschläge wie im Leitfaden: get/try/join/use/go/meet + Firma, Firma + hq/team/group/now/works/hub.
export function domainSuggestions(companyName, mainDomain = "") {
  const base = slug(String(mainDomain || "").split(".")[0]) || slug(companyName);
  if (!base) return [];
  const pre = ["get", "try", "join", "use", "go", "meet"].map(p => `${p}${base}`);
  const suf = ["hq", "team", "group", "now", "works", "hub"].map(x => `${base}${x}`);
  return [...pre, ...suf].flatMap(n => [`${n}.com`, `${n}.de`]).slice(0, 24);
}

export function signatureCheck(sig) {
  const s = String(sig || "").trim();
  if (!s) return { ok: false, text: "keine Signatur" };
  const lines = s.split(/\r?\n/).filter(l => l.trim()).length;
  const links = (s.match(/https?:\/\//gi) || []).length;
  if (/<img|\.(png|jpe?g|gif)\b/i.test(s)) return { ok: false, text: "Bild/Banner in der Signatur" };
  if (lines > 6) return { ok: false, text: `${lines} Zeilen – schlank halten (Name, Position, Firma)` };
  if (links > 1) return { ok: false, text: `${links} Links – höchstens einer` };
  return { ok: true, text: "schlank" };
}

function mailboxRow(mb, now) {
  const local = mb.email.split("@")[0];
  const warmDays = mb.warmup_enabled && mb.warmup_started_at ? Math.floor((now - mb.warmup_started_at) / DAY_MS) : 0;
  const limit = Number(mb.daily_limit) || 0, start = Math.max(1, Number(mb.ramp_start) || 1), step = Number(mb.ramp_step) || 0;
  const rampFrom = mb.ramp_started_at || mb.created_at || now;
  return {
    today_limit: effectiveDailyLimit(mb, now), ramp_enabled: !!mb.ramp_enabled,
    full_at: mb.ramp_enabled && step > 0 && limit > start ? rampFrom + Math.ceil((limit - start) / step) * DAY_MS : null,
    gentle: !!mb.ramp_enabled && start <= 10 && limit <= MAIN_PER_MAILBOX,
    id: mb.id, email: mb.email, from_name: mb.from_name, status: mb.status, last_error: mb.last_error, imap: imapConfigured(mb),
    warmup_enabled: !!mb.warmup_enabled, warmup_days: warmDays, warmup_ready: !!mb.warmup_enabled && warmDays >= WARMUP_DAYS,
    warm_since: mb.warmup_started_at, ready_at: mb.warmup_started_at ? mb.warmup_started_at + WARMUP_DAYS * DAY_MS : null,
    name_ok: !ROLE_LOCALS.test(local), signature: signatureCheck(mb.signature), daily_limit: mb.daily_limit
  };
}

const check = (label, status, detail = "", link = "") => ({ label, status, detail, link });
// DNS gilt erst als erledigt, wenn nichts mehr offen ist – fehlendes DKIM allein soll nicht als „grün“ durchgehen.
const dnsClean = d => !!d.dns && !d.dns.errors && !d.dns.warnings;
const dnsText = d => !d.dns ? `${d.domain}: nicht geprüft – „Prüfen“ klicken`
  : `${d.domain}: ${d.dns.score} %${(d.dns.checks || []).filter(c => c.status !== "ok").map(c => ` – ${c.label} fehlt/prüfen`).join("")}`;
const dayDe = ts => new Date(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
const stepStatus = checks => (checks.some(c => c.status === "bad") ? "bad" : checks.every(c => c.status === "ok") ? "ok" : checks.some(c => c.status === "ok" || c.status === "warn") ? "warn" : "todo");

function campaignChecks(c, activeMailboxes, mbById, now, settings, mode) {
  const steps = loadSteps(c.id);
  const ids = parseJson(c.mailbox_ids, []).map(Number);
  const days = String(c.days || "").split(",").map(Number).filter(Boolean).sort().join(",");
  const cold = c.legal_basis === "cold";
  const out = [];
  out.push(check("Zeitzone", c.timezone === (settings.timezone || "Europe/Berlin") ? "ok" : "warn", c.timezone));
  out.push(check("Versandtage Mo–Fr, Wochenende aus", days === "1,2,3,4,5" ? "ok" : "warn", days ? days.replace("1", "Mo").replace("2", "Di").replace("3", "Mi").replace("4", "Do").replace("5", "Fr").replace("6", "Sa").replace("7", "So") : "–"));
  const startOk = c.window_start >= "07:00" && c.window_start <= "09:00", endOk = c.window_end >= "16:00" && c.window_end <= "18:00";
  out.push(check("Versandzeit 08–17 Uhr", startOk && endOk ? "ok" : "warn", `${c.window_start}–${c.window_end}`));
  const assigned = ids.filter(id => mbById.has(id));
  const todayCap = assigned.reduce((s, id) => s + (mbById.get(id).today_limit || 0), 0);
  if (mode === "main") out.push(check("Menge passend zur Hauptdomain", c.daily_limit <= MAIN_PER_DAY ? "ok" : "warn",
    `${c.daily_limit}/Tag${c.daily_limit > MAIN_PER_DAY ? ` – über die Hauptdomain höchstens ${MAIN_PER_DAY}` : ""}; die Postfächer schaffen heute ${todayCap}, alle Kampagnen über die Hauptdomain teilen sich ${MAIN_PER_DAY}/Tag`));
  else out.push(check("Langsam hochfahren", c.ramp_enabled ? "ok" : c.daily_limit <= 150 ? "ok" : "warn",
    c.ramp_enabled ? `Woche 1: ${c.ramp_week1}, Woche 2: ${c.ramp_week2}, danach ${c.daily_limit}/Tag` : `${c.daily_limit}/Tag${c.daily_limit > 150 ? " – mit 100–150 starten oder „Langsam hochfahren“ aktivieren" : ""}`));
  out.push(check("Alle Postfächer zugewiesen", !assigned.length ? "bad" : assigned.length >= activeMailboxes.length ? "ok" : "warn", `${assigned.length} von ${activeMailboxes.length} aktiven Postfächern`));
  const fuCount = Math.max(0, steps.length - 1);
  const seqOk = cold ? steps.length >= 2 && steps.length <= 3 : steps.length >= 4;
  out.push(check(cold ? "Sequenz (Kaltakquise: max. 3 Mails)" : "Sequenz: Entry + 3 Follow-ups + Break-up", seqOk ? "ok" : steps.length ? "warn" : "bad", `${steps.length ? `${steps.length} Mails (${fuCount} Follow-ups)` : "noch keine Mail"}`));
  const variants = steps[0]?.variants?.filter(v => v.enabled !== false).length || 0;
  out.push(check("A/B-Variante der ersten Mail", variants >= 2 ? "ok" : "warn", variants >= 2 ? `${variants} Varianten` : "nur eine Variante"));
  const delays = steps.slice(1).map(s => Number(s.delay_days));
  const badDelay = delays.filter(d => d < 3 || d > 7);
  out.push(check("Abstand der Follow-ups 3–7 Tage", !delays.length ? "todo" : badDelay.length ? "warn" : "ok", delays.length ? delays.map(d => `${d} T`).join(" · ") : "–"));
  const middle = steps.slice(1, -1).filter(s => s.variants.some(v => String(v.subject || "").trim()));
  out.push(check("Follow-ups im selben Thread (Betreff leer)", !delays.length ? "todo" : middle.length ? "warn" : "ok", middle.length ? `${middle.length} Follow-up(s) mit eigenem Betreff` : "Betreff der ersten Mail wird übernommen"));
  const approval = approvalState(c, steps);
  out.push(check("Texte freigegeben", approval.approved ? "ok" : "bad", approval.approved ? `von ${c.approved_by}` : approval.outdated ? "nach Freigabe geändert" : "noch nicht freigegeben", `#/kampagnen/${c.id}/sequenz`));
  const comp = complianceIssues(c, steps, settings);
  out.push(check("Rechts-Check", comp.errors.length ? "bad" : comp.warnings.length ? "warn" : "ok", comp.errors[0] || comp.warnings[0] || "alles in Ordnung", `#/kampagnen/${c.id}/einstellungen`));

  // Start-Bereitschaft
  const launch = [];
  const notWarm = mode === "main" ? [] : assigned.map(id => mbById.get(id)).filter(m => !m.warmup_ready);
  const readyAt = notWarm.length ? Math.max(...notWarm.map(m => m.ready_at || now + WARMUP_DAYS * DAY_MS)) : null;
  if (mode === "main") {
    const rough = assigned.map(id => mbById.get(id)).filter(m => !m.gentle);
    launch.push(check("Sanfter Start aktiv", !assigned.length ? "todo" : rough.length ? "warn" : "ok",
      !assigned.length ? "–" : rough.length ? `${rough.map(m => m.email).join(", ")}: Hochfahren aus oder Tageslimit über ${MAIN_PER_MAILBOX}` : `Start sofort möglich – heute bis zu ${todayCap} Mails`));
  } else launch.push(check(`Warmup ≥ ${WARMUP_DAYS} Tage`, !assigned.length ? "todo" : notWarm.length ? "warn" : "ok",
    notWarm.length ? `${notWarm.length} Postfach/Postfächer noch nicht so weit – frühestens ${new Date(readyAt).toLocaleDateString("de-DE")}` : "alle zugewiesenen Postfächer"));
  const leads = q.get(`SELECT COUNT(*) AS n, TOTAL(CASE WHEN l.verify_status = 'valid' THEN 1 ELSE 0 END) AS valid, TOTAL(CASE WHEN l.verify_status = 'invalid' THEN 1 ELSE 0 END) AS invalid
    FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id WHERE cl.campaign_id = ?`, c.id);
  launch.push(check("Leads hinzugefügt", leads.n ? "ok" : "todo", `${leads.n} Leads`, `#/kampagnen/${c.id}/leads`));
  const share = leads.n ? Math.round((leads.valid / leads.n) * 100) : 0;
  launch.push(check("E-Mails geprüft", !leads.n ? "todo" : leads.invalid ? "bad" : share >= 90 ? "ok" : "warn", leads.n ? `${share} % gültig${leads.invalid ? `, ${leads.invalid} ungültig` : ""}` : "–", "#/leads"));
  launch.push(check("Abmelde-Link", c.unsubscribe ? "ok" : "bad", c.unsubscribe ? "an" : "aus"));
  launch.push(check("Leads mit fehlenden Variablen überspringen", c.skip_missing_vars ? "ok" : "warn", c.skip_missing_vars ? "keine sichtbaren {{platzhalter}}" : "aus – Fallbacks prüfen"));
  const personal = steps[0]?.variants?.some(v => /\{\{\s*(first_name|vorname|firstname|company|anrede|hallo)\b/i.test(`${v.subject}\n${v.body}`));
  launch.push(check("Persönliche Ansprache (Name/Firma)", personal ? "ok" : "warn", personal ? "Variablen genutzt" : "Tipp: {{first_name}} oder {{company}} im Betreff"));
  launch.push(check("Tracking", c.track_opens || c.track_clicks ? "warn" : "ok", c.track_opens || c.track_clicks ? "an – nur mit Einwilligung, die Tracking umfasst (§ 25 TDDDG)" : "aus (reiner Text, beste Zustellbarkeit; Kennzahl sind Antworten)"));
  return { id: c.id, name: c.name, status: c.status, legal_basis: c.legal_basis, checks: out, launch, ready: [...out, ...launch].every(x => x.status === "ok" || x.status === "warn") && !launch.some(x => x.status === "todo"), ready_at: readyAt };
}

export function setupStatus(now = Date.now()) {
  const settings = getSettings();
  const mode = settings.setup_mode === "main" ? "main" : "separate";
  const main = normalizeDomainInput(settings.main_domain);
  const all = q.all("SELECT * FROM mailboxes ORDER BY email");
  const rows = all.map(mb => mailboxRow(mb, now));
  const mbById = new Map(rows.map(r => [r.id, r]));
  const planned = (Array.isArray(settings.setup_domains) ? settings.setup_domains : []).map(normalizeDomainInput).filter(Boolean);
  const cache = settings.setup_domain_cache && typeof settings.setup_domain_cache === "object" ? settings.setup_domain_cache : {};
  const names = [...new Set([...(mode === "main" && main ? [main] : []), ...planned, ...rows.map(r => domainOf(r.email))])].filter(Boolean);
  const company = slug(settings.company_name);
  const mainLabel = slug(main.split(".")[0]);
  const domains = names.map(d => {
    const mbs = rows.filter(r => domainOf(r.email) === d);
    const c = cache[d] || null;
    return {
      domain: d, planned: planned.includes(d), is_main: !!main && d === main, tld: tldOf(d), tld_level: tldLevel(d),
      near_company: !!(company && slug(d).includes(company.slice(0, 6))) || !!(mainLabel && slug(d).includes(mainLabel)),
      mailboxes: mbs, dns: c?.dns || null, web: c?.web || null, checked_at: c?.checked_at || null
    };
  });
  const sending = domains.filter(d => (mode === "main" ? d.is_main : !d.is_main));
  const active = rows.filter(r => r.status === "active");
  const onMain = rows.filter(r => main && domainOf(r.email) === main);
  const mainDomain = domains.find(d => d.is_main);
  const dnsCheck = list => check("DNS: SPF, DKIM, DMARC", !list.length ? "todo" : list.every(dnsClean) ? "ok" : list.some(d => d.dns && d.dns.errors) ? "bad" : "warn",
    list.map(dnsText).join(" · "));
  const mainCap = onMain.filter(r => r.status === "active").reduce((s, r) => s + (Number(r.daily_limit) || 0), 0);

  const s1 = mode === "main" ? [
    check("Hauptdomain eingetragen", main ? "ok" : "todo", main ? `${main} – Versand über die eigene Domain, kein Domainkauf` : "Hauptdomain eintragen, z. B. musterfirma.de"),
    dnsCheck(mainDomain ? [mainDomain] : []),
    check(`Kleine Menge (höchstens ${MAIN_PER_DAY} Mails/Tag)`, !onMain.length ? "todo" : "ok",
      onMain.length ? `alle Postfächer auf ${main} zusammen höchstens ${MAIN_PER_DAY}/Tag – wird beim Versand automatisch eingehalten${mainCap > MAIN_PER_DAY ? ` (Postfach-Limits zusammen ${mainCap})` : ""}` : "–")
  ] : [
    check(`${TARGET_DOMAINS} eigene Versand-Domains`, sending.length >= TARGET_DOMAINS ? "ok" : sending.length ? "warn" : "todo", `${sending.length} von ${TARGET_DOMAINS}`),
    check("Nicht die Hauptdomain", domains.some(d => d.is_main && d.mailboxes.length) ? "bad" : main ? "ok" : sending.length ? "warn" : "todo", main ? (domains.some(d => d.is_main && d.mailboxes.length) ? `Postfächer auf ${main} – Hauptdomain nie für Cold Mails nutzen` : `Hauptdomain ${main} wird nicht verwendet`) : "Hauptdomain eintragen, damit wir das prüfen können"),
    check("Seriöse Endung (.com, .de …)", sending.some(d => d.tld_level === "bad") ? "bad" : sending.some(d => d.tld_level === "warn") ? "warn" : sending.length ? "ok" : "todo", sending.filter(d => d.tld_level !== "ok").map(d => d.domain).join(", ") || (sending.length ? "alle in Ordnung" : "–")),
    check("Name nah an der Firma", !sending.length ? "todo" : sending.every(d => d.near_company) ? "ok" : "warn", sending.filter(d => !d.near_company).map(d => d.domain).join(", ") || "alle"),
    dnsCheck(sending),
    check("Keine Website/Weiterleitung", !sending.length ? "todo" : sending.some(d => d.web?.redirects_to_main) ? "warn" : sending.every(d => d.web) ? "ok" : "warn",
      sending.filter(d => d.web?.redirects_to_main).map(d => `${d.domain} leitet auf die Hauptdomain weiter`).join(", ") || (sending.every(d => d.web) ? "geprüft" : "noch nicht geprüft"))
  ];
  const perDomain = sending.map(d => d.mailboxes.length);
  const s2 = [
    ...(mode === "main" ? [check("Postfächer auf der Hauptdomain", !onMain.length ? "todo" : onMain.length <= 4 ? "ok" : "warn",
      !onMain.length ? "neues Postfach im Hosting anlegen (z. B. max@…) und hier verbinden" : `${onMain.length} Postfach/Postfächer, teilen sich ${MAIN_PER_DAY} Mails/Tag${onMain.length > 4 ? " – mehr Postfächer bringen keine zusätzliche Menge" : ""}`)] : [
    check(`${MAILBOXES_PER_DOMAIN} Postfächer je Domain`, !sending.length ? "todo" : perDomain.every(n => n >= MAILBOXES_PER_DOMAIN && n <= 3) ? "ok" : perDomain.some(n => n > 3) ? "warn" : "warn",
      sending.map(d => `${d.domain}: ${d.mailboxes.length}`).join(" · ") || "–"),
    check(`${TARGET_DOMAINS * MAILBOXES_PER_DOMAIN} Postfächer insgesamt`, rows.length >= TARGET_DOMAINS * MAILBOXES_PER_DOMAIN ? "ok" : rows.length ? "warn" : "todo", `${rows.length} Postfächer`)]),
    check("Klarnamen statt info@/sales@", !rows.length ? "todo" : rows.every(r => r.name_ok) ? "ok" : "warn", rows.filter(r => !r.name_ok).map(r => r.email).join(", ") || "alle persönlich"),
    check("Absendername gesetzt", !rows.length ? "todo" : rows.every(r => r.from_name) ? "ok" : "warn", rows.filter(r => !r.from_name).map(r => r.email).join(", ") || "alle"),
    check("Verbindung aktiv (SMTP)", !rows.length ? "todo" : rows.some(r => r.status === "error" || r.last_error) ? "bad" : rows.every(r => r.status === "active") ? "ok" : "warn",
      rows.filter(r => r.last_error || r.status !== "active").map(r => `${r.email}: ${r.last_error || r.status}`).join(" · ") || "alle aktiv"),
    check("IMAP für Antworten & Warmup", !rows.length ? "todo" : rows.every(r => r.imap) ? "ok" : "bad", rows.filter(r => !r.imap).map(r => r.email).join(", ") || "alle")
  ];
  const signatures = check("Schlanke Signatur", !rows.length ? "todo" : rows.every(r => r.signature.ok) ? "ok" : "warn", rows.filter(r => !r.signature.ok).map(r => `${r.email}: ${r.signature.text}`).join(" · ") || "alle");
  const s3 = mode === "main" ? [
    check("Sanfter Start: 5 Mails, dann +3 pro Tag", !rows.length ? "todo" : rows.every(r => r.gentle) ? "ok" : "warn",
      rows.map(r => `${r.email}: ${r.gentle ? `heute ${r.today_limit}/Tag${r.full_at && r.today_limit < r.daily_limit ? `, ${r.daily_limit} ab ${dayDe(r.full_at)}` : ""}` : `Hochfahren aus oder Tageslimit über ${MAIN_PER_MAILBOX}`}`).join(" · ") || "–"),
    check("Warmup", !rows.length ? "todo" : active.length < 2 || rows.every(r => r.warmup_enabled) ? "ok" : "warn",
      active.length < 2 ? "mit einem Postfach nicht nötig – die Hauptdomain hat schon einen Ruf, der sanfte Start ersetzt das Aufwärmen" : `${rows.filter(r => r.warmup_enabled).length} von ${rows.length} – läuft zusätzlich zwischen euren Postfächern`),
    signatures
  ] : [
    check("Warmup an allen Postfächern", !rows.length ? "todo" : rows.every(r => r.warmup_enabled) ? "ok" : "warn", `${rows.filter(r => r.warmup_enabled).length} von ${rows.length}`),
    check(`${WARMUP_DAYS} Tage Warmup abgeschlossen`, !rows.length ? "todo" : rows.every(r => r.warmup_ready) ? "ok" : "warn",
      rows.filter(r => !r.warmup_ready).map(r => `${r.email}: ${r.warmup_enabled ? `Tag ${r.warmup_days}` : "aus"}`).join(" · ") || "alle bereit"),
    check("Mindestens 2 Postfächer (Warmup untereinander)", active.length >= 2 ? "ok" : rows.length ? "warn" : "todo", `${active.length} aktiv`),
    signatures
  ];
  const campaigns = q.all("SELECT * FROM campaigns WHERE is_template = 0 AND status != 'completed' ORDER BY status = 'active' DESC, updated_at DESC LIMIT 20")
    .map(c => campaignChecks(c, active, mbById, now, settings, mode));
  const s4 = campaigns.length ? campaigns.flatMap(c => c.checks.filter(x => x.status !== "ok").slice(0, 3).map(x => ({ ...x, label: `${c.name}: ${x.label}` }))) : [check("Kampagne angelegt", "todo", "Kampagne aus einer freigegebenen Vorlage erstellen", "#/kampagnen")];
  if (campaigns.length && !s4.length) s4.push(check("Alle Kampagnen-Einstellungen", "ok", `${campaigns.length} Kampagne(n) geprüft`));
  const live = campaigns.filter(c => c.status === "active");
  const s5 = [
    check("Kampagne gestartet", live.length ? "ok" : "todo", live.map(c => c.name).join(", ") || "noch keine aktiv"),
    ...campaigns.slice(0, 3).flatMap(c => c.launch.filter(x => x.status !== "ok").slice(0, 2).map(x => ({ ...x, label: `${c.name}: ${x.label}` })))
  ];
  const warmReadyAt = mode === "main" ? [] : rows.filter(r => r.warmup_enabled && !r.warmup_ready).map(r => r.ready_at).filter(Boolean);
  const steps = [
    { key: "domains", title: mode === "main" ? "Versand-Domain" : "Versand-Domains", checks: s1 },
    { key: "mailboxes", title: "Postfächer", checks: s2 },
    { key: "warmup", title: mode === "main" ? "Sanfter Start & Signatur" : "Warmup & Signaturen", checks: s3 },
    { key: "campaign", title: "Kampagne vorbereiten", checks: s4 },
    { key: "launch", title: "Start & tägliche Routine", checks: s5 }
  ].map(s => ({ ...s, status: stepStatus(s.checks) }));
  return {
    mode, main_domain: main, company_name: settings.company_name, planned_domains: planned, domains, mailboxes: rows, campaigns, steps,
    suggestions: mode === "main" ? [] : domainSuggestions(settings.company_name, main).filter(d => !names.includes(d)),
    warmup_ready_at: warmReadyAt.length ? Math.max(...warmReadyAt) : null,
    capacity: { mailboxes: active.length, per_day: active.reduce((s, r) => s + (Number(r.daily_limit) || 0), 0), today: active.reduce((s, r) => s + (r.today_limit || 0), 0) },
    costs: { tools_per_month: 0, note: mode === "main"
      ? "0 €: kein Domainkauf, keine Zusatz-Tools. Versand, Unibox und KI laufen in der eigenen App; die KI zählt gegen das Max-Abo."
      : "Versand, Warmup, Unibox und KI laufen in der eigenen App – keine Kosten für Zapmail oder Instantly. Es fallen nur die Domains beim Registrar an (bei vielen Hostern im Paket enthalten); die KI zählt gegen das Max-Abo." }
  };
}
