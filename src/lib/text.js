// Text/HTML-Helfer für E-Mails.
export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi;

// Klartext → schlichtes HTML (Absätze, Zeilenumbrüche, klickbare Links). linkMapper erlaubt Klick-Tracking.
export function textToHtml(text, linkMapper = url => url) {
  const paragraphs = String(text || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  const body = paragraphs.map(p => {
    let html = "", last = 0;
    for (const m of p.matchAll(URL_RE)) {
      html += escapeHtml(p.slice(last, m.index));
      html += `<a href="${escapeHtml(linkMapper(m[0]))}">${escapeHtml(m[0])}</a>`;
      last = m.index + m[0].length;
    }
    html += escapeHtml(p.slice(last));
    return `<p style="margin:0 0 1em 0">${html.replace(/\n/g, "<br>")}</p>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">${body}</body></html>`;
}

export function replaceUrls(text, mapper) {
  return String(text || "").replace(URL_RE, url => mapper(url));
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", euro: "€", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©", reg: "®" };

export function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e] ?? m;
  });
}

// Entfernt Blöcke wie <script>…</script> in linearer Zeit (Regex mit [\s\S]*? wäre bei offenen Tags quadratisch).
export function dropBlocks(html, tags) {
  const lower = html.toLowerCase();
  const openRe = new RegExp(`<(${tags.join("|")})(?=[\\s>/])`, "gi");
  const noClose = new Set();
  let out = "", pos = 0, m;
  while ((m = openRe.exec(html))) {
    const tag = m[1].toLowerCase();
    if (m.index < pos || noClose.has(tag)) continue;
    const end = lower.indexOf(`</${tag}`, m.index + 1);
    if (end < 0) { noClose.add(tag); continue; }
    const close = lower.indexOf(">", end);
    out += html.slice(pos, m.index) + " ";
    pos = close < 0 ? html.length : close + 1;
    openRe.lastIndex = pos;
  }
  return out + html.slice(pos);
}

const MAX_HTML = 1024 * 1024;

export function htmlToText(html) {
  const source = dropBlocks(String(html || "").slice(0, MAX_HTML), ["script", "style", "head", "noscript", "svg", "template"]);
  return decodeEntities(source
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, "\n")
    .replace(/<li[^<>]*>/gi, "• ")
    .replace(/<[^<>]*>/g, " ")
    .replace(/[<>]/g, " "))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Zitierten Verlauf aus einer Antwort entfernen (Gmail, Outlook, Apple Mail, deutsch/englisch).
// Zeilenweise statt mit /m-Regex über den ganzen Text – bleibt auch bei präparierten Mails linear.
const MAX_TEXT = 200000;
const QUOTE_INTRO = /^(am|on)\s/i;
const QUOTE_VERB = /(schrieb|wrote|a écrit)/i;
const QUOTE_SEPARATOR = /^-{2,}\s*(original(nachricht| message)|ursprüngliche nachricht|weitergeleitete nachricht|forwarded message)\s*-{2,}/i;

function isQuoteStart(lines, i) {
  const t = lines[i].trim();
  if (!t || t.length > 500) return false;
  const next = (lines[i + 1] || "").trim();
  if (QUOTE_INTRO.test(t) && QUOTE_VERB.test(t) && (t.endsWith(":") || (next.length < 200 && next.endsWith(">:")))) return true;
  if (QUOTE_SEPARATOR.test(t)) return true;
  if (/^(von|from)\s*:\s/i.test(t) && /^(gesendet|sent|datum|date)\s*:/i.test(next)) return true;
  return /^_{10,}$/.test(t);
}

export function stripQuoted(text) {
  const lines = String(text || "").slice(0, MAX_TEXT).replace(/\r\n/g, "\n").split("\n");
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && isQuoteStart(lines, i)) break;
    if (!/^[ \t]*>/.test(lines[i])) kept.push(lines[i]);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function snippet(text, length = 160) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > length ? s.slice(0, length - 1) + "…" : s;
}
