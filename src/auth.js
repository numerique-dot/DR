import crypto from "node:crypto";
import { insert, readCollection, writeCollection } from "./store.js";

const SESSION_COOKIE = "drdu_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ---------- Mots de passe : scrypt + sel aléatoire ---------- */

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const reference = Buffer.from(expected, "hex");
  if (candidate.length !== reference.length) return false;
  return crypto.timingSafeEqual(candidate, reference);
}

/* ---------- Comptes ---------- */

function normalizeEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

export function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name, tier: user.tier };
}

export function createUser({ email, password, name, tier = "member" }) {
  const normalized = normalizeEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
    throw Object.assign(new Error("Adresse électronique invalide."), { status: 400 });
  }
  if (String(password ?? "").length < 8) {
    throw Object.assign(new Error("Le mot de passe doit compter au moins 8 caractères."), { status: 400 });
  }
  if (readCollection("users").some((user) => user.email === normalized)) {
    throw Object.assign(new Error("Un compte existe déjà pour cette adresse."), { status: 409 });
  }
  return insert("users", {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    email: normalized,
    name: String(name ?? "").trim().slice(0, 120) || normalized.split("@")[0],
    // La formule Membre est ici accordée à l'inscription : il n'y a pas encore
    // de paiement. C'est le seul endroit à brancher sur un prestataire.
    tier: tier === "free" ? "free" : "member",
    password: hashPassword(password),
  });
}

export function authenticate({ email, password }) {
  const user = readCollection("users").find((row) => row.email === normalizeEmail(email));
  if (!user || !verifyPassword(String(password ?? ""), user.password)) {
    throw Object.assign(new Error("Adresse ou mot de passe incorrect."), { status: 401 });
  }
  return user;
}

/* ---------- Sessions ---------- */

function pruneSessions(rows) {
  const now = Date.now();
  return rows.filter((row) => Date.parse(row.expiresAt) > now);
}

export function startSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const rows = pruneSessions(readCollection("sessions"));
  rows.push({
    // Seul le condensé du jeton est stocké : une fuite du fichier ne permet
    // pas de rejouer les sessions.
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  writeCollection("sessions", rows);
  return token;
}

export function endSession(token) {
  if (!token) return;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  writeCollection(
    "sessions",
    pruneSessions(readCollection("sessions")).filter((row) => row.tokenHash !== hash),
  );
}

function parseCookies(header) {
  const jar = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

export function sessionToken(req) {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

/** Utilisateur rattaché à la requête, ou null. */
export function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const session = pruneSessions(readCollection("sessions")).find((row) => row.tokenHash === hash);
  if (!session) return null;
  return readCollection("users").find((user) => user.id === session.userId) ?? null;
}

export function sessionCookie(token, { clear = false } = {}) {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  if (clear) return `${SESSION_COOKIE}=; ${attributes.join("; ")}; Max-Age=0`;
  return `${SESSION_COOKIE}=${token}; ${attributes.join("; ")}; Max-Age=${SESSION_TTL_MS / 1000}`;
}
