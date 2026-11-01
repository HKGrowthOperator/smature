// DNS-Check: DKIM darf nicht durch einen Wildcard-CNAME (*.domain → Webserver) „grün“ werden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDomain } from "../src/lib/dns-check.js";

const KEY = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAx1y2z3";
const nf = () => Object.assign(new Error("not found"), { code: "ENOTFOUND" });

// Kleiner Fake-Resolver: TXT folgt CNAMEs wie ein echter Resolver, "*" = Wildcard.
function resolver({ txt = {}, cname = {}, wildcardTo = "" }) {
  // Wie in echtem DNS: Ein vorhandener Name (eigener TXT) wird nie von der Wildcard überdeckt.
  const cn = name => cname[name] ?? (txt[name] ? null : wildcardTo && name.endsWith(".muster.de") && name !== "muster.de" && !name.startsWith("_dmarc.") ? wildcardTo : null);
  return {
    resolveMx: async () => [{ priority: 10, exchange: "mx.muster.de" }],
    resolveCname: async name => { const c = cn(name); if (!c) throw nf(); return [c]; },
    resolveTxt: async name => {
      const target = cn(name) || name;
      if (txt[target]) return txt[target].map(t => [t]);
      throw nf();
    }
  };
}
const base = { "muster.de": ["v=spf1 include:spf.kasserver.com ~all"], "_dmarc.muster.de": ["v=DMARC1; p=none;"] };
const dkim = r => r.checks.find(c => c.key === "dkim");

test("Wildcard-CNAME auf den Webserver zählt nicht als DKIM", async () => {
  const r = await checkDomain("muster.de", { resolver: resolver({ txt: base, wildcardTo: "w0123.kasserver.com" }) });
  assert.equal(dkim(r).status, "warn");
  assert.match(dkim(r).fix, /ALL-INKL/);
});

test("Echter Schlüssel unter eigenem Selektor wird erkannt – auch neben einem Wildcard", async () => {
  const r = await checkDomain("muster.de", { extraSelectors: ["kas202405"], resolver: resolver({ txt: { ...base, "kas202405._domainkey.muster.de": [KEY] }, wildcardTo: "w0123.kasserver.com" }) });
  assert.equal(dkim(r).status, "ok");
  assert.match(dkim(r).detail, /kas202405/);
  assert.doesNotMatch(dkim(r).detail, /google/);
});

test("Delegiertes DKIM per CNAME (z. B. Microsoft 365) wird erkannt", async () => {
  const r = await checkDomain("muster.de", { resolver: resolver({ txt: { ...base, "selector1-muster-de._domainkey.muster.onmicrosoft.com": [KEY] }, cname: { "selector1._domainkey.muster.de": "selector1-muster-de._domainkey.muster.onmicrosoft.com" } }) });
  assert.equal(dkim(r).status, "ok");
  assert.match(dkim(r).detail, /selector1/);
});
