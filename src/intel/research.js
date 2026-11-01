// Firmen-Recherche (Intelligence Engine): Website der Firma lesen (Start, Impressum, Über uns, Karriere, News,
// Leistungen) → Claude liefert belegte Fakten, Anlässe (Why Now), Hypothesen, Personen, 4 Scores und den besten Play.
// Harte Regeln: Jede Tatsache braucht eine Quelle aus den gelesenen Seiten, Personen nur mit Nennung auf der Website,
// Fakten / Hypothesen / Vertriebs-Interpretation werden getrennt gespeichert.
import { q, tx, insert, update, parseJson } from "../db.js";
import { callJson, AiError } from "../ai/claude.js";
import { fetchPage, extractLinks, extractSiteText } from "../lib/website.js";
import { getSettings } from "../settings.js";
import { recordEvent } from "../events.js";
import { DAY_MS } from "../lib/time.js";
import { setLifecycle } from "./lifecycle.js";
import { createTask } from "../engine/followup.js";

export const SIGNAL_TYPES = {
  hiring: "Stellen / Wachstum im Team",
  expansion: "Neuer Standort / Halle / Maschine",
  leadership: "Neue Führung",
  digitalization: "Digitalisierung / IT-Projekt",
  growth: "Wachstum / neue Produkte / große Projekte",
  process: "Prozess-Hinweis (z. B. manuelle Abläufe)",
  other: "Sonstiges"
};
export const COMMITTEE_ROLES = {
  economic_buyer: "Entscheider (Budget)",
  champion: "Möglicher Fürsprecher",
  user: "Späterer Nutzer",
  technical: "Technischer Einfluss (IT)",
  gatekeeper: "Assistenz / Zentrale",
  do_not_contact: "Nicht kontaktieren"
};

const PAGE_KINDS = [
  ["impressum", /impressum|imprint|legal-notice/i],
  ["about", /ueber-uns|uber-uns|über uns|about|unternehmen|wir-sind|team|firma|historie|geschichte/i],
  ["career", /karriere|jobs|stellen|career|ausbildung|bewerb|offene-stellen/i],
  ["news", /news|aktuell|presse|blog|neuigkeit|meldung/i],
  ["services", /leistung|produkt|service|angebot|loesung|lösung|kompetenz|portfolio/i]
];

const norm = s => String(s || "").toLowerCase().replace(/[„“"'‚‘’]/g, "").replace(/\s+/g, " ").trim();
const clamp = n => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export function opportunityScore({ fit, pain, timing, contactability }) {
  if ([fit, pain, timing, contactability].some(v => v === null || v === undefined)) return null;
  return Math.round(0.35 * fit + 0.25 * pain + 0.25 * timing + 0.15 * contactability);
}

// Seiten der Firma sammeln. fetcher ist für Tests austauschbar.
let fetcher = fetchPage;
export function setResearchFetcher(fn) { fetcher = fn || fetchPage; }

export async function gatherSources(account, { maxPages = 6 } = {}) {
  const start = account.website || (account.domain ? `https://${account.domain}` : "");
  if (!start) throw new AiError("Keine Website/Domain hinterlegt");
  const home = await fetcher(start);
  if (!home) throw new AiError(`Website ${start} nicht erreichbar`);
  const pages = [{ kind: "home", url: home.url, html: home.html }];
  const links = extractLinks(home.html, home.url);
  for (const [kind, re] of PAGE_KINDS) {
    if (pages.length >= maxPages) break;
    const link = links.find(l => re.test(new URL(l.url).pathname) || re.test(l.text));
    if (!link || pages.some(p => p.url === link.url)) continue;
    const page = await fetcher(link.url);
    if (page) pages.push({ kind, url: page.url, html: page.html });
  }
  return pages.map((p, i) => ({ label: `S${i + 1}`, kind: p.kind, url: p.url, text: extractSiteText(p.html, p.kind === "career" || p.kind === "news" ? 7000 : 5000) }));
}

function contextBlock(account) {
  const project = account.project_id ? q.get("SELECT * FROM projects WHERE id = ?", account.project_id) : null;
  const products = account.product_id
    ? q.all("SELECT * FROM products WHERE id = ?", account.product_id)
    : project ? q.all("SELECT * FROM products WHERE project_id = ? ORDER BY name", project.id) : q.all("SELECT * FROM products ORDER BY name LIMIT 8");
  const plays = q.all("SELECT * FROM plays WHERE status = 'active' AND (? IS NULL OR project_id = ? OR project_id IS NULL) ORDER BY id LIMIT 30", project?.id ?? null, project?.id ?? null);
  const s = getSettings();
  return [
    `# Wir (Absender)\n${s.company_name || ""}\n${s.sender_context || ""}`.trim(),
    project ? `# Geschäftsbereich: ${project.name}\n${project.description}` : "",
    products.length ? `# Unsere Produkte (Bewertung der Passung bezieht sich darauf)\n${products.map(p => `- ${p.name}: ${p.description || ""}${p.icp ? `\n  Ideale Kunden: ${p.icp}` : ""}${p.proof ? `\n  Belege: ${p.proof}` : ""}`).join("\n")}` : "",
    plays.length ? `# Bekannte Plays (id: Branche · Anlass · Persona · Pain · Angle · Kanal)\n${plays.map(p => `- ${p.id}: ${p.industry} · ${p.trigger_type} · ${p.persona} · ${p.pain} · ${p.angle} · ${p.channel}`).join("\n")}` : ""
  ].filter(Boolean).join("\n\n");
}

function memoryBlock(accountId) {
  const mem = q.all("SELECT kind, text FROM account_memory WHERE account_id = ? AND kind IN ('do_not_claim','rejected_assumption','timing','system','objection') ORDER BY id DESC LIMIT 30", accountId);
  const rejected = q.all("SELECT statement, resolved_note FROM account_hypotheses WHERE account_id = ? AND status = 'rejected' ORDER BY id DESC LIMIT 20", accountId);
  const confirmed = q.all("SELECT statement FROM account_hypotheses WHERE account_id = ? AND status = 'confirmed' ORDER BY id DESC LIMIT 20", accountId);
  const lines = [
    ...mem.map(m => `- [${m.kind}] ${m.text}`),
    ...rejected.map(r => `- [widerlegt] ${r.statement}${r.resolved_note ? ` (${r.resolved_note})` : ""}`),
    ...confirmed.map(c => `- [bestätigt] ${c.statement}`)
  ];
  return lines.length ? `# Gedächtnis zu dieser Firma (verbindlich beachten)\n${lines.join("\n")}` : "";
}

const RESEARCH_RULES = `Du recherchierst für den B2B-Vertrieb eines deutschen Mittelständlers. Ziel: nicht möglichst viele Firmen, sondern die wenigen mit echtem Bedarf UND aktuellem Anlass erkennen.
Regeln (verbindlich):
- Trenne strikt: FAKTEN (stehen in den Quellen), HYPOTHESEN (Vermutungen über Probleme/Anlässe) und VERTRIEBS-INTERPRETATION (warum das für uns relevant sein könnte).
- Jeder Fakt und jeder Anlass nennt die Quelle (S1, S2 …) und ein wörtliches kurzes Zitat (max. 20 Wörter) aus genau dieser Quelle. Ohne Zitat kein Fakt.
- type "verified" nur, wenn der Fakt wörtlich so in der Quelle steht; Schätzungen (z. B. Mitarbeiterzahl aus Teamfotos) sind "estimate" mit ehrlicher Konfidenz.
- Personen nur, wenn sie mit Namen auf der Website stehen (z. B. Impressum: Geschäftsführer). Keine Namen erfinden. Keine privaten Informationen (Familie, Alter, Hobbys, Privatadresse, Gesundheit) – nur die berufliche Rolle.
- Hypothesen beziehen sich auf Evidenz (F1… für Fakten, G1… für Anlässe in der Reihenfolge deiner Listen). Formuliere sie als Vermutung, nie als Tatsache.
- Beachte das Gedächtnis: Widerlegte Annahmen nicht erneut aufstellen, „nicht behaupten“-Hinweise respektieren.
- Scores 0–100: fit (passt die Firma zu unseren Produkten/idealen Kunden), pain (wie wahrscheinlich ist ein relevanter Prozess-Schmerz), timing (gibt es einen aktuellen Anlass – ohne Anlass höchstens 40), contactability (sind Entscheider/Telefon/Ansprechpartner erkennbar).
- Kein Anlass erkennbar ist ein gültiges Ergebnis. Lieber ehrlich niedrig bewerten als schönreden.`;

const SCHEMA = {
  type: "object",
  properties: {
    company: {
      type: "object",
      properties: { name: { type: "string" }, industry: { type: "string" }, city: { type: "string" }, employees_estimate: { type: "string" }, summary: { type: "string" } },
      required: ["name", "industry", "city", "employees_estimate", "summary"], additionalProperties: false
    },
    facts: { type: "array", items: { type: "object", properties: {
      key: { type: "string" }, statement: { type: "string" }, type: { type: "string", enum: ["verified", "estimate"] }, confidence: { type: "number" }, source: { type: "string" }, quote: { type: "string" }
    }, required: ["key", "statement", "type", "confidence", "source", "quote"], additionalProperties: false } },
    signals: { type: "array", items: { type: "object", properties: {
      type: { type: "string", enum: Object.keys(SIGNAL_TYPES) }, title: { type: "string" }, detail: { type: "string" }, strength: { type: "number" }, confidence: { type: "number" }, source: { type: "string" }, quote: { type: "string" }
    }, required: ["type", "title", "detail", "strength", "confidence", "source", "quote"], additionalProperties: false } },
    hypotheses: { type: "array", items: { type: "object", properties: {
      kind: { type: "string", enum: ["pain", "why_now", "value"] }, statement: { type: "string" }, interpretation: { type: "string" }, confidence: { type: "number" }, evidence: { type: "array", items: { type: "string" } }
    }, required: ["kind", "statement", "interpretation", "confidence", "evidence"], additionalProperties: false } },
    people: { type: "array", items: { type: "object", properties: {
      name: { type: "string" }, role: { type: "string" }, committee_role: { type: "string", enum: Object.keys(COMMITTEE_ROLES) }, decision_power: { type: "string", enum: ["high", "medium", "low"] }, pain_influence: { type: "string", enum: ["very_high", "high", "medium", "low"] }, source: { type: "string" }
    }, required: ["name", "role", "committee_role", "decision_power", "pain_influence", "source"], additionalProperties: false } },
    strategy: { type: "object", properties: {
      primary_entry: { type: "string" }, secondary: { type: "string" }, champion: { type: "string" }, economic_buyer: { type: "string" }, technical: { type: "string" }, do_not_contact: { type: "string" }
    }, required: ["primary_entry", "secondary", "champion", "economic_buyer", "technical", "do_not_contact"], additionalProperties: false },
    scores: { type: "object", properties: {
      fit: { type: "number" }, pain: { type: "number" }, timing: { type: "number" }, contactability: { type: "number" },
      fit_reason: { type: "string" }, pain_reason: { type: "string" }, timing_reason: { type: "string" }, contactability_reason: { type: "string" }
    }, required: ["fit", "pain", "timing", "contactability", "fit_reason", "pain_reason", "timing_reason", "contactability_reason"], additionalProperties: false },
    why_now: { type: "object", properties: { summary: { type: "string" }, confidence: { type: "number" } }, required: ["summary", "confidence"], additionalProperties: false },
    play: { type: "object", properties: {
      matched_play_id: { type: "number" }, persona: { type: "string" }, trigger: { type: "string" }, pain: { type: "string" }, angle: { type: "string" }, proof: { type: "string" },
      channel: { type: "string", enum: ["call", "email", "linkedin", "letter"] }, cta: { type: "string" }
    }, required: ["matched_play_id", "persona", "trigger", "pain", "angle", "proof", "channel", "cta"], additionalProperties: false },
    disqualify: { type: "object", properties: { yes: { type: "boolean" }, reason: { type: "string" } }, required: ["yes", "reason"], additionalProperties: false }
  },
  required: ["company", "facts", "signals", "hypotheses", "people", "strategy", "scores", "why_now", "play", "disqualify"],
  additionalProperties: false
};

// Prüft die KI-Antwort gegen die gelesenen Quellen (Halluzinations-Schutz).
export function validateResearch(result, sources) {
  const byLabel = new Map(sources.map(s => [s.label, s]));
  const quoteOk = (src, quote) => {
    const text = norm(src?.text);
    const qn = norm(quote);
    if (!text || qn.length < 4) return false;
    return text.includes(qn) || text.includes(qn.slice(0, 40));
  };
  const facts = [];
  const factIndex = new Map();
  (result.facts || []).forEach((f, i) => {
    const src = byLabel.get(String(f.source || "").trim());
    if (!src || !String(f.statement || "").trim()) return;
    const verifiedQuote = quoteOk(src, f.quote);
    const fact = {
      key: String(f.key || "").slice(0, 60), statement: String(f.statement).slice(0, 500),
      // Zitat nicht in der Quelle gefunden → höchstens Schätzung mit geringer Konfidenz.
      type: verifiedQuote && f.type === "verified" ? "verified" : "estimate",
      confidence: verifiedQuote ? clamp(f.confidence) : Math.min(40, clamp(f.confidence)),
      source_url: src.url, source_type: src.kind, quote: String(f.quote || "").slice(0, 300)
    };
    factIndex.set(`F${i + 1}`, facts.length);
    facts.push(fact);
  });
  const signals = [];
  const signalIndex = new Map();
  (result.signals || []).forEach((g, i) => {
    const src = byLabel.get(String(g.source || "").trim());
    if (!src || !quoteOk(src, g.quote) || !String(g.title || "").trim()) return; // Anlässe nur mit belegtem Zitat
    signalIndex.set(`G${i + 1}`, signals.length);
    signals.push({ type: SIGNAL_TYPES[g.type] ? g.type : "other", title: String(g.title).slice(0, 200), detail: String(g.detail || "").slice(0, 500), strength: clamp(g.strength), confidence: clamp(g.confidence), source_url: src.url, quote: String(g.quote || "").slice(0, 300) });
  });
  const hypotheses = (result.hypotheses || []).filter(h => String(h.statement || "").trim()).map((h, i) => {
    const ev = { facts: [], signals: [] };
    for (const ref of h.evidence || []) {
      const r = String(ref).trim().toUpperCase();
      if (factIndex.has(r)) ev.facts.push(factIndex.get(r));
      if (signalIndex.has(r)) ev.signals.push(signalIndex.get(r));
    }
    // Ohne Evidenz bleibt eine Hypothese erlaubt, aber mit begrenzter Konfidenz.
    const conf = ev.facts.length || ev.signals.length ? clamp(h.confidence) : Math.min(50, clamp(h.confidence));
    return { kind: ["pain", "why_now", "value"].includes(h.kind) ? h.kind : "pain", statement: String(h.statement).slice(0, 400), interpretation: String(h.interpretation || "").slice(0, 400), confidence: conf, evidence: ev, rank: i };
  });
  const allText = norm(sources.map(s => s.text).join(" "));
  const people = (result.people || []).filter(p => {
    const name = norm(p.name);
    return name.length >= 5 && name.includes(" ") && allText.includes(name);
  }).map(p => ({ ...p, source_url: byLabel.get(String(p.source || "").trim())?.url || "" }));
  return { facts, signals, hypotheses, people };
}

export async function researchAccount(accountId, { userId = null } = {}) {
  const account = q.get("SELECT * FROM accounts WHERE id = ?", accountId);
  if (!account) throw new AiError("Firma nicht gefunden");
  let sources;
  try {
    sources = await gatherSources(account);
  } catch (err) {
    q.run("UPDATE accounts SET research_error = ?, updated_at = ? WHERE id = ?", err.message, Date.now(), accountId);
    throw err;
  }
  const result = await callJson({
    system: [RESEARCH_RULES, contextBlock(account), memoryBlock(accountId)].filter(Boolean),
    content: [
      `# Firma\nName: ${account.name || "(unbekannt)"}\nDomain: ${account.domain || "–"}`,
      ...sources.map(s => `\n# Quelle ${s.label} (${s.kind}) – ${s.url}\n${s.text}`),
      "\nErstelle das Account-Profil nach den Regeln. Personen nur aus den Quellen. Der Play bezieht sich auf unsere Produkte; matched_play_id = id eines bekannten Plays, sonst 0."
    ].join("\n"),
    schema: SCHEMA,
    maxTokens: 12000,
    effort: "medium"
  });
  return applyResearch(accountId, result, sources, { userId });
}

export function applyResearch(accountId, result, sources, { userId = null } = {}) {
  const account = q.get("SELECT * FROM accounts WHERE id = ?", accountId);
  const v = validateResearch(result, sources);
  const now = Date.now();
  const scores = {
    fit: clamp(result.scores?.fit), pain: clamp(result.scores?.pain), timing: clamp(result.scores?.timing), contactability: clamp(result.scores?.contactability)
  };
  // Von Hand eingetragene Anlässe (Gespräch, Zeitung, Messe) zählen genauso wie gefundene.
  const manualSignals = q.all("SELECT strength FROM account_signals WHERE account_id = ? AND status = 'active' AND created_by != 'ai'", accountId);
  const manualStrong = manualSignals.some(x => Number(x.strength) >= 60);
  if (!v.signals.length && !manualSignals.length) scores.timing = Math.min(scores.timing, 40); // ohne belegten Anlass kein hoher Timing-Score
  if (manualStrong) scores.timing = Math.max(scores.timing, 70);
  const opp = opportunityScore(scores);
  const prevTiming = account.timing_score;
  const playId = Number(result.play?.matched_play_id) || 0;
  const validPlay = playId && q.get("SELECT 1 FROM plays WHERE id = ?", playId) ? playId : null;
  const c = result.company || {};

  tx(() => {
    q.run("UPDATE account_facts SET status = 'outdated' WHERE account_id = ? AND created_by = 'ai' AND status = 'active'", accountId);
    const factIds = v.facts.map(f => insert("account_facts", { account_id: accountId, ...f, observed_at: now, status: "active", created_by: "ai", created_at: now }));
    const signalIds = v.signals.map(sig => {
      const existing = q.get("SELECT id FROM account_signals WHERE account_id = ? AND type = ? AND LOWER(title) = LOWER(?) AND status = 'active'", accountId, sig.type, sig.title);
      if (existing) {
        update("account_signals", existing.id, { observed_at: now, detail: sig.detail, strength: sig.strength, confidence: sig.confidence, quote: sig.quote, source_url: sig.source_url });
        return existing.id;
      }
      return insert("account_signals", { account_id: accountId, ...sig, observed_at: now, first_seen_at: now, status: "active", created_by: "ai", created_at: now });
    });
    q.run("UPDATE account_signals SET status = 'expired' WHERE account_id = ? AND status = 'active' AND observed_at < ?", accountId, now - 120 * DAY_MS);
    q.run("DELETE FROM account_hypotheses WHERE account_id = ? AND created_by = 'ai' AND status = 'open'", accountId);
    for (const h of v.hypotheses) {
      insert("account_hypotheses", {
        account_id: accountId, kind: h.kind, statement: h.statement, interpretation: h.interpretation, confidence: h.confidence, rank: h.rank,
        evidence: JSON.stringify({ facts: h.evidence.facts.map(i => factIds[i]), signals: h.evidence.signals.map(i => signalIds[i]) }),
        status: "open", created_by: "ai", created_at: now, updated_at: now
      });
    }
    for (const p of v.people) {
      const existing = q.get("SELECT * FROM account_people WHERE account_id = ? AND LOWER(name) = LOWER(?)", accountId, p.name);
      const row = { role: p.role, committee_role: p.committee_role, decision_power: p.decision_power, pain_influence: p.pain_influence, source_url: p.source_url, updated_at: now };
      if (existing) update("account_people", existing.id, { ...row, role: existing.role || p.role, committee_role: existing.committee_role || p.committee_role });
      else insert("account_people", { account_id: accountId, name: p.name, ...row, source: "website", created_at: now });
    }
    update("accounts", accountId, {
      name: !account.name || account.name === account.domain ? (c.name || account.name) : account.name,
      industry: account.industry || c.industry || "", city: account.city || c.city || "", employees: c.employees_estimate || account.employees || "",
      summary: c.summary || "", fit_score: scores.fit, pain_score: scores.pain, timing_score: scores.timing, contactability_score: scores.contactability, opportunity_score: opp,
      score_reasons: JSON.stringify({ fit: result.scores?.fit_reason || "", pain: result.scores?.pain_reason || "", timing: result.scores?.timing_reason || "", contactability: result.scores?.contactability_reason || "" }),
      why_now: result.why_now?.summary || "", why_now_confidence: clamp(result.why_now?.confidence),
      strategy: JSON.stringify(result.strategy || {}),
      suggested_play: JSON.stringify({ ...(result.play || {}), matched_play_id: validPlay }),
      play_id: account.play_id || validPlay,
      researched_at: now, research_error: null, updated_at: now
    });
    recordEvent("research", { data: { account_id: accountId, facts: v.facts.length, signals: v.signals.length, opportunity: opp } });
  });

  // Lebenszyklus: nur in den frühen Phasen automatisch einordnen.
  const settings = getSettings();
  const watchDays = Number(settings.watch_interval_days) || 30;
  const early = ["discovered", "researched", "qualified", "watching", "triggered", "no_response", "not_now"].includes(account.lifecycle);
  let state = null;
  // Sperrfrist nach „kein Interesse“ (bei einer Person der Firma): kein neuer Anruf, auch wenn ein Anlass auftaucht.
  const onHold = !!q.get("SELECT 1 FROM leads WHERE account_id = ? AND hold_until > ?", accountId, now);
  if (early) {
    if (result.disqualify?.yes || scores.fit < 40) state = "disqualified";
    else if (scores.fit >= 60 && scores.timing >= 70) state = "triggered";
    else if (scores.fit >= 60 && scores.timing < 45) state = account.lifecycle === "not_now" ? "not_now" : "watching";
    else if (scores.fit >= 60) state = "qualified";
    else state = "researched";
    if (["no_response", "not_now"].includes(account.lifecycle) && state !== "triggered") state = account.lifecycle;
    if (state === "triggered" && onHold) state = account.lifecycle === "triggered" ? "triggered" : ["no_response", "not_now"].includes(account.lifecycle) ? account.lifecycle : "watching";
    if (state !== account.lifecycle) setLifecycle(accountId, state, { reason: result.disqualify?.yes ? result.disqualify.reason : `Recherche: Fit ${scores.fit}, Timing ${scores.timing}`, by: "ai" });
  }
  q.run("UPDATE accounts SET next_check_at = ? WHERE id = ?", ["watching", "not_now", "no_response", "qualified", "researched"].includes(state || account.lifecycle) ? now + watchDays * DAY_MS : null, accountId);
  // Neuer Anlass bei einer beobachteten Firma → sofort in den Vertrieb.
  if (state === "triggered" && account.lifecycle !== "triggered") {
    const top = v.signals.sort((a, b) => b.strength - a.strength)[0];
    const name = q.value("SELECT name FROM accounts WHERE id = ?", accountId) || account.domain;
    createTask({
      type: "todo", account_id: accountId, title: `Neuer Anlass: ${name}${top ? ` – ${top.title}` : ""} – in eine Kampagne aufnehmen`,
      notes: [result.why_now?.summary, prevTiming !== null && prevTiming !== undefined ? `Timing ${prevTiming} → ${scores.timing}` : ""].filter(Boolean).join(" · "),
      priority: 400, user_id: userId
    });
  }
  return { account: q.get("SELECT * FROM accounts WHERE id = ?", accountId), facts: v.facts.length, signals: v.signals.length, hypotheses: v.hypotheses.length, people: v.people.length, state, dropped: { facts: (result.facts || []).length - v.facts.length, signals: (result.signals || []).length - v.signals.length, people: (result.people || []).length - v.people.length } };
}

export function parseStrategy(account) {
  return parseJson(account.strategy, {}) || {};
}
