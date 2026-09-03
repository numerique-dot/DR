import { $, boot, escapeHtml, isMember, notify, onSessionChange, state } from "/shared.js";

/** Studio de traduction de documents : dépôt, traduction, notice, historique. */
const studio = { file: null, result: null, activeTab: "translation", history: [], historyId: null };

const MAX_FILE = 9 * 1024 * 1024;
const LANG_LABEL = { zh: "中文 (simplifié)", en: "English", fr: "Français" };

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
  if (file.size > MAX_FILE) return studioError("Fichier trop volumineux : 9 Mo maximum.");
  studio.file = file;
  $("#file-name").textContent = `${file.name} — ${(file.size / 1024).toFixed(0)} ko`;
  $("#error").hidden = true;
}

/* ---------- Traduction ---------- */
$("#translate-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!studio.file) return studioError("Déposez d'abord un document à traduire.");

  const tier = (isMember() ? "member" : "free");
  const target = document.querySelector('input[name="target"]:checked').value;
  const button = $("#submit-btn");

  button.disabled = true;
  $("#error").hidden = true;
  $("#loading").hidden = false;

  try {
    const payload = {
      tier,
      target,
      fileName: studio.file.name,
      mediaType: studio.file.type,
      // Sans coche explicite, rien n'est conservé.
      save: state.historyEnabled && document.querySelector("#save-history")?.checked === true,
    };
    if (isTextFile(studio.file)) payload.text = await studio.file.text();
    else payload.dataBase64 = await toBase64(studio.file);

    const response = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "La traduction a échoué.");
    studio.result = data;
    studio.activeTab = "translation";
    renderResult(data);
    if (data.tier === "member" && state.historyEnabled) loadHistory();
  } catch (error) {
    studioError(error.message);
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
    button.setAttribute("aria-selected", String(tab.id === studio.activeTab));
    button.innerHTML = `${escapeHtml(tab.label)}${tab.count ? ` <span class="tab-count">${tab.count}</span>` : ""}${tab.locked ? " 🔒" : ""}`;
    button.addEventListener("click", () => {
      studio.activeTab = tab.id;
      renderResult(studio.result);
    });
    tabBar.append(button);

    const panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = tab.id !== studio.activeTab;
    panel.innerHTML = tab.locked && tab.id !== "translation" ? lockedPanel(tab.label) : panelHtml(tab.id, data);
    panels.append(panel);
  }
}

function lockedPanel(label) {
  return `<div class="locked">
    <h4>${escapeHtml(label)} — réservé aux membres</h4>
    <p>La formule Essentiel rend la traduction telle quelle, sans interprétation.
    La formule Membre y ajoute les montants et les échéances, la durée d'engagement,
    les conditions de résiliation et les pièces à fournir.</p>
    <p><button class="btn btn-primary btn-sm" type="button" data-auth="subscribe">Devenir membre · 9 €/mois</button></p>
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
  if (!studio.result?.translation) return;
  try {
    await navigator.clipboard.writeText(studio.result.translation);
    $("#copy-btn").textContent = "Copié ✓";
    setTimeout(() => ($("#copy-btn").textContent = "Copier la traduction"), 1800);
  } catch {
    studioError("Copie impossible : votre navigateur l'a refusée.");
  }
});

/* ---------- Historique (membres, si la conservation est activée) ---------- */

async function loadHistory() {
  try {
    const response = await fetch("/api/history");
    if (!response.ok) return;
    studio.history = await response.json();
    renderHistory();
  } catch {
    /* l'historique est un confort, pas un bloqueur */
  }
}

function renderHistory() {
  const list = $("#history-list");
  const detail = $("#history-detail");
  if (!list || !detail) return;
  list.innerHTML = "";

  if (!studio.history?.length) {
    list.innerHTML =
      '<li class="history-empty">Aucun document conservé : cochez « Conserver cette traduction » avant l\'envoi.</li>';
    detail.innerHTML = '<p class="history-empty">Sélectionnez un document pour revoir sa traduction et sa notice.</p>';
    return;
  }

  for (const row of studio.history) {
    const item = document.createElement("li");
    if (row.id === studio.historyId) item.classList.add("is-active");
    const date = new Date(row.createdAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
    item.innerHTML = `
      <button class="h-open" type="button">${escapeHtml(row.document_type || row.fileName)}</button>
      <span class="h-meta">${escapeHtml(row.fileName)} → ${escapeHtml(LANG_LABEL[row.target] ?? row.target)} · ${escapeHtml(date)}</span>
      <span class="h-meta">${row.cautions.length} point(s) de vigilance</span>
      <span class="h-actions"><button class="link" type="button">Supprimer</button></span>`;
    item.querySelector(".h-open").addEventListener("click", () => {
      studio.historyId = row.id;
      renderHistory();
    });
    item.querySelector(".h-actions .link").addEventListener("click", () => removeHistory(row.id));
    list.append(item);
  }

  const active = studio.history.find((row) => row.id === studio.historyId);
  detail.innerHTML = active
    ? `<h3>${escapeHtml(active.document_type || active.fileName)}</h3>
       <p class="result-meta">${escapeHtml(active.fileName)} → ${escapeHtml(LANG_LABEL[active.target] ?? active.target)}</p>
       ${panelHtml("translation", active)}
       <h4>注意事项</h4>${panelHtml("cautions", active)}
       <h4>Suivi</h4>${panelHtml("follow", active)}`
    : '<p class="history-empty">Sélectionnez un document pour revoir sa traduction et sa notice.</p>';
}

async function removeHistory(id) {
  if (!confirm("Supprimer définitivement ce document de votre historique ?")) return;
  const response = await fetch(`/api/history/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) return studioError("Suppression impossible.");
  if (studio.historyId === id) studio.historyId = null;
  await loadHistory();
}

function studioError(message) {
  const box = $("#error");
  if (!box) return notify(message);
  box.textContent = message;
  box.hidden = false;
}

/* Le studio suit la session : palier, conservation, historique. */
onSessionChange(() => {
  const badge = $("#ai-mode");
  if (badge) {
    const modes = [state.aiMode === "live" ? "IA connectée · Claude" : "Mode démonstration (aucune clé API)"];
    if (state.billingMode === "stub") modes.push("paiement simulé");
    badge.textContent = modes.join(" · ");
  }
  const member = isMember();
  const memberRadio = document.querySelector('input[name="tier"][value="member"]');
  const freeRadio = document.querySelector('input[name="tier"][value="free"]');
  if (memberRadio && freeRadio) {
    memberRadio.disabled = !member;
    if (member) memberRadio.checked = true;
    else freeRadio.checked = true;
  }
  const saveField = $("#save-field");
  if (saveField) saveField.hidden = !(member && state.historyEnabled);
  const historique = $("#historique");
  if (historique) {
    const show = member && state.historyEnabled;
    historique.hidden = !show;
    if (show) loadHistory();
  }
});

boot();
