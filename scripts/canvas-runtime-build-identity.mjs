import { lstatSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { readCanvasBuildIdentity } from "./canvas-helper-provenance.mjs";

export const DESKTOP_INSTALL_LOCK = ".Due Good.install.lock";

function isPackagedRuntime(runtimeRoot) {
  const resolvedRoot = path.resolve(runtimeRoot);
  const resourcesDirectory = path.dirname(resolvedRoot);
  const contentsDirectory = path.dirname(resourcesDirectory);
  return path.basename(resolvedRoot) === "browser-runtime"
    && path.basename(resourcesDirectory) === "Resources"
    && path.basename(contentsDirectory) === "Contents";
}

/** Read the embedded identity, optionally waiting for the installer to finish publishing helpers.
 * @param {{ runtimeRoot: string, waitForHelpers?: boolean, waitMs?: number, readIdentity?: typeof readCanvasBuildIdentity }} options
 */
export async function readRuntimeBuildIdentity({
  runtimeRoot,
  waitForHelpers = false,
  waitMs = 10 * 60_000,
  readIdentity = readCanvasBuildIdentity,
} = {}) {
  if (!isPackagedRuntime(runtimeRoot)) return undefined;
  if (waitForHelpers) {
    const lock = path.resolve(runtimeRoot, "../../../..", DESKTOP_INSTALL_LOCK);
    const deadline = performance.now() + waitMs;
    while (lstatSync(lock, { throwIfNoEntry: false }) !== undefined) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw Object.assign(new Error("Canvas helper installation has not finished."), { code: "HELPER_STALE" });
      await delay(Math.min(500, remaining));
    }
  }
  const metadataPath = path.join(runtimeRoot, "..", "duegood-build.json");
  const identity = await readIdentity({ metadataPath });
  if (!identity) {
    const error = new Error("Packaged Canvas helper provenance is unavailable.");
    error.code = "HELPER_STALE";
    throw error;
  }
  return identity;
}
