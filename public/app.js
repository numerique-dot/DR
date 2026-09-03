const $ = (sel) => document.querySelector(sel);
const MAX_FILE = 9 * 1024 * 1024;
const LANG_LABEL = { zh: "中文 (simplifié)", en: "English", fr: "Français" };

const state = {
  file: null,
  text: null,
  result: null,
  activeTab: "translation",
  user: null,
  history: [],
  historyId: null,
  billingMode: "stub",
  historyEnabled: false,
};

/* ---------- Amorçage : praticiens + mode IA ---------- */
async function boot() {
  try {
    const config = await (await fetch("/api/config")).json();
    state.user = config.user;
    state.billingMode = config.billingMode;
    state.historyEnabled = config.historyEnabled;
    renderAccount();
    const badge = $("#ai-mode");
    const modes = [config.aiMode === "live" ? "IA connectée · Claude" : "Mode démonstration (aucune clé API)"];
    if (config.billingMode === "stub") modes.push("paiement simulé");
    badge.textContent = modes.join(" · ");
    badge.title =
      config.aiMode === "live"
        ? "Les documents sont traduits par le modèle Claude."
        : "ANTHROPIC_API_KEY n'est pas définie : une notice d'exemple est renvoyée.";
  } catch {
    $("#ai-mode").textContent = "Service indisponible";
  }
}

/** Au retour du paiement, l'abonnement peut n'être actif qu'après le webhook. */
async function handleBillingReturn() {
  const status = new URLSearchParams(window.location.search).get("abonnement");
  if (!status) return;
  history.replaceState(null, "", window.location.pathname + window.location.hash);
  if (status === "annule") return notify("Souscription abandonnée. Votre compte reste en formule Essentiel.");
  for (let attempt = 0; attempt < 5; attempt++) {
    const { user } = await (await fetch("/api/auth/me")).json();
    state.user = user;
    renderAccount();
    if (user?.tier === "member") return notify("Paiement confirmé. Votre formule Membre est active.");
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  notify("Paiement enregistré. L'activation peut prendre quelques instants — rechargez la page.");
}

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
  // Le serveur décide seul du palier d'après la session ; côté client, ceci ne
  // sert qu'à l'affichage.
  return state.user?.tier === "member" ? "member" : "free";
}

/* ---------- Compte ---------- */

function renderAccount() {
  const box = $("#account");
  const memberRadio = document.querySelector('input[name="tier"][value="member"]');
  const freeRadio = document.querySelector('input[name="tier"][value="free"]');

  if (state.user) {
    const member = state.user.tier === "member";
    box.innerHTML = `<span class="who">Bonjour <strong>${escapeHtml(state.user.name)}</strong>${
      member ? " · Membre" : ""
    }</span>${
      member
        ? '<button class="btn btn-ghost btn-sm" type="button" data-auth="manage">Gérer l\'abonnement</button>'
        : '<button class="btn btn-primary btn-sm" type="button" data-auth="subscribe">Devenir membre · 9 €/mois</button>'
    }<button class="btn btn-ghost btn-sm" type="button" data-auth="logout">Se déconnecter</button>`;
  } else {
    box.innerHTML = `<button class="btn btn-ghost btn-sm" type="button" data-auth="login">Se connecter</button>
      <button class="btn btn-primary btn-sm" type="button" data-auth="subscribe">Devenir membre</button>`;
  }

  const isMember = state.user?.tier === "member";
  memberRadio.disabled = !isMember;
  if (isMember) memberRadio.checked = true;
  else freeRadio.checked = true;

  const saveField = document.querySelector("#save-field");
  if (saveField) saveField.hidden = !(isMember && state.historyEnabled);
  const showHistory = isMember && state.historyEnabled;
  $("#historique").hidden = !showHistory;
  if (showHistory) loadHistory();
  else {
    state.history = [];
    state.historyId = null;
  }
}

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-auth]")?.dataset.auth;
  if (!action) return;
  if (action === "logout") return logout();
  if (action === "subscribe") return subscribe();
  if (action === "manage") return manageSubscription();
  openAuth(action);
});

/* ---------- Abonnement ---------- */

/** Souscrire : redirection vers Stripe, ou activation simulée hors production. */
async function subscribe() {
  if (!state.user) return openAuth("signup", "subscribe");
  try {
    const response = await fetch("/api/billing/checkout", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Souscription impossible.");
    if (data.url) return void (window.location.href = data.url);
    state.user = data.user;
    renderAccount();
    if (state.result) renderResult(state.result);
    notify("Formule Membre active. Les points de vigilance sont débloqués.");
  } catch (error) {
    showError(error.message);
  }
}

/** Gérer ou résilier : portail Stripe, ou résiliation simulée hors production. */
async function manageSubscription() {
  try {
    const response = await fetch("/api/billing/portal", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Espace de gestion indisponible.");
    if (data.url) return void (window.location.href = data.url);
    state.user = data.user;
    renderAccount();
    notify("Abonnement résilié. Votre compte reste actif en formule Essentiel.");
  } catch (error) {
    showError(error.message);
  }
}

function notify(message) {
  const box = document.querySelector("#notice");
  box.textContent = message;
  box.hidden = false;
  setTimeout(() => (box.hidden = true), 6000);
}

const authDialog = $("#auth");
let authMode = "signup";
/** Retient si l'utilisateur venait pour souscrire, afin d'enchaîner après connexion. */
let authIntent = null;

function openAuth(mode, intent = null) {
  authIntent = intent;
  authMode = mode;
  const form = $("#auth-form");
  form.reset();
  $("#auth-error").hidden = true;
  $("#auth-title").textContent = mode === "signup" ? "Devenir membre" : "Se connecter";
  $("#auth-intro").textContent =
    mode === "signup"
      ? "La formule Membre débloque les points de vigilance (注意事项) et l'historique de vos documents."
      : "Retrouvez vos documents traduits et vos rendez-vous.";
  $("#auth-name-field").hidden = mode !== "signup";
  $("#auth-submit").textContent = mode === "signup" ? "Créer mon compte" : "Se connecter";
  $("#auth-switch").innerHTML =
    mode === "signup"
      ? 'Déjà membre ? <button type="button" class="link" data-auth="login">Se connecter</button>'
      : 'Pas encore de compte ? <button type="button" class="link" data-auth="signup">Devenir membre</button>';
  if (authDialog.open) authDialog.close();
  authDialog.showModal();
}

$("#auth-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target).entries());
  const button = $("#auth-submit");
  button.disabled = true;
  try {
    const route = authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const response = await fetch(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Connexion impossible.");
    state.user = data.user;
    authDialog.close();
    renderAccount();
    if (state.result) renderResult(state.result);
    if (authIntent === "subscribe" && state.user.tier !== "member") await subscribe();
  } catch (error) {
    const box = $("#auth-error");
    box.textContent = error.message;
    box.hidden = false;
  } finally {
    button.disabled = false;
  }
});

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  state.user = null;
  renderAccount();
  if (state.result) {
    state.result = null;
    $("#result").hidden = true;
    $("#result-empty").hidden = false;
  }
}

/* ---------- Historique des documents (membres) ---------- */

async function loadHistory() {
  try {
    const response = await fetch("/api/history");
    if (!response.ok) return;
    state.history = await response.json();
    renderHistory();
  } catch {
    /* silencieux : l'historique est un confort, pas un bloqueur */
  }
}

function renderHistory() {
  const list = $("#history-list");
  const detail = $("#history-detail");
  list.innerHTML = "";

  if (!state.history.length) {
    list.innerHTML = '<li class="history-empty">Aucun document pour le moment : traduisez une ordonnance et elle apparaîtra ici.</li>';
    detail.innerHTML = '<p class="history-empty">Sélectionnez un document pour revoir sa traduction et sa notice.</p>';
    return;
  }

  for (const row of state.history) {
    const item = document.createElement("li");
    if (row.id === state.historyId) item.classList.add("is-active");
    const date = new Date(row.createdAt).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
    item.innerHTML = `
      <button class="h-open" type="button">${escapeHtml(row.document_type || row.fileName)}</button>
      <span class="h-meta">${escapeHtml(row.fileName)} → ${escapeHtml(LANG_LABEL[row.target] ?? row.target)} · ${escapeHtml(date)}</span>
      <span class="h-meta">${row.cautions.length} point(s) de vigilance</span>
      <span class="h-actions"><button class="link" type="button" data-del="${escapeHtml(row.id)}">Supprimer</button></span>`;
    item.querySelector(".h-open").addEventListener("click", () => {
      state.historyId = row.id;
      renderHistory();
    });
    item.querySelector("[data-del]").addEventListener("click", () => removeHistory(row.id));
    list.append(item);
  }

  const active = state.history.find((row) => row.id === state.historyId);
  if (!active) {
    detail.innerHTML = '<p class="history-empty">Sélectionnez un document pour revoir sa traduction et sa notice.</p>';
    return;
  }
  detail.innerHTML = `<h3>${escapeHtml(active.document_type || active.fileName)}</h3>
    <p class="result-meta">${escapeHtml(active.fileName)} → ${escapeHtml(LANG_LABEL[active.target] ?? active.target)}</p>
    ${panelHtml("translation", active)}
    <h4>注意事项</h4>${panelHtml("cautions", active)}
    <h4>Suivi</h4>${panelHtml("follow", active)}`;
}

async function removeHistory(id) {
  if (!confirm("Supprimer définitivement ce document de votre historique ?")) return;
  const response = await fetch(`/api/history/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) return showError("Suppression impossible.");
  if (state.historyId === id) state.historyId = null;
  await loadHistory();
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
      // Sans coche explicite, rien n'est conservé.
      save: state.historyEnabled && document.querySelector("#save-history")?.checked === true,
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
    if (data.tier === "member" && state.historyEnabled) loadHistory();
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

/* La barre supérieure ne prend son filet qu'une fois la page défilée. */
const topbar = document.querySelector(".topbar");
const onScroll = () => topbar.classList.toggle("is-stuck", window.scrollY > 8);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* Apparition progressive — désactivée si l'utilisateur limite les animations. */
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.querySelectorAll(".reveal").forEach((el) => el.classList.add("is-in"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
  );
  document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));
}

/* Fermeture des dialogues à l'échappement : on rend la main proprement. */
for (const dlg of document.querySelectorAll("dialog")) {
  dlg.addEventListener("cancel", (event) => {
    event.preventDefault();
    dlg.close("cancel");
  });
}

boot();
