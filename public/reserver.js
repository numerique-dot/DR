import {
  $,
  boot,
  escapeHtml,
  formatDateTime,
  formatPrice,
  formatTime,
  notify,
  onSessionChange,
  openAuth,
  setupTabs,
  state,
  t,
} from "/shared.js";
import { bookingCard } from "/booking-card.js";

const page = { catalog: [], bookings: [], openThread: null };
let showTab = () => {};

/* ---------- Catalogue ---------- */

async function loadCatalog() {
  const city = $("#filter-city").value;
  const category = $("#filter-category").value;
  const query = new URLSearchParams();
  if (city) query.set("ville", city);
  if (category) query.set("categorie", category);

  const response = await fetch(`/api/catalog?${query}`);
  if (!response.ok) return notify("Catalogue indisponible.");
  const data = await response.json();
  page.catalog = data.merchants;

  fillOnce($("#filter-city"), data.cities.map((c) => [c, c]), t("form.all"));
  fillOnce($("#filter-category"), Object.entries(data.categories), t("form.all"));
  renderCatalog();
}

/** Remplit un menu déroulant une seule fois, en conservant la valeur choisie. */
function fillOnce(select, entries, allLabel) {
  if (select.dataset.filled) return;
  select.dataset.filled = "1";
  select.innerHTML = `<option value="">${escapeHtml(allLabel)}</option>${entries
    .map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
    .join("")}`;
}

function renderCatalog() {
  const list = $("#catalog-list");
  list.innerHTML = "";
  if (!page.catalog.length) {
    list.innerHTML = `<p class="history-empty">${escapeHtml(t("catalog.none"))}</p>`;
    return;
  }
  for (const merchant of page.catalog) list.append(merchantCard(merchant));
}

function merchantCard(merchant) {
  const card = document.createElement("article");
  card.className = "merchant-card";
  const services = merchant.services
    .map(
      (service) =>
        `<li><span>${escapeHtml(service.name)}</span><span class="service-meta">${service.durationMin} min · ${escapeHtml(
          formatPrice(service.priceCents),
        )}</span></li>`,
    )
    .join("");
  card.innerHTML = `
    <div class="merchant-head">
      <span class="merchant-monogram" aria-hidden="true">${escapeHtml(merchant.name.slice(0, 1).toUpperCase())}</span>
      <div>
        <p class="spec">${escapeHtml(merchant.categoryLabel)}</p>
        <h2>${escapeHtml(merchant.name)}</h2>
        <p class="result-meta">${escapeHtml(merchant.address)}, ${escapeHtml(merchant.postalCode)} ${escapeHtml(merchant.city)}</p>
      </div>
    </div>
    <div class="tags">${merchant.languages.map((l) => `<span>${escapeHtml(l)}</span>`).join("")}</div>
    <p class="merchant-desc">${escapeHtml(merchant.description)}</p>
    <ul class="service-list-inline">${services || "<li>Aucune prestation publiée</li>"}</ul>
    <p class="result-meta">${
      merchant.openSlots
        ? `${merchant.openSlots} ${escapeHtml(t("catalog.slots"))}`
        : escapeHtml(t("catalog.noslots"))
    }</p>
    <div class="profile-actions">
      <button class="btn btn-primary btn-sm" type="button"${merchant.openSlots ? "" : " disabled"}>${escapeHtml(
        merchant.openSlots ? t("catalog.book") : t("catalog.full"),
      )}</button>
    </div>`;
  const button = card.querySelector("button");
  if (merchant.openSlots) button.addEventListener("click", () => openBooking(merchant));
  return card;
}

/* ---------- Réservation ---------- */

const dialog = $("#booking-dialog");

async function openBooking(merchant) {
  if (!state.user) return openAuth("signup");
  const response = await fetch(`/api/merchants/${merchant.id}`);
  if (!response.ok) return notify("Établissement indisponible.");
  const data = await response.json();
  if (!data.slots.length) return notify("Plus aucun créneau libre pour cet établissement.");

  $("#booking-merchant").textContent = `${data.merchant.name} — ${data.merchant.categoryLabel}`;
  $("#booking-error").hidden = true;
  $("#booking-note").value = "";
  dialog.dataset.merchantId = merchant.id;

  $("#booking-service").innerHTML = data.services
    .map(
      (service) =>
        `<option value="${escapeHtml(service.id)}">${escapeHtml(service.name)} — ${service.durationMin} min, ${escapeHtml(
          formatPrice(service.priceCents),
        )}</option>`,
    )
    .join("");
  renderSlotOptions(data.slots);
  $("#booking-service").onchange = () => renderSlotOptions(data.slots);
  dialog.showModal();
}

/** N'affiche que les créneaux compatibles avec la prestation choisie. */
function renderSlotOptions(slots) {
  const serviceId = $("#booking-service").value;
  const usable = slots.filter((slot) => !slot.serviceId || slot.serviceId === serviceId);
  $("#booking-slot").innerHTML = usable
    .map((slot) => `<option value="${escapeHtml(slot.id)}">${escapeHtml(formatDateTime(slot.startsAt))}</option>`)
    .join("");
  $("#booking-submit").disabled = usable.length === 0;
  if (!usable.length) {
    const box = $("#booking-error");
    box.textContent = "Aucun créneau ne correspond à cette prestation.";
    box.hidden = false;
  } else {
    $("#booking-error").hidden = true;
  }
}

$("#booking-form")?.addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const button = $("#booking-submit");
  button.disabled = true;
  try {
    const response = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slotId: $("#booking-slot").value,
        serviceId: $("#booking-service").value,
        note: $("#booking-note").value,
        noteLang: state.locale,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Réservation impossible.");
    dialog.close();
    notify(`Réservation confirmée — ${t("booking.reference")} ${data.booking.reference}`);
    await loadBookings();
    await loadCatalog();
    showTab("mes-reservations");
  } catch (error) {
    const box = $("#booking-error");
    box.textContent = error.message;
    box.hidden = false;
  } finally {
    button.disabled = false;
  }
});

/* ---------- Mes réservations ---------- */

async function loadBookings() {
  if (!state.user) {
    $("#bookings-gate").hidden = false;
    $("#bookings-list").innerHTML = "";
    return;
  }
  $("#bookings-gate").hidden = true;
  const response = await fetch("/api/bookings");
  if (!response.ok) return;
  const data = await response.json();
  page.bookings = data.bookings;
  renderBookings();
}

function renderBookings() {
  const list = $("#bookings-list");
  list.innerHTML = "";
  const unread = page.bookings.reduce((total, booking) => total + booking.unread, 0);
  const badge = $("#unread-badge");
  badge.hidden = unread === 0;
  badge.textContent = unread;

  if (!page.bookings.length) {
    list.innerHTML = `<p class="history-empty">${escapeHtml(t("bookings.none"))}</p>`;
    return;
  }
  for (const booking of page.bookings) list.append(bookingCard(booking, "customer"));
}

/* ---------- Cycle de vie ---------- */

document.addEventListener("bookings:refresh", async () => {
  await loadBookings();
  await loadCatalog();
});

$("#filters")?.addEventListener("change", loadCatalog);
$("#filters")?.addEventListener("submit", (event) => event.preventDefault());

showTab = setupTabs((name) => {
  if (name === "catalogue") loadCatalog();
  if (name === "mes-reservations") loadBookings();
});

onSessionChange(() => {
  loadCatalog();
  loadBookings();
});

boot().then(() => {
  const wanted = window.location.hash.slice(1);
  showTab(["catalogue", "mes-reservations"].includes(wanted) ? wanted : "catalogue");
});
