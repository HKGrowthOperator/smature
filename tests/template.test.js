import { test } from "node:test";
import assert from "node:assert/strict";
import { spin, fillVars, render, greeting, buildVars, lintTemplate, usedVariables, salutationGender } from "../src/lib/template.js";
import { seededRandom } from "../src/crypto.js";

test("Spintax wählt eine Option und lässt Variablen-Klammern unangetastet", () => {
  for (let i = 0; i < 20; i++) {
    const out = spin("{Hallo|Hi|Guten Tag} {{first_name}}, {kurz|knapp}: {{company|eure Firma}}");
    assert.match(out, /^(Hallo|Hi|Guten Tag) \{\{first_name\}\}, (kurz|knapp): \{\{company\|eure Firma\}\}$/);
  }
  assert.equal(spin("{A|{B|C}}", () => 0.99), "C");
  assert.equal(spin("ohne { Klammer"), "ohne { Klammer");
});

test("Seeded Spintax ist deterministisch (Vorschau = Versand)", () => {
  const a = render("{a|b|c|d|e|f}", {}, "seed-1").text;
  for (let i = 0; i < 5; i++) assert.equal(render("{a|b|c|d|e|f}", {}, "seed-1").text, a);
  const r1 = seededRandom("x"), r2 = seededRandom("x");
  assert.equal(r1(), r2());
});

test("Variablen mit Fallback, Aliasen und Fehlerliste", () => {
  const vars = { first_name: "Max", company: "", "custom.mitarbeiter": "12" };
  assert.deepEqual(fillVars("Hi {{first_name}} von {{company|eurer Firma}}", vars), { text: "Hi Max von eurer Firma", missing: [] });
  assert.deepEqual(fillVars("{{firstName}} {{Vorname}}", vars).text, "Max Max");
  assert.deepEqual(fillVars("{{company}} {{last_name}}", vars).missing, ["company", "last_name"]);
  assert.equal(fillVars("{{custom.mitarbeiter}} MA", vars).text, "12 MA");
  assert.equal(fillVars("{{ first_name | Hallo }}", { first_name: " " }).text, "Hallo");
});

test("Deutsche Anrede", () => {
  assert.equal(greeting({ salutation: "Herr", last_name: "Müller", first_name: "Max" }), "Sehr geehrter Herr Müller");
  assert.equal(greeting({ salutation: "Frau Dr.", last_name: "Schmidt" }), "Sehr geehrte Frau Dr. Schmidt");
  assert.equal(greeting({ salutation: "", first_name: "Kim", last_name: "Lee" }), "Guten Tag Kim Lee");
  assert.equal(greeting({}), "Guten Tag");
  assert.equal(greeting({ first_name: "Max" }, "de", "casual"), "Hallo Max");
  assert.equal(greeting({ salutation: "Mr", last_name: "Smith" }, "en"), "Dear Mr. Smith");
  assert.equal(salutationGender("Hr."), "m");
  assert.equal(salutationGender("Fr."), "f");
});

test("buildVars: Domain, eigene Felder, Absender", () => {
  const v = buildVars({ lead: { email: "a@b.de", website: "https://www.dachbau-mueller.de/kontakt", custom: JSON.stringify({ Mitarbeiter: "25" }), salutation: "Herr", last_name: "Müller" }, mailbox: { from_name: "Max Mustermann", email: "l@hk.de" } });
  assert.equal(v.domain, "dachbau-mueller.de");
  assert.equal(v.mitarbeiter, "25");
  assert.equal(v.sender_first_name, "Max");
  assert.equal(v.herr_frau, "Herr Müller");
});

test("Vorlagen-Lint erkennt unausgeglichene Klammern", () => {
  assert.deepEqual(lintTemplate("{{a}} {b|c}"), []);
  assert.ok(lintTemplate("{{a} text").length >= 1);
  assert.equal(lintTemplate("{b|c").length, 1);
  assert.deepEqual(usedVariables("{{A}} {{b|x}}"), ["a", "b"]);
});

test("Fall-Blöcke: passender Zweig, sonst-Zweig, Lint und Copy-Check", async () => {
  const { resolveCases } = await import("../src/lib/template.js");
  const { leadCase } = await import("../src/lib/cases.js");
  const tpl = "{{anrede}},\n\n{{#fall handwerk,bau}}\nWer einen Dachdecker sucht, googelt.\n{{#fall gastro}}\nWer einen Tisch sucht, googelt.\n{{#sonst}}\nWer etwas sucht, googelt.\n{{/fall}}\n\nDarf ich?";
  assert.equal(resolveCases(tpl, "bau"), "{{anrede}},\n\nWer einen Dachdecker sucht, googelt.\n\nDarf ich?");
  assert.equal(resolveCases(tpl, "gastro"), "{{anrede}},\n\nWer einen Tisch sucht, googelt.\n\nDarf ich?");
  assert.equal(resolveCases(tpl, "it"), "{{anrede}},\n\nWer etwas sucht, googelt.\n\nDarf ich?");
  // Ohne sonst-Zweig fällt der Block weg, ohne doppelte Leerzeilen.
  assert.equal(resolveCases("A\n\n{{#fall gastro}}\nTisch\n{{/fall}}\n\nB", "bau"), "A\n\nB");
  // Inline-Block mitten im Satz
  assert.equal(resolveCases("holt er {{#fall gastro}}Gäste{{#fall werkstatt}}Termine{{#sonst}}Aufträge{{/fall}} rein", "werkstatt"), "holt er Termine rein");
  // render: Fall kommt aus den Lead-Daten (Kategorie der Leadquelle), Spintax und Variablen funktionieren im Zweig
  const vars = buildVars({ lead: { company: "Müller Bedachungen GmbH", industry: "Dachdeckerei", custom: "{}" } });
  assert.equal(vars.fall, "bau");
  assert.equal(render("{{#fall bau}}{Dach|Dach} von {{company}}{{#sonst}}nix{{/fall}}", vars, "s").text, "Dach von Müller Bedachungen GmbH");
  // leadCase: Branche vor Firmenname, alte Sales-App-Branche, Standard
  assert.equal(leadCase({ industry: "Kfz-Werkstatt", company: "Autohaus Schmitz" }), "werkstatt");
  assert.equal(leadCase({ company: "Pizzeria Roma GmbH" }), "gastro");
  assert.equal(leadCase({ custom: JSON.stringify({ branche: "Spedition Und Logistik" }) }), "logistik");
  assert.equal(leadCase({ custom: JSON.stringify({ branche: "Sanitär-, Heizungs- und Klimatechnik" }) }), "technik");
  assert.equal(leadCase({ custom: JSON.stringify({ branche: "Werkzeug Und Formenbauer" }) }), "metall");
  assert.equal(leadCase({ industry: "Werbeagentur" }), "agentur");
  assert.equal(leadCase({ industry: "IT-Dienstleister" }), "it");
  assert.equal(leadCase({ company: "Beispiel GmbH" }), "sonst");
  // Lint: unausgeglichen und unbekannter Fall
  assert.ok(lintTemplate("{{#fall bau}}x").some(p => /nicht ausgeglichen/.test(p)));
  assert.ok(lintTemplate("{{#fall raumfahrt}}x{{/fall}}").some(p => /Unbekannter Fall/.test(p)));
  assert.deepEqual(lintTemplate(tpl), []);
  // Copy-Check zählt den längsten Zweig
  const { checkCopy } = await import("../src/lib/spam.js");
  const words = checkCopy("Betreff {{company}}", "{{anrede}},\n\n{{#fall bau}}eins zwei{{#sonst}}eins zwei drei vier fünf sechs{{/fall}}\n\nFrage?").words;
  assert.equal(words, 8);
});

test("Beobachtung je Lead: aus der Leadquellen-Prüfung, sonst allgemeiner Satz je Fall", async () => {
  const { observation, observationShort } = await import("../src/lib/observations.js");
  const lead = { industry: "Sanitär/Heizung", custom: JSON.stringify({ website_hinweise: "veralteter Aufbau, kein Kontaktformular, Stand 2019", anfrage_signale: "Notdienst/24h", groessen_hinweise: "3 offene Stellen" }) };
  assert.equal(observation(lead), "Zwei Dinge sind mir aufgefallen: Im Footer steht noch 2019, und man kann Ihnen auf der Seite nicht direkt schreiben, es gibt nur die Telefonnummer.");
  assert.equal(observationShort(lead), "Footer sagt 2019");
  assert.match(observation(lead, { prefer: "signals" }), /^Zwei Dinge sind mir aufgefallen: Sie werben mit Notdienst/);
  assert.equal(observationShort(lead, { prefer: "signals" }), "Notdienst, aber nachts still");
  assert.equal(observation({ industry: "Kfz-Werkstatt", custom: "{}" }), "Wer abends mit schleifender Bremse am Handy eine Werkstatt sucht, entscheidet in Sekunden, wem er schreibt.");
  assert.equal(observationShort({ custom: "{}" }), "");
  const vars = buildVars({ lead });
  assert.ok(vars.beobachtung.startsWith("Zwei Dinge") && vars.aufgefallen === "Footer sagt 2019");
  assert.equal(render("{{domain}}: {{aufgefallen|eine Sache}}", buildVars({ lead: { website: "x.de", custom: "{}" } }), "s").text, "x.de: eine Sache");
});
