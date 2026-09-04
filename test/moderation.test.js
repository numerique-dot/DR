import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase, startServer } from "./helpers.js";

/* Modération activée : les fiches attendent une validation. */
process.env.MERCHANT_AUTO_APPROVE = "false";
process.env.ADMIN_EMAILS = "moderation@drdu.example";

const database = isolatedDatabase();

const FICHE = {
  name: "Studio Lin",
  category: "beaute",
  description: "Coiffure et couleur, équipe bilingue français-chinois.",
  address: "5 rue de Belleville",
  city: "Paris",
  postalCode: "75020",
  phone: "01 42 00 00 00",
  languages: ["Français", "中文"],
};

let pro;
let admin;
let client;
let merchantId;

async function account(app, email, name) {
  await app.post("/api/auth/signup", { email, password: "motdepassesolide", name });
  return app;
}

before(async () => {
  pro = await account(await startServer(), "pro@example.com", "Lin");
  admin = await account(await startServer(), "moderation@drdu.example", "Modération");
  client = await account(await startServer(), "client@example.com", "Léa");
  const created = await pro.post("/api/merchants", FICHE);
  merchantId = created.body.merchant.id;
});

after(async () => {
  for (const app of [pro, admin, client]) await app.close();
  database.cleanup();
});

describe("file de validation", () => {
  it("dépose la fiche en attente, hors catalogue", async () => {
    const { body } = await pro.get("/api/merchant/me");
    assert.equal(body.merchant.status, "pending");
    const catalog = await client.get("/api/catalog");
    assert.equal(catalog.body.merchants.length, 0, "une fiche en attente ne paraît pas au catalogue");
  });

  it("réserve la modération aux comptes désignés", async () => {
    assert.equal((await pro.get("/api/admin/merchants")).status, 403);
    assert.equal((await client.put(`/api/admin/merchants/${merchantId}`, { status: "active" })).status, 403);
    const anonymous = await startServer();
    assert.equal((await anonymous.get("/api/admin/merchants")).status, 401);
    await anonymous.close();
  });

  it("liste la file avec le compte propriétaire", async () => {
    const { status, body } = await admin.get("/api/admin/merchants?statut=pending");
    assert.equal(status, 200);
    assert.equal(body.merchants.length, 1);
    assert.equal(body.merchants[0].owner.email, "pro@example.com");
    assert.equal(body.counts.pending, 1);
  });

  it("exige un motif pour refuser", async () => {
    const { status, body } = await admin.put(`/api/admin/merchants/${merchantId}`, { status: "rejected" });
    assert.equal(status, 400);
    assert.match(body.error, /motivé/);
  });

  it("refuse avec motif, que le commerçant peut lire", async () => {
    const note = "Adresse incomplète : indiquez le numéro de rue.";
    const { body } = await admin.put(`/api/admin/merchants/${merchantId}`, { status: "rejected", note });
    assert.equal(body.merchant.status, "rejected");
    const seen = await pro.get("/api/merchant/me");
    assert.equal(seen.body.merchant.moderationNote, note);
  });

  it("remet la fiche corrigée en attente", async () => {
    const { body } = await pro.put("/api/merchant/me", { ...FICHE, address: "5 bis rue de Belleville" });
    assert.equal(body.merchant.status, "pending", "une fiche refusée puis corrigée repasse en validation");
  });

  it("publie la fiche validée", async () => {
    const { body } = await admin.put(`/api/admin/merchants/${merchantId}`, { status: "active" });
    assert.equal(body.merchant.status, "active");
    const catalog = await client.get("/api/catalog");
    assert.equal(catalog.body.merchants.length, 1);
  });

  it("refuse un statut inventé", async () => {
    assert.equal((await admin.put(`/api/admin/merchants/${merchantId}`, { status: "vip" })).status, 400);
  });
});

describe("mise en pause par le commerçant", () => {
  it("retire puis remet la fiche au catalogue", async () => {
    const paused = await pro.put("/api/merchant/visibility", { visible: false });
    assert.equal(paused.body.merchant.status, "paused");
    assert.equal((await client.get("/api/catalog")).body.merchants.length, 0);

    const back = await pro.put("/api/merchant/visibility", { visible: true });
    assert.equal(back.body.merchant.status, "active");
    assert.equal((await client.get("/api/catalog")).body.merchants.length, 1);
  });

  it("ne permet pas de se publier soi-même quand la fiche attend une validation", async () => {
    const other = await account(await startServer(), "autre@example.com", "Autre");
    await other.post("/api/merchants", { ...FICHE, name: "Autre salon" });
    const { status, body } = await other.put("/api/merchant/visibility", { visible: true });
    assert.equal(status, 409);
    assert.match(body.error, /validation/);
    await other.close();
  });
});

describe("suspension par la modération", () => {
  it("ne peut pas être levée par le commerçant", async () => {
    const suspended = await admin.put(`/api/admin/merchants/${merchantId}`, { status: "suspended", note: "Signalements répétés." });
    assert.equal(suspended.body.merchant.status, "suspended");
    assert.equal((await client.get("/api/catalog")).body.merchants.length, 0);

    const attempt = await pro.put("/api/merchant/visibility", { visible: true });
    assert.equal(attempt.status, 409, "seule la modération lève une suspension");
    assert.match(attempt.body.error, /suspendue/);
    assert.equal((await pro.get("/api/merchant/me")).body.merchant.status, "suspended");

    // La modération, elle, peut rétablir.
    assert.equal((await admin.put(`/api/admin/merchants/${merchantId}`, { status: "active" })).body.merchant.status, "active");
  });
});
