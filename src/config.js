/**
 * Configuration lue une fois au démarrage. Toute variable absente a un repli
 * explicite, et le démarrage échoue plutôt que de servir une configuration
 * dangereuse en production.
 */
const env = process.env;

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export const config = {
  env: env.NODE_ENV ?? "development",
  get isProduction() {
    return this.env === "production";
  },
  port: Number(env.PORT ?? 3000),
  host: env.HOST ?? "0.0.0.0",
  /** Origine publique, utilisée pour les liens, la vérification CSRF et Stripe. */
  publicUrl: (env.PUBLIC_URL ?? `http://localhost:${Number(env.PORT ?? 3000)}`).replace(/\/$/, ""),
  trustProxy: bool(env.TRUST_PROXY, false),
  databaseFile: env.DATABASE_FILE ?? "data/drdu.sqlite",

  ai: {
    configured: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    model: env.CLAUDE_MODEL ?? "claude-opus-5",
  },

  mail: {
    /** "log" écrit dans la sortie standard, "webhook" relaie vers MAIL_WEBHOOK_URL. */
    transport: env.MAIL_TRANSPORT ?? (env.MAIL_WEBHOOK_URL ? "webhook" : "log"),
    webhookUrl: env.MAIL_WEBHOOK_URL ?? null,
    from: env.MAIL_FROM ?? "D.R DU <ne-pas-repondre@drdu.example>",
    replyTo: env.MAIL_REPLY_TO ?? "accueil@drdu.example",
  },

  billing: {
    /** Sans clé Stripe, l'abonnement passe en mode simulé (utile en recette). */
    provider: env.STRIPE_SECRET_KEY ? "stripe" : "stub",
    secretKey: env.STRIPE_SECRET_KEY ?? null,
    priceId: env.STRIPE_PRICE_ID ?? null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    portalReturnPath: "/#offres",
  },

  limits: {
    /** 12 Mo de corps JSON, soit environ 9 Mo de fichier après base64. */
    bodyBytes: Number(env.MAX_BODY_BYTES ?? 12 * 1024 * 1024),
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    historyPerUser: Number(env.HISTORY_PER_USER ?? 50),
  },

  /** Fenêtres de limitation de débit, par adresse IP. */
  rateLimits: {
    auth: { windowMs: 15 * 60_000, max: 10 },
    translate: { windowMs: 60 * 60_000, max: 30 },
    booking: { windowMs: 60 * 60_000, max: 10 },
    global: { windowMs: 60_000, max: 300 },
  },

  clinic: {
    name: "D.R DU",
    address: "12 place de la République, 75011 Paris",
    phone: "+33 1 84 00 12 12",
    email: "accueil@drdu.example",
    siret: env.CLINIC_SIRET ?? "000 000 000 00000",
    publisher: env.CLINIC_PUBLISHER ?? "Société D.R DU SAS",
    host: env.CLINIC_HOST ?? "Hébergeur certifié HDS (à préciser)",
    dpo: env.CLINIC_DPO ?? "dpo@drdu.example",
  },
};

/** Vérifications qui doivent faire échouer le démarrage en production. */
export function assertProductionReady() {
  if (!config.isProduction) return [];
  const fatal = [];
  const warn = [];
  if (!config.publicUrl.startsWith("https://")) fatal.push("PUBLIC_URL doit être en HTTPS.");
  if (!config.ai.configured) fatal.push("ANTHROPIC_API_KEY manquante : le studio ne traduirait rien.");
  if (config.billing.provider === "stub") {
    fatal.push("STRIPE_SECRET_KEY manquante : l'abonnement serait accordé sans paiement.");
  } else {
    if (!config.billing.priceId) fatal.push("STRIPE_PRICE_ID manquant.");
    if (!config.billing.webhookSecret) fatal.push("STRIPE_WEBHOOK_SECRET manquant.");
  }
  if (config.mail.transport === "log") warn.push("MAIL_TRANSPORT=log : aucun courriel ne partira réellement.");
  if (fatal.length) {
    throw new Error(`Configuration de production incomplète :\n  - ${fatal.join("\n  - ")}`);
  }
  return warn;
}
