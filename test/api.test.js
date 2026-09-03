import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase, startServer, textDocument } from "./helpers.js";

const database = isolatedDatabase();
let app;
let security;

before(async () => {
  app = await startServer();
  security = await import("../src/security.js");
});
after(async () => {
  await app.close();
  database.cleanup();
});

const credentials = (suffix) => ({
  email: `patient${suffix}@example.com`,
  password: "motdepassesolide",
  name: "Léa Martin",
});

describe("santé du service", () => {
  it("expose /healthz", async () => {
    const { status, body } = await app.get("/healthz");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
  });

  it("sert la page d'accueil avec les en-têtes de sécurité", async () => {
    const { status, headers } = await app.get("/");
    assert.equal(status, 200);
    assert.match(headers.get("content-security-policy"), /default-src 'self'/);
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.equal(headers.get("x-frame-options"), "DENY");
  });

  it("renvoie 304 sur ETag inchangé", async () => {
    const first = await app.get("/styles.css");
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const second = await app.get("/styles.css", { headers: { "if-none-match": etag } });
    assert.equal(second.status, 304);
  });

  it("sert les pages légales sans extension", async () => {
    for (const page of ["/mentions-legales", "/confidentialite", "/cgu", "/accessibilite"]) {
      const { status } = await app.get(page);
      assert.equal(status, 200, page);
    }
  });

  it("rend une 404 pour une page inconnue et une erreur JSON pour une API inconnue", async () => {
    assert.equal((await app.get("/inconnu")).status, 404);
    const api = await app.get("/api/inconnu");
    assert.equal(api.status, 404);
    assert.equal(api.body.error, "Route inconnue.");
  });

  it("refuse la traversée de chemin", async () => {
    const { status } = await app.get("/../package.json");
    assert.ok([403, 404].includes(status), `statut inattendu : ${status}`);
  });
});

describe("comptes", () => {
  it("crée un compte en formule Essentiel, pas membre", async () => {
    const { status, body } = await app.post("/api/auth/signup", credentials("1"));
    assert.equal(status, 201);
    assert.equal(body.user.tier, "free", "un compte neuf ne doit jamais naître membre");
  });

  it("refuse un mot de passe trop court", async () => {
    const { status, body } = await app.post("/api/auth/signup", { ...credentials("2"), password: "court" });
    assert.equal(status, 400);
    assert.match(body.error, /10 caractères/);
  });

  it("refuse un doublon quelle que soit la casse", async () => {
    const { status } = await app.post("/api/auth/signup", {
      ...credentials("1"),
      email: "PATIENT1@example.com",
    });
    assert.equal(status, 409);
  });

  it("ne révèle pas l'existence d'une adresse à la connexion", async () => {
    const inconnu = await app.post("/api/auth/login", { email: "personne@example.com", password: "motdepassesolide" });
    const mauvais = await app.post("/api/auth/login", { email: "patient1@example.com", password: "mauvaismotdepasse" });
    assert.equal(inconnu.status, 401);
    assert.equal(mauvais.status, 401);
    assert.equal(inconnu.body.error, mauvais.body.error);
  });

  it("pose un cookie de session HttpOnly et SameSite", async () => {
    const { headers } = await app.post("/api/auth/login", {
      email: "patient1@example.com",
      password: "motdepassesolide",
    });
    const cookie = headers.getSetCookie()[0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  it("refuse une requête mutante d'origine étrangère", async () => {
    const { status } = await app.post("/api/auth/login", { email: "x@y.z", password: "z" }, {
      headers: { origin: "https://attaquant.example" },
    });
    assert.equal(status, 403);
  });
});

describe("traduction et paliers", () => {
  it("ignore un palier « member » réclamé par un visiteur anonyme", async () => {
    const anonymous = await startServer();
    const { status, body } = await anonymous.post("/api/translate", { ...textDocument(), tier: "member", target: "zh" });
    assert.equal(status, 200);
    assert.equal(body.tier, "free");
    assert.equal(body.cautions.length, 0, "la notice ne doit pas être produite hors formule Membre");
    assert.ok(body.translation.length > 0);
    await anonymous.close();
  });

  it("refuse un format non pris en charge", async () => {
    const { status } = await app.post("/api/translate", {
      fileName: "video.mp4",
      mediaType: "video/mp4",
      dataBase64: "AAAA",
    });
    assert.equal(status, 415);
  });

  it("refuse une requête sans document", async () => {
    assert.equal((await app.post("/api/translate", { target: "zh" })).status, 400);
  });

  it("réserve l'historique aux membres", async () => {
    const { status } = await app.get("/api/history");
    assert.equal(status, 403, "un compte Essentiel connecté doit recevoir 403");
  });
});

describe("abonnement", () => {
  it("active la formule, débloque la notice, puis résilie", async () => {
    const checkout = await app.post("/api/billing/checkout");
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.user.tier, "member");

    const translation = await app.post("/api/translate", { ...textDocument(), target: "en" });
    assert.equal(translation.body.tier, "member");
    assert.ok(translation.body.cautions.length > 0, "la notice doit être produite pour un membre");
    assert.ok(translation.body.historyId, "la traduction doit entrer dans l'historique");

    const list = await app.get("/api/history");
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    const removed = await app.del(`/api/history/${list.body[0].id}`);
    assert.equal(removed.status, 200);
    assert.equal((await app.get("/api/history")).body.length, 0);

    const portal = await app.post("/api/billing/portal");
    assert.equal(portal.body.user.tier, "free");
    assert.equal((await app.get("/api/history")).status, 403);
  });

  it("refuse une double souscription", async () => {
    await app.post("/api/billing/checkout");
    const again = await app.post("/api/billing/checkout");
    assert.equal(again.status, 409);
    await app.post("/api/billing/portal");
  });

  it("exige une session pour souscrire", async () => {
    const anonymous = await startServer();
    assert.equal((await anonymous.post("/api/billing/checkout")).status, 401);
    await anonymous.close();
  });

  it("rejette un webhook non signé", async () => {
    const { status } = await app.post("/api/billing/webhook", { id: "evt_1", type: "checkout.session.completed" });
    // Sans clé Stripe le service se déclare indisponible ; avec clé, la signature est exigée.
    assert.ok([400, 503].includes(status));
  });
});

describe("rendez-vous", () => {
  it("réserve un créneau, puis le retire des disponibilités", async () => {
    security.resetRateLimits();
    const before = await app.get("/api/config");
    const doctor = before.body.doctors.find((d) => d.id === "vasseur");
    const slot = doctor.slots[0];

    const created = await app.post("/api/appointments", {
      doctorId: "vasseur",
      slot,
      patientName: "Léa Martin",
      email: "lea@example.com",
    });
    assert.equal(created.status, 201);
    assert.match(created.body.reference, /^DRDU-[0-9A-F]{6}$/);

    const again = await app.post("/api/appointments", {
      doctorId: "vasseur",
      slot,
      patientName: "Autre",
      email: "autre@example.com",
    });
    assert.equal(again.status, 409, "le même créneau ne peut pas être réservé deux fois");

    const after = await app.get("/api/config");
    assert.ok(!after.body.doctors.find((d) => d.id === "vasseur").slots.includes(slot));
  });

  it("valide les champs obligatoires et le praticien", async () => {
    assert.equal((await app.post("/api/appointments", { doctorId: "fantome", slot: "Lun. 09:00" })).status, 400);
    const missing = await app.post("/api/appointments", { doctorId: "moreau", slot: "Mar. 08:30" });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /Champs manquants/);
  });

  it("liste les rendez-vous du seul compte connecté", async () => {
    const mine = await app.get("/api/appointments");
    assert.equal(mine.status, 200);
    assert.ok(Array.isArray(mine.body));
    const anonymous = await startServer();
    assert.equal((await anonymous.get("/api/appointments")).status, 401);
    await anonymous.close();
  });
});

describe("limitation de débit", () => {
  it("bloque après trop de tentatives de connexion", async () => {
    security.resetRateLimits();
    const fresh = await startServer();
    let blocked = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await fresh.post("/api/auth/login", { email: "a@b.co", password: "mauvaismotdepasse" });
      if (response.status === 429) {
        blocked = response;
        break;
      }
    }
    assert.ok(blocked, "la limitation doit finir par répondre 429");
    assert.ok(Number(blocked.headers.get("retry-after")) > 0);
    await fresh.close();
    security.resetRateLimits();
  });
});

describe("déconnexion", () => {
  it("invalide la session", async () => {
    await app.post("/api/auth/logout");
    assert.equal((await app.get("/api/appointments")).status, 401);
  });
});
