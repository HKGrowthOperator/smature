// KI-Funktionen: Wissen (Zielgruppe/Produkt) verdichten, Sequenzen und Nachfass-Texte schreiben, Leads prüfen und
// personalisieren, Antworten einordnen und Antworten entwerfen.
import { q, parseJson } from "../db.js";
import { callJson, aiAvailable as available, AiError, AiLimitError } from "./claude.js";
import { getSettings } from "../settings.js";
import { fetchWebsiteText } from "../lib/website.js";
import { buildVars, render, productVars } from "../lib/template.js";
import { stripQuoted } from "../lib/text.js";
import { isFreemail } from "../lib/verify.js";
import { emitWebhook, recordEvent, leadPayload } from "../events.js";
import { markUnsubscribed } from "../mail/inbound.js";
import { brainText } from "../intel/brain.js";
import { checkMessage, qaFeedback } from "../orchestration/qa.js";

export const aiAvailable = available;
export { AiError, AiLimitError };

export const LABELS = {
  interested: "Interessiert",
  meeting: "Termin gewünscht",
  question: "Rückfrage",
  later: "Später melden",
  not_interested: "Kein Interesse",
  wrong_person: "Falscher Ansprechpartner",
  unsubscribe: "Abmeldung",
  ooo: "Abwesend",
  other: "Sonstiges"
};

// Passung eines Leads zum Produkt (Qualitätsprüfung vor dem Anschreiben).
export const FIT_LABELS = {
  A: "Sehr gut passend",
  B: "Passend",
  C: "Unklar",
  D: "Passt nicht"
};

function senderBlock() {
  const s = getSettings();
  return [
    `# Absender`,
    `Unternehmen: ${s.company_name || "(nicht angegeben)"}`,
    s.sender_context ? `Was wir anbieten / wer wir sind:\n${s.sender_context}` : "Was wir anbieten: (nicht hinterlegt – nur Angaben aus Produkt- und Zielgruppenwissen verwenden)"
  ].filter(Boolean).join("\n");
}

function knowledgeTexts(column, id, maxChars = 60000) {
  if (!id) return "";
  const docs = q.all(`SELECT title, kind, content FROM knowledge_docs WHERE ${column} = ? AND content != '' ORDER BY id`, id);
  let out = "", used = 0;
  for (const d of docs) {
    const chunk = `\n## ${d.title}\n${d.content}\n`;
    if (used + chunk.length > maxChars) { out += `\n## ${d.title}\n${d.content.slice(0, Math.max(0, maxChars - used - 50))}\n[…gekürzt]\n`; break; }
    out += chunk; used += chunk.length;
  }
  return out.trim();
}

function targetGroupBlock(tg, { includeKnowledge = true } = {}) {
  if (!tg) return "# Zielgruppe\n(keine Zielgruppe hinterlegt)";
  const parts = [
    `# Zielgruppe: ${tg.name}`,
    tg.description && `Beschreibung: ${tg.description}`,
    tg.offer && `Angebot für diese Zielgruppe: ${tg.offer}`,
    tg.tone && `Tonalität/Ansprache: ${tg.tone}`,
    tg.cta && `Gewünschter nächster Schritt (CTA): ${tg.cta}`,
    `Sprache der Mails: ${tg.language === "en" ? "Englisch" : "Deutsch"}`,
    tg.profile && `\n## Zielgruppen-Profil (verdichtetes Wissen)\n${tg.profile}`
  ].filter(Boolean);
  if (includeKnowledge && !tg.profile) {
    const k = knowledgeTexts("target_group_id", tg.id, 30000);
    if (k) parts.push(`\n## Wissen (Info-Blätter)\n${k}`);
  }
  return parts.join("\n");
}

export function productBlock(product, { includeKnowledge = true, withLinks = false } = {}) {
  if (!product) return "";
  const settings = getSettings();
  const booking = product.booking_url || settings.booking_url;
  const parts = [
    `# Produkt: ${product.name}`,
    product.description && `Beschreibung: ${product.description}`,
    product.offer && `Angebot / Nutzenversprechen: ${product.offer}`,
    product.icp && `Ideale Kunden (Wer passt, wer nicht): ${product.icp}`,
    product.proof && `Belege (Referenzen, Zahlen – nur diese verwenden): ${product.proof}`,
    booking ? (withLinks ? `Terminlink: ${booking}` : "Terminlink: vorhanden – als Platzhalter {{termin_link}} einsetzen") : "Terminlink: (keiner hinterlegt – stattdessen nach einem passenden Zeitpunkt für ein kurzes Telefonat fragen)",
    product.kit_url ? (withLinks ? `Info-Kit (${product.kit_label || "Info-Kit"}): ${product.kit_url}` : `Info-Kit „${product.kit_label || "Info-Kit"}“: vorhanden – als Platzhalter {{kit_link}} einsetzen`) : "",
    product.profile && `\n## Produkt-Profil (verdichtetes Wissen)\n${product.profile}`
  ].filter(Boolean);
  if (includeKnowledge && !product.profile) {
    const k = knowledgeTexts("product_id", product.id, 30000);
    if (k) parts.push(`\n## Produkt-Wissen (Info-Blätter)\n${k}`);
  }
  return parts.join("\n");
}

// Eigene Regeln. Das Handwerk (Aufbau, Einstiegsangebot, Längen, Nachfass-Logik) ist aus einem Cold-Mailing-
// Coaching übernommen; was dort in Deutschland heikel oder unehrlich ist, ist bewusst ausgeschlossen (Schein-Gespräch im
// Betreff, erfundene Verknappung und Referenzen, „ist morgen fertig“-Versprechen, Bilder/Tracking in der ersten Mail).
const COLD_MAIL_RULES = `# Regeln für B2B-Mails (verbindlich)
- Die Mail verkauft nicht, sie ist der Aufhänger für ein Gespräch oder Telefonat. Schreibe über den Empfänger, nicht über uns („Sie bekommen …“ statt „Wir sind ein führender Anbieter …“).
- Aufbau der ersten Mail: Anrede → individueller Bezug zu genau dieser Firma (1–2 Sätze) → Einstiegsangebot (was bekommt der Empfänger konkret, ohne Aufwand für ihn) → kurz warum bzw. ein belegter Beweis → EINE leichte Handlung, am liebsten „kurz antworten“.
- Einstiegsangebot statt Verkaufsangebot: konkret („kurze Einschätzung Ihrer Startseite mit drei Hebeln“ statt „kostenlose Beratung“), ohne Risiko und ohne Verpflichtung, keine Preise, keine Bestellseite. Nur anbieten, was wir laut Wissen wirklich liefern.
- Längen: erste Mail 60–120 Wörter, Nachhaken 30–50, Mehrwert 50–80, Abschluss 30–60. Fließtext in kurzen Absätzen, keine Aufzählungen, kein Fettdruck, keine Emojis, keine Gedankenstriche als Stilmittel (lieber Komma oder Punkt).
- Betreff: 2–5 Wörter, persönlich (Vorname oder Firma), kein Clickbait.
- Keine Links, Bilder oder Anhänge in der ersten Mail.
- Keine erfundenen Fakten, Zahlen, Kunden, Referenzen oder Garantien. Belege und Garantien nur, wenn sie im Wissen stehen.
- Nichts ankündigen, was es nicht gibt („ich habe schon ein Video für Sie aufgenommen“). Ehrlich anbieten: „Soll ich Ihnen das kurz zusammenstellen?“
- Keine falsche Vertrautheit: kein „Re:“/„AW:“, kein „Unser Gespräch“, „wie besprochen“, „unser Telefonat“ oder „Ihre Anfrage“, wenn es das nicht gab.
- Kein Druck, keine künstliche Verknappung („nur noch 3 Plätze“) und keine Fristen, die es nicht wirklich gibt. Keine Spam-Wörter (kostenlos, gratis, garantiert, Angebot nur heute, 100 % usw.); was nichts kostet, heißt „auf unsere Kosten“ oder „ohne Kosten für Sie“.
- Keine Signatur und keinen Abmelde-Hinweis schreiben – beides fügt das System automatisch an.
- Deutsch: Sie-Form, wenn die Tonalität nichts anderes sagt. Rechtschreibung nach Duden, typografische Anführungszeichen „…“.`;

// Einstiegsangebote („Marketing Offer“): Die erste Mail bietet etwas Konkretes, für das der Empfänger nur antworten muss.
export const OFFER_TYPES = {
  question: { label: "Offene Frage zum Bedarf", hint: "Eine konkrete Frage, ob das Thema gerade dran ist – ohne Angebot. Am zurückhaltendsten." },
  deliverable: { label: "Konkrete Einschätzung / Beispiel", hint: "Z. B. kurze Einschätzung mit drei Hebeln. Wird erst erstellt, wenn jemand antwortet – nie behaupten, es sei schon fertig." },
  partial: { label: "Erster Baustein auf unsere Kosten", hint: "Ein klar umrissener erster Baustein ohne Kosten und ohne Verpflichtung – nur, wenn wir das wirklich anbieten." },
  pilot: { label: "Pilotkunden gesucht", hint: "Nur bei einem echten Pilotprogramm; eine Begrenzung nur nennen, wenn es sie wirklich gibt." },
  funding: { label: "Förderung", hint: "Nur bei belegter Förderfähigkeit; nichts zusagen, was die Förderstelle entscheidet." },
  partner: { label: "Partner gesucht", hint: "Augenhöhe statt Verkauf – für echte Kooperationen (z. B. Empfehlungen, regionale Partner)." },
  meeting: { label: "Kurzes Erstgespräch", hint: "Funktioniert nur mit starken, belegten Ergebnissen." }
};

// Aufbau einer Sequenz: Eskalation Nachhaken → Mehrwert → Relevanz → Abschluss. Jede Mail hat genau eine Aufgabe.
const ROLE_TEXT = {
  entry: "Erste Mail (60–120 Wörter, trägt die ganze Botschaft und muss allein funktionieren): Anrede, individueller Bezug, Einstiegsangebot, kurz warum bzw. ein belegter Beweis, EINE leichte Handlung. Kurzer Betreff, kein Link.",
  reminder: "Kurzes Nachhaken (30–50 Wörter): freundlich fragen, ob die Mail im Alltag untergegangen ist. Kein neues Argument, das Angebot nicht wiederholen, kurze Bitte um Rückmeldung.",
  aspect: "Mehrwert (50–80 Wörter): GENAU EIN neuer Aspekt – ein belegtes Beispiel, ein Ergebnis oder ein anderer Nutzen (jedes Mal ein anderer). Kein zweiter Pitch, das Angebot nicht wiederholen.",
  relevance: "Relevanz-Frage (40–60 Wörter): ehrlich fragen, ob das Thema gerade überhaupt dran ist oder ein späterer Zeitpunkt besser passt. Dringlichkeit nur bei einem echten Anlass oder einer echten Frist aus den Hinweisen.",
  breakup: "Abschluss (30–60 Wörter, eigener kurzer Betreff wie „Letzter Versuch“): Da keine Antwort kam, passt es vermutlich gerade nicht – völlig in Ordnung. Sagen, dass wir uns nicht mehr melden, Tür offen lassen, kein Druck."
};
const ROLE_DELAY = { reminder: 3, aspect: 5, relevance: 7, breakup: 7 };
export function sequenceRoles(count) {
  const plans = { 1: ["entry"], 2: ["entry", "breakup"], 3: ["entry", "aspect", "breakup"], 4: ["entry", "reminder", "aspect", "breakup"], 5: ["entry", "reminder", "aspect", "relevance", "breakup"], 6: ["entry", "reminder", "aspect", "relevance", "aspect", "breakup"] };
  return plans[count] || plans[3];
}

const SCENARIOS = {
  consent: "Die Empfänger haben ausdrücklich eingewilligt, Informationen von uns per E-Mail zu erhalten (z. B. Anfrage, Messe-Kontakt mit Einwilligung, Bestandskunde). Die erste Mail knüpft daran an, ohne zu übertreiben.",
  cold: "Die Empfänger kennen uns nicht. Die Mails müssen deshalb besonders zurückhaltend, kurz und relevant sein: höchstens 3 Mails, große Abstände, keine Werbesprache, sofort respektieren, wenn kein Interesse besteht."
};

// ---------- Wissen verdichten ----------

const DISTILL_SECTIONS = {
  target_group: [
    "## Wer sie sind (Branche, Größe, Rollen der Entscheider)",
    "## Typische Situation & Schmerzpunkte",
    "## Ziele & Auslöser (wann sie kaufen)",
    "## Unser Nutzen für sie (konkrete Argumente)",
    "## Belege (Referenzen, Zahlen, Beispiele – nur was im Material steht)",
    "## Häufige Einwände & gute Antworten",
    "## Ansprache & Tonalität (Sie/Du, Fachbegriffe, was gut ankommt)",
    "## Vermeiden",
    "## Mögliche nächste Schritte (CTAs)"
  ],
  product: [
    "## Was das Produkt ist (in einem Satz)",
    "## Für wen es passt – und für wen nicht (Ausschlusskriterien)",
    "## Probleme, die es löst",
    "## Nutzen & Ergebnisse (konkret, messbar, wenn belegt)",
    "## Belege (Referenzen, Zahlen, Beispiele – nur was im Material steht)",
    "## Ablauf / Einstieg (wie man startet, was der Kunde tun muss)",
    "## Häufige Einwände & gute Antworten",
    "## Was im Info-Kit steht / was man im Termin klärt",
    "## Vermeiden (Aussagen, die wir nicht machen dürfen)"
  ]
};

export async function distillKnowledge(kind, id) {
  const isProduct = kind === "product";
  const table = isProduct ? "products" : "target_groups";
  const column = isProduct ? "product_id" : "target_group_id";
  const label = isProduct ? "Produkt" : "Zielgruppe";
  const row = q.get(`SELECT * FROM ${table} WHERE id = ?`, id);
  if (!row) throw new AiError(`${label} nicht gefunden`);
  const docs = q.all(`SELECT * FROM knowledge_docs WHERE ${column} = ? ORDER BY id`, id);
  if (!docs.length && !row.description && !row.offer) throw new AiError("Noch kein Wissen hinterlegt – zuerst Info-Blätter hochladen oder Text einfügen.");
  const content = [];
  let pdfBytes = 0;
  for (const d of docs) {
    if (d.kind === "pdf" && d.data && pdfBytes + d.size < 25 * 1024 * 1024) {
      pdfBytes += d.size;
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(d.data).toString("base64") }, title: d.title });
    }
  }
  const texts = knowledgeTexts(column, id, 150000);
  content.push({
    type: "text",
    text: [
      `${label}: ${row.name}`,
      row.description && `Beschreibung: ${row.description}`,
      row.offer && `Angebot: ${row.offer}`,
      isProduct && row.icp && `Ideale Kunden: ${row.icp}`,
      isProduct && row.proof && `Belege: ${row.proof}`,
      texts && `Info-Blätter (Text):\n${texts}`,
      "",
      isProduct
        ? "Verdichte alles Wissen über dieses Produkt zu einem Profil, das als Grundlage für Vertriebs-Mails, Nachfass-Mails und Telefonate dient."
        : "Verdichte alles Wissen über diese Zielgruppe zu einem Profil, das als Grundlage für Vertriebs-Mails dient.",
      "Gliedere das Profil in Markdown mit diesen Abschnitten (kurze Stichpunkte, keine Floskeln):",
      ...DISTILL_SECTIONS[isProduct ? "product" : "target_group"],
      "Erfinde nichts. Fehlt etwas im Material, schreibe „(keine Angaben)“."
    ].filter(Boolean).join("\n")
  });
  const result = await callJson({
    system: ["Du bist eine erfahrene B2B-Vertriebsstrategin im deutschsprachigen Mittelstand. Du verdichtest Vertriebsunterlagen präzise und ehrlich.", senderBlock()],
    content,
    schema: {
      type: "object",
      properties: {
        profile_markdown: { type: "string" },
        suggested_tone: { type: "string" },
        suggested_cta: { type: "string" }
      },
      required: ["profile_markdown", "suggested_tone", "suggested_cta"],
      additionalProperties: false
    },
    maxTokens: 12000,
    effort: "medium"
  });
  const now = Date.now();
  if (isProduct) {
    q.run("UPDATE products SET profile = ?, updated_at = ? WHERE id = ?", result.profile_markdown, now, id);
  } else {
    q.run("UPDATE target_groups SET profile = ?, profile_updated_at = ?, tone = CASE WHEN tone = '' THEN ? ELSE tone END, cta = CASE WHEN cta = '' THEN ? ELSE cta END, updated_at = ? WHERE id = ?",
      result.profile_markdown, now, result.suggested_tone || "", result.suggested_cta || "", now, id);
  }
  return result;
}

// ---------- Sequenz + Nachfass-Texte generieren ----------

export async function generateSequence({ targetGroupId = null, productId = null } = {}, { steps = 3, goal = "", notes = "", legalBasis = "consent", offerType = "", entryOffer = "" } = {}) {
  const tg = targetGroupId ? q.get("SELECT * FROM target_groups WHERE id = ?", targetGroupId) : null;
  if (targetGroupId && !tg) throw new AiError("Zielgruppe nicht gefunden");
  const product = productId ? q.get("SELECT * FROM products WHERE id = ?", productId) : null;
  if (productId && !product) throw new AiError("Produkt nicht gefunden");
  if (!tg && !product) throw new AiError("Zielgruppe oder Produkt angeben");
  const cold = legalBasis === "cold";
  const maxSteps = cold ? 3 : 6;
  const count = Math.min(maxSteps, Math.max(1, Number(steps) || 3));
  const minDelay = cold ? 4 : 2;
  const hasBooking = !!(product?.booking_url || getSettings().booking_url);
  const hasKit = !!product?.kit_url;
  const roles = sequenceRoles(count);
  const offer = OFFER_TYPES[offerType] || null;
  const result = await callJson({
    system: [
      "Du schreibst E-Mail-Sequenzen für den B2B-Vertrieb, die Antworten bekommen – ehrlich, kurz, relevant und rechtlich sauber.",
      COLD_MAIL_RULES,
      `# Ausgangslage\n${SCENARIOS[cold ? "cold" : "consent"]}`,
      senderBlock(),
      productBlock(product),
      targetGroupBlock(tg)
    ].filter(Boolean),
    content: [
      `Schreibe eine Sequenz mit genau ${count} Mails${product ? ` für das Produkt „${product.name}“` : ""}${tg ? ` an die Zielgruppe „${tg.name}“` : ""}.`,
      goal && `Ziel der Kampagne: ${goal}`,
      notes && `Zusätzliche Hinweise: ${notes}`,
      offer || entryOffer ? `Einstiegsangebot: ${offer ? `${offer.label} (${offer.hint})` : "frei"}${entryOffer ? `\nKonkret: ${entryOffer}` : ""}` : "Einstiegsangebot: aus Produkt-Profil und Zielgruppe ableiten – das konkreteste, das wir ehrlich liefern können.",
      "",
      "Aufbau (Reihenfolge fest, jede Mail hat genau eine Aufgabe):",
      ...roles.map((r, i) => `- Mail ${i + 1}: ${ROLE_TEXT[r]}`),
      "",
      "Technische Vorgaben:",
      "- Verfügbare Variablen: {{anrede}} (förmlich, z. B. „Sehr geehrter Herr Müller“), {{hallo}} (locker, „Hallo Max“), {{first_name}}, {{last_name}}, {{company}}, {{position}}, {{city}}, {{industry}}, {{sender_first_name}}, {{produkt}}" +
        `${hasBooking ? ", {{termin_link}}" : ""}${hasKit ? ", {{kit_link}}, {{kit_name}}" : ""}. Nur diese verwenden.`,
      "- Die erste Zeile jeder Mail ist die Anrede mit Komma, z. B. „{{anrede}},“.",
      "- Optional Spintax für kleine Variationen: {Variante A|Variante B}. Sparsam einsetzen.",
      hasKit ? "- Ab Mail 2 darf einmal das Info-Kit angeboten werden: „{{kit_link}}“ (nur als Angebot, nicht aufdrängen)." : "",
      hasBooking ? "- Ab Mail 2 darf einmal der Terminlink angeboten werden: „{{termin_link}}“ – als Alternative zur kurzen Antwort, nicht als Hauptaufforderung." : "- Als nächsten Schritt nach einer kurzen Antwort oder einem kurzen Telefonat fragen (kein Terminlink vorhanden).",
      "- Mails zwischen der ersten und der Abschluss-Mail laufen als Antwort im selben Thread: Betreff als leeren String \"\" zurückgeben. Nur die Abschluss-Mail bekommt einen eigenen kurzen Betreff.",
      `- delay_days: Tage Abstand zur vorherigen Mail (Mail 1: 0; danach mindestens ${minDelay}; Richtwerte: ${roles.slice(1).map(r => `${ROLE_DELAY[r]}`).join(", ") || "–"}).`,
      "- variant_b_*: eine Alternative für den A/B-Test, die genau EINE Sache ändert (anderer Betreff ODER anderer Einstieg), damit klar ist, was wirkt. Bei Mails im selben Thread ebenfalls leerer Betreff.",
      "",
      "Zusätzlich: Nachfass-Mails für Empfänger, die bereits Interesse gezeigt haben, sich danach aber nicht mehr melden (z. B. „klingt interessant, schicken Sie mal Infos“ – und dann Funkstille).",
      "- Schreibe genau 2 kurze Nachfass-Mails (je 30–70 Wörter), die als Antwort im Gespräch gesendet werden: freundlich an das gezeigte Interesse anknüpfen, einen konkreten nächsten Schritt anbieten" +
        `${hasBooking ? " ({{termin_link}})" : " (kurzes Telefonat, zwei Zeitfenster vorschlagen)"}${hasKit ? ", ggf. das Info-Kit ({{kit_link}})" : ""}, kein Druck. Die zweite ist ein letztes, höfliches Nachhaken.`,
      "- Nachfass-Mails beginnen ebenfalls mit der Anrede („{{anrede}},“) und haben keinen Betreff.",
      "",
      "Gib außerdem einen kurzen Kampagnennamen zurück."
    ].filter(Boolean).join("\n"),
    schema: {
      type: "object",
      properties: {
        campaign_name: { type: "string" },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              delay_days: { type: "number" },
              subject: { type: "string" },
              body: { type: "string" },
              variant_b_subject: { type: "string" },
              variant_b_body: { type: "string" }
            },
            required: ["delay_days", "subject", "body", "variant_b_subject", "variant_b_body"],
            additionalProperties: false
          }
        },
        nurture: {
          type: "array",
          items: {
            type: "object",
            properties: { body: { type: "string" } },
            required: ["body"],
            additionalProperties: false
          }
        }
      },
      required: ["campaign_name", "steps", "nurture"],
      additionalProperties: false
    },
    maxTokens: 20000,
    effort: "high"
  });
  const stripRe = s => String(s || "").replace(/^\s*((re|aw|fw|wg|fwd)\s*:\s*)+/i, "").trim();
  result.steps = (result.steps || []).slice(0, count).map((s, i) => ({
    delay_days: i === 0 ? 0 : Math.max(minDelay, Math.round(Number(s.delay_days) || ROLE_DELAY[roles[i]] || (cold ? 5 : 3))),
    subject: i === 0 ? stripRe(s.subject) : (s.subject || ""),
    body: s.body,
    variant_b_subject: i === 0 ? stripRe(s.variant_b_subject) : (s.variant_b_subject || ""),
    variant_b_body: s.variant_b_body
  }));
  result.nurture = (result.nurture || []).slice(0, 3).map(n => ({ body: String(n.body || "").trim() })).filter(n => n.body);
  return result;
}

// ---------- Einstiegsangebote vorschlagen ----------

// Ideen für das Einstiegsangebot der ersten Mail – geprüft auf „würde ich antworten?“, „nur antworten nötig“, „konkret“
// und darauf, dass wir es wirklich liefern können (Aufwand je Antwort realistisch, keine erfundenen Garantien).
export async function suggestEntryOffers(product, { targetGroupId = null, notes = "" } = {}) {
  if (!product) throw new AiError("Produkt fehlt");
  const tg = targetGroupId ? q.get("SELECT * FROM target_groups WHERE id = ?", targetGroupId) : null;
  const res = await callJson({
    system: [
      "Du entwickelst Einstiegsangebote für B2B-Kaltmails im deutschsprachigen Mittelstand. Ein Einstiegsangebot ist kein Verkaufsangebot: Der Empfänger bekommt etwas Konkretes und muss dafür nur antworten.",
      COLD_MAIL_RULES,
      senderBlock(),
      productBlock(product, { includeKnowledge: true }),
      targetGroupBlock(tg)
    ].filter(Boolean),
    content: [
      `Entwickle 5 verschiedene Einstiegsangebote für „${product.name}“${tg ? ` und die Zielgruppe „${tg.name}“` : ""}.`,
      notes && `Hinweise: ${notes}`,
      `Nutze möglichst verschiedene Arten: ${Object.entries(OFFER_TYPES).map(([k, o]) => `${k} = ${o.label}`).join("; ")}.`,
      "Jedes Angebot muss alle drei Prüfungen bestehen: 1. Würde ein beschäftigter Geschäftsführer darauf antworten? 2. Er muss nichts tun außer antworten (kein Formular, kein Download). 3. Konkret statt allgemein.",
      "Außerdem: nur, was wir laut Wissen wirklich liefern können; Aufwand pro Antwort realistisch einschätzen; keine Garantie, Zahl oder Referenz, die nicht im Wissen steht; keine erfundene Begrenzung.",
      "text ist der Kern-Satz, so wie er in der Mail stehen könnte (Sie-Form, ohne Spam-Wörter). why erklärt in einem Satz, warum es für diese Zielgruppe zieht. effort ist der Aufwand für uns je Antwort. caution nennt, worauf man achten muss (oder leer)."
    ].filter(Boolean).join("\n"),
    schema: {
      type: "object",
      properties: {
        offers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: Object.keys(OFFER_TYPES) },
              title: { type: "string" }, text: { type: "string" }, why: { type: "string" }, effort: { type: "string" }, caution: { type: "string" }
            },
            required: ["type", "title", "text", "why", "effort", "caution"],
            additionalProperties: false
          }
        }
      },
      required: ["offers"],
      additionalProperties: false
    },
    maxTokens: 6000,
    effort: "medium"
  });
  return (res.offers || []).slice(0, 6).map(o => ({
    type: OFFER_TYPES[o.type] ? o.type : "question", title: cleanAiText(o.title), text: cleanAiText(o.text), why: cleanAiText(o.why), effort: cleanAiText(o.effort), caution: cleanAiText(o.caution)
  })).filter(o => o.text);
}

// ---------- Lead prüfen (Passung + Anlass) ----------

export async function leadResearch(lead) {
  let site = lead.website;
  if (!site && lead.email && !isFreemail(lead.email)) site = lead.email.split("@")[1];
  if (!site) return "";
  const text = await fetchWebsiteText(site).catch(() => null);
  return text ? text.slice(0, 3500) : "";
}

function leadFacts(lead) {
  const custom = parseJson(lead.custom, {}) || {};
  // Nur die Domain der Adresse (nicht die vollständige E-Mail) – reicht zur Einordnung der Firma.
  const domain = String(lead.email || "").split("@")[1] || "";
  const facts = {
    Anrede: lead.salutation, Vorname: lead.first_name, Nachname: lead.last_name, Firma: lead.company, Position: lead.position,
    "E-Mail-Domain": isFreemail(lead.email) ? `${domain} (privater Mail-Anbieter)` : domain,
    Website: lead.website, Stadt: lead.city, Land: lead.country, Branche: lead.industry, LinkedIn: lead.linkedin, Notizen: lead.notes, ...custom
  };
  return Object.entries(facts).filter(([, val]) => val !== undefined && val !== null && String(val).trim() !== "").map(([k, val]) => `${k}: ${String(val).slice(0, 500)}`).join("\n");
}

// Bewertet, ob ein Lead zum Produkt passt (A–D) und formuliert den konkreten Anlass, warum er für ihn relevant ist.
export async function qualifyLead(lead, product, { research } = {}) {
  if (!product) throw new AiError("Produkt fehlt");
  const site = research ?? await leadResearch(lead);
  const result = await callJson({
    system: [
      "Du prüfst für den B2B-Vertrieb, ob ein Unternehmen zu einem Produkt passt. Sei streng und ehrlich: Lieber „C“ oder „D“ als ein falsches „A“. Qualität vor Menge.",
      senderBlock(),
      productBlock(product, { includeKnowledge: true })
    ],
    content: [
      `# Lead\n${leadFacts(lead)}`,
      lead.account_id ? `\n${brainText(lead.account_id, { maxChars: 3000 })}` : "",
      `\n# Website-Auszug\n${site || "(nicht verfügbar)"}`,
      "\nBewerte die Passung:",
      "- A: passt eindeutig zum idealen Kunden, konkreter Bedarf erkennbar",
      "- B: passt zum idealen Kunden, Bedarf plausibel",
      "- C: unklar – zu wenige Informationen oder nur teilweise passend",
      "- D: passt nicht (Ausschlusskriterium, falsche Branche/Größe, Privatperson, Wettbewerber)",
      "reason: Ein sachlicher Satz (max. 25 Wörter), warum das Produkt für genau diese Firma relevant ist – nur mit Fakten aus Lead-Daten oder Website. Bei C/D: warum nicht bzw. was fehlt.",
      "Nichts erfinden."
    ].join("\n"),
    schema: {
      type: "object",
      properties: { fit: { type: "string", enum: Object.keys(FIT_LABELS) }, reason: { type: "string" } },
      required: ["fit", "reason"],
      additionalProperties: false
    },
    maxTokens: 1500,
    effort: "low"
  });
  const fit = FIT_LABELS[result.fit] ? result.fit : "C";
  const reason = String(result.reason || "").trim().slice(0, 500);
  q.run(`INSERT INTO lead_fit (lead_id, product_id, fit, reason, checked_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(lead_id, product_id) DO UPDATE SET fit = excluded.fit, reason = excluded.reason, checked_at = excluded.checked_at`, lead.id, product.id, fit, reason, Date.now());
  if (["A", "B"].includes(fit) && reason && !String(lead.reason || "").trim()) {
    q.run("UPDATE leads SET reason = ?, updated_at = ? WHERE id = ?", reason, Date.now(), lead.id);
  }
  return { fit, reason };
}

// ---------- Personalisierung je Lead ----------

// Links und Produktname bleiben als Platzhalter erhalten, damit die KI sie nicht verändert oder erfindet.
const PROTECTED = ["termin_link", "kit_link", "kit_name", "produkt", "unsubscribe_url"];
const protectToken = name => `[[${name.toUpperCase()}]]`;

function protectVars(text) {
  let out = String(text || "");
  for (const name of PROTECTED) out = out.replace(new RegExp(`\\{\\{\\s*${name}\\s*(\\|[^{}]*)?\\}\\}`, "gi"), protectToken(name));
  return out;
}

function cleanAiText(s) {
  // KI-Text darf keine Vorlagen-Syntax enthalten (würde sonst als Spintax/Variable interpretiert) – außer den geschützten Platzhaltern.
  let out = String(s || "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\{([^{}]*)\}/g, (_, inner) => inner.split("|")[0])
    .replace(/[{}]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  for (const name of PROTECTED) out = out.split(protectToken(name)).join(`{{${name}}}`);
  return out.replace(/\[\[[A-Z_]+\]\]/g, "");
}

// Einstiegssatz: immer etwas Gutes, das uns an genau dieser Firma aufgefallen ist – konkret, belegt, menschlich.
export const FIRST_LINE_TASK = [
  "Schreibe EINEN Einstiegssatz (12–30 Wörter), der direkt nach der Anrede steht. Er benennt eine konkrete gute Sache, die uns an genau dieser Firma aufgefallen ist, und führt locker zum Anliegen der Mail.",
  "Wähle die gute Sache in dieser Reihenfolge – die erste, zu der es echte Belege im Website-Auszug, in den Lead-Daten oder im Account Brain gibt:",
  "1. ein konkretes Referenzprojekt, eine Kundenstimme oder Bewertung (sinngemäß, nicht wörtlich zitieren),",
  "2. eine Spezialisierung, besondere Leistung, Auszeichnung oder Zertifizierung,",
  "3. Tradition, Familienbetrieb, Jubiläum, Ausbildungsbetrieb, Engagement in der Region,",
  "4. Größe, Wachstum (z. B. offene Stellen) oder Einsatzgebiet.",
  "So klingt es menschlich: wie ein aufmerksamer Mensch, der kurz auf der Website war – einfach, konkret, ohne Übertreibung. Abwechslungsreich formulieren, nicht jedes Mal „Mir ist aufgefallen“.",
  "Verboten: Superlative und leeres Lob („beeindruckend“, „großartig“, „toll“, „spannend“), „Ich bin auf Ihre Website gestoßen“, „Ich hoffe, es geht Ihnen gut“, Gedankenstriche, Ausrufezeichen, Links, Kritik an der Firma, erfundene Details.",
  "Keine Frage stellen und nichts anbieten – Frage und Angebot stehen schon im nächsten Absatz der Mail.",
  "Wenn es keinen echten Beleg gibt: ein freundlicher, wahrer Satz zu Branche und Ort (z. B. was Betriebe dieser Art in der Region gerade beschäftigt) – nie etwas behaupten, das nicht belegt ist."
].join("\n");

// Was einen Einstiegssatz nach KI klingen lässt – wird verworfen und neu geschrieben.
const ROBOTIC = /(beeindruckend|großartig|grossartig|fantastisch|hervorragend|herausragend|toll\b|spannend|bin auf ihre .{0,20}gestoßen|ich hoffe,? (es geht|diese)|!|—|\s–\s|\?)/i;
export function roboticIssues(line) {
  const m = ROBOTIC.exec(String(line || ""));
  return m ? `Klingt nicht menschlich: „${m[0].trim()}“ – schlicht und konkret formulieren, ohne Ausrufezeichen, Gedankenstriche, Fragen oder Superlative.` : "";
}

export async function ensurePersonalization({ campaign, steps, cl, lead, mailbox, stepIndex, variantKey, force = false }) {
  const ai = parseJson(cl.ai, {}) || {};
  if (!force) {
    // Auch ein von der Qualitätsprüfung verworfener Satz ("") gilt als erledigt – sonst würde bei jedem Versuch neu generiert.
    if (campaign.ai_mode === "first_line" && (ai.first_line || (ai.qa && ai.first_line === ""))) return ai;
    if (campaign.ai_mode === "full" && (ai.steps?.[stepIndex] || (ai.qa_failed || []).includes(stepIndex))) return ai;
  }
  const tg = campaign.target_group_id ? q.get("SELECT * FROM target_groups WHERE id = ?", campaign.target_group_id) : null;
  const product = campaign.product_id ? q.get("SELECT * FROM products WHERE id = ?", campaign.product_id) : null;
  if (ai.research === undefined) ai.research = await leadResearch(lead);
  const language = tg?.language || "de";
  const system = [
    "Du personalisierst B2B-Mails für einzelne Empfänger. Du schreibst wie ein aufmerksamer Mensch, der sich 2 Minuten mit der Firma beschäftigt hat.",
    COLD_MAIL_RULES,
    senderBlock(),
    productBlock(product),
    targetGroupBlock(tg, { includeKnowledge: true }),
    campaign.ai_instructions ? `# Hinweise zur Kampagne\n${campaign.ai_instructions}` : ""
  ].filter(Boolean);
  const reason = String(lead.reason || "").trim();
  const brain = lead.account_id ? brainText(lead.account_id, { maxChars: 4000 }) : "";
  const leadInfo = `# Empfänger\n${leadFacts(lead) || "(nur E-Mail-Adresse bekannt)"}${reason ? `\nAnlass/Relevanz: ${reason}` : ""}${brain ? `\n\n${brain}\n(Nur Fakten aus dem Account Brain als Tatsache nennen; Hypothesen höchstens als Frage; „NICHT BEHAUPTEN“ und widerlegte Annahmen nie verwenden.)` : ""}\n\n# Website-Auszug\n${ai.research || "(nicht verfügbar)"}`;
  const qaContext = { accountId: lead.account_id || null, productId: product?.id || null, lead };

  if (campaign.ai_mode === "first_line") {
    const ask = feedback => callJson({
      system,
      content: `${leadInfo}${feedback ? `\n\nDein letzter Vorschlag wurde von der Qualitätsprüfung abgelehnt:\n${feedback}\nSchreibe einen neuen Satz ohne diese Punkte.` : ""}\n\n${FIRST_LINE_TASK}\n${language === "en" ? "Write in English." : "Auf Deutsch, Sie-Form, sofern die Tonalität nichts anderes sagt."}`,
      schema: { type: "object", properties: { first_line: { type: "string" } }, required: ["first_line"], additionalProperties: false },
      maxTokens: 2000,
      effort: "low"
    });
    const clean = r => cleanAiText(r.first_line).replace(/\{\{[^}]*\}\}/g, "").trim();
    const review = l => { const q1 = checkMessage({ body: l }, qaContext); const robot = roboticIssues(l); return robot ? { ...q1, ok: false, issues: [...q1.issues, { type: "tone", severity: "block", text: robot }] } : q1; };
    let line = clean(await ask(""));
    let qa = review(line);
    if (!qa.ok) {
      line = clean(await ask(qaFeedback(qa)));
      qa = review(line);
    }
    ai.qa = { ...qa, step: stepIndex };
    // Fällt auch der zweite Versuch durch, bleibt der Einstiegssatz leer (Mail geht dann ohne bzw. wird übersprungen).
    ai.first_line = qa.ok ? line : "";
  } else if (campaign.ai_mode === "full") {
    const step = steps[stepIndex];
    const variant = (step.variants || []).find(v => v.key === variantKey) || step.variants[0];
    const vars = buildVars({ lead, mailbox, ai, language });
    const tplSubject = render(protectVars(variant.subject || ""), vars, `${cl.id}:${stepIndex}:tpl`).text;
    const tplBody = render(protectVars(variant.body || ""), vars, `${cl.id}:${stepIndex}:tplb`).text;
    const previous = q.all("SELECT step, subject, text FROM messages WHERE campaign_lead_id = ? AND direction = 'out' AND kind = 'campaign' ORDER BY created_at", cl.id)
      .map(m => `Mail ${m.step + 1} (bereits gesendet), Betreff: ${m.subject}\n${String(m.text).split("\n\n").slice(0, 6).join("\n\n")}`).join("\n\n---\n\n");
    const tokens = PROTECTED.map(protectToken).filter(t => tplBody.includes(t) || tplSubject.includes(t));
    const ask = feedback => callJson({
      system,
      content: [
        leadInfo,
        previous ? `\n# Bisher gesendete Mails an diesen Empfänger\n${previous}` : "",
        feedback ? `\n# Qualitätsprüfung hat deinen letzten Entwurf abgelehnt\n${feedback}\nSchreibe die Mail ohne diese Punkte neu.` : "",
        `\n# Vorlage für Mail ${stepIndex + 1} (Leitplanke)\nBetreff: ${tplSubject || "(leer = Antwort im selben Thread)"}\n\n${tplBody}`,
        "\nSchreibe diese Mail für genau diesen Empfänger neu. Behalte Anrede, Kernaussage, Länge (±20 %) und die Abschlussfrage der Vorlage bei, mache Einstieg und Nutzen aber konkret für diese Firma. Ist der Betreff der Vorlage leer, gib einen leeren Betreff zurück. Keine Signatur, keine Links oder URLs, die nicht in der Vorlage stehen.",
        tokens.length ? `Platzhalter ${tokens.join(", ")} genau so (mit eckigen Klammern) unverändert übernehmen – sie werden beim Versand durch die echten Links/Namen ersetzt.` : "",
        language === "en" ? "Write in English." : ""
      ].filter(Boolean).join("\n"),
      schema: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } }, required: ["subject", "body"], additionalProperties: false },
      maxTokens: 4000,
      effort: "low"
    });
    const template = `${tplSubject}\n${tplBody}`;
    let result = await ask("");
    let qa = checkMessage({ subject: result.subject, body: result.body }, { ...qaContext, template });
    if (!qa.ok) {
      result = await ask(qaFeedback(qa));
      qa = checkMessage({ subject: result.subject, body: result.body }, { ...qaContext, template });
    }
    ai.qa = { ...qa, step: stepIndex };
    let body = cleanAiText(result.body);
    // Fehlt ein Link-Platzhalter aus der Vorlage im KI-Text, wird er angehängt – Termin- und Kit-Link gehen nie verloren.
    for (const name of ["termin_link", "kit_link"]) {
      if (tplBody.includes(protectToken(name)) && !body.includes(`{{${name}}}`)) body += `\n\n{{${name}}}`;
    }
    ai.steps = ai.steps || {};
    // Besteht der Text die Prüfung auch im zweiten Versuch nicht, geht die freigegebene Vorlage unverändert raus.
    ai.steps[stepIndex] = qa.ok ? { subject: tplSubject.trim() ? cleanAiText(result.subject).replace(/\{\{[^}]*\}\}/g, "") : "", body } : null;
    // Verworfen merken – sonst würde jeder neue Versuch wieder zwei KI-Anfragen kosten.
    ai.qa_failed = [...new Set([...(ai.qa_failed || []).filter(i => i !== stepIndex), ...(qa.ok ? [] : [stepIndex])])];
  }
  ai.generated_at = Date.now();
  q.run("UPDATE campaign_leads SET ai = ?, ai_attempts = 0 WHERE id = ?", JSON.stringify(ai), cl.id);
  return ai;
}

// ---------- Antworten einordnen ----------

function threadText(conversationId, limit = 6) {
  return q.all("SELECT direction, subject, text, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?", conversationId, limit)
    .reverse()
    .map(m => `${m.direction === "in" ? "EMPFÄNGER" : "WIR"} (${new Date(m.created_at).toISOString().slice(0, 10)}), Betreff: ${m.subject}\n${stripQuoted(m.text).slice(0, 3000)}`)
    .join("\n\n---\n\n");
}

export async function classifyConversation(conversationId) {
  const conv = q.get("SELECT * FROM conversations WHERE id = ?", conversationId);
  if (!conv) throw new AiError("Gespräch nicht gefunden");
  const result = await callJson({
    system: ["Du ordnest Antworten auf B2B-Vertriebsmails präzise ein. Sei konservativ: „interested“ nur bei echtem Interesse, Höflichkeit allein ist kein Interesse.", senderBlock()],
    content: `Verlauf:\n\n${threadText(conversationId)}\n\nOrdne die LETZTE Nachricht des Empfängers ein:\n- interested: zeigt Interesse / möchte mehr wissen / bittet um Unterlagen\n- meeting: möchte ausdrücklich ein Gespräch/einen Termin oder nennt Zeiten\n- question: stellt eine Rückfrage ohne klares Interesse\n- later: aktuell nicht, aber später wieder melden\n- not_interested: kein Interesse / kein Bedarf\n- wrong_person: falscher Ansprechpartner (ggf. Hinweis auf richtige Person)\n- unsubscribe: möchte keine weiteren Mails / widerspricht der Nutzung seiner Daten\n- ooo: Abwesenheitsnotiz\n- other: nichts davon\nGib außerdem eine Zusammenfassung in einem Satz (Deutsch) und den empfohlenen nächsten Schritt zurück. Nennt der Empfänger eine andere Kontaktperson, gib deren E-Mail zurück (sonst leer). Nennt er eine Telefonnummer oder bittet um Rückruf, gib die Nummer zurück (sonst leer).`,
    schema: {
      type: "object",
      properties: {
        label: { type: "string", enum: Object.keys(LABELS) },
        summary: { type: "string" },
        next_step: { type: "string" },
        referral_email: { type: "string" },
        callback_phone: { type: "string" }
      },
      required: ["label", "summary", "next_step", "referral_email", "callback_phone"],
      additionalProperties: false
    },
    maxTokens: 2000,
    effort: "low"
  });
  applyClassification(conv, result);
  return result;
}

export function applyClassification(staleConv, result) {
  // Während der KI-Anfrage kann jemand das Label von Hand gesetzt haben – immer den aktuellen Stand verwenden.
  const conv = q.get("SELECT * FROM conversations WHERE id = ?", staleConv.id) || staleConv;
  const label = LABELS[result.label] ? result.label : "other";
  const summary = [result.summary, result.next_step && `Nächster Schritt: ${result.next_step}`, result.referral_email && `Empfehlung: ${result.referral_email}`, result.callback_phone && `Rückruf: ${result.callback_phone}`].filter(Boolean).join(" ");
  const phone = String(result.callback_phone || "").replace(/[^\d+()\/\s-]/g, "").trim().slice(0, 40);
  if (phone.replace(/\D/g, "").length >= 6) q.run("UPDATE leads SET phone = ?, updated_at = ? WHERE id = ? AND (phone IS NULL OR phone = '')", phone, Date.now(), conv.lead_id);
  if (conv.label_by === "user") q.run("UPDATE conversations SET ai_summary = ?, ai_pending = 0 WHERE id = ?", summary, conv.id);
  else q.run("UPDATE conversations SET label = ?, label_by = 'ai', ai_summary = ?, ai_pending = 0 WHERE id = ?", label, summary, conv.id);
  if (conv.label_by !== "user") onLabel(conv, label, { by: "ai", callback: !!phone });
}

// Engine-Module (Nachfassen, Anrufliste) hängen sich hier ein, ohne zirkuläre Importe.
const labelHooks = [];
export function setLabelHook(fn) {
  if (!labelHooks.includes(fn)) labelHooks.push(fn);
}

export function onLabel(conv, label, meta = {}) {
  if (["interested", "meeting"].includes(label)) {
    if (conv.campaign_lead_id) q.run("UPDATE campaign_leads SET interest = ? WHERE id = ?", label, conv.campaign_lead_id);
    const already = q.get("SELECT 1 FROM events WHERE type = 'interested' AND lead_id = ? AND (campaign_id = ? OR (campaign_id IS NULL AND ? IS NULL))", conv.lead_id, conv.campaign_id, conv.campaign_id);
    if (!already) {
      recordEvent("interested", { campaign_id: conv.campaign_id, lead_id: conv.lead_id, mailbox_id: conv.mailbox_id, data: { label } });
      emitWebhook("lead.interested", { lead: leadPayload(conv.lead_id), label, campaign_id: conv.campaign_id, conversation_id: conv.id });
    }
  } else if (conv.campaign_lead_id) {
    q.run("UPDATE campaign_leads SET interest = ? WHERE id = ?", label, conv.campaign_lead_id);
  }
  if (label === "unsubscribe") markUnsubscribed(conv.lead_id, { source: "reply", campaignId: conv.campaign_id });
  for (const hook of labelHooks) {
    try { hook(conv, label, meta); } catch (err) { console.error("[label-hook]", err); }
  }
}

export async function classifyPendingConversations(limit = 10) {
  const pending = q.all("SELECT id FROM conversations WHERE ai_pending = 1 ORDER BY last_inbound_at LIMIT ?", limit);
  if (!pending.length) return 0;
  if (!aiAvailable() || !getSettings().auto_classify) {
    q.run("UPDATE conversations SET ai_pending = 0 WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(pending.map(p => Number(p.id))));
    return 0;
  }
  let done = 0;
  for (const p of pending) {
    try {
      await classifyConversation(p.id);
      done++;
    } catch (err) {
      // Abo-Limit erreicht: offen lassen und später weitermachen.
      if (err instanceof AiLimitError) break;
      q.run("UPDATE conversations SET ai_pending = 0, ai_summary = ? WHERE id = ?", `KI-Einordnung fehlgeschlagen: ${err.message}`, p.id);
    }
  }
  return done;
}

// ---------- Antwortentwurf ----------

export function conversationContext(conversationId) {
  const conv = q.get("SELECT * FROM conversations WHERE id = ?", conversationId);
  if (!conv) return null;
  const campaign = conv.campaign_id ? q.get("SELECT * FROM campaigns WHERE id = ?", conv.campaign_id) : null;
  const tg = campaign?.target_group_id ? q.get("SELECT * FROM target_groups WHERE id = ?", campaign.target_group_id) : null;
  const product = campaign?.product_id ? q.get("SELECT * FROM products WHERE id = ?", campaign.product_id) : null;
  const lead = q.get("SELECT * FROM leads WHERE id = ?", conv.lead_id);
  const mailbox = conv.mailbox_id ? q.get("SELECT id, from_name, email, signature FROM mailboxes WHERE id = ?", conv.mailbox_id) : null;
  return { conv, campaign, tg, product, lead, mailbox };
}

export async function draftReply(conversationId, { instructions = "", nurture = false } = {}) {
  const ctx = conversationContext(conversationId);
  if (!ctx) throw new AiError("Gespräch nicht gefunden");
  const { tg, product, lead, mailbox } = ctx;
  const links = productVars(product, lead || {}, getSettings());
  const linkInfo = [
    links.termin_link && `Terminlink (genau so verwenden): ${links.termin_link}`,
    links.kit_link && `Info-Kit „${links.kit_name}“ (genau so verwenden): ${links.kit_link}`
  ].filter(Boolean).join("\n");
  const task = nurture
    ? "Der Empfänger hat Interesse gezeigt, sich danach aber nicht mehr gemeldet. Schreibe eine kurze, freundliche Nachfass-Mail (30–70 Wörter): an sein Interesse anknüpfen, EINEN konkreten nächsten Schritt anbieten (Terminlink oder zwei Zeitfenster für ein kurzes Telefonat), kein Druck, kein Vorwurf."
    : "Schreibe die Antwort auf die letzte Nachricht des Empfängers.";
  const result = await callJson({
    system: [
      "Du antwortest im Namen des Absenders auf Antworten von Interessenten. Ziel: ein Gespräch vereinbaren, Fragen ehrlich und knapp beantworten, nie drängen.",
      "Regeln: kurz (40–120 Wörter), menschlich, konkret auf die Nachricht eingehen; bei Interesse den Terminlink anbieten oder 2 Terminvorschläge machen; bittet der Empfänger um Unterlagen, das Info-Kit verlinken; bei Rückfragen nur mit Fakten aus dem Wissen antworten; bei Absage freundlich bedanken und nicht weiter verkaufen. Keine Signatur (wird angefügt). Keine erfundenen Fakten oder Links.",
      senderBlock(),
      productBlock(product, { withLinks: true }),
      targetGroupBlock(tg)
    ].filter(Boolean),
    content: `Absender: ${mailbox?.from_name || ""} <${mailbox?.email || ""}>\nEmpfänger: ${[lead?.salutation, lead?.first_name, lead?.last_name].filter(Boolean).join(" ")} (${lead?.company || ""})\n${linkInfo ? `${linkInfo}\n` : ""}${lead?.account_id ? `\n${brainText(lead.account_id, { maxChars: 3000 })}\n(Nur Fakten als Tatsache, „NICHT BEHAUPTEN“ beachten.)\n` : ""}\nVerlauf:\n\n${threadText(conversationId, 8)}\n\n${instructions ? `Zusätzliche Anweisung: ${instructions}\n\n` : ""}${task}`,
    schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"], additionalProperties: false },
    maxTokens: 3000,
    effort: "medium"
  });
  return { body: String(result.body || "").trim() };
}

// ---------- Copy-Review ----------

export async function reviewCopy({ subject, body, targetGroupId = null, productId = null, legalBasis = "consent" }) {
  const tg = targetGroupId ? q.get("SELECT * FROM target_groups WHERE id = ?", targetGroupId) : null;
  const product = productId ? q.get("SELECT * FROM products WHERE id = ?", productId) : null;
  const qa = checkMessage({ subject, body }, { productId });
  const result = await callJson({
    system: ["Du bist ein strenger, hilfreicher Coach für B2B-Vertriebsmails. Du achtest auch auf rechtlich heikle Formulierungen (irreführende Aussagen, falsche Vertrautheit, Druck).", COLD_MAIL_RULES, `# Ausgangslage\n${SCENARIOS[legalBasis === "cold" ? "cold" : "consent"]}`, senderBlock(), productBlock(product), targetGroupBlock(tg)].filter(Boolean),
    content: `Bewerte diese Mail (Variablen in {{…}} und Spintax {a|b} sind Platzhalter und bleiben erhalten):\n\nBetreff: ${subject || "(leer – Antwort im Thread)"}\n\n${body}\n\nGib eine Note von 0–100, die wichtigsten Verbesserungen (max. 5, konkret), den Creepy-Score (wirkt die Mail überwachend/zu persönlich?), unbelegte Aussagen und eine verbesserte Fassung zurück (Variablen, Links-Platzhalter und Spintax beibehalten; leerer Betreff bleibt leer).`,
    schema: {
      type: "object",
      properties: {
        score: { type: "number" },
        verdict: { type: "string" },
        suggestions: { type: "array", items: { type: "string" } },
        improved_subject: { type: "string" },
        improved_body: { type: "string" },
        creepy_score: { type: "number", description: "0–100: Wie stark wirkt die Mail aufdringlich, überwachend oder zu persönlich? Über 35 nicht senden." },
        unsupported_claims: { type: "array", items: { type: "string" }, description: "Aussagen/Zahlen, die nicht aus Produktwissen oder Lead-Daten belegt sind" }
      },
      required: ["score", "verdict", "suggestions", "improved_subject", "improved_body", "creepy_score", "unsupported_claims"],
      additionalProperties: false
    },
    maxTokens: 6000,
    effort: "medium"
  });
  const creepy = Math.max(qa.creepy_score, Math.round(Number(result.creepy_score) || 0));
  return { ...result, creepy_score: creepy, creepy_threshold: qa.threshold, checks: qa.issues, unsupported_claims: result.unsupported_claims || [] };
}
