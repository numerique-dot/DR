import { $, boot, escapeHtml, notify, onSessionChange, state } from "/shared.js";

const view = { filter: "pending", merchants: [] };

async function load() {
  const query = view.filter ? `?statut=${encodeURIComponent(view.filter)}` : "";
  const response = await fetch(`/api/admin/merchants${query}`);
  if (!response.ok) return;
  const data = await response.json();
  view.merchants = data.merchants;

  const pending = data.counts.pending ?? 0;
  const badge = $("#count-pending");
  badge.hidden = pending === 0;
  badge.textContent = pending;
  render();
}

const STATUS_LABEL = {
  pending: "En attente",
  active: "Publiée",
  paused: "En pause",
  rejected: "Refusée",
};

function render() {
  const list = $("#mod-list");
  list.innerHTML = "";
  if (!view.merchants.length) {
    list.innerHTML = '<p class="history-empty">Rien à traiter dans cette file.</p>';
    return;
  }
  for (const merchant of view.merchants) list.append(card(merchant));
}

function card(merchant) {
  const element = document.createElement("article");
  element.className = "booking-card";
  const deposit = new Date(merchant.createdAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });

  element.innerHTML = `
    <div class="booking-head">
      <div>
        <h3>${escapeHtml(merchant.name)}</h3>
        <p class="result-meta">${escapeHtml(merchant.categoryLabel)} · ${escapeHtml(merchant.address)}, ${escapeHtml(
          merchant.postalCode,
        )} ${escapeHtml(merchant.city)} · ${escapeHtml(merchant.phone)}</p>
        <p class="result-meta">Compte : ${escapeHtml(merchant.owner?.name ?? "—")} &lt;${escapeHtml(
          merchant.owner?.email ?? "",
        )}&gt; · déposée le ${escapeHtml(deposit)} · ${merchant.services} prestation(s)</p>
      </div>
      <div class="booking-when">
        <strong>${escapeHtml(STATUS_LABEL[merchant.status] ?? merchant.status)}</strong>
        ${merchant.languages.length ? `<span class="result-meta">${merchant.languages.map(escapeHtml).join(", ")}</span>` : ""}
      </div>
    </div>
    <p class="merchant-desc">${escapeHtml(merchant.description)}</p>
    ${
      merchant.moderationNote
        ? `<div class="booking-note"><p class="preview-title">Motif enregistré</p><p>${escapeHtml(
            merchant.moderationNote,
          )}</p></div>`
        : ""
    }
    <label class="mod-note"><span class="preview-title">Motif (obligatoire pour refuser)</span>
      <textarea rows="2" maxlength="1000" placeholder="Ce que le professionnel doit corriger."></textarea>
    </label>
    <div class="profile-actions">
      ${merchant.status !== "active" ? '<button class="btn btn-primary btn-sm" type="button" data-decision="active">Publier</button>' : ""}
      ${merchant.status !== "rejected" ? '<button class="btn btn-ghost btn-sm" type="button" data-decision="rejected">Refuser</button>' : ""}
      ${merchant.status === "active" ? '<button class="btn btn-ghost btn-sm" type="button" data-decision="paused">Suspendre</button>' : ""}
    </div>
    <div class="alert" role="alert" hidden></div>`;

  for (const button of element.querySelectorAll("[data-decision]")) {
    button.addEventListener("click", async () => {
      const status = button.dataset.decision;
      const note = element.querySelector(".mod-note textarea").value.trim();
      const box = element.querySelector(".alert");
      box.hidden = true;
      const response = await fetch(`/api/admin/merchants/${merchant.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, note }),
      });
      const data = await response.json();
      if (!response.ok) {
        box.textContent = data.error ?? "Décision impossible.";
        box.hidden = false;
        return;
      }
      notify(`${merchant.name} — ${STATUS_LABEL[status].toLowerCase()}.`);
      await load();
    });
  }
  return element;
}

for (const tab of document.querySelectorAll(".app-tab")) {
  tab.addEventListener("click", () => {
    view.filter = tab.dataset.filter;
    for (const other of document.querySelectorAll(".app-tab")) {
      other.setAttribute("aria-selected", String(other === tab));
    }
    load();
  });
}

onSessionChange(() => {
  const allowed = Boolean(state.user?.admin);
  $("#mod-gate").hidden = allowed;
  $("#mod-console").hidden = !allowed;
  if (allowed) load();
});

boot();
