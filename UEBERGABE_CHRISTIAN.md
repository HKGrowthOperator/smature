# Übergabe an Christian Richter – Smarture Coldmail

Stand 01.11.2026. Ab jetzt betreibt Christian die App komplett selbst – Code, Inhalte, Server. Luis ist danach nicht mehr beteiligt.
Diese Datei enthält **keine** Passwörter oder Schlüssel (das Repo ist öffentlich). Zugangsdaten gibt Luis persönlich weiter.

---

## 1. Was steht – der aktuelle Stand

**Betrieb**
- App läuft in Coolify (noch über http, Adresse gibt Luis weiter), Datenbank im Volume `/app/data`.
- Admin-Login: E-Mail und Passwort gibt Luis persönlich weiter – Passwort sofort in der App ändern.
- Jeder Push auf `main` von `HKGrowthOperator/smature` wird automatisch deployt. Bei jedem Push laufen Tests, Geheimnis-Suche und Kundendaten-Sperre (GitHub Actions „Sicherheit & Tests“).

**Postfächer und Domains**
- 10 Google-Workspace-Postfächer auf `joinsmarture.com` (3), `reachsmarture.com` (3), `usesmarture.com` (3), `gosmarture.com` (1) – alle verbunden, SMTP über Port 587 (Hetzner sperrt 465), IMAP ok.
- DNS liegt bei Google (Nameserver `ns-cloud-*.googledomains.com`), nicht bei ALL-INKL oder Zapmail. SPF, DKIM, DMARC, MX: in der App geprüft, alle 4 Domains 100/100.
- Warmup läuft seit 01.11. → **frühester Versandstart Montag, 16.11.2026**. Tageslimit 30 je Postfach = 300/Tag. Eine fünfte Domain ist nicht nötig; Puffer: 2 weitere Postfächer auf `gosmarture.com`.

**Kampagne „Webauftritt – GaLaBau“** (Entwurf, noch nicht freigegeben)
- Mail 1: A/B-Test, Betreff „Ein digitaler Mitarbeiter für {{company}}?“ – Variante 1 „Hero ausführlich“ (mit `{{beobachtung_konkret|}}`), Variante 2 „Hero kurz“.
- Mail 2 nach 3 Tagen im selben Verlauf (Nachhaken), Mail 3 nach weiteren 5 Tagen (letzte Mail, Winter-Satz nur für GaLaBau – ab Frühjahr austauschen).
- Grußformel steht nicht im Text; die Signatur „Beste Grüße / Christian Richter / Geschäftsführer“ hängt die App an.
- KI-Modus „Einstiegssatz“: `{{ai_first_line|}}` = ein belegter, positiver Satz über den Betrieb. Fällt er durch die Prüfung, bleibt die Zeile leer. Ohne KI-Zugang warten die Mails.
- Alle 10 Postfächer, Mo–Fr 8–17 Uhr, sanftes Hochfahren.

**Zielgruppe und Produkt** (aus DealUno, Regel-Fassung 2026-10-07.1)
- Zielgruppe „GaLaBau – Hunsrück, Nahe, Rheinhessen“: inhabergeführt, 3–20 Mitarbeitende, Entscheider Inhaber; gute Google-Bewertungen bei schwacher Website, Wachstumssignal. Ausschluss: Ketten/Franchise, starke Website oder Google Ads, keine Bewertungen, Gartencenter/Baumärkte, Verbände/Innungen.
- Später mit gleichen Kriterien: SHK (2), Elektro/PV (3), Dachdecker (4), Bestatter (5; Mainz, Simmern, Bad Kreuznach, 2–20 MA).
- Produkt „Webauftritt für Handwerker“: Nutzen, Gesprächsziel Erstgespräch, Beleg „Wir starten gerade, keine Referenzen“. **Preise stehen bewusst nirgends** in der App oder in Mails.

**Regeln aus DealUno – in der App umgesetzt**
- Keine E-Mail-Adressen raten: Einstellung „Chef-Adressen bilden“ ist **aus** (nur wörtlich veröffentlichte Adressen).
- Keine Freemail-Adressen in Kaltakquise (abschaltbar, nicht empfohlen).
- Nichts behaupten, was nicht belegt ist: KI-Regeln + Qualitätsprüfung; `{{beobachtung_konkret}}` nur mit Beleg.
- Nie an Kanzleien, Steuerberater, Behörden, Kammern, Verbände. Abmeldung/„kein Interesse“ sperrt die ganze Firma.
- Google-Bewertungen: Prüfung über die Google Places API ist eingebaut (wird aktiv mit `GOOGLE_PLACES_API_KEY`). Ohne Bewertungen → aussortiert, gute Bewertungen (ab 10 und 4,5 ★) + mittlere Website → Qualität A. Bewertungen werden nicht gespeichert.
- Google Ads prüft die App nicht – bei Bedarf von Hand (Google Ads Transparency Center).

**Leadquellen**
- Regionen: Rhein-Hunsrück-Kreis, Landkreis Bad Kreuznach, Landkreis Birkenfeld, Landkreis Mainz-Bingen, Landkreis Alzey-Worms, Mainz, Worms.
- Projekt „Smarture“ sucht automatisch **nur** in der Kategorie „Garten- und Landschaftsbau“.

---

## 2. Was Christian vor dem Start erledigen muss

- [ ] **Absenderangaben (Fußzeile) + Datenschutz-Link** – Pflicht, ohne sie startet keine Kampagne (Rechts-Check). Eine Zeile reicht:
      `Christian Richter · Smarture · Straße Nr. · PLZ Ort · E-Mail · Datenschutz: {{privacy_url}}`
      Privatadresse nicht zeigen? → ladungsfähige Geschäftsadresse über Postdienst/virtuelles Büro. Datenschutz: einfache Seite auf der Website (Claude schreibt einen Entwurf).
- [ ] **Eigener KI-Zugang** – empfohlen API-Key aus der eigenen Anthropic Console (`AI_PROVIDER=api`, `ANTHROPIC_API_KEY`); den bisherigen Token ersetzen.
- [ ] **`GOOGLE_PLACES_API_KEY`** in Coolify (Google Cloud → „Places API (New)“ → API-Schlüssel, auf Places API beschränken).
- [ ] **Calendly-Link** → Produkt → Termin-Link; Webhook aus Einstellungen → Termine in Calendly eintragen.
- [ ] **HTTPS** – A-Record `app.<domain>` → IP des Servers, in Coolify als Domain eintragen, dann `APP_URL=https://…` und `COOKIE_SECURE=true`. Coolify selbst ebenso (Settings → Instance Domain).
- [ ] **Rechtsgrundlage** der Kampagne festlegen. Werbemails an Firmen brauchen in Deutschland eine Einwilligung (§ 7 Abs. 2 Nr. 2 UWG). Bewusste Kaltakquise muss in der Kampagne ausdrücklich bestätigt werden – das Risiko liegt beim Absender.
- [ ] **Tageslimit** nach Entwurfs-Kapazität (jede Zusage = Entwurf in zwei Tagen; 300 Mails/Tag ≈ 6–9 Entwürfe/Tag).
- [ ] **AV-Verträge**: Hetzner (Konsole), Google Workspace (Admin → Data Processing Amendment), Anthropic (nur mit API-Key). Informationspflicht Art. 14 DSGVO für gespeicherte Geschäftsführer-Namen.
- [ ] **Testmail** an ein eigenes Postfach, dann Kampagne **freigeben**.

---

## 3. Luis komplett rausnehmen

1. **Ein Repo als Quelle festlegen** (siehe Abschnitt 4) – Luis überträgt `HKGrowthOperator/smature` an Christian (GitHub → Settings → *Transfer ownership*).
2. **Coolify-Quelle** auf das Repo in Christians Konto umstellen (GitHub App auf Christians Konto), einmal deployen.
3. **Coolify/Server**: Christian als Owner (Coolify → Team → Members), Luis entfernen. Läuft der Server auf Luis' Hetzner-Konto: eigener Server, Backup von `/app/data` (inkl. `.app-secret`) umziehen, **`APP_SECRET` unverändert** übernehmen.
4. **Alles erneuern**: Coolify-API-Tokens löschen, Admin-Passwort ändern, eigener KI-Zugang, neue Google-App-Passwörter für alle 10 Postfächer (in der App unter *Postfächer* eintragen).
5. **Prüfen**: *Einrichtung* grün, *Postfächer* → Verbindungstest grün.

---

## 4. Das Repo am besten steuern

**Eine Quelle, nicht zwei.** Christians Fork liegt mehrere Commits hinter `HKGrowthOperator/smature`, und Coolify deployt nur von dort. Empfehlung:

- **Variante A (empfohlen):** Luis überträgt `HKGrowthOperator/smature` an Christian. Christian löscht danach seinen alten Fork (oder benennt ihn um, falls der Name kollidiert). Ein Repo, eine Historie, Coolify zeigt darauf.
- **Variante B:** Christian behält seinen Fork → auf GitHub **„Sync fork“** klicken (holt alle Änderungen), dann in Coolify die Quelle auf den Fork umstellen. Das alte Repo danach archivieren.

**Arbeiten mit Claude Code**
1. claude.ai/code (oder lokal `claude` im Repo-Ordner) → Repo wählen. Claude liest `CLAUDE.md` und kennt Aufbau, Regeln und offene Aufgaben.
2. Änderung in eigenen Worten beschreiben → Claude arbeitet auf einem Branch, lässt `npm test` laufen und öffnet einen Pull Request.
3. Christian prüft den Pull Request → **Merge** → Coolify deployt automatisch (ca. 1 Minute, kurz 502 während des Wechsels).

**Absichern (einmal einstellen, GitHub → Settings):**
- *Branches* → Regel für `main`: „Require a pull request“ und „Require status checks“ (Sicherheit & Tests) – dann geht nichts Ungeprüftes live.
- *Code security*: Secret scanning + Push protection an (blockiert versehentlich gepushte Schlüssel), Dependabot an (Sicherheits-Updates als Pull Request).

**Beispiel-Aufträge an Claude**
- „Trag die Fußzeile ein: … und setze den Datenschutz-Link …“ (über `BOOTSTRAP_JSON`, siehe `CLAUDE.md`)
- „Leg eine zweite Zielgruppe SHK/Heizung mit eigenem Projekt, Produkt und Kampagne an – gleiche Kriterien wie GaLaBau.“
- „Tausche in Mail 3 den Winter-Satz gegen einen Satz für das Frühjahr.“
- „Ergänze Regionen: Rhein-Lahn-Kreis, Westerwaldkreis.“
- „Prüfe die offenen Dependabot-Pull-Requests und merge die, bei denen die Tests grün sind.“

**Inhalte per Coolify setzen** (wenn Claude nicht in die App kommt): Variable `BOOTSTRAP_JSON` in Coolify setzen → redeploy → im Container-Log stehen die Ergebnisse (`BOOTSTRAP: …`) → Variable wieder löschen. Möglich: Einstellungen (Fußzeile, Datenschutz-Link, Termin-Link, Regionen, Prüf-Limit), Projekte, Postfächer, Kampagne (nur solange nicht freigegeben), DNS-Prüfung, Autopilot-Kategorien. Details in `src/bootstrap.js`.

---

## 5. Automatisierung

**Ebene 1 – Tages-Autopilot in der App (Leadsuche + Versand)**

Einmal einrichten, danach läuft jeden Tag von allein: Folge-Mails zuerst → neue Erst-Mails aus dem Pool → Pool wird nachgefüllt, sobald er unter 7 Versandtage fällt (neuer Suchlauf, jede Suche in einer anderen Region) → einmal am Tag aufräumen.

1. **Leadquellen → Regionen & Limit**: Regionen prüfen, Website-Prüfungen pro Tag 100–300, Google-Regeln (aus ohne Bewertungen; gut ab 10 / 4,5 ★).
2. **Projektkarte Smarture → Suche starten** → Kategorie „Garten- und Landschaftsbau“ (erster Lauf von Hand).
3. **Projektkarte Smarture → „Pool → Kampagne“** – verbindet „Webauftritt – GaLaBau“ mit dem Pool.
4. **Kampagne freigeben und starten** (ab 16.11.).
5. **Leadquellen → Tages-Autopilot → Anteile & Regeln** (Puffer 7 Tage, Aufräumen nach 60 Tagen) → **Einschalten**.

Täglich bleibt nur: *Heute* öffnen, Antworten in unter 30 Minuten, Entwürfe in zwei Tagen, warme Leads weitergeben.

**Ebene 2 – GitHub (läuft schon)**
- Bei jedem Push: Tests, Geheimnis-Suche, Kundendaten-Sperre.
- Coolify deployt jeden Merge auf `main` automatisch.
- Dependabot (nach dem Einschalten): Sicherheits-Updates kommen als Pull Request.

**Ebene 3 – optional: wöchentlicher Check mit Claude Code**

In Claude Code (claude.ai/code → Routines, oder `/schedule` in einer Sitzung) eine Routine anlegen, z. B. **montags 7:40 Uhr** im Smarture-Repo:

> „Prüfe das Repo smarture: offene Dependabot-Pull-Requests mit grünen Tests mergen, sonst zusammenfassen. Prüfe, ob die letzte GitHub-Actions-Ausführung auf `main` grün ist. Fasse mir in fünf Zeilen zusammen, was sich geändert hat und was ich tun muss.“

Die Routine läuft mit Christians eigenem Claude-Konto. Sie greift nicht in die App-Daten ein – Kampagnen freigeben und starten bleibt bewusst Handarbeit.

**Backup**: In der Hetzner-Konsole für den Server *Backups* einschalten (tägliche Sicherung, auch des Volumes `/app/data`).

---

## 6. Variablen in Coolify (Werte nur dort, nie ins Repo)

| Variable | Wofür |
| --- | --- |
| `APP_URL` | Adresse der App (später `https://…`) |
| `APP_SECRET` | **nie ändern** – verschlüsselt die Postfach-Passwörter |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | erster Admin; Passwort danach in der App ändern |
| `TRUST_PROXY=true`, `COOKIE_SECURE` | `true` mit HTTPS, `false` solange http |
| `AI_PROVIDER` + `ANTHROPIC_API_KEY` | empfohlen: `api` + eigener API-Key (Commercial Terms, AV-Vertrag möglich) |
| `AI_PROVIDER` + `CLAUDE_CODE_OAUTH_TOKEN` | Alternative `subscription` mit eigenem Max-Abo – für Serverbetrieb laut Anthropic-Bedingungen eine Grauzone |
| `GOOGLE_PLACES_API_KEY` | Google-Bewertungen in den Leadquellen |
| `BOOTSTRAP_JSON` | nur kurzzeitig zum Einrichten, danach löschen |
