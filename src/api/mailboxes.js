// API: Postfächer (SMTP/IMAP), Verbindungstest, DNS-Check, Testversand, manueller Abgleich.
import { q, insert, update } from "../db.js";
import { encrypt } from "../crypto.js";
import { fail, v } from "../http.js";
import { publicMailbox, getMailbox, sentTodayByMailbox } from "../mail/mailboxes.js";
import { verifySmtp, buildRaw, sendRaw, describeSmtpError } from "../mail/transport.js";
import { verifyImap, syncMailbox, imapConfigured, providerSavesSent } from "../mail/imap.js";
import { checkDomain } from "../lib/dns-check.js";
import { newMessageId } from "../mail/compose.js";

export const PROVIDERS = {
  google: { label: "Google Workspace / Gmail", smtp_host: "smtp.gmail.com", smtp_port: 587, smtp_secure: 0, imap_host: "imap.gmail.com", imap_port: 993, imap_secure: 1, hint: "2-Schritt-Verifizierung aktivieren und ein App-Passwort erstellen (myaccount.google.com → Sicherheit → App-Passwörter). SMTP über Port 587 (STARTTLS) – Port 465 sperren manche Hoster (z. B. Hetzner)." },
  microsoft: { label: "Microsoft 365 / Outlook", smtp_host: "smtp.office365.com", smtp_port: 587, smtp_secure: 0, imap_host: "outlook.office365.com", imap_port: 993, imap_secure: 1, hint: "Microsoft hat Basic Auth für SMTP/IMAP weitgehend abgeschaltet – funktioniert nur, wenn SMTP AUTH im Tenant noch erlaubt ist." },
  ionos: { label: "IONOS", smtp_host: "smtp.ionos.de", smtp_port: 465, smtp_secure: 1, imap_host: "imap.ionos.de", imap_port: 993, imap_secure: 1, hint: "" },
  strato: { label: "STRATO", smtp_host: "smtp.strato.de", smtp_port: 465, smtp_secure: 1, imap_host: "imap.strato.de", imap_port: 993, imap_secure: 1, hint: "" },
  allinkl: { label: "ALL-INKL (KAS)", smtp_host: "", smtp_port: 587, smtp_secure: 0, imap_host: "", imap_port: 993, imap_secure: 1, hint: "Server ist wXXXXXXX.kasserver.com (siehe KAS → E-Mail). SMTP über Port 587 (STARTTLS); 465 ist bei manchen Servern gesperrt." },
  hetzner: { label: "Hetzner (konsoleH)", smtp_host: "mail.your-server.de", smtp_port: 465, smtp_secure: 1, imap_host: "mail.your-server.de", imap_port: 993, imap_secure: 1, hint: "" },
  zoho: { label: "Zoho Mail (EU)", smtp_host: "smtp.zoho.eu", smtp_port: 465, smtp_secure: 1, imap_host: "imap.zoho.eu", imap_port: 993, imap_secure: 1, hint: "" },
  custom: { label: "Eigener Server", smtp_host: "", smtp_port: 465, smtp_secure: 1, imap_host: "", imap_port: 993, imap_secure: 1, hint: "" }
};

const baseDomain = host => String(host || "").toLowerCase().split(".").filter(Boolean).slice(-2).join(".");

// Gespeicherte Passwörter nie an einen geänderten Server/Benutzer schicken – sonst ließen sie sich über einen
// fremden Server auslesen. Bei Änderung muss das Passwort neu eingegeben werden.
function changedTarget(row, existing, kind) {
  if (!existing) return false;
  return ["host", "port", "user"].some(f => String(row[`${kind}_${f}`] ?? "").toLowerCase() !== String(existing[`${kind}_${f}`] ?? "").toLowerCase());
}

function guardStoredSecrets(row, existing, body) {
  if (!existing) return;
  if (!body.smtp_pass && changedTarget(row, existing, "smtp")) fail(400, "SMTP-Server, Port oder Benutzer geändert – bitte das SMTP-Passwort erneut eingeben.");
  if (!row.imap_host || body.imap_pass || (body.imap_same_pass && body.smtp_pass)) return;
  if (existing.imap_host && existing.imap_pass && !changedTarget(row, existing, "imap")) return;
  // IMAP neu eingerichtet ohne Passwort: SMTP-Passwort nur beim selben Anbieter übernehmen (smtp.x.de ↔ imap.x.de).
  if (!existing.imap_host && baseDomain(row.imap_host) === baseDomain(row.smtp_host) && String(row.imap_user || row.smtp_user).toLowerCase() === String(row.smtp_user).toLowerCase()) return;
  fail(400, "IMAP-Server, Port oder Benutzer geändert – bitte das IMAP-Passwort erneut eingeben.");
}

export function readMailbox(body, existing = null) {
  const email = v.email(body.email ?? existing?.email);
  const row = {
    email,
    from_name: v.str(body.from_name ?? existing?.from_name, { max: 120, name: "Absendername" }),
    provider: v.oneOf(body.provider ?? existing?.provider ?? "custom", Object.keys(PROVIDERS), "custom"),
    smtp_host: v.str(body.smtp_host ?? existing?.smtp_host, { max: 255, required: true, name: "SMTP-Server" }),
    smtp_port: v.int(body.smtp_port ?? existing?.smtp_port, { min: 1, max: 65535, name: "SMTP-Port" }),
    smtp_secure: v.bool(body.smtp_secure ?? existing?.smtp_secure),
    smtp_user: v.str(body.smtp_user ?? existing?.smtp_user ?? email, { max: 255, required: true, name: "SMTP-Benutzer" }) || email,
    imap_host: v.str(body.imap_host ?? existing?.imap_host, { max: 255 }) || null,
    imap_port: v.int(body.imap_port ?? existing?.imap_port, { min: 1, max: 65535, fallback: 993 }),
    imap_secure: v.bool(body.imap_secure ?? existing?.imap_secure, true),
    imap_user: v.str(body.imap_user ?? existing?.imap_user, { max: 255 }) || null,
    daily_limit: v.int(body.daily_limit ?? existing?.daily_limit, { min: 1, max: 2000, fallback: 30, name: "Tageslimit" }),
    min_gap_sec: v.int(body.min_gap_sec ?? existing?.min_gap_sec, { min: 0, max: 86400, fallback: 120 }),
    ramp_enabled: v.bool(body.ramp_enabled ?? existing?.ramp_enabled, true),
    ramp_start: v.int(body.ramp_start ?? existing?.ramp_start, { min: 1, max: 500, fallback: 5 }),
    ramp_step: v.int(body.ramp_step ?? existing?.ramp_step, { min: 0, max: 200, fallback: 3 }),
    signature: v.text(body.signature ?? existing?.signature ?? "", { max: 5000, name: "Signatur" }),
    reply_to: v.email(body.reply_to ?? existing?.reply_to ?? "", { required: false, name: "Antwort-an" }) || null,
    warmup_enabled: v.bool(body.warmup_enabled ?? existing?.warmup_enabled),
    warmup_daily: v.int(body.warmup_daily ?? existing?.warmup_daily, { min: 1, max: 60, fallback: 10 }),
    warmup_reply_rate: v.int(body.warmup_reply_rate ?? existing?.warmup_reply_rate, { min: 0, max: 100, fallback: 35 })
  };
  row.save_sent = body.save_sent !== undefined ? v.bool(body.save_sent) : (existing ? existing.save_sent : (providerSavesSent(row) ? 0 : 1));
  if (body.smtp_pass) row.smtp_pass = encrypt(v.str(body.smtp_pass, { max: 500 }));
  if (body.imap_pass) row.imap_pass = encrypt(v.str(body.imap_pass, { max: 500 }));
  else if (body.imap_same_pass && body.smtp_pass) row.imap_pass = row.smtp_pass;
  if (!existing && !row.smtp_pass) fail(400, "SMTP-Passwort fehlt");
  if (row.imap_host && !row.imap_user) row.imap_user = row.smtp_user;
  if (row.imap_host && !row.imap_pass && !existing?.imap_pass) row.imap_pass = row.smtp_pass || existing?.smtp_pass || null;
  return row;
}

// Testkonfiguration aus dem Formular (vor dem Speichern) – Passwörter bleiben im Klartext nur im Speicher.
function plainConfig(body, existing) {
  const base = readMailbox({ ...body, smtp_pass: undefined, imap_pass: undefined }, existing || { smtp_pass: "placeholder" });
  if (existing) guardStoredSecrets(base, existing, body);
  const mb = { ...(existing || {}), ...base };
  if (body.smtp_pass) mb.smtp_pass_plain = String(body.smtp_pass);
  else if (!existing) fail(400, "SMTP-Passwort fehlt");
  const imapPass = body.imap_pass || ((body.imap_same_pass || !existing?.imap_pass) ? body.smtp_pass : undefined);
  if (imapPass) mb.imap_pass_plain = String(imapPass);
  if (existing) {
    mb.smtp_pass = existing.smtp_pass;
    mb.imap_pass = existing.imap_pass || existing.smtp_pass;
  }
  return mb;
}

export async function testConnection(mb) {
  const smtp = await verifySmtp(mb);
  const imap = imapConfigured(mb) ? await verifyImap(mb) : { ok: null, error: "IMAP nicht konfiguriert – Antworten werden dann nicht erkannt." };
  return { smtp, imap };
}

export function register(r) {
  r.get("/api/mailboxes/providers", () => PROVIDERS);

  r.get("/api/mailboxes", () => {
    const sent = sentTodayByMailbox();
    return q.all("SELECT * FROM mailboxes ORDER BY email").map(mb => publicMailbox(mb, sent));
  });

  r.post("/api/mailboxes", async ({ body }) => {
    const row = readMailbox(body);
    if (q.get("SELECT 1 FROM mailboxes WHERE email = ?", row.email)) fail(409, "Dieses Postfach existiert bereits");
    const now = Date.now();
    const id = insert("mailboxes", { ...row, status: "active", ramp_started_at: now, created_at: now, updated_at: now });
    return publicMailbox(getMailbox(id), sentTodayByMailbox());
  });

  r.post("/api/mailboxes/test", async ({ body }) => {
    const existing = body.id ? getMailbox(v.id(body.id)) : null;
    return testConnection(plainConfig(body, existing));
  });

  r.get("/api/mailboxes/:id", ({ params }) => {
    const mb = getMailbox(v.id(params.id)) || fail(404, "Postfach nicht gefunden");
    return publicMailbox(mb, sentTodayByMailbox());
  });

  r.put("/api/mailboxes/:id", ({ params, body }) => {
    const id = v.id(params.id);
    const existing = getMailbox(id) || fail(404, "Postfach nicht gefunden");
    const row = readMailbox(body, existing);
    guardStoredSecrets(row, existing, body);
    if (row.email !== existing.email && q.get("SELECT 1 FROM mailboxes WHERE email = ? AND id != ?", row.email, id)) fail(409, "Dieses Postfach existiert bereits");
    if (row.warmup_enabled && !existing.warmup_enabled) row.warmup_started_at = Date.now();
    update("mailboxes", id, { ...row, updated_at: Date.now() });
    return publicMailbox(getMailbox(id), sentTodayByMailbox());
  });

  r.delete("/api/mailboxes/:id", ({ params }) => {
    const id = v.id(params.id);
    q.run("DELETE FROM mailboxes WHERE id = ?", id);
    return { ok: true };
  });

  r.post("/api/mailboxes/:id/status", ({ params, body }) => {
    const id = v.id(params.id);
    const status = v.oneOf(body.status, ["active", "paused"], "active");
    getMailbox(id) || fail(404, "Postfach nicht gefunden");
    q.run("UPDATE mailboxes SET status = ?, error_count = 0, last_error = CASE WHEN ? = 'active' THEN NULL ELSE last_error END, next_send_at = 0, updated_at = ? WHERE id = ?", status, status, Date.now(), id);
    return publicMailbox(getMailbox(id), sentTodayByMailbox());
  });

  r.post("/api/mailboxes/:id/test", async ({ params }) => {
    const mb = getMailbox(v.id(params.id)) || fail(404, "Postfach nicht gefunden");
    const result = await testConnection(mb);
    if (result.smtp.ok) q.run("UPDATE mailboxes SET last_error = NULL, error_count = 0 WHERE id = ?", mb.id);
    return result;
  });

  r.post("/api/mailboxes/:id/test-send", async ({ params, body }) => {
    const mb = getMailbox(v.id(params.id)) || fail(404, "Postfach nicht gefunden");
    const to = v.email(body.to, { name: "Empfänger" });
    const raw = await buildRaw({
      from: { name: mb.from_name, address: mb.email }, to, subject: "Testnachricht aus Smature Coldmail",
      text: `Hallo,\n\ndas ist eine Testnachricht von ${mb.email}. Wenn sie im Posteingang (nicht im Spam) angekommen ist, ist alles bereit.\n\n${mb.signature || ""}`.trim(),
      messageId: newMessageId(mb.email), date: new Date()
    });
    try {
      await sendRaw(mb, { from: mb.email, to, raw });
    } catch (err) {
      fail(502, describeSmtpError(err));
    }
    return { ok: true };
  });

  r.post("/api/mailboxes/:id/sync", async ({ params }) => {
    const mb = getMailbox(v.id(params.id)) || fail(404, "Postfach nicht gefunden");
    const result = await syncMailbox(mb);
    if (result.error) fail(502, result.error);
    return result;
  });

  r.get("/api/mailboxes/:id/dns", async ({ params, query }) => {
    const mb = getMailbox(v.id(params.id)) || fail(404, "Postfach nicht gefunden");
    const selector = String(query.get("selector") || "").trim().replace(/[^a-z0-9._-]/gi, "").slice(0, 63);
    return checkDomain(mb.email.split("@")[1], { extraSelectors: selector ? [selector] : [] });
  });

  r.get("/api/domains/check", async ({ query }) => {
    const domain = String(query.get("domain") || "").trim().toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) fail(400, "Ungültige Domain");
    return checkDomain(domain);
  });
}
