import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename as fsRename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDesktopApp as installDesktopAppImplementationRaw } from "../../scripts/install-desktop-app.mjs";
import { acquireOwnedStageRoot } from "../../scripts/owned-stage-root.mjs";

const identityHash = "A".repeat(40);
const identityName = "Developer ID Application: Zero Delta LLC (US) (4CJ49V6QHW)";
const candidateTree = "1234567890abcdef1234567890abcdef12345678";
const helperRelativePath = "Contents/MacOS/duegood-refresh";
const captureHelperRelativePath = "Contents/MacOS/duegood-capture-download";
const backupEntryName = ".Due Good.backup-01234567-89ab-cdef-0123-456789abcdef.app";

type InstallResult = {
  appPath: string;
  buildMetadataPath: string;
  rootMarkerPath: string;
  productionDataRootExistedBeforeInstall: boolean;
  productionDataRootExistsAfterOpen: boolean;
  sourceRevision: string;
  candidateTree: string;
  helperDigest: string;
  helperDigests: Record<string, string>;
  backupPath?: string;
  removedBackupPaths: string[];
};

const installDesktopAppImplementation = installDesktopAppImplementationRaw as unknown as
  (options: Record<string, unknown>) => Promise<InstallResult>;
const installDesktopApp = (options: Record<string, unknown> = {}) => installDesktopAppImplementation({
  ...options,
  launchProof: fakeLaunchProof,
  stopCandidate: fakeStopCandidate,
  stopExistingApp: async ({ bundleId, appPath, dataRoot }: { bundleId: string; appPath: string; dataRoot: string }) => { expect({ bundleId, appPath, dataRoot }).toStrictEqual({ bundleId: "com.zerodelta.duegood", appPath: path.join(applications, "Due Good.app"), dataRoot: path.join(await realpath(homeDirectory), "Library", "Application Support", "com.zerodelta.duegood") }); commands.push({ command: "native-stop-existing-verified-app", args: [bundleId, appPath] }); },
});
const acquireOwnedStageRootForTest = acquireOwnedStageRoot as unknown as
  (options: { source: string; destination?: string; keep?: boolean }) => Promise<{
    ownership: Record<string, unknown>;
    close: () => Promise<void>;
  }>;

let temporary = "";
let app: string;
let candidateRoot: string;
let applications: string;
let sourceCheckout: string;
let homeDirectory: string;
let rootMarkerPath: string;
let commands: Array<{ command: string; args: string[]; cwd?: string }>;
let logs: string[];
let registrations: string;
let signatureMode: "valid" | "unsigned" | "adhoc";
let embeddedAssetChecks: string[];
let failedAssetCheckCall: number | undefined;
let bundleIds: Map<string, string>;
let productionRunningAtCheck: number | undefined;
let productionRunningChecks: number;
let failedLaunchServicesRegistration: boolean;
let launchServicesFailureConsumed: boolean;
let failLaunchServicesRegistrationOnCall: number | undefined;
let launchServicesRegistrationCalls: number;
let failedOpen: boolean;
let stageLockToCorrupt: string | undefined;
let coldProofBackupSnapshots: Array<Array<{ path: string; exists: boolean }>>;

async function makeApp(appPath: string, id = "com.zerodelta.duegood") {
  const helper = path.join(appPath, helperRelativePath);
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(path.join(appPath, "Contents", "Info.plist"), "fixture plist");
  await writeFile(helper, "synthetic signed helper bytes");
  await writeFile(path.join(appPath, captureHelperRelativePath), "synthetic signed capture helper bytes");
  await writeFile(path.join(appPath, "Contents", "MacOS", "duegood-desktop"), "synthetic desktop executable");
  await mkdir(path.join(appPath, "Contents", "Resources"), { recursive: true });
  await writeFile(path.join(appPath, "Contents", "Resources", "duegood-build.json"), `${JSON.stringify({
    schemaVersion: 1,
    sourceRevision: "v0.1.0-4-gabc1234-dirty",
    candidateTree,
  })}\n`);
  bundleIds.set(await realpath(appPath), id);
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

function writeReceipt(directory: string, extra: Record<string, unknown> = {}) {
  return writeFile(path.join(directory, "receipt.json"), `${JSON.stringify({
    schemaVersion: 1,
    stagedMatchesCandidate: true,
    treeDigest: candidateTree,
    ...extra,
  })}\n`);
}

/** Build a stage under `<sourceCheckout>/.stage` with an optional ownership receipt. */
async function makeOwnedHandoffStage({
  relative = ["candidate"],
  stageRootOverride,
  sourceRootOverride,
  handoff = true,
  keep = false,
}: {
  relative?: string[];
  stageRootOverride?: string;
  sourceRootOverride?: string;
  handoff?: boolean;
  keep?: boolean;
} = {}): Promise<string> {
  const stageRoot = path.join(sourceCheckout, ".stage", ...relative);
  const actualHandoff = handoff && relative.length === 1 && !stageRootOverride && !sourceRootOverride;
  const ownership = actualHandoff
    ? (await acquireOwnedStageRootForTest({ source: sourceCheckout, destination: stageRoot, keep })).ownership
    : {
        schemaVersion: 1,
        owner: "duegood-stage",
        projectRoot: sourceRootOverride ?? sourceCheckout,
        stageRoot: stageRootOverride ?? stageRoot,
        lockPath: path.join(sourceCheckout, ".stage", ".locks", `${path.basename(stageRoot)}.lock`),
        purpose: path.basename(stageRoot),
        handoff,
        keep,
      };
  await mkdir(path.join(stageRoot, ".git"), { recursive: true });
  await makeApp(path.join(stageRoot, "build", "Due Good.app"));
  await writeReceipt(stageRoot, {
    stageOwnership: ownership,
  });
  return stageRoot;
}

function stageLockPath(stageRoot: string): string {
  return path.join(sourceCheckout, ".stage", ".locks", `${path.basename(stageRoot)}.lock`);
}

async function expectStagePurposeReusable(stageRoot: string): Promise<void> {
  const lifecycle = await acquireOwnedStageRootForTest({ source: sourceCheckout, destination: stageRoot });
  await lifecycle.close();
}

function installFromStage(stageRoot: string, overrides: Record<string, unknown> = {}) {
  return installDesktopApp({
    candidateRoot: stageRoot,
    sourceCheckout,
    applicationsDirectory: applications,
    homeDirectory,
    rootMarkerPath: path.join(stageRoot, ".git", "phase4-root-marker.json"),
    signingIdentity: identityName,
    platform: "darwin",
    run: fakeRun,
    log: (message: string) => logs.push(message),
    ...overrides,
  });
}

async function fakeRun(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) {
  commands.push({ command, args, cwd: options?.cwd });
  if (command === "git" && args[0] === "rev-parse") return Promise.resolve({ stdout: `${candidateTree}\n`, stderr: "" });
  if (command === "git" && args[0] === "describe") return Promise.resolve({ stdout: "v0.1.0-4-gabc1234-dirty\n", stderr: "" });
  if (command.endsWith("/PlistBuddy")) {
    const plist = args[2] ?? "";
    const appRoot = await realpath(path.dirname(path.dirname(plist)));
    return Promise.resolve({ stdout: `${bundleIds.get(appRoot) ?? "com.zerodelta.duegood"}\n`, stderr: "" });
  }
  if (command.endsWith("/pgrep") && args.join(" ") === "-x duegood-desktop") {
    productionRunningChecks += 1;
    return Promise.resolve({ stdout: "", stderr: "", code: productionRunningChecks === productionRunningAtCheck ? 0 : 1 });
  }
  if (command.endsWith("/security")) return Promise.resolve({ stdout: `  1 valid identities found\n     ${identityHash} "${identityName}"\n`, stderr: "" });
  if (command.endsWith("/duegood-desktop") && args[0] === "--verify-embedded-assets") {
    embeddedAssetChecks.push(command);
    if (stageLockToCorrupt) {
      await writeFile(path.join(stageLockToCorrupt, "owner.json"), "{}\n");
      stageLockToCorrupt = undefined;
    }
    if (embeddedAssetChecks.length === failedAssetCheckCall) return Promise.reject(new Error("asset check failed"));
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (command.endsWith("/codesign")) {
    if (signatureMode === "unsigned" && args[0] === "--verify") return Promise.reject(new Error("unsigned app"));
    if (args[0] === "--display") {
      if (signatureMode === "adhoc") return Promise.resolve({ stdout: "Signature=adhoc\n", stderr: "" });
      return Promise.resolve({ stdout: "", stderr: `Authority=${identityName}\nAuthority=Developer ID Certification Authority\nSignature=Developer ID\n` });
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (command.endsWith("/lsregister")) {
    if (args[0] === "-dump") return Promise.resolve({ stdout: registrations, stderr: "" });
    if (args[0] === "-f") {
      launchServicesRegistrationCalls += 1;
      if ((failedLaunchServicesRegistration && !launchServicesFailureConsumed)
          || launchServicesRegistrationCalls === failLaunchServicesRegistrationOnCall) {
        launchServicesFailureConsumed = true;
        return Promise.reject(new Error("registration failed"));
      }
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  return Promise.reject(new Error("Unexpected command in hermetic test."));
}

async function fakeLaunchProof({
  appPath,
  onOwnedLaunch,
}: {
  appPath: string;
  onOwnedLaunch: (identity: { pid: number; appPath: string; executablePath: string }, method: string) => void;
}) {
  const recordBackups = async () => coldProofBackupSnapshots.push(await Promise.all(
    (await readdir(applications)).filter((name) => /^\.Due Good\.backup-[0-9a-f-]{36}\.app$/u.test(name))
      .map(async (name) => ({ path: path.join(applications, name), exists: await exists(path.join(applications, name)) })),
  ));
  const exactPathIdentity = { pid: 801, appPath, executablePath: path.join(appPath, "Contents", "MacOS", "duegood-desktop") };
  const bundleIdentity = { pid: 802, appPath, executablePath: path.join(appPath, "Contents", "MacOS", "duegood-desktop") };
  await recordBackups();
  commands.push({ command: "native-launch-exact-path", args: [appPath] }); onOwnedLaunch(exactPathIdentity, "exact-path");
  commands.push({ command: "native-stop-under-snapshot-lock", args: [String(exactPathIdentity.pid)] }); await recordBackups();
  commands.push({ command: "/usr/bin/open", args: ["-b", "com.zerodelta.duegood"] });
  if (failedOpen) throw new Error("open failed");
  onOwnedLaunch(bundleIdentity, "bundle-id"); await mkdir(path.join(homeDirectory, "Library", "Application Support", "com.zerodelta.duegood"), { recursive: true });
  return { exactPath: exactPathIdentity, bundleId: bundleIdentity };
}

async function fakeStopCandidate({ pid }: { pid: number }) { commands.push({ command: "native-rollback-stop-verified-candidate", args: [String(pid)] }); }

beforeEach(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), "duegood-install-test-"));
  candidateRoot = path.join(temporary, "candidate");
  app = path.join(candidateRoot, "Due Good.app");
  applications = path.join(temporary, "Applications");
  sourceCheckout = path.join(temporary, "source-checkout");
  homeDirectory = path.join(temporary, "home");
  rootMarkerPath = path.join(candidateRoot, ".git", "phase4-root-marker.json");
  await mkdir(applications, { recursive: true });
  await mkdir(sourceCheckout, { recursive: true });
  sourceCheckout = await realpath(sourceCheckout);
  await mkdir(path.dirname(rootMarkerPath), { recursive: true });
  await mkdir(homeDirectory, { recursive: true });
  await writeReceipt(candidateRoot);
  commands = [];
  logs = [];
  embeddedAssetChecks = [];
  failedAssetCheckCall = undefined;
  registrations = "bundle id: com.other.app\npath: /Applications/Other.app\n";
  signatureMode = "valid";
  bundleIds = new Map();
  productionRunningAtCheck = undefined;
  productionRunningChecks = 0;
  failedLaunchServicesRegistration = false;
  launchServicesFailureConsumed = false;
  failLaunchServicesRegistrationOnCall = undefined;
  launchServicesRegistrationCalls = 0;
  failedOpen = false;
  stageLockToCorrupt = undefined;
  coldProofBackupSnapshots = [];
  await makeApp(app);
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe("desktop app installer", () => {
  it("records both provenance stamps, prints the installed helper digest, then opens by bundle id", async () => {
    const helperBytes = await readFile(path.join(app, helperRelativePath));
    const expectedDigest = createHash("sha256").update(helperBytes).digest("hex");
    const captureHelperBytes = await readFile(path.join(app, captureHelperRelativePath));
    const expectedCaptureDigest = createHash("sha256").update(captureHelperBytes).digest("hex");
    const result = await installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: (message: string) => logs.push(message),
    });

    const stamp = JSON.parse(await readFile(result.buildMetadataPath, "utf8")) as { sourceRevision: string; candidateTree: string };
    expect(stamp).toStrictEqual({ schemaVersion: 1, sourceRevision: "v0.1.0-4-gabc1234-dirty", candidateTree });
    expect(result.helperDigest).toBe(expectedDigest);
    expect(result.helperDigests).toStrictEqual({
      "duegood-refresh": expectedDigest,
      "duegood-capture-download": expectedCaptureDigest,
    });
    expect(result.removedBackupPaths).toStrictEqual([]);
    expect(logs).toContain(`Installed helper SHA-256: ${expectedDigest}`);
    expect(logs).toContain(`Installed capture download helper SHA-256: ${expectedCaptureDigest}`);
    expect(result.productionDataRootExistedBeforeInstall).toBe(false);
    expect(result.productionDataRootExistsAfterOpen).toBe(true);
    expect(coldProofBackupSnapshots).toStrictEqual([[], []]);
    const marker = JSON.parse(await readFile(rootMarkerPath, "utf8")) as { root: string; existedBeforePhase: boolean };
    expect(marker).toStrictEqual({
      schemaVersion: 1,
      root: path.join(await realpath(homeDirectory), "Library", "Application Support", "com.zerodelta.duegood"),
      existedBeforePhase: false,
    });
    expect((await stat(rootMarkerPath)).mode & 0o777).toBe(0o600);
    expect(commands.findIndex(({ command, args }) => command.endsWith("/open") && args.join(" ") === "-b com.zerodelta.duegood"))
      .toBeGreaterThan(commands.findIndex(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f"));
    expect(commands.some(({ command, args }) => command.endsWith("/codesign") && args.includes("--strict"))).toBe(true);
    expect(commands.some(({ command, args }) => command.endsWith("/codesign") && args.some((arg) => arg.endsWith("/duegood-capture-download")))).toBe(true);
    expect(embeddedAssetChecks).toHaveLength(3);
    expect(embeddedAssetChecks[0]).toContain("candidate/Due Good.app/Contents/MacOS/duegood-desktop");
    expect(embeddedAssetChecks[1]).toContain("Applications/.Due Good.staging-");
    expect(embeddedAssetChecks[2]).toContain("Applications/Due Good.app/Contents/MacOS/duegood-desktop");
    expect(await readdir(applications)).toContain("Due Good.app");
  });

  it("refuses an app bundle missing the fixed capture download helper", async () => {
    await rm(path.join(app, captureHelperRelativePath));
    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: (message: string) => logs.push(message),
    })).rejects.toThrow("missing a required regular file");
    expect(await readdir(applications)).toEqual([]);
  });

  it("refuses a candidate whose embedded-asset self-check fails before copying", async () => {
    failedAssetCheckCall = 1;
    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    })).rejects.toThrow("asset check failed");

    expect(embeddedAssetChecks).toHaveLength(1);
    expect(await readdir(applications)).not.toContain("Due Good.app");
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
  });

  it("removes a new initial install when its installed embedded-asset self-check fails", async () => {
    failedAssetCheckCall = 2;
    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/copied app failed its verification/u);

    expect(embeddedAssetChecks).toHaveLength(2);
    expect(await readdir(applications)).not.toContain("Due Good.app");
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
    expect(commands.some(({ command }) => command.endsWith("/open"))).toBe(false);
  });

  it.each(["unsigned", "adhoc"] as const)("refuses a %s app before copying", async (mode) => {
    signatureMode = mode;
    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    })).rejects.toThrow();
    expect(await readdir(applications)).not.toContain("Due Good.app");
  });

  it("unregisters stale Due Good paths and refuses a live competing claimant without copying", async () => {
    const competitor = path.join(applications, "Other Due Good.app");
    await makeApp(competitor);
    registrations = [
      "bundle id: com.zerodelta.duegood",
      "path: /private/tmp/missing-old-duegood.app",
      "bundle id: com.zerodelta.duegood",
      `path: ${competitor}`,
    ].join("\n");

    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: (message: string) => logs.push(message),
    })).rejects.toThrow(/different installed app claims/u);

    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-u" && args[1] === "/private/tmp/missing-old-duegood.app")).toBe(true);
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
    expect(await readdir(applications)).toContain("Other Due Good.app");
    expect(await readdir(applications)).not.toContain("Due Good.app");
  });

  it("upgrades in place and removes the retained backup after a successful verification and open", async () => {
    const installed = path.join(applications, "Due Good.app");
    await makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    const dataRoot = path.join(homeDirectory, "Library", "Application Support", "com.zerodelta.duegood");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, "owner-data-sentinel"), "keep this data");

    const result = await installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    });

    expect(await readFile(path.join(installed, helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(await readFile(path.join(dataRoot, "owner-data-sentinel"), "utf8")).toBe("keep this data");
    expect(result.productionDataRootExistedBeforeInstall).toBe(true);
    expect(result.backupPath).toBeUndefined();
    expect(result.removedBackupPaths).toHaveLength(1);
    const removedUpgradeBackup = result.removedBackupPaths[0];
    if (!removedUpgradeBackup) throw new Error("The upgrade backup was not recorded as removed.");
    expect(removedUpgradeBackup).toMatch(/\.Due Good\.backup-[0-9a-f-]{36}\.app$/u);
    expect(await exists(removedUpgradeBackup)).toBe(false);
    expect(await readdir(applications)).toEqual(["Due Good.app"]);
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister")
      && args[0] === "-u" && args[1] === removedUpgradeBackup)).toBe(true);
    expect(coldProofBackupSnapshots).toHaveLength(2);
    expect(coldProofBackupSnapshots.every((snapshot) => snapshot.length === 1 && snapshot[0]?.exists)).toBe(true);
    expect(commands.filter(({ command }) => command.endsWith("/pgrep"))).toHaveLength(2);
    expect(commands.findIndex(({ command }) => command === "native-stop-existing-verified-app")).toBeLessThan(commands.findIndex(({ command }) => command.endsWith("/pgrep")));
  });

  it("removes an older installer-owned backup and unregisters it after success", async () => {
    const installed = path.join(applications, "Due Good.app");
    const priorBackup = path.join(applications, backupEntryName);
    await makeApp(installed);
    await makeApp(priorBackup);
    registrations = [
      "bundle id: com.zerodelta.duegood",
      `path: ${priorBackup}`,
    ].join("\n");

    const result = await installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    });

    expect(commands.some(({ command, args }) => command.endsWith("/lsregister")
      && args[0] === "-u" && args[1] === priorBackup)).toBe(true);
    expect(await exists(priorBackup)).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(result.removedBackupPaths).toHaveLength(2);
    expect(result.removedBackupPaths).toContain(priorBackup);
    expect(await readdir(applications)).toEqual(["Due Good.app"]);
  });

  it("leaves an unknown bundle with a backup-like name untouched on success", async () => {
    const unknown = path.join(applications, backupEntryName);
    await makeApp(unknown, "com.example.not-duegood");

    const result = await installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    });

    expect(await readFile(path.join(unknown, helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(result.removedBackupPaths).toStrictEqual([]);
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-u" && args[1] === unknown)).toBe(false);
    expect(await readdir(applications).then((names) => names.sort())).toEqual(["Due Good.app", backupEntryName].sort());
  });

  it("leaves a symlinked backup-like entry untouched on success", async () => {
    const target = path.join(temporary, "elsewhere", "Other.app");
    await makeApp(target, "com.example.not-duegood");
    const link = path.join(applications, backupEntryName);
    await symlink(target, link);

    const result = await installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(target, helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(result.removedBackupPaths).toStrictEqual([]);
  });

  it("refuses a symlinked backup-like bundle that claims the Due Good identifier", async () => {
    const target = path.join(temporary, "elsewhere", "Due Good.app");
    await makeApp(target);
    const link = path.join(applications, backupEntryName);
    await symlink(target, link);

    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/different installed app claims/u);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(target, helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
  });

  it.each([1, 2])("refuses an upgrade if the production app is running at check %i", async (runningCheck) => {
    const installed = path.join(applications, "Due Good.app");
    await makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    productionRunningAtCheck = runningCheck;

    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/production Due Good app is running/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(applications)).toContain("Due Good.app");
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
  });

  it("restores the prior app when the swapped copy fails verification", async () => {
    const installed = path.join(applications, "Due Good.app");
    await makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    failedAssetCheckCall = 3;

    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/previous app was restored/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(applications)).toEqual(["Due Good.app"]);
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(true);
  });

  it("restores the prior app when LaunchServices registration fails", async () => {
    const installed = path.join(applications, "Due Good.app");
    await makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    failedLaunchServicesRegistration = true;

    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/previous app was restored/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(applications)).toEqual(["Due Good.app"]);
    expect(commands.some(({ command }) => command.endsWith("/open"))).toBe(false);
  });

  it("reports the restored app path when registering the restored backup fails", async () => {
    const installed = path.join(applications, "Due Good.app");
    await makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    failedLaunchServicesRegistration = true;
    failLaunchServicesRegistrationOnCall = 2;

    const result = await installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    }).then(() => undefined, (error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    const message = (result as Error).message;
    expect(message).toContain(`previous app was restored at ${installed}`);
    expect(message).toContain("registration could not be confirmed");
    expect(message).not.toContain("remains in its backup");
    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(applications)).toEqual(["Due Good.app"]);
    expect(launchServicesRegistrationCalls).toBe(2);
  });

  it("reports an incomplete restore when moving the backup back fails after removing the new app", async () => {
    const installed = path.join(applications, "Due Good.app");
    await makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    failedLaunchServicesRegistration = true;
    let retainedBackupPath = "";
    const files = {
      cp, lstat, readFile, readdir, realpath, rm, writeFile,
      rename: async (source: string, destination: string) => {
        if (source === installed && path.basename(destination).startsWith(".Due Good.backup-")) retainedBackupPath = destination;
        if (retainedBackupPath && source === retainedBackupPath && destination === installed) throw new Error("restore rename failed");
        return fsRename(source, destination);
      },
    };

    const result = await installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      files,
      log: () => undefined,
    }).then(() => undefined, (error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    const message = (result as Error).message;
    expect(message).toContain("restoration did not complete");
    expect(message).toContain(`previous app remains in its backup at ${retainedBackupPath}`);
    expect(message).not.toContain("new app remains installed");
    expect(retainedBackupPath).not.toBe("");
    expect(await exists(installed)).toBe(false);
    expect(await readFile(path.join(retainedBackupPath, helperRelativePath), "utf8")).toBe("owner-installed bytes");
    expect(await readdir(applications)).toEqual([path.basename(retainedBackupPath)]);
  });

  it("restores the prior app when opening by bundle identifier fails", async () => {
    const installed = path.join(applications, "Due Good.app");
    await makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    failedOpen = true;

    await expect(installDesktopApp({
      appPath: app,
      candidateRoot,
      sourceCheckout,
      applicationsDirectory: applications,
      homeDirectory,
      rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/previous app was restored/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(applications)).toEqual(["Due Good.app"]);
    expect(commands.some(({ command, args }) => command === "native-rollback-stop-verified-candidate" && args[0] === "801")).toBe(true);
  });

  it("consumes an owned stage handoff and removes the stage after a successful install", async () => {
    const stageRoot = await makeOwnedHandoffStage();

    const result = await installFromStage(stageRoot);

    expect(result.appPath).toBe(path.join(applications, "Due Good.app"));
    expect(await readFile(path.join(applications, "Due Good.app", helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(await exists(stageRoot)).toBe(false);
    expect(await exists(stageLockPath(stageRoot))).toBe(false);
    await expectStagePurposeReusable(stageRoot);
  });

  it("defaults to the stage-local build/Due Good.app when the installer runs from the stage root", async () => {
    const stageRoot = await makeOwnedHandoffStage();
    const previousCwd = process.cwd();
    process.chdir(stageRoot);
    try {
      const result = await installDesktopApp({
        sourceCheckout,
        applicationsDirectory: applications,
        homeDirectory,
        rootMarkerPath: path.join(stageRoot, ".git", "phase4-root-marker.json"),
        signingIdentity: identityName,
        platform: "darwin",
        run: fakeRun,
        log: () => undefined,
      });
      expect(result.appPath).toBe(path.join(applications, "Due Good.app"));
    } finally {
      process.chdir(previousCwd);
    }
    expect(await exists(stageRoot)).toBe(false);
    expect(await exists(stageLockPath(stageRoot))).toBe(false);
    expect(await exists(path.join(applications, "Due Good.app"))).toBe(true);
  });

  it("removes an owned stage after a failed install that restores the prior app", async () => {
    const installed = path.join(applications, "Due Good.app");
    await makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    const stageRoot = await makeOwnedHandoffStage();
    failedAssetCheckCall = 3;

    await expect(installFromStage(stageRoot)).rejects.toThrow(/previous app was restored/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(applications)).toEqual(["Due Good.app"]);
    expect(await exists(stageRoot)).toBe(false);
    expect(await exists(stageLockPath(stageRoot))).toBe(false);
    await expectStagePurposeReusable(stageRoot);
  });

  it("removes an owned stage when the candidate fails before copying", async () => {
    const stageRoot = await makeOwnedHandoffStage();
    failedAssetCheckCall = 1;

    await expect(installFromStage(stageRoot)).rejects.toThrow(/asset check failed/u);

    expect(await exists(stageRoot)).toBe(false);
    expect(await exists(stageLockPath(stageRoot))).toBe(false);
    expect(await readdir(applications)).toEqual([]);
    await expectStagePurposeReusable(stageRoot);
  });

  it("rejects a handoff with a mismatched lock owner before starting installation", async () => {
    const stageRoot = await makeOwnedHandoffStage();
    await writeFile(path.join(stageLockPath(stageRoot), "owner.json"), "{}\n");

    await expect(installFromStage(stageRoot)).rejects.toThrow("stage handoff lock does not match its receipt");

    expect(embeddedAssetChecks).toHaveLength(0);
    expect(await readdir(applications)).toEqual([]);
    expect(await exists(stageRoot)).toBe(true);
    expect(await exists(stageLockPath(stageRoot))).toBe(true);
  });

  it("reports stage cleanup failure without hiding the failed install", async () => {
    const stageRoot = await makeOwnedHandoffStage();
    failedAssetCheckCall = 1;
    stageLockToCorrupt = stageLockPath(stageRoot);

    let failure: unknown;
    try {
      await installFromStage(stageRoot);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toContain("asset check failed");
    expect(aggregate.message).toContain("stage handoff lock does not match its receipt");
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[0]).toMatchObject({ message: "asset check failed" });
    expect(await exists(stageRoot)).toBe(true);
    expect(await exists(stageLockPath(stageRoot))).toBe(true);
  });

  it.each([
    { label: "an explicit keep flag", handoff: true, keep: true },
    { label: "a diagnostic non-handoff receipt", handoff: false, keep: false },
  ])("keeps the stage when the receipt requests retention ($label)", async ({ handoff, keep }) => {
    const stageRoot = await makeOwnedHandoffStage({ handoff, keep });

    await installFromStage(stageRoot);

    expect(await exists(stageRoot)).toBe(true);
    expect(await exists(path.join(stageRoot, "build", "Due Good.app"))).toBe(true);
    if (keep) expect(await exists(stageLockPath(stageRoot))).toBe(true);
  });

  it("does not remove a stage when the receipt names a different stage path", async () => {
    const fixture = path.join(temporary, "caller-fixture");
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, "keep.txt"), "keep\n");
    const stageRoot = await makeOwnedHandoffStage({ stageRootOverride: fixture });

    await installFromStage(stageRoot);

    expect(await readFile(path.join(fixture, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await exists(stageRoot)).toBe(true);
  });

  it("does not remove a stage whose canonical path is not a direct child of the source .stage directory", async () => {
    const stageRoot = await makeOwnedHandoffStage({ relative: ["nested", "candidate"] });

    await installFromStage(stageRoot);

    expect(await exists(stageRoot)).toBe(true);
  });

  it("does not remove a stage when the receipt names a different source checkout", async () => {
    const otherSource = path.join(temporary, "other-source");
    await mkdir(otherSource, { recursive: true });
    const stageRoot = await makeOwnedHandoffStage({ sourceRootOverride: otherSource });

    await installFromStage(stageRoot);

    expect(await exists(stageRoot)).toBe(true);
  });
});
