import {
  $,
  escapeHtml,
  formatDateTime,
  formatPrice,
  formatTime,
  notify,
  state,
  t,
} from "/shared.js";

/** Fiche de réservation, côté client comme côté professionnel. */
export function bookingCard(booking, role) {
  const card = document.createElement("article");
  const cancelled = booking.status !== "confirmed";
  card.className = `booking-card${cancelled ? " is-cancelled" : ""}`;
  const counterpart =
    role === "customer"
      ? `${escapeHtml(booking.merchant?.name ?? "")} · ${escapeHtml(booking.merchant?.city ?? "")}`
      : `${escapeHtml(booking.customer?.name ?? "")} · ${escapeHtml(booking.customer?.email ?? "")}`;

  card.innerHTML = `
    <div class="booking-head">
      <div>
        <h3>${escapeHtml(booking.service?.name ?? "")}</h3>
        <p class="result-meta">${counterpart}</p>
      </div>
      <div class="booking-when">
        <strong>${escapeHtml(formatDateTime(booking.startsAt))}</strong>
        <span class="result-meta">${booking.service?.durationMin ?? "?"} min · ${escapeHtml(
          formatPrice(booking.service?.priceCents ?? 0),
        )}</span>
      </div>
    </div>
    <p class="result-meta">${escapeHtml(t("booking.reference"))} ${escapeHtml(booking.reference)}${
      cancelled ? ` · <strong>${escapeHtml(t("booking.cancelled"))}</strong>` : ""
    }</p>
    ${
      booking.note
        ? `<div class="booking-note">
             <p class="preview-title">${escapeHtml(t("booking.note"))}</p>
             <p>${escapeHtml(booking.noteTranslation ?? booking.note)}</p>
             ${
               booking.noteTranslation
                 ? `<details class="bubble-original"><summary>${escapeHtml(t("message.original"))}</summary><p>${escapeHtml(
                     booking.note,
                   )}</p></details>`
                 : ""
             }
           </div>`
        : ""
    }
    <div class="profile-actions">
      <button class="btn btn-ghost btn-sm" type="button" data-act="thread">${escapeHtml(t("booking.messages"))}${
        booking.unread ? ` <span class="unread">${booking.unread}</span>` : ""
      }</button>
      ${cancelled ? "" : `<button class="btn btn-ghost btn-sm" type="button" data-act="cancel">${escapeHtml(t("booking.cancel"))}</button>`}
    </div>
    <div class="thread-box" hidden></div>`;

  card.querySelector('[data-act="thread"]').addEventListener("click", () => toggleThread(card, booking));
  card.querySelector('[data-act="cancel"]')?.addEventListener("click", async () => {
    if (!confirm("Annuler cette réservation ?")) return;
    const response = await fetch(`/api/bookings/${booking.id}/cancel`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) return notify(data.error ?? "Annulation impossible.");
    notify("Réservation annulée.");
    document.dispatchEvent(new CustomEvent("bookings:refresh"));
  });
  return card;
}

/* ---------- Fil de discussion attaché à une réservation ---------- */

export async function toggleThread(card, booking) {
  const box = card.querySelector(".thread-box");
  if (!box.hidden) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = '<p class="history-empty">Chargement…</p>';
  await renderThread(box, booking);
}

async function renderThread(box, booking) {
  const response = await fetch(`/api/bookings/${booking.id}/messages?lang=${state.locale}`);
  if (!response.ok) {
    box.innerHTML = '<p class="history-empty">Conversation indisponible.</p>';
    return;
  }
  const data = await response.json();
  box.innerHTML = `
    <div class="thread-messages">${
      data.messages.length
        ? data.messages
            .map((message) => {
              const main = message.mine ? message.body : (message.translation ?? message.body);
              return `<div class="bubble ${message.mine ? "me" : "them"}">
                <p class="bubble-text">${escapeHtml(main)}</p>
                ${
                  message.mine || !message.translation
                    ? ""
                    : `<details class="bubble-original"><summary>${escapeHtml(t("message.original"))}</summary><p>${escapeHtml(
                        message.body,
                      )}</p></details>`
                }
                <p class="bubble-time">${escapeHtml(formatTime(message.createdAt))}</p>
              </div>`;
            })
            .join("")
        : `<p class="history-empty">${escapeHtml(t("message.none"))}</p>`
    }</div>
    <form class="composer">
      <label class="sr-only" for="msg-${booking.id}">Message</label>
      <textarea id="msg-${booking.id}" rows="2" placeholder="${escapeHtml(t("message.placeholder"))}" required></textarea>
      <div class="composer-actions">
        <button class="btn btn-primary btn-sm" type="submit">${escapeHtml(t("message.send"))}</button>
      </div>
    </form>`;

  box.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const textarea = box.querySelector("textarea");
    const body = textarea.value.trim();
    if (!body) return;
    const response = await fetch(`/api/bookings/${booking.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    const data = await response.json();
    if (!response.ok) return notify(data.error ?? "Envoi impossible.");
    textarea.value = "";
    await renderThread(box, booking);
  });
}

