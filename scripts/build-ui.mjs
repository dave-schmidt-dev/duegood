import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist", "public");
const stylesDirectory = path.join(root, "src", "ui", "styles");

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

const serviceWorker = `self.addEventListener("install",event=>{event.waitUntil(self.skipWaiting())});self.addEventListener("activate",event=>{event.waitUntil(self.clients.claim())});`;

// Concatenated in token/shell/component order so later rules (component-specific) can override
// earlier ones (shell-generic) at equal specificity, same as the source layout under src/ui/styles/.
const css = (
  await Promise.all(
    ["tokens.css", "shell.css", "components.css"].map((file) => readFile(path.join(stylesDirectory, file), "utf8")),
  )
).join("\n");

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
