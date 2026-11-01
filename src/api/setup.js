// API: Einrichtungs-Assistent (Domains, Postfächer, Warmup, Signaturen, Kampagnen-Check, KI-Hilfe).
import { q, insert } from "../db.js";
import { fail, v } from "../http.js";
import { requireAdmin } from "../auth.js";
import { getSettings, saveSettings } from "../settings.js";
import { checkDomain } from "../lib/dns-check.js";
import { probeSite } from "../lib/website.js";
import { setupStatus, normalizeDomainInput, signatureCheck, SETUP_MODES } from "../setup/status.js";
import { readMailbox, testConnection, PROVIDERS } from "./mailboxes.js";
import { getMailbox } from "../mail/mailboxes.js";
import { callJson, aiAvailable } from "../ai/claude.js";

const AI_MISSING = "KI ist nicht eingerichtet (CLAUDE_CODE_OAUTH_TOKEN für das Max-Abo fehlt).";

const GUIDE = `Leitfaden für das technische Setup von Cold-/B2B-Mailing in dieser App (Smature Coldmail, selbst gehostet):
1. Versand-Domains: 5 eigene Domains, nie die Hauptdomain. Name nah an der Firma (get/try/join/use/go/meet + Firma, Firma + hq/team/group/now/works/hub). Endung .com, sonst .de/.net/.info; nie .xyz/.biz. Keine Website und keine 301-Weiterleitung auf die Hauptdomain. Kaufen bei einem Registrar oder im vorhandenen Hosting-Paket (z. B. ALL-INKL KAS, IONOS) ohne Upsells.
2. DNS: SPF (ein Eintrag, ~all/-all), DKIM beim Mail-Anbieter aktivieren (ALL-INKL: KAS → Domain → DKIM; Google Workspace: Admin → Gmail → Authentifizieren), DMARC "_dmarc" mit p=none zum Start. Propagation 30 Min. bis 48 Std. (whatsmydns.net). Der DNS-Check in der App prüft MX, SPF, DKIM, DMARC und Blocklisten.
3. Postfächer: 2 je Domain = 10 Postfächer, Klarnamen (v.nachname@, vorname@), nie info@/sales@. In der App unter Postfächer per SMTP/IMAP verbinden (Vorlagen für ALL-INKL, IONOS, STRATO, Google, Hetzner, Zoho). Microsoft 365 funktioniert nur, wenn SMTP AUTH im Tenant erlaubt ist (OAuth ist nicht eingebaut). Absendername = echter Name. IMAP ist Pflicht (Antworten, Warmup).
4. Warmup: in der App je Postfach einschalten (Warmup zwischen den eigenen Postfächern inkl. Antworten und Rettung aus dem Spam), mindestens 14 Tage vor der ersten Kampagne, danach weiterlaufen lassen. Ramp-up je Postfach ist voreingestellt (Start 5/Tag, +3 täglich, max. 30). Signatur schlank: Grüße, Name, Position – Firma; keine Banner, Icons, Award-Listen.
5. Kampagne: Zeitzone Europe/Berlin, Mo–Fr 08–17 Uhr, Wochenende aus. Start 100–150 Mails/Tag, Woche 2: 200–250, ab Woche 3: 300 („Langsam hochfahren“ in den Kampagnen-Einstellungen). Alle Postfächer zuweisen (Rotation). Sequenz („Standard-Gerüst“ im Sequenz-Editor): erste Mail mit Einstiegsangebot und A/B-Variante (nur eine Sache ändern), dann Nachhaken (3 Tage), ein neuer Aspekt (5 Tage), Relevanz-Frage (7 Tage) im selben Thread mit leerem Betreff, zum Schluss Abschluss-Mail mit eigenem Betreff (7 Tage). Kaltakquise: höchstens 3 Mails. Einstiegsangebot: etwas Konkretes, für das der Empfänger nur antworten muss; Vorschläge per „Einstiegsangebote vorschlagen“ in „Vorlage mit KI erstellen“. Leads per CSV (Vorname, Nachname, Firma, E-Mail, Website), 20 Stichproben prüfen, E-Mails prüfen lassen. Texte müssen freigegeben werden.
6. Recht (Deutschland): E-Mail-Werbung braucht nach § 7 Abs. 2 Nr. 2 UWG eine vorherige ausdrückliche Einwilligung, auch bei Firmen. Ausnahme Bestandskunden (§ 7 Abs. 3 UWG). Kaltakquise per Mail ist abmahnfähig; die App erlaubt sie nur nach ausdrücklicher Bestätigung, max. 3 Mails, nur Firmenadressen, ohne Tracking. B2B-Anrufe sind bei mutmaßlicher Einwilligung (konkreter Anlass) erlaubt – empfohlener Weg: anrufen, Einwilligung für Infos per Mail einholen, dann Einwilligungs-Kampagne. Öffnungs-/Klick-Tracking nur mit Einwilligung (§ 25 TDDDG) – Standard ist aus; Kennzahl sind Antworten und Termine. Impressum, Abmelde-Link und Datenschutz-Link sind Pflicht. Hoster-AGB verbieten unerlaubte Werbung ebenfalls.
7. Start & Routine: Unibox täglich, positive Antworten sofort (Ziel unter 30 Min., „Heute“ zeigt sie zuerst). Interessiert = grün, kein Interesse = rot, Abwesend/falsche Person = blau. Wöchentlich: Antwortquote, Bounce-Rate (< 2 %), Termine. Nachtelefonieren ist der wichtigste Schritt.
Weg „Über die Hauptdomain“ (in der Einrichtung wählbar): kein Domainkauf, Postfächer auf der Geschäftsdomain (auch eins je Projekt, z. B. webseiten@, vertrieb@). Kein 14-Tage-Warmup nötig, weil die Domain schon einen Ruf hat – Start sofort, aber sanft (je Postfach Tag 1: 5 Mails, dann +3 täglich bis 30) und alle Postfächer der Domain zusammen höchstens 60 Mails/Tag – das hält der Versand automatisch ein. Rechtlich ändert die Domain nichts (entscheidend ist die Einwilligung); das Risiko ist technisch: Spam-Beschwerden oder Blocklisten träfen auch die normale Geschäftspost. Darum saubere, geprüfte Listen, Abmeldungen sofort, bei mehr Menge auf separate Domains umsteigen.
Troubleshooting: DNS nicht grün → 48 Std. warten, Einträge prüfen. SMTP-Fehler → Server/Port/Passwort, bei Google App-Passwort. Warmup-Wert niedrig → 14 Tage abwarten, Tageslimit senken. Mails im Spam → Warmup weiterlaufen lassen, Limit senken, Betreff/Text ändern, ggf. neue Domain.`;

function cacheDomain(domain, entry) {
  const s = getSettings();
  const cache = { ...(s.setup_domain_cache && typeof s.setup_domain_cache === "object" ? s.setup_domain_cache : {}) };
  cache[domain] = entry;
  // Nur Domains behalten, die noch geplant sind oder Postfächer haben.
  const keep = new Set([...(s.setup_domains || []), normalizeDomainInput(s.main_domain), ...q.all("SELECT email FROM mailboxes").map(m => m.email.split("@")[1].toLowerCase()), domain]);
  for (const k of Object.keys(cache)) if (!keep.has(k)) delete cache[k];
  saveSettings({ setup_domain_cache: cache });
}

// DNS + Website-Check einer Versand-Domain (Ergebnis wird gemerkt) – auch für die Einrichtung beim Start (bootstrap.js).
export async function checkSetupDomain(domain, selectorInput) {
  // Eigener DKIM-Selektor wird gemerkt, damit spätere Prüfungen ihn wieder nutzen.
  const known = (getSettings().setup_domain_cache || {})[domain]?.selector || "";
  const selector = String(selectorInput ?? known).trim().replace(/[^a-z0-9._-]/gi, "").slice(0, 63);
  const [dns, site] = await Promise.all([checkDomain(domain, { extraSelectors: selector ? [selector] : [] }), probeSite(domain).catch(err => ({ reachable: false, error: err.message }))]);
  const main = normalizeDomainInput(getSettings().main_domain);
  let redirectHost = "";
  try { redirectHost = site.redirect ? new URL(site.redirect).hostname.replace(/^www\./, "") : ""; } catch { /* ungültige Location */ }
  const web = { reachable: !!site.reachable, page: !!site.page, redirect: site.redirect || null, redirects_to_main: !!(main && redirectHost && (redirectHost === main || redirectHost.endsWith(`.${main}`))) };
  const entry = {
    dns: { score: dns.score, errors: dns.checks.filter(c => c.status === "error").length, warnings: dns.checks.filter(c => c.status === "warn").length, checks: dns.checks },
    web, selector, checked_at: Date.now()
  };
  cacheDomain(domain, entry);
  return { domain, ...entry };
}

export function register(r) {
  r.get("/api/setup", () => setupStatus());

  r.put("/api/setup", ({ body, user }) => {
    requireAdmin(user);
    const patch = {};
    if (body.main_domain !== undefined) {
      const d = normalizeDomainInput(body.main_domain);
      if (body.main_domain && !d) fail(400, "Hauptdomain ungültig (z. B. musterfirma.de)");
      patch.main_domain = d;
    }
    if (body.domains !== undefined) {
      const list = (Array.isArray(body.domains) ? body.domains : String(body.domains).split(/[\s,;]+/)).map(normalizeDomainInput).filter(Boolean);
      if (list.length > 50) fail(400, "Maximal 50 Domains");
      patch.setup_domains = [...new Set(list)];
    }
    if (body.company_name !== undefined) patch.company_name = v.str(body.company_name, { max: 200 });
    if (body.setup_mode !== undefined) {
      if (!SETUP_MODES[body.setup_mode]) fail(400, "Unbekannter Weg (separate oder main)");
      patch.setup_mode = body.setup_mode;
    }
    saveSettings(patch);
    return setupStatus();
  });

  // DNS + Website-Check einer Versand-Domain (Ergebnis wird gemerkt).
  r.post("/api/setup/check-domain", async ({ body }) => {
    const domain = normalizeDomainInput(body.domain);
    if (!domain) fail(400, "Ungültige Domain");
    return checkSetupDomain(domain, body.selector);
  });

  // Mehrere Postfächer auf einmal anlegen (z. B. 10 Postfächer bei ALL-INKL) – mit Verbindungstest, Warmup und Signatur.
  r.post("/api/setup/mailboxes", async ({ body, user }) => {
    requireAdmin(user);
    const preset = body.preset || {};
    const provider = v.oneOf(preset.provider || "custom", Object.keys(PROVIDERS), "custom");
    const base = { ...PROVIDERS[provider], ...Object.fromEntries(Object.entries(preset).filter(([, x]) => x !== "" && x !== undefined && x !== null)) };
    const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 50);
    if (!rows.length) fail(400, "Keine Postfächer angegeben");
    const company = getSettings().company_name || "";
    const position = v.str(body.position ?? "", { max: 120 });
    const results = [];
    for (const row of rows) {
      const email = String(row.email || "").trim().toLowerCase();
      try {
        if (q.get("SELECT 1 FROM mailboxes WHERE email = ?", email)) throw new Error("existiert bereits");
        const name = String(row.from_name || "").trim();
        const signature = body.signature !== false && name ? ["Beste Grüße", name, [position, company].filter(Boolean).join(" – ")].filter(Boolean).join("\n") : "";
        const data = readMailbox({
          email, from_name: name, provider, smtp_host: base.smtp_host, smtp_port: base.smtp_port, smtp_secure: base.smtp_secure,
          smtp_user: row.user || email, smtp_pass: row.password, imap_host: base.imap_host, imap_port: base.imap_port, imap_secure: base.imap_secure,
          imap_same_pass: true, warmup_enabled: body.warmup !== false, signature, daily_limit: v.int(body.daily_limit, { min: 1, max: 200, fallback: 30 })
        });
        const now = Date.now();
        const id = insert("mailboxes", { ...data, status: "active", ramp_started_at: now, warmup_started_at: data.warmup_enabled ? now : null, created_at: now, updated_at: now });
        const test = body.test === false ? null : await testConnection(getMailbox(id)).catch(err => ({ smtp: { ok: false, error: err.message }, imap: { ok: false, error: err.message } }));
        if (test && !test.smtp.ok) q.run("UPDATE mailboxes SET last_error = ?, updated_at = ? WHERE id = ?", String(test.smtp.error || "SMTP-Test fehlgeschlagen").slice(0, 500), Date.now(), id);
        results.push({ email, ok: true, id, smtp: test?.smtp?.ok ?? null, imap: test?.imap?.ok ?? null, error: test && !test.smtp.ok ? test.smtp.error : test && test.imap?.ok === false ? `IMAP: ${test.imap.error}` : null });
      } catch (err) {
        results.push({ email, ok: false, error: err.message });
      }
    }
    return { results, status: setupStatus() };
  });

  r.post("/api/setup/warmup-all", ({ user }) => {
    requireAdmin(user);
    const now = Date.now();
    const n = q.run("UPDATE mailboxes SET warmup_enabled = 1, warmup_started_at = COALESCE(warmup_started_at, ?), updated_at = ? WHERE warmup_enabled = 0 AND status = 'active'", now, now).changes;
    return { changed: Number(n), status: setupStatus() };
  });

  r.post("/api/setup/signatures", ({ body, user }) => {
    requireAdmin(user);
    const company = getSettings().company_name || "";
    const position = v.str(body.position ?? "", { max: 120 });
    const greeting = v.str(body.greeting || "Beste Grüße", { max: 60 });
    let changed = 0;
    for (const mb of q.all("SELECT id, from_name, signature FROM mailboxes")) {
      if (!body.overwrite && signatureCheck(mb.signature).ok) continue;
      if (!mb.from_name) continue;
      const sig = [greeting, mb.from_name, [position, company].filter(Boolean).join(" – ")].filter(Boolean).join("\n");
      q.run("UPDATE mailboxes SET signature = ?, updated_at = ? WHERE id = ?", sig, Date.now(), mb.id);
      changed++;
    }
    return { changed, status: setupStatus() };
  });

  // Frage an den Setup-Assistenten – kennt den Leitfaden und den aktuellen Stand der Einrichtung.
  r.post("/api/setup/ask", async ({ body }) => {
    if (!aiAvailable()) fail(400, AI_MISSING);
    const question = v.text(body.question, { max: 3000, name: "Frage" });
    if (!question.trim()) fail(400, "Bitte eine Frage eingeben");
    const st = setupStatus();
    const state = st.steps.map(s => `## ${s.title} (${s.status})\n${s.checks.map(c => `- ${c.label}: ${c.status} – ${c.detail}`).join("\n")}`).join("\n");
    const res = await callJson({
      system: ["Du bist der Setup-Assistent von Smature Coldmail. Antworte auf Deutsch, knapp und in konkreten Schritten (wo klicken, was eintragen). Beziehe dich auf den aktuellen Stand. Erfinde keine Funktionen, die nicht im Leitfaden stehen. Bei rechtlichen Fragen: Hinweis, dass es keine Rechtsberatung ist.", GUIDE],
      content: `# Aktueller Stand der Einrichtung\nHauptdomain: ${st.main_domain || "(nicht eingetragen)"}\nPostfächer: ${st.mailboxes.length}, Kapazität ${st.capacity.per_day} Mails/Tag\n${state}\n\n# Frage\n${question}`,
      schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
      maxTokens: 2500, effort: "low"
    });
    return { answer: String(res.answer || "").trim() };
  });
}
