// Google-Bewertungen (Places API): Treffer über Website oder Name+Ort, Regeln „keine“ / „gut“.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupDb } from "./helpers.js";
import { config } from "../src/config.js";
import { findPlace, judgePlace, setPlacesFetch } from "../src/lib/places.js";
import { qualify } from "../src/intel/sourcing.js";

let cleanup;
before(() => { cleanup = setupDb(); });
after(() => { setPlacesFetch(null); cleanup(); });

const reply = places => async (url, opts) => {
  assert.equal(opts.headers["X-Goog-Api-Key"], "test-key");
  assert.match(opts.headers["X-Goog-FieldMask"], /places\.rating/);
  return { ok: true, json: async () => ({ places }) };
};

test("ohne Schlüssel: keine Abfrage", async () => {
  config.googlePlacesKey = "";
  assert.deepEqual(await findPlace({ name: "Grün GmbH" }), { checked: false });
});

test("Treffer über die Website, sonst über Name und Ort", async () => {
  config.googlePlacesKey = "test-key";
  setPlacesFetch(reply([
    { id: "x1", displayName: { text: "Anderer Betrieb" }, formattedAddress: "Mainz", rating: 3, userRatingCount: 2, websiteUri: "https://anders.de" },
    { id: "p1", displayName: { text: "Grün Gartenbau" }, formattedAddress: "Hauptstr. 1, 55543 Bad Kreuznach", rating: 4.8, userRatingCount: 37, websiteUri: "https://www.gruen-gartenbau.de/" }
  ]));
  const byWeb = await findPlace({ name: "Irgendwas", website: "https://gruen-gartenbau.de" });
  assert.equal(byWeb.place_id, "p1"); assert.equal(byWeb.matched_by, "website");
  const byName = await findPlace({ name: "Grün Gartenbau GmbH", city: "Bad Kreuznach" });
  assert.equal(byName.place_id, "p1"); assert.equal(byName.matched_by, "name");
  assert.equal((await findPlace({ name: "Unbekannt", city: "Worms" })).found, false);
  config.googlePlacesKey = "";
});

test("Regeln: keine Bewertungen, gut, vorhanden – gute Bewertungen heben mittlere Website auf A", () => {
  const s = { google_good_count: 10, google_good_rating: 4.5 };
  assert.equal(judgePlace({ checked: true, found: true, count: 0 }, s).status, "keine");
  assert.equal(judgePlace({ checked: true, found: true, count: 37, rating: 4.8 }, s).status, "gut");
  assert.equal(judgePlace({ checked: true, found: true, count: 5, rating: 5 }, s).status, "vorhanden");
  assert.equal(judgePlace({ checked: true, found: false }, s).status, "nicht gefunden");
  const site = { text: "", quality: { score: 6, issues: ["kein Formular"] } };
  assert.equal(qualify("website", { name: "Grün" }, site).fit, "B");
  assert.equal(qualify("website", { name: "Grün" }, { ...site, google: { good: true } }).fit, "A");
});
