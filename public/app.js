const $ = (sel) => document.querySelector(sel);
const MAX_FILE = 9 * 1024 * 1024;

const state = { file: null, text: null, result: null, activeTab: "translation" };

/* ---------- Amorçage : praticiens + mode IA ---------- */
async function boot() {
  try {
    const config = await (await fetch("/api/config")).json();
    renderDoctors(config.doctors);
    const badge = $("#ai-mode");
    badge.textContent = config.aiMode === "live" ? "IA connectée · Claude" : "Mode démonstration (aucune clé API)";
    badge.title =
      config.aiMode === "live"
        ? "Les documents sont traduits par le modèle Claude."
        : "ANTHROPIC_API_KEY n'est pas définie : une notice d'exemple est renvoyée.";
  } catch {
    $("#ai-mode").textContent = "Service indisponible";
  }
}

function renderDoctors(doctors) {
  const grid = $("#doctor-grid");
  grid.innerHTML = "";
  for (const doctor of doctors) {
    const card = document.createElement("article");
    card.className = "doctor";
    card.innerHTML = `
      <p class="spec">${escapeHtml(doctor.speciality)}</p>
      <h3>${escapeHtml(doctor.name)}</h3>
      <p class="meta">${escapeHtml(doctor.address)}<br />${escapeHtml(doctor.sector)}<br />${doctor.languages.map(escapeHtml).join(" · ")}</p>
      <div class="slots">${doctor.slots.map((s) => `<span>${escapeHtml(s)}</span>`).join("")}</div>
      <button class="btn btn-ghost btn-sm" type="button">Réserver</button>`;
    card.querySelector("button").addEventListener("click", () => openBooking(doctor));
    grid.append(card);
  }
}

/* ---------- Réservation ---------- */
const dialog = $("#booking");
function openBooking(doctor) {
  const form = $("#booking-form");
  form.reset();
  $("#booking-error").hidden = true;
  form.elements.doctorId.value = doctor.id;
  $("#booking-doctor").textContent = `${doctor.name} — ${doctor.speciality}`;
  form.elements.slot.innerHTML = doctor.slots
    .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
    .join("");
  dialog.showModal();
}

$("#booking-form").addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.returnValue === "cancel" || event.submitter?.value === "cancel") return;
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.tier = selectedTier();
  const button = $("#booking-submit");
  button.disabled = true;
  try {
    const response = await fetch("/api/appointments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Réservation impossible.");
    dialog.close();
    alert(
      `Rendez-vous confirmé.\n\n${data.doctorName} — ${data.slot}\nRéférence : ${data.reference}\nUn courriel de confirmation part à ${data.email}.`,
    );
  } catch (error) {
    const box = $("#booking-error");
    box.textContent = error.message;
    box.hidden = false;
  } finally {
    button.disabled = false;
  }
});

/* ---------- Dépôt de fichier ---------- */
const dropzone = $("#dropzone");
const fileInput = $("#file-input");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
["dragenter", "dragover"].forEach((type) =>
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add("is-over");
  }),
);
["dragleave", "drop"].forEach((type) =>
  dropzone.addEventListener(type, () => dropzone.classList.remove("is-over")),
);
dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  if (event.dataTransfer.files[0]) acceptFile(event.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) acceptFile(fileInput.files[0]);
});

function acceptFile(file) {
  if (file.size > MAX_FILE) return showError("Fichier trop volumineux : 9 Mo maximum.");
  state.file = file;
  $("#file-name").textContent = `${file.name} — ${(file.size / 1024).toFixed(0)} ko`;
  $("#error").hidden = true;
}

function selectedTier() {
  return document.querySelector('input[name="tier"]:checked').value;
}

/* ---------- Traduction ---------- */
$("#translate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.file) return showError("Déposez d'abord un document à traduire.");

  const tier = selectedTier();
  const target = document.querySelector('input[name="target"]:checked').value;
  const button = $("#submit-btn");

  button.disabled = true;
  $("#error").hidden = true;
  $("#loading").hidden = false;

  try {
    const payload = {
      tier,
      target,
      fileName: state.file.name,
      mediaType: state.file.type,
    };
    if (isTextFile(state.file)) payload.text = await state.file.text();
    else payload.dataBase64 = await toBase64(state.file);

    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "La traduction a échoué.");
    state.result = data;
    state.activeTab = "translation";
    renderResult(data);
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
    $("#loading").hidden = true;
  }
});

function isTextFile(file) {
  return file.type.startsWith("text/") || /\.(txt|md)$/i.test(file.name);
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
    reader.readAsDataURL(file);
  });
}

const LANG_LABEL = { zh: "中文 (simplifié)", en: "English", fr: "Français" };

function renderResult(data) {
  $("#result-empty").hidden = true;
  $("#result").hidden = false;
  $("#result-title").textContent = data.document_type || "Traduction";

  const tierLabel = data.tier === "member" ? "Formule Membre" : "Formule Essentiel";
  const mode = data.mode === "demo" ? " · exemple de démonstration" : "";
  $("#result-meta").textContent = `${escapeText(data.fileName)} → ${LANG_LABEL[data.target] ?? data.target} · ${tierLabel}${mode}`;

  const member = data.tier === "member";
  const tabs = [
    { id: "translation", label: "Traduction" },
    { id: "cautions", label: "注意事项 · Vigilance", count: member ? (data.cautions ?? []).length : null, locked: !member },
    { id: "glossary", label: "Glossaire", count: member ? (data.glossary ?? []).length : null, locked: !member },
    { id: "questions", label: "Questions au médecin", count: member ? (data.questions_for_doctor ?? []).length : null, locked: !member },
    { id: "follow", label: "Suivi", count: member ? (data.follow_up ?? []).length : null, locked: !member },
  ];

  const tabBar = $("#tabs");
  const panels = $("#panels");
  tabBar.innerHTML = "";
  panels.innerHTML = "";

  for (const tab of tabs) {
    const button = document.createElement("button");
    button.className = "tab";
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(tab.id === state.activeTab));
    button.innerHTML = `${escapeHtml(tab.label)}${tab.count ? ` <span class="tab-count">${tab.count}</span>` : ""}${tab.locked ? " 🔒" : ""}`;
    button.addEventListener("click", () => {
      state.activeTab = tab.id;
      renderResult(state.result);
    });
    tabBar.append(button);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = tab.id !== state.activeTab;
    panel.innerHTML = tab.locked && tab.id !== "translation" ? lockedPanel(tab.label) : panelHtml(tab.id, data);
    panels.append(panel);
  }
}

function lockedPanel(label) {
  return `<div class="locked">
    <h4>${escapeHtml(label)} — réservé aux membres</h4>
    <p>La formule Essentiel rend la traduction telle quelle, sans interprétation.
    La formule Membre y ajoute la posologie détaillée, les interactions, les valeurs hors normes
    et les échéances à ne pas manquer.</p>
    <p><a class="btn btn-primary btn-sm" href="#offres">Voir la formule Membre</a></p>
  </div>`;
}

function panelHtml(id, data) {
  if (id === "translation") {
    const summary = data.summary
      ? `<p class="result-meta"><strong>Résumé :</strong> ${escapeHtml(data.summary)}</p>`
      : "";
    return `${summary}<pre class="translation">${escapeHtml(data.translation ?? "")}</pre>`;
  }
  if (id === "cautions") {
    const items = data.cautions ?? [];
    if (!items.length) return empty("Aucun point de vigilance identifié dans ce document.");
    const severity = { urgent: "À traiter sans délai", attention: "Attention", info: "Information" };
    return `<ul class="cards">${items
      .map(
        (item) => `<li class="card ${escapeHtml(item.severity ?? "info")}">
          <span class="sev">${escapeHtml(severity[item.severity] ?? "Information")}</span>
          <strong>${escapeHtml(item.title ?? "")}</strong>
          <p>${escapeHtml(item.detail ?? "")}</p>
        </li>`,
      )
      .join("")}</ul>`;
  }
  if (id === "glossary") {
    const items = data.glossary ?? [];
    if (!items.length) return empty("Aucun terme technique à expliciter.");
    return `<table class="glossary"><thead><tr><th>Terme (source)</th><th>Traduction</th><th>Explication</th></tr></thead><tbody>${items
      .map(
        (item) =>
          `<tr><td>${escapeHtml(item.source ?? "")}</td><td>${escapeHtml(item.target ?? "")}</td><td>${escapeHtml(item.explanation ?? "")}</td></tr>`,
      )
      .join("")}</tbody></table>`;
  }
  const list = id === "questions" ? (data.questions_for_doctor ?? []) : (data.follow_up ?? []);
  if (!list.length) return empty("Rien à signaler pour cette rubrique.");
  return `<ul class="plain-list">${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function empty(message) {
  return `<p class="result-meta">${escapeHtml(message)}</p>`;
}

$("#copy-btn").addEventListener("click", async () => {
  if (!state.result?.translation) return;
  try {
    await navigator.clipboard.writeText(state.result.translation);
    $("#copy-btn").textContent = "Copié ✓";
    setTimeout(() => ($("#copy-btn").textContent = "Copier la traduction"), 1800);
  } catch {
    showError("Copie impossible : votre navigateur l'a refusée.");
  }
});

function showError(message) {
  const box = $("#error");
  box.textContent = message;
  box.hidden = false;
}

function escapeText(value) {
  return String(value ?? "");
}

function escapeHtml(value) {
  return escapeText(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

boot();
