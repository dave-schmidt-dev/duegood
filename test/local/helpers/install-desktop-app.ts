import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { installDesktopApp as installDesktopAppImplementationRaw } from "../../../scripts/install-desktop-app.mjs";
import { acquireOwnedStageRoot } from "../../../scripts/owned-stage-root.mjs";

export const identityHash = "A".repeat(40);
export const identityName = "Developer ID Application: Zero Delta LLC (US) (4CJ49V6QHW)";
export const candidateTree = "1234567890abcdef1234567890abcdef12345678";
export const helperRelativePath = "Contents/MacOS/duegood-refresh";
export const captureHelperRelativePath = "Contents/MacOS/duegood-capture-download";
export const backupEntryName = ".Due Good.backup-01234567-89ab-cdef-0123-456789abcdef.app";

export type InstallResult = {
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

type OwnedStageRoot = {
  ownership: Record<string, unknown>;
  close: () => Promise<void>;
};

export interface InstallDesktopAppFixture {
  temporary: string;
  app: string;
  candidateRoot: string;
  applications: string;
  sourceCheckout: string;
  homeDirectory: string;
  rootMarkerPath: string;
  commands: Array<{ command: string; args: string[]; cwd?: string }>;
  logs: string[];
  registrations: string;
  signatureMode: "valid" | "unsigned" | "adhoc";
  embeddedAssetChecks: string[];
  failedAssetCheckCall: number | undefined;
  bundleIds: Map<string, string>;
  productionRunningAtCheck: number | undefined;
  productionRunningChecks: number;
  failedLaunchServicesRegistration: boolean;
  launchServicesFailureConsumed: boolean;
  failLaunchServicesRegistrationOnCall: number | undefined;
  launchServicesRegistrationCalls: number;
  failedOpen: boolean;
  stageLockToCorrupt: string | undefined;
  coldProofBackupSnapshots: Array<Array<{ path: string; exists: boolean }>>;
  makeApp: (appPath: string, id?: string) => Promise<void>;
  exists: (target: string) => Promise<boolean>;
  writeReceipt: (directory: string, extra?: Record<string, unknown>) => Promise<void>;
  makeOwnedHandoffStage: (options?: {
    relative?: string[];
    stageRootOverride?: string;
    sourceRootOverride?: string;
    handoff?: boolean;
    keep?: boolean;
  }) => Promise<string>;
  stageLockPath: (stageRoot: string) => string;
  expectStagePurposeReusable: (stageRoot: string) => Promise<void>;
  installFromStage: (stageRoot: string, overrides?: Record<string, unknown>) => Promise<InstallResult>;
  installDesktopApp: (options?: Record<string, unknown>) => Promise<InstallResult>;
  fakeRun: (command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string; code?: number }>;
  fakeLaunchProof: (options: {
    appPath: string;
    onOwnedLaunch: (identity: { pid: number; appPath: string; executablePath: string }, method: string) => void;
  }) => Promise<{ exactPath: { pid: number; appPath: string; executablePath: string }; bundleId: { pid: number; appPath: string; executablePath: string } }>;
  cleanup: () => Promise<void>;
}

const installDesktopAppImplementation = installDesktopAppImplementationRaw as unknown as
  (options: Record<string, unknown>) => Promise<InstallResult>;
const acquireOwnedStageRootForTest = acquireOwnedStageRoot as unknown as
  (options: { source: string; destination?: string; keep?: boolean }) => Promise<OwnedStageRoot>;

/** Create an isolated filesystem and all fake native adapters for one installer test. */
export async function createInstallDesktopAppFixture(): Promise<InstallDesktopAppFixture> {
  async function makeApp(appPath: string, id = "com.zerodelta.duegood"): Promise<void> {
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
    fixture.bundleIds.set(await realpath(appPath), id);
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await lstat(target);
      return true;
    } catch {
      return false;
    }
  }

  async function writeReceipt(directory: string, extra: Record<string, unknown> = {}): Promise<void> {
    await writeFile(path.join(directory, "receipt.json"), `${JSON.stringify({
      schemaVersion: 1,
      stagedMatchesCandidate: true,
      treeDigest: candidateTree,
      ...extra,
    })}\n`);
  }

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
    const stageRoot = path.join(fixture.sourceCheckout, ".stage", ...relative);
    const actualHandoff = handoff && relative.length === 1 && !stageRootOverride && !sourceRootOverride;
    const ownership = actualHandoff
      ? (await acquireOwnedStageRootForTest({ source: fixture.sourceCheckout, destination: stageRoot, keep })).ownership
      : {
          schemaVersion: 1,
          owner: "duegood-stage",
          projectRoot: sourceRootOverride ?? fixture.sourceCheckout,
          stageRoot: stageRootOverride ?? stageRoot,
          lockPath: path.join(fixture.sourceCheckout, ".stage", ".locks", `${path.basename(stageRoot)}.lock`),
          purpose: path.basename(stageRoot),
          handoff,
          keep,
        };
    await mkdir(path.join(stageRoot, ".git"), { recursive: true });
    await makeApp(path.join(stageRoot, "build", "Due Good.app"));
    await writeReceipt(stageRoot, { stageOwnership: ownership });
    return stageRoot;
  }

  function stageLockPath(stageRoot: string): string {
    return path.join(fixture.sourceCheckout, ".stage", ".locks", `${path.basename(stageRoot)}.lock`);
  }

  async function expectStagePurposeReusable(stageRoot: string): Promise<void> {
    const lifecycle = await acquireOwnedStageRootForTest({ source: fixture.sourceCheckout, destination: stageRoot });
    await lifecycle.close();
  }

  function installFromStage(stageRoot: string, overrides: Record<string, unknown> = {}): Promise<InstallResult> {
    return fixture.installDesktopApp({
      candidateRoot: stageRoot,
      sourceCheckout: fixture.sourceCheckout,
      applicationsDirectory: fixture.applications,
      homeDirectory: fixture.homeDirectory,
      rootMarkerPath: path.join(stageRoot, ".git", "phase4-root-marker.json"),
      signingIdentity: identityName,
      platform: "darwin",
      run: fixture.fakeRun,
      log: (message: string) => fixture.logs.push(message),
      ...overrides,
    });
  }

  async function fakeRun(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number }) {
    fixture.commands.push({ command, args, cwd: options?.cwd });
    if (command === "git" && args[0] === "rev-parse") return Promise.resolve({ stdout: `${candidateTree}\n`, stderr: "" });
    if (command === "git" && args[0] === "describe") return Promise.resolve({ stdout: "v0.1.0-4-gabc1234-dirty\n", stderr: "" });
    if (command.endsWith("/PlistBuddy")) {
      const plist = args[2] ?? "";
      const appRoot = await realpath(path.dirname(path.dirname(plist)));
      return Promise.resolve({ stdout: `${fixture.bundleIds.get(appRoot) ?? "com.zerodelta.duegood"}\n`, stderr: "" });
    }
    if (command.endsWith("/pgrep") && args.join(" ") === "-x duegood-desktop") {
      fixture.productionRunningChecks += 1;
      return Promise.resolve({ stdout: "", stderr: "", code: fixture.productionRunningChecks === fixture.productionRunningAtCheck ? 0 : 1 });
    }
    if (command.endsWith("/security")) return Promise.resolve({ stdout: `  1 valid identities found\n     ${identityHash} "${identityName}"\n`, stderr: "" });
    if (command.endsWith("/duegood-desktop") && args[0] === "--verify-embedded-assets") {
      fixture.embeddedAssetChecks.push(command);
      if (fixture.stageLockToCorrupt) {
        await writeFile(path.join(fixture.stageLockToCorrupt, "owner.json"), "{}\n");
        fixture.stageLockToCorrupt = undefined;
      }
      if (fixture.embeddedAssetChecks.length === fixture.failedAssetCheckCall) return Promise.reject(new Error("asset check failed"));
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (command.endsWith("/codesign")) {
      if (fixture.signatureMode === "unsigned" && args[0] === "--verify") return Promise.reject(new Error("unsigned app"));
      if (args[0] === "--display") {
        if (fixture.signatureMode === "adhoc") return Promise.resolve({ stdout: "Signature=adhoc\n", stderr: "" });
        return Promise.resolve({ stdout: "", stderr: `Authority=${identityName}\nAuthority=Developer ID Certification Authority\nSignature=Developer ID\n` });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (command.endsWith("/lsregister")) {
      if (args[0] === "-dump") return Promise.resolve({ stdout: fixture.registrations, stderr: "" });
      if (args[0] === "-f") {
        fixture.launchServicesRegistrationCalls += 1;
        if ((fixture.failedLaunchServicesRegistration && !fixture.launchServicesFailureConsumed)
            || fixture.launchServicesRegistrationCalls === fixture.failLaunchServicesRegistrationOnCall) {
          fixture.launchServicesFailureConsumed = true;
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
    const recordBackups = async () => fixture.coldProofBackupSnapshots.push(await Promise.all(
      (await readdir(fixture.applications)).filter((name) => /^\.Due Good\.backup-[0-9a-f-]{36}\.app$/u.test(name))
        .map(async (name) => ({ path: path.join(fixture.applications, name), exists: await exists(path.join(fixture.applications, name)) })),
    ));
    const exactPathIdentity = { pid: 801, appPath, executablePath: path.join(appPath, "Contents", "MacOS", "duegood-desktop") };
    const bundleIdentity = { pid: 802, appPath, executablePath: path.join(appPath, "Contents", "MacOS", "duegood-desktop") };
    await recordBackups();
    fixture.commands.push({ command: "native-launch-exact-path", args: [appPath] }); onOwnedLaunch(exactPathIdentity, "exact-path");
    fixture.commands.push({ command: "native-stop-under-snapshot-lock", args: [String(exactPathIdentity.pid)] }); await recordBackups();
    fixture.commands.push({ command: "/usr/bin/open", args: ["-b", "com.zerodelta.duegood"] });
    if (fixture.failedOpen) throw new Error("open failed");
    onOwnedLaunch(bundleIdentity, "bundle-id"); await mkdir(path.join(fixture.homeDirectory, "Library", "Application Support", "com.zerodelta.duegood"), { recursive: true });
    return { exactPath: exactPathIdentity, bundleId: bundleIdentity };
  }

  async function fakeStopCandidate({ pid }: { pid: number }): Promise<void> {
    fixture.commands.push({ command: "native-rollback-stop-verified-candidate", args: [String(pid)] });
  }

  const fixture: InstallDesktopAppFixture = {
    temporary: "",
    app: "",
    candidateRoot: "",
    applications: "",
    sourceCheckout: "",
    homeDirectory: "",
    rootMarkerPath: "",
    commands: [],
    logs: [],
    registrations: "bundle id: com.other.app\npath: /Applications/Other.app\n",
    signatureMode: "valid",
    embeddedAssetChecks: [],
    failedAssetCheckCall: undefined,
    bundleIds: new Map(),
    productionRunningAtCheck: undefined,
    productionRunningChecks: 0,
    failedLaunchServicesRegistration: false,
    launchServicesFailureConsumed: false,
    failLaunchServicesRegistrationOnCall: undefined,
    launchServicesRegistrationCalls: 0,
    failedOpen: false,
    stageLockToCorrupt: undefined,
    coldProofBackupSnapshots: [],
    makeApp,
    exists,
    writeReceipt,
    makeOwnedHandoffStage,
    stageLockPath,
    expectStagePurposeReusable,
    installFromStage,
    installDesktopApp: (options = {}) => installDesktopAppImplementation({
      ...options,
      launchProof: fakeLaunchProof,
      stopCandidate: fakeStopCandidate,
      stopExistingApp: async ({ bundleId, appPath, dataRoot }: { bundleId: string; appPath: string; dataRoot: string }) => {
        expect({ bundleId, appPath, dataRoot }).toStrictEqual({
          bundleId: "com.zerodelta.duegood",
          appPath: path.join(fixture.applications, "Due Good.app"),
          dataRoot: path.join(await realpath(fixture.homeDirectory), "Library", "Application Support", "com.zerodelta.duegood"),
        });
        fixture.commands.push({ command: "native-stop-existing-verified-app", args: [bundleId, appPath] });
      },
    }),
    fakeRun,
    fakeLaunchProof,
    cleanup: async () => { await rm(fixture.temporary, { recursive: true, force: true }); },
  };

  try {
    fixture.temporary = await mkdtemp(path.join(tmpdir(), "duegood-install-test-"));
    fixture.candidateRoot = path.join(fixture.temporary, "candidate");
    fixture.app = path.join(fixture.candidateRoot, "Due Good.app");
    fixture.applications = path.join(fixture.temporary, "Applications");
    fixture.sourceCheckout = path.join(fixture.temporary, "source-checkout");
    fixture.homeDirectory = path.join(fixture.temporary, "home");
    fixture.rootMarkerPath = path.join(fixture.candidateRoot, ".git", "phase4-root-marker.json");
    await mkdir(fixture.applications, { recursive: true });
    await mkdir(fixture.sourceCheckout, { recursive: true });
    fixture.sourceCheckout = await realpath(fixture.sourceCheckout);
    await mkdir(path.dirname(fixture.rootMarkerPath), { recursive: true });
    await mkdir(fixture.homeDirectory, { recursive: true });
    await writeReceipt(fixture.candidateRoot);
    await makeApp(fixture.app);
    return fixture;
  } catch (error) {
    if (fixture.temporary) await rm(fixture.temporary, { recursive: true, force: true });
    throw error;
  }
}
