// Kleine UI-Bibliothek: DOM-Helfer, API-Client, Toasts, Modals, Formatierung. Keine Abhängigkeiten.
export const state = { user: null, csrf: null, meta: null };

export function h(tag, props, ...children) {
  const el = tag === "svg" || tag.startsWith("svg:") ? document.createElementNS("http://www.w3.org/2000/svg", tag.replace("svg:", "")) : document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.setAttribute("class", Array.isArray(v) ? v.filter(Boolean).join(" ") : v);
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else if (k === "selected") el.selected = !!v;
      else if (k === "html") throw new Error("html nicht erlaubt");
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

const ICONS = {
  dashboard: "M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z",
  inbox: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  target: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  plus: "M12 5v14M5 12h14",
  upload: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12",
  download: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  play: "M5 3l14 9-14 9V3z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  sparkles: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z",
  trash: "M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  edit: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z",
  copy: "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  menu: "M3 12h18M3 6h18M3 18h18",
  shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6",
  arrowLeft: "M19 12H5M12 19l-7-7 7-7",
  flame: "M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z",
  reply: "M9 17l-5-5 5-5M20 18v-2a4 4 0 0 0-4-4H4",
  box: "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96 12 12.01l8.73-5.05M12 22.08V12",
  phone: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z",
  list: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z",
  calendar: "M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM16 2v4M8 2v4M3 10h18",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42",
  columns: "M3 3h4v18H3zM10 3h4v18h-4zM17 3h4v18h-4z",
  building: "M3 21h18M5 21V7l8-4v18M19 21V11l-6-4M9 9v.01M9 12v.01M9 15v.01M9 18v.01",
  trending: "M23 6l-9.5 9.5-5-5L1 18M17 6h6v6",
  chart: "M18 20V10M12 20V4M6 20v-6",
  zap: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  external: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"
};

export function icon(name, cls = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] || ICONS.file);
  svg.appendChild(path);
  return svg;
}

export class ApiError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export async function api(path, { method = "GET", body, raw = false } = {}) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (method !== "GET" && state.csrf) opts.headers["X-CSRF-Token"] = state.csrf;
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new ApiError(0, "Keine Verbindung zum Server");
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/auth/login" && path !== "/api/me") {
    state.user = null;
    window.dispatchEvent(new CustomEvent("auth:lost"));
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Fehler ${res.status}`, data.details);
  return data;
}

// Hinweis, wenn eine Notiz #nomail oder #blacklist ausgelöst hat.
export function noteTagToast(res) {
  const tags = res?.note_tags || [];
  if (tags.includes("blacklist")) toast("#blacklist: Firma gesperrt – keine Mails, keine Anrufe mehr.", "info");
  else if (tags.includes("nomail")) toast("#nomail: keine Mails mehr an diese Person – anrufen bleibt möglich.", "info");
}

export function toast(message, type = "info") {
  let box = document.querySelector(".toasts");
  if (!box) { box = h("div", { class: "toasts", role: "status", "aria-live": "polite" }); document.body.appendChild(box); }
  const t = h("div", { class: ["toast", type === "error" && "error"] }, message);
  box.appendChild(t);
  setTimeout(() => t.remove(), type === "error" ? 7000 : 3500);
}

export const toastError = err => toast(err?.message || String(err), "error");

// Button während einer async-Aktion sperren.
export async function busy(button, fn) {
  if (button) { button.setAttribute("aria-busy", "true"); button.disabled = true; }
  try {
    return await fn();
  } catch (err) {
    toastError(err);
    return undefined;
  } finally {
    if (button) { button.removeAttribute("aria-busy"); button.disabled = false; }
  }
}

export function modal({ title, body, footer, wide = false, onClose } = {}) {
  const close = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); onClose?.(); };
  const onKey = e => { if (e.key === "Escape") close(); };
  const box = h("div", { class: ["modal", wide && "wide"], role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "modal-head" }, h("h2", { class: "grow" }, title), h("button", { class: "btn btn-ghost btn-icon", "aria-label": "Schließen", onclick: close }, icon("x"))),
    h("div", { class: "modal-body" }, body),
    footer ? h("div", { class: "modal-foot" }, footer) : null);
  const backdrop = h("div", { class: "modal-backdrop", onmousedown: e => { if (e.target === backdrop) close(); } }, box);
  document.body.appendChild(backdrop);
  document.addEventListener("keydown", onKey);
  // Erstes Feld fokussieren – aber nur, wenn noch nichts im Dialog fokussiert ist (sonst landet Getipptes im falschen Feld).
  setTimeout(() => { if (!box.contains(document.activeElement)) box.querySelector("input:not([type=hidden]):not([type=checkbox]), textarea, select")?.focus(); }, 30);
  return { close, el: box, body: box.querySelector(".modal-body"), foot: box.querySelector(".modal-foot") };
}

export function confirmDialog(message, { title = "Bitte bestätigen", confirm = "Bestätigen", danger = false } = {}) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); m.close(); } };
    const m = modal({
      title,
      body: h("p", { class: "pre" }, message),
      footer: [h("button", { class: "btn", onclick: () => finish(false) }, "Abbrechen"), h("button", { class: ["btn", danger ? "btn-danger" : "btn-primary"], onclick: () => finish(true) }, confirm)],
      onClose: () => { if (!done) { done = true; resolve(false); } }
    });
  });
}

export function drawer(content, { onClose } = {}) {
  const close = () => { back.remove(); panel.remove(); document.removeEventListener("keydown", onKey); onClose?.(); };
  const onKey = e => { if (e.key === "Escape") close(); };
  const back = h("div", { class: "drawer-backdrop", onclick: close });
  const panel = h("aside", { class: "drawer", role: "dialog", "aria-modal": "true" });
  document.body.append(back, panel);
  document.addEventListener("keydown", onKey);
  const api = { close, el: panel, set: (...c) => clear(panel, ...c) };
  clear(panel, typeof content === "function" ? content(api) : content);
  return api;
}

// ---------- Formulare ----------
export function field(label, input, hint) {
  const id = input.id || `f${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h("div", { class: "field" }, h("label", { for: id }, label), input, hint ? h("div", { class: "hint" }, hint) : null);
}
export const input = (props = {}) => h("input", { class: "input", type: "text", ...props });
export const textarea = (props = {}) => h("textarea", { class: ["textarea", props.code && "code"], ...props, code: undefined });
export function select(options, value, props = {}) {
  return h("select", { class: "select", ...props }, options.map(o => {
    const [val, label] = Array.isArray(o) ? o : [o.value, o.label];
    return h("option", { value: val, selected: String(val) === String(value ?? "") }, label);
  }));
}
export function checkbox(label, checked, hint, props = {}) {
  const cb = h("input", { type: "checkbox", checked, ...props });
  const el = h("label", { class: "check" }, cb, h("span", null, label, hint ? h("span", { class: "hint" }, hint) : null));
  el.input = cb;
  return el;
}

export function readFileAs(file, mode = "text") {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("Datei konnte nicht gelesen werden"));
    r.onload = () => resolve(mode === "base64" ? String(r.result).split(",")[1] || "" : r.result);
    if (mode === "base64") r.readAsDataURL(file); else r.readAsText(file);
  });
}

// ---------- Formatierung ----------
const nf = new Intl.NumberFormat("de-DE");
export const num = n => nf.format(Number(n) || 0);
export const pct = n => `${(Number(n) || 0).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;
export function dateTime(ts) {
  if (!ts) return "–";
  return new Date(ts).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}
export function relTime(ts) {
  if (!ts) return "–";
  const diff = Date.now() - ts;
  const abs = Math.abs(diff);
  const fut = diff < 0;
  const m = Math.round(abs / 60000);
  if (m < 1) return fut ? "gleich" : "gerade eben";
  if (m < 60) return fut ? `in ${m} Min.` : `vor ${m} Min.`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return fut ? `in ${hrs} Std.` : `vor ${hrs} Std.`;
  const d = Math.round(hrs / 24);
  if (d < 14) return fut ? `in ${d} Tag${d === 1 ? "" : "en"}` : `vor ${d} Tag${d === 1 ? "" : "en"}`;
  return dateTime(ts);
}
export const fileSize = b => (b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function debounce(fn, ms = 400) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const STATUS = {
  campaign: { draft: ["Entwurf", ""], active: ["Aktiv", "ok"], paused: ["Pausiert", "warn"], completed: ["Abgeschlossen", "info"] },
  consent: { none: ["Keine Einwilligung", ""], granted: ["Einwilligung", "ok"], customer: ["Bestandskunde", "ok"], revoked: ["Widerspruch", "danger"] },
  fit: { A: ["A · sehr gut", "ok"], B: ["B · passend", "ok"], C: ["C · unklar", "warn"], D: ["D · passt nicht", "danger"] },
  legal: { consent: ["Einwilligung", "ok"], customer: ["Bestandskunden", "info"], cold: ["Kaltakquise", "warn"] },
  task: { open: ["Offen", "info"], done: ["Erledigt", "ok"], dismissed: ["Entfallen", ""] },
  mailbox: { active: ["Aktiv", "ok"], paused: ["Pausiert", "warn"], error: ["Fehler", "danger"], disabled: ["Deaktiviert", ""] },
  lead: { active: ["Aktiv", "ok"], unsubscribed: ["Abgemeldet", "warn"], bounced: ["Bounce", "danger"], blocked: ["Gesperrt", "danger"] },
  verify: { valid: ["Gültig", "ok"], risky: ["Riskant", "warn"], invalid: ["Ungültig", "danger"], unknown: ["Ungeprüft", ""] },
  cl: {
    queued: ["Wartet", ""], active: ["Läuft", "info"], paused: ["Pausiert", "warn"], completed: ["Fertig", "ok"], replied: ["Geantwortet", "ok"],
    bounced: ["Bounce", "danger"], unsubscribed: ["Abgemeldet", "warn"], blocked: ["Gesperrt", "danger"], invalid: ["Ungültig", "danger"],
    stopped: ["Gestoppt", ""], skipped: ["Übersprungen", ""], error: ["Fehler", "danger"]
  }
};
export function badge(kind, value) {
  const [label, tone] = STATUS[kind]?.[value] || [value || "–", ""];
  return h("span", { class: ["badge", tone] }, label);
}

// Farben wie gewohnt: grün = interessiert (sofort antworten), rot = kein Interesse/Abmeldung, blau = abwesend/falsche Person.
export const LABEL_TONES = { interested: "ok", meeting: "ok", question: "warn", later: "warn", not_interested: "danger", wrong_person: "info", unsubscribe: "danger", ooo: "info", other: "" };
export function labelBadge(label) {
  if (!label) return null;
  return h("span", { class: ["badge", LABEL_TONES[label] || ""] }, state.meta?.labels?.[label] || label);
}

// Einfaches Balkendiagramm als SVG (zwei Serien).
export function barChart(series, keys = ["sent", "replies"], labels = ["Gesendet", "Antworten"]) {
  const W = 640, H = 180, pad = { l: 28, r: 6, t: 8, b: 22 };
  const max = Math.max(1, ...series.flatMap(d => keys.map(k => d[k] || 0)));
  const step = (W - pad.l - pad.r) / Math.max(1, series.length);
  const bw = Math.max(2, (step - 6) / keys.length);
  const y = v => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const svg = h("svg:svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": labels.join(" und ") + " pro Tag" });
  const grid = h("svg:g", { class: "grid" });
  const ticks = max >= 4 ? [0, Math.round(max / 2), max] : [0, max];
  for (const tick of ticks) {
    const yy = y(tick);
    grid.append(h("svg:line", { x1: pad.l, x2: W - pad.r, y1: yy, y2: yy }), h("svg:text", { x: 2, y: yy + 3 }, String(tick)));
  }
  svg.append(grid);
  const colors = ["var(--accent)", "var(--info)", "var(--warn)"];
  series.forEach((d, i) => {
    keys.forEach((k, j) => {
      const v = d[k] || 0;
      const x = pad.l + i * step + 3 + j * bw;
      const rect = h("svg:rect", { x, y: y(v), width: bw, height: Math.max(0, H - pad.b - y(v)), rx: 2, fill: colors[j] });
      rect.append(h("svg:title", null, `${d.day}: ${labels[j]} ${v}`));
      svg.append(rect);
    });
    if (series.length <= 16 || i % Math.ceil(series.length / 10) === 0) svg.append(h("svg:text", { x: pad.l + i * step + step / 2, y: H - 6, "text-anchor": "middle" }, d.day.slice(8, 10) + "." + d.day.slice(5, 7) + "."));
  });
  return h("div", null, svg, h("div", { class: "legend" }, labels.map((l, j) => h("span", null, h("i", { style: { background: colors[j] } }), l))));
}

// Freigabe-Status einer Kampagne/Vorlage.
export function approvalBadge(approval) {
  if (approval?.approved) return h("span", { class: "badge ok", title: `freigegeben von ${approval.approved_by || "?"} am ${dateTime(approval.approved_at)}` }, icon("check", "icon icon-xs"), "Freigegeben");
  if (approval?.outdated) return h("span", { class: "badge warn", title: "Nach der Freigabe geändert" }, "Geändert – erneut freigeben");
  return h("span", { class: "badge warn" }, "Nicht freigegeben");
}

// Wartet auf einen Hintergrund-Auftrag (z. B. KI-Qualitätsprüfung) und meldet den Fortschritt.
export async function waitForJob(id, onProgress) {
  for (;;) {
    const job = await api(`/api/jobs/${id}`);
    onProgress?.(job);
    if (job.status !== "running") return job;
    await new Promise(r => setTimeout(r, 1500));
  }
}

// Kurze Bezeichnungen für Auswahllisten (ausführliche Erklärung steht daneben).
export const LEGAL_OPTIONS = [["consent", "Einwilligung liegt vor"], ["customer", "Bestandskunden (§ 7 Abs. 3 UWG)"], ["cold", "Kaltakquise ohne Einwilligung (riskant)"]];

export const aiMissingText = "KI nicht eingerichtet: CLAUDE_CODE_OAUTH_TOKEN (Claude-Max-Abo) auf dem Server setzen.";

export function emptyState(title, text, action) {
  return h("div", { class: "empty" }, h("h3", null, title), text ? h("p", null, text) : null, action || null);
}

export function skeletonRows(n = 4) {
  return h("div", { class: "card card-pad stack-sm" }, Array.from({ length: n }, (_, i) => h("div", { class: "skeleton", style: { width: `${90 - i * 12}%` } })));
}

export function pager({ page, limit, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return h("div", { class: "pager" },
    `${num(total)} Einträge · Seite ${page} von ${pages}`,
    h("button", { class: "btn btn-sm", disabled: page <= 1, onclick: () => onPage(page - 1) }, "Zurück"),
    h("button", { class: "btn btn-sm", disabled: page >= pages, onclick: () => onPage(page + 1) }, "Weiter"));
}

export function scoreView(score) {
  const color = score >= 80 ? "var(--ok)" : score >= 60 ? "var(--warn)" : "var(--danger)";
  return h("span", { class: "score" }, h("span", { class: "score-dot", style: { background: color } }), `${Math.round(score)}/100`);
}

// ---------- Revenue OS ----------
export const LIFECYCLE_TONES = {
  discovered: "", researched: "", qualified: "info", watching: "", triggered: "warn", outreach_ready: "info", contacted: "info", engaged: "ok",
  meeting: "ok", opportunity: "ok", proposal: "ok", won: "ok", disqualified: "", no_response: "", not_now: "", suppressed: "danger", lost: "danger"
};
export function lifecycleBadge(state, label) {
  return h("span", { class: ["badge", LIFECYCLE_TONES[state] || ""] }, label || state);
}
export const euro = n => (n === null || n === undefined || n === "" ? "–" : `${Math.round(Number(n)).toLocaleString("de-DE")} €`);
export function projectDot(color, name) {
  return h("span", { class: "project-tag" }, h("i", { style: { background: color || "var(--line-2)" } }), name || "Ohne Projekt");
}
// Score 0–100 als kleiner Balken mit Zahl (null = noch nicht bewertet).
export function scoreBar(label, value, reason) {
  const v = value === null || value === undefined ? null : Number(value);
  return h("div", { class: "scorebar", title: reason || "" },
    h("span", { class: "label" }, label),
    h("div", { class: ["bar", v !== null && v < 40 ? "danger" : v !== null && v < 60 ? "warn" : ""] }, h("span", { style: { width: `${v ?? 0}%` } })),
    h("span", { class: "val" }, v === null ? "–" : String(v)));
}
// Projekt-Auswahl (Liste wird beim Start geladen und nach Änderungen aktualisiert).
export function projectSelect(value, props = {}) {
  return select([["", "– ohne Projekt –"], ...(state.projects || []).map(p => [p.id, p.name])], value ?? "", props);
}
export async function reloadProjects() {
  state.projects = await api("/api/projects").catch(() => state.projects || []);
  return state.projects;
}
export async function projectOptions() {
  const list = await api("/api/projects").catch(() => []);
  return { list, options: [["", "– ohne Projekt –"], ...list.map(p => [p.id, p.name])] };
}

export function issuesList(issues) {
  if (!issues?.length) return h("div", { class: "small muted" }, "Keine Auffälligkeiten.");
  return h("ul", { class: "issues" }, issues.map(i => h("li", { class: i.level }, i.level === "info" ? "•" : "!", " ", i.message)));
}
