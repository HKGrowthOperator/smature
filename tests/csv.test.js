import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, detectDelimiter, guessMapping, toCsv } from "../src/lib/csv.js";

test("Semikolon (deutsches Excel), BOM, Anführungszeichen, Zeilenumbruch im Feld", () => {
  const csv = '﻿E-Mail;Vorname;Firma;Notiz\r\nmax@a.de;Max;"Müller; Söhne GmbH";"Zeile 1\nZeile 2"\r\n\r\nerika@b.de;Erika;"Sagt ""Hallo""";\r\n';
  const r = parseCsv(csv);
  assert.equal(r.delimiter, ";");
  assert.deepEqual(r.headers, ["E-Mail", "Vorname", "Firma", "Notiz"]);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0][2], "Müller; Söhne GmbH");
  assert.equal(r.rows[0][3], "Zeile 1\nZeile 2");
  assert.equal(r.rows[1][2], 'Sagt "Hallo"');
});

test("Trennzeichen-Erkennung", () => {
  assert.equal(detectDelimiter("a,b,c\n1,2,3"), ",");
  assert.equal(detectDelimiter("a\tb\tc"), "\t");
  assert.equal(detectDelimiter('"a,b";c;d'), ";");
});

test("Spalten automatisch zuordnen (deutsch/englisch, Apollo)", () => {
  const m = guessMapping(["Email", "First Name", "Last Name", "Company Name", "Title", "Website", "Anrede", "Mitarbeiterzahl", "Person Linkedin Url"]);
  assert.equal(m[0], "email");
  assert.equal(m[1], "first_name");
  assert.equal(m[2], "last_name");
  assert.equal(m[3], "company");
  assert.equal(m[4], "position");
  assert.equal(m[5], "website");
  assert.equal(m[6], "salutation");
  assert.equal(m[7], "custom:Mitarbeiterzahl");
  assert.equal(m[8], "linkedin");
});

test("Export schützt vor Formel-Injection und maskiert Trennzeichen", () => {
  const out = toCsv(["a", "b"], [["=HYPERLINK(1)", "x;y"]]);
  assert.match(out, /'=HYPERLINK\(1\)/);
  assert.match(out, /"x;y"/);
});
