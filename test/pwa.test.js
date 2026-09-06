import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolatedDatabase, startServer } from "./helpers.js";

/* Application installable : manifeste, icônes, service worker, page hors ligne. */

const database = isolatedDatabase();
let app;

before(async () => {
  app = await startServer();
});
after(() => {
  app.close();
  database.cleanup();
});

describe("application web installable", () => {
  it("sert un manifeste valide dont toutes les icônes existent", async () => {
    const { status, headers, body } = await app.get("/site.webmanifest");
    assert.equal(status, 200);
    assert.match(headers.get("content-type"), /manifest\+json/);
    assert.equal(body.short_name, "D.R. RDV");
    assert.equal(body.display, "standalone");
    const sizes = body.icons.map((icon) => icon.sizes);
    assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
    assert.ok(body.icons.some((icon) => icon.purpose === "maskable"));
    for (const icon of [...body.icons, ...body.shortcuts.flatMap((s) => s.icons)]) {
      assert.ok(fs.existsSync(path.join("public", icon.src)), `icône manquante : ${icon.src}`);
    }
    for (const shortcut of body.shortcuts) {
      const page = shortcut.url.replace(/[?#].*$/, "");
      const { status: pageStatus } = await app.get(page, { raw: true });
      assert.equal(pageStatus, 200, `raccourci cassé : ${shortcut.url}`);
    }
  });

  it("sert le service worker sans mise en cache longue", async () => {
    const { status, headers, body: text } = await app.get("/sw.js", { raw: true });
    assert.equal(status, 200);
    assert.match(headers.get("content-type"), /javascript/);
    assert.equal(headers.get("cache-control"), "no-cache");
    assert.match(text, /addEventListener\("fetch"/);
    assert.match(text, /\/api\//, "les appels API doivent être exclus du cache");
  });

  it("précharge un socle dont chaque URL répond", async () => {
    const { body: text } = await app.get("/sw.js", { raw: true });
    const shell = [...text.matchAll(/^\s+"(\/[^"]*)",$/gm)].map((m) => m[1]);
    assert.ok(shell.length >= 10);
    for (const url of shell) {
      const { status } = await app.get(url, { raw: true });
      assert.equal(status, 200, `socle : ${url}`);
    }
  });

  it("sert les icônes PNG avec un cache long", async () => {
    const { status, headers } = await app.get("/icones/icone-512.png", { raw: true });
    assert.equal(status, 200);
    assert.equal(headers.get("content-type"), "image/png");
    assert.match(headers.get("cache-control"), /immutable/);
  });

  it("propose une page hors ligne", async () => {
    const { status, body: text } = await app.get("/hors-ligne", { raw: true });
    assert.equal(status, 200);
    assert.match(text, /hors ligne/i);
    assert.match(text, /网络/);
  });

  it("déclare l'icône Apple et le manifeste sur chaque page applicative", () => {
    for (const page of ["index", "reserver", "pro", "traduction", "moderation", "reinitialiser"]) {
      const html = fs.readFileSync(path.join("public", `${page}.html`), "utf8");
      assert.match(html, /rel="manifest"/, page);
      assert.match(html, /rel="apple-touch-icon"/, page);
    }
  });

  it("traduit les libellés d'installation dans les trois langues", async () => {
    for (const lang of ["fr", "zh", "en"]) {
      const { body } = await app.get(`/api/config?lang=${lang}`);
      assert.ok(body.dictionary["app.install"], lang);
      assert.ok(body.dictionary["app.install.button"], lang);
    }
  });
});
