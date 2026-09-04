import http from "node:http";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase, startServer } from "./helpers.js";

/**
 * Le lien de réinitialisation n'existe qu'à un endroit : le courriel. On monte
 * donc un relais qui capte les messages, exactement comme le ferait un
 * prestataire d'envoi, et on lit le lien dedans.
 */
const inbox = [];

/* Le relais est monté avant tout import lisant la configuration : celle-ci
   fige MAIL_TRANSPORT et MAIL_WEBHOOK_URL au chargement du module. */
const relay = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    inbox.push(JSON.parse(body));
    res.writeHead(200).end("{}");
  });
});
await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));

const database = isolatedDatabase();
process.env.MAIL_TRANSPORT = "webhook";
process.env.MAIL_WEBHOOK_URL = `http://127.0.0.1:${relay.address().port}/`;

const { resetRateLimits } = await import("../src/security.js");
let app;
const EMAIL = "oubli@example.com";
const ORIGINAL = "motdepassesolide";

/** Demande un lien et renvoie le jeton contenu dans le courriel reçu. */
async function requestToken() {
  // La limite de cinq demandes par heure vise les abus, pas la suite de tests.
  resetRateLimits();
  const before = inbox.length;
  const { status } = await app.post("/api/auth/forgot", { email: EMAIL });
  assert.equal(status, 200);
  const message = inbox.slice(before).find((mail) => mail.subject.includes("Réinitialiser"));
  assert.ok(message, "un courriel de réinitialisation doit partir");
  const link = message.text.match(/reinitialiser\?jeton=([^\s]+)/);
  assert.ok(link, "le courriel doit contenir le lien");
  return decodeURIComponent(link[1]);
}

before(async () => {
  app = await startServer();
  await app.post("/api/auth/signup", { email: EMAIL, password: ORIGINAL, name: "Oubli" });
  await app.post("/api/auth/logout");
});

after(async () => {
  await app.close();
  // Les connexions persistantes du relais empêcheraient le processus de finir.
  relay.closeAllConnections();
  await new Promise((resolve) => relay.close(resolve));
  database.cleanup();
});

describe("demande de réinitialisation", () => {
  it("répond la même chose pour une adresse connue et inconnue", async () => {
    const known = await app.post("/api/auth/forgot", { email: EMAIL });
    const unknown = await app.post("/api/auth/forgot", { email: "personne@example.com" });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(known.body, unknown.body, "la réponse ne doit pas révéler l'existence d'un compte");
  });

  it("n'envoie de courriel qu'aux adresses connues", async () => {
    const before = inbox.length;
    await app.post("/api/auth/forgot", { email: "inconnu@example.com" });
    assert.equal(inbox.length, before, "aucun message ne part vers une adresse sans compte");
  });
});

describe("changement de mot de passe", () => {
  it("refuse un jeton absent ou inventé", async () => {
    assert.equal((await app.post("/api/auth/reset", { password: "unnouveaumotdepasse" })).status, 400);
    assert.equal((await app.post("/api/auth/reset", { token: "inventé", password: "unnouveaumotdepasse" })).status, 400);
  });

  it("refuse un mot de passe trop court sans brûler le lien", async () => {
    const token = await requestToken();
    const tooShort = await app.post("/api/auth/reset", { token, password: "court" });
    assert.equal(tooShort.status, 400);
    assert.match(tooShort.body.error, /10 caractères/);

    const retry = await app.post("/api/auth/reset", { token, password: "premiernouveaumdp" });
    assert.equal(retry.status, 200, "un mot de passe refusé ne doit pas consommer le jeton");
  });

  it("remplace le mot de passe : l'ancien ne fonctionne plus", async () => {
    assert.equal((await app.post("/api/auth/login", { email: EMAIL, password: ORIGINAL })).status, 401);
    assert.equal((await app.post("/api/auth/login", { email: EMAIL, password: "premiernouveaumdp" })).status, 200);
  });

  it("prévient l'utilisateur du changement", async () => {
    assert.ok(
      inbox.some((mail) => mail.subject.includes("mot de passe a été modifié")),
      "un courriel doit signaler le changement",
    );
  });

  it("ne sert qu'une fois", async () => {
    const token = await requestToken();
    assert.equal((await app.post("/api/auth/reset", { token, password: "deuxiemenouveaumdp" })).status, 200);
    const again = await app.post("/api/auth/reset", { token, password: "troisiemenouveaumdp" });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /invalide ou expiré/);
  });

  it("annule la demande précédente quand une nouvelle est faite", async () => {
    const first = await requestToken();
    const second = await requestToken();
    assert.notEqual(first, second);
    assert.equal((await app.post("/api/auth/reset", { token: first, password: "ancienlienrefuse" })).status, 400);
    assert.equal((await app.post("/api/auth/reset", { token: second, password: "nouveaulienaccepte" })).status, 200);
  });

  it("ferme les sessions ouvertes ailleurs", async () => {
    const connected = await startServer();
    await connected.post("/api/auth/login", { email: EMAIL, password: "nouveaulienaccepte" });
    assert.equal((await connected.get("/api/auth/me")).body.user.email, EMAIL);

    const token = await requestToken();
    await app.post("/api/auth/reset", { token, password: "motdepasseapresvol" });

    assert.equal(
      (await connected.get("/api/auth/me")).body.user,
      null,
      "la session ouverte ailleurs doit être fermée",
    );
    await connected.close();
  });
});
