# Übergabe an Christian – Smarture Coldmail

Stand 01.11.2026. Ziel: Christian betreibt die App komplett selbst, Luis ist danach nicht mehr beteiligt.
In dieser Datei stehen **keine** Passwörter oder Schlüssel – das Repo ist öffentlich.

---

## 1. Was kann Christian über das Repo machen – und was nicht?

| Bereich | Wo wird es geändert? | Über das Repo? |
| --- | --- | --- |
| Code der App (Funktionen, Regeln, Oberfläche) | dieses Repo | ✅ Ja. Jeder Push auf `main` wird von Coolify automatisch deployt. |
| Texte, Kampagnen, Zielgruppen, Produkte, Leads, Einstellungen | in der App (Datenbank im Volume `/app/data`) | ⚠️ Nur indirekt: per `BOOTSTRAP_JSON` in Coolify (siehe `src/bootstrap.js`). Normalerweise direkt in der App. |
| Umgebungsvariablen (KI, Google, Admin, Domain) | Coolify → App → Environment Variables | ❌ Nein, nur in Coolify. |
| Server, Domain, HTTPS | Coolify + DNS beim Domain-Anbieter | ❌ Nein. |
| Postfächer, DNS der Versand-Domains | Google Workspace + App → Postfächer | ❌ Nein. |

**Mit Claude Code:** Christian öffnet das Repo in Claude Code (claude.ai/code oder lokal mit `claude`). Claude liest `CLAUDE.md` und kennt Aufbau und Regeln. Code-Änderungen → Tests (`npm test`) → Push → Coolify deployt.

---

## 2. So kommt Luis komplett raus (Reihenfolge einhalten)

1. **Repo übertragen** – Luis: GitHub → `HKGrowthOperator/smature` → Settings → General → *Transfer ownership* → an Christians GitHub-Konto.
2. **Coolify-Quelle umstellen** – In Coolify die App mit dem übertragenen Repo verbinden (GitHub App auf Christians Konto installieren, Repo + Branch `main` wählen). Danach einmal deployen und prüfen, dass Pushes automatisch deployen.
3. **Coolify und Server übernehmen** –
   - Läuft der Server auf Christians Hetzner-Konto: Christian in Coolify als *Owner* (Settings → Team → Members) – Luis entfernen.
   - Läuft er auf Luis' Konto: Christian legt einen eigenen Server mit Coolify an, Luis exportiert ein Backup des Volumes `/app/data` (Datenbank + `.app-secret`), Christian spielt es ein und setzt dieselben Variablen. **`APP_SECRET` muss gleich bleiben**, sonst sind die Postfach-Passwörter unlesbar.
4. **Alle Zugänge erneuern** (sie standen teilweise im Chat):
   - Coolify → Security → API Tokens: **alle Tokens löschen**.
   - App → Einstellungen → Benutzer: Admin-Passwort ändern.
   - KI: eigenen Zugang setzen (Abschnitt 4) – den bisherigen Token ersetzen.
   - Google Workspace: für alle 10 Postfächer neue App-Passwörter erzeugen und in der App unter *Postfächer* eintragen.
5. **Prüfen:** App → *Einrichtung* zeigt alles grün, *Postfächer* → Verbindungstest grün.

---

## 3. Was Christian vor dem Start noch erledigen muss

- [ ] **Impressum / Fußzeile** – Einstellungen → Allgemein: Firmenname, Anschrift, Telefon, E-Mail, Registergericht/-nummer (falls vorhanden), Geschäftsführer, Datenschutz-Link mit `{{privacy_url}}`. Ohne Fußzeile blockiert der Rechts-Check den Start.
- [ ] **Calendly-Link** – Produkt „Webauftritt für Handwerker“ → Termin-Link. Einstellungen → Termine → Webhook-Adresse in Calendly eintragen (Invitee Created/Canceled).
- [ ] **KI prüfen** – Einstellungen → KI & Abo muss „verbunden“ zeigen.
- [ ] **Google-Bewertungen** – `GOOGLE_PLACES_API_KEY` in Coolify setzen (Abschnitt 4), redeployen.
- [ ] **HTTPS** – A-Record z. B. `app.<eure-domain>` → `167.233.76.202`; in Coolify bei der App als Domain `https://app.<eure-domain>` eintragen; dann `APP_URL=https://app.<eure-domain>` und `COOKIE_SECURE=true` setzen, redeployen. (Gleiches für Coolify selbst unter Settings → Instance Domain.)
- [ ] **Kampagne „Webauftritt – GaLaBau“ prüfen** – Vorschau mit echten Leads, Testmail an ein eigenes Postfach, dann **freigeben**.
- [ ] **Rechtsgrundlage festlegen** – Die Kampagne steht auf „Einwilligung liegt vor“. Werbemails an Firmen brauchen in Deutschland eine Einwilligung (§ 7 Abs. 2 Nr. 2 UWG). Wer bewusst Kaltakquise macht, muss das in der Kampagne ausdrücklich bestätigen – das Risiko liegt beim Absender.
- [ ] **Tageslimit** – aus der Zahl der Entwürfe pro Woche ableiten (jede Zusage = Entwurf in zwei Tagen). Bei ~2–3 % positiven Antworten: 300 Mails/Tag ≈ 6–9 Entwürfe/Tag.
- [ ] **Start frühestens 16.11.2026** (14 Tage Warmup seit 01.11.).
- [ ] **AV-Verträge** – Hetzner (Konsole), Google Workspace (Admin-Konsole → Data Processing Amendment), Anthropic (nur mit API-Key/Commercial Terms).
- [ ] **Google Ads** von Kandidaten prüft die App nicht – bei Bedarf von Hand (Google Ads Transparency Center).

---

## 4. Variablen in Coolify (Werte nur in Coolify, nie ins Repo)

| Variable | Wofür |
| --- | --- |
| `APP_URL` | Adresse der App (später `https://…`) |
| `APP_SECRET` | **nie ändern** – verschlüsselt die Postfach-Passwörter |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | erster Admin (Passwort danach in der App ändern) |
| `TRUST_PROXY=true`, `COOKIE_SECURE` | `true` mit HTTPS, `false` solange http |
| `AI_PROVIDER` + `ANTHROPIC_API_KEY` | **empfohlen:** `api` + API-Key aus Christians Anthropic Console (Commercial Terms, AV-Vertrag möglich) |
| `AI_PROVIDER` + `CLAUDE_CODE_OAUTH_TOKEN` | Alternative `subscription` mit eigenem Max-Abo (`claude setup-token`) – für automatischen Serverbetrieb laut Anthropic-Bedingungen eine Grauzone |
| `GOOGLE_PLACES_API_KEY` | Google Cloud → „Places API (New)“ aktivieren → API-Schlüssel, auf Places API beschränken |
| `BOOTSTRAP_JSON` | nur kurzzeitig für Einrichtung per Coolify, danach löschen |

---

## 5. Automatisierung: Leadsuche und Versand laufen von allein

Die App hat dafür den **Tages-Autopilot**. Einmal einrichten, danach läuft jeden Tag:
Folge-Mails zuerst → neue Erst-Mails aus dem Pool → Pool automatisch nachfüllen (neue Leadquellen-Läufe) → einmal am Tag aufräumen.

**Einrichten (in der App, ca. 10 Minuten):**

1. **Leadquellen → Regionen & Limit**
   - Regionen sind gesetzt: Rhein-Hunsrück-Kreis, Bad Kreuznach, Birkenfeld, Mainz-Bingen, Alzey-Worms, Mainz, Worms. Später erweitern.
   - Website-Prüfungen pro Tag: zum Start **100–300**.
   - Google-Bewertungen: „ohne Bewertungen aussortieren“ an, „gut“ ab 10 Bewertungen und 4,5 Sternen (wirkt erst mit `GOOGLE_PLACES_API_KEY`).
2. **Erster Suchlauf** – Projektkarte *Smarture* → **Suche starten** → Kategorie **„Garten- und Landschaftsbau“**. Die automatischen Läufe nutzen für Smarture ebenfalls nur diese Kategorie (Einstellung `autopilot_categories`).
3. **Projektkarte Smarture → „Pool → Kampagne“** – verbindet die Kampagne „Webauftritt – GaLaBau“ mit dem Pool. Neue Pool-Leads landen automatisch in der Kampagne.
4. **Kampagne freigeben und starten** (ab 16.11.).
5. **Leadquellen → Tages-Autopilot → Anteile & Regeln** – Puffer 7 Versandtage, Aufräumen nach 60 Tagen → **Einschalten**.

**Täglich bleibt nur:** *Heute* öffnen – Antworten in unter 30 Minuten beantworten, Entwürfe in zwei Tagen liefern, warme Leads weitergeben. Freigeben und Starten neuer Kampagnen bleibt bewusst Handarbeit.

**Weitere Zielgruppen später** (SHK, Elektro/PV, Dachdecker, Bestatter): je Zielgruppe ein eigenes Projekt mit Produkt, Kampagne und eigenen Kategorien – Claude kann die Kategorien in `src/intel/sourcing.js` (`CATEGORIES`) ergänzen und per `BOOTSTRAP_JSON` (`autopilot_categories`) zuordnen.

---

## 6. Regeln, die in der App fest eingebaut sind

- Nur wörtlich veröffentlichte Adressen (Chef-Adressen werden nicht geraten – Einstellung „Chef-Adressen bilden“ aus).
- Keine Freemail-Adressen in Kaltakquise (abschaltbar, nicht empfohlen).
- Nie an Kanzleien, Steuerberater, Behörden, Kammern, Verbände.
- Abmeldung oder „kein Interesse“ sperrt die ganze Firma.
- Jede Textänderung hebt die Freigabe auf; die Kampagne hält dann an.
- KI-Texte: keine erfundenen Fakten, Zahlen, Referenzen, Google-Bewertungen.
