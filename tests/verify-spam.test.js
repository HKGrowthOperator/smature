import { test } from "node:test";
import assert from "node:assert/strict";
import { syntaxValid, verifyEmail, clearMxCache, isRole } from "../src/lib/verify.js";
import { checkCopy } from "../src/lib/spam.js";

const resolver = {
  async resolveMx(d) {
    if (d === "firma.de") return [{ exchange: "mx.firma.de", priority: 10 }];
    if (d === "nullmx.de") return [{ exchange: "", priority: 0 }];
    const e = new Error("no"); e.code = "ENOTFOUND"; throw e;
  },
  async resolve4(d) { if (d === "nurweb.de") return ["1.2.3.4"]; throw Object.assign(new Error("no"), { code: "ENOTFOUND" }); }
};

test("Syntax", () => {
  assert.ok(syntaxValid("max.mueller@firma.de"));
  assert.ok(syntaxValid("a+b@sub.firma.co.uk"));
  for (const bad of ["kaputt", "a@b", "a..b@c.de", ".a@b.de", "a@b.c", "a b@c.de"]) assert.equal(syntaxValid(bad), false, bad);
});

test("Prüfung: gültig, Rolle, Wegwerf, kein MX, Null-MX, implizites MX", async () => {
  clearMxCache();
  assert.equal((await verifyEmail("max@firma.de", resolver)).status, "valid");
  assert.equal((await verifyEmail("info@firma.de", resolver)).status, "risky");
  assert.equal((await verifyEmail("x@mailinator.com", resolver)).status, "invalid");
  assert.equal((await verifyEmail("x@gibtsnicht.de", resolver)).status, "invalid");
  assert.equal((await verifyEmail("x@nullmx.de", resolver)).status, "invalid");
  assert.equal((await verifyEmail("x@nurweb.de", resolver)).status, "valid");
  assert.ok(isRole("Kontakt@firma.de"));
});

test("Copy-Check: gute Mail vs. Spam-Mail", () => {
  const good = checkCopy("Frage zu {{company}}", "{{anrede}},\n\nwir helfen Handwerksbetrieben, über die eigene Website Bewerbungen von Fachkräften zu bekommen. Bei {{company}} habe ich gesehen, dass Sie aktuell zwei Stellen ausgeschrieben haben.\n\nWäre ein kurzer Austausch dazu interessant für Sie?\n\nViele Grüße");
  assert.ok(good.score >= 80, JSON.stringify(good));
  const bad = checkCopy("KOSTENLOS!!! Nur heute", "Jetzt kaufen! 100% gratis und garantiert. Klicken Sie hier: https://bit.ly/x https://a.de https://b.de https://c.de");
  assert.ok(bad.score < 40, JSON.stringify(bad));
  assert.ok(bad.issues.some(i => /Link-Kürzer/.test(i.message)));
});
