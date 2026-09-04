/**
 * Textes des courriels de notification, dans la langue du destinataire.
 * Les commerçants sinophones ne doivent pas recevoir leurs alertes en français.
 */
export const MAIL_TEXTS = {
  fr: {
    newBooking: {
      subject: (b) => `Nouvelle réservation — ${b.service} · ${b.when}`,
      body: (b) => `Bonjour ${b.owner},

Vous avez une nouvelle réservation.

  Client      : ${b.customer} (${b.email})
  Prestation  : ${b.service}
  Date        : ${b.when}
  Référence   : ${b.reference}
${b.note ? `\n  Précision du client :\n  ${b.note}${b.noteTranslation ? `\n  (traduction) ${b.noteTranslation}` : ""}\n` : ""}
Votre agenda : ${b.url}`,
    },
    bookingCancelledByCustomer: {
      subject: (b) => `Réservation annulée par le client — ${b.when}`,
      body: (b) => `Bonjour ${b.owner},

${b.customer} a annulé sa réservation « ${b.service} » du ${b.when} (référence ${b.reference}).
Le créneau est de nouveau réservable.

Votre agenda : ${b.url}`,
    },
    digest: {
      subject: (d) => (d.total === 1 ? "Nouveau message" : `${d.total} nouveaux messages`),
      intro: (d) => `Bonjour ${d.name},

Vous avez ${d.total === 1 ? "un nouveau message" : `${d.total} nouveaux messages`} :`,
      line: (l) => `  · ${l.who} — ${l.service} du ${l.when} : ${l.count === 1 ? "1 message" : `${l.count} messages`}`,
      outro: (d) => `\nLisez et répondez dans votre langue : ${d.url}`,
    },
    signature: (service) => `\n${service}`,
  },
  zh: {
    newBooking: {
      subject: (b) => `新预约 — ${b.service} · ${b.when}`,
      body: (b) => `${b.owner},您好:

您收到一条新预约。

  客户      : ${b.customer}(${b.email})
  服务项目  : ${b.service}
  时间      : ${b.when}
  预约号    : ${b.reference}
${b.note ? `\n  客户备注:\n  ${b.note}${b.noteTranslation ? `\n  (译文)${b.noteTranslation}` : ""}\n` : ""}
查看日程:${b.url}`,
    },
    bookingCancelledByCustomer: {
      subject: (b) => `客户已取消预约 — ${b.when}`,
      body: (b) => `${b.owner},您好:

${b.customer} 取消了 ${b.when} 的「${b.service}」预约(预约号 ${b.reference})。
该时段已重新开放。

查看日程:${b.url}`,
    },
    digest: {
      subject: (d) => (d.total === 1 ? "您有一条新消息" : `您有 ${d.total} 条新消息`),
      intro: (d) => `${d.name},您好:

您有 ${d.total} 条新消息:`,
      line: (l) => `  · ${l.who} — ${l.when} 的「${l.service}」:${l.count} 条`,
      outro: (d) => `\n用您自己的语言阅读和回复即可:${d.url}`,
    },
    signature: (service) => `\n${service}`,
  },
  en: {
    newBooking: {
      subject: (b) => `New booking — ${b.service} · ${b.when}`,
      body: (b) => `Hello ${b.owner},

You have a new booking.

  Customer   : ${b.customer} (${b.email})
  Service    : ${b.service}
  When       : ${b.when}
  Reference  : ${b.reference}
${b.note ? `\n  Customer's note:\n  ${b.note}${b.noteTranslation ? `\n  (translation) ${b.noteTranslation}` : ""}\n` : ""}
Your schedule: ${b.url}`,
    },
    bookingCancelledByCustomer: {
      subject: (b) => `Booking cancelled by the customer — ${b.when}`,
      body: (b) => `Hello ${b.owner},

${b.customer} cancelled their "${b.service}" booking on ${b.when} (reference ${b.reference}).
The slot is available again.

Your schedule: ${b.url}`,
    },
    digest: {
      subject: (d) => (d.total === 1 ? "New message" : `${d.total} new messages`),
      intro: (d) => `Hello ${d.name},

You have ${d.total === 1 ? "a new message" : `${d.total} new messages`}:`,
      line: (l) => `  · ${l.who} — ${l.service}, ${l.when}: ${l.count === 1 ? "1 message" : `${l.count} messages`}`,
      outro: (d) => `\nRead and reply in your own language: ${d.url}`,
    },
    signature: (service) => `\n${service}`,
  },
};

const LOCALE_TAGS = { fr: "fr-FR", zh: "zh-CN", en: "en-GB" };

/** Date et heure dans la langue et le fuseau du destinataire. */
export function formatWhen(iso, locale, timeZone) {
  return new Date(iso).toLocaleString(LOCALE_TAGS[locale] ?? "fr-FR", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone,
  });
}

export function texts(locale) {
  return MAIL_TEXTS[locale] ?? MAIL_TEXTS.fr;
}
