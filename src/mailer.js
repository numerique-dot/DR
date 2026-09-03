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

export function appointmentConfirmation(appointment) {
  return send({
    to: appointment.email,
    subject: `Rendez-vous confirmé — ${appointment.doctor_name}, ${appointment.slot}`,
    text: `Bonjour ${appointment.patient_name},

Votre rendez-vous est confirmé.

  Praticien : ${appointment.doctor_name} (${appointment.speciality})
  Créneau   : ${appointment.slot}
  Référence : ${appointment.reference}

Lieu : ${config.clinic.address}
Merci de vous présenter dix minutes avant l'heure, avec votre carte Vitale.

Pour annuler ou déplacer ce rendez-vous, appelez le ${config.clinic.phone}.

${config.clinic.name}`,
  });
}

export function welcome(user) {
  return send({
    to: user.email,
    subject: "Bienvenue chez D.R DU",
    text: `Bonjour ${user.name},

Votre compte est créé. Vous pouvez déposer vos documents de santé et en obtenir
la traduction en chinois, en anglais ou en français.

${
  user.tier === "member"
    ? "Votre formule Membre est active : chaque traduction est accompagnée de ses points de vigilance (posologie, interactions, valeurs hors normes, échéances)."
    : "La formule Essentiel rend la traduction fidèle du document. La formule Membre y ajoute les points de vigilance."
}

Rappel : ces traductions sont une aide à la compréhension et ne remplacent pas
l'avis de votre médecin ou de votre pharmacien.

${config.clinic.name}`,
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

${config.clinic.name}`,
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

${config.clinic.name}`,
  });
}
