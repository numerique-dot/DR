import http from "node:http";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase, startServer } from "./helpers.js";

/* Un relais capte les courriels ; on vérifie ce que reçoit le commerçant. */
const inbox = [];
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

const { flushNotifications } = await import("../src/notifications.js");

const PRO_EMAIL = "lin@example.com";
const CLIENT_EMAIL = "wei@example.com";
let pro;
let client;
let merchantId;
let serviceId;

const inFuture = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const mailsTo = (email) => inbox.filter((mail) => mail.to === email);
const settle = () => new Promise((resolve) => setTimeout(resolve, 120));

async function newBooking(note) {
  const moment = inFuture(24 + Math.random() * 400);
  await pro.post("/api/merchant/slots", { startsAt: [moment] });
  const slot = (await pro.get("/api/merchant/me")).body.slots.find((row) => row.startsAt === moment);
  const { status, body } = await client.post("/api/bookings", { slotId: slot.id, serviceId, note, noteLang: "zh" });
  assert.equal(status, 201);
  await settle();
  return body.booking;
}

before(async () => {
  pro = await startServer();
  client = await startServer();
  await pro.post("/api/auth/signup", { email: PRO_EMAIL, password: "motdepassesolide", name: "Lin" });
  // Le commerçant travaille en chinois : ses alertes doivent l'être aussi.
  await pro.put("/api/locale", { locale: "zh" });
  await client.post("/api/auth/signup", { email: CLIENT_EMAIL, password: "motdepassesolide", name: "Wei" });

  const created = await pro.post("/api/merchants", {
    name: "Studio Lin",
    category: "beaute",
    description: "Coiffure et couleur, équipe bilingue français-chinois.",
    address: "5 rue de Belleville",
    city: "Paris",
    postalCode: "75020",
    phone: "01 42 00 00 00",
    languages: ["Français", "中文"],
  });
  merchantId = created.body.merchant.id;
  serviceId = (await pro.post("/api/merchant/services", { name: "Coupe", durationMin: 30, priceCents: 3000 })).body.service.id;
});

after(async () => {
  await pro.close();
  await client.close();
  relay.closeAllConnections();
  await new Promise((resolve) => relay.close(resolve));
  database.cleanup();
});

describe("nouvelle réservation", () => {
  it("prévient le commerçant dans sa langue, avec la consigne du client", async () => {
    const before = mailsTo(PRO_EMAIL).length;
    const booking = await newBooking("我想染浅棕色，可以吗？");
    const mails = mailsTo(PRO_EMAIL).slice(before);
    assert.equal(mails.length, 1, "un seul courriel au commerçant");
    assert.match(mails[0].subject, /新预约/, "sujet en chinois, la langue du commerçant");
    assert.match(mails[0].text, /Wei/);
    assert.match(mails[0].text, new RegExp(booking.reference));
    assert.match(mails[0].text, /我想染浅棕色/, "la consigne d'origine figure dans le courriel");
  });

  it("prévient aussi le client, comme avant", async () => {
    const before = mailsTo(CLIENT_EMAIL).length;
    await newBooking("");
    assert.equal(mailsTo(CLIENT_EMAIL).length, before + 1);
  });
});

describe("annulation", () => {
  it("par le client : le commerçant est prévenu", async () => {
    const booking = await newBooking("");
    const before = mailsTo(PRO_EMAIL).length;
    await client.post(`/api/bookings/${booking.id}/cancel`);
    await settle();
    const mails = mailsTo(PRO_EMAIL).slice(before);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /取消/);
  });

  it("par le commerçant : le client est prévenu, pas le commerçant", async () => {
    const booking = await newBooking("");
    const beforePro = mailsTo(PRO_EMAIL).length;
    const beforeClient = mailsTo(CLIENT_EMAIL).length;
    await pro.post(`/api/bookings/${booking.id}/cancel`);
    await settle();
    assert.equal(mailsTo(PRO_EMAIL).length, beforePro, "on ne se prévient pas soi-même");
    assert.equal(mailsTo(CLIENT_EMAIL).length, beforeClient + 1);
  });
});

describe("messages groupés", () => {
  it("n'envoie rien immédiatement, puis un seul récapitulatif à l'échéance", async () => {
    const booking = await newBooking("");
    const before = mailsTo(PRO_EMAIL).length;

    await client.post(`/api/bookings/${booking.id}/messages`, { body: "第一条消息" });
    await client.post(`/api/bookings/${booking.id}/messages`, { body: "第二条消息" });
    await client.post(`/api/bookings/${booking.id}/messages`, { body: "第三条消息" });
    await settle();
    assert.equal(mailsTo(PRO_EMAIL).length, before, "pas de courriel à chaque message");

    // Cinq minutes plus tard : toujours rien, le délai est de dix.
    const early = await flushNotifications({ now: new Date(Date.now() + 5 * 60_000) });
    assert.equal(early.sent, 0);

    // Onze minutes plus tard : un seul courriel, qui compte les trois messages.
    const due = await flushNotifications({ now: new Date(Date.now() + 11 * 60_000) });
    assert.equal(due.sent, 1);
    await settle();
    const mails = mailsTo(PRO_EMAIL).slice(before);
    assert.equal(mails.length, 1, "trois messages, un courriel");
    assert.match(mails[0].subject, /3 条新消息/);
    assert.match(mails[0].text, /Wei/);

    // La file est vidée : un second passage n'envoie rien.
    assert.equal((await flushNotifications({ force: true })).sent, 0);
  });

  it("n'envoie rien si le destinataire a lu la conversation entre-temps", async () => {
    const booking = await newBooking("");
    const before = mailsTo(PRO_EMAIL).length;
    await client.post(`/api/bookings/${booking.id}/messages`, { body: "有空吗？" });
    // Le commerçant ouvre le fil avant l'échéance.
    await pro.get(`/api/bookings/${booking.id}/messages`);
    const result = await flushNotifications({ force: true });
    assert.equal(result.sent, 0, "lu avant l'envoi : pas de courriel");
    assert.equal(mailsTo(PRO_EMAIL).length, before);
  });

  it("fonctionne dans l'autre sens : le client reçoit le récapitulatif en sa langue", async () => {
    const booking = await newBooking("");
    const before = mailsTo(CLIENT_EMAIL).length;
    await pro.post(`/api/bookings/${booking.id}/messages`, { body: "Bonjour, oui c'est possible." });
    const result = await flushNotifications({ force: true });
    assert.equal(result.sent, 1);
    await settle();
    const mails = mailsTo(CLIENT_EMAIL).slice(before);
    assert.equal(mails.length, 1);
    assert.match(mails[0].subject, /Nouveau message/, "le client est resté en français");
    assert.match(mails[0].text, /Studio Lin/);
  });

  it("regroupe plusieurs conversations dans un même courriel", async () => {
    const first = await newBooking("");
    const second = await newBooking("");
    const before = mailsTo(PRO_EMAIL).length;
    await client.post(`/api/bookings/${first.id}/messages`, { body: "A" });
    await client.post(`/api/bookings/${second.id}/messages`, { body: "B" });
    await client.post(`/api/bookings/${second.id}/messages`, { body: "C" });
    const result = await flushNotifications({ force: true });
    assert.equal(result.sent, 1, "un destinataire, un courriel");
    await settle();
    const [mail] = mailsTo(PRO_EMAIL).slice(before);
    assert.match(mail.subject, /3 条新消息/);
    assert.equal((mail.text.match(/  · /g) ?? []).length, 2, "une ligne par conversation");
  });
});
