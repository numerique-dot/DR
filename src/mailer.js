import { config } from "./config.js";
import { log } from "./logger.js";

/**
 * Courriels transactionnels. Deux transports sans dépendance :
 *  - "log"     : trace le message (développement, recette) ;
 *  - "webhook" : relaie le message en JSON vers MAIL_WEBHOOK_URL, ce qui permet
 *                de brancher n'importe quel prestataire d'envoi.
 */
async function deliver(message) {
  if (config.mail.transport === "webhook" && config.mail.webhookUrl) {
    const response = await fetch(config.mail.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!response.ok) throw new Error(`Relais de courriel en échec : ${response.status}`);
    return { delivered: true, transport: "webhook" };
  }
  log.info("courriel (transport log)", { to: message.to, subject: message.subject });
  return { delivered: false, transport: "log" };
}

/** Un envoi de courriel ne doit jamais faire échouer la requête du patient. */
async function send(message) {
  const payload = { from: config.mail.from, replyTo: config.mail.replyTo, ...message };
  try {
    return await deliver(payload);
  } catch (error) {
    log.error("échec d'envoi de courriel", { to: payload.to, error: error.message });
    return { delivered: false, transport: "erreur" };
  }
}

export function welcome(user) {
  return send({
    to: user.email,
    subject: "Bienvenue chez D.R RDV",
    text: `Bonjour ${user.name},

Votre compte est créé. Vous pouvez réserver auprès des professionnels inscrits,
échanger avec eux dans votre langue, et faire traduire vos documents.

Rappel : le document que vous déposez n'est pas conservé. Il est traité en
mémoire, traduit, puis abandonné.

${
  user.tier === "member"
    ? "Votre formule Membre est active : chaque traduction de document est accompagnée de ses points de vigilance (montants, échéances, engagements, conditions de résiliation)."
    : "La formule Essentiel rend la traduction fidèle du document. La formule Membre y ajoute les points de vigilance."
}

Rappel : ces traductions sont une aide à la compréhension et ne remplacent pas
l'avis de votre médecin ou de votre pharmacien.

${config.service.name}`,
  });
}

export function subscriptionActivated(user) {
  return send({
    to: user.email,
    subject: "Votre formule Membre est active",
    text: `Bonjour ${user.name},

Votre abonnement est actif${user.current_period_end ? ` jusqu'au ${new Date(user.current_period_end).toLocaleDateString("fr-FR")}` : ""}.
Les points de vigilance et l'historique de vos documents sont désormais accessibles.

Vous pouvez résilier à tout moment depuis votre espace, sans frais.

${config.service.name}`,
  });
}

export function subscriptionEnded(user) {
  return send({
    to: user.email,
    subject: "Votre formule Membre a pris fin",
    text: `Bonjour ${user.name},

Votre abonnement est terminé. Votre compte reste actif en formule Essentiel :
les traductions restent gratuites, sans les points de vigilance.

Vos documents déjà traduits demeurent dans votre historique.

${config.service.name}`,
  });
}

/* ---------- Réservations ---------- */

const euros = (cents) => (cents / 100).toFixed(2).replace(".", ",");
const moment = (iso, locale = "fr-FR") =>
  new Date(iso).toLocaleString(locale, { dateStyle: "full", timeStyle: "short", timeZone: config.timezone });

export function bookingConfirmation(booking, customer) {
  return send({
    to: customer.email,
    subject: `Réservation confirmée — ${booking.merchant?.name ?? ""} (${booking.reference})`,
    text: `Bonjour ${customer.name},

Votre réservation est confirmée.

  Établissement : ${booking.merchant?.name ?? ""}
  Prestation    : ${booking.service?.name ?? ""} (${booking.service?.durationMin ?? "?"} min, ${euros(booking.service?.priceCents ?? 0)} €)
  Date          : ${moment(booking.startsAt)}
  Adresse       : ${booking.merchant?.address ?? ""}, ${booking.merchant?.city ?? ""}
  Téléphone     : ${booking.merchant?.phone ?? ""}
  Référence     : ${booking.reference}
${booking.note ? `\n  Votre précision : ${booking.note}` : ""}

Pour annuler, rendez-vous dans « Mes réservations » sur ${config.publicUrl}.
L'établissement peut vous écrire depuis la plateforme : les messages sont
traduits dans votre langue.

${config.service.name}`,
  });
}

export function bookingCancelled(booking) {
  const byMerchant = booking.cancelledBy === "merchant";
  return send({
    to: booking.customer?.email ?? "",
    subject: `Réservation annulée — ${booking.reference}`,
    text: `Bonjour ${booking.customer?.name ?? ""},

La réservation ${booking.reference} du ${moment(booking.startsAt)} chez
${booking.merchant?.name ?? ""} est annulée${byMerchant ? " par l'établissement" : ""}.

${
  byMerchant
    ? `Vous pouvez choisir un autre créneau sur ${config.publicUrl}, ou joindre l'établissement au ${booking.merchant?.phone ?? ""}.`
    : "Le créneau est de nouveau disponible pour d'autres clients."
}

${config.service.name}`,
  });
}

/* ---------- Modération et mot de passe ---------- */

export function merchantApproved(merchant, owner) {
  return send({
    to: owner.email,
    subject: `${merchant.name} est publié au catalogue`,
    text: `Bonjour ${owner.name},

Votre établissement « ${merchant.name} » est validé et visible au catalogue.
Les clients peuvent désormais réserver les créneaux que vous ouvrez.

Votre espace : ${config.publicUrl}/pro

${config.service.name}`,
  });
}

export function merchantRejected(merchant, owner, reason) {
  return send({
    to: owner.email,
    subject: `${merchant.name} : votre inscription n'a pas été retenue`,
    text: `Bonjour ${owner.name},

Votre demande d'inscription pour « ${merchant.name} » n'a pas été retenue.

${reason ? `Motif indiqué par la modération :\n${reason}` : "Aucun motif n'a été précisé."}

Vous pouvez corriger votre fiche depuis ${config.publicUrl}/pro et nous écrire à
${config.service.email} si vous pensez qu'il s'agit d'une erreur.

${config.service.name}`,
  });
}

export function passwordResetRequested(user, token) {
  const link = `${config.publicUrl}/reinitialiser?jeton=${encodeURIComponent(token)}`;
  return send({
    to: user.email,
    subject: "Réinitialiser votre mot de passe",
    text: `Bonjour ${user.name},

Vous avez demandé à réinitialiser votre mot de passe. Ce lien est valable
${config.limits.resetMinutes} minutes et ne fonctionne qu'une fois :

${link}

Si vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot
de passe reste inchangé. Personne d'autre ne peut ouvrir ce lien sans y accéder.

${config.service.name}`,
  });
}

export function passwordChanged(user) {
  return send({
    to: user.email,
    subject: "Votre mot de passe a été modifié",
    text: `Bonjour ${user.name},

Votre mot de passe vient d'être modifié et toutes vos sessions ont été fermées.

Si vous n'êtes pas à l'origine de ce changement, écrivez immédiatement à
${config.service.email}.

${config.service.name}`,
  });
}
