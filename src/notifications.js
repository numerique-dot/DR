import { config } from "./config.js";
import { log } from "./logger.js";
import { bookings, merchants, pendingNotifications, users } from "./db.js";
import { messageDigest } from "./mailer.js";

/**
 * Notifications de messages, groupées. Un message reçu n'envoie pas de
 * courriel immédiatement : il entre dans une file, et le destinataire reçoit
 * un seul récapitulatif quand la plus ancienne entrée a dix minutes. S'il a lu
 * la conversation entre-temps, la file se vide et rien ne part.
 *
 * La file est en base : un redémarrage ne perd aucune notification.
 */

/** À l'envoi d'un message : le destinataire est l'autre partie de la réservation. */
export function noteNewMessage(booking, senderId) {
  const owner = merchants.owner(booking.merchantId);
  const recipientId = senderId === booking.customerId ? owner?.id : booking.customerId;
  if (!recipientId) return;
  pendingNotifications.add(recipientId, booking.id, "message");
}

/** Le lecteur a ouvert la conversation : plus rien à lui signaler pour celle-ci. */
export function noteThreadRead(userId, bookingId) {
  return pendingNotifications.clear(userId, bookingId);
}

/**
 * Envoie les récapitulatifs arrivés à échéance.
 * @param {object} [options]
 * @param {Date}   [options.now]   horloge de référence (tests)
 * @param {boolean}[options.force] ignore le délai de regroupement
 */
export async function flushNotifications({ now = new Date(), force = false } = {}) {
  const cutoff = force
    ? new Date(now.getTime() + 1).toISOString()
    : new Date(now.getTime() - config.notifications.digestMinutes * 60_000).toISOString();

  let sent = 0;
  for (const due of pendingNotifications.due(cutoff)) {
    const recipient = users.byId(due.userId);
    if (!recipient) {
      pendingNotifications.consume(due.userId);
      continue;
    }
    const merchant = merchants.byOwner(recipient.id);
    const lines = [];
    for (const item of due.items) {
      const booking = bookings.detailed(item.bookingId, recipient.id);
      if (!booking) continue;
      const asMerchant = merchant && booking.merchantId === merchant.id;
      lines.push({
        who: asMerchant ? booking.customer?.name ?? "" : booking.merchant?.name ?? "",
        service: booking.service?.name ?? "",
        startsAt: booking.startsAt,
        count: item.count,
      });
    }
    // La file est vidée avant l'envoi : un échec de courriel ne doit pas la
    // faire renvoyer indéfiniment.
    pendingNotifications.consume(due.userId);
    if (!lines.length) continue;

    const url = `${config.publicUrl}${merchant ? "/pro#reservations" : "/reserver#mes-reservations"}`;
    await messageDigest(recipient, lines, url);
    sent++;
    log.info("récapitulatif de messages envoyé", { userId: recipient.id, conversations: lines.length });
  }
  return { sent };
}

/** Vérification périodique de la file. */
export function startNotificationSweep() {
  const timer = setInterval(() => {
    flushNotifications().catch((error) => log.error("envoi des notifications en échec", { error: error.message }));
  }, config.notifications.sweepSeconds * 1000);
  timer.unref();
  return timer;
}
