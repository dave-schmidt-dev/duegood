import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename as fsRename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupEntryName,
  captureHelperRelativePath,
  candidateTree,
  createInstallDesktopAppFixture,
  helperRelativePath,
  identityName,
  type InstallDesktopAppFixture,
} from "./helpers/install-desktop-app";

let harness: InstallDesktopAppFixture;
let cleanupHarness: InstallDesktopAppFixture | undefined;

beforeEach(async () => {
  cleanupHarness = undefined;
  harness = await createInstallDesktopAppFixture();
  cleanupHarness = harness;
});

afterEach(async () => {
  await cleanupHarness?.cleanup();
});

describe("desktop app installer", () => {
  it("records both provenance stamps, prints the installed helper digest, then opens by bundle id", async () => {
    const helperBytes = await readFile(path.join(harness.app, helperRelativePath));
    const expectedDigest = createHash("sha256").update(helperBytes).digest("hex");
    const captureHelperBytes = await readFile(path.join(harness.app, captureHelperRelativePath));
    const expectedCaptureDigest = createHash("sha256").update(captureHelperBytes).digest("hex");
    const result = await harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: (message: string) => harness.logs.push(message),
    });

    const stamp = JSON.parse(await readFile(result.buildMetadataPath, "utf8")) as { sourceRevision: string; candidateTree: string };
    expect(stamp).toStrictEqual({ schemaVersion: 1, sourceRevision: "v0.1.0-4-gabc1234-dirty", candidateTree });
    expect(result.helperDigest).toBe(expectedDigest);
    expect(result.helperDigests).toStrictEqual({
      "duegood-refresh": expectedDigest,
      "duegood-capture-download": expectedCaptureDigest,
    });
    expect(result.removedBackupPaths).toStrictEqual([]);
    expect(harness.logs).toContain(`Installed helper SHA-256: ${expectedDigest}`);
    expect(harness.logs).toContain(`Installed capture download helper SHA-256: ${expectedCaptureDigest}`);
    expect(result.productionDataRootExistedBeforeInstall).toBe(false);
    expect(result.productionDataRootExistsAfterOpen).toBe(true);
    expect(harness.coldProofBackupSnapshots).toStrictEqual([[], []]);
    const marker = JSON.parse(await readFile(harness.rootMarkerPath, "utf8")) as { root: string; existedBeforePhase: boolean };
    expect(marker).toStrictEqual({
      schemaVersion: 1,
      root: path.join(await realpath(harness.homeDirectory), "Library", "Application Support", "com.zerodelta.duegood"),
      existedBeforePhase: false,
    });
    expect((await stat(harness.rootMarkerPath)).mode & 0o777).toBe(0o600);
    expect(harness.commands.findIndex(({ command, args }) => command.endsWith("/open") && args.join(" ") === "-b com.zerodelta.duegood"))
      .toBeGreaterThan(harness.commands.findIndex(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f"));
    expect(harness.commands.some(({ command, args }) => command.endsWith("/codesign") && args.includes("--strict"))).toBe(true);
    expect(harness.commands.some(({ command, args }) => command.endsWith("/codesign") && args.some((arg) => arg.endsWith("/duegood-capture-download")))).toBe(true);
    expect(harness.embeddedAssetChecks).toHaveLength(3);
    expect(harness.embeddedAssetChecks[0]).toContain("candidate/Due Good.app/Contents/MacOS/duegood-desktop");
    expect(harness.embeddedAssetChecks[1]).toContain("Applications/.Due Good.staging-");
    expect(harness.embeddedAssetChecks[2]).toContain("Applications/Due Good.app/Contents/MacOS/duegood-desktop");
    expect(await readdir(harness.applications)).toContain("Due Good.app");
  });

  it("refuses an app bundle missing the fixed capture download helper", async () => {
    await rm(path.join(harness.app, captureHelperRelativePath));
    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: (message: string) => harness.logs.push(message),
    })).rejects.toThrow("missing a required regular file");
    expect(await readdir(harness.applications)).toEqual([]);
  });

  it("refuses a candidate whose embedded-asset self-check fails before copying", async () => {
    harness.failedAssetCheckCall = 1;
    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    })).rejects.toThrow("asset check failed");

    expect(harness.embeddedAssetChecks).toHaveLength(1);
    expect(await readdir(harness.applications)).not.toContain("Due Good.app");
    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
  });

  it("removes a new initial install when its installed embedded-asset self-check fails", async () => {
    harness.failedAssetCheckCall = 2;
    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/copied app failed its verification/u);

    expect(harness.embeddedAssetChecks).toHaveLength(2);
    expect(await readdir(harness.applications)).not.toContain("Due Good.app");
    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
    expect(harness.commands.some(({ command }) => command.endsWith("/open"))).toBe(false);
  });

  it.each(["unsigned", "adhoc"] as const)("refuses a %s app before copying", async (mode) => {
    harness.signatureMode = mode;
    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    })).rejects.toThrow();
    expect(await readdir(harness.applications)).not.toContain("Due Good.app");
  });

  it("unregisters stale Due Good paths and refuses a live competing claimant without copying", async () => {
    const competitor = path.join(harness.applications, "Other Due Good.app");
    await harness.makeApp(competitor);
    harness.registrations = [
      "bundle id: com.zerodelta.duegood",
      "path: /private/tmp/missing-old-duegood.app",
      "bundle id: com.zerodelta.duegood",
      `path: ${competitor}`,
    ].join("\n");

    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: (message: string) => harness.logs.push(message),
    })).rejects.toThrow(/different installed app claims/u);

    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-u" && args[1] === "/private/tmp/missing-old-duegood.app")).toBe(true);
    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
    expect(await readdir(harness.applications)).toContain("Other Due Good.app");
    expect(await readdir(harness.applications)).not.toContain("Due Good.app");
  });

  it("upgrades in place and removes the retained backup after a successful verification and open", async () => {
    const installed = path.join(harness.applications, "Due Good.app");
    await harness.makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    const dataRoot = path.join(harness.homeDirectory, "Library", "Application Support", "com.zerodelta.duegood");
    await mkdir(dataRoot, { recursive: true });
    await writeFile(path.join(dataRoot, "owner-data-sentinel"), "keep this data");

    const result = await harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
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
    expect(await harness.exists(removedUpgradeBackup)).toBe(false);
    expect(await readdir(harness.applications)).toEqual(["Due Good.app"]);
    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister")
      && args[0] === "-u" && args[1] === removedUpgradeBackup)).toBe(true);
    expect(harness.coldProofBackupSnapshots).toHaveLength(2);
    expect(harness.coldProofBackupSnapshots.every((snapshot) => snapshot.length === 1 && snapshot[0]?.exists)).toBe(true);
    expect(harness.commands.filter(({ command }) => command.endsWith("/pgrep"))).toHaveLength(2);
    expect(harness.commands.findIndex(({ command }) => command === "native-stop-existing-verified-app")).toBeLessThan(harness.commands.findIndex(({ command }) => command.endsWith("/pgrep")));
  });

  it("removes an older installer-owned backup and unregisters it after success", async () => {
    const installed = path.join(harness.applications, "Due Good.app");
    const priorBackup = path.join(harness.applications, backupEntryName);
    await harness.makeApp(installed);
    await harness.makeApp(priorBackup);
    harness.registrations = [
      "bundle id: com.zerodelta.duegood",
      `path: ${priorBackup}`,
    ].join("\n");

    const result = await harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    });

    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister")
      && args[0] === "-u" && args[1] === priorBackup)).toBe(true);
    expect(await harness.exists(priorBackup)).toBe(false);
    expect(result.backupPath).toBeUndefined();
    expect(result.removedBackupPaths).toHaveLength(2);
    expect(result.removedBackupPaths).toContain(priorBackup);
    expect(await readdir(harness.applications)).toEqual(["Due Good.app"]);
  });

  it("leaves an unknown bundle with a backup-like name untouched on success", async () => {
    const unknown = path.join(harness.applications, backupEntryName);
    await harness.makeApp(unknown, "com.example.not-duegood");

    const result = await harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    });

    expect(await readFile(path.join(unknown, helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(result.removedBackupPaths).toStrictEqual([]);
    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-u" && args[1] === unknown)).toBe(false);
    expect(await readdir(harness.applications).then((names) => names.sort())).toEqual(["Due Good.app", backupEntryName].sort());
  });

  it("leaves a symlinked backup-like entry untouched on success", async () => {
    const target = path.join(harness.temporary, "elsewhere", "Other.app");
    await harness.makeApp(target, "com.example.not-duegood");
    const link = path.join(harness.applications, backupEntryName);
    await symlink(target, link);

    const result = await harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    });

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(target, helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(result.removedBackupPaths).toStrictEqual([]);
  });

  it("refuses a symlinked backup-like bundle that claims the Due Good identifier", async () => {
    const target = path.join(harness.temporary, "elsewhere", "Due Good.app");
    await harness.makeApp(target);
    const link = path.join(harness.applications, backupEntryName);
    await symlink(target, link);

    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/different installed app claims/u);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(target, helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
  });

  it.each([1, 2])("refuses an upgrade if the production app is running at check %i", async (runningCheck) => {
    const installed = path.join(harness.applications, "Due Good.app");
    await harness.makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    harness.productionRunningAtCheck = runningCheck;

    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/production Due Good app is running/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(harness.applications)).toContain("Due Good.app");
    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(false);
  });

  it("restores the prior app when the swapped copy fails verification", async () => {
    const installed = path.join(harness.applications, "Due Good.app");
    await harness.makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    harness.failedAssetCheckCall = 3;

    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/previous app was restored/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(harness.applications)).toEqual(["Due Good.app"]);
    expect(harness.commands.some(({ command, args }) => command.endsWith("/lsregister") && args[0] === "-f")).toBe(true);
  });

  it("restores the prior app when LaunchServices registration fails", async () => {
    const installed = path.join(harness.applications, "Due Good.app");
    await harness.makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    harness.failedLaunchServicesRegistration = true;

    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/previous app was restored/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(harness.applications)).toEqual(["Due Good.app"]);
    expect(harness.commands.some(({ command }) => command.endsWith("/open"))).toBe(false);
  });

  it("reports the restored app path when registering the restored backup fails", async () => {
    const installed = path.join(harness.applications, "Due Good.app");
    await harness.makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    harness.failedLaunchServicesRegistration = true;
    harness.failLaunchServicesRegistrationOnCall = 2;

    const result = await harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    }).then(() => undefined, (error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    const message = (result as Error).message;
    expect(message).toContain(`previous app was restored at ${installed}`);
    expect(message).toContain("registration could not be confirmed");
    expect(message).not.toContain("remains in its backup");
    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(harness.applications)).toEqual(["Due Good.app"]);
    expect(harness.launchServicesRegistrationCalls).toBe(2);
  });

  it("reports an incomplete restore when moving the backup back fails after removing the new app", async () => {
    const installed = path.join(harness.applications, "Due Good.app");
    await harness.makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    harness.failedLaunchServicesRegistration = true;
    let retainedBackupPath = "";
    const files = {
      cp, lstat, readFile, readdir, realpath, rm, writeFile,
      rename: async (source: string, destination: string) => {
        if (source === installed && path.basename(destination).startsWith(".Due Good.backup-")) retainedBackupPath = destination;
        if (retainedBackupPath && source === retainedBackupPath && destination === installed) throw new Error("restore rename failed");
        return fsRename(source, destination);
      },
    };

    const result = await harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      files,
      log: () => undefined,
    }).then(() => undefined, (error: unknown) => error);

    expect(result).toBeInstanceOf(Error);
    const message = (result as Error).message;
    expect(message).toContain("restoration did not complete");
    expect(message).toContain(`previous app remains in its backup at ${retainedBackupPath}`);
    expect(message).not.toContain("new app remains installed");
    expect(retainedBackupPath).not.toBe("");
    expect(await harness.exists(installed)).toBe(false);
    expect(await readFile(path.join(retainedBackupPath, helperRelativePath), "utf8")).toBe("owner-installed bytes");
    expect(await readdir(harness.applications)).toEqual([path.basename(retainedBackupPath)]);
  });

  it("restores the prior app when opening by bundle identifier fails", async () => {
    const installed = path.join(harness.applications, "Due Good.app");
    await harness.makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    harness.failedOpen = true;

    await expect(harness.installDesktopApp({
      appPath: harness.app,
      candidateRoot: harness.candidateRoot,
      sourceCheckout: harness.sourceCheckout,
      applicationsDirectory: harness.applications,
      homeDirectory: harness.homeDirectory,
      rootMarkerPath: harness.rootMarkerPath,
      signingIdentity: identityName,
      platform: "darwin",
      run: harness.fakeRun,
      log: () => undefined,
    })).rejects.toThrow(/previous app was restored/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(harness.applications)).toEqual(["Due Good.app"]);
    expect(harness.commands.some(({ command, args }) => command === "native-rollback-stop-verified-candidate" && args[0] === "801")).toBe(true);
  });
});
