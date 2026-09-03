import {
  $,
  boot,
  escapeHtml,
  formatDateTime,
  formatPrice,
  notify,
  onSessionChange,
  setupTabs,
  state,
  t,
} from "/shared.js";
import { bookingCard } from "/booking-card.js";

const pro = { services: [], slots: [], bookings: [] };
let showTab = () => {};

/* ---------- Chargement du back-office ---------- */

async function loadConsole() {
  const response = await fetch("/api/merchant/me");
  if (!response.ok) return;
  const data = await response.json();
  state.merchant = data.merchant;
  pro.services = data.services;
  pro.slots = data.slots;

  $("#pro-name").textContent = data.merchant.name;
  $("#pro-status").textContent = `${data.merchant.categoryLabel} · ${data.merchant.city} · ${
    data.merchant.status === "active" ? t("pro.status.published") : t("pro.status.pending")
  }`;

  renderServices();
  renderSlots();
  fillServiceSelect();
  fillEditForm(data.merchant);
  await loadBookings();
}

/* ---------- Prestations ---------- */

function fillServiceSelect() {
  const select = $("#slot-service");
  select.innerHTML = `<option value="">${escapeHtml(t("form.all"))}</option>${pro.services
    .filter((service) => service.active)
    .map((service) => `<option value="${escapeHtml(service.id)}">${escapeHtml(service.name)}</option>`)
    .join("")}`;
}

function renderServices() {
  const list = $("#service-list");
  list.innerHTML = "";
  if (!pro.services.length) {
    list.innerHTML = `<p class="history-empty">${escapeHtml(t("pro.service.none"))}</p>`;
    return;
  }
  for (const service of pro.services) {
    const row = document.createElement("article");
    row.className = `service-row${service.active ? "" : " is-off"}`;
    row.innerHTML = `
      <div>
        <h3>${escapeHtml(service.name)}</h3>
        <p class="result-meta">${service.durationMin} min · ${escapeHtml(formatPrice(service.priceCents))}${
          service.active ? "" : " · désactivée"
        }</p>
        ${service.description ? `<p class="service-desc">${escapeHtml(service.description)}</p>` : ""}
      </div>
      <div class="profile-actions">
        <button class="btn btn-ghost btn-sm" type="button" data-act="toggle">${escapeHtml(
          service.active ? t("pro.service.disable") : t("pro.service.enable"),
        )}</button>
        <button class="btn btn-ghost btn-sm" type="button" data-act="delete">${escapeHtml(t("pro.service.delete"))}</button>
      </div>`;

    row.querySelector('[data-act="toggle"]').addEventListener("click", async () => {
      const response = await fetch(`/api/merchant/services/${service.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...service, priceCents: service.priceCents, active: !service.active }),
      });
      if (!response.ok) return notify("Modification impossible.");
      await loadConsole();
    });
    row.querySelector('[data-act="delete"]').addEventListener("click", async () => {
      if (!confirm(`Supprimer « ${service.name} » ?`)) return;
      const response = await fetch(`/api/merchant/services/${service.id}`, { method: "DELETE" });
      if (!response.ok) return notify("Suppression impossible.");
      await loadConsole();
    });
    list.append(row);
  }
}

$("#service-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const box = $("#service-error");
  box.hidden = true;
  try {
    const response = await fetch("/api/merchant/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.elements.name.value,
        durationMin: Number(form.elements.durationMin.value),
        // Le prix est saisi en euros, stocké en centimes.
        priceCents: Math.round(Number(form.elements.price.value) * 100),
        description: form.elements.description.value,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Ajout impossible.");
    form.reset();
    form.elements.durationMin.value = 30;
    form.elements.price.value = 35;
    notify("Prestation ajoutée.");
    await loadConsole();
  } catch (error) {
    box.textContent = error.message;
    box.hidden = false;
  }
});

/* ---------- Créneaux ---------- */

function renderSlots() {
  const list = $("#slot-list");
  list.innerHTML = "";
  if (!pro.slots.length) {
    list.innerHTML = `<p class="history-empty">${escapeHtml(t("pro.slots.none"))}</p>`;
    return;
  }
  // Regroupement par journée : un agenda se lit par jour, pas par ligne.
  const days = new Map();
  for (const slot of pro.slots) {
    const day = slot.startsAt.slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(slot);
  }
  for (const [day, slots] of days) {
    const block = document.createElement("section");
    block.className = "slot-day";
    block.innerHTML = `<h3>${escapeHtml(
      new Date(day).toLocaleDateString(state.locale === "zh" ? "zh-CN" : state.locale === "en" ? "en-GB" : "fr-FR", {
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
    )}</h3><div class="slot-chips"></div>`;
    const chips = block.querySelector(".slot-chips");
    for (const slot of slots) {
      const chip = document.createElement("span");
      chip.className = `slot-chip${slot.booked ? " is-booked" : ""}`;
      const hour = new Date(slot.startsAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
      chip.innerHTML = `<strong>${escapeHtml(hour)}</strong> <span>${escapeHtml(
        slot.booked ? t("pro.slots.booked") : t("pro.slots.free"),
      )}</span>`;
      if (!slot.booked) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "slot-remove";
        remove.setAttribute("aria-label", `Retirer le créneau de ${hour}`);
        remove.textContent = "×";
        remove.addEventListener("click", async () => {
          const response = await fetch(`/api/merchant/slots/${slot.id}`, { method: "DELETE" });
          if (!response.ok) return notify("Retrait impossible.");
          await loadConsole();
        });
        chip.append(remove);
      }
      chips.append(chip);
    }
    list.append(block);
  }
}

$("#slot-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const box = $("#slot-error");
  box.hidden = true;
  try {
    const date = form.elements.date.value;
    const step = Number(form.elements.step.value);
    const [fromH, fromM] = form.elements.from.value.split(":").map(Number);
    const [toH, toM] = form.elements.to.value.split(":").map(Number);
    const start = new Date(`${date}T${form.elements.from.value}:00`);
    const end = new Date(`${date}T${form.elements.to.value}:00`);
    if (Number.isNaN(start.getTime()) || end <= start) throw new Error("Plage horaire invalide.");
    if (fromH * 60 + fromM >= toH * 60 + toM) throw new Error("L'heure de fin doit suivre l'heure de début.");

    const startsAt = [];
    for (let time = start.getTime(); time < end.getTime(); time += step * 60_000) {
      startsAt.push(new Date(time).toISOString());
    }
    const response = await fetch("/api/merchant/slots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ startsAt, serviceId: form.elements.serviceId.value || null }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Ouverture impossible.");
    notify(`${data.created} créneau(x) ouvert(s).`);
    await loadConsole();
  } catch (error) {
    box.textContent = error.message;
    box.hidden = false;
  }
});

/* ---------- Réservations reçues ---------- */

async function loadBookings() {
  const response = await fetch(`/api/merchant/bookings?lang=${state.locale}`);
  if (!response.ok) return;
  const data = await response.json();
  pro.bookings = data.bookings;

  const unread = pro.bookings.reduce((total, booking) => total + booking.unread, 0);
  const badge = $("#pro-unread");
  badge.hidden = unread === 0;
  badge.textContent = unread;

  const list = $("#pro-bookings");
  list.innerHTML = "";
  if (!pro.bookings.length) {
    list.innerHTML = `<p class="history-empty">${escapeHtml(t("pro.bookings.none"))}</p>`;
    return;
  }
  // La fiche de réservation est la même des deux côtés : ici en rôle « merchant ».
  for (const booking of pro.bookings) list.append(bookingCard(booking, "merchant"));
}

/* ---------- Inscription et fiche de l'établissement ---------- */

function categoryOptions(selected) {
  return Object.entries(state.categories)
    .map(
      ([value, label]) =>
        `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");
}

function readMerchantForm(form) {
  return {
    name: form.elements.name.value,
    category: form.elements.category.value,
    address: form.elements.address.value,
    city: form.elements.city.value,
    postalCode: form.elements.postalCode.value,
    phone: form.elements.phone.value,
    description: form.elements.description.value,
    languages: form.elements.languages.value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}

$("#merchant-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const box = $("#merchant-error");
  box.hidden = true;
  try {
    const response = await fetch("/api/merchants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(readMerchantForm(event.target)),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Inscription impossible.");
    notify(
      data.merchant.status === "active"
        ? "Établissement inscrit et publié au catalogue."
        : "Établissement inscrit : il paraîtra au catalogue après validation.",
    );
    await boot();
  } catch (error) {
    box.textContent = error.message;
    box.hidden = false;
  }
});

/** Formulaire de modification, construit à partir de la fiche existante. */
function fillEditForm(merchant) {
  const form = $("#merchant-edit");
  form.innerHTML = `
    <div class="field-row">
      <label>Nom de l'établissement<input name="name" maxlength="120" required value="${escapeHtml(merchant.name)}" /></label>
      <label>Métier<select name="category" required>${categoryOptions(merchant.category)}</select></label>
    </div>
    <div class="field-row">
      <label>Adresse<input name="address" maxlength="160" required value="${escapeHtml(merchant.address)}" /></label>
      <label>Téléphone<input name="phone" maxlength="30" required value="${escapeHtml(merchant.phone)}" /></label>
    </div>
    <div class="field-row">
      <label>Ville<input name="city" maxlength="80" required value="${escapeHtml(merchant.city)}" /></label>
      <label>Code postal<input name="postalCode" maxlength="12" required value="${escapeHtml(merchant.postalCode)}" /></label>
    </div>
    <label>Langues parlées <em>(séparées par des virgules)</em>
      <input name="languages" required value="${escapeHtml(merchant.languages.join(", "))}" />
    </label>
    <label>Description<textarea name="description" rows="5" maxlength="2000" required>${escapeHtml(merchant.description)}</textarea></label>
    <div class="alert" role="alert" hidden></div>
    <button class="btn btn-primary" type="submit">${escapeHtml(t("common.save"))}</button>`;

  form.onsubmit = async (event) => {
    event.preventDefault();
    const box = form.querySelector(".alert");
    box.hidden = true;
    const response = await fetch("/api/merchant/me", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(readMerchantForm(form)),
    });
    const data = await response.json();
    if (!response.ok) {
      box.textContent = data.error ?? "Enregistrement impossible.";
      box.hidden = false;
      return;
    }
    notify("Fiche mise à jour.");
    await loadConsole();
  };
}

/* ---------- Cycle de vie ---------- */

showTab = setupTabs((name) => {
  if (name === "reservations") loadBookings();
  if (name === "agenda") renderSlots();
});

onSessionChange(async () => {
  const connected = Boolean(state.user);
  $("#pro-gate").hidden = connected;
  $("#pro-onboarding").hidden = !(connected && !state.merchant);
  $("#pro-console").hidden = !(connected && state.merchant);

  if (connected && !state.merchant) {
    $("#merchant-category").innerHTML = categoryOptions();
  }
  if (connected && state.merchant) {
    await loadConsole();
    const wanted = window.location.hash.slice(1);
    showTab(["agenda", "reservations", "prestations", "etablissement"].includes(wanted) ? wanted : "agenda");
  }
});

boot();
