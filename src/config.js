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
  /** Fuseau des dates dans les courriels : le serveur, lui, tourne en UTC. */
  timezone: env.TIMEZONE ?? "Europe/Paris",
  databaseFile: env.DATABASE_FILE ?? "data/drdu.sqlite",

  ai: {
    configured: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    model: env.CLAUDE_MODEL ?? "claude-opus-5",
  },

  mail: {
    /** "log" écrit dans la sortie standard, "webhook" relaie vers MAIL_WEBHOOK_URL. */
    transport: env.MAIL_TRANSPORT ?? (env.MAIL_WEBHOOK_URL ? "webhook" : "log"),
    webhookUrl: env.MAIL_WEBHOOK_URL ?? null,
    from: env.MAIL_FROM ?? "D.R RDV <ne-pas-repondre@drdu.example>",
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

  features: {
    /**
     * Conservation des traductions de documents. Désactivée par défaut : les
     * documents déposés dans l'outil peuvent contenir n'importe quoi (contrat,
     * bulletin de paie, courrier médical), et ce que l'on ne garde pas ne peut
     * pas fuiter. À n'activer qu'avec une raison et une politique de purge.
     */
    history: bool(env.HISTORY_ENABLED, false),
    /**
     * Inscription des commerçants publiée immédiatement. Passer à false impose
     * une validation manuelle (statut « pending ») avant l'apparition au catalogue.
     */
    merchantAutoApprove: bool(env.MERCHANT_AUTO_APPROVE, true),
  },

  /**
   * Comptes autorisés à modérer les établissements. Le rôle n'est pas stocké en
   * base : il découle de cette liste, ce qui évite qu'une écriture malencontreuse
   * promeuve quelqu'un, et permet de retirer un modérateur en redémarrant.
   */
  adminEmails: String(env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),

  limits: {
    /** 12 Mo de corps JSON, soit environ 9 Mo de fichier après base64. */
    bodyBytes: Number(env.MAX_BODY_BYTES ?? 12 * 1024 * 1024),
    sessionDays: Number(env.SESSION_DAYS ?? 30),
    historyPerUser: Number(env.HISTORY_PER_USER ?? 50),
    /** Durée de validité d'un lien de réinitialisation de mot de passe. */
    resetMinutes: Number(env.PASSWORD_RESET_MINUTES ?? 60),
  },

  /** Fenêtres de limitation de débit, par adresse IP. */
  rateLimits: {
    auth: { windowMs: 15 * 60_000, max: 10 },
    /** Textes courts (consignes, messages) : nombreux et peu coûteux. */
    translate: { windowMs: 60 * 60_000, max: 400 },
    /** Documents entiers : rares et chers, accessibles sans compte. */
    document: { windowMs: 60 * 60_000, max: 30 },
    message: { windowMs: 60 * 60_000, max: 120 },
    booking: { windowMs: 60 * 60_000, max: 20 },
    /** Demandes de réinitialisation : rare par nature, strict par prudence. */
    reset: { windowMs: 60 * 60_000, max: 5 },
    global: { windowMs: 60_000, max: 300 },
  },

  service: {
    name: "D.R RDV",
    address: "12 place de la République, 75011 Paris",
    phone: "+33 1 84 00 12 12",
    email: "contact@drdu.example",
    siret: env.SERVICE_SIRET ?? "000 000 000 00000",
    publisher: env.SERVICE_PUBLISHER ?? "Société D.R RDV SAS",
    host: env.SERVICE_HOST ?? "Hébergeur (à préciser)",
    /** Médecin donneur d'ordre du service de traduction. */
    mandatingDoctor: env.MANDATING_DOCTOR ?? "Médecin donneur d'ordre (à préciser)",
    dpo: env.SERVICE_DPO ?? "dpo@drdu.example",
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
  if (!config.features.merchantAutoApprove && !config.adminEmails.length) {
    fatal.push(
      "MERCHANT_AUTO_APPROVE=false sans ADMIN_EMAILS : aucune fiche ne pourrait jamais être publiée.",
    );
  }
  if (config.features.history) {
    warn.push(
      "HISTORY_ENABLED=true : les traductions de documents sont conservées. " +
        "Vérifiez que la politique de conservation et l'information des utilisateurs suivent.",
    );
  } else {
    warn.push("Historique désactivé : aucun document ni traduction conservés.");
  }
  if (fatal.length) {
    throw new Error(`Configuration de production incomplète :\n  - ${fatal.join("\n  - ")}`);
  }
  return warn;
}
