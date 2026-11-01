// SQLite über das eingebaute node:sqlite (keine nativen Abhängigkeiten). Alle Zeitstempel sind Millisekunden seit Epoch.
import { DatabaseSync } from "node:sqlite";

let db = null;
const statements = new Map();

const MIGRATIONS = [
  // v1 – Grundschema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE mailboxes (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    from_name TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'custom',
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    smtp_secure INTEGER NOT NULL DEFAULT 0,
    smtp_user TEXT NOT NULL,
    smtp_pass TEXT NOT NULL,
    imap_host TEXT,
    imap_port INTEGER,
    imap_secure INTEGER NOT NULL DEFAULT 1,
    imap_user TEXT,
    imap_pass TEXT,
    daily_limit INTEGER NOT NULL DEFAULT 30,
    min_gap_sec INTEGER NOT NULL DEFAULT 120,
    ramp_enabled INTEGER NOT NULL DEFAULT 1,
    ramp_start INTEGER NOT NULL DEFAULT 5,
    ramp_step INTEGER NOT NULL DEFAULT 3,
    ramp_started_at INTEGER,
    signature TEXT NOT NULL DEFAULT '',
    reply_to TEXT,
    save_sent INTEGER NOT NULL DEFAULT 1,
    sent_folder TEXT,
    warmup_enabled INTEGER NOT NULL DEFAULT 0,
    warmup_daily INTEGER NOT NULL DEFAULT 10,
    warmup_reply_rate INTEGER NOT NULL DEFAULT 35,
    warmup_started_at INTEGER,
    warmup_next_at INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    last_error TEXT,
    error_count INTEGER NOT NULL DEFAULT 0,
    next_send_at INTEGER NOT NULL DEFAULT 0,
    last_sent_at INTEGER,
    imap_uidvalidity TEXT,
    imap_last_uid INTEGER,
    last_sync_at INTEGER,
    sync_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE target_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'de',
    tone TEXT NOT NULL DEFAULT '',
    offer TEXT NOT NULL DEFAULT '',
    cta TEXT NOT NULL DEFAULT '',
    profile TEXT NOT NULL DEFAULT '',
    profile_updated_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE knowledge_docs (
    id INTEGER PRIMARY KEY,
    target_group_id INTEGER NOT NULL REFERENCES target_groups(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    file_name TEXT,
    mime TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    data BLOB,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE lead_lists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    target_group_id INTEGER REFERENCES target_groups(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE leads (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    salutation TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    position TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    linkedin TEXT NOT NULL DEFAULT '',
    custom TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'active',
    verify_status TEXT NOT NULL DEFAULT 'unknown',
    verify_reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE lead_list_members (
    list_id INTEGER NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, lead_id)
  );
  CREATE INDEX idx_members_lead ON lead_list_members(lead_id);
  CREATE TABLE blocklist (
    id INTEGER PRIMARY KEY,
    value TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE campaigns (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    target_group_id INTEGER REFERENCES target_groups(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    timezone TEXT NOT NULL DEFAULT 'Europe/Berlin',
    days TEXT NOT NULL DEFAULT '1,2,3,4,5',
    window_start TEXT NOT NULL DEFAULT '08:00',
    window_end TEXT NOT NULL DEFAULT '17:00',
    daily_limit INTEGER NOT NULL DEFAULT 50,
    min_gap_sec INTEGER NOT NULL DEFAULT 240,
    max_gap_sec INTEGER NOT NULL DEFAULT 600,
    stop_on_reply INTEGER NOT NULL DEFAULT 1,
    stop_on_auto_reply INTEGER NOT NULL DEFAULT 0,
    stop_company_on_reply INTEGER NOT NULL DEFAULT 1,
    track_opens INTEGER NOT NULL DEFAULT 0,
    track_clicks INTEGER NOT NULL DEFAULT 0,
    unsubscribe INTEGER NOT NULL DEFAULT 1,
    skip_missing_vars INTEGER NOT NULL DEFAULT 1,
    skip_risky INTEGER NOT NULL DEFAULT 0,
    ai_mode TEXT NOT NULL DEFAULT 'off',
    ai_instructions TEXT NOT NULL DEFAULT '',
    mailbox_ids TEXT NOT NULL DEFAULT '[]',
    start_at INTEGER,
    launched_at INTEGER,
    completed_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE campaign_steps (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    delay_days REAL NOT NULL DEFAULT 3,
    variants TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX idx_steps_campaign ON campaign_steps(campaign_id, position);
  CREATE TABLE campaign_leads (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued',
    step INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
    thread_message_id TEXT,
    thread_subject TEXT,
    last_message_id TEXT,
    refs TEXT NOT NULL DEFAULT '',
    variants TEXT NOT NULL DEFAULT '{}',
    ai TEXT NOT NULL DEFAULT '{}',
    ai_attempts INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_sent_at INTEGER,
    replied_at INTEGER,
    interest TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (campaign_id, lead_id)
  );
  CREATE INDEX idx_cl_due ON campaign_leads(campaign_id, status, next_at);
  CREATE INDEX idx_cl_lead ON campaign_leads(lead_id);

  CREATE TABLE conversations (
    id INTEGER PRIMARY KEY,
    mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE SET NULL,
    subject TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    label TEXT,
    label_by TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    unread INTEGER NOT NULL DEFAULT 0,
    has_inbound INTEGER NOT NULL DEFAULT 0,
    ai_summary TEXT,
    ai_pending INTEGER NOT NULL DEFAULT 0,
    last_at INTEGER NOT NULL,
    last_inbound_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_conv_inbox ON conversations(has_inbound, last_at);
  CREATE INDEX idx_conv_lead ON conversations(lead_id);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
    mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE SET NULL,
    step INTEGER,
    variant TEXT,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_id TEXT,
    in_reply_to TEXT,
    refs TEXT,
    from_addr TEXT NOT NULL DEFAULT '',
    to_addr TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    html TEXT,
    token TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'sent',
    error TEXT,
    opens INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    first_open_at INTEGER,
    first_click_at INTEGER,
    imap_uid INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_msg_mid ON messages(message_id);
  CREATE INDEX idx_msg_mailbox ON messages(mailbox_id, direction, created_at);
  CREATE INDEX idx_msg_campaign ON messages(campaign_id, created_at);
  CREATE INDEX idx_msg_conv ON messages(conversation_id, created_at);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    campaign_id INTEGER,
    lead_id INTEGER,
    mailbox_id INTEGER,
    message_id INTEGER,
    step INTEGER,
    variant TEXT,
    data TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_events_campaign ON events(campaign_id, type, created_at);
  CREATE INDEX idx_events_time ON events(created_at);

  CREATE TABLE warmup (
    id INTEGER PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    from_mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
    to_mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
    parent_id INTEGER,
    message_id TEXT,
    subject TEXT NOT NULL DEFAULT '',
    sent_at INTEGER NOT NULL,
    landed TEXT,
    checked_at INTEGER,
    replied INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_warmup_from ON warmup(from_mailbox_id, sent_at);
  CREATE INDEX idx_warmup_to ON warmup(to_mailbox_id, checked_at);

  CREATE TABLE website_cache (
    host TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
  // v2 – Produkte, Einwilligung/Anlass je Lead, Freigabe & Rechtsgrundlage je Kampagne, Nachfassen, Aufgaben/Anrufliste
  `
  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    offer TEXT NOT NULL DEFAULT '',
    icp TEXT NOT NULL DEFAULT '',
    proof TEXT NOT NULL DEFAULT '',
    booking_url TEXT NOT NULL DEFAULT '',
    kit_url TEXT NOT NULL DEFAULT '',
    kit_label TEXT NOT NULL DEFAULT '',
    nurture_texts TEXT NOT NULL DEFAULT '[]',
    profile TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE knowledge_docs_v2 (
    id INTEGER PRIMARY KEY,
    target_group_id INTEGER REFERENCES target_groups(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    file_name TEXT,
    mime TEXT,
    size INTEGER NOT NULL DEFAULT 0,
    data BLOB,
    created_at INTEGER NOT NULL
  );
  INSERT INTO knowledge_docs_v2 (id, target_group_id, title, kind, content, file_name, mime, size, data, created_at)
    SELECT id, target_group_id, title, kind, content, file_name, mime, size, data, created_at FROM knowledge_docs;
  DROP TABLE knowledge_docs;
  ALTER TABLE knowledge_docs_v2 RENAME TO knowledge_docs;
  CREATE INDEX idx_docs_tg ON knowledge_docs(target_group_id);
  CREATE INDEX idx_docs_product ON knowledge_docs(product_id);

  ALTER TABLE leads ADD COLUMN consent_status TEXT NOT NULL DEFAULT 'none';
  ALTER TABLE leads ADD COLUMN consent_source TEXT NOT NULL DEFAULT '';
  ALTER TABLE leads ADD COLUMN consent_at INTEGER;
  ALTER TABLE leads ADD COLUMN reason TEXT NOT NULL DEFAULT '';
  ALTER TABLE leads ADD COLUMN hold_until INTEGER;
  ALTER TABLE leads ADD COLUMN meeting_at INTEGER;

  CREATE TABLE lead_fit (
    lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    fit TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (lead_id, product_id)
  );

  ALTER TABLE campaigns ADD COLUMN product_id INTEGER REFERENCES products(id) ON DELETE SET NULL;
  ALTER TABLE campaigns ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE campaigns ADD COLUMN legal_basis TEXT NOT NULL DEFAULT 'consent';
  ALTER TABLE campaigns ADD COLUMN cold_ack_by TEXT;
  ALTER TABLE campaigns ADD COLUMN cold_ack_at INTEGER;
  ALTER TABLE campaigns ADD COLUMN approved_at INTEGER;
  ALTER TABLE campaigns ADD COLUMN approved_by TEXT;
  ALTER TABLE campaigns ADD COLUMN approved_hash TEXT;
  ALTER TABLE campaigns ADD COLUMN min_fit TEXT NOT NULL DEFAULT '';
  ALTER TABLE campaigns ADD COLUMN nurture_enabled INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE campaigns ADD COLUMN nurture_days INTEGER NOT NULL DEFAULT 3;
  ALTER TABLE campaigns ADD COLUMN nurture_max INTEGER NOT NULL DEFAULT 2;
  ALTER TABLE campaigns ADD COLUMN nurture_mode TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE campaigns ADD COLUMN nurture_texts TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE campaigns ADD COLUMN call_on_interest INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE campaigns ADD COLUMN call_after_sequence INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_campaign_product ON campaigns(product_id, is_template);

  ALTER TABLE conversations ADD COLUMN nurture_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE conversations ADD COLUMN nurture_next_at INTEGER;
  ALTER TABLE conversations ADD COLUMN nurture_stopped TEXT;
  ALTER TABLE conversations ADD COLUMN meeting_at INTEGER;
  CREATE INDEX idx_conv_nurture ON conversations(nurture_next_at);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    due_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    attempts INTEGER NOT NULL DEFAULT 0,
    outcome TEXT,
    notes TEXT NOT NULL DEFAULT '',
    draft TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    done_at INTEGER
  );
  CREATE INDEX idx_tasks_open ON tasks(status, due_at);
  CREATE INDEX idx_tasks_lead ON tasks(lead_id);

  CREATE TABLE ai_jobs_usage (
    day TEXT PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER
  );
  `,
  // v3 – Revenue Intelligence: Projekte (Geschäftsbereiche), Firmen (Account Brain) mit Belegen, Anlässen, Hypothesen,
  // Gedächtnis und Personen; Plays; Verkaufschancen mit Zuordnung bis zum Umsatz.
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO projects (name, slug, description, color, position, created_at, updated_at) VALUES
    ('Webseite', 'webseite', 'Websites, Karriereseiten und Relaunches', '#2b7353', 1, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
    ('Software Sales App', 'software-sales-app', 'Sales App für Vertriebsteams', '#24589e', 2, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
    ('Software Mittelstand', 'software-mittelstand', 'Prozess-Software für den Mittelstand (Auftrag bis Rechnung)', '#7a4bb0', 3, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000),
    ('Webseite / Automation', 'webseite-automation', 'Website plus Automatisierung (Anfragen, Bewerbungen, Prozesse)', '#b26b00', 4, CAST(strftime('%s','now') AS INTEGER) * 1000, CAST(strftime('%s','now') AS INTEGER) * 1000);

  ALTER TABLE products ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
  ALTER TABLE target_groups ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
  ALTER TABLE lead_lists ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;

  CREATE TABLE plays (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    industry TEXT NOT NULL DEFAULT '',
    trigger_type TEXT NOT NULL DEFAULT '',
    persona TEXT NOT NULL DEFAULT '',
    pain TEXT NOT NULL DEFAULT '',
    angle TEXT NOT NULL DEFAULT '',
    proof TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT 'call',
    cta TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE campaigns ADD COLUMN play_id INTEGER REFERENCES plays(id) ON DELETE SET NULL;

  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    domain TEXT UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    employees TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    play_id INTEGER REFERENCES plays(id) ON DELETE SET NULL,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    lifecycle TEXT NOT NULL DEFAULT 'discovered',
    lifecycle_at INTEGER,
    fit_score INTEGER,
    pain_score INTEGER,
    timing_score INTEGER,
    contactability_score INTEGER,
    opportunity_score INTEGER,
    score_reasons TEXT NOT NULL DEFAULT '{}',
    why_now TEXT NOT NULL DEFAULT '',
    why_now_confidence INTEGER,
    strategy TEXT NOT NULL DEFAULT '{}',
    suggested_play TEXT NOT NULL DEFAULT '{}',
    researched_at INTEGER,
    research_error TEXT,
    next_check_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_accounts_state ON accounts(lifecycle, opportunity_score);
  CREATE INDEX idx_accounts_project ON accounts(project_id);
  CREATE INDEX idx_accounts_check ON accounts(next_check_at);

  ALTER TABLE leads ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL;
  CREATE INDEX idx_leads_account ON leads(account_id);

  CREATE TABLE account_people (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    committee_role TEXT NOT NULL DEFAULT '',
    decision_power TEXT NOT NULL DEFAULT '',
    pain_influence TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    do_not_contact INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_people_account ON account_people(account_id);
  CREATE UNIQUE INDEX idx_people_lead ON account_people(lead_id) WHERE lead_id IS NOT NULL;

  CREATE TABLE account_facts (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    key TEXT NOT NULL DEFAULT '',
    statement TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'estimate',
    confidence INTEGER NOT NULL DEFAULT 50,
    source_type TEXT NOT NULL DEFAULT 'website',
    source_url TEXT NOT NULL DEFAULT '',
    quote TEXT NOT NULL DEFAULT '',
    observed_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT NOT NULL DEFAULT 'ai',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_facts_account ON account_facts(account_id, status);

  CREATE TABLE account_signals (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'other',
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    quote TEXT NOT NULL DEFAULT '',
    strength INTEGER NOT NULL DEFAULT 50,
    confidence INTEGER NOT NULL DEFAULT 50,
    observed_at INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT NOT NULL DEFAULT 'ai',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_signals_account ON account_signals(account_id, status);

  CREATE TABLE account_hypotheses (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'pain',
    statement TEXT NOT NULL,
    interpretation TEXT NOT NULL DEFAULT '',
    confidence INTEGER NOT NULL DEFAULT 50,
    evidence TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'open',
    rank INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL DEFAULT 'ai',
    resolved_note TEXT NOT NULL DEFAULT '',
    resolved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_hyp_account ON account_hypotheses(account_id, status);

  CREATE TABLE account_memory (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'note',
    text TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'user',
    meta TEXT NOT NULL DEFAULT '{}',
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_memory_account ON account_memory(account_id, kind);

  CREATE TABLE opportunities (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    play_id INTEGER REFERENCES plays(id) ON DELETE SET NULL,
    campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    person_id INTEGER REFERENCES account_people(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT 'meeting',
    value_eur INTEGER,
    probability INTEGER,
    meeting_at INTEGER,
    quality TEXT NOT NULL DEFAULT '{}',
    prep TEXT,
    discovery TEXT,
    attribution TEXT NOT NULL DEFAULT '{}',
    loss TEXT NOT NULL DEFAULT '{}',
    next_step TEXT NOT NULL DEFAULT '',
    next_step_at INTEGER,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE INDEX idx_opps_stage ON opportunities(stage, project_id);
  CREATE INDEX idx_opps_account ON opportunities(account_id);

  ALTER TABLE tasks ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;
  ALTER TABLE tasks ADD COLUMN person_id INTEGER REFERENCES account_people(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_tasks_account ON tasks(account_id);
  `,
  // v4: Kampagnen langsam hochfahren (Woche 1, Woche 2, danach Tageslimit).
  `
  ALTER TABLE campaigns ADD COLUMN ramp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE campaigns ADD COLUMN ramp_week1 INTEGER NOT NULL DEFAULT 150;
  ALTER TABLE campaigns ADD COLUMN ramp_week2 INTEGER NOT NULL DEFAULT 250;
  `,
  // v5: Eine Zielgruppe kann zusätzlich in weiteren Projekten gelten (z. B. Webseite und Webseite/Automation teilen sie).
  `
  ALTER TABLE target_groups ADD COLUMN also_project_ids TEXT NOT NULL DEFAULT '[]';
  `,
  // v6: Nur Cold Mailing – telefoniert wird in der eigenen Sales App. Offene Anruf-Aufgaben schließen, Anruf-Optionen aus.
  `
  UPDATE tasks SET status = 'dismissed', outcome = COALESCE(outcome, 'sales_app'), done_at = CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE type IN ('call','call_sequence') AND status = 'open';
  UPDATE campaigns SET call_on_interest = 0, call_after_sequence = 0;
  UPDATE plays SET channel = 'email' WHERE channel != 'email';
  `,
  // v7: Leadquellen – Firmen aus OpenStreetMap finden, Website/Impressum prüfen, passende in den Pool des Projekts legen.
  `
  CREATE TABLE sourcing_runs (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    list_id INTEGER REFERENCES lead_lists(id) ON DELETE SET NULL,
    profile TEXT NOT NULL DEFAULT 'website',
    source TEXT NOT NULL DEFAULT 'osm',
    regions TEXT NOT NULL DEFAULT '[]',
    categories TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued',
    max_candidates INTEGER NOT NULL DEFAULT 300,
    found INTEGER NOT NULL DEFAULT 0,
    checked INTEGER NOT NULL DEFAULT 0,
    imported INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    duplicates INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0,
    region_index INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE TABLE sourcing_candidates (
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES sourcing_runs(id) ON DELETE CASCADE,
    project_id INTEGER,
    osm_id TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL DEFAULT '',
    website TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '',
    plz TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    region TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    fit TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    checked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_cand_run_status ON sourcing_candidates(run_id, status);
  CREATE INDEX idx_cand_domain ON sourcing_candidates(domain);
  CREATE INDEX idx_cand_checked ON sourcing_candidates(checked_at);
  `,
  // v8: Kampagne lädt neue Leads einer Liste automatisch nach (Autopilot: Pool → Kampagne)
  `
  ALTER TABLE campaigns ADD COLUMN auto_list_id INTEGER REFERENCES lead_lists(id) ON DELETE SET NULL;
  `,
  // v9: Tages-Autopilot – automatisch gestartete Leadquellen-Läufe (Pool nachfüllen) kennzeichnen
  `
  ALTER TABLE sourcing_runs ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
  `
];

function normalize(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}
function params(args) {
  if (args.length === 1 && args[0] && typeof args[0] === "object" && !Buffer.isBuffer(args[0]) && !(args[0] instanceof Uint8Array)) {
    const out = {};
    for (const [k, v] of Object.entries(args[0])) out[k] = normalize(v);
    return [out];
  }
  return args.map(normalize);
}
function stmt(sql) {
  let s = statements.get(sql);
  if (!s) {
    s = db.prepare(sql);
    statements.set(sql, s);
  }
  return s;
}

export function openDb(file) {
  if (db) closeDb();
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  migrate();
  return db;
}
export function closeDb() {
  statements.clear();
  if (db) db.close();
  db = null;
}

function migrate() {
  const current = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

export const q = {
  get: (sql, ...args) => stmt(sql).get(...params(args)),
  all: (sql, ...args) => stmt(sql).all(...params(args)),
  run: (sql, ...args) => stmt(sql).run(...params(args)),
  exec: (sql) => db.exec(sql),
  value(sql, ...args) {
    const row = stmt(sql).get(...params(args));
    return row ? Object.values(row)[0] : undefined;
  }
};

let depth = 0;
export function tx(fn) {
  if (depth > 0) return fn();
  // Zähler erst nach erfolgreichem BEGIN erhöhen – schlägt BEGIN fehl (z. B. „database is locked“), bleibt alles konsistent.
  db.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    depth--;
  }
}

// Einfügen/Aktualisieren aus Objekten. Spaltennamen kommen ausschließlich aus dem Code (Whitelist), nie aus Eingaben.
export function insert(table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(k => "$" + k).join(", ")})`;
  return Number(q.run(sql, row).lastInsertRowid);
}
export function update(table, id, row) {
  const keys = Object.keys(row);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map(k => `${k} = $${k}`).join(", ")} WHERE id = $__id`;
  return Number(q.run(sql, { ...row, __id: id }).changes);
}

export function getSetting(key, fallback = null) {
  const row = q.get("SELECT value FROM settings WHERE key = ?", key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
export function setSetting(key, value) {
  q.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
}

// Suchmuster für LIKE … ESCAPE '\\' – % und _ werden wörtlich gesucht (z. B. „max_muster@…“).
export const likeAny = text => `%${String(text).replace(/[\\%_]/g, c => "\\" + c)}%`;

export function parseJson(text, fallback) {
  if (text === null || text === undefined || text === "") return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}
