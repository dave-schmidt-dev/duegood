import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "scripts", "canvas-browser-session-capture.mjs");
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;

/** Loads current capture source into the existing broker without closing its Chrome context. */
export async function loadCurrentCanvasCapture({ entry = ENTRY, bundle = build } = {}) {
  const result = await bundle({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  if (result.outputFiles?.length !== 1 || result.outputFiles[0].contents.length > MAX_BUNDLE_BYTES) {
    throw new Error("CAPTURE_RUNTIME_REJECTED");
  }
  const source = Buffer.from(result.outputFiles[0].contents).toString("base64");
  const runtime = await import(`data:text/javascript;base64,${source}`);
  if (typeof runtime.runCanvasCapture !== "function") throw new Error("CAPTURE_RUNTIME_REJECTED");
  return runtime.runCanvasCapture;
}
