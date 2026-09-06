/*
 * Service worker de D.R. RDV.
 *
 * Stratégie volontairement simple et sûre :
 *  - /api/*        : réseau uniquement, jamais mis en cache (données personnelles, sessions).
 *  - pages HTML    : réseau d'abord, repli sur le cache puis sur la page hors ligne.
 *  - statiques     : cache d'abord, rafraîchi en arrière-plan (stale-while-revalidate).
 *
 * VERSION change à chaque déploiement modifiant le socle ; les anciens caches sont purgés.
 */
const VERSION = "v1";
const CACHE = `drrdv-${VERSION}`;

const SHELL = [
  "/",
  "/reserver",
  "/pro",
  "/traduction",
  "/hors-ligne",
  "/styles.css",
  "/fonts.css",
  "/shared.js",
  "/reserver.js",
  "/booking-card.js",
  "/pro.js",
  "/studio.js",
  "/landing.js",
  "/icone.svg",
  "/icones/icone-192.png",
  "/fonts/inter-latin.woff2",
  "/fonts/inter-latin-ext.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

function isHtml(request) {
  return request.mode === "navigate" || (request.headers.get("accept") ?? "").includes("text/html");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;

  if (isHtml(request)) {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = (await cache.match(request)) ?? (await cache.match(new URL(request.url).pathname));
    return cached ?? (await cache.match("/hors-ligne")) ?? Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? refresh;
}
