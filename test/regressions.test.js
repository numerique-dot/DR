import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase, startServer } from "./helpers.js";

/* Chaque test de ce fichier correspond à un défaut relevé en revue avant la
   fusion : il doit échouer sur l'ancien code et passer sur le nouveau. */

const database = isolatedDatabase();
let security;
let pro;
let client;
let other;
let merchantId;
let serviceId;

const inFuture = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

async function account(email, name) {
  const app = await startServer();
  await app.post("/api/auth/signup", { email, password: "motdepassesolide", name });
  return app;
}

async function freeSlot() {
  const moment = inFuture(24 + Math.random() * 500);
  await pro.post("/api/merchant/slots", { startsAt: [moment] });
  const { body } = await pro.get("/api/merchant/me");
  return body.slots.find((row) => row.startsAt === moment);
}

before(async () => {
  security = await import("../src/security.js");
  pro = await account("pro@example.com", "Lin");
  client = await account("client@example.com", "Léa");
  other = await account("autre@example.com", "Wei");
  const created = await pro.post("/api/merchants", {
    name: "Studio Lin",
    category: "beaute",
    description: "Coiffure et couleur, équipe bilingue français-chinois.",
    address: "5 rue de Belleville",
    city: "Paris",
    postalCode: "75020",
    phone: "01 42 00 00 00",
    languages: ["Français"],
  });
  merchantId = created.body.merchant.id;
  const service = await pro.post("/api/merchant/services", { name: "Coupe", durationMin: 30, priceCents: 3000 });
  serviceId = service.body.service.id;
});

after(async () => {
  for (const app of [pro, client, other]) await app.close();
  database.cleanup();
});

describe("ménage périodique", () => {
  it("s'exécute sans lever d'exception", async () => {
    const { housekeep } = await import("../src/app.js");
    assert.doesNotThrow(() => housekeep());
    const result = housekeep();
    assert.ok(typeof result.sessions === "number" && typeof result.tokens === "number");
  });
});

describe("créneau annulé", () => {
  it("redevient réellement réservable", async () => {
    const slot = await freeSlot();
    const first = await client.post("/api/bookings", { slotId: slot.id, serviceId });
    assert.equal(first.status, 201);
    assert.equal((await client.post(`/api/bookings/${first.body.booking.id}/cancel`)).status, 200);

    const again = await other.post("/api/bookings", { slotId: slot.id, serviceId });
    assert.equal(again.status, 201, "après annulation, un autre client doit pouvoir prendre le créneau");
    await other.post(`/api/bookings/${again.body.booking.id}/cancel`);
  });

  it("supporte une seconde annulation sans erreur ni changement", async () => {
    const slot = await freeSlot();
    const { body } = await client.post("/api/bookings", { slotId: slot.id, serviceId });
    await client.post(`/api/bookings/${body.booking.id}/cancel`);
    const twice = await client.post(`/api/bookings/${body.booking.id}/cancel`);
    assert.equal(twice.status, 200);
    assert.equal(twice.body.booking.status, "cancelled");
  });
});

describe("suppression d'une prestation", () => {
  it("est refusée tant qu'une réservation en cours en dépend", async () => {
    const created = await pro.post("/api/merchant/services", { name: "Couleur", durationMin: 60, priceCents: 7000 });
    const id = created.body.service.id;
    const slot = await freeSlot();
    const booking = await client.post("/api/bookings", { slotId: slot.id, serviceId: id });
    assert.equal(booking.status, 201);

    const refused = await pro.del(`/api/merchant/services/${id}`);
    assert.equal(refused.status, 409, "supprimer détruirait la réservation du client");
    assert.match(refused.body.error, /désactivez/);

    // La réservation existe toujours.
    const mine = await client.get("/api/bookings");
    assert.ok(mine.body.bookings.some((row) => row.id === booking.body.booking.id));

    // Annulée, la réservation reste dans l'historique du client : la prestation
    // ne se supprime toujours pas, mais se désactive.
    await client.post(`/api/bookings/${booking.body.booking.id}/cancel`);
    const stillRefused = await pro.del(`/api/merchant/services/${id}`);
    assert.equal(stillRefused.status, 409);
    assert.match(stillRefused.body.error, /historique/);

    const off = await pro.put(`/api/merchant/services/${id}`, { name: "Couleur", durationMin: 60, priceCents: 7000, active: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.service.active, false);
  });

  it("reste possible pour une prestation jamais réservée", async () => {
    const created = await pro.post("/api/merchant/services", { name: "Brushing seul", durationMin: 20, priceCents: 2000 });
    assert.equal((await pro.del(`/api/merchant/services/${created.body.service.id}`)).status, 200);
  });
});

describe("réservation hors catalogue", () => {
  it("est refusée quand la fiche est en pause, même avec un identifiant de créneau", async () => {
    const slot = await freeSlot();
    assert.equal((await pro.put("/api/merchant/visibility", { visible: false })).body.merchant.status, "paused");
    const { status, body } = await client.post("/api/bookings", { slotId: slot.id, serviceId });
    assert.equal(status, 409);
    assert.match(body.error, /n'accepte pas/);
    await pro.put("/api/merchant/visibility", { visible: true });
  });
});

describe("compteur de messages non lus", () => {
  it("ne compte pas ses propres messages", async () => {
    const slot = await freeSlot();
    const { body } = await client.post("/api/bookings", { slotId: slot.id, serviceId });
    const bookingId = body.booking.id;

    await client.post(`/api/bookings/${bookingId}/messages`, { body: "Bonjour, une question." });
    const mine = await client.get("/api/bookings");
    assert.equal(mine.body.bookings.find((row) => row.id === bookingId).unread, 0, "l'auteur n'a rien de non lu");

    const theirs = await pro.get("/api/merchant/bookings");
    assert.equal(theirs.body.bookings.find((row) => row.id === bookingId).unread, 1, "le destinataire en a un");
    await client.post(`/api/bookings/${bookingId}/cancel`);
  });
});

describe("quota de connexions", () => {
  it("n'est pas remis à zéro par une inscription", async () => {
    security.resetRateLimits();
    const fresh = await startServer();
    for (let attempt = 0; attempt < 9; attempt++) {
      await fresh.post("/api/auth/login", { email: "client@example.com", password: "mauvais" });
    }
    // L'inscription consomme la dixième tentative et ne doit rien effacer.
    const signup = await fresh.post("/api/auth/signup", {
      email: `jetable${Date.now()}@example.com`,
      password: "motdepassesolide",
      name: "Jetable",
    });
    assert.equal(signup.status, 201);
    await fresh.post("/api/auth/logout");
    const blocked = await fresh.post("/api/auth/login", { email: "client@example.com", password: "mauvais" });
    assert.equal(blocked.status, 429, "créer un compte ne doit pas rouvrir la force brute");
    security.resetRateLimits();
    await fresh.close();
  });
});

describe("fiche publique", () => {
  it("n'expose ni le compte propriétaire ni les notes de modération", async () => {
    const anonymous = await startServer();
    const catalog = await anonymous.get("/api/catalog");
    for (const merchant of catalog.body.merchants) {
      assert.equal(merchant.ownerId, undefined);
      assert.equal(merchant.moderationNote, undefined);
    }
    const detail = await anonymous.get(`/api/merchants/${merchantId}`);
    assert.equal(detail.body.merchant.ownerId, undefined);
    assert.equal(detail.body.merchant.moderationNote, undefined);
    await anonymous.close();
  });
});
