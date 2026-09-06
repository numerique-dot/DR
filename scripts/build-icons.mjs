/**
 * Génère les icônes PNG de l'application web à partir de public/icone.svg.
 * Usage : node scripts/build-icons.mjs  (nécessite Chromium via playwright-core)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const svg = fs.readFileSync(path.join(root, "public", "icone.svg"), "utf8");
const out = path.join(root, "public", "icones");
fs.mkdirSync(out, { recursive: true });

// Variante « maskable » : le pictogramme occupe la zone sûre (80 %) sur fond plein.
const maskable = svg.replace(
  /<path /,
  '<g transform="translate(51.2 51.2) scale(0.8)"><path ',
).replace(/<\/svg>/, "</g></svg>");

const targets = [
  { file: "icone-192.png", size: 192, source: svg },
  { file: "icone-512.png", size: 512, source: svg },
  { file: "icone-maskable-512.png", size: 512, source: maskable },
  { file: "apple-touch-icon.png", size: 180, source: svg },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium",
});
try {
  for (const { file, size, source } of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:#000091}svg{display:block;width:${size}px;height:${size}px}</style>${source}`,
    );
    await page.screenshot({ path: path.join(out, file), clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`✓ ${file}`);
  }
} finally {
  await browser.close();
}
