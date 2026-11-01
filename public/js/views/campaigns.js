// Kampagnen-Übersicht.
import { h, clear, api, modal, field, input, select, busy, badge, num, pct, icon, emptyState, skeletonRows, relTime, state, LEGAL_OPTIONS } from "../lib.js";

export async function render(el) {
  clear(el, header(), h("div", { class: "content" }, skeletonRows(4)));
  const list = await api("/api/campaigns");
  clear(el, header(), h("div", { class: "content" }, h("div", { class: "card" },
    list.length ? h("div", { class: "table-wrap" }, h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "Kampagne"), h("th", null, "Status"), h("th", { class: "num" }, "Leads"), h("th", { class: "num" }, "Gesendet"), h("th", { class: "num" }, "Antworten"), h("th", { class: "num" }, "Interessiert"), h("th", { class: "num" }, "Bounces"), h("th", null, "Geändert"))),
      h("tbody", null, list.map(c => h("tr", { class: "clickable", onclick: () => { location.hash = `#/kampagnen/${c.id}`; } },
        h("td", null, h("div", { class: "strong" }, c.name), h("div", { class: "small muted" }, c.product_name || "ohne Produkt", c.target_group_name ? ` · ${c.target_group_name}` : "", c.ai_mode !== "off" ? " · KI-personalisiert" : "")),
        h("td", null, h("div", { class: "row-tight", style: { flexWrap: "wrap" } }, badge("campaign", c.status), badge("legal", c.legal_basis), c.approved ? null : h("span", { class: "badge warn" }, "nicht freigegeben"))),
        h("td", { class: "num" }, num(c.stats.leads)),
        h("td", { class: "num" }, num(c.stats.sent)),
        h("td", { class: "num" }, `${num(c.stats.replied)} `, h("span", { class: "muted small" }, `(${pct(c.stats.reply_rate)})`)),
        h("td", { class: "num" }, num(c.stats.interested)),
        h("td", { class: "num" }, h("span", { style: { color: c.stats.bounce_rate > 3 ? "var(--danger)" : "inherit" } }, `${num(c.stats.bounced)} (${pct(c.stats.bounce_rate)})`)),
        h("td", { class: "small muted" }, relTime(c.updated_at)))))))
      : emptyState("Noch keine Kampagne", "Eine Kampagne verbindet Produkt, freigegebene Texte, Leads und Postfächer. Am schnellsten: unter „Produkte“ eine Vorlage mit KI erstellen, prüfen, freigeben – und daraus die Kampagne.", h("button", { class: "btn btn-primary", onclick: openCreate }, icon("plus"), "Kampagne anlegen")))));
}

function header() {
  return h("div", { class: "page-head" }, h("h1", null, "Kampagnen"), h("div", { class: "actions" }, h("button", { class: "btn btn-primary", onclick: openCreate }, icon("plus"), "Kampagne anlegen")));
}

async function openCreate() {
  const [groups, products] = await Promise.all([api("/api/target-groups"), api("/api/products")]);
  const name = input({ placeholder: "z. B. Website-Paket Handwerk Oberberg – Q4" });
  const product = select([["", "– ohne Produkt –"], ...products.map(p => [p.id, p.name])], products[0]?.id || "");
  const group = select([["", "– ohne Zielgruppe –"], ...groups.map(g => [g.id, g.name])], groups[0]?.id || "");
  const legal = select(LEGAL_OPTIONS, "consent");
  const dlg = modal({
    title: "Kampagne anlegen",
    body: h("div", { class: "stack" },
      products.some(p => p.template_count) ? h("div", { class: "alert info" }, "Tipp: Fertige Vorlagen findest du beim Produkt – „Kampagne erstellen“ übernimmt Texte und Freigabe.") : null,
      field("Name", name), field("Produkt", product, "Liefert Termin-Link, Info-Kit und Produktwissen."), field("Zielgruppe", group), field("Rechtsgrundlage", legal, "Standard: nur Kontakte mit dokumentierter Einwilligung.")),
    footer: [h("button", { class: "btn", onclick: () => dlg.close() }, "Abbrechen"), h("button", { class: "btn btn-primary", onclick: e => busy(e.currentTarget, async () => {
      const c = await api("/api/campaigns", { method: "POST", body: { name: name.value || "Neue Kampagne", product_id: product.value ? Number(product.value) : null, target_group_id: group.value ? Number(group.value) : null, legal_basis: legal.value } });
      dlg.close();
      location.hash = `#/kampagnen/${c.id}/sequenz`;
    }) }, "Anlegen")]
  });
}
