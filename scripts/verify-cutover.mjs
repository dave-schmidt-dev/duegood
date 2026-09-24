import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { userInfo } from "node:os";

const MANIFEST_NAME = "duegood-store.json";
const MANIFEST_FORMAT = "duegood-store";
const MANIFEST_VERSION = 1;
const PRODUCTION_BUNDLE_ID = "com.zerodelta.duegood";
const INSTALLED_APP_PATH = "/Applications/Due Good.app";
const INSTALLED_HELPER_PATH = path.join(INSTALLED_APP_PATH, "Contents", "MacOS", "duegood-refresh");
const LAUNCH_SERVICES_REGISTER = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const PLIST_BUDDY = "/usr/libexec/PlistBuddy";
const CODE_SIGN = "/usr/bin/codesign";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_SETTING_BYTES = 1024;
const MAX_TREE_ENTRIES = 200_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024 * 1024;
const HASH_BUFFER_BYTES = 128 * 1024;
const PROCESS_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_LAUNCH_SERVICES_OUTPUT_BYTES = 64 * 1024 * 1024;
const NOT_LOADED_EXIT_CODE = 113;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export class CutoverVerificationError extends Error {
  constructor(code) {
    super(code);
    this.name = "CutoverVerificationError";
    this.code = code;
  }
}

function fail(code) {
  throw new CutoverVerificationError(code);
}

function emit(onStatus, step) {
  if (typeof onStatus === "function") onStatus({ type: "progress", step });
}

function assertAbsolutePathArgument(value, code) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value) || value.includes("\0")) fail(code);
  return path.resolve(value);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeName(buffer) {
  const name = buffer.toString("utf8");
  if (!Buffer.from(name, "utf8").equals(buffer) || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    fail("unsupported-entry-name");
  }
  return name;
}

function stableStatTuple(info) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

async function readRegularFileDigest(filename, observed) {
  let handle;
  try {
    handle = await open(filename, OPEN_FLAGS);
    const before = await handle.stat();
    if (!before.isFile() || stableStatTuple(before) !== stableStatTuple(observed) || before.size > MAX_FILE_BYTES) {
      fail("tree-changed-or-unsupported");
    }

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) fail("tree-limit-exceeded");
      digest.update(buffer.subarray(0, bytesRead));
    }

    const after = await handle.stat();
    if (total !== before.size || stableStatTuple(before) !== stableStatTuple(after)) fail("tree-changed-or-unsupported");
    return { digest: digest.digest(), bytes: total };
  } catch (error) {
    if (error instanceof CutoverVerificationError) throw error;
    fail(error?.code === "ENOENT" || error?.code === "ELOOP" ? "tree-changed-or-unsupported" : "tree-unavailable");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function scanTree(root, label, onStatus) {
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch {
    fail("tree-unavailable");
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail("tree-root-invalid");

  const treeDigest = createHash("sha256");
  const state = { entries: 0, bytes: 0 };
  const visit = async (directory, relative) => {
    let before;
    let names;
    try {
      before = await lstat(directory);
      if (before.isSymbolicLink() || !before.isDirectory()) fail("tree-symlink-or-type");
      names = await readdir(directory, { encoding: "buffer" });
    } catch (error) {
      if (error instanceof CutoverVerificationError) throw error;
      fail("tree-unavailable");
    }
    names.sort(Buffer.compare);

    for (const rawName of names) {
      state.entries += 1;
      if (state.entries > MAX_TREE_ENTRIES) fail("tree-limit-exceeded");
      if (state.entries % 5000 === 0) emit(onStatus, label);
      const name = safeName(rawName);
      const key = relative ? `${relative}/${name}` : name;
      const child = path.join(directory, name);
      let info;
      try {
        info = await lstat(child);
      } catch {
        fail("tree-changed-or-unsupported");
      }
      const keyBytes = Buffer.from(key, "utf8");
      if (info.isSymbolicLink()) fail("tree-symlink-or-type");
      if (info.isDirectory()) {
        treeDigest.update(Buffer.from("D\0"));
        treeDigest.update(keyBytes);
        treeDigest.update(Buffer.from("\0"));
        await visit(child, key);
      } else if (info.isFile()) {
        if (info.size > MAX_FILE_BYTES || state.bytes + info.size > MAX_TREE_BYTES) fail("tree-limit-exceeded");
        const file = await readRegularFileDigest(child, info);
        state.bytes += file.bytes;
        treeDigest.update(Buffer.from("F\0"));
        treeDigest.update(keyBytes);
        treeDigest.update(Buffer.from(`\0${file.bytes}\0`));
        treeDigest.update(file.digest);
        treeDigest.update(Buffer.from("\0"));
      } else {
        fail("tree-symlink-or-type");
      }
    }

    let after;
    try {
      after = await lstat(directory);
    } catch {
      fail("tree-changed-or-unsupported");
    }
    if (stableStatTuple(before) !== stableStatTuple(after)) fail("tree-changed-or-unsupported");
  };

  await visit(root, "");
  if (stableStatTuple(rootInfo) !== stableStatTuple(await lstat(root))) fail("tree-changed-or-unsupported");
  return { digest: treeDigest.digest(), entries: state.entries, bytes: state.bytes };
}

async function assertLayoutAnchors(root) {
  try {
    const [coursework, classes] = await Promise.all([
      lstat(path.join(root, "coursework.json")),
      lstat(path.join(root, "classes")),
    ]);
    if (coursework.isSymbolicLink() || !coursework.isFile() || classes.isSymbolicLink() || !classes.isDirectory()) {
      fail("layout-anchor-missing-or-invalid");
    }
  } catch (error) {
    if (error instanceof CutoverVerificationError) throw error;
    fail("layout-anchor-missing-or-invalid");
  }
}

export async function compareLayoutTrees({ sourceRoot, exportRoot, onStatus } = {}) {
  const source = assertAbsolutePathArgument(sourceRoot, "source-root-required");
  const exported = assertAbsolutePathArgument(exportRoot, "export-root-required");
  if (source === exported || isWithin(source, exported) || isWithin(exported, source)) fail("overlapping-roots");
  await Promise.all([assertLayoutAnchors(source), assertLayoutAnchors(exported)]);
  emit(onStatus, "compare-source-layout");
  const left = await scanTree(source, "compare-source-layout", onStatus);
  emit(onStatus, "compare-export-layout");
  const right = await scanTree(exported, "compare-export-layout", onStatus);
  if (left.entries !== right.entries || left.bytes !== right.bytes || !left.digest.equals(right.digest)) fail("tree-mismatch");
  return { equal: true };
}

function exactKeys(object, expected) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return false;
  const actual = Object.keys(object).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && Number.isFinite(Date.parse(value));
}

async function readAndVerifyManifest(storeRoot, expectedState) {
  const root = assertAbsolutePathArgument(storeRoot, "store-root-required");
  let rootInfo;
  let manifestInfo;
  let raw;
  try {
    rootInfo = await lstat(root);
    manifestInfo = await lstat(path.join(root, MANIFEST_NAME));
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.size > MAX_MANIFEST_BYTES) {
      fail("manifest-invalid");
    }
    raw = await readFile(path.join(root, MANIFEST_NAME));
    const after = await lstat(path.join(root, MANIFEST_NAME));
    const rootAfter = await lstat(root);
    if (stableStatTuple(rootInfo) !== stableStatTuple(rootAfter)
        || stableStatTuple(manifestInfo) !== stableStatTuple(after)
        || raw.length !== manifestInfo.size) fail("manifest-changed");
  } catch (error) {
    if (error instanceof CutoverVerificationError) throw error;
    fail("manifest-unavailable");
  }

  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    fail("manifest-invalid");
  }
  if (!exactKeys(value, ["createdAt", "format", "importedAt", "source", "state", "version"])) fail("manifest-invalid");
  if (value.format !== MANIFEST_FORMAT || value.version !== MANIFEST_VERSION || value.state !== expectedState) fail("store-state-mismatch");
  if (!validTimestamp(value.createdAt) || !validTimestamp(value.importedAt)) fail("manifest-invalid");
  if (!exactKeys(value.source, ["bytes", "files", "kind", "treeDigest"])) fail("manifest-invalid");
  if (value.source.kind !== "legacy-import"
      || !Number.isSafeInteger(value.source.files) || value.source.files < 0
      || !Number.isSafeInteger(value.source.bytes) || value.source.bytes < 0
      || typeof value.source.treeDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.source.treeDigest)) {
    fail("manifest-invalid");
  }
  return value.state;
}

function productionStoreRoot(home) {
  if (typeof home !== "string" || !path.isAbsolute(home)) fail("production-root-unavailable");
  return path.join(home, "Library", "Application Support", PRODUCTION_BUNDLE_ID, "store");
}

async function readRefreshSetting(storeRoot) {
  const settingPath = path.join(path.dirname(storeRoot), "canvas-refresh-enabled.json");
  let info;
  try {
    info = await lstat(settingPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_SETTING_BYTES || (info.mode & 0o777) !== 0o600) {
      fail("refresh-setting-invalid");
    }
    const value = JSON.parse(await readFile(settingPath, "utf8"));
    const after = await lstat(settingPath);
    if (stableStatTuple(info) !== stableStatTuple(after)) fail("refresh-setting-changed");
    if (!exactKeys(value, ["canvasRefreshEnabled"]) || value.canvasRefreshEnabled !== true) fail("refresh-not-enabled");
  } catch (error) {
    if (error instanceof CutoverVerificationError) throw error;
    fail("refresh-setting-unavailable");
  }
}

async function verifyLatestRefresh(storeRoot) {
  const filename = path.join(storeRoot, "coursework-refresh-history.json");
  let info;
  let bytes;
  try {
    info = await lstat(filename);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_HISTORY_BYTES) fail("refresh-history-invalid");
    bytes = await readFile(filename);
    const after = await lstat(filename);
    if (stableStatTuple(info) !== stableStatTuple(after) || bytes.length !== info.size) fail("refresh-history-changed");
  } catch (error) {
    if (error instanceof CutoverVerificationError) throw error;
    fail("refresh-history-unavailable");
  }
  let history;
  try {
    history = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("refresh-history-invalid");
  }
  if (!history || typeof history !== "object" || Array.isArray(history)
      || (history.schema !== undefined && history.schema !== 1)
      || !Array.isArray(history.events) || history.events.length === 0) {
    fail("refresh-history-invalid");
  }
  const latest = history.events.at(-1);
  if (!latest || typeof latest !== "object" || Array.isArray(latest)
      || latest.status !== "succeeded" || latest.sourceComplete !== true || !validTimestamp(latest.finishedAt)) {
    fail("latest-refresh-not-complete");
  }
}

async function assertExecutable(filename, code) {
  try {
    const info = await lstat(filename);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o111) === 0) fail(code);
    await access(filename, constants.X_OK);
  } catch (error) {
    if (error instanceof CutoverVerificationError) throw error;
    fail(code);
  }
}

function launchServicesRegistrationPaths(output) {
  const matches = [];
  let active = false;
  let registeredPath;
  const flush = () => {
    if (active && registeredPath) matches.push(registeredPath);
    registeredPath = undefined;
  };
  for (const line of output.split(/\r?\n/u)) {
    const id = /^\s*bundle id:\s*(\S+)\s*$/iu.exec(line);
    if (id) {
      flush();
      active = id[1] === PRODUCTION_BUNDLE_ID;
      continue;
    }
    if (active) {
      const location = /^\s*path:\s*(.+?)\s*$/iu.exec(line);
      if (location) registeredPath = location[1].replace(/^"|"$/gu, "");
    }
  }
  flush();
  return [...new Set(matches)];
}

async function verifyInstalledApp({ storeRoot, spawn, paths }) {
  const appPath = paths.appPath;
  const helperPath = paths.helperPath;
  const brokerPath = paths.brokerPath;
  let appInfo;
  let plistInfo;
  try {
    appInfo = await lstat(appPath);
    plistInfo = await lstat(path.join(appPath, "Contents", "Info.plist"));
  } catch {
    fail("installed-app-unavailable");
  }
  if (appInfo.isSymbolicLink() || !appInfo.isDirectory() || plistInfo.isSymbolicLink() || !plistInfo.isFile()) {
    fail("installed-app-invalid");
  }

  const plist = spawn(PLIST_BUDDY, ["-c", "Print :CFBundleIdentifier", path.join(appPath, "Contents", "Info.plist")], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (plist.error || plist.status !== 0 || plist.stdout?.trim() !== PRODUCTION_BUNDLE_ID) fail("bundle-identity-mismatch");

  const appVerify = spawn(CODE_SIGN, ["--verify", "--strict", "--verbose=2", appPath], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (appVerify.error || appVerify.status !== 0) fail("bundle-signature-invalid");
  const appDisplay = spawn(CODE_SIGN, ["--display", "--verbose=4", appPath], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  const appSignature = `${appDisplay.stdout ?? ""}\n${appDisplay.stderr ?? ""}`;
  if (appDisplay.error || appDisplay.status !== 0
      || !new RegExp(`^Identifier=${PRODUCTION_BUNDLE_ID}$`, "m").test(appSignature)
      || !/^Authority=Developer ID Application:.+$/m.test(appSignature)
      || !/^Authority=Developer ID Certification Authority/m.test(appSignature)) {
    fail("bundle-signature-invalid");
  }

  await assertExecutable(helperPath, "refresh-helper-unavailable");
  await assertExecutable(brokerPath, "secret-broker-unavailable");
  const helperVerify = spawn(CODE_SIGN, ["--verify", "--strict", "--verbose=2", helperPath], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (helperVerify.error || helperVerify.status !== 0) fail("refresh-helper-signature-invalid");

  const registrations = spawn(LAUNCH_SERVICES_REGISTER, ["-dump"], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_LAUNCH_SERVICES_OUTPUT_BYTES,
  });
  if (registrations.error || registrations.status !== 0) fail("launch-services-query-failed");
  const pathsRegistered = launchServicesRegistrationPaths(`${registrations.stdout ?? ""}\n${registrations.stderr ?? ""}`)
    .map((registeredPath) => path.resolve(registeredPath));
  if (pathsRegistered.length !== 1 || pathsRegistered[0] !== path.resolve(appPath)) fail("bundle-registration-mismatch");

  const helperReport = spawn(helperPath, ["--report-store-root"], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (helperReport.error || helperReport.status !== 0) fail("app-store-root-unavailable");
  const reportedRoot = helperReport.stdout?.trim();
  if (!reportedRoot || !path.isAbsolute(reportedRoot) || path.resolve(reportedRoot) !== path.resolve(storeRoot)) {
    fail("app-store-root-mismatch");
  }
}

function parseLaunchctlOutput(result) {
  if (result.error || result.signal || result.status === null || result.status === undefined) fail("launchctl-unavailable");
  return result;
}

function normalizeDisabledOutput(output, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!/disabled services\s*=\s*\{/i.test(output)) fail("launchctl-query-failed");
  const match = output.match(new RegExp(`^[\\t ]*["']?${escaped}["']?[\\t ]*=>[\\t ]*(disabled|enabled|true|false)[\\t ]*$`, "mi"));
  if (!match) return "enabled";
  return match[1].toLowerCase() === "disabled" || match[1].toLowerCase() === "true" ? "disabled" : "enabled";
}

function runLaunchctl(label, expectedLoaded, expectedDisabled, spawn, getuid) {
  const uid = typeof getuid === "function" ? getuid() : null;
  if (!Number.isInteger(uid) || uid < 0) fail("launchd-domain-unavailable");
  const domain = `gui/${uid}`;
  const loadedResult = parseLaunchctlOutput(spawn("launchctl", ["print", `${domain}/${label}`], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  }));
  let loaded;
  if (loadedResult.status === 0) loaded = true;
  else if (loadedResult.status === NOT_LOADED_EXIT_CODE) loaded = false;
  else fail("launchctl-query-failed");

  const disabledResult = parseLaunchctlOutput(spawn("launchctl", ["print-disabled", domain], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  }));
  if (disabledResult.status !== 0) fail("launchctl-query-failed");
  const disabled = normalizeDisabledOutput(`${disabledResult.stdout ?? ""}\n${disabledResult.stderr ?? ""}`, label) === "disabled";
  if (loaded !== expectedLoaded || disabled !== expectedDisabled) fail("service-state-mismatch");
  return { loaded: loaded ? "loaded" : "unloaded", plist: disabled ? "disabled" : "enabled" };
}

async function verifyLaunchAgent(home, label, spawn) {
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  const filename = path.join(launchAgents, `${label}.plist`);
  try {
    const directoryInfo = await lstat(launchAgents);
    const plistInfo = await lstat(filename);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory() || plistInfo.isSymbolicLink() || !plistInfo.isFile()) {
      fail("launch-agent-missing-or-invalid");
    }
  } catch (error) {
    if (error instanceof CutoverVerificationError) throw error;
    fail("launch-agent-missing-or-invalid");
  }
  const result = spawn(PLIST_BUDDY, ["-c", "Print :Label", filename], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0 || result.stdout?.trim() !== label) fail("launch-agent-identity-mismatch");
}

function resolveInstalledBundle(spawn) {
  const result = spawn("open", ["-b", PRODUCTION_BUNDLE_ID], {
    encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, maxBuffer: MAX_PROCESS_OUTPUT_BYTES,
  });
  if (result.error || result.signal || result.status !== 0) fail("bundle-resolution-failed");
  return "open-b-resolved";
}

function expectedFor({ mode, checkpoint }) {
  if (mode === "final") {
    if (checkpoint !== undefined) fail("invalid-checkpoint");
    return {
      store: "authoritative",
      loaded: false,
      disabled: true,
      consumerAttestation: "owner-confirmed-legacy-disabled",
    };
  }
  if (mode !== "rehearsal") fail("mode-required");
  if (checkpoint === "post-refresh") {
    return { store: "authoritative", loaded: false, disabled: false, consumerAttestation: "owner-confirmed-desktop-enabled" };
  }
  if (checkpoint === "rollback") {
    return { store: "preview", loaded: true, disabled: false, consumerAttestation: "owner-confirmed-legacy-enabled" };
  }
  fail("checkpoint-required");
}

function validateLabel(label) {
  if (typeof label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(label)) fail("service-label-invalid");
  return label;
}

/** Read-only comparison and status check. The `open -b` resolution may launch the installed app. */
export async function verifyCutover(options = {}, dependencies = {}) {
  const expected = expectedFor(options);
  const sourceRoot = assertAbsolutePathArgument(options.sourceRoot, "source-root-required");
  const exportRoot = assertAbsolutePathArgument(options.exportRoot, "export-root-required");
  const storeRoot = assertAbsolutePathArgument(options.storeRoot, "store-root-required");
  if (options.brokerPath !== undefined || dependencies.systemPaths?.brokerPath !== undefined) {
    fail("broker-path-not-configurable");
  }
  const serviceLabel = validateLabel(options.serviceLabel);
  if (sourceRoot === exportRoot || sourceRoot === storeRoot || exportRoot === storeRoot) fail("overlapping-roots");
  const consumerAttestation = options.consumerAttestation;
  if (consumerAttestation !== expected.consumerAttestation) fail("consumer-attestation-required");
  const home = dependencies.home ?? userInfo().homedir;
  const expectedRoot = dependencies.expectedStoreRoot ?? productionStoreRoot(home);
  if (storeRoot !== path.resolve(expectedRoot)) fail("production-root-mismatch");
  try {
    const [actualRealRoot, expectedRealRoot] = await Promise.all([realpath(storeRoot), realpath(expectedRoot)]);
    if (actualRealRoot !== expectedRealRoot) fail("production-root-mismatch");
  } catch (error) {
    if (error instanceof CutoverVerificationError) throw error;
    fail("production-root-unavailable");
  }
  if (typeof home !== "string" || !path.isAbsolute(home)) fail("production-root-unavailable");

  const onStatus = dependencies.onStatus ?? options.onStatus;
  emit(onStatus, "validate-layout-equality");
  await compareLayoutTrees({ sourceRoot, exportRoot, onStatus });

  emit(onStatus, "validate-store-manifest");
  const storeState = await readAndVerifyManifest(storeRoot, expected.store);

  const spawn = dependencies.spawnSync ?? spawnSync;
  const paths = {
    appPath: dependencies.systemPaths?.appPath ?? INSTALLED_APP_PATH,
    helperPath: dependencies.systemPaths?.helperPath ?? INSTALLED_HELPER_PATH,
    brokerPath: path.join(home, ".agent", "bin", "bws-secret-exec"),
  };
  emit(onStatus, "validate-installed-app");
  await verifyInstalledApp({ storeRoot, spawn, paths });
  await verifyLaunchAgent(home, serviceLabel, spawn);

  let refreshAvailability;
  if (storeState === "authoritative") {
    emit(onStatus, "validate-latest-refresh");
    await readRefreshSetting(storeRoot);
    await verifyLatestRefresh(storeRoot);
    refreshAvailability = "enabled-local-prerequisites";
  } else {
    refreshAvailability = "unavailable-preview";
  }

  emit(onStatus, "validate-service-state");
  const getuid = dependencies.getuid ?? process.getuid;
  const service = runLaunchctl(serviceLabel, expected.loaded, expected.disabled, spawn, getuid);

  emit(onStatus, "resolve-installed-app");
  const appResolution = resolveInstalledBundle(spawn);

  emit(onStatus, "record-consumer-attestation");
  return {
    mode: options.mode,
    ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
    equality: "equal",
    storeState,
    refreshAvailability,
    appResolution,
    service,
    consumer: { evidence: "owner-attested", status: expected.consumerAttestation },
  };
}

function parseArgs(argv, env = process.env) {
  const values = {};
  let mode;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--rehearsal" || arg === "--final") {
      if (mode) fail("mode-required");
      mode = arg.slice(2);
      continue;
    }
    if (arg === "--help") return { help: true };
    if (!["--checkpoint", "--source", "--export", "--store-root", "--service-label", "--consumer-attestation"].includes(arg)) {
      fail("invalid-arguments");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--") || values[arg]) fail("invalid-arguments");
    values[arg] = value;
    index += 1;
  }
  if (!mode) fail("mode-required");
  const environment = {
    "--source": env.DUEGOOD_CUTOVER_SOURCE_ROOT,
    "--export": env.DUEGOOD_CUTOVER_EXPORT_ROOT,
    "--store-root": env.DUEGOOD_CUTOVER_STORE_ROOT,
    "--service-label": env.DUEGOOD_CUTOVER_SERVICE_LABEL,
    "--consumer-attestation": env.DUEGOOD_CUTOVER_CONSUMER_ATTESTATION,
    "--checkpoint": env.DUEGOOD_CUTOVER_CHECKPOINT,
  };
  const pick = (flag) => values[flag] ?? environment[flag];
  const options = {
    mode,
    checkpoint: pick("--checkpoint"),
    sourceRoot: pick("--source"),
    exportRoot: pick("--export"),
    storeRoot: pick("--store-root"),
    serviceLabel: pick("--service-label"),
    consumerAttestation: pick("--consumer-attestation"),
  };
  expectedFor(options);
  return options;
}

export const CUTOVER_USAGE = `Usage:
  node scripts/verify-cutover.mjs --rehearsal --checkpoint <post-refresh-or-rollback> \\
    --source <private-layout-root> --export <private-export-root> --store-root <private-store-dir> \\
    --service-label <launchd-label> \\
    --consumer-attestation <owner-confirmation-for-checkpoint>
  node scripts/verify-cutover.mjs --final \\
    --source <private-layout-root> --export <private-export-root> --store-root <private-store-dir> \\
    --service-label <launchd-label> \\
    --consumer-attestation owner-confirmed-legacy-disabled

Use owner-confirmed-desktop-enabled after refresh or owner-confirmed-legacy-enabled during rollback.
The consumer status is a content-free owner attestation; this command never queries BWS.
Private paths may instead be supplied through DUEGOOD_CUTOVER_SOURCE_ROOT,
DUEGOOD_CUTOVER_EXPORT_ROOT, and DUEGOOD_CUTOVER_STORE_ROOT.
The BWS broker path is fixed to the path used by the installed desktop app.
Progress is written to stderr.`;

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${CUTOVER_USAGE}\n`);
      return;
    }
    const report = await verifyCutover(options, {
      onStatus: (status) => process.stderr.write(`${JSON.stringify(status)}\n`),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    const code = error instanceof CutoverVerificationError ? error.code : "verification-failed";
    process.stderr.write(`Cutover verification failed (${code}). No paths, file names, contents, or credentials were printed.\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
