// Richtlinien: wie man mit der App rechtssicher und qualitativ hochwertig akquiriert (Deutschland/B2B). Keine Rechtsberatung.
import { h, clear, api, icon, skeletonRows } from "../lib.js";

const section = (title, ...body) => h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, title)), h("div", { class: "card-body stack-sm guide" }, body));
const p = text => h("p", null, text);
const list = items => h("ul", null, items.map(i => h("li", null, i)));

export async function render(el) {
  clear(el, h("div", { class: "page-head" }, h("h1", null, "Richtlinien")), h("div", { class: "content" }, skeletonRows(4)));
  const [settings, dash] = await Promise.all([api("/api/settings"), api("/api/dashboard")]);
  const checks = [
    [!!settings.footer_text, "Impressum/Pflichtangaben in der Fußzeile", "#/einstellungen"],
    [!!settings.privacy_url, "Link zur Datenschutzerklärung (inkl. Datenquelle und Widerspruchsrecht)", "#/einstellungen"],
    [/\{\{unsubscribe_url\}\}/.test(settings.unsubscribe_text || ""), "Abmelde-Hinweis mit Link in jeder Mail", "#/einstellungen"],
    [dash.setup.product, "Mindestens ein Produkt mit Termin-Link und Info-Kit", "#/produkte"],
    [dash.setup.template, "Mail-Texte geprüft und freigegeben", "#/produkte"],
    [!!settings.booking_url || dash.setup.product, "Termin-Link hinterlegt (Buchungen stoppen alles automatisch)", "#/einstellungen/termine"]
  ];
  clear(el,
    h("div", { class: "page-head" }, h("div", null, h("h1", null, "Richtlinien"), h("div", { class: "sub muted small" }, "So bleibt die Akquise sauber, persönlich und abmahnsicher."))),
    h("div", { class: "content stack", style: { maxWidth: "980px" } },
      h("div", { class: "alert warn" }, h("div", null, h("strong", null, "Wichtig: "), "Diese Seite fasst die Rechtslage in Deutschland für B2B-Akquise verständlich zusammen und ersetzt keine Rechtsberatung. Lasst Texte, Fußzeile und Einwilligungs-Formulare einmal von einer Anwältin oder einem Anwalt prüfen.")),
      h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", null, "Checkliste")),
        h("div", { class: "card-body" }, h("ul", { class: "checklist" }, checks.map(([ok, label, href]) => h("li", { class: ok ? "done" : "" }, h("span", { class: "tick" }, ok ? icon("check") : ""), h("a", { href }, label)))))),
      section("1 · E-Mail-Werbung braucht eine Einwilligung – auch an Firmen",
        p("Nach § 7 Abs. 2 Nr. 2 UWG ist Werbung per E-Mail ohne vorherige ausdrückliche Einwilligung eine unzumutbare Belästigung – das gilt ausdrücklich auch gegenüber Unternehmen. Schon eine einzige unerwünschte Mail kann eine Abmahnung (Wettbewerber, Verbände) oder eine Unterlassungsforderung des Empfängers auslösen; dazu kommen Datenschutzrisiken (Art. 6 DSGVO)."),
        p("Deshalb ist in der App „Einwilligung liegt vor“ die Standard-Rechtsgrundlage: Nur Kontakte mit dokumentierter Einwilligung (Quelle + Datum) werden angeschrieben."),
        list([
          "Einwilligung erhalten z. B. über Website-Formular mit Häkchen (Double-Opt-In), Messe-Formular, Visitenkarte mit ausdrücklicher Zusage, oder im Telefonat („Darf ich Ihnen die Infos per E-Mail schicken?“).",
          "In der App beim Lead bzw. beim Import „Einwilligung“ setzen und die Quelle eintragen (z. B. „Telefonat 07.10.2026, Herr Müller, Infos zum Website-Paket gewünscht“). Im Streitfall müsst ihr die Einwilligung nachweisen.",
          "Bestandskunden (§ 7 Abs. 3 UWG): erlaubt für eigene ähnliche Produkte, wenn ihr die Adresse aus einem Verkauf habt, bei der Erhebung auf das Widerspruchsrecht hingewiesen habt und in jeder Mail darauf hinweist."
        ])),
      section("2 · So arbeitet diese App: nur Cold Mailing",
        p("Diese App schreibt Mails und nimmt Antworten entgegen – sonst nichts. Telefoniert wird in eurer eigenen Sales App."),
        list([
          "Die richtige E-Mail-Adresse zählt: „Geschäftsführer suchen“ liest das Impressum und übernimmt Name, Anrede und die veröffentlichte persönliche Adresse.",
          "Wer warm wird (Interesse, Termin, Link geklickt), steht unter „Leads → Status: Warm“. Export → in der Sales App hochladen.",
          "Die App legt keine Anruf-Aufgaben an und ruft niemanden an.",
          "Privatpersonen nie anmailen – Kaltakquise nur an Firmenadressen."
        ])),
      section("3 · Kaltakquise per Mail ohne Einwilligung – nur bewusst und eng begrenzt",
        p("Die App erlaubt Kampagnen mit der Rechtsgrundlage „Kaltakquise“ nur nach ausdrücklicher Bestätigung (mit Name und Zeitpunkt dokumentiert) und mit festen Grenzen. Das rechtliche Risiko bleibt bestehen – es wird nur kleiner, wenn die Mail relevant, selten und leicht abbestellbar ist."),
        list([
          "Höchstens 3 Mails pro Kontakt, mindestens 4 Tage Abstand, kein Tracking, keine Links in der ersten Mail.",
          "Nur Firmenadressen (keine Gmail/GMX/Web.de …), nur geprüfte A/B-Leads, höchstens 3 Kontakte je Firma in 30 Tagen, 90 Tage Sperrfrist zwischen Kampagnen.",
          "Keine gekauften Listen ohne Einwilligungsnachweis. Bei „kein Interesse“ ein Jahr Sperre, bei Abmeldung dauerhaft."
        ])),
      section("4 · Pflichtangaben in jeder Mail",
        list([
          "Impressum bzw. Geschäftsbrief-Angaben (§ 5 DDG, bei GmbH/UG § 35a GmbHG): Firma mit Rechtsform, Anschrift, Geschäftsführung, Registergericht und HRB-Nummer – in Einstellungen → Fußzeile.",
          "Abmelde-Hinweis mit Link und One-Click-Abmeldung (List-Unsubscribe) – die App hängt ihn automatisch an und sperrt Abmeldungen sofort, auch wenn jemand nur „bitte austragen“ antwortet.",
          "Datenschutz (Art. 13/14 DSGVO): Woher die Daten stammen, wofür sie genutzt werden und wie man widerspricht – über den Link zur Datenschutzerklärung ({{privacy_url}}) in der Fußzeile.",
          "Absender und werblicher Charakter dürfen in Absender- und Betreffzeile nicht verschleiert werden (§ 6 DDG): kein „Re:“/„AW:“ in der ersten Mail, kein „wie besprochen“, wenn es kein Gespräch gab. Der Rechts-Check vor dem Start blockiert solche Texte."
        ])),
      section("5 · Tracking",
        p("Öffnungs- und Klick-Tracking greift auf das Endgerät zu und braucht eine Einwilligung (§ 25 TDDDG). Es ist deshalb standardmäßig aus und bei Kaltakquise gesperrt. Die Kennzahl, die zählt, sind Antworten und gebuchte Termine – beides misst die App ohne Tracking.")),
      section("6 · Freigabe: kein Text geht ungeprüft raus",
        list([
          "Jede Vorlage und jede Kampagne muss freigegeben werden. Jede Änderung an Texten, Abständen, Nachfass-Texten oder Rechtsgrundlage hebt die Freigabe auf; eine laufende Kampagne hält dann automatisch an.",
          "Automatisches Nachfassen nutzt nur freigegebene Texte. Ohne freigegebenen Text entsteht ein Entwurf in den Aufgaben, den ihr prüft und selbst sendet.",
          "KI-Volltext-Personalisierung formuliert freigegebene Texte je Lead um – in der Vorschau Stichproben prüfen oder „Einstiegssatz“ nutzen."
        ])),
      section("7 · Zustellbarkeit und Anbieter",
        list([
          "Eigene Postfächer (ALL-INKL, Google Workspace, IONOS, STRATO …) mit SPF, DKIM und DMARC – die DNS-Prüfung zeigt, was fehlt. Separate Versand-Domains schützen den Ruf der Hauptdomain bei viel Menge; bei kleiner Menge geht auch die Hauptdomain (Einrichtung → „Über meine Hauptdomain“). Rechtlich ändert die Domain nichts.",
          "Neue Postfächer sanft starten (5 Mails, dann +3 pro Tag), höchstens 30 Mails pro Postfach und Tag.",
          "Transaktions-Dienste wie Resend, Postmark oder SendGrid verbieten in ihren Nutzungsbedingungen unaufgeforderte Akquise-Mails – das führt zur Sperrung des Kontos und schadet der Domain."
        ])),
      section("8 · Qualität vor Menge",
        list([
          "Ein Produkt, eine klar beschriebene Zielgruppe, ein konkreter Anlass pro Firma.",
          "Kurze, ehrliche Mails (60–120 Wörter), eine leichte Handlung als Abschluss, keine Superlative, keine erfundenen Referenzen.",
          "Antworten schnell und persönlich beantworten – die Aufgabenliste sorgt dafür, dass kein Interessent liegen bleibt."
        ])),
      section("9 · Texte, die Antworten bekommen",
        h("p", null, "Das Handwerk stammt zum Teil aus einem Cold-Mailing-Coaching. Übernommen ist, was funktioniert und in Deutschland sauber ist – nicht alles."),
        list([
          "Die Mail ist ein Aufhänger für das Telefonat, kein Verkaufstext. Termine entstehen meist erst durch das Nachtelefonieren.",
          "Aufbau der ersten Mail: Anrede → individueller Bezug zu genau dieser Firma → Einstiegsangebot → kurz warum → eine leichte Handlung („Soll ich Ihnen das kurz schicken?“).",
          "Einstiegsangebot statt Verkaufsangebot: etwas Konkretes, für das der Empfänger nur antworten muss – z. B. eine kurze Einschätzung, ein erster Baustein auf unsere Kosten, ein Pilot, ein Förderhinweis. Je dünner die Referenzen, desto stärker muss das Angebot sein.",
          "Nachfassen mit Eskalation, jede Mail genau eine Aufgabe: kurz nachhaken → ein neuer Aspekt (Beispiel, Ergebnis) → ehrliche Relevanz-Frage → freundlicher Abschluss.",
          "Aufhänger für den ersten Satz, in dieser Reihenfolge: Kundenstimme von der Website, konkrete Beobachtung, sichtbare Lücke (als Chance), Branche und Region.",
          "In „Vorlage mit KI erstellen“ das Einstiegsangebot wählen oder vorschlagen lassen. In der Terminvorbereitung steht der Schmerz-Leitfaden (Situation, warum, Kosten des Nichthandelns, heute, bisher, warum jetzt)."
        ]),
        h("p", null, h("strong", null, "Bewusst nicht übernommen:")),
        list([
          "Betreffs wie „Unser Gespräch {{Vorname}}“, „Meeting {{Vorname}} & Julia“ oder „Zugang freigeschaltet“ – sie täuschen einen Termin oder ein Konto vor (§ 5 UWG). Der Rechts-Check meldet das.",
          "Künstliche Verknappung („nur noch 3 Plätze“) und erfundene Referenzen oder Garantien – nur, was wirklich stimmt und im Wissen steht.",
          "„Ich habe schon ein Video für Sie aufgenommen, morgen ist es fertig“, wenn es das nicht gibt – stattdessen ehrlich anbieten, es zu erstellen.",
          "Bilder, GIFs, Videos und Klick-Tracking in der ersten Mail – schaden der Zustellbarkeit; Tracking nur mit Einwilligung.",
          "Massen-Kaltmails ohne Einwilligung: E-Mail-Werbung braucht auch bei Firmen eine Einwilligung (§ 7 UWG). Das Risiko bleibt – deshalb nur ausgewählte, passende Firmen, wenig Menge, ein echtes Geschenk im Pitch und Widerspruch sofort sperren."
        ])),
      section("10 · Schnell sperren per Notiz",
        list([
          "#nomail in einer Notiz (Firma, Lead, Aufgabe): an diese Person keine Mails mehr – Sequenzen und Nachfassen stoppen sofort.",
          "#blacklist: die ganze Firma nie wieder kontaktieren – alle Personen gesperrt, Domain auf der Sperrliste, offene Aufgaben geschlossen.",
          "Klickt jemand in einer Kampagne mit Einwilligung auf einen Link, steht er sofort unter „Warm“ – am selben Tag in die Sales App übergeben."
        ]))));
}
