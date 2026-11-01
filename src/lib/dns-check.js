// Zustellbarkeits-Check einer Absender-Domain: MX, SPF, DKIM (gängige Selektoren), DMARC, Domain-Blocklisten.
import dns from "node:dns/promises";

const DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "dkim", "mail", "k1", "k2", "s1", "s2", "smtp", "mxvault", "zoho", "zmail", "ionos", "s1-ionos", "s2-ionos", "strato", "kas", "hetzner", "everlytickey1", "mandrill", "sig1", "fm1", "protonmail"];

async function txt(name, resolver) {
  try {
    return (await resolver.resolveTxt(name)).map(parts => parts.join(""));
  } catch {
    return [];
  }
}

export async function checkDomain(domain, { resolver = dns, extraSelectors = [] } = {}) {
  const d = String(domain || "").trim().toLowerCase().replace(/^.*@/, "");
  const checks = [];
  const add = (key, label, status, detail, fix = "") => checks.push({ key, label, status, detail, fix });

  // MX
  try {
    const mx = (await resolver.resolveMx(d)).sort((a, b) => a.priority - b.priority);
    if (mx.length) add("mx", "MX-Einträge", "ok", mx.map(m => `${m.priority} ${m.exchange}`).join(", "));
    else add("mx", "MX-Einträge", "error", "Keine MX-Einträge – Antworten können nicht zugestellt werden.", "MX-Einträge beim E-Mail-Anbieter einrichten.");
  } catch {
    add("mx", "MX-Einträge", "error", "Keine MX-Einträge gefunden.", "MX-Einträge beim E-Mail-Anbieter einrichten.");
  }

  // SPF
  const spf = (await txt(d, resolver)).filter(r => /^v=spf1\b/i.test(r));
  if (spf.length === 0) add("spf", "SPF", "error", "Kein SPF-Eintrag.", `TXT-Eintrag auf ${d} anlegen, z. B. "v=spf1 include:<anbieter> ~all" (Wert vom Mail-Anbieter).`);
  else if (spf.length > 1) add("spf", "SPF", "error", `Mehrere SPF-Einträge (${spf.length}) – ungültig.`, "Zu einem einzigen SPF-Eintrag zusammenführen.");
  else {
    const rec = spf[0];
    const lookups = (rec.match(/\b(include:|a\b|a:|mx\b|mx:|ptr|exists:|redirect=)/gi) || []).length;
    if (/\+all\b/i.test(rec)) add("spf", "SPF", "error", rec, '"+all" erlaubt jedem den Versand – auf "~all" oder "-all" ändern.');
    else if (lookups > 10) add("spf", "SPF", "warn", `${rec} (${lookups} DNS-Lookups, max. 10)`, "SPF vereinfachen (weniger include:).");
    else if (!/[~-]all\b/i.test(rec)) add("spf", "SPF", "warn", rec, 'SPF sollte mit "~all" oder "-all" enden.');
    else add("spf", "SPF", "ok", rec);
  }

  // DMARC
  const dmarc = (await txt(`_dmarc.${d}`, resolver)).find(r => /^v=DMARC1\b/i.test(r));
  if (!dmarc) add("dmarc", "DMARC", "error", "Kein DMARC-Eintrag (seit 2024 Pflicht bei Gmail/Yahoo für Massenversender).", `TXT-Eintrag "_dmarc.${d}" mit z. B. "v=DMARC1; p=none; rua=mailto:dmarc@${d}" anlegen.`);
  else {
    const p = (/;\s*p=([a-z]+)/i.exec(dmarc) || [])[1] || "";
    add("dmarc", "DMARC", p ? "ok" : "warn", dmarc, p ? "" : "Policy (p=) fehlt.");
  }

  // DKIM – Selektoren durchprobieren. Gezählt wird nur ein echter Schlüssel (TXT folgt CNAMEs) oder ein an einen
  // DKIM-Dienst delegierter CNAME. Ein Wildcard-Eintrag (*.domain → Webserver, z. B. bei ALL-INKL üblich) beantwortet
  // jeden Selektor – der zählt nicht, sonst wäre DKIM immer „grün“.
  const cnameOf = async name => { try { return String((await resolver.resolveCname(name))[0] || "").toLowerCase(); } catch { return ""; } };
  const isKey = r => !/^v=(spf1|dmarc1)\b/i.test(r) && (/v=DKIM1/i.test(r) || /(^|;)\s*p=[A-Za-z0-9+/]{40,}/.test(r));
  const wildcard = await cnameOf(`zz${Math.random().toString(36).slice(2, 10)}._domainkey.${d}`);
  const selectors = [...new Set([...extraSelectors, ...DKIM_SELECTORS])];
  const found = [];
  await Promise.all(selectors.map(async s => {
    const rec = await txt(`${s}._domainkey.${d}`, resolver);
    if (rec.some(isKey)) found.push(s);
    else {
      const cname = await cnameOf(`${s}._domainkey.${d}`);
      if (cname && cname !== wildcard && /domainkey/.test(cname)) found.push(s);
    }
  }));
  if (found.length) add("dkim", "DKIM", "ok", `Gefunden für Selektor: ${found.sort().join(", ")}`);
  else add("dkim", "DKIM", "warn", "Kein DKIM-Schlüssel unter gängigen Selektoren gefunden.", "DKIM beim E-Mail-Anbieter aktivieren (ALL-INKL: KAS → Domain bearbeiten → DKIM; Google Workspace: Admin → Gmail → E-Mails authentifizieren). Der Selektor steht dort (bei ALL-INKL z. B. „kas2024…“) oder im Header einer gesendeten Mail (DKIM-Signature: s=…) – eintragen und erneut prüfen.");

  // Domain-Blocklisten
  const lists = [["dbl.spamhaus.org", "Spamhaus DBL"], ["multi.surbl.org", "SURBL"], ["multi.uribl.com", "URIBL"]];
  const listed = [], unknown = [];
  await Promise.all(lists.map(async ([zone, name]) => {
    try {
      const a = await resolver.resolve4(`${d}.${zone}`);
      // Spamhaus/URIBL antworten öffentlichen Resolvern mit 127.255.255.x bzw. 127.0.0.1 → nicht auswertbar.
      if (a.some(ip => /^127\.255\.255\./.test(ip) || ip === "127.0.0.1")) unknown.push(name);
      else if (a.some(ip => ip.startsWith("127."))) listed.push(name);
    } catch { /* NXDOMAIN = nicht gelistet */ }
  }));
  if (listed.length) add("blocklist", "Blocklisten", "error", `Gelistet bei: ${listed.join(", ")}`, "Ursache klären und Delisting beim Betreiber beantragen. Bis dahin nicht von dieser Domain versenden.");
  else add("blocklist", "Blocklisten", unknown.length === lists.length ? "warn" : "ok", unknown.length ? `Nicht gelistet (nicht prüfbar über diesen DNS-Resolver: ${unknown.join(", ")})` : "Auf keiner geprüften Domain-Blockliste.");

  const score = Math.round(checks.reduce((sum, c) => sum + (c.status === "ok" ? 1 : c.status === "warn" ? 0.5 : 0), 0) / checks.length * 100);
  return { domain: d, score, checks, checked_at: Date.now() };
}
