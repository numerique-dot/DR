import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { log } from "./logger.js";
import { DOCTORS } from "./doctors.js";
import { appointments, history, migrate, sessions, users } from "./db.js";
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
import { appointmentConfirmation, welcome } from "./mailer.js";
import { LANGUAGES, translateDocument } from "./ai.js";
import { clientIp, rateLimit, sameOrigin, securityHeaders, startRateLimitCleanup } from "./security.js";

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

/* ---------- Praticiens ---------- */

function doctorsWithAvailability() {
  const taken = new Set(appointments.allBooked().map((row) => `${row.doctor_id}|${row.slot}`));
  return DOCTORS.map((doctor) => ({
    ...doctor,
    slots: doctor.slots.filter((slot) => !taken.has(`${doctor.id}|${slot}`)),
  }));
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

  const saved = tier === "member" && body.save !== false ? history.save(user.id, result) : null;
  return json(res, 200, { ...result, historyId: saved?.id ?? null });
}

async function handleAppointment(req, res) {
  guard("booking", req);
  const body = await readBody(req);
  const user = currentUser(req);
  const doctor = DOCTORS.find((d) => d.id === body.doctorId);
  const missing = ["patientName", "email", "slot"].filter((field) => !String(body[field] ?? "").trim());
  if (!doctor) return json(res, 400, { error: "Praticien inconnu." });
  if (missing.length) return json(res, 400, { error: `Champs manquants : ${missing.join(", ")}.` });
  if (!doctor.slots.includes(body.slot)) return json(res, 409, { error: "Créneau plus disponible." });

  const appointment = appointments.create({
    userId: user?.id ?? null,
    doctorId: doctor.id,
    doctorName: doctor.name,
    speciality: doctor.speciality,
    slot: body.slot,
    patientName: String(body.patientName).slice(0, 120),
    email: String(body.email).slice(0, 160),
    phone: String(body.phone ?? "").slice(0, 40),
    reason: String(body.reason ?? "").slice(0, 1000),
    tier: user?.tier === "member" ? "member" : "free",
  });
  await appointmentConfirmation(appointment);
  log.info("rendez-vous créé", { reference: appointment.reference, doctorId: doctor.id });
  return json(res, 201, {
    id: appointment.id,
    reference: appointment.reference,
    doctorName: appointment.doctor_name,
    slot: appointment.slot,
    email: appointment.email,
  });
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
        });
      }

      if (req.method === "GET" && pathname === "/api/config") {
        const user = currentUser(req);
        return json(res, 200, {
          aiMode: config.ai.configured ? "live" : "demo",
          billingMode: config.billing.provider,
          languages: LANGUAGES,
          doctors: doctorsWithAvailability(),
          user: publicUser(user),
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
        return json(res, 200, history.forUser(requireMember(req).id));
      }
      if (req.method === "DELETE" && pathname.startsWith("/api/history/")) {
        const user = requireMember(req);
        const id = pathname.slice("/api/history/".length);
        if (!history.remove(user.id, id)) return json(res, 404, { error: "Document introuvable." });
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && pathname === "/api/appointments") {
        return json(res, 200, appointments.forUser(requireUser(req).id));
      }
      if (req.method === "POST" && pathname === "/api/appointments") return await handleAppointment(req, res);
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
