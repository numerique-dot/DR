import crypto from "node:crypto";
import { config } from "./config.js";
import { passwordResets, sessions, users } from "./db.js";

const SESSION_COOKIE = "drdu_session";
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ---------- Mots de passe ---------- */

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const candidate = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  const reference = Buffer.from(expected, "hex");
  return candidate.length === reference.length && crypto.timingSafeEqual(candidate, reference);
}

/* ---------- Comptes ---------- */

const normalizeEmail = (email) => String(email ?? "").trim().toLowerCase();
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

/** Un compte est modérateur si son adresse figure dans ADMIN_EMAILS. */
export function isAdmin(user) {
  return Boolean(user) && config.adminEmails.includes(String(user.email).toLowerCase());
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    tier: user.tier,
    role: user.role ?? "customer",
    admin: isAdmin(user),
    locale: user.locale ?? "fr",
    subscriptionStatus: user.subscription_status ?? null,
    currentPeriodEnd: user.current_period_end ?? null,
  };
}

/** Contrôle unique du mot de passe : même règle à l'inscription et au changement. */
function checkPassword(password) {
  const secret = String(password ?? "");
  if (secret.length < 10) {
    throw Object.assign(new Error("Le mot de passe doit compter au moins 10 caractères."), { status: 400 });
  }
  if (secret.length > 256) {
    throw Object.assign(new Error("Mot de passe trop long (256 caractères maximum)."), { status: 400 });
  }
  return secret;
}

export function createUser({ email, password, name }) {
  const normalized = normalizeEmail(email);
  if (!EMAIL.test(normalized)) {
    throw Object.assign(new Error("Adresse électronique invalide."), { status: 400 });
  }
  const secret = checkPassword(password);
  if (users.byEmail(normalized)) {
    throw Object.assign(new Error("Un compte existe déjà pour cette adresse."), { status: 409 });
  }
  // Un compte naît en formule Essentiel : seule la facturation le fait passer membre.
  return users.create({
    email: normalized,
    name: String(name ?? "").trim().slice(0, 120) || normalized.split("@")[0],
    password: hashPassword(secret),
    tier: "free",
  });
}

export function authenticate({ email, password }) {
  const user = users.byEmail(normalizeEmail(email));
  // Comparaison menée même sans compte, pour ne pas révéler l'existence de l'adresse.
  const reference = user?.password ?? hashPassword("mot-de-passe-inexistant");
  const ok = verifyPassword(String(password ?? ""), reference);
  if (!user || !ok) {
    throw Object.assign(new Error("Adresse ou mot de passe incorrect."), { status: 401 });
  }
  return user;
}

/* ---------- Sessions ---------- */

export const startSession = (userId) => sessions.create(userId);
export const endSession = (token) => sessions.destroy(token);
export const currentUser = (req) => sessions.user(sessionToken(req));

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

export function sessionCookie(token, { clear = false } = {}) {
  const attributes = ["Path=/", "HttpOnly", "SameSite=Lax"];
  if (config.isProduction) attributes.push("Secure");
  if (clear) return `${SESSION_COOKIE}=; ${attributes.join("; ")}; Max-Age=0`;
  return `${SESSION_COOKIE}=${token}; ${attributes.join("; ")}; Max-Age=${config.limits.sessionDays * 86_400}`;
}

/* ---------- Réinitialisation de mot de passe ---------- */

/**
 * Ouvre une demande. Renvoie null si l'adresse est inconnue : l'appelant
 * répond la même chose dans tous les cas, pour ne pas révéler qui a un compte.
 */
export function openPasswordReset(email) {
  const user = users.byEmail(normalizeEmail(email));
  if (!user) return null;
  const token = passwordResets.create(user.id, config.limits.resetMinutes);
  return { user, token };
}

/**
 * Consomme le jeton et remplace le mot de passe. Toutes les sessions ouvertes
 * sont fermées : si quelqu'un d'autre était connecté, il ne l'est plus.
 */
export function completePasswordReset(token, password) {
  const secret = checkPassword(password);
  const user = passwordResets.claim(token);
  if (!user) {
    throw Object.assign(new Error("Lien invalide ou expiré. Demandez-en un nouveau."), { status: 400 });
  }
  users.setPassword(user.id, hashPassword(secret));
  sessions.destroyAllFor(user.id);
  return users.byId(user.id);
}
