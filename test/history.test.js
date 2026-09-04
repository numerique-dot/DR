import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase, startServer, textDocument } from "./helpers.js";

/* Conservation activée : elle exige l'attestation d'hébergement HDS. */
process.env.HISTORY_ENABLED = "true";
process.env.HDS_HOSTING_CERTIFIED = "true";

const database = isolatedDatabase();
let app;

before(async () => {
  app = await startServer();
  await app.post("/api/auth/signup", {
    email: "membre@example.com",
    password: "motdepassesolide",
    name: "Léa",
  });
  await app.post("/api/billing/checkout");
});
after(async () => {
  await app.close();
  database.cleanup();
});

describe("conservation activée", () => {
  it("n'enregistre rien sans demande explicite", async () => {
    const { body } = await app.post("/api/translate", { ...textDocument(), target: "zh" });
    assert.equal(body.historyId, null, "la conservation doit rester un choix explicite");
    assert.equal((await app.get("/api/history")).body.length, 0);
  });

  it("enregistre puis supprime sur demande", async () => {
    const { body } = await app.post("/api/translate", { ...textDocument(), target: "zh", save: true });
    assert.ok(body.historyId);

    const list = await app.get("/api/history");
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.ok(list.body[0].cautions.length > 0);

    assert.equal((await app.del(`/api/history/${body.historyId}`)).status, 200);
    assert.equal((await app.get("/api/history")).body.length, 0);
  });

  it("cloisonne l'historique entre comptes", async () => {
    await app.post("/api/translate", { ...textDocument(), target: "zh", save: true });
    const autre = await startServer();
    await autre.post("/api/auth/signup", {
      email: "autre@example.com",
      password: "motdepassesolide",
      name: "Autre",
    });
    await autre.post("/api/billing/checkout");
    assert.equal((await autre.get("/api/history")).body.length, 0, "aucune fuite entre comptes");
    await autre.close();
  });
});
