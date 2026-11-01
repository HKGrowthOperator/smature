// App-Shell: Anmeldung, Navigation, Hash-Router.
import { h, clear, icon, api, state, toastError, input, field } from "./lib.js";

const ROUTES = [
  { path: /^#?\/?$/, view: "today", nav: "heute" },
  { path: /^#\/heute$/, view: "today", nav: "heute" },
  { path: /^#\/projekte$/, view: "projects", nav: "projekte" },
  { path: /^#\/firmen$/, view: "accounts", nav: "firmen" },
  { path: /^#\/firmen\/(\d+)$/, view: "account", nav: "firmen" },
  { path: /^#\/pipeline$/, view: "pipeline", nav: "pipeline" },
  { path: /^#\/pipeline\/(\d+)$/, view: "opportunity", nav: "pipeline" },
  { path: /^#\/lernen$/, view: "learning", nav: "lernen" },
  { path: /^#\/einrichtung$/, view: "setup", nav: "einrichtung" },
  { path: /^#\/dashboard$/, view: "dashboard", nav: "dashboard" },
  { path: /^#\/unibox(?:\/(\d+))?$/, view: "unibox", nav: "unibox" },
  { path: /^#\/kampagnen$/, view: "campaigns", nav: "kampagnen" },
  { path: /^#\/kampagnen\/(\d+)(?:\/(\w+))?$/, view: "campaign", nav: "kampagnen" },
  { path: /^#\/leads(?:\/([\w-]+))?$/, view: "leads", nav: "leads" },
  { path: /^#\/leadquellen$/, view: "sourcing", nav: "leadquellen" },
  { path: /^#\/aufgaben(?:\/(\w+))?$/, view: "tasks", nav: "aufgaben" },
  { path: /^#\/produkte$/, view: "products", nav: "produkte" },
  { path: /^#\/produkte\/(\d+)$/, view: "product", nav: "produkte" },
  { path: /^#\/richtlinien$/, view: "guidelines", nav: "richtlinien" },
  { path: /^#\/zielgruppen$/, view: "targetGroups", nav: "zielgruppen" },
  { path: /^#\/zielgruppen\/(\d+)$/, view: "targetGroup", nav: "zielgruppen" },
  { path: /^#\/postfaecher$/, view: "mailboxes", nav: "postfaecher" },
  { path: /^#\/einstellungen(?:\/(\w+))?$/, view: "settings", nav: "einstellungen" }
];

// Gruppierte Navigation: erst verkaufen, dann Markt, dann Ansprache, dann System.
const NAV = [
  ["Vertrieb"],
  ["heute", "Heute", "sun", "#/"],
  ["unibox", "Unibox", "inbox", "#/unibox"],
  ["aufgaben", "Aufgaben", "list", "#/aufgaben"],
  ["pipeline", "Pipeline", "trending", "#/pipeline"],
  ["Markt"],
  ["projekte", "Projekte", "columns", "#/projekte"],
  ["firmen", "Firmen", "building", "#/firmen"],
  ["leads", "Leads", "users", "#/leads"],
  ["leadquellen", "Leadquellen", "search", "#/leadquellen"],
  ["Ansprache"],
  ["kampagnen", "Kampagnen", "send", "#/kampagnen"],
  ["produkte", "Produkte & Vorlagen", "box", "#/produkte"],
  ["zielgruppen", "Zielgruppen & Wissen", "target", "#/zielgruppen"],
  ["lernen", "Plays & Lernen", "chart", "#/lernen"],
  ["System"],
  ["einrichtung", "Einrichtung", "list", "#/einrichtung"],
  ["dashboard", "Versand-Übersicht", "dashboard", "#/dashboard"],
  ["postfaecher", "Postfächer", "mail", "#/postfaecher"],
  ["richtlinien", "Richtlinien", "shield", "#/richtlinien"],
  ["einstellungen", "Einstellungen", "settings", "#/einstellungen"]
];

const root = document.getElementById("app");
let shell = null;
let currentCleanup = null;
let unreadTimer = null;

function renderLogin(message) {
  const email = input({ type: "email", autocomplete: "username", required: true, name: "email" });
  const password = input({ type: "password", autocomplete: "current-password", required: true, name: "password" });
  const error = h("div", { class: "alert danger", hidden: !message }, message || "");
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "Anmelden");
  const form = h("form", { class: "stack", onsubmit: async e => {
    e.preventDefault();
    submit.setAttribute("aria-busy", "true");
    try {
      const res = await api("/api/auth/login", { method: "POST", body: { email: email.value, password: password.value } });
      state.user = res.user; state.csrf = res.csrf;
      await boot();
    } catch (err) {
      error.hidden = false; error.textContent = err.message;
    } finally {
      submit.removeAttribute("aria-busy");
    }
  } }, field("E-Mail", email), field("Passwort", password), error, submit);
  clear(root, h("div", { class: "login" }, h("div", { class: "card" },
    h("div", { class: "brand" }, h("span", { class: "brand-mark" }, "SM"), "Coldmail"),
    h("p", { class: "muted" }, "Bitte melde dich an."), form)));
  shell = null;
}

function buildShell() {
  const navItems = NAV.map(([key, label, ic, href]) => (!label ? h("div", { class: "nav-group" }, key)
    : h("a", { href, dataset: { nav: key } }, icon(ic), h("span", null, label), key === "unibox" ? h("span", { class: "badge accent", hidden: true, dataset: { unread: "1" } }) : key === "aufgaben" ? h("span", { class: "badge accent", hidden: true, dataset: { tasks: "1" } }) : null)));
  const navLinks = navItems.filter(n => n.tagName === "A");
  const main = h("main", { class: "main", id: "main" });
  const el = h("div", { class: "shell" },
    h("aside", { class: "sidebar" },
      h("div", { class: "brand" }, h("span", { class: "brand-mark" }, "SM"), "Coldmail"),
      h("nav", { class: "nav", "aria-label": "Hauptnavigation", onclick: () => el.classList.remove("nav-open") }, navItems),
      h("div", { class: "sidebar-foot" },
        h("span", { class: "grow", title: state.user.email }, state.user.name || state.user.email),
        h("button", { class: "btn btn-ghost btn-icon", title: "Abmelden", "aria-label": "Abmelden", onclick: logout }, icon("logout")))),
    h("div", { class: "main-wrap" },
      h("div", { class: "topbar" }, h("button", { class: "btn btn-ghost btn-icon", "aria-label": "Menü", onclick: () => el.classList.toggle("nav-open") }, icon("menu")), h("strong", null, "Smature Coldmail")),
      main));
  clear(root, el);
  shell = { el, main, navLinks };
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  state.user = null; state.csrf = null;
  clearInterval(unreadTimer);
  location.hash = "#/";
  renderLogin();
}

export async function refreshUnread() {
  if (!shell) return;
  const show = (sel, n) => {
    const b = shell.el.querySelector(sel);
    if (!b) return;
    b.hidden = !n;
    b.textContent = n > 99 ? "99+" : String(n);
  };
  try {
    const [conv, tasks] = await Promise.all([api("/api/conversations?filter=unread&limit=1"), api("/api/tasks/counts")]);
    show("[data-unread]", conv.counts?.unread || 0);
    show("[data-tasks]", tasks.due || 0);
  } catch { /* still */ }
}

async function route() {
  if (!state.user) return;
  if (!shell) buildShell();
  const full = location.hash || "#/";
  const qi = full.indexOf("?");
  const hash = qi >= 0 ? full.slice(0, qi) : full;
  state.query = new URLSearchParams(qi >= 0 ? full.slice(qi + 1) : "");
  const match = ROUTES.map(r => ({ r, m: r.path.exec(hash) })).find(x => x.m);
  if (!match) { location.hash = "#/"; return; }
  for (const a of shell.navLinks) a.classList.toggle("active", a.dataset.nav === match.r.nav);
  if (typeof currentCleanup === "function") currentCleanup();
  currentCleanup = null;
  const container = h("div");
  clear(shell.main, container);
  try {
    const mod = await import(`./views/${match.r.view}.js`);
    currentCleanup = await mod.render(container, match.m.slice(1));
  } catch (err) {
    toastError(err);
    clear(container, h("div", { class: "content" }, h("div", { class: "alert danger" }, `Seite konnte nicht geladen werden: ${err.message}`)));
  }
  window.scrollTo(0, 0);
}

async function boot() {
  try {
    const me = await api("/api/me");
    state.user = me.user; state.csrf = me.csrf;
  } catch {
    return renderLogin();
  }
  [state.meta, state.projects] = await Promise.all([api("/api/meta").catch(() => ({ variables: [], labels: {} })), api("/api/projects").catch(() => [])]);
  shell = null;
  await route();
  refreshUnread();
  clearInterval(unreadTimer);
  unreadTimer = setInterval(refreshUnread, 60000);
}

window.addEventListener("hashchange", route);
window.addEventListener("auth:lost", () => renderLogin("Sitzung abgelaufen – bitte erneut anmelden."));
window.addEventListener("unread:changed", refreshUnread);
window.addEventListener("tasks:changed", refreshUnread);
boot();
