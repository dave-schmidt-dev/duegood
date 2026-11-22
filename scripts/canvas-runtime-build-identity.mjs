import path from "node:path";
import { readCanvasBuildIdentity } from "./canvas-helper-provenance.mjs";

function isPackagedRuntime(runtimeRoot) {
  const resolvedRoot = path.resolve(runtimeRoot);
  const resourcesDirectory = path.dirname(resolvedRoot);
  const contentsDirectory = path.dirname(resourcesDirectory);
  return path.basename(resolvedRoot) === "browser-runtime"
    && path.basename(resourcesDirectory) === "Resources"
    && path.basename(contentsDirectory) === "Contents";
}

/** Read only the identity embedded beside a packaged app runtime. */
/** @param {{ runtimeRoot: string, readIdentity?: typeof readCanvasBuildIdentity }} options */
export async function readRuntimeBuildIdentity({
  runtimeRoot,
  readIdentity = readCanvasBuildIdentity,
} = {}) {
  if (!isPackagedRuntime(runtimeRoot)) return undefined;
  const metadataPath = path.join(runtimeRoot, "..", "duegood-build.json");
  const identity = await readIdentity({ metadataPath });
  if (!identity) {
    const error = new Error("Packaged Canvas helper provenance is unavailable.");
    error.code = "HELPER_STALE";
    throw error;
  }
  return identity;
}
