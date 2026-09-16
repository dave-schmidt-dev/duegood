import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist", "public");

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Due Good</title>
    <link rel="stylesheet" href="/app.css">
    <script type="module" src="/app.js"></script>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <div id="app"></div>
  </body>
</html>
`;

const css = `:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f1e9;color:#1f2937}*{box-sizing:border-box}body{margin:0;min-height:100vh}.skip-link{position:absolute;left:-999px;top:0}.skip-link:focus{left:1rem;top:1rem;background:#fff;color:#0e2a47;padding:.75rem;outline:3px solid #b08d57}.shell{min-height:100vh;display:grid;place-items:center;padding:2rem}.panel{width:min(42rem,100%);background:#fff;border:1px solid #c7c1b5;border-radius:.75rem;padding:clamp(1.5rem,5vw,3rem);box-shadow:0 .5rem 2rem rgb(14 42 71/.08)}.eyebrow{color:#5a6f47;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{color:#0e2a47;font-family:Georgia,serif;font-size:clamp(2rem,6vw,3.25rem);margin:.25rem 0 1rem}p{line-height:1.6}.status{border-left:.25rem solid #b08d57;padding:.75rem 1rem;background:#f4f1e9}.status strong{display:block;color:#0e2a47}@media (prefers-color-scheme:dark){:root{background:#101820;color:#edf2f7}.panel{background:#172433;border-color:#41556a}.eyebrow{color:#a9bc99}h1,.status strong{color:#f1d7a6}.status{background:#202f3f}}`;

const serviceWorker = `self.addEventListener("install",event=>{event.waitUntil(self.skipWaiting())});self.addEventListener("activate",event=>{event.waitUntil(self.clients.claim())});`;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "ui", "router.ts")],
  outfile: path.join(outputDirectory, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
});
await Promise.all([
  writeFile(path.join(outputDirectory, "index.html"), html, "utf8"),
  writeFile(path.join(outputDirectory, "app.css"), css, "utf8"),
  writeFile(path.join(outputDirectory, "sw.js"), serviceWorker, "utf8"),
]);

console.log(`Built static browser shell in ${path.relative(root, outputDirectory)}.`);
