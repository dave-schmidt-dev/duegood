import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist", "local");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(root, "scripts", "local-server.mjs")],
  outfile: path.join(output, "server.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  logLevel: "info",
});
console.log("Built local coursework server.");
