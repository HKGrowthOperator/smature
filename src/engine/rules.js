// Regeln, damit nur sauber freigegebene Texte an passende Kontakte gehen:
//  • Freigabe: Hash über alle Texte, Abstände, Nachfass-Texte und Rechtsgrundlage – jede Änderung hebt sie auf.
//  • Rechts-Check vor dem Start (Impressum, Abmeldung, Datenschutz, kein Tracking ohne Einwilligung …).
//  • Kontaktregeln je Lead (Einwilligung, Qualität, Sperrfristen, max. Kontakte je Firma).
import crypto from "node:crypto";
import { q, parseJson } from "../db.js";
import { DAY_MS } from "../lib/time.js";
import { isFreemail } from "../lib/verify.js";
import { usedVariables } from "../lib/template.js";
import { getSettings } from "../settings.js";

export const LEGAL_BASES = {
  consent: "Einwilligung liegt vor (z. B. Anfrage, Messe-Kontakt mit Zustimmung, Newsletter)",
  customer: "Bestandskunden (§ 7 Abs. 3 UWG: ähnliche Produkte, Hinweis auf Widerspruch)",
  cold: "Kaltakquise ohne Einwilligung (rechtlich riskant – nur mit ausdrücklicher Bestätigung)"
};

export const CONSENT_STATUSES = {
  none: "Keine Einwilligung",
  granted: "Einwilligung liegt vor",
  customer: "Bestandskunde",
  revoked: "Widerrufen / Widerspruch"
};

const FIT_RANK = { A: 1, B: 2, C: 3, D: 4 };

// Kaltakquise nie ins rechtliche Umfeld: Wer beruflich mit Recht, Abmahnungen, Datenschutz oder Aufsicht zu tun hat,
// mahnt unerwünschte Werbung am ehesten ab. Geprüft werden Firma, Branche, Position, Website und E-Mail-Domain.
export const LEGAL_RISK_PATTERNS = [
  [/rechtsanw|anw(a|ä|ae)lt|kanzlei|notar(?!zt)|jurist|justiz|rechtsberat|rechtsbeist|rechtsschutz|rechtsabteilung|\blegal\b|law-?firm|lawyer|attorney/, "Recht/Kanzlei"],
  [/abmahn|wettbewerbszentrale|wettbewerbsverband|verbraucherzentrale|verbraucherschutz|interessenverband/, "Abmahnung/Verbraucherschutz"],
  [/datenschutz|inkasso/, "Datenschutz/Inkasso"],
  [/steuerberat|wirtschaftspr(u|ü|ue)f/, "Steuerberatung/Wirtschaftsprüfung"],
  [/rechtsanwaltskammer|handwerkskammer|\bihk\b|ministerium|beh(o|ö|oe)rde|bundesamt|landesamt|polizei|amtsgericht|landgericht|staatsanwalt/, "Kammer/Behörde/Gericht"]
];

export function legalRiskHit(lead, settings = getSettings()) {
  const text = [lead.company, lead.industry, lead.position, lead.website, lead.email].map(x => String(x || "")).join(" ").toLowerCase();
  for (const [re, label] of LEGAL_RISK_PATTERNS) if (re.test(text)) return label;
  const extra = String(settings.cold_exclude_terms || "").split(/[,;\n]+/).map(t => t.trim().toLowerCase()).filter(t => t.length >= 3);
  const own = extra.find(t => text.includes(t));
  return own ? `eigener Ausschluss „${own}“` : null;
}

export function nurtureTexts(campaign) {
  return (parseJson(campaign?.nurture_texts, []) || []).map(t => (typeof t === "string" ? { body: t } : t)).filter(t => t && String(t.body || "").trim());
}

// Alles, was der Empfänger lesen kann oder wann er es bekommt – Grundlage der Freigabe.
export function contentHash(campaign, steps) {
  const payload = {
    legal_basis: campaign.legal_basis || "consent",
    product_id: campaign.product_id || null,
    steps: steps.map(s => ({
      delay: Number(s.delay_days) || 0,
      variants: (s.variants || []).map(v => ({ subject: String(v.subject || ""), body: String(v.body || ""), enabled: v.enabled !== false }))
    })),
    nurture: campaign.nurture_enabled ? { texts: nurtureTexts(campaign).map(t => t.body), mode: campaign.nurture_mode } : null
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function approvalState(campaign, steps) {
  const hash = contentHash(campaign, steps);
  const approved = !!campaign.approved_hash && campaign.approved_hash === hash;
  return {
    approved,
    hash,
    approved_at: approved ? campaign.approved_at : null,
    approved_by: approved ? campaign.approved_by : null,
    // Freigabe gab es, aber seither wurde etwas geändert.
    outdated: !!campaign.approved_hash && !approved
  };
}

const ENABLED = s => (s.variants || []).filter(v => v.enabled !== false && (String(v.body || "").trim() || String(v.subject || "").trim()));

// Prüft Inhalte und Einstellungen einer Kampagne gegen die Richtlinien. Fehler blockieren den Start.
export function complianceIssues(campaign, steps, settings = getSettings()) {
  const errors = [], warnings = [];
  const basis = campaign.legal_basis || "consent";
  const cold = basis === "cold";
  const product = campaign.product_id ? q.get("SELECT * FROM products WHERE id = ?", campaign.product_id) : null;

  if (!String(settings.footer_text || "").trim()) errors.push("Impressum fehlt: In den Einstellungen die Fußzeile mit Firma, Anschrift, Vertretung und Registerangaben hinterlegen (Pflicht für geschäftliche E-Mails).");
  if (!campaign.unsubscribe) errors.push("Abmelde-Möglichkeit ist aus. Jede Mail braucht einen einfachen Widerspruchsweg (Art. 21 DSGVO, § 7 Abs. 3 UWG).");
  if (!String(settings.privacy_url || "").trim()) {
    (cold ? errors : warnings).push("Kein Link zur Datenschutzerklärung hinterlegt (Einstellungen). Empfänger müssen erfahren, woher ihre Daten stammen und wie sie widersprechen können (Art. 14 DSGVO).");
  } else if (!/\{\{\s*privacy_url\s*\}\}|datenschutz/i.test(`${settings.footer_text}\n${settings.unsubscribe_text}`)) {
    warnings.push("Die Fußzeile verweist nicht auf die Datenschutzerklärung – {{privacy_url}} in Fußzeile oder Abmelde-Text einfügen.");
  }
  if (campaign.track_opens || campaign.track_clicks) {
    if (basis !== "consent") errors.push("Öffnungs-/Klick-Tracking braucht eine Einwilligung (§ 25 TDDDG) – bei dieser Rechtsgrundlage abschalten.");
    else warnings.push("Tracking nur einsetzen, wenn die Einwilligung der Empfänger das Tracking ausdrücklich umfasst (§ 25 TDDDG).");
  }
  if (cold) {
    if (!campaign.cold_ack_at) errors.push("Kaltakquise ohne Einwilligung: Bitte zuerst bestätigen, dass das Risiko (Abmahnung nach § 7 UWG) bekannt ist und nur sorgfältig ausgewählte Firmenkontakte angeschrieben werden.");
    if (steps.length > 3) errors.push("Kaltakquise: höchstens 3 Mails pro Kontakt.");
    steps.forEach((s, i) => { if (i > 0 && Number(s.delay_days) < 4) warnings.push(`Kaltakquise: Schritt ${i + 1} kommt nach ${s.delay_days} Tagen – mindestens 4 Tage Abstand wirken weniger aufdringlich.`); });
    if (!campaign.min_fit) warnings.push("Kaltakquise ohne Qualitätsfilter: „Nur passende Leads (A/B)“ aktivieren und Leads vorher prüfen.");
    if (campaign.call_after_sequence) warnings.push("Anrufe ohne vorheriges Interesse sind nur bei mutmaßlicher Einwilligung erlaubt (§ 7 Abs. 2 Nr. 1 UWG) – nur Firmen mit klarem Bedarf anrufen.");
  }
  if (basis === "customer") warnings.push("Bestandskunden: nur für eigene, ähnliche Produkte und nur, wenn bei der Datenerhebung auf das Widerspruchsrecht hingewiesen wurde (§ 7 Abs. 3 UWG).");

  const texts = [];
  steps.forEach((s, i) => {
    for (const v of ENABLED(s)) {
      texts.push({ where: `Schritt ${i + 1}${s.variants.length > 1 ? `, Variante ${v.key}` : ""}`, subject: v.subject, body: v.body, first: i === 0 });
    }
  });
  if (campaign.nurture_enabled) nurtureTexts(campaign).forEach((t, i) => texts.push({ where: `Nachfass-Text ${i + 1}`, subject: "", body: t.body }));
  for (const t of texts) {
    if (t.first && /^\s*(re|aw|fw|fwd|wg)\s*:/i.test(t.subject || "")) errors.push(`${t.where}: Betreff beginnt mit „Re:“/„AW:“ – täuscht ein bestehendes Gespräch vor (irreführend, § 5 UWG).`);
    if (t.first && /(wie besprochen|wie telefonisch|unser telefonat|unser gespräch|ihre anfrage)/i.test(`${t.subject}\n${t.body}`) && cold) {
      errors.push(`${t.where}: Bezug auf ein Gespräch oder eine Anfrage, die es nicht gab – irreführend.`);
    }
    // Beliebte Coaching-Betreffs wie „Meeting {{first_name}} & Julia“ oder „Zugang freigeschaltet“ täuschen einen
    // vereinbarten Termin bzw. ein bestehendes Konto vor.
    if (t.first && cold && /\b(meeting|gespräch|termin|call)\s+(mit\s+)?\{\{\s*(first_name|vorname|last_name|nachname)\s*\}\}|zugang\s+freigeschaltet/i.test(t.subject || "")) {
      errors.push(`${t.where}: Betreff täuscht einen vereinbarten Termin oder ein bestehendes Konto vor – irreführend (§ 5 UWG). Besser z. B. „Frage zu {{company}}“.`);
    }
    const vars = usedVariables(`${t.subject}\n${t.body}`);
    if (vars.includes("termin_link") && !(product?.booking_url || settings.booking_url)) errors.push(`${t.where}: {{termin_link}} wird verwendet, aber kein Termin-Link hinterlegt (Produkt oder Einstellungen).`);
    if ((vars.includes("kit_link") || vars.includes("kit_name")) && !product?.kit_url) errors.push(`${t.where}: {{kit_link}} wird verwendet, aber beim Produkt ist kein Info-Kit hinterlegt.`);
    if (t.first && cold && /https?:\/\//i.test(t.body || "")) warnings.push(`${t.where}: Links in der ersten Kaltmail verschlechtern die Zustellbarkeit und wirken werblich.`);
    // Platzhalter aus dem Standard-Gerüst („[Anlass: …]“) dürfen nie verschickt werden.
    if (/^\s*\[[^\]\n]{3,}\]\s*$/m.test(t.body || "")) errors.push(`${t.where}: enthält noch einen Platzhalter in eckigen Klammern (z. B. „[Anlass …]“) – Text ausformulieren.`);
  }
  if (campaign.nurture_enabled && campaign.nurture_mode === "auto" && !nurtureTexts(campaign).length && !(product && nurtureTexts(product).length)) {
    warnings.push("Nachfassen ist auf „automatisch“, aber es gibt keine freigegebenen Nachfass-Texte – es werden nur Entwürfe zur Prüfung angelegt.");
  }
  return { errors, warnings };
}

// ---------- Kontaktregeln je Lead ----------

function domainOf(email) {
  return String(email || "").toLowerCase().split("@")[1] || "";
}

export function leadFit(leadId, productId) {
  return productId ? q.get("SELECT fit, reason FROM lead_fit WHERE lead_id = ? AND product_id = ?", leadId, productId) : null;
}

// Gründe, warum ein Lead für diese Kampagne (noch) nicht angeschrieben werden darf. Gibt null zurück, wenn alles passt.
// { reason, final } – final: endgültig überspringen, sonst später erneut versuchen ({ retryAt }).
// Sperren aus dem Firmenprofil: Person „nicht kontaktieren“, Firma gesperrt bzw. (für neue Ansprache) disqualifiziert.
export function accountBlock(lead, { firstContact = true } = {}) {
  if (!lead) return null;
  if (q.get("SELECT 1 FROM account_people WHERE lead_id = ? AND do_not_contact = 1", lead.id)) return "Person ist als „nicht kontaktieren“ markiert";
  if (!lead.account_id) return null;
  const lifecycle = q.value("SELECT lifecycle FROM accounts WHERE id = ?", lead.account_id);
  if (lifecycle === "suppressed") return "Firma ist gesperrt";
  if (firstContact && lifecycle === "disqualified") return "Firma passt nicht (disqualifiziert)";
  return null;
}

export function contactBlock(campaign, lead, { stepIndex = 0, now = Date.now(), settings = getSettings(), clId = null } = {}) {
  const basis = campaign.legal_basis || "consent";
  if (lead.consent_status === "revoked") return { reason: "Widerspruch/Widerruf des Kontakts", final: true };
  const acc = accountBlock(lead, { firstContact: stepIndex === 0 });
  if (acc) return { reason: acc, final: true };
  if (lead.hold_until && lead.hold_until > now) return { reason: `Gesperrt bis ${new Date(lead.hold_until).toLocaleDateString("de-DE")} (z. B. „kein Interesse“)`, final: true };
  if (lead.meeting_at && stepIndex === 0) return { reason: "Termin ist bereits gebucht", final: true };
  if (basis === "consent" && !["granted", "customer"].includes(lead.consent_status)) return { reason: "Keine dokumentierte Einwilligung", final: true };
  if (basis === "customer" && lead.consent_status !== "customer" && lead.consent_status !== "granted") return { reason: "Kein Bestandskunde", final: true };
  if (stepIndex > 0) return null;

  if (basis === "cold") {
    if (settings.skip_freemail_cold && isFreemail(lead.email)) return { reason: "Private/Freemail-Adresse – Kaltakquise nur an Firmenadressen", final: true };
    const legal = legalRiskHit(lead, settings);
    if (legal) return { reason: `Rechtliches Umfeld (${legal}) – nie per Kaltakquise anschreiben`, final: true };
    if (campaign.min_fit) {
      const fit = leadFit(lead.id, campaign.product_id);
      if (!fit) return { reason: "Qualität noch nicht geprüft – Leads zuerst prüfen (KI)", final: true };
      if (FIT_RANK[fit.fit] > FIT_RANK[campaign.min_fit]) return { reason: `Passt nicht gut genug (${fit.fit})${fit.reason ? `: ${fit.reason}` : ""}`, final: true };
    }
  }
  const cooldown = Number(settings.cooldown_days) || 0;
  if (cooldown > 0) {
    const recent = q.value(`SELECT MAX(created_at) FROM messages WHERE lead_id = ? AND direction = 'out' AND kind IN ('campaign','nurture') AND status != 'failed'
      AND (campaign_lead_id IS NULL OR campaign_lead_id != ?)`, lead.id, clId || 0);
    if (recent && recent > now - cooldown * DAY_MS) return { reason: `Wurde vor weniger als ${cooldown} Tagen schon angeschrieben`, final: true };
  }
  const cap = Number(settings.company_cap_30d) || 0;
  const domain = domainOf(lead.email);
  if (cap > 0 && domain && !isFreemail(lead.email)) {
    const contacted = q.value(`SELECT COUNT(DISTINCT m.lead_id) FROM messages m WHERE m.direction = 'out' AND m.kind = 'campaign' AND m.step = 0 AND m.status != 'failed'
      AND m.created_at > ? AND m.to_addr LIKE ? ESCAPE '\\' AND m.lead_id != ?`, now - 30 * DAY_MS, `%@${domain.replace(/[\\%_]/g, c => "\\" + c)}`, lead.id);
    if (contacted >= cap) return { reason: `Schon ${contacted} Kontakte dieser Firma in den letzten 30 Tagen`, final: false, retryAt: now + DAY_MS };
  }
  return null;
}

// Vorab-Prüfung beim Hinzufügen zu einer Kampagne: liefert den Grund, warum ein Lead nicht aufgenommen wird.
export function enrollBlock(campaign, lead, settings = getSettings()) {
  if (lead.status !== "active") return "nicht aktiv";
  if (lead.verify_status === "invalid") return "ungültige Adresse";
  const other = q.get(`SELECT c.name FROM campaign_leads cl JOIN campaigns c ON c.id = cl.campaign_id
    WHERE cl.lead_id = ? AND cl.campaign_id != ? AND cl.status IN ('queued','active','paused') AND c.status IN ('active','paused') AND c.is_template = 0 LIMIT 1`, lead.id, campaign.id);
  if (other) return `läuft schon in „${other.name}“`;
  // Projekte sauber getrennt: Firmen eines anderen Geschäftsbereichs werden nicht aufgenommen.
  const campaignProject = q.value(`SELECT COALESCE(p.project_id, tg.project_id) FROM campaigns c LEFT JOIN products p ON p.id = c.product_id
    LEFT JOIN target_groups tg ON tg.id = c.target_group_id WHERE c.id = ?`, campaign.id);
  const own = lead.account_id ? q.get("SELECT a.project_id, pj.name FROM accounts a LEFT JOIN projects pj ON pj.id = a.project_id WHERE a.id = ?", lead.account_id) : null;
  if (campaignProject && own?.project_id && own.project_id !== campaignProject) return `Firma gehört zu Projekt „${own.name}“`;
  const block = contactBlock(campaign, lead, { settings });
  return block && block.final ? block.reason : null;
}
