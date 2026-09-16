import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadConfigModule() {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "duegood-config-check-"));
  const outfile = path.join(tempDirectory, "config.mjs");
  try {
    await build({
      entryPoints: [path.join(root, "src", "config.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: ["node20"],
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function stripJsonComments(raw) {
  let result = "";
  let inString = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (inString) {
      result += char;
      if (char === "\\") {
        result += next ?? "";
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      result += char;
    } else if (char === "/" && next === "/") {
      while (index < raw.length && raw[index] !== "\n") index += 1;
      result += "\n";
    } else {
      result += char;
    }
  }
  return result;
}

function parseDevVars(raw) {
  return Object.fromEntries(
    raw
      .split("\n")
      .map((line) => /^([A-Z_]+)="(.*)"$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]),
  );
}

const { resolveAuthConfig, CANVAS_REQUIRED_SCOPE } = await loadConfigModule();

const wranglerRaw = await readFile(path.join(root, "templates", "wrangler.example.jsonc"), "utf8");
const wranglerVars = JSON.parse(stripJsonComments(wranglerRaw)).vars;

const wranglerResult = resolveAuthConfig({
  authMode: "enabled",
  appOrigin: wranglerVars.APP_ORIGIN,
  institutionOrigin: wranglerVars.CANVAS_ORIGIN,
  clientId: wranglerVars.CANVAS_CLIENT_ID,
  clientSecret: "REPLACE_WITH_INSTITUTION_ISSUED_SECRET",
  scope: CANVAS_REQUIRED_SCOPE,
  keyVersion: wranglerVars.TOKEN_KEY_VERSION,
  activeKeyB64: undefined,
  legacyKeysJson: undefined,
});
if (wranglerResult.mode !== "disabled") {
  throw new Error("templates/wrangler.example.jsonc placeholders unexpectedly resolve to an enabled auth config");
}

const devVarsRaw = await readFile(path.join(root, "templates", ".dev.vars.example"), "utf8");
const devVars = parseDevVars(devVarsRaw);

const devVarsResult = resolveAuthConfig({
  authMode: "enabled",
  appOrigin: "https://duegood.example.workers.dev",
  institutionOrigin: "https://marymount.instructure.com",
  clientId: "placeholder-client-id",
  clientSecret: devVars.CANVAS_CLIENT_SECRET,
  scope: CANVAS_REQUIRED_SCOPE,
  keyVersion: "1",
  activeKeyB64: devVars.TOKEN_ENCRYPTION_ACTIVE_KEY_B64,
  legacyKeysJson: devVars.TOKEN_ENCRYPTION_LEGACY_KEYS_JSON,
});
if (devVarsResult.mode !== "disabled") {
  throw new Error("templates/.dev.vars.example placeholders unexpectedly resolve to an enabled auth config");
}

console.log("Configuration templates contain only non-secret placeholders that keep auth disabled.");
