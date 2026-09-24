import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installDesktopApp } from "../../scripts/install-desktop-app.mjs";

const identityHash = "A".repeat(40);
const identityName = "Developer ID Application: Zero Delta LLC (US) (4CJ49V6QHW)";
const candidateTree = "1234567890abcdef1234567890abcdef12345678";
const helperRelativePath = "Contents/MacOS/duegood-refresh";

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

async function makeApp(appPath: string, id = "com.zerodelta.duegood") {
  const helper = path.join(appPath, helperRelativePath);
  await mkdir(path.dirname(helper), { recursive: true });
  await writeFile(path.join(appPath, "Contents", "Info.plist"), "fixture plist");
  await writeFile(helper, "synthetic signed helper bytes");
  await writeFile(path.join(appPath, "Contents", "MacOS", "duegood-desktop"), "synthetic desktop executable");
  await mkdir(path.join(appPath, "Contents", "Resources"), { recursive: true });
  await writeFile(path.join(appPath, "Contents", "Resources", "duegood-build.json"), `${JSON.stringify({
    schemaVersion: 1,
    sourceRevision: "v0.1.0-4-gabc1234-dirty",
    candidateTree,
  })}\n`);
  bundleIds.set(await realpath(appPath), id);
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
    if (args[0] === "-f" && failedLaunchServicesRegistration) return Promise.reject(new Error("registration failed"));
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  if (command.endsWith("/open")) {
    return mkdir(path.join(homeDirectory, "Library", "Application Support", "com.zerodelta.duegood"), { recursive: true })
      .then(() => ({ stdout: "", stderr: "" }));
  }
  return Promise.reject(new Error("Unexpected command in hermetic test."));
}

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
  await mkdir(path.dirname(rootMarkerPath), { recursive: true });
  await mkdir(homeDirectory, { recursive: true });
  await writeFile(path.join(candidateRoot, "receipt.json"), `${JSON.stringify({
    schemaVersion: 1,
    stagedMatchesCandidate: true,
    treeDigest: candidateTree,
  })}\n`);
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
  await makeApp(app);
});

afterEach(async () => {
  await rm(temporary, { recursive: true, force: true });
});

describe("desktop app installer", () => {
  it("records both provenance stamps, prints the installed helper digest, then opens by bundle id", async () => {
    const helperBytes = await readFile(path.join(app, helperRelativePath));
    const expectedDigest = createHash("sha256").update(helperBytes).digest("hex");
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
      log: (message) => logs.push(message),
    });

    const stamp = JSON.parse(await readFile(result.buildMetadataPath, "utf8")) as { sourceRevision: string; candidateTree: string };
    expect(stamp).toStrictEqual({ schemaVersion: 1, sourceRevision: "v0.1.0-4-gabc1234-dirty", candidateTree });
    expect(result.helperDigest).toBe(expectedDigest);
    expect(logs).toContain(`Installed helper SHA-256: ${expectedDigest}`);
    expect(result.productionDataRootExistedBeforeInstall).toBe(false);
    expect(result.productionDataRootExistsAfterOpen).toBe(true);
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
    expect(embeddedAssetChecks).toHaveLength(3);
    expect(embeddedAssetChecks[0]).toContain("candidate/Due Good.app/Contents/MacOS/duegood-desktop");
    expect(embeddedAssetChecks[1]).toContain("Applications/.Due Good.staging-");
    expect(embeddedAssetChecks[2]).toContain("Applications/Due Good.app/Contents/MacOS/duegood-desktop");
    expect(await readdir(applications)).toContain("Due Good.app");
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
      log: (message) => logs.push(message),
    })).rejects.toThrow(/different installed app claims/u);

    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-u" && args[1] === "/private/tmp/missing-old-duegood.app")).toBe(true);
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
    expect(await readdir(applications)).toContain("Other Due Good.app");
    expect(await readdir(applications)).not.toContain("Due Good.app");
  });

  it("upgrades in place while retaining the prior app bundle as a backup", async () => {
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

    const backupPath = result.backupPath;
    if (!backupPath) throw new Error("The upgrade did not retain the previous app bundle.");
    expect(backupPath).toMatch(/\.Due Good\.backup-[0-9a-f-]{36}\.app$/u);
    expect(await readFile(path.join(backupPath, helperRelativePath), "utf8")).toBe("owner-installed bytes");
    expect(await readFile(path.join(installed, helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(await readFile(path.join(dataRoot, "owner-data-sentinel"), "utf8")).toBe("keep this data");
    expect(result.productionDataRootExistedBeforeInstall).toBe(true);
    expect(await readdir(applications)).toContain(path.basename(backupPath));
    expect(commands.filter(({ command }) => command.endsWith("/pgrep"))).toHaveLength(2);
  });

  it("unregisters a previously retained backup instead of treating it as a competing app", async () => {
    const installed = path.join(applications, "Due Good.app");
    const priorBackup = path.join(applications, ".Due Good.backup-01234567-89ab-cdef-0123-456789abcdef.app");
    await makeApp(installed);
    await makeApp(priorBackup);
    registrations = [
      "bundle id: com.zerodelta.duegood",
      `path: ${priorBackup}`,
    ].join("\n");

    await installDesktopApp({
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
    expect(await readFile(path.join(priorBackup, helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
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
    expect(commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
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
});
