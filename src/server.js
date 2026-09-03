import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DOCTORS } from "./doctors.js";
import { createAppointment, listAppointments } from "./store.js";
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

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
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

async function handleTranslate(req, res) {
  const body = await readBody(req);
  const tier = body.tier === "member" ? "member" : "free";
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
  return json(res, 200, result);
}

async function handleAppointment(req, res) {
  const body = await readBody(req);
  const doctor = DOCTORS.find((d) => d.id === body.doctorId);
  const required = ["patientName", "email", "slot"];
  const missing = required.filter((field) => !String(body[field] ?? "").trim());
  if (!doctor) return json(res, 400, { error: "Praticien inconnu." });
  if (missing.length) return json(res, 400, { error: `Champs manquants : ${missing.join(", ")}.` });
  if (!doctor.slots.includes(body.slot)) return json(res, 409, { error: "Créneau plus disponible." });

  const appointment = createAppointment({
    doctorId: doctor.id,
    doctorName: doctor.name,
    speciality: doctor.speciality,
    slot: body.slot,
    patientName: String(body.patientName).slice(0, 120),
    email: String(body.email).slice(0, 160),
    phone: String(body.phone ?? "").slice(0, 40),
    reason: String(body.reason ?? "").slice(0, 1000),
    tier: body.tier === "member" ? "member" : "free",
  });
  return json(res, 201, appointment);
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");
    if (req.method === "GET" && pathname === "/api/config") {
      return json(res, 200, {
        aiMode: aiConfigured() ? "live" : "demo",
        languages: LANGUAGES,
        doctors: DOCTORS,
      });
    }
    if (req.method === "GET" && pathname === "/api/appointments") {
      return json(res, 200, listAppointments());
    }
    if (req.method === "POST" && pathname === "/api/appointments") {
      return await handleAppointment(req, res);
    }
    if (req.method === "POST" && pathname === "/api/translate") {
      return await handleTranslate(req, res);
    }
    if (req.method === "GET" || req.method === "HEAD") {
      return serveStatic(req, res);
    }
    return json(res, 405, { error: "Méthode non autorisée." });
  } catch (error) {
    const status = error.status ?? error.statusCode ?? 500;
    console.error("[erreur]", error);
    return json(res, status, { error: error.message ?? "Erreur interne." });
  }
});

server.listen(PORT, () => {
  console.log(`D.R DU — http://localhost:${PORT} (IA : ${aiConfigured() ? "API Claude" : "démo hors ligne"})`);
});
