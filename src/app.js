import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { log } from "./logger.js";
import {
  CATEGORIES,
  bookingMessages,
  bookings,
  history,
  merchants,
  migrate,
  services,
  sessions,
  slots,
  translations,
  users,
} from "./db.js";
import {
  authenticate,
  createUser,
  currentUser,
  endSession,
  publicUser,
  sessionCookie,
  sessionToken,
  startSession,
} from "./auth.js";
import { applyEvent, portalUrl, startCheckout, verifySignature } from "./billing.js";
import { bookingConfirmation, bookingCancelled, welcome } from "./mailer.js";
import { LANGUAGES, translateDocument } from "./ai.js";
import { translateShortText } from "./ai-text.js";
import { LOCALES, dictionary, normalizeLocale } from "./i18n.js";
import {
  clientIp,
  forgetRateLimit,
  rateLimit,
  sameOrigin,
  securityHeaders,
  startRateLimitCleanup,
} from "./security.js";

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".ico": "image/x-icon",
};

const COMPRESSIBLE = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".xml", ".webmanifest"]);

const ALLOWED_MEDIA = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
  "",
]);

/* ---------- Réponses ---------- */

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readBody(req, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > config.limits.bodyBytes) {
        reject(Object.assign(new Error("Fichier trop volumineux (9 Mo maximum)."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (raw) return resolve(text);
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error("Corps de requête JSON invalide."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/* ---------- Fichiers statiques : ETag, compression, cache ---------- */

const etags = new Map();

async function etagFor(file) {
  const stat = await fsp.stat(file);
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  if (!etags.has(key)) {
    const hash = crypto.hash("sha1", await fsp.readFile(file), "base64url").slice(0, 20);
    etags.set(key, `"${hash}"`);
  }
  return etags.get(key);
}

function cacheControl(ext) {
  if (ext === ".woff2") return "public, max-age=31536000, immutable";
  if (ext === ".html") return "no-cache";
  return "public, max-age=3600";
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  let target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, "index.html")) {
    return json(res, 403, { error: "Accès refusé." });
  }
  // Les pages sont adressables sans extension : /confidentialite → confidentialite.html
  if (!path.extname(target) && fs.existsSync(`${target}.html`)) target += ".html";

  let stat;
  try {
    stat = await fsp.stat(target);
    if (stat.isDirectory()) throw new Error("répertoire");
  } catch {
    return notFound(req, res);
  }

  const ext = path.extname(target);
  const etag = await etagFor(target);
  const headers = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": cacheControl(ext),
    etag,
    "last-modified": stat.mtime.toUTCString(),
    ...securityHeaders(),
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const body = await fsp.readFile(target);
  const accepts = String(req.headers["accept-encoding"] ?? "");
  if (COMPRESSIBLE.has(ext) && body.length > 1024 && /\bgzip\b/.test(accepts)) {
    const gzipped = zlib.gzipSync(body, { level: 6 });
    res.writeHead(200, { ...headers, "content-encoding": "gzip", "content-length": gzipped.length, vary: "Accept-Encoding" });
    return res.end(req.method === "HEAD" ? undefined : gzipped);
  }
  res.writeHead(200, { ...headers, "content-length": body.length });
  return res.end(req.method === "HEAD" ? undefined : body);
}

async function notFound(req, res) {
  const page = path.join(PUBLIC_DIR, "404.html");
  if (fs.existsSync(page)) {
    const body = await fsp.readFile(page);
    res.writeHead(404, { "content-type": MIME[".html"], "content-length": body.length, ...securityHeaders() });
    return res.end(body);
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...securityHeaders() });
  return res.end("Page introuvable");
}

/* ---------- Gardes ---------- */

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw Object.assign(new Error("Connexion requise."), { status: 401 });
  return user;
}

function requireMember(req) {
  const user = requireUser(req);
  if (user.tier !== "member") throw Object.assign(new Error("Formule Membre requise."), { status: 403 });
  return user;
}

/** L'historique n'existe que si la conservation des documents est activée. */
function requireHistory(req) {
  if (!config.features.history) {
    throw Object.assign(new Error("La conservation des documents est désactivée sur ce service."), {
      status: 404,
    });
  }
  return requireMember(req);
}

function guard(name, req) {
  const verdict = rateLimit(name, req);
  if (!verdict.allowed) {
    throw Object.assign(new Error("Trop de tentatives. Réessayez plus tard."), {
      status: 429,
      retryAfter: verdict.retryAfter,
    });
  }
}

/* ---------- Routes ---------- */

async function handleSignup(req, res) {
  guard("auth", req);
  const body = await readBody(req);
  const user = createUser(body);
  const token = startSession(user.id);
  forgetRateLimit("auth", req);
  await welcome(user);
  log.info("compte créé", { userId: user.id });
  return json(res, 201, { user: publicUser(user) }, { "set-cookie": sessionCookie(token) });
}

async function handleLogin(req, res) {
  guard("auth", req);
  const body = await readBody(req);
  const user = authenticate(body);
  // Rotation : une session neuve à chaque connexion réussie.
  const token = startSession(user.id);
  // Le quota ne doit pénaliser que les échecs.
  forgetRateLimit("auth", req);
  return json(res, 200, { user: publicUser(user) }, { "set-cookie": sessionCookie(token) });
}

function handleLogout(req, res) {
  endSession(sessionToken(req));
  return json(res, 200, { ok: true }, { "set-cookie": sessionCookie(null, { clear: true }) });
}

async function handleTranslate(req, res) {
  guard("translate", req);
  const body = await readBody(req);
  const user = currentUser(req);
  // Le palier vient de la session, jamais du client.
  const tier = user?.tier === "member" ? "member" : "free";
  const target = Object.hasOwn(LANGUAGES, body.target) ? body.target : "zh";
  const fileName = String(body.fileName ?? "document").slice(0, 200);
  const mediaType = String(body.mediaType ?? "");
  const text = typeof body.text === "string" && body.text.trim() ? body.text.slice(0, 200_000) : null;

  if (!text && !body.dataBase64) return json(res, 400, { error: "Aucun document reçu." });
  if (!text && !ALLOWED_MEDIA.has(mediaType)) {
    return json(res, 415, {
      error: `Format non pris en charge (${mediaType}). Formats acceptés : PDF, PNG, JPEG, WebP, texte.`,
    });
  }
  if (body.dataBase64 && !/^[A-Za-z0-9+/=\s]*$/.test(String(body.dataBase64).slice(0, 200))) {
    return json(res, 400, { error: "Contenu du fichier illisible." });
  }

  const started = Date.now();
  const result = await translateDocument({ tier, target, fileName, mediaType, dataBase64: body.dataBase64, text });
  log.info("document traduit", { tier, target, ms: Date.now() - started, mode: result.mode });

  const keep = config.features.history && tier === "member" && body.save === true;
  const saved = keep ? history.save(user.id, result) : null;
  return json(res, 200, { ...result, historyId: saved?.id ?? null });
}

async function handleCheckout(req, res) {
  const user = requireUser(req);
  if (user.tier === "member") return json(res, 409, { error: "Votre formule Membre est déjà active." });
  const result = await startCheckout(user);
  return json(res, 200, result.mode === "stub" ? { mode: "stub", user: publicUser(result.user) } : { url: result.url });
}

async function handlePortal(req, res) {
  const user = requireUser(req);
  const result = await portalUrl(user);
  return json(res, 200, result.mode === "stub" ? { mode: "stub", user: publicUser(result.user) } : { url: result.url });
}

async function handleBillingWebhook(req, res) {
  const raw = await readBody(req, { raw: true });
  if (config.billing.provider !== "stripe") return json(res, 503, { error: "Facturation non configurée." });
  if (!verifySignature(raw, req.headers["stripe-signature"])) {
    log.warn("signature de webhook invalide", { ip: clientIp(req) });
    return json(res, 400, { error: "Signature invalide." });
  }
  const event = JSON.parse(raw);
  const outcome = await applyEvent(event);
  return json(res, 200, { received: true, ...outcome });
}


/* ---------- Gardes de la plateforme ---------- */

/** Établissement rattaché au compte, ou 403 si le compte n'en a pas. */
function requireMerchant(req) {
  const user = requireUser(req);
  const merchant = merchants.byOwner(user.id);
  if (!merchant) {
    throw Object.assign(new Error("Aucun établissement rattaché à ce compte."), { status: 403 });
  }
  return { user, merchant };
}

/** Langue de lecture : celle demandée, sinon celle du compte, sinon le français. */
function readerLocale(req, user) {
  const asked = new URL(req.url, config.publicUrl).searchParams.get("lang");
  if (Object.hasOwn(LOCALES, asked)) return asked;
  return normalizeLocale(user?.locale);
}

/**
 * Traduit un texte court en le mettant en cache : une consigne ou un message
 * déjà traduit dans une langue n'est jamais repayé.
 */
async function cachedTranslation(kind, subjectId, text, target) {
  if (!text?.trim()) return null;
  const cached = translations.get(kind, subjectId, target);
  if (cached) return cached;
  const result = await translateShortText({ text, target });
  return translations.put(kind, subjectId, target, result);
}

/* ---------- Catalogue public ---------- */

function handleCatalog(req, res) {
  const url = new URL(req.url, config.publicUrl);
  const catalog = merchants.catalog({
    city: url.searchParams.get("ville") ?? undefined,
    category: url.searchParams.get("categorie") ?? undefined,
  });
  return json(res, 200, { categories: CATEGORIES, cities: merchants.cities(), merchants: catalog });
}

function handleMerchantDetail(req, res, merchantId) {
  const merchant = merchants.byId(merchantId);
  if (!merchant || merchant.status !== "active") return json(res, 404, { error: "Établissement introuvable." });
  const url = new URL(req.url, config.publicUrl);
  const serviceId = url.searchParams.get("prestation");
  return json(res, 200, {
    merchant,
    services: services.forMerchant(merchant.id, { onlyActive: true }),
    slots: slots.available(merchant.id, { serviceId: serviceId || null }),
  });
}

/* ---------- Inscription des commerçants ---------- */

async function handleMerchantCreate(req, res) {
  const user = requireUser(req);
  const body = await readBody(req);
  const merchant = merchants.create(user.id, {
    ...merchants.validate(body),
    // En l'absence de modération humaine, l'inscription est immédiate ou en
    // attente selon la configuration de la plateforme.
    status: config.features.merchantAutoApprove ? "active" : "pending",
  });
  log.info("établissement créé", { merchantId: merchant.id, status: merchant.status });
  return json(res, 201, { merchant });
}

async function handleMerchantUpdate(req, res) {
  const { merchant } = requireMerchant(req);
  const body = await readBody(req);
  const updated = merchants.update(merchant.id, merchants.validate(body));
  translations.invalidate("merchant", merchant.id);
  return json(res, 200, { merchant: updated });
}

/* ---------- Prestations ---------- */

async function handleServiceCreate(req, res) {
  const { merchant } = requireMerchant(req);
  const body = await readBody(req);
  return json(res, 201, { service: services.create(merchant.id, services.validate(body)) });
}

async function handleServiceUpdate(req, res, serviceId) {
  const { merchant } = requireMerchant(req);
  const service = services.byId(serviceId);
  if (!service || service.merchantId !== merchant.id) return json(res, 404, { error: "Prestation introuvable." });
  const body = await readBody(req);
  return json(res, 200, { service: services.update(serviceId, services.validate(body)) });
}

function handleServiceDelete(req, res, serviceId) {
  const { merchant } = requireMerchant(req);
  if (!services.remove(merchant.id, serviceId)) return json(res, 404, { error: "Prestation introuvable." });
  return json(res, 200, { ok: true });
}

/* ---------- Créneaux ---------- */

async function handleSlotsOpen(req, res) {
  const { merchant } = requireMerchant(req);
  const body = await readBody(req);
  const list = Array.isArray(body.startsAt) ? body.startsAt : [];
  const valid = list
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()) && date.getTime() > Date.now())
    .slice(0, 200)
    .map((date) => date.toISOString());
  if (!valid.length) return json(res, 400, { error: "Aucun créneau valide à venir." });
  const serviceId = body.serviceId ? String(body.serviceId) : null;
  if (serviceId) {
    const service = services.byId(serviceId);
    if (!service || service.merchantId !== merchant.id) return json(res, 400, { error: "Prestation inconnue." });
  }
  const created = slots.open(merchant.id, valid, serviceId);
  return json(res, 201, { created, slots: slots.forMerchant(merchant.id) });
}

function handleSlotDelete(req, res, slotId) {
  const { merchant } = requireMerchant(req);
  if (!slots.remove(merchant.id, slotId)) return json(res, 404, { error: "Créneau introuvable." });
  return json(res, 200, { ok: true });
}

/* ---------- Réservations ---------- */

async function handleBookingCreate(req, res) {
  const user = requireUser(req);
  guard("booking", req);
  const body = await readBody(req);
  const booking = bookings.create({
    slotId: String(body.slotId ?? ""),
    serviceId: String(body.serviceId ?? ""),
    customerId: user.id,
    note: String(body.note ?? "").slice(0, 1000),
    noteLang: normalizeLocale(body.noteLang ?? user.locale),
  });
  const detailed = bookings.forCustomer(user.id).find((row) => row.id === booking.id);
  await bookingConfirmation(detailed, user);
  log.info("réservation créée", { reference: booking.reference, merchantId: booking.merchantId });
  return json(res, 201, { booking: detailed });
}

function handleMyBookings(req, res) {
  const user = requireUser(req);
  return json(res, 200, { bookings: bookings.forCustomer(user.id) });
}

async function handleBookingCancel(req, res, bookingId) {
  const user = requireUser(req);
  const merchant = merchants.byOwner(user.id);
  const cancelled = bookings.cancel(bookingId, { userId: user.id, merchantId: merchant?.id });
  const detailed = bookings.forCustomer(cancelled.customerId).find((row) => row.id === cancelled.id);
  await bookingCancelled(detailed);
  log.info("réservation annulée", { reference: cancelled.reference, by: cancelled.cancelledBy });
  return json(res, 200, { booking: detailed });
}

/**
 * Réservations reçues par le commerçant. La consigne laissée par le client est
 * traduite dans la langue du back-office : le commerçant lit du français même
 * si le client a écrit en chinois.
 */
async function handleMerchantBookings(req, res) {
  const { user, merchant } = requireMerchant(req);
  const target = readerLocale(req, user);
  const rows = bookings.forMerchant(merchant.id);
  const out = [];
  for (const booking of rows) {
    let noteTranslation = null;
    if (booking.note && booking.noteLang !== target) {
      guard("translate", req);
      noteTranslation = (await cachedTranslation("note", booking.id, booking.note, target))?.translation ?? null;
    }
    out.push({ ...booking, noteTranslation });
  }
  return json(res, 200, { bookings: out, target });
}

/* ---------- Messages d'une réservation ---------- */

async function handleBookingMessages(req, res, bookingId) {
  const user = requireUser(req);
  const merchant = merchants.byOwner(user.id);
  const access = bookings.access(bookingId, user, merchant);
  if (!access) return json(res, 404, { error: "Réservation introuvable." });
  const target = readerLocale(req, user);

  const out = [];
  for (const message of bookingMessages.list(bookingId)) {
    const mine = message.senderId === user.id;
    let translation = null;
    if (!mine) {
      const cache = translations.get("message", message.id, target);
      if (cache) {
        translation = cache.translation;
      } else {
        guard("translate", req);
        translation = (await cachedTranslation("message", message.id, message.body, target))?.translation ?? null;
      }
    }
    out.push({
      id: message.id,
      mine,
      senderRole: message.senderRole,
      body: message.body,
      translation,
      createdAt: message.createdAt,
    });
  }
  bookingMessages.markRead(bookingId, user.id);
  return json(res, 200, { messages: out, target, role: access.role });
}

async function handleBookingMessageSend(req, res, bookingId) {
  const user = requireUser(req);
  const merchant = merchants.byOwner(user.id);
  const access = bookings.access(bookingId, user, merchant);
  if (!access) return json(res, 404, { error: "Réservation introuvable." });
  const body = await readBody(req);
  const text = String(body.body ?? "").trim();
  if (!text) return json(res, 400, { error: "Message vide." });
  if (text.length > 2000) return json(res, 413, { error: "Message trop long (2000 caractères maximum)." });
  guard("message", req);
  const message = bookingMessages.create(bookingId, user.id, access.role, text);
  return json(res, 201, { id: message.id, createdAt: message.created_at });
}

/* ---------- Serveur ---------- */

export function createApp() {
  migrate();
  startRateLimitCleanup();

  return http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = "/";
    try {
      ({ pathname } = new URL(req.url, config.publicUrl));

      // Le webhook de facturation est signé : ni CSRF ni limitation de débit.
      if (req.method === "POST" && pathname === "/api/billing/webhook") {
        return await handleBillingWebhook(req, res);
      }

      guard("global", req);

      if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
        return json(res, 403, { error: "Origine non autorisée." });
      }

      if (req.method === "GET" && pathname === "/healthz") {
        return json(res, 200, {
          status: "ok",
          uptime: Math.round(process.uptime()),
          version: process.env.APP_VERSION ?? "dev",
          ai: config.ai.configured ? "live" : "demo",
          billing: config.billing.provider,
          retention: config.features.history ? "historique actif" : "sans rétention",
        });
      }

      if (req.method === "GET" && pathname === "/api/config") {
        const user = currentUser(req);
        // Un visiteur sans compte peut demander une langue le temps de sa visite.
        const locale = readerLocale(req, user);
        return json(res, 200, {
          aiMode: config.ai.configured ? "live" : "demo",
          billingMode: config.billing.provider,
          languages: LANGUAGES,
          historyEnabled: config.features.history,
          user: publicUser(user),
          locale,
          locales: LOCALES,
          dictionary: dictionary(locale),
          categories: CATEGORIES,
          merchant: user ? merchants.byOwner(user.id) : null,
        });
      }

      if (req.method === "POST" && pathname === "/api/auth/signup") return await handleSignup(req, res);
      if (req.method === "POST" && pathname === "/api/auth/login") return await handleLogin(req, res);
      if (req.method === "POST" && pathname === "/api/auth/logout") return handleLogout(req, res);
      if (req.method === "GET" && pathname === "/api/auth/me") {
        return json(res, 200, { user: publicUser(currentUser(req)) });
      }

      if (req.method === "POST" && pathname === "/api/billing/checkout") return await handleCheckout(req, res);
      if (req.method === "POST" && pathname === "/api/billing/portal") return await handlePortal(req, res);

      if (req.method === "GET" && pathname === "/api/history") {
        return json(res, 200, history.forUser(requireHistory(req).id));
      }
      if (req.method === "DELETE" && pathname.startsWith("/api/history/")) {
        const user = requireHistory(req);
        const id = pathname.slice("/api/history/".length);
        if (!history.remove(user.id, id)) return json(res, 404, { error: "Document introuvable." });
        return json(res, 200, { ok: true });
      }

      // Catalogue et fiches, accessibles sans compte.
      if (req.method === "GET" && pathname === "/api/catalog") return handleCatalog(req, res);
      const merchantDetail = pathname.match(/^\/api\/merchants\/([\w-]+)$/);
      if (req.method === "GET" && merchantDetail) return handleMerchantDetail(req, res, merchantDetail[1]);

      // Espace professionnel.
      if (req.method === "POST" && pathname === "/api/merchants") return await handleMerchantCreate(req, res);
      if (req.method === "GET" && pathname === "/api/merchant/me") {
        const { merchant } = requireMerchant(req);
        return json(res, 200, {
          merchant,
          services: services.forMerchant(merchant.id),
          slots: slots.forMerchant(merchant.id),
        });
      }
      if (req.method === "PUT" && pathname === "/api/merchant/me") return await handleMerchantUpdate(req, res);
      if (req.method === "GET" && pathname === "/api/merchant/bookings") return await handleMerchantBookings(req, res);
      if (req.method === "POST" && pathname === "/api/merchant/services") return await handleServiceCreate(req, res);
      const serviceRoute = pathname.match(/^\/api\/merchant\/services\/([\w-]+)$/);
      if (serviceRoute) {
        if (req.method === "PUT") return await handleServiceUpdate(req, res, serviceRoute[1]);
        if (req.method === "DELETE") return handleServiceDelete(req, res, serviceRoute[1]);
      }
      if (req.method === "POST" && pathname === "/api/merchant/slots") return await handleSlotsOpen(req, res);
      const slotRoute = pathname.match(/^\/api\/merchant\/slots\/([\w-]+)$/);
      if (req.method === "DELETE" && slotRoute) return handleSlotDelete(req, res, slotRoute[1]);

      // Réservations et messages.
      if (req.method === "POST" && pathname === "/api/bookings") return await handleBookingCreate(req, res);
      if (req.method === "GET" && pathname === "/api/bookings") return handleMyBookings(req, res);
      const cancelRoute = pathname.match(/^\/api\/bookings\/([\w-]+)\/cancel$/);
      if (req.method === "POST" && cancelRoute) return await handleBookingCancel(req, res, cancelRoute[1]);
      const messageRoute = pathname.match(/^\/api\/bookings\/([\w-]+)\/messages$/);
      if (messageRoute) {
        if (req.method === "GET") return await handleBookingMessages(req, res, messageRoute[1]);
        if (req.method === "POST") return await handleBookingMessageSend(req, res, messageRoute[1]);
      }

      // Langue de l'interface.
      if (req.method === "PUT" && pathname === "/api/locale") {
        const user = requireUser(req);
        const body = await readBody(req);
        const locale = normalizeLocale(body.locale);
        users.setLocale(user.id, locale);
        return json(res, 200, { locale, dictionary: dictionary(locale) });
      }

      if (req.method === "POST" && pathname === "/api/translate") return await handleTranslate(req, res);

      if (pathname.startsWith("/api/")) return json(res, 404, { error: "Route inconnue." });
      if (req.method === "GET" || req.method === "HEAD") return await serveStatic(req, res, pathname);
      return json(res, 405, { error: "Méthode non autorisée." });
    } catch (error) {
      const status = error.status ?? error.statusCode ?? 500;
      if (status >= 500) log.error("requête en échec", { pathname, error: error.message, stack: error.stack });
      else log.warn("requête refusée", { pathname, status, error: error.message });
      const headers = error.retryAfter ? { "retry-after": String(error.retryAfter) } : {};
      // Aucune fuite de détail interne au client.
      return json(
        res,
        status,
        { error: status >= 500 ? "Erreur interne. L'incident est journalisé." : error.message },
        headers,
      );
    } finally {
      if (!pathname.startsWith("/fonts/")) {
        log.info("requête", { method: req.method, pathname, status: res.statusCode, ms: Date.now() - started });
      }
    }
  });
}

/** Nettoyage périodique des sessions expirées. */
export function startHousekeeping() {
  const timer = setInterval(() => {
    const removed = sessions.prune();
    if (removed) log.info("sessions expirées purgées", { removed });
  }, 6 * 3_600_000);
  timer.unref();
  return timer;
}

export { users };
