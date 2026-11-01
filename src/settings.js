// App-Einstellungen (im Admin änderbar) mit Standardwerten.
import { getSetting, setSetting } from "./db.js";
import { config } from "./config.js";

export const DEFAULT_SETTINGS = {
  company_name: "",
  // Pflichtangaben für geschäftliche E-Mails (§ 35a GmbHG / § 5 DDG) – wird unter jede Mail gesetzt.
  footer_text: "",
  unsubscribe_text: "Kein Interesse? Kurze Antwort genügt – oder hier abmelden: {{unsubscribe_url}}",
  privacy_url: "",
  // Was wir anbieten – Grundlage für alle KI-Texte (wird mit dem Wissen der Zielgruppe kombiniert).
  sender_context: "",
  timezone: config.defaultTimezone || "Europe/Berlin",
  webhook_url: "",
  webhook_secret: "",
  webhook_events: ["reply.received", "lead.interested", "lead.unsubscribed", "lead.bounced"],
  warmup_folder: "Warmup",
  auto_classify: true,
  booking_url: "",
  // Termin-Link mit ?email=… ergänzen (Vorbelegung + Zuordnung der Buchung). Aus = keine Adresse in Links.
  booking_prefill: false,
  // Geheimnis für den eingehenden Buchungs-Webhook (/hooks/booking/<secret>) – wird beim ersten Start erzeugt.
  booking_hook_secret: "",
  // Kontaktregeln (gelten über alle Produkte/Kampagnen hinweg)
  cooldown_days: 90,
  not_interested_hold_days: 365,
  company_cap_30d: 3,
  skip_freemail_cold: true,
  // Chef-Adressen aus Name + Firmenmuster bilden (Leadquellen, Impressum-Suche). Aus = nur wörtlich veröffentlichte Adressen.
  guess_chief_emails: false,
  // Google-Bewertungen (nur mit GOOGLE_PLACES_API_KEY): ohne Bewertungen aussortieren, „gut“ ab Anzahl + Sterne.
  google_require_reviews: true,
  google_good_count: 10,
  google_good_rating: 4.5,
  // Zusätzliche Ausschluss-Begriffe für Kaltakquise (Komma/Zeile getrennt), zusätzlich zum festen Rechts-Ausschluss.
  cold_exclude_terms: "",
  // Nachfassen-Standard, falls die Kampagne nichts anderes sagt
  nurture_window_start: "08:30",
  nurture_window_end: "17:30",
  nurture_weekdays: "1,2,3,4,5",
  // KI-Budget: max. KI-Anfragen pro Tag (schützt das Kontingent des Max-Abos)
  ai_daily_limit: 300,
  // Revenue Intelligence
  watch_interval_days: 30,
  watch_daily_limit: 10,
  reply_sla_minutes: 30,
  creepy_threshold: 35,
  // Einrichtungs-Assistent
  main_domain: "",
  setup_mode: "separate", // "separate" = eigene Versand-Domains (Leitfaden), "main" = über die Hauptdomain, kleine Menge
  setup_domains: [],
  setup_domain_cache: {},
  // Leadquellen (Scraping): Website-Prüfungen pro Tag und Standard-Regionen (Verwaltungsnamen wie bei OpenStreetMap).
  sourcing_daily_limit: 800,
  // Tages-Autopilot: Kapazität aller Postfächer auf die Autopilot-Kampagnen der Projekte verteilen (Folge-Mails zuerst,
  // dann Erst-Mails nach Anteil), Pools automatisch nachfüllen, nie angeschriebene alte Pool-Leads aufräumen.
  autopilot_enabled: false,
  autopilot_shares: {}, // { projectId: Gewicht } – Standard 1 je Projekt (gleich verteilt)
  autopilot_buffer_days: 7, // Pool soll so viele Versandtage an Erst-Mails vorrätig haben
  autopilot_lead_max_age_days: 60, // nie angeschriebene Pool-Leads, die älter sind, werden gelöscht
  autopilot_refill: true,
  autopilot_cleanup: true,
  autopilot_last_cleanup: null,
  sourcing_regions: []
};

let cache = null;

export function getSettings() {
  if (!cache) cache = { ...DEFAULT_SETTINGS, ...(getSetting("app", {}) || {}) };
  return cache;
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  setSetting("app", next);
  cache = next;
  return next;
}

export function resetSettingsCache() { cache = null; }
