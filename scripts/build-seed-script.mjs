import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(root, "dist", "scripts");

await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(root, "scripts", "seed-playwright-session.ts")],
  outfile: path.join(outputDirectory, "seed-playwright-session.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: ["node22"],
  // `wrangler` is a large CLI package with its own dynamic requires; bundling it in has no upside
  // here and risks breaking those. It's already a resolvable dependency at runtime from this
  // project's own node_modules, same as any other script invoked via `node`.
  external: ["wrangler"],
  legalComments: "none",
  sourcemap: false,
  logLevel: "info",
});

console.log(`Built local session-seed script in ${path.relative(root, outputDirectory)}.`);
