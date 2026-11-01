# Vorlagen zum Ausfüllen – Smature Coldmail

Alles in der Reihenfolge, in der du es in der App einträgst. `‹…›` durch eure Werte ersetzen, den Rest kannst du so übernehmen.

---

## 1. Coolify – Umgebungsvariablen

```env
APP_URL=https://‹coldmail.eure-domain.de›
APP_SECRET=‹Ausgabe von: openssl rand -base64 48 – danach NIE mehr ändern›
ADMIN_EMAIL=‹admin@eure-domain.de›
ADMIN_PASSWORD=‹mind. 12 Zeichen›
ADMIN_NAME=‹Vorname Nachname›
TRUST_PROXY=true
COOKIE_SECURE=true
DEFAULT_TIMEZONE=Europe/Berlin
# KI (optional, eigenes Claude-Max-Abo: auf einem Rechner `claude setup-token` ausführen)
CLAUDE_CODE_OAUTH_TOKEN=‹Token›
AI_PROVIDER=subscription
```

Außerdem: Port **3000**, Persistent Storage nach **`/app/data`**. Danach neu deployen und `https://‹app-domain›/healthz` öffnen → `{"ok":true}`.

---

## 2. DNS je Versand-Domain (beim Domain-Anbieter)

| Typ | Name | Wert |
| --- | --- | --- |
| MX | `@` | ‹vom Mail-Anbieter, z. B. Google Workspace / IONOS› |
| TXT (SPF) | `@` | `v=spf1 include:‹spf-des-anbieters› ~all` |
| TXT (DKIM) | `‹selector›._domainkey` | ‹Schlüssel aus dem Admin des Mail-Anbieters› |
| TXT (DMARC) | `_dmarc` | `v=DMARC1; p=none; rua=mailto:‹dmarc@eure-domain.de›` |
| CNAME (optional Tracking) | `‹link›` | `‹app-domain›` |

Prüfen in der App: **Postfächer → DNS**.

---

## 3. Einrichtung → Domains

```
Hauptdomain:      ‹eure-domain.de›
Versand-Domains:  ‹get-eurefirma.de›
                  ‹eurefirma-team.de›
                  ‹eurefirma-hq.de›
```

Die Hauptdomain nie zum Kaltversand nutzen, wenn du den Weg mit Versand-Domains wählst.

---

## 4. Einrichtung → Postfächer (eine Zeile je Postfach)

```
‹vorname›@‹versand-domain-1›;‹App-Passwort›;‹Vorname Nachname›
‹v.nachname›@‹versand-domain-1›;‹App-Passwort›;‹Vorname Nachname›
‹vorname›@‹versand-domain-2›;‹App-Passwort›;‹Vorname Nachname›
‹v.nachname›@‹versand-domain-2›;‹App-Passwort›;‹Vorname Nachname›
```

**Signatur (schlank, ohne Bilder und Links):**

```
‹Vorname Nachname›
‹Position› · ‹Firmenname›
Tel. ‹Telefonnummer›
```

---

## 5. Einstellungen → Allgemein

**Firmenname**
```
‹Firmenname GmbH›
```

**Fußzeile / Impressum (steht unter jeder Mail)**
```
‹Firmenname GmbH› · ‹Straße Nr.› · ‹PLZ Ort› · Geschäftsführer: ‹Name› · ‹HRB 12345›, ‹Amtsgericht Ort› · Datenschutz: {{privacy_url}}
```

**Abmelde-Hinweis** (Standard übernehmen)
```
Kein Interesse? Kurze Antwort genügt – oder hier abmelden: {{unsubscribe_url}}
```

**Datenschutz-Link**
```
https://‹eure-domain.de›/datenschutz
```

---

## 6. Einstellungen → KI & Abo → Absender-Beschreibung

Das ist die Grundlage für jeden KI-Text. Je konkreter, desto besser.

```
Wer wir sind:
‹Firmenname› aus ‹Ort›, seit ‹Jahr›, ‹Anzahl› Mitarbeitende.

Was wir anbieten:
‹Leistung 1 – in einem Satz›
‹Leistung 2 – in einem Satz›

Für wen:
‹Branchen, Firmengröße, Region, Ansprechpartner (z. B. Geschäftsführung, Vertriebsleitung)›
Nicht für: ‹wen ihr ausdrücklich nicht wollt›

Ergebnisse / Belege (nur Echtes):
‹Kunde/Branche – Ergebnis – Zeitraum›
‹Kunde/Branche – Ergebnis – Zeitraum›

Wie wir arbeiten:
‹Ablauf in 3–4 Schritten, Dauer, was der Kunde tun muss›

Was wir nie sagen / versprechen:
‹z. B. keine Preise in der ersten Mail, keine Garantien›
```

Tageslimit KI: `300` (Standard), so bleibt genug Abo-Kontingent für die übrige Arbeit.

---

## 7. Einstellungen → Kontaktregeln (Empfehlung)

| Feld | Wert |
| --- | --- |
| Sperrfrist zwischen Kampagnen (Tage) | `90` |
| Sperrfrist nach „kein Interesse“ (Tage) | `365` |
| Max. Kontakte je Firma in 30 Tagen | `3` |
| Kaltakquise nur an Firmenadressen | ✔ |
| Weitere Ausschluss-Begriffe | `‹z. B. eigene Kunden, Wettbewerber, Branchen, die ihr nicht wollt›` |
| Nachfass-Fenster | `08:30` – `17:30`, Mo–Fr |

---

## 8. Einstellungen → Termine

```
Standard-Termin-Link: https://‹cal.com / calendly.com›/‹euer-link›
```

Die angezeigte **Webhook-Adresse** kopierst du und trägst sie im Buchungstool ein (Calendly: „Invitee Created/Canceled“, Cal.com: „Booking Created/Cancelled“).

---

## 9. Projekte (eine Spalte je Geschäftsbereich)

Die vier Beispiel-Spalten umbenennen oder löschen. Je Projekt:

```
Name:          ‹Geschäftsbereich, z. B. „Produkt A“›
Beschreibung:  ‹Was verkauft dieser Bereich, an wen?›
```

Hinweis zur automatischen Lead-Zuordnung: Projektnamen mit „Automation“, „Sales App“/„CRM“ oder „Mittelstand“/„Prozess“ nutzen die passenden Bewertungsregeln. Alle anderen werden wie „Webseite“ bewertet.

---

## 10. Produkt (je Projekt mindestens eins)

**Name**
```
‹Produktname›
```

**Beschreibung** – was ist es, was bekommt der Kunde?
```
‹1–2 Sätze›
```

**Nutzenversprechen** – welches Ergebnis, in welcher Zeit?
```
‹z. B. „In ‹X› Wochen ‹Ergebnis›, ohne dass Ihr Team ‹Aufwand›.“›
```

**Ideale Kunden** – wer passt, und wer ausdrücklich nicht?
```
Passt: ‹Branche›, ‹Größe (Mitarbeitende/Umsatz)›, ‹Region›, Entscheider: ‹Rolle›
Typischer Anlass: ‹z. B. Wachstum, neue Stellen, alte Website, neuer Standort›
Passt nicht: ‹Ausschlüsse›
```

**Belege** – nur Belegtes, die KI erfindet nichts dazu
```
‹Referenz 1: Kunde/Branche – was gemacht – Ergebnis›
‹Referenz 2: …›
```

**Termin-Link:** `https://‹…›`
**Info-Kit-Link:** `https://‹…›/info.pdf` · **Info-Kit-Name:** `‹z. B. Ablauf & Preise (PDF)›`

Danach: Info-Blätter hochladen → **„Produkt-Profil aus Wissen erstellen“**.

---

## 11. Zielgruppe

```
Name:          ‹Branche + Region, z. B. „Maschinenbau NRW 20–200 MA“›
Sprache:       Deutsch
Beschreibung:  ‹Wer genau? Branche, Größe, Region, Entscheider-Rollen›
Angebot:       ‹Was bieten wir genau dieser Zielgruppe an? Welches Ergebnis?›
Tonalität:     Sie-Form, sachlich, kurz, keine Anglizismen
CTA:           ‹z. B. „Kurze Antwort genügt“ / 15-Minuten-Telefonat›
```

---

## 12. Play (Projekte → Spalte → Plays → +)

| Feld | Wert |
| --- | --- |
| Name | `‹Branche › Anlass › Persona›` |
| Branche | `‹…›` |
| Anlass („Why now“) | `‹z. B. sucht Vertriebler, neuer Standort, alte Website›` |
| Persona | `‹z. B. Geschäftsführer›` |
| Schmerz | `‹welches Problem hat diese Person konkret?›` |
| Argument (Angle) | `‹warum wir, warum jetzt – in einem Satz›` |
| Beleg | `‹eine echte Referenz›` |
| CTA | `‹kurz antworten / Termin-Link›` |

---

## 13. Vorlage mit KI (Produkt → „Vorlage mit KI“)

| Feld | Wert |
| --- | --- |
| Zielgruppe | ‹aus Schritt 11› |
| Rechtsgrundlage | `Einwilligung liegt vor` / `Bestandskunden (§ 7 Abs. 3 UWG)` / `Kaltakquise ohne Einwilligung (riskant)` |
| Anzahl Mails | `4` (erste Mail → Nachhaken → neuer Aspekt → Abschluss) |
| Einstiegsangebot | `– KI wählt passend –` oder z. B. „Konkrete Einschätzung / Beispiel“ |
| Einstiegsangebot (Text) | `‹z. B. „Kurze Einschätzung zu ‹Thema› mit drei konkreten Hebeln – schicke ich gern, wenn Sie kurz antworten.“›` |
| Ziel | `‹z. B. Erstgespräch über den Termin-Link buchen›` |
| Hinweise | `‹Anlass, Aufhänger, was vermieden werden soll›` |
| Name | `‹Produkt› – ‹Zielgruppe› – v1` |

Danach: Vorschau mit echten Leads → Testmail an dich → **freigeben** → „Kampagne erstellen“.

---

## 14. Lead-Import (CSV)

Kopfzeile, die die App automatisch erkennt (Trennzeichen `;` oder `,`):

```csv
E-Mail;Anrede;Vorname;Nachname;Firma;Position;Website;Telefon;Stadt;Land;Branche;LinkedIn;Quelle;Notizen
‹max@firma.de›;Herr;‹Max›;‹Mustermann›;‹Firma GmbH›;Geschäftsführer;‹https://firma.de›;‹0221 …›;‹Köln›;Deutschland;‹Maschinenbau›;;‹Messe XY 2026›;
```

Weitere Spalten (z. B. `Mitarbeiter`) werden eigene Felder → in Vorlagen als `{{mitarbeiter}}`.
Beim Import: **Einwilligung + Quelle** für die ganze Datei angeben, wenn vorhanden. Danach „Qualität prüfen (KI)“.

---

## 15. Leadquellen → Regionen & Limit

Eine Region je Zeile, Schreibweise wie bei OpenStreetMap:

```
‹Köln›
‹Rhein-Sieg-Kreis›
‹Kreis Mettmann›
```

Prüf-Tageslimit: Standard `800` Websites/Tag – zum Start ruhig auf `100` setzen.

---

## 16. Variablen für eigene Texte

| Variable | Ergebnis |
| --- | --- |
| `{{anrede}}` | „Sehr geehrter Herr Müller“ / „Guten Tag“ |
| `{{hallo}}` | „Hallo Max“ / „Hallo“ |
| `{{first_name}}` `{{last_name}}` `{{company}}` `{{city}}` `{{industry}}` `{{website}}` | Lead-Felder |
| `{{produkt}}` `{{termin_link}}` `{{kit_link}}` `{{kit_name}}` | aus dem Produkt |
| `{{sender_first_name}}` `{{sender_name}}` | Absender |
| `{{ai_first_line}}` | KI-Einstiegssatz |
| `{{company\|Ihr Team}}` | Fallback, wenn leer |
| `{Hallo\|Guten Tag}` | Spintax |

**Beispiel erste Mail (Gerüst):**

```
Betreff: {{company}} – kurze Frage

{{anrede}},

‹1–2 Sätze, warum genau diese Firma – ein belegter Bezug›

‹Einstiegsangebot: was der Empfänger konkret bekommt, ohne Aufwand›

‹ein belegter Beweis in einem Satz›

Soll ich Ihnen das kurz zusammenstellen? Eine kurze Antwort genügt.

Viele Grüße
{{sender_first_name}}
```

---

## 17. Start-Checkliste

- [ ] `/healthz` ok, Login klappt
- [ ] Fußzeile + Datenschutz-Link gesetzt
- [ ] DNS: SPF, DKIM, DMARC grün (Postfächer → DNS)
- [ ] Postfächer verbunden, Warmup an (14 Tage bei neuen Versand-Domains)
- [ ] Absender-Beschreibung ausgefüllt
- [ ] Produkt + Zielgruppe + Vorlage **freigegeben**
- [ ] Testmail an dich selbst geprüft
- [ ] Leads importiert + Qualität geprüft
- [ ] Kampagne gestartet
- [ ] Täglich: **Heute** abarbeiten (Antworten zuerst)
