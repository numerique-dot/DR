/**
 * Construit une prévisualisation autonome du site : un seul fichier HTML,
 * avec la feuille de style, la police, les quatre pages et une API simulée en
 * mémoire à la place du serveur. Rien n'est envoyé nulle part ; recharger
 * remet les données de démonstration.
 *
 *   node scripts/build-preview.mjs  →  preview/index.html
 */
import fs from "node:fs";
import path from "node:path";

process.env.DATABASE_FILE = ":memory:";
const { dictionary, LOCALES } = await import("../src/i18n.js");
const { CATEGORIES } = await import("../src/db.js");

const PUBLIC = path.resolve("public");
const read = (file) => fs.readFileSync(path.join(PUBLIC, file), "utf8");
const demo = fs.readFileSync(path.resolve("src/demo-translation.json"), "utf8");

/* ---------- Pages : on garde le <main> de chacune ---------- */

const mainOf = (html) => html.match(/<main[^>]*>[\s\S]*?<\/main>/)[0];
const pages = {
  accueil: mainOf(read("index.html")),
  reserver: mainOf(read("reserver.html")),
  pro: mainOf(read("pro.html")),
  traduction: mainOf(read("traduction.html")),
  moderation: mainOf(read("moderation.html")),
  "mentions-legales": mainOf(read("mentions-legales.html")),
  confidentialite: mainOf(read("confidentialite.html")),
  cgu: mainOf(read("cgu.html")),
  accessibilite: mainOf(read("accessibilite.html")),
};

// Les liens internes deviennent des routes par ancre.
const ROUTES = ["reserver", "pro", "traduction", "moderation", "mentions-legales", "confidentialite", "cgu", "accessibilite"];
function relink(html) {
  html = html.replace(/href="\/(#[^"]*)?"/g, 'href="#/"');
  for (const route of ROUTES) {
    html = html.replace(new RegExp(`href="/${route}(#[^"]*)?"`, "g"), `href="#/${route}"`);
  }
  return html.replace(/href="\/reinitialiser[^"]*"/g, 'href="#/"');
}

const header = relink(read("index.html").match(/<header class="topbar">[\s\S]*?<\/header>/)[0]);
const footer = relink(read("index.html").match(/<footer class="footer">[\s\S]*?<\/footer>/)[0]);
const dialogs = relink(read("index.html").match(/<dialog id="forgot"[\s\S]*<\/dialog>\s*<dialog id="auth"[\s\S]*?<\/dialog>/)[0]);
const bookingDialog = read("reserver.html").match(/<dialog id="booking-dialog"[\s\S]*?<\/dialog>/)[0];

/* ---------- Style et police, en ligne ---------- */

const fontFace = read("fonts.css").replace(/url\(\/fonts\/([^)]+)\)/g, (_, file) => {
  const data = fs.readFileSync(path.join(PUBLIC, "fonts", file)).toString("base64");
  return `url(data:font/woff2;base64,${data})`;
});
const css = read("styles.css");

/* ---------- Scripts : modules ES fondus dans un seul script classique ---------- */

const stripImports = (code) => code.replace(/^import[\s\S]*?from\s+"[^"]+";\n/gm, "");
const SHARED_EXPORTS = [
  "$", "state", "onSessionChange", "escapeHtml", "t", "notify", "isMember", "formatDateTime", "formatTime",
  "formatPrice", "boot", "applyDictionary", "renderAccount", "openAuth", "subscribe", "setupTabs",
];

let shared = stripImports(read("shared.js")).replace(/^export /gm, "");
// Les onglets d'une page ne doivent pas piloter l'ancre de la prévisualisation.
shared = shared.replace("    if (window.location.hash.slice(1) !== name) history.replaceState(null, \"\", `#${name}`);\n", "");
const sharedScript = `const Shared = (() => {\n${shared}\nreturn { ${SHARED_EXPORTS.join(", ")} };\n})();`;

let card = stripImports(read("booking-card.js")).replace(/^export /gm, "");
const cardScript = `(() => {\nconst { ${SHARED_EXPORTS.join(", ")} } = Shared;\n${card}\nShared.bookingCard = bookingCard;\nShared.toggleThread = toggleThread;\n})();`;

function pageScript(file, page) {
  let code = stripImports(read(file));
  // Les onglets et les listes d'onglets restent dans la section de la page.
  code = code.replace(/setupTabs\(/g, "setupTabsScoped(");
  code = code.replace(/document\.querySelectorAll\("\.app-tab"\)/g, 'root.querySelectorAll(".app-tab")');
  // La sélection d'onglet d'après l'ancre n'a plus de sens ici.
  code = code.replace(/window\.location\.hash\.slice\(1\)/g, '""');
  return `(() => {\nconst root = document.querySelector('[data-page="${page}"]');\nconst { ${SHARED_EXPORTS.filter((n) => n !== "setupTabs").join(", ")} } = Shared;\nconst setupTabsScoped = (cb) => Shared.setupTabs(cb, root);\nconst bookingCard = Shared.bookingCard;\n${code}\n})();`;
}

const pageScripts = [
  pageScript("reserver.js", "reserver"),
  pageScript("pro.js", "pro"),
  pageScript("studio.js", "traduction"),
  pageScript("moderation.js", "moderation"),
].join("\n\n");

/* ---------- API simulée ---------- */

const mockApi = fs.readFileSync(path.resolve("scripts/preview-api.js"), "utf8")
  .replace("__DICTIONARIES__", JSON.stringify(Object.fromEntries(Object.keys(LOCALES).map((l) => [l, dictionary(l)]))))
  .replace("__LOCALES__", JSON.stringify(LOCALES))
  .replace("__CATEGORIES__", JSON.stringify(CATEGORIES))
  .replace("__DEMO_TRANSLATION__", demo);

/* ---------- Routeur et bandeau de prévisualisation ---------- */

const router = `
(() => {
  const sections = [...document.querySelectorAll("[data-page]")];
  const show = () => {
    const wanted = (window.location.hash.replace(/^#\\/?/, "") || "accueil").split("#")[0];
    const target = sections.some((s) => s.dataset.page === wanted) ? wanted : "accueil";
    for (const s of sections) s.hidden = s.dataset.page !== target;
    for (const a of document.querySelectorAll(".topbar nav a")) {
      a.toggleAttribute("aria-current", a.getAttribute("href") === "#/" + target);
    }
    window.scrollTo({ top: 0 });
  };
  window.addEventListener("hashchange", show);
  show();

  // Connexions rapides du bandeau de prévisualisation.
  document.querySelector("#preview-bar")?.addEventListener("click", async (event) => {
    const as = event.target.closest("[data-login-as]")?.dataset.loginAs;
    if (!as) return;
    await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: as, password: "motdepassesolide" }) });
    await Shared.boot();
    Shared.notify("Connecté : " + as);
    if (as.startsWith("moderation")) window.location.hash = "#/moderation";
    else if (as.startsWith("studio")) window.location.hash = "#/pro";
    else window.location.hash = "#/reserver";
  });
})();`;

const previewBar = `
<div id="preview-bar" class="preview-bar" role="region" aria-label="Prévisualisation">
  <strong>Prévisualisation</strong>
  <span>Site complet avec un serveur simulé dans votre navigateur : tout fonctionne, rien n'est envoyé, recharger remet les données d'exemple.</span>
  <span class="preview-logins">Se connecter comme
    <button type="button" class="link" data-login-as="wei@example.com">client Wei</button> ·
    <button type="button" class="link" data-login-as="studio.lin@example.com">commerçant Lin (中文)</button> ·
    <button type="button" class="link" data-login-as="moderation@drdu.example">modération</button>
  </span>
</div>`;

const previewCss = `
.preview-bar { display: flex; flex-wrap: wrap; gap: .4rem 1rem; align-items: baseline; padding: .55rem var(--gutter); background: #ffe552; color: #161621; font-size: .82rem; border-bottom: 1px solid #d8c23a; }
.preview-bar .link { color: #000091; }
[data-page][hidden] { display: none !important; }
/* Dans la prévisualisation, la notification descend en bas pour ne pas masquer le bandeau. */
.notice { top: auto; bottom: 0; animation: none; }
`;

/* ---------- Assemblage ---------- */

const sectionsHtml = Object.entries(pages)
  .map(([page, main]) => `<div data-page="${page}" hidden>\n${relink(main)}\n</div>`)
  .join("\n\n");

const html = `<title>D.R. RDV</title>
<style>
${fontFace}
${css}
${previewCss}
</style>
<a class="skip" href="#contenu">Aller au contenu</a>
<p id="notice" class="notice" role="status" hidden></p>
${previewBar}
${header}
${sectionsHtml}
${footer}
${bookingDialog}
${dialogs}
<script>
${mockApi}
${sharedScript}
${cardScript}
${pageScripts}
${router}
</script>
`;

fs.writeFileSync(path.resolve("preview/index.html"), html);
const size = (fs.statSync(path.resolve("preview/index.html")).size / 1024).toFixed(0);
console.log(`preview/index.html écrit (${size} Ko)`);
