import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTORS } from "./doctors.js";
import {
  bookedSlots,
  createAppointment,
  deleteHistory,
  listAppointments,
  listHistory,
  saveHistory,
} from "./store.js";
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
import { LANGUAGES, aiConfigured, translateDocument } from "./ai.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

/** 12 Mo de charge utile : ~9 Mo de fichier après encodage base64. */
const MAX_BODY = 12 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const ALLOWED_MEDIA = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "text/plain",
  "text/markdown",
  "",
]);

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Fichier trop volumineux (9 Mo maximum)."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Corps de requête JSON invalide."), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Interdit");
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Page introuvable");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" });
    res.end(data);
  });
}

/** Praticiens avec les créneaux déjà réservés retirés. */
function doctorsWithAvailability() {
  return DOCTORS.map((doctor) => {
    const taken = bookedSlots(doctor.id);
    return { ...doctor, slots: doctor.slots.filter((slot) => !taken.has(slot)) };
  });
}

function requireMember(req) {
  const user = currentUser(req);
  if (!user) throw Object.assign(new Error("Connexion requise."), { status: 401 });
  if (user.tier !== "member") throw Object.assign(new Error("Formule Membre requise."), { status: 403 });
  return user;
}

/* ---------- Comptes ---------- */

async function handleSignup(req, res) {
  const body = await readBody(req);
  const user = createUser(body);
  const token = startSession(user.id);
  return json(res, 201, { user: publicUser(user) }, { "set-cookie": sessionCookie(token) });
}

async function handleLogin(req, res) {
  const body = await readBody(req);
  const user = authenticate(body);
  const token = startSession(user.id);
  return json(res, 200, { user: publicUser(user) }, { "set-cookie": sessionCookie(token) });
}

function handleLogout(req, res) {
  endSession(sessionToken(req));
  return json(res, 200, { ok: true }, { "set-cookie": sessionCookie(null, { clear: true }) });
}

/* ---------- Traduction ---------- */

async function handleTranslate(req, res) {
  const body = await readBody(req);
  const user = currentUser(req);
  // Le palier vient de la session, jamais du client : un utilisateur anonyme
  // ne peut pas obtenir la notice en modifiant la requête.
  const tier = user?.tier === "member" ? "member" : "free";
  const target = Object.hasOwn(LANGUAGES, body.target) ? body.target : "zh";
  const fileName = String(body.fileName ?? "document").slice(0, 200);
  const mediaType = String(body.mediaType ?? "");
  const text = typeof body.text === "string" && body.text.trim() ? body.text.slice(0, 200000) : null;

  if (!text && !body.dataBase64) {
    return json(res, 400, { error: "Aucun document reçu." });
  }
  if (!text && !ALLOWED_MEDIA.has(mediaType)) {
    return json(res, 415, {
      error: `Format non pris en charge (${mediaType}). Formats acceptés : PDF, PNG, JPEG, WebP, texte.`,
    });
  }

  const result = await translateDocument({
    tier,
    target,
    fileName,
    mediaType,
    dataBase64: body.dataBase64,
    text,
  });

  // Historique : uniquement pour les membres, et uniquement s'ils le demandent.
  let saved = null;
  if (tier === "member" && body.save !== false) {
    saved = saveHistory(user.id, result);
  }
  return json(res, 200, { ...result, historyId: saved?.id ?? null });
}

/* ---------- Rendez-vous ---------- */

async function handleAppointment(req, res) {
  const body = await readBody(req);
  const user = currentUser(req);
  const doctor = DOCTORS.find((d) => d.id === body.doctorId);
  const required = ["patientName", "email", "slot"];
  const missing = required.filter((field) => !String(body[field] ?? "").trim());
  if (!doctor) return json(res, 400, { error: "Praticien inconnu." });
  if (missing.length) return json(res, 400, { error: `Champs manquants : ${missing.join(", ")}.` });
  if (!doctor.slots.includes(body.slot) || bookedSlots(doctor.id).has(body.slot)) {
    return json(res, 409, { error: "Créneau plus disponible." });
  }

  const appointment = createAppointment({
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
  return json(res, 201, appointment);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");

    if (req.method === "GET" && pathname === "/api/config") {
      const user = currentUser(req);
      return json(res, 200, {
        aiMode: aiConfigured() ? "live" : "demo",
        languages: LANGUAGES,
        doctors: doctorsWithAvailability(),
        user: user ? publicUser(user) : null,
      });
    }

    if (req.method === "POST" && pathname === "/api/auth/signup") return await handleSignup(req, res);
    if (req.method === "POST" && pathname === "/api/auth/login") return await handleLogin(req, res);
    if (req.method === "POST" && pathname === "/api/auth/logout") return handleLogout(req, res);
    if (req.method === "GET" && pathname === "/api/auth/me") {
      const user = currentUser(req);
      return json(res, 200, { user: user ? publicUser(user) : null });
    }

    if (req.method === "GET" && pathname === "/api/history") {
      const user = requireMember(req);
      return json(res, 200, listHistory(user.id));
    }
    if (req.method === "DELETE" && pathname.startsWith("/api/history/")) {
      const user = requireMember(req);
      const id = pathname.slice("/api/history/".length);
      if (!deleteHistory(user.id, id)) return json(res, 404, { error: "Document introuvable." });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/appointments") {
      const user = currentUser(req);
      if (!user) throw Object.assign(new Error("Connexion requise."), { status: 401 });
      return json(res, 200, listAppointments(user.id));
    }
    if (req.method === "POST" && pathname === "/api/appointments") {
      return await handleAppointment(req, res);
    }
    if (req.method === "POST" && pathname === "/api/translate") {
      return await handleTranslate(req, res);
    }

    if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
    return json(res, 405, { error: "Méthode non autorisée." });
  } catch (error) {
    const status = error.status ?? error.statusCode ?? 500;
    if (status >= 500) console.error("[erreur]", error);
    return json(res, status, { error: error.message ?? "Erreur interne." });
  }
});

server.listen(PORT, () => {
  console.log(`D.R DU — http://localhost:${PORT} (IA : ${aiConfigured() ? "API Claude" : "démo hors ligne"})`);
});
