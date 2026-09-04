/**
 * Socle commun aux pages : session, barre de compte, dialogue d'inscription,
 * abonnement, notifications, et langue de l'interface.
 */
export const $ = (sel, root = document) => root.querySelector(sel);

export const state = {
  user: null,
  merchant: null,
  locale: "fr",
  dictionary: {},
  categories: {},
  billingMode: "stub",
  historyEnabled: false,
  aiMode: "demo",
};

const listeners = new Set();
export function onSessionChange(callback) {
  listeners.add(callback);
}
function announce() {
  for (const callback of listeners) callback(state);
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

/** Libellé d'interface ; à défaut, la clé elle-même, pour repérer les oublis. */
export function t(key) {
  return state.dictionary[key] ?? key;
}

export function notify(message) {
  const box = $("#notice");
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => (box.hidden = true), 6000);
}

export function isMember() {
  return state.user?.tier === "member";
}

/** Formats localisés : dates, heures et montants suivent la langue choisie. */
const LOCALE_TAGS = { fr: "fr-FR", zh: "zh-CN", en: "en-GB" };
export function formatDateTime(iso) {
  return new Date(iso).toLocaleString(LOCALE_TAGS[state.locale] ?? "fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function formatTime(iso) {
  return new Date(iso).toLocaleTimeString(LOCALE_TAGS[state.locale] ?? "fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
export function formatPrice(cents) {
  return new Intl.NumberFormat(LOCALE_TAGS[state.locale] ?? "fr-FR", {
    style: "currency",
    currency: "EUR",
  }).format(cents / 100);
}

/* ---------- Amorçage ---------- */

export async function boot() {
  try {
    const config = await (await fetch("/api/config")).json();
    Object.assign(state, {
      user: config.user,
      merchant: config.merchant,
      locale: config.locale ?? "fr",
      dictionary: config.dictionary ?? {},
      categories: config.categories ?? {},
      billingMode: config.billingMode,
      historyEnabled: config.historyEnabled,
      aiMode: config.aiMode,
    });
  } catch {
    notify("Service momentanément indisponible.");
  }
  applyDictionary();
  renderAccount();
  const select = $("#locale-select");
  if (select) select.value = state.locale;
  announce();
  await handleBillingReturn();
  return state;
}

/** Applique le dictionnaire aux éléments porteurs de data-i18n. */
export function applyDictionary() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    const value = state.dictionary[node.dataset.i18n];
    if (value) node.textContent = value;
  }
  document.documentElement.lang = state.locale;
}

$("#locale-select")?.addEventListener("change", async (event) => {
  const locale = event.target.value;
  if (state.user) {
    const response = await fetch("/api/locale", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale }),
    });
    const data = await response.json();
    if (response.ok) {
      state.locale = data.locale;
      state.dictionary = data.dictionary;
    }
  } else {
    // Sans compte, la langue vaut pour la visite en cours.
    const config = await (await fetch(`/api/config?lang=${locale}`)).json();
    state.locale = locale;
    state.dictionary = config.dictionary ?? state.dictionary;
  }
  applyDictionary();
  announce();
});

/* ---------- Barre de compte ---------- */

export function renderAccount() {
  const box = $("#account");
  if (!box) return;
  if (!state.user) {
    box.innerHTML = `<button class="btn btn-ghost btn-sm" type="button" data-auth="login">${escapeHtml(
      t("account.login"),
    )}</button>
      <button class="btn btn-primary btn-sm" type="button" data-auth="signup">${escapeHtml(t("account.signup"))}</button>`;
    return;
  }
  box.innerHTML = `<span class="who">${escapeHtml(state.user.name)}${isMember() ? " · Membre" : ""}</span>
    ${state.user.admin ? '<a class="btn btn-ghost btn-sm" href="/moderation">Modération</a>' : ""}
    <button class="btn btn-ghost btn-sm" type="button" data-auth="logout">${escapeHtml(t("account.logout"))}</button>`;
}

document.addEventListener("click", (event) => {
  const action = event.target.closest("[data-auth]")?.dataset.auth;
  if (!action) return;
  if (action === "logout") return void logout();
  if (action === "subscribe") return void subscribe();
  if (action === "manage") return void manageSubscription();
  if (action === "forgot") return void openForgot();
  openAuth(action);
});

/* ---------- Inscription et connexion ---------- */

let authMode = "signup";
let authIntent = null;

export function openAuth(mode, intent = null) {
  const dialog = $("#auth");
  if (!dialog) return;
  authMode = mode;
  authIntent = intent;
  const form = $("#auth-form");
  form.reset();
  $("#auth-error").hidden = true;
  $("#auth-title").textContent = mode === "signup" ? "Créer un compte" : "Se connecter";
  $("#auth-intro").textContent =
    mode === "signup"
      ? "Un compte suffit pour réserver, et pour inscrire un établissement."
      : "Retrouvez vos réservations et votre établissement.";
  $("#auth-name-field").hidden = mode !== "signup";
  $("#auth-submit").textContent = mode === "signup" ? "Créer mon compte" : "Se connecter";
  $("#auth-switch").innerHTML =
    mode === "signup"
      ? 'Déjà inscrit ? <button type="button" class="link" data-auth="login">Se connecter</button>'
      : `Pas encore de compte ? <button type="button" class="link" data-auth="signup">Créer un compte</button>
         <br /><button type="button" class="link" data-auth="forgot">Mot de passe oublié ?</button>`;
  if (dialog.open) dialog.close();
  dialog.showModal();
}

$("#auth-form")?.addEventListener("submit", async (event) => {
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
    state.locale = data.user.locale ?? state.locale;
    $("#auth").close();
    // La session change : on relit la configuration (établissement, langue).
    await boot();
    if (authIntent === "subscribe" && !isMember()) return void subscribe();
  } catch (error) {
    const box = $("#auth-error");
    box.textContent = error.message;
    box.hidden = false;
  } finally {
    button.disabled = false;
  }
});

for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dialog.close("cancel");
  });
}

async function logout() {
  await fetch("/api/auth/logout", { method: "POST" });
  state.user = null;
  state.merchant = null;
  renderAccount();
  announce();
  notify("Vous êtes déconnecté.");
}

/* ---------- Abonnement (formule Membre du studio de traduction) ---------- */

export async function subscribe() {
  if (!state.user) return openAuth("signup", "subscribe");
  try {
    const response = await fetch("/api/billing/checkout", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Souscription impossible.");
    if (data.url) return void (window.location.href = data.url);
    state.user = data.user;
    renderAccount();
    announce();
    notify("Formule Membre active.");
  } catch (error) {
    notify(error.message);
  }
}

async function manageSubscription() {
  try {
    const response = await fetch("/api/billing/portal", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Espace de gestion indisponible.");
    if (data.url) return void (window.location.href = data.url);
    state.user = data.user;
    renderAccount();
    announce();
    notify("Abonnement résilié.");
  } catch (error) {
    notify(error.message);
  }
}

async function handleBillingReturn() {
  const status = new URLSearchParams(window.location.search).get("abonnement");
  if (!status) return;
  history.replaceState(null, "", window.location.pathname + window.location.hash);
  if (status === "annule") return notify("Souscription abandonnée.");
  for (let attempt = 0; attempt < 5; attempt++) {
    const { user } = await (await fetch("/api/auth/me")).json();
    state.user = user;
    renderAccount();
    announce();
    if (user?.tier === "member") return notify("Paiement confirmé.");
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  notify("Paiement enregistré ; l'activation peut prendre quelques instants.");
}

/* ---------- Onglets et effets communs ---------- */

/** Onglets d'une page : chaque bouton [data-view] montre la section #view-<nom>. */
export function setupTabs(onChange) {
  const tabs = [...document.querySelectorAll(".app-tab")];
  if (!tabs.length) return () => {};
  const show = (name) => {
    for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.view === name));
    for (const section of document.querySelectorAll(".app-view")) {
      section.hidden = section.id !== `view-${name}`;
    }
    if (window.location.hash.slice(1) !== name) history.replaceState(null, "", `#${name}`);
    onChange?.(name);
  };
  for (const tab of tabs) tab.addEventListener("click", () => show(tab.dataset.view));
  return show;
}

const topbar = document.querySelector(".topbar");
if (topbar) {
  const onScroll = () => topbar.classList.toggle("is-stuck", window.scrollY > 8);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

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

/* ---------- Mot de passe oublié ---------- */

/**
 * La réponse du serveur est volontairement la même que l'adresse existe ou non :
 * l'interface ne doit donc pas laisser deviner le contraire.
 */
function openForgot() {
  const dialog = $("#forgot");
  if (!dialog) return;
  $("#forgot-form").reset();
  $("#forgot-error").hidden = true;
  $("#forgot-done").hidden = true;
  $("#forgot-fields").hidden = false;
  if ($("#auth")?.open) $("#auth").close();
  dialog.showModal();
}

$("#forgot-form")?.addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const button = $("#forgot-submit");
  button.disabled = true;
  try {
    const response = await fetch("/api/auth/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: event.target.elements.email.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Demande impossible.");
    $("#forgot-fields").hidden = true;
    $("#forgot-done").textContent = data.message;
    $("#forgot-done").hidden = false;
  } catch (error) {
    const box = $("#forgot-error");
    box.textContent = error.message;
    box.hidden = false;
  } finally {
    button.disabled = false;
  }
});
