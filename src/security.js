import { config } from "./config.js";

/**
 * En-têtes de sécurité. La CSP est stricte : aucun script en ligne, aucune
 * connexion sortante depuis le navigateur, aucune inclusion dans une iframe.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export function securityHeaders() {
  const headers = {
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "x-frame-options": "DENY",
  };
  if (config.isProduction) {
    headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

/** Adresse cliente, en tenant compte du proxy seulement si on lui fait confiance. */
export function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "inconnu";
}

/**
 * Limitation de débit à fenêtre glissante, en mémoire. Suffisant pour une
 * instance unique ; derrière plusieurs instances, il faut un magasin partagé.
 */
const buckets = new Map();

export function rateLimit(name, req) {
  const rule = config.rateLimits[name];
  if (!rule) return { allowed: true };
  const key = `${name}:${clientIp(req)}`;
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((time) => now - time < rule.windowMs);
  if (hits.length >= rule.max) {
    buckets.set(key, hits);
    return { allowed: false, retryAfter: Math.ceil((rule.windowMs - (now - hits[0])) / 1000) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true };
}

/** Purge périodique des compteurs pour éviter une fuite de mémoire. */
export function startRateLimitCleanup() {
  const widest = Math.max(...Object.values(config.rateLimits).map((r) => r.windowMs));
  const timer = setInterval(() => {
    const cutoff = Date.now() - widest;
    for (const [key, hits] of buckets) {
      const kept = hits.filter((time) => time > cutoff);
      if (kept.length) buckets.set(key, kept);
      else buckets.delete(key);
    }
  }, 60_000);
  timer.unref();
  return timer;
}

export function resetRateLimits() {
  buckets.clear();
}

/**
 * Oublie les tentatives comptées pour cette règle et cette adresse. Appelé
 * après une authentification réussie : c'est l'échec répété qui doit être
 * freiné, pas l'usage normal — plusieurs personnes peuvent partager une même
 * adresse IP (bureau, réseau mobile) et n'ont pas à se pénaliser entre elles.
 */
export function forgetRateLimit(name, req) {
  buckets.delete(`${name}:${clientIp(req)}`);
}

/**
 * Protection CSRF : le cookie de session est en SameSite=Lax, ce qui bloque
 * déjà les envois croisés, mais on vérifie l'origine des requêtes mutantes
 * pour couvrir les navigateurs anciens et les clients exotiques.
 */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, applications natives : pas de contexte navigateur.
  try {
    const sent = new URL(origin);
    const expected = new URL(config.publicUrl);
    if (sent.origin === expected.origin) return true;
    // En développement, on tolère localhost quel que soit le port.
    if (!config.isProduction && ["localhost", "127.0.0.1"].includes(sent.hostname)) return true;
    return false;
  } catch {
    return false;
  }
}
