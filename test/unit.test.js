import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { isolatedDatabase } from "./helpers.js";

const database = isolatedDatabase();
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.STRIPE_SECRET_KEY = "sk_test";
process.env.STRIPE_PRICE_ID = "price_test";

const { verifySignature } = await import("../src/billing.js");
const { sameOrigin } = await import("../src/security.js");

describe("signature des webhooks de facturation", () => {
  const sign = (payload, timestamp) =>
    crypto.createHmac("sha256", "whsec_test").update(`${timestamp}.${payload}`).digest("hex");

  it("accepte une signature valide et récente", () => {
    const payload = JSON.stringify({ id: "evt_1" });
    const t = Math.floor(Date.now() / 1000);
    assert.equal(verifySignature(payload, `t=${t},v1=${sign(payload, t)}`), true);
  });

  it("rejette un corps modifié", () => {
    const t = Math.floor(Date.now() / 1000);
    const signature = `t=${t},v1=${sign('{"id":"evt_1"}', t)}`;
    assert.equal(verifySignature('{"id":"evt_falsifie"}', signature), false);
  });

  it("rejette un horodatage trop ancien (rejeu)", () => {
    const payload = "{}";
    const t = Math.floor(Date.now() / 1000) - 3600;
    assert.equal(verifySignature(payload, `t=${t},v1=${sign(payload, t)}`), false);
  });

  it("rejette un en-tête absent ou malformé", () => {
    assert.equal(verifySignature("{}", undefined), false);
    assert.equal(verifySignature("{}", "n'importe quoi"), false);
  });
});

describe("vérification d'origine", () => {
  const req = (origin) => ({ headers: origin ? { origin } : {} });

  it("laisse passer une requête sans origine (client non navigateur)", () => {
    assert.equal(sameOrigin(req()), true);
  });

  it("refuse une origine étrangère", () => {
    assert.equal(sameOrigin(req("https://attaquant.example")), false);
  });

  it("accepte localhost hors production", () => {
    assert.equal(sameOrigin(req("http://localhost:4321")), true);
  });
});

describe("garde-fous de configuration", () => {
  it("refuse de démarrer en production sans clé Stripe ni HTTPS", async () => {
    const previous = { ...process.env };
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_URL = "http://exemple.fr";
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    // Import frais du module de configuration pour relire l'environnement.
    const { assertProductionReady } = await import(`../src/config.js?v=${Date.now()}`);
    assert.throws(() => assertProductionReady(), /Configuration de production incomplète/);
    Object.assign(process.env, previous);
    process.env.NODE_ENV = "test";
  });
});

process.on("exit", () => database.cleanup());
