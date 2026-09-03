import crypto from "node:crypto";
import { config } from "./config.js";
import { events, users } from "./db.js";
import { log } from "./logger.js";
import { subscriptionActivated, subscriptionEnded } from "./mailer.js";

const API = "https://api.stripe.com/v1";

/* ---------- Appel de l'API Stripe (formulaire encodé, sans dépendance) ---------- */

function encode(params, prefix = "") {
  const search = new URLSearchParams();
  const walk = (value, key) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${key}[${index}]`));
    else if (typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, `${key}[${k}]`);
    else search.append(key, String(value));
  };
  for (const [key, value] of Object.entries(params)) walk(value, prefix ? `${prefix}[${key}]` : key);
  return search;
}

async function stripe(method, endpoint, params) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${config.billing.secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params ? encode(params) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.error?.message ?? "Erreur de facturation."), { status: 502 });
  }
  return data;
}

/* ---------- Souscription ---------- */

/**
 * Ouvre une session de paiement. En mode simulé (aucune clé Stripe), l'abonnement
 * est activé immédiatement — pratique en recette, refusé au démarrage en production.
 */
export async function startCheckout(user) {
  if (config.billing.provider === "stub") {
    const updated = users.setSubscription(user.id, {
      tier: "member",
      status: "active_simulee",
      subscriptionId: `sim_${crypto.randomBytes(6).toString("hex")}`,
      customerId: `sim_cus_${user.id.slice(0, 8)}`,
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    await subscriptionActivated(updated);
    log.warn("abonnement activé en mode simulé", { userId: user.id });
    return { mode: "stub", user: updated };
  }

  let customerId = user.customer_id;
  if (!customerId) {
    const customer = await stripe("POST", "/customers", {
      email: user.email,
      name: user.name,
      metadata: { user_id: user.id },
    });
    customerId = customer.id;
    users.setCustomerId(user.id, customerId);
  }

  const session = await stripe("POST", "/checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: config.billing.priceId, quantity: 1 }],
    success_url: `${config.publicUrl}/?abonnement=confirme`,
    cancel_url: `${config.publicUrl}/?abonnement=annule`,
    locale: "fr",
    subscription_data: { metadata: { user_id: user.id } },
  });
  return { mode: "stripe", url: session.url };
}

/** Espace de gestion de l'abonnement (résiliation, moyen de paiement, factures). */
export async function portalUrl(user) {
  if (config.billing.provider === "stub") {
    const updated = users.setSubscription(user.id, {
      tier: "free",
      status: "resiliee_simulee",
      subscriptionId: null,
      customerId: user.customer_id,
      currentPeriodEnd: null,
    });
    await subscriptionEnded(updated);
    return { mode: "stub", user: updated };
  }
  if (!user.customer_id) throw Object.assign(new Error("Aucun abonnement à gérer."), { status: 400 });
  const session = await stripe("POST", "/billing_portal/sessions", {
    customer: user.customer_id,
    return_url: `${config.publicUrl}${config.billing.portalReturnPath}`,
  });
  return { mode: "stripe", url: session.url };
}

/* ---------- Webhook ---------- */

/** Vérifie la signature Stripe (HMAC SHA-256 de « timestamp.payload »). */
export function verifySignature(rawBody, header, { toleranceSeconds = 300 } = {}) {
  const parts = Object.fromEntries(
    String(header ?? "")
      .split(",")
      .map((part) => part.split("=", 2)),
  );
  const timestamp = Number(parts.t);
  if (!timestamp || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;

  const expected = crypto
    .createHmac("sha256", config.billing.webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ACTIVE = new Set(["active", "trialing"]);

/** Applique un événement Stripe. Idempotent : un même événement rejoué est ignoré. */
export async function applyEvent(event) {
  if (!events.claim(event.id)) {
    log.info("événement de facturation déjà traité", { id: event.id });
    return { ignored: true };
  }

  const object = event.data?.object ?? {};
  const findUser = () => {
    const byRef = object.client_reference_id ?? object.metadata?.user_id;
    if (byRef) return users.byId(byRef);
    const customerId = typeof object.customer === "string" ? object.customer : object.customer?.id;
    return customerId ? users.byCustomerId(customerId) : null;
  };

  switch (event.type) {
    case "checkout.session.completed": {
      const user = findUser();
      if (!user) break;
      const customerId = typeof object.customer === "string" ? object.customer : object.customer?.id;
      const updated = users.setSubscription(user.id, {
        tier: "member",
        status: "active",
        subscriptionId: object.subscription ?? null,
        customerId,
        currentPeriodEnd: null,
      });
      await subscriptionActivated(updated);
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const user = findUser();
      if (!user) break;
      const active = ACTIVE.has(object.status);
      const updated = users.setSubscription(user.id, {
        tier: active ? "member" : "free",
        status: object.status,
        subscriptionId: object.id,
        customerId: typeof object.customer === "string" ? object.customer : null,
        currentPeriodEnd: object.current_period_end
          ? new Date(object.current_period_end * 1000).toISOString()
          : null,
      });
      if (active && user.tier !== "member") await subscriptionActivated(updated);
      if (!active && user.tier === "member") await subscriptionEnded(updated);
      break;
    }
    case "customer.subscription.deleted": {
      const user = findUser();
      if (!user) break;
      const updated = users.setSubscription(user.id, {
        tier: "free",
        status: "canceled",
        subscriptionId: null,
        customerId: typeof object.customer === "string" ? object.customer : null,
        currentPeriodEnd: null,
      });
      await subscriptionEnded(updated);
      break;
    }
    default:
      log.info("événement de facturation non traité", { type: event.type });
  }
  return { applied: true, type: event.type };
}
