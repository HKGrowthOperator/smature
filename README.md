# Smature Coldmail

> **Leere Installation für Smature.** Es sind keine Firmendaten, Leads, Postfächer oder Zugangsdaten enthalten. Firmenname, Impressum, Domains, Produkte, Zielgruppen und Regionen trägst du nach dem ersten Login in der App ein.

## In 10 Minuten startklar

**Variante A – Coolify (empfohlen, mit HTTPS):**

1. Coolify → Neue Ressource → *Public Repository* `https://github.com/HKGrowthOperator/smature`, Build Pack **Dockerfile**, Port **3000**.
2. Domain eintragen, z. B. `https://coldmail.smature.de` (A-Record auf den Server).
3. **Persistent Storage:** Volume nach `/app/data` (dort liegt die Datenbank).
4. Umgebungsvariablen setzen (Vorlage: `.env.example`):
   - `APP_URL=https://coldmail.smature.de`
   - `APP_SECRET=` → Ergebnis von `openssl rand -base64 48` (danach nie mehr ändern)
   - `ADMIN_EMAIL=` / `ADMIN_PASSWORD=` (mind. 12 Zeichen) – erster Login
   - `TRUST_PROXY=true`, `COOKIE_SECURE=true`
   - optional für die KI: `CLAUDE_CODE_OAUTH_TOKEN=` (eigenes Claude-Max-Abo, siehe unten)
5. Deploy → `https://…/healthz` muss `{"ok":true}` zeigen → einloggen.

**Variante B – beliebiger Server mit Docker:**

```bash
git clone https://github.com/HKGrowthOperator/smature && cd smature
cp .env.example .env   # Werte eintragen (siehe oben)
docker compose up -d   # App läuft auf Port 3000 – HTTPS über einen Reverse Proxy davor
```

**Variante C – nur lokal ausprobieren:** `npm install && npm run dev` → http://localhost:3000, Login `admin@localhost.test` / `local-dev-password`.

## Nach dem ersten Login

**Alle Felder zum Ausfüllen stehen in [VORLAGEN.md](VORLAGEN.md).**

1. **Einstellungen → Allgemein:** Firmenname, Impressum/Pflichtangaben (Fußzeile), Link zur Datenschutzerklärung.
2. **Einrichtung:** Versand-Domains bzw. Hauptdomain, Postfächer verbinden, Warmup.
3. **Projekte:** Die vier Spalten (Webseite, Software Sales App, Software Mittelstand, Webseite / Automation) sind nur Beispiele – umbenennen, löschen oder eigene anlegen.
4. **Produkte & Zielgruppen** anlegen, Vorlage mit KI erstellen, freigeben.
5. **Leadquellen → Regionen & Limit:** eigene Regionen eintragen (Standard ist leer – ohne Region sucht der Autopilot keine neuen Firmen).

---


Selbst gehostete Vertriebs-App – wie Instantly, aber **pro Projekt und Produkt** und mit eingebauten Leitplanken. Ziel ist nicht möglichst viele Mails, sondern **qualifizierte Termine und Aufträge**: Die App merkt sich pro Firma, was wir sicher wissen (mit Quelle), was wir nur vermuten und was widerlegt ist, erkennt Anlässe („Why now“) und sagt jeden Morgen, welche Handvoll Aktionen heute zählen. Für jedes Produkt hinterlegt ihr Angebot, Info-Kit, Termin-Link und Wissen; die KI (Claude, abgerechnet über das **Claude-Max-Abo**) recherchiert Firmen, schreibt Vorlagen, prüft Leads, personalisiert, ordnet Antworten ein und bereitet Termine vor. Nichts geht ungeprüft raus: Texte werden freigegeben, Rechts-Check, Kontaktregeln und eine Qualitätsprüfung (Creepy-Score, Zahlen ohne Beleg) laufen automatisch. Alle Daten bleiben auf dem eigenen Server.

## Was die App kann

| Bereich | Funktionen |
| --- | --- |
| **Einrichtung** | Geführt in 5 Schritten mit Live-Prüfung – wie die üblichen Setup-Leitfäden für Zapmail + Instantly, nur komplett in der App und ohne Tool-Kosten: 5 Versand-Domains (nie die Hauptdomain, seriöse Endung, Name nah an der Firma, DNS-Check, keine Weiterleitung) → 10 Postfächer (2 je Domain, Klarnamen, in einem Schritt verbinden) → Warmup 14 Tage + schlanke Signaturen → Kampagne (Europe/Berlin, Mo–Fr 8–17 Uhr, Hochfahren 150 → 250 → 300/Tag, alle Postfächer, Standard-Gerüst) → Start-Check und tägliche Routine. Mit Fehlersuche und KI-Assistent. Alternativ der Weg **„Über meine Hauptdomain“**: kein Domainkauf, gern ein Postfach je Projekt, Start sofort mit sanftem Hochfahren (5 Mails, dann +3 pro Tag bis 30); alle Postfächer der Domain zusammen höchstens 60 Mails/Tag – der Versand hält das automatisch ein. |
| **Heute** | Startseite mit den Aktionen, die heute zählen – sortiert nach Wirkung: positive Antworten zuerst (Antwortziel < 30 Min., rot bei Überschreitung), Termine ohne Briefing, Firmen mit neuem Anlass, Angebote zum Nachfassen, beste unberührte Firmen. Kennzahlen: Pipeline gewichtet, gewonnen im Monat. |
| **Projekte** | Board mit einer Spalte je Geschäftsbereich: **Webseite · Software Sales App · Software Mittelstand · Webseite / Automation** (weitere anlegbar). Je Spalte Produkte, Zielgruppen, Plays, Kampagnen, Firmen nach Status, Pipeline und die wichtigsten Aktionen. Produkte, Zielgruppen, Listen, Plays und Firmen werden einem Projekt zugeordnet. **Saubere Trennung:** Wer in eine Liste mit Projekt importiert wird, gehört mit seiner Firma zu diesem Projekt; Kampagnen anderer Projekte nehmen die Firma nicht auf. Umsortieren über „Projekt zuordnen“, Filter nach Projekt in den Leads. |
| **Firmen (Account Brain)** | Leads werden über die Domain ihrer Firma zugeordnet; Firmen lassen sich auch per Website anlegen (z. B. aus einer Messe-Liste). Pro Firma: **Fakten mit Quelle und Zitat** (verifiziert vs. Schätzung), **Anlässe**, **Hypothesen** (bestätigen/widerlegen – widerlegte Annahmen nutzt die KI nie wieder), **Gedächtnis** (Einwände, Systeme, Zeitpunkt, „nicht behaupten“), **Personen im Buying Committee** (auch ohne E-Mail, z. B. Geschäftsführer aus dem Impressum), vier Scores (Fit, Pain, Timing, Erreichbarkeit → Opportunity), Lebenszyklus, Kontakt-Sättigung und der nächste sinnvolle Schritt. |
| **Recherche & Beobachtung** | Die KI liest Startseite, Impressum, Über uns, Karriere und News der Firma, übernimmt nur belegte Fakten (Zitat muss in der Quelle stehen) und Personen, die dort genannt sind. Passende Firmen ohne Anlass werden **regelmäßig neu geprüft** (Standard alle 30 Tage, Tageslimit); taucht ein Anlass auf, springt die Firma auf „Anlass erkannt“ und landet in „Heute“ – zum Aufnehmen in eine Kampagne. |
| **Qualitätsprüfung** | Vor dem Versand jeder KI-Text: Creepy-Score (Überwachungs-Eindruck, Privates), Floskeln, Zahlen ohne Beleg, Vermutungen als Tatsache, widerlegte Annahmen. Fällt ein Text durch, schreibt die KI ihn einmal neu; sonst geht die freigegebene Vorlage unverändert raus. Auch im KI-Feedback zu Vorlagen. |
| **Pipeline** | Termin → qualifiziert → Angebot → gewonnen/verloren. Gebuchte Termine legen automatisch eine Chance an – mit **Herkunft** (erster Kontakt, Kanal, Persona, Anlass, Pain, Play, Angle). **Termin-Briefing** (Fakten, Vermutungen, was wir nicht unterstellen, 6 Fragen entlang des Schmerz-Leitfadens: Situation → warum → Kosten des Nichthandelns → heute → bisher → warum jetzt; der Leitfaden steht auch ohne KI auf jeder Chance), **Gesprächsauswertung** aus Notizen (bestätigte Pains, Systeme, Entscheidungsweg, Einwände, Qualität), Wahrscheinlichkeit nach Gesprächsqualität, Verlust mit Grund und Lernregel. |
| **Plays & Lernen** | Plays = Branche × Anlass × Persona × Pain × Angle × Beleg × Kanal × CTA. Auswertung **bis zum Umsatz** statt bis zur Antwortquote: Umsatz je Firma, qualifizierte Termine, Angebote, Win-Rate – je Play, Angle, Persona, Pain, Anlass, Kanal und Branche; Verlustgründe, früher erkennbare Verluste, häufigste Einwände. |
| **Produkte & Vorlagen** | Pro Produkt Beschreibung, Nutzen, ideale Kunden (inkl. Ausschlüssen), Belege, **Termin-Link** (`{{termin_link}}`), **Info-Kit** (`{{kit_link}}`, `{{kit_name}}`), Info-Blätter (PDF/Text) und ein KI-Produkt-Profil. **Vorlagen mit KI**: Sequenz + Nachfass-Texte aus Produkt- und Zielgruppen-Wissen mit wählbarem **Einstiegsangebot** (Einschätzung, erster Baustein, Pilot, Förderung, Partner, Frage, Erstgespräch – oder von der KI vorschlagen lassen) und festem Aufbau: erste Mail → Nachhaken → ein neuer Aspekt → Relevanz-Frage → Abschluss; daraus mit einem Klick eine Kampagne. |
| **Freigabe** | Jede Vorlage/Kampagne muss freigegeben werden (Name + Zeitpunkt). Jede Änderung an Texten, Abständen, Nachfass-Texten oder Rechtsgrundlage hebt die Freigabe auf; eine laufende Kampagne hält dann automatisch an. |
| **Rechts-Check & Kontaktregeln** | Vor dem Start: Impressum, Abmeldung, Datenschutz-Link, kein Tracking ohne Einwilligung, kein „Re:“/vorgetäuschtes Gespräch oder vorgetäuschter Termin („Meeting {{first_name}} & …“), fehlende Termin-/Kit-Links. Je Lead: Einwilligung mit Quelle, Widerruf, Sperrfrist nach „kein Interesse“, Sperrfrist zwischen Kampagnen, max. Kontakte je Firma, keine Freemail-Adressen in Kaltakquise, **nie das rechtliche Umfeld per Kaltakquise** (Anwälte, Kanzleien, Notare, Steuerberater, Abmahn- und Verbraucherschutz-Vereine, Datenschutz, Inkasso, Kammern, Behörden, Gerichte; eigene Begriffe in den Einstellungen ergänzbar), nur KI-geprüfte A/B-Leads. Gründe sind am Lead sichtbar. |
| **Qualität der Leads** | KI-Prüfung je Produkt im Hintergrund: Passung **A–D** + konkreter Anlass (wird am Lead dokumentiert und in der Personalisierung genutzt). Filter in Leads und Kampagnen. |
| **Nachfassen bei Interesse** | Wer Interesse zeigt, sich nach eurer Antwort aber nicht mehr meldet, bekommt nach X Tagen im selben Thread eine Nachfass-Mail – automatisch nur mit freigegebenen Texten, sonst als Entwurf zur Prüfung. Danach keine weitere Mail – der Lead steht unter „Warm“ zur Übergabe an die Sales App. |
| **Nur Cold Mailing** | Diese App schreibt Mails und nimmt Antworten entgegen – telefoniert wird in der eigenen Sales App. Keine Anruf-Aufgaben, keine Anrufliste. **Aufgaben** entstehen nur für Antworten, Nachfass-Entwürfe und Sonderfälle (z. B. rechtliche Reaktion). Warme Leads (Interesse, Termin, Klick) unter „Leads → Status: Warm“ exportieren und in der Sales App hochladen. Die Telefonnummer ist ein normales Feld am Lead, mehr nicht. |
| **Termine** | Buchungs-Webhook für Calendly, Cal.com oder die eigene Sales App: Buchung → alle Mails, das Nachfassen stoppen, Ereignis + Webhook `lead.meeting`. Absage → Aufgabe „neu vereinbaren“. Auch per Klick „Termin gebucht“. |
| **Postfächer** | Beliebig viele SMTP/IMAP-Postfächer, Vorlagen für Google Workspace, Microsoft 365, IONOS, STRATO, ALL-INKL, Hetzner, Zoho. Verbindungstest, verschlüsselte Passwörter (AES-256-GCM), Tageslimit, **Ramp-up**, Mindestabstand, Signatur, Kopie in „Gesendet“. |
| **Zustellbarkeit** | DNS-Check (MX, SPF, DKIM, DMARC, Blocklisten), reiner Text als Standard, zufällige Abstände, Versandfenster je Zeitzone, List-Unsubscribe + One-Click (RFC 8058), Bounce-Rate je Postfach, saubere Fehlerbehandlung (volles Empfänger-Postfach ≠ eigenes Limit, Absender-Ablehnung pausiert das Postfach). |
| **Warmup** | Internes Warmup zwischen den eigenen Postfächern inkl. Antworten und Rettung aus dem Spam; Posteingangs-Wert je Postfach. |
| **Zielgruppen & Wissen** | Pro Zielgruppe Beschreibung, Angebot, Tonalität, CTA und Info-Blätter; KI-Zielgruppen-Profil. **Geteilte Zielgruppen**: „Gilt auch in“ ordnet eine Zielgruppe zusätzlich weiteren Projekten zu (z. B. Webseite und Webseite / Automation) – Kampagnen und Produkte bleiben je Projekt getrennt, das Board zeigt die Zielgruppe und ihre Listen in jeder Spalte. |
| **Leads** | CSV-Import (Spaltenzuordnung, Einwilligung + Quelle für die ganze Datei), Listen, E-Mail-Prüfung, **Chef-Adresse suchen** (liest Impressum und Kontakt-/Team-Seiten: Name und Anrede der Geschäftsführung; die E-Mail-Adresse veröffentlicht, sonst aus dem Namen und dem Adressmuster der Firma gebildet und als „riskant" markiert – info@ bleibt als Zentrale, Bounces werden erkannt und stoppen den Versand), Blockliste, Export (Filter „Warm“ für die Übergabe an die Sales App per CSV-Upload), DSGVO-Löschung. |
| **Kampagnen** | Sequenzen mit A/B-Varianten, Spintax, Variablen mit Fallback, deutsche Anrede, Follow-ups im Thread, Postfach-Rotation, Vorschau je Lead, Copy-Check, Testmail, Statistik je Schritt/Variante, KI-Personalisierung (Einstiegssatz oder Volltext – Termin-/Kit-Links bleiben immer erhalten). |
| **Unibox** | Alle Mails rein und raus in der App: Antworten, direkte Mails von Unbekannten (werden als Kontakt angelegt, Newsletter/Systemmails bleiben draußen), Filter „Gesendet“; Antworten gehen an den, der zuletzt geschrieben hat. **Nie wieder schreiben** ohne KI: Abmeldung („nie wieder“, „in Ruhe lassen“, „Spam“ …) und Absage („kein Interesse“, „kein Bedarf“) sperren die ganze Firma für Mails; Abmahnung, Anwalt oder DSGVO-Auskunft sperren alles und legen eine dringende Aufgabe an. KI-Einordnung, Zusammenfassung, Antworten im Thread, KI-Antwort- und Nachfass-Entwürfe, Status von Termin/Nachfassen/Aufgaben. |
| **Richtlinien** | Eigene Seite mit Checkliste und den Regeln für E-Mail, Kaltakquise, Pflichtangaben, Tracking und Zustellbarkeit – plus „Texte, die Antworten bekommen“ (was wir aus dem Coaching übernehmen und was bewusst nicht). |
| **Integration** | Signierte Webhooks (`reply.received`, `lead.interested`, `lead.meeting`, `lead.unsubscribed`, `lead.bounced`, `campaign.completed`, `task.created`, `account.triggered`, `opportunity.won`). |
| **Team** | Administratoren/Mitarbeiter, Login mit Rate-Limit, CSRF-Schutz, strikte CSP. |

## Schnellstart lokal

```bash
npm install
npm run dev          # http://localhost:3000 – Login admin@localhost.test / local-dev-password
npm test             # Unit-/Integrationstests (101)
```

Node 22.13+ (nutzt das eingebaute `node:sqlite`, keine nativen Abhängigkeiten).

## KI über das Claude-Max-Abo

Die KI läuft standardmäßig über **Claude Code im Headless-Modus** (`claude -p`) mit eurem Max-Abo. Jede KI-Anfrage zählt gegen die Nutzungslimits des Abos – es entstehen keine Kosten pro Token und es wird kein API-Key benötigt.

1. Auf einem Rechner mit Browser: `npm install -g @anthropic-ai/claude-code`, dann `claude setup-token` ausführen und mit dem Max-Konto anmelden. Der ausgegebene Token ist ca. ein Jahr gültig.
2. Token in Coolify als `CLAUDE_CODE_OAUTH_TOKEN` hinterlegen (Claude Code ist im Docker-Image vorinstalliert), App neu starten.
3. In claude.ai unter **Einstellungen → Nutzung** die **Zusatznutzung ausgeschaltet lassen** – dann kann nie mehr als das Abo verbraucht werden.
4. In der App unter **Einstellungen → KI & Abo** ein eigenes Tageslimit setzen (Standard 300 Anfragen), damit genug Kontingent für eure übrige Arbeit mit Claude bleibt.

Ist das Abo-Limit erreicht, pausiert die KI bis zum Reset: Mails mit KI-Personalisierung warten (ohne Fehlversuch), Mails ohne KI laufen weiter, eine Ausweichung auf die API gibt es nicht. Die App gibt den API-Key nie an Claude Code weiter; `ANTHROPIC_API_KEY` wird nur mit `AI_PROVIDER=api` genutzt (Abrechnung pro Token). Hinweis: Anthropic erlaubt Drittanbietern nicht, claude.ai-Logins oder Abo-Limits in eigenen Produkten anzubieten – diese App ist für den internen Einsatz mit eurem eigenen Abo gedacht.

## Deployment mit Coolify (wie die Website)

1. Neue Ressource → Repository `HKGrowthOperator/smature`, Build Pack **Dockerfile**, **Port 3000**, HTTPS-Domain verbinden (z. B. `coldmail.example.de`).
2. **Persistentes Volume nach `/app/data`** (SQLite-Datenbank mit Leads, Nachrichten, Wissen).
3. Umgebungsvariablen (siehe `.env.example`):

| Variable | Pflicht | Bedeutung |
| --- | --- | --- |
| `APP_URL` | ja | Öffentliche Adresse (Abmelde-, Tracking- und Buchungs-Webhook-Links). |
| `APP_SECRET` | ja | ≥ 32 Zeichen, `openssl rand -base64 48`. Verschlüsselt Postfach-Passwörter – nicht mehr ändern. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | beim ersten Start | Erster Administrator (Passwort ≥ 12 Zeichen). |
| `CLAUDE_CODE_OAUTH_TOKEN` | für KI | Token aus `claude setup-token` (Max-Abo). |
| `AI_PROVIDER` | nein | `subscription` (Standard mit Token) oder `api`. |
| `ANTHROPIC_API_KEY` | nein | Nur für `AI_PROVIDER=api`. |
| `AI_MODEL` | nein | Standard `claude-opus-5-5`. |
| `GOOGLE_PLACES_API_KEY` | nein | Google Places API (New): Leadquellen prüfen Google-Bewertungen. Ohne Bewertungen → aussortiert, gute Bewertungen + mittlere Website → Qualität A (Leadquellen → Regionen & Limit). Bewertungen werden nicht gespeichert, nur Place ID und Ergebnis. |
| `TRUST_PROXY` | nein | `true` hinter Coolify/Traefik. |
| `TRACKING_URL` | nein | Eigene Tracking-Domain (CNAME auf die App). |
| `COOKIE_SECURE` | nein | `true` lassen (HTTPS). |

4. Starten, `/healthz` prüfen, anmelden, die Einrichtungs-Checkliste auf der Übersicht abarbeiten.
5. Backup: Volume `/app/data` regelmäßig sichern.

**Fehlersuche Coolify**

| Symptom | Ursache / Lösung |
| --- | --- |
| `no available server` bzw. 503 | Traefik kennt die Domain, aber kein gesunder Container läuft. Deployment-Log und Container-Log in Coolify öffnen. Häufig: `Konfiguration unvollständig` → `APP_SECRET` fehlt/kürzer als 32 Zeichen, `ADMIN_PASSWORD` kürzer als 12 Zeichen, `APP_URL` fehlt. Oder der Build läuft noch (das Image installiert Claude Code, dauert einige Minuten). |
| Container startet neu / „unhealthy“ | Der Healthcheck ruft `http://127.0.0.1:3000/healthz` im Container auf – **Ports Exposes = 3000** lassen, `PORT` nicht überschreiben. |
| `EACCES` auf `/app/data` | Der Container läuft als Benutzer `node` (UID 1000). Ein **Docker-Volume** verwenden oder beim Bind-Mount den Ordner `chown 1000:1000`. |
| Zertifikatsfehler direkt nach dem Anlegen | Let's Encrypt stellt das Zertifikat erst aus, wenn der Container gesund ist und DNS (A-Record auf den Server) stimmt – nach dem ersten erfolgreichen Start kurz warten. Domain in Coolify mit `https://` eintragen. |
| Login klappt, Sitzung geht sofort verloren | `COOKIE_SECURE=true` braucht HTTPS; hinter Coolify `TRUST_PROXY=true` setzen. |

## Welcher Versand-Anbieter?

Für Akquise **keine** Transaktions-Dienste wie Resend, Postmark oder SendGrid: Deren Nutzungsbedingungen verbieten unaufgeforderte Akquise-Mails und gekaufte Listen – das führt zur Kontosperre und schadet der Domain. Stattdessen echte Postfächer, die die App per SMTP/IMAP anbindet:

- **Google Workspace** (App-Passwörter) oder klassische Hoster wie **IONOS, STRATO, mailbox.org, ALL-INKL** – 2–5 Postfächer.
- Auf einer **separaten Versand-Domain** (z. B. `musterfirma-mail.de` statt der Hauptdomain), mit SPF, DKIM und DMARC.
- Warmup + Ramp-up, 30–50 Mails pro Postfach und Tag nicht überschreiten.

## Einrichtung – empfohlene Reihenfolge

Am einfachsten über **Einrichtung** in der App: Sie prüft jeden Schritt live und zeigt, was fehlt. Zwei Wege: **separate Versand-Domains** (viel Menge, 14 Tage Warmup) oder **über die Hauptdomain** (kein Domainkauf, kleine Menge, Start sofort). Rechtlich ändert die Domain nichts – entscheidend ist die Einwilligung; separate Domains schützen nur den Ruf der Geschäftspost. Kurzfassung:

1. Versand-Domain + Postfächer einrichten, **SPF, DKIM, DMARC** setzen (Postfach → „DNS“), Warmup und Ramp-up an.
2. **Einstellungen → Allgemein**: Impressum/Pflichtangaben für die Fußzeile mit `{{privacy_url}}`, Link zur Datenschutzerklärung.
3. **Einstellungen → Termine**: Termin-Link und den Buchungs-Webhook im Buchungstool eintragen. **Kontaktregeln** prüfen.
4. **Produkt** anlegen: Angebot, ideale Kunden, Termin-Link, Info-Kit, Info-Blätter → „Produkt-Profil aus Wissen erstellen“.
5. **Vorlage mit KI** erstellen, in der Vorschau mit echten Leads prüfen, Testmail an euch, anpassen, **freigeben**.
6. Leads importieren – mit Einwilligung + Quelle, wenn sie vorliegt – und „Qualität prüfen (KI)“.
7. Aus der Vorlage eine **Kampagne** erstellen, Leads hinzufügen, Zeitfenster wählen, starten.
8. **Projekte** prüfen: Produkte und Zielgruppen den vier Spalten zuordnen, pro Projekt 1–3 **Plays** anlegen (wen sprechen wir mit welchem Anlass und welchem Argument an?).
9. **Firmen** anlegen oder aus den Leads übernehmen lassen und **recherchieren** – Firmen mit Anlass erscheinen in „Heute“.
10. Täglich **Heute** abarbeiten: erst Antworten, dann Termine vorbereiten, dann warme Leads per Export in die Sales App übergeben. Nach jedem Termin die Gesprächsnotizen auswerten lassen, Chancen bis gewonnen/verloren pflegen – nur so lernt „Plays & Lernen“, was Umsatz bringt.

## Leadquellen (Scraping je Projekt)

Unter **Leadquellen** füllt die App für jedes Projekt einen eigenen Pool mit neuen Firmen – ohne Zukauf, ohne fremde Verzeichnisse:

1. **Finden:** OpenStreetMap (Overpass API) liefert Firmen mit Website oder E-Mail je Region (Verwaltungsname, z. B. „Oberbergischer Kreis“, „Köln“) und Kategorie (Handwerk, Werkstätten, Fachhandel, Gastronomie, Agenturen, Industrie, Logistik …). Je Region eine Abfrage, eigener User-Agent, Fair-Use.
2. **Prüfen:** Die App liest höchstens 5 eigene Seiten der Firma (Start, Impressum, Über uns, Karriere, Referenzen/Kontakt) und leitet ab: Qualität der Website (0–10: HTTPS, Handy-Tauglichkeit, Baukasten, Alter, Formular …), Anfrage-Signale (Formular, Online-Terminbuchung, WhatsApp, Notdienst), Mitarbeiterzahl und offene Stellen, Geschäftsführung aus dem Impressum, Adresse/Telefon/Rechtsform und **belegte Fakten** für ein echtes Lob (seit wann, Familienbetrieb, Meisterbetrieb, Zertifikate, Auszeichnungen, Bewertungen, Kundenzahl). Keine SMTP-Abfragen bei fremden Servern, keine Logins.
3. **Bewerten und zuordnen:** Jede Firma wird gegen alle vier Profile bewertet und landet in genau **einem** Pool – dem mit der besten Passung (bei Gleichstand gewinnt das Profil des Laufs, danach die Software-Produkte vor Website). Profile: *Webseite* (je schwächer die Website, desto besser A/B/C), *Webseite / Automation* (Anfrage-Signale ohne Prozess), *Sales-Software* (Agenturen, Berater, Dienstleister mit B2B-Vertrieb; Handwerk und Endkunden-Läden fallen raus), *Software Mittelstand* (Industrie-/Handwerks-Mittelstand ab ~20 Mitarbeitenden mit Auftragsgeschäft). Die Bewertung landet als Qualität A–C am Lead (Kampagnen-Filter „Mindestqualität“).
4. **Aussortieren:** Firmen, die schon in Coldmail sind (auch wenn die Website auf eine andere Domain weiterleitet), rechtliches Umfeld (Kanzleien, Kammern, Behörden …), Vereine/Verbände/gemeinnützige Träger/Kliniken, Sperrliste, nur Freemail-Adressen (Kontaktregel „Kaltakquise nur an Firmenadressen“). Adressen fremder Domains aus dem Impressum (Webagentur, Hoster) werden nie übernommen.
5. **In den Pool legen:** Lead mit Chef-Adresse (veröffentlicht → persönlich → aus Name und Firmenmuster gebildet, dann als „riskant“ markiert; die Zentrale bleibt als Rückfall), Firma mit Projekt, Fakten im Account Brain (die KI-Einstiegszeile nennt nur belegte Dinge), Liste „Pool · Projekt“ mit der Zielgruppe des Projekts.

**Autopilot (Pool → Kampagne):** Auf der Projektkarte unter Leadquellen legt „Pool → Kampagne“ aus der Vorlage des Projekt-Produkts eine Kampagne an, die den Pool automatisch nachlädt (Kampagnen-Einstellung „Leads automatisch aus Liste nachladen“). Nach Freigabe und Start gehen neue Pool-Leads von allein raus; wer vor der ersten Mail aus der Liste fliegt (z. B. „nicht passend“ nach der Recherche), wird wieder ausgetragen.

**Tages-Autopilot (Leadquellen → „Tages-Autopilot“ → Einschalten):** Verteilt jeden Tag die volle Versand-Kapazität aller Postfächer der Autopilot-Kampagnen auf die vier Projekte – ChatGPT-Rechnerei von Hand entfällt:

1. **Kapazität:** Tageslimits (inkl. Ramp-up) der Postfächer; was diese Postfächer heute schon für andere Kampagnen oder Nachfassen verschickt haben, geht ab. Hauptdomain-Weg: höchstens 60 Mails/Tag für die Domain.
2. **Folge-Mails zuerst:** Wer schon angeschrieben ist, bekommt seine nächste Stufe (2, 3, 4 …) pünktlich. Reicht die Kapazität nicht, wird anteilig gekürzt.
3. **Erst-Mails nach Anteil:** Der Rest geht als Erst-Mails an die Projekte (Anteil je Projekt unter „Anteile & Regeln“, Standard gleich verteilt). Fehlen einem Projekt Leads, bekommen die anderen seinen Platz – es bleibt nichts ungenutzt. Der Plan ersetzt das feste Tageslimit der Autopilot-Kampagnen; Postfach-Limits, Versandfenster, Abstände, Freigabe und Kontaktregeln gelten unverändert.
4. **Pools nachfüllen:** Fällt der Vorrat eines Projekts unter den Puffer (Standard 7 Versandtage an Erst-Mails), startet automatisch ein Leadquellen-Lauf (ein Lauf je Projekt gleichzeitig, jede neue Suche beginnt in einer anderen Region der Liste „Regionen & Limit“). Das Prüf-Tageslimit der Leadquellen bleibt die Obergrenze.
5. **Aufräumen (einmal am Tag):** Gelöscht werden nur Leads aus den Leadquellen, die **nie** eine Mail bekommen haben: älter als 60 Tage, aus dem Pool geflogen (z. B. „nicht passend“), Adresse ungültig oder Kampagne beendet, ohne dass etwas rausging. Angeschriebene, abgemeldete und importierte Leads bleiben – an ihnen hängen Sperrfristen und Abmeldungen. Die Firma darf bei einem späteren Lauf mit frischen Daten neu gefunden werden.

Die Tabelle zeigt je Projekt: heute geplant (Folge / Neu), je Stufe gesendet + fällig, Pool-Vorrat in Tagen und was fehlt (z. B. „Texte nicht freigegeben“). Freigeben und Starten der Kampagnen bleibt bewusst Handarbeit.

**Alle recherchieren & zuordnen** (Leadquellen, Leads-Liste oder Auswahl): Die KI prüft jeden Lead gegen die vier Projekte (Website einmal gelesen, Fall-Regeln sparen unnötige Prüfungen: ein Bowlingcenter wird nie für Sales-Software geprüft) und legt ihn in den Pool des Projekts mit der besten Passung (A vor B). Passt er nirgends, fliegt er aus allen Pools und trägt „zuordnung: nicht passend“ mit Begründung. Läuft als Hintergrund-Auftrag (Fortschritt unter /api/jobs).

Ein Hintergrund-Worker arbeitet alle 20 Sekunden ein Paket ab (eine OpenStreetMap-Abfrage, bis zu 10 Websites mit 3 parallel). Tageslimit und Standard-Regionen stehen unter Leadquellen → „Regionen & Limit“. Läufe lassen sich pausieren, fortsetzen (Fehler werden erneut geprüft) und löschen; angelegte Leads bleiben erhalten – Administratoren können einen Lauf auch samt seiner Leads verwerfen (bereits angeschriebene bleiben). Jeder Kandidat zeigt Ergebnis, Fit und Begründung.

## Vorlagen-Referenz

| Syntax | Ergebnis |
| --- | --- |
| `{{anrede}}` | „Sehr geehrter Herr Müller“ / „Sehr geehrte Frau Dr. Schmidt“ / „Guten Tag“ |
| `{{hallo}}` | „Hallo Max“ / „Hallo“ |
| `{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{position}}`, `{{city}}`, `{{industry}}`, `{{website}}`, `{{domain}}` | Lead-Felder |
| `{{produkt}}`, `{{termin_link}}`, `{{kit_link}}`, `{{kit_name}}` | Aus dem Produkt der Kampagne (Termin-Link optional mit vorbelegter E-Mail) |
| `{{privacy_url}}` | Link zur Datenschutzerklärung (Einstellungen) |
| `{{mitarbeiter}}` | eigenes Feld aus dem CSV-Import (Spaltenname klein) |
| `{{sender_name}}`, `{{sender_first_name}}` | Absender des Postfachs |
| `{{ai_first_line}}` | KI-Einstiegssatz (Kampagnen-Modus „Einstiegssatz“). Fällt der Satz durch die Qualitätsprüfung, ist er leer – deshalb als `{{ai_first_line|}}` schreiben, sonst wird der Lead übersprungen. Ohne KI-Zugang warten die Mails. |
| `{{beobachtung}}` | Beobachtung zur Website aus der Leadquellen-Prüfung; ohne Daten ein allgemeiner Satz je Branche (nie leer) |
| `{{beobachtung_konkret}}` | Nur belegte Beobachtung, sonst leer – als `{{beobachtung_konkret|}}` schreiben |
| `{{company\|Ihr Team}}` | Fallback, wenn das Feld leer ist |
| `{Hallo\|Guten Tag\|Hi}` | Spintax – je Lead eine Variante (Vorschau = Versand) |
| `{{#fall handwerk,bau}} … {{#fall gastro}} … {{#sonst}} … {{/fall}}` | Fall-Absätze: je Lead bleibt der Zweig stehen, der zu seinem Fall passt (aus Branche, Leadquellen-Kategorie, Branche der alten Sales App oder Firmenname), sonst der `{{#sonst}}`-Zweig. Auch mitten im Satz möglich. Fälle: bau, technik, metall, industrie, logistik, handwerk, werkstatt, laden, gastro, freizeit, praxis, agentur, it, personal, beratung, immobilien, dienstleister, sonst. Der Copy-Check prüft den längsten Zweig. |
| `{{fall}}` | Schlüssel des Falls (z. B. zum Prüfen in der Vorschau) |
| `{{beobachtung}}`, `{{aufgefallen}}` | Ein wahrer Satz über die Website des Leads aus der Leadquellen-Prüfung („Zwei Dinge sind mir aufgefallen: Im Footer steht noch 2019, und man kann Ihnen auf der Seite nicht direkt schreiben.“) bzw. die Kurzform für den Betreff („Footer sagt 2019“). Ohne Befund: ein allgemeiner Satz je Fall bzw. leer. `{{signal}}`/`{{signal_kurz}}`: dasselbe mit Anfrage-Signalen zuerst (Notdienst, Terminbuchung, offene Stellen). |
| Betreff leer bei Follow-up | Antwort im selben Thread („Re: …“, In-Reply-To/References) |

Signatur, Abmelde-Hinweis und Impressum werden automatisch angehängt. Leads mit fehlenden Variablen (ohne Fallback) werden übersprungen statt „Hallo ,“ zu verschicken.

## Webhooks

**Ausgehend:** `POST` mit JSON `{ "event": "...", "sentAt": "ISO-Zeit", "source": "hk-coldmail", "data": { ... } }`, Header `X-Coldmail-Event` und `X-Coldmail-Signature: sha256=<HMAC-SHA256(Body, Geheimnis)>`. Drei Zustellversuche.

**Eingehend (Buchungen):** `POST <APP_URL>/hooks/booking/<geheim>` – die Adresse steht unter Einstellungen → Termine. Verstanden werden Calendly (`payload.email`, `payload.scheduled_event.start_time`), Cal.com (`payload.attendees[0].email`, `payload.startTime`) und einfache Formate (`{ "email": "...", "start_time": "..." }`); Absagen (`invitee.canceled`, `BOOKING_CANCELLED`) werden erkannt.

## Datenschutz & Recht

Keine Rechtsberatung – die Seite **Richtlinien** in der App erklärt alles ausführlich. Kurz:

- **E-Mail-Werbung** braucht nach **§ 7 Abs. 2 Nr. 2 UWG** eine **vorherige ausdrückliche Einwilligung – auch gegenüber Firmen**. Ausnahme Bestandskunden (§ 7 Abs. 3 UWG). Standard-Rechtsgrundlage in der App ist deshalb „Einwilligung liegt vor“; Kaltakquise ist nur nach dokumentierter Bestätigung und mit engen Grenzen möglich.
- **Telefon:** Diese App ruft niemanden an. Warme Leads gehen per Export „Warm“ an die Sales App – dort gelten deren Regeln für B2B-Anrufe (mutmaßliche Einwilligung, § 7 Abs. 2 Nr. 1 UWG).
- Pflichtangaben (§ 5 DDG, § 35a GmbHG), Abmelde-Link + One-Click, Datenschutz-Information (Art. 13/14 DSGVO), kein Tracking ohne Einwilligung (§ 25 TDDDG), keine verschleierten Absender/Betreffs (§ 6 DDG).
- Für KI-Funktionen werden Lead-Daten, Website-Auszüge und Gesprächsinhalte an Anthropic (Claude) übermittelt → Verzeichnis der Verarbeitungstätigkeiten / Datenschutzerklärung ergänzen.
- **Firmen-Recherche** nutzt nur öffentliche Firmen-Websites (Impressum, Karriere, News …). Personen werden nur mit beruflicher Rolle gespeichert und nur, wenn sie dort genannt sind; keine privaten Profile, kein Scraping von LinkedIn & Co. (deren Nutzungsbedingungen verbieten das). Ein Anlass auf der Website ist ein **sachlicher Grund für einen B2B-Anruf**, ersetzt aber keine Einwilligung für E-Mails.

## Aufbau

```
src/server.js            Start: Konfiguration, DB, HTTP, Hintergrund-Jobs, sauberes Herunterfahren
src/app.js               HTTP-Routing, Login/CSRF, Tracking-, Abmelde- und Buchungs-Endpunkte, SPA
src/db.js                SQLite (node:sqlite), Schema/Migrationen
src/api/*.js             REST-API (Postfächer, Leads, Zielgruppen, Produkte, Kampagnen, Unibox, Aufgaben, Projekte, Firmen, Pipeline, System)
src/engine/scheduler.js  Versand-Takt: Rotation, Limits, Abstände, Zeitfenster, Nachfassen
src/engine/sender.js     Versand eines Schritts, Kontaktregeln, Fehler-/Bounce-Behandlung, Antworten
src/engine/rules.js      Freigabe (Inhalts-Hash), Rechts-Check, Kontaktregeln je Lead
src/engine/followup.js   Nachfassen bei Interesse, Aufgaben, Termin gebucht
src/engine/sync.js       IMAP-Abgleich aller Postfächer + KI-Einordnung
src/intel/               Firmen: Zuordnung per Domain, Lebenszyklus, Recherche mit Belegen, Account Brain, Beobachtung
src/orchestration/       Qualitätsprüfung (Creepy-Score, Belege) und „Heute“-Aktionen
src/conversion/          Chancen, Herkunft, Termin-Briefing, Gesprächsauswertung, Verlust-Analyse
src/learning/            Auswertung nach Umsatz je Play/Angle/Persona/Pain/Anlass/Kanal
src/mail/                SMTP (nodemailer), IMAP (imapflow), Eingangs-Analyse, Warmup, Mail-Aufbau
src/ai/                  Claude (Max-Abo über Claude Code oder API): Wissen, Vorlagen, Qualität, Personalisierung, Einordnung, Entwürfe
src/lib/                 Vorlagen/Spintax, CSV, E-Mail-Prüfung, DNS-Check, Copy-Check, Zeitzonen, Website-Abruf (SSRF-geschützt)
public/                  Oberfläche (Vanilla-JS, kein Build-Schritt)
tests/                   node:test; tests/e2e gegen echten SMTP/IMAP-Server (GreenMail)
```

## Tests

```bash
npm test
# End-to-End mit echtem Mailserver:
docker run -d --name greenmail -p 3025:3025 -p 3143:3143 -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=sales1:pw-sales1@test-firma.de,sales2:pw-sales2@test-firma.de,max:pw-max@kunde-a.de,erika:pw-erika@kunde-b.de -Dgreenmail.users.login=email' greenmail/standalone:2.1.2
npm run test:e2e
```

Die Tests decken u. a. ab: Versand mit Rotation, Antwort per IMAP → Sequenz gestoppt, Follow-up im Thread, DSN-Bounce, Warmup, Freigabe und Rechts-Check, Kontaktregeln, Nachfassen, Aufgaben, Buchungs-Webhook, die KI über das Abo (mit einem Test-Doppel für `claude`), Projekte-Board, Firmen-Zuordnung, Recherche mit Beleg-Prüfung, Qualitätsprüfung, „Heute“, Chancen bis gewonnen/verloren und die Lern-Auswertung.

## Bekannte Grenzen / nächste Schritte

- **Microsoft 365** hat Basic Auth für SMTP/IMAP weitgehend abgeschaltet → dafür ist OAuth2 nötig (noch nicht eingebaut). Google Workspace funktioniert mit App-Passwörtern.
- Warmup läuft nur zwischen den eigenen Postfächern (kein externes Warmup-Netzwerk) – mit 3+ Postfächern sinnvoll.
- E-Mail-Prüfung ohne SMTP-Probe (kein Catch-all-Test), um die Reputation nicht zu gefährden.
- Recherche liest nur die Firmen-Website. Handelsregister, Förderdatenbanken oder Stellenbörsen sind noch nicht angebunden; Anlässe von dort lassen sich von Hand eintragen („Anlass“ im Firmenprofil).
- Das Lernen zeigt, was funktioniert – es ändert Scores und Plays (noch) nicht selbstständig. Aussagekräftig wird es ab etwa 20–30 abgeschlossenen Chancen je Projekt.
