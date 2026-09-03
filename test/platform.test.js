import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase, startServer } from "./helpers.js";

const database = isolatedDatabase();

/** Un compte prêt à l'emploi, avec sa propre session. */
async function account(name) {
  const app = await startServer();
  const { body } = await app.post("/api/auth/signup", {
    email: `${name}${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: "motdepassesolide",
    name,
  });
  return { app, user: body.user };
}

const MERCHANT = {
  name: "Studio Lin",
  category: "beaute",
  description: "Coiffure et couleur, équipe bilingue français-chinois.",
  address: "5 rue de Belleville",
  city: "Paris",
  postalCode: "75020",
  phone: "01 42 00 00 00",
  languages: ["Français", "中文"],
};

const inFuture = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();

let pro;
let client;
let outsider;
let merchantId;
let serviceId;

before(async () => {
  pro = await account("pro");
  client = await account("client");
  outsider = await account("tiers");

  const created = await pro.app.post("/api/merchants", MERCHANT);
  merchantId = created.body.merchant.id;
  const service = await pro.app.post("/api/merchant/services", {
    name: "Coupe et brushing",
    durationMin: 45,
    priceCents: 3500,
  });
  serviceId = service.body.service.id;
  await pro.app.post("/api/merchant/slots", { startsAt: [inFuture(24), inFuture(25), inFuture(26)] });
});

after(async () => {
  for (const session of [pro, client, outsider]) await session.app.close();
  database.cleanup();
});

describe("inscription des commerçants", () => {
  it("refuse une fiche incomplète en nommant les champs", async () => {
    const { status, body } = await outsider.app.post("/api/merchants", { name: "", category: "inexistante" });
    assert.equal(status, 400);
    assert.match(body.error, /nom de l'établissement/);
    assert.match(body.error, /catégorie/);
  });

  it("refuse un deuxième établissement sur le même compte", async () => {
    const { status } = await pro.app.post("/api/merchants", MERCHANT);
    assert.equal(status, 409);
  });

  it("passe le compte en rôle commerçant et publie la fiche", async () => {
    const { body } = await pro.app.get("/api/config");
    assert.equal(body.user.role, "merchant");
    assert.equal(body.merchant.id, merchantId);
    assert.equal(body.merchant.status, "active");
  });

  it("ferme le back-office aux comptes sans établissement", async () => {
    assert.equal((await client.app.get("/api/merchant/me")).status, 403);
    assert.equal((await client.app.post("/api/merchant/services", { name: "x", durationMin: 30, priceCents: 0 })).status, 403);
    assert.equal((await client.app.post("/api/merchant/slots", { startsAt: [inFuture(30)] })).status, 403);
  });
});

describe("catalogue", () => {
  it("expose la fiche, ses prestations et ses créneaux libres", async () => {
    const anonymous = await startServer();
    const { status, body } = await anonymous.get("/api/catalog");
    assert.equal(status, 200);
    const found = body.merchants.find((row) => row.id === merchantId);
    assert.ok(found, "la fiche doit paraître au catalogue");
    assert.equal(found.services.length, 1);
    assert.equal(found.openSlots, 3);
    assert.ok(body.cities.includes("Paris"));
    await anonymous.close();
  });

  it("filtre par ville et par catégorie", async () => {
    const hit = await client.app.get("/api/catalog?ville=paris&categorie=beaute");
    assert.equal(hit.body.merchants.length, 1);
    const miss = await client.app.get("/api/catalog?ville=Lyon");
    assert.equal(miss.body.merchants.length, 0);
  });
});

describe("réservation", () => {
  let bookingId;

  it("réserve un créneau et retourne une référence", async () => {
    const detail = await client.app.get(`/api/merchants/${merchantId}`);
    const slot = detail.body.slots[0];
    const { status, body } = await client.app.post("/api/bookings", {
      slotId: slot.id,
      serviceId,
      note: "我想染浅棕色，可以吗？",
      noteLang: "zh",
    });
    assert.equal(status, 201);
    assert.match(body.booking.reference, /^DR-[0-9A-F]{6}$/);
    bookingId = body.booking.id;
  });

  it("retire le créneau réservé des disponibilités", async () => {
    const detail = await client.app.get(`/api/merchants/${merchantId}`);
    assert.equal(detail.body.slots.length, 2);
  });

  it("refuse deux réservations du même créneau", async () => {
    const before = await pro.app.post("/api/merchant/slots", { startsAt: [inFuture(48)] });
    const slot = before.body.slots.find((row) => !row.booked);
    const first = await client.app.post("/api/bookings", { slotId: slot.id, serviceId });
    assert.equal(first.status, 201);
    const second = await outsider.app.post("/api/bookings", { slotId: slot.id, serviceId });
    assert.equal(second.status, 409);
  });

  it("refuse un créneau passé et une prestation étrangère", async () => {
    assert.equal((await client.app.post("/api/bookings", { slotId: "inconnu", serviceId })).status, 404);
    const detail = await client.app.get(`/api/merchants/${merchantId}`);
    const slot = detail.body.slots[0];
    assert.equal((await client.app.post("/api/bookings", { slotId: slot.id, serviceId: "autre" })).status, 400);
  });

  it("traduit la précision du client dans la langue du commerçant", async () => {
    const { status, body } = await pro.app.get("/api/merchant/bookings?lang=fr");
    assert.equal(status, 200);
    const booking = body.bookings.find((row) => row.id === bookingId);
    assert.ok(booking.noteTranslation, "la consigne doit être traduite");
    assert.notEqual(booking.noteTranslation, booking.note);
    assert.equal(booking.note, "我想染浅棕色，可以吗？", "l'original doit rester intact");
  });

  it("ne traduit pas quand la langue est déjà la bonne", async () => {
    const { body } = await pro.app.get("/api/merchant/bookings?lang=zh");
    const booking = body.bookings.find((row) => row.id === bookingId);
    assert.equal(booking.noteTranslation, null);
  });

  it("cloisonne les réservations entre comptes", async () => {
    const mine = await client.app.get("/api/bookings");
    assert.ok(mine.body.bookings.some((row) => row.id === bookingId));
    const theirs = await outsider.app.get("/api/bookings");
    assert.ok(!theirs.body.bookings.some((row) => row.id === bookingId));
  });

  it("permet au client d'annuler et libère le créneau", async () => {
    const detail = await client.app.get(`/api/merchants/${merchantId}`);
    const before = detail.body.slots.length;
    const { status, body } = await client.app.post(`/api/bookings/${bookingId}/cancel`);
    assert.equal(status, 200);
    assert.equal(body.booking.status, "cancelled");
    assert.equal(body.booking.cancelledBy, "customer");
    const after = await client.app.get(`/api/merchants/${merchantId}`);
    assert.equal(after.body.slots.length, before + 1, "le créneau doit repartir au catalogue");
  });

  it("interdit à un tiers d'annuler", async () => {
    assert.equal((await outsider.app.post(`/api/bookings/${bookingId}/cancel`)).status, 404);
  });
});

describe("messages traduits", () => {
  let bookingId;

  before(async () => {
    // Créneau dédié : ce bloc ne dépend pas de ce que les autres ont réservé.
    const moment = inFuture(120);
    await pro.app.post("/api/merchant/slots", { startsAt: [moment] });
    const opened = await pro.app.get("/api/merchant/me");
    const slot = opened.body.slots.find((row) => row.startsAt === moment && !row.booked);
    const created = await client.app.post("/api/bookings", { slotId: slot.id, serviceId });
    assert.equal(created.status, 201, "la réservation de préparation doit réussir");
    bookingId = created.body.booking.id;
  });

  it("traduit le message reçu et garde l'original", async () => {
    await pro.app.post(`/api/bookings/${bookingId}/messages`, {
      body: "Bonjour, prévoyez quinze minutes de plus.",
    });
    const { status, body } = await client.app.get(`/api/bookings/${bookingId}/messages?lang=zh`);
    assert.equal(status, 200);
    assert.equal(body.role, "customer");
    const [message] = body.messages;
    assert.equal(message.mine, false);
    assert.equal(message.body, "Bonjour, prévoyez quinze minutes de plus.");
    assert.ok(message.translation);
  });

  it("ne traduit pas ses propres messages", async () => {
    await client.app.post(`/api/bookings/${bookingId}/messages`, { body: "他好的，谢谢！" });
    const { body } = await client.app.get(`/api/bookings/${bookingId}/messages?lang=zh`);
    const mine = body.messages.find((row) => row.mine);
    assert.equal(mine.translation, null);
  });

  it("refuse un message vide et ferme le fil aux tiers", async () => {
    assert.equal((await client.app.post(`/api/bookings/${bookingId}/messages`, { body: "   " })).status, 400);
    assert.equal((await outsider.app.get(`/api/bookings/${bookingId}/messages`)).status, 404);
    assert.equal((await outsider.app.post(`/api/bookings/${bookingId}/messages`, { body: "coucou" })).status, 404);
  });
});

describe("prestations et créneaux", () => {
  it("désactive une prestation sans la supprimer, puis la supprime", async () => {
    const created = await pro.app.post("/api/merchant/services", {
      name: "Coloration",
      durationMin: 90,
      priceCents: 7500,
    });
    const id = created.body.service.id;
    assert.ok(
      (await client.app.get(`/api/merchants/${merchantId}`)).body.services.some((row) => row.id === id),
      "une prestation active doit être proposée au public",
    );

    const off = await pro.app.put(`/api/merchant/services/${id}`, {
      name: "Coloration",
      durationMin: 90,
      priceCents: 7500,
      active: false,
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.service.active, false);
    assert.ok(
      !(await client.app.get(`/api/merchants/${merchantId}`)).body.services.some((row) => row.id === id),
      "une prestation désactivée disparaît du public",
    );
    assert.ok(
      (await pro.app.get("/api/merchant/me")).body.services.some((row) => row.id === id),
      "elle reste visible dans le back-office",
    );

    assert.equal((await pro.app.del(`/api/merchant/services/${id}`)).status, 200);
    assert.equal((await pro.app.del(`/api/merchant/services/${id}`)).status, 404);
  });

  it("interdit de modifier la prestation d'un autre commerçant", async () => {
    const services = await pro.app.get("/api/merchant/me");
    const id = services.body.services[0].id;
    const { status } = await outsider.app.put(`/api/merchant/services/${id}`, {
      name: "Détournement",
      durationMin: 10,
      priceCents: 0,
    });
    assert.equal(status, 403, "un compte sans établissement n'a pas accès au back-office");
  });

  it("refuse de retirer un créneau réservé, l'accepte sinon", async () => {
    // Créneau dédié à ce test, pour ne dépendre d'aucun autre.
    const moment = inFuture(96);
    await pro.app.post("/api/merchant/slots", { startsAt: [moment] });
    const opened = await pro.app.get("/api/merchant/me");
    const slot = opened.body.slots.find((row) => row.startsAt === moment);
    assert.ok(slot, "le créneau vient d'être ouvert");

    // Libre : le retrait passe.
    assert.equal((await pro.app.del(`/api/merchant/slots/${slot.id}`)).status, 200);

    // Réservé : le retrait est refusé.
    await pro.app.post("/api/merchant/slots", { startsAt: [moment] });
    const again = await pro.app.get("/api/merchant/me");
    const reopened = again.body.slots.find((row) => row.startsAt === moment);
    const booked = await client.app.post("/api/bookings", { slotId: reopened.id, serviceId });
    assert.equal(booked.status, 201);
    const refused = await pro.app.del(`/api/merchant/slots/${reopened.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /réservé/);

    await client.app.post(`/api/bookings/${booked.body.booking.id}/cancel`);
  });

  it("ignore les créneaux en double", async () => {
    const moment = inFuture(72);
    const first = await pro.app.post("/api/merchant/slots", { startsAt: [moment] });
    assert.equal(first.body.created, 1);
    const again = await pro.app.post("/api/merchant/slots", { startsAt: [moment] });
    assert.equal(again.body.created, 0, "le même créneau ne doit pas être créé deux fois");
  });
});

describe("langue de l'interface", () => {
  it("sert le dictionnaire demandé sans compte", async () => {
    const anonymous = await startServer();
    const { body } = await anonymous.get("/api/config?lang=zh");
    assert.equal(body.locale, "zh");
    assert.equal(body.dictionary["pro.tab.agenda"], "日程");
    await anonymous.close();
  });

  it("mémorise la langue du compte", async () => {
    const changed = await client.app.put("/api/locale", { locale: "zh" });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.locale, "zh");
    assert.equal(changed.body.dictionary["nav.bookings"], "我的预约");

    const config = await client.app.get("/api/config");
    assert.equal(config.body.locale, "zh", "la langue doit survivre à la requête suivante");
    assert.equal(config.body.user.locale, "zh");

    await client.app.put("/api/locale", { locale: "fr" });
  });

  it("retombe sur le français pour une langue inconnue", async () => {
    const anonymous = await startServer();
    const { body } = await anonymous.get("/api/config?lang=klingon");
    assert.equal(body.locale, "fr");
    await anonymous.close();
  });
});

describe("limitation de débit de l'authentification", () => {
  it("ne compte que les échecs : une connexion réussie libère le quota", async () => {
    const app = await startServer();
    const credentials = {
      email: `quota${Date.now()}@example.com`,
      password: "motdepassesolide",
      name: "Quota",
    };
    await app.post("/api/auth/signup", credentials);
    await app.post("/api/auth/logout");

    // Neuf échecs : sous la limite de dix.
    for (let attempt = 0; attempt < 9; attempt++) {
      const bad = await app.post("/api/auth/login", { email: credentials.email, password: "mauvais-mot-de-passe" });
      assert.equal(bad.status, 401, `tentative ${attempt + 1}`);
    }

    // La bonne remet le compteur à zéro…
    assert.equal((await app.post("/api/auth/login", credentials)).status, 200);

    // …donc dix nouveaux échecs sont de nouveau possibles avant blocage.
    let blocked = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await app.post("/api/auth/login", { email: credentials.email, password: "encore-faux" });
      if (response.status === 429) {
        blocked = { attempt: attempt + 1, response };
        break;
      }
    }
    assert.ok(blocked, "la limitation doit finir par bloquer");
    assert.ok(blocked.attempt > 9, `le quota devait repartir de zéro (bloqué à la ${blocked.attempt}e)`);
    await app.close();
  });
});
