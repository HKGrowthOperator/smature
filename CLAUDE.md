# Smature Coldmail – Hinweise für Claude

Selbst gehostete Cold-Mail-App von Smature (Node 22, eingebautes `node:sqlite`, keine Frameworks). Läuft per Dockerfile in Coolify. Die Oberfläche und alle Texte sind auf Deutsch.

## Wichtig, vor allem anderen

- **Das Repo kann öffentlich sein.** Niemals Leads, Kundendaten, CSV-Exporte, Datenbanken (`data/`, `*.db`), `.env`, Passwörter, Tokens oder API-Keys committen. Lead-Listen und Recherchen gehören in die App (Import), nicht ins Repo.
- Echte Firmendaten (Impressum, Absender, Domains, Produkte, Regionen) stehen **in der App** (Einstellungen, Datenbank im Volume `/app/data`), nicht im Code. Im Code nur neutrale Platzhalter wie „Musterfirma“.
- Nach jeder Code-Änderung: `npm test`. Alle Tests müssen grün sein, bevor du pushst.
- Committe nicht direkt auf `main`, wenn der Nutzer nichts anderes sagt: eigener Branch und Pull Request. Coolify deployt von `main`.

## Offene Aufgabe zuerst: Absenderangaben (Fußzeile) und Datenschutz-Link

Die Kampagne „Webauftritt – GaLaBau“ startet erst, wenn in den Einstellungen eine Fußzeile mit Absenderangaben und ein Datenschutz-Link stehen (Rechts-Check in `src/engine/rules.js`). **Diesen Check nicht entfernen oder abschwächen** – Werbemails ohne erkennbaren Absender sind rechtswidrig (§ 6 DDG) und abmahnfähig.

So erledigen:
1. Christian nach Name/Firma, ladungsfähiger Anschrift und E-Mail fragen. Will er seine Privatadresse nicht zeigen: Geschäftsadresse über einen Postdienst/virtuelles Büro (ladungsfähig, nicht nur Postfach).
2. Datenschutz-Seite: Christian einen kurzen Entwurf für seine Website schreiben (Verantwortlicher, Zweck: B2B-Kontaktaufnahme, Rechtsgrundlage, Herkunft der Daten = öffentliche Websites, Speicherdauer, Widerspruch, Rechte nach Art. 15–21 DSGVO) – Hinweis, dass das keine Rechtsberatung ist.
3. Eintragen – entweder Christian in der App unter Einstellungen → Allgemein, oder per Coolify-Variable `BOOTSTRAP_JSON` (danach wieder löschen):
   `{"settings":{"footer_text":"Christian Richter · Smarture · Straße Nr. · PLZ Ort · E-Mail · Datenschutz: {{privacy_url}}","privacy_url":"https://…/datenschutz"}}`
4. In der App die Kampagne öffnen: Start-Check muss grün sein, dann Testmail und Freigabe.

Weitere offene Punkte: `UEBERGABE_CHRISTIAN.md`.

## Befehle

```bash
npm install
npm run dev     # http://localhost:3000 – Login admin@localhost.test / local-dev-password
npm test        # Unit-/Integrationstests (node --test)
```

## Aufbau

| Ordner | Inhalt |
| --- | --- |
| `src/server.js`, `src/app.js`, `src/http.js` | Start, Routen, HTTP-Helfer |
| `src/config.js` | Umgebungsvariablen + Startprüfung (`APP_SECRET` ≥ 32 Zeichen, `APP_URL`, `ADMIN_PASSWORD` ≥ 12) |
| `src/settings.js` | App-Einstellungen mit Standardwerten (im Admin änderbar) |
| `src/db.js` | SQLite-Schema und Migrationen. Nur neue Migrationen anhängen, alte nie ändern |
| `src/api/` | REST-Endpunkte je Bereich |
| `src/engine/` | Versand, Planer, IMAP-Abgleich, Nachfassen, Autopilot, Regeln |
| `src/mail/` | SMTP/IMAP, Postfächer, Warmup, eingehende Mails |
| `src/intel/` | Firmen-Recherche, Leadquellen (OpenStreetMap), Zuordnung zu Projekten |
| `src/ai/` | Claude-Anbindung (`claude -p` über Max-Abo oder API) und KI-Funktionen |
| `src/lib/` | Vorlagen, CSV, DNS-Check, Spam-Check, Hilfsfunktionen |
| `public/` | Oberfläche (Vanilla JS, `public/js/views/*`) |
| `tests/` | Tests, Hilfen in `tests/helpers.js` |

## Leitplanken der App (nicht abschwächen)

- Jede Vorlage/Kampagne braucht eine Freigabe. Änderungen an Texten heben sie auf.
- Rechts-Check vor dem Start: Impressum in der Fußzeile, Abmelde-Link, Datenschutz-Link, kein vorgetäuschtes „Re:“.
- Kein Kaltversand an das rechtliche Umfeld (Kanzleien, Notare, Steuerberater, Behörden …) und nicht an Freemail-Adressen.
- Abmeldung/„kein Interesse“ sperrt die ganze Firma. Abmahnung/Anwalt/DSGVO-Auskunft sperrt alles und legt eine dringende Aufgabe an.
- KI-Texte: keine erfundenen Fakten, Zahlen oder Referenzen (`COLD_MAIL_RULES` in `src/ai/features.js`).

## Projekte und Lead-Zuordnung

Die vier Start-Projekte (Webseite, Software Sales App, Software Mittelstand, Webseite / Automation) sind Beispiele. Die Bewertungsprofile in `src/intel/sourcing.js` (`PROFILES`) und `src/intel/assign.js` hängen über `profileFor()` am Projektnamen. Wenn Smature eigene Geschäftsbereiche bekommt, dort die Profile anpassen und die Tests in `tests/sourcing.test.js` und `tests/assign.test.js` nachziehen.

## Betrieb

- Einrichtung und alle Felder zum Ausfüllen: `README.md` und `VORLAGEN.md`.
- Deploy: Coolify, Dockerfile, Port 3000, Volume `/app/data`. Startet der Container nicht, im Container-Log nach „Konfiguration unvollständig“ suchen.
- KI: `CLAUDE_CODE_OAUTH_TOKEN` (aus `claude setup-token`) in Coolify. Ohne Token läuft die App, nur ohne KI.
