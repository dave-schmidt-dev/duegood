import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { PassThrough } from "node:stream";
import {
  assertSingleOwnedRunningApplication as assertSingleOwnedRunningApplicationRaw,
  assertSnapshotCatalogIdentity as assertSnapshotCatalogIdentityRaw,
  proveColdApplicationLaunch as proveColdApplicationLaunchRaw,
  queryRunningApplicationIdentities as queryRunningApplicationIdentitiesRaw,
  runColdLaunchProof as runColdLaunchProofRaw,
  stopColdVerifiedCandidate as stopColdVerifiedCandidateRaw,
  stopRunningInstalledCandidate as stopRunningInstalledCandidateRaw,
  stopVerifiedCandidate as stopVerifiedCandidateRaw,
} from "../../scripts/install-desktop-launch.mjs";

const bundleId = "com.zerodelta.duegood";
const appPath = "/Applications/Due Good.app";
const executablePath = `${appPath}/Contents/MacOS/duegood-desktop`;

type Identity = { pid: number; appPath: string; executablePath: string };
type AppEvidence = {
  rootPath: string;
  openedRoot: { device: number; inode: number; uid: number; mode: number; kind: string };
  currentRoot: { device: number; inode: number; uid: number; mode: number; kind: string };
  openedLock: { device: number; inode: number; uid: number; mode: number; kind: string };
  currentLock: { device: number; inode: number; uid: number; mode: number; kind: string };
};
type ProofOptions = {
  bundleId: string;
  appPath: string;
  query: (bundleId: string) => Promise<Identity[]>;
  launchByPath: (appPath: string) => Promise<string>;
  launchByBundleId: (bundleId: string, appPath: string) => Promise<string>;
  withSnapshotLock: (callback: () => Promise<unknown>) => Promise<unknown>;
  inspectProcess: (pid: number, bundleId: string) => Promise<Identity>;
  stopProcess: (identity: Identity, bundleId: string) => Promise<void>;
  onOwnedLaunch?: (identity: Identity, method: string) => void;
};
const proveColdApplicationLaunch = proveColdApplicationLaunchRaw as unknown as (options: ProofOptions) => Promise<{ exactPath: Identity; bundleId: Identity }>;
const assertSingleOwnedRunningApplication = assertSingleOwnedRunningApplicationRaw as unknown as
  (apps: Identity[], options: { appPath: string; expectedPid?: number; bundleId?: string }) => Identity;
const assertSnapshotCatalogIdentity = assertSnapshotCatalogIdentityRaw as unknown as
  (evidence: AppEvidence, options: { dataRoot: string; uid: number }) => boolean;
const stopVerifiedCandidate = stopVerifiedCandidateRaw as unknown as (options: {
  bundleId: string;
  appPath: string;
  pid: number;
  dataRoot: string;
  query: (options: { bundleId: string }) => Promise<Identity[]>;
  withSnapshotLock: (callback: () => Promise<unknown>) => Promise<unknown>;
  inspectProcess: (pid: number, bundleId: string) => Promise<Identity>;
  stopProcess: (identity: Identity, bundleId: string) => Promise<void>;
}) => Promise<void>;
const stopRunningInstalledCandidate = stopRunningInstalledCandidateRaw as unknown as (options: {
  bundleId: string; appPath: string; dataRoot: string; query: (options: { bundleId: string }) => Promise<Identity[]>;
  stopCandidate: (options: { bundleId: string; appPath: string; pid: number; dataRoot: string }) => Promise<void>;
}) => Promise<boolean>;
const queryRunningApplicationIdentities = queryRunningApplicationIdentitiesRaw as unknown as (options: {
  bundleId: string; environment?: Record<string, string>; inheritEnvironment?: boolean;
  run: (code: string, options: { env: Record<string, string>; inheritEnvironment: boolean; maxBytes: number }) => Promise<string>;
}) => Promise<Identity[]>;
const runColdLaunchProof = runColdLaunchProofRaw as unknown as (options: {
  bundleId: string; appPath: string; dataRoot: string;
  spawnImpl: (command: string, args: string[], options: { env: Record<string, string | undefined> }) => unknown;
}) => Promise<{ exactPath: Identity; bundleId: Identity }>;
const stopColdVerifiedCandidate = stopColdVerifiedCandidateRaw as unknown as (options: {
  bundleId: string; appPath: string; pid: number; dataRoot: string;
  spawnImpl: (command: string, args: string[], options: { env: Record<string, string | undefined> }) => unknown;
}) => Promise<void>;

function launchedLine(identity: Identity): string {
  return `${identity.pid}\t${identity.appPath}\t${identity.executablePath}\n`;
}

function makeSnapshotEvidence(): AppEvidence {
  return {
    rootPath: "/Users/test/Library/Application Support/com.zerodelta.duegood",
    openedRoot: { device: 7, inode: 11, uid: 501, mode: 0o700, kind: "directory" },
    currentRoot: { device: 7, inode: 11, uid: 501, mode: 0o700, kind: "directory" },
    openedLock: { device: 7, inode: 12, uid: 501, mode: 0o600, kind: "regular" },
    currentLock: { device: 7, inode: 12, uid: 501, mode: 0o600, kind: "regular" },
  };
}

function makeNativeChild({ output = "", holdForInput = false }: { output?: string; holdForInput?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => void;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => undefined;
  const finish = () => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  };
  if (holdForInput) {
    child.stdin.once("finish", finish);
    process.nextTick(() => child.stdout.write(output));
  } else {
    process.nextTick(() => {
      if (output) child.stdout.write(output);
      finish();
    });
  }
  return child;
}

function nativeSpawnHarness(queryRows: Identity[][]) {
  const calls: Array<{ code: string; env: Record<string, string | undefined> }> = [];
  const dataRoot = `${homedir()}/Library/Application Support/com.zerodelta.duegood`;
  let queryIndex = 0;
  const spawnImpl = (_command: string, args: string[], options: { env: Record<string, string | undefined> }) => {
    const code = args[1] ?? "";
    calls.push({ code, env: options.env });
    if (code.includes("LOCKED\\t")) {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      const evidence = {
        rootPath: dataRoot,
        openedRoot: { device: 7, inode: 11, uid, mode: 0o700, kind: "directory" },
        currentRoot: { device: 7, inode: 11, uid, mode: 0o700, kind: "directory" },
        openedLock: { device: 7, inode: 12, uid, mode: 0o600, kind: "regular" },
        currentLock: { device: 7, inode: 12, uid, mode: 0o600, kind: "regular" },
      };
      return makeNativeChild({ output: `LOCKED\t${JSON.stringify(evidence)}\n`, holdForInput: true });
    }
    if (code.includes("JSONSerialization.data(withJSONObject: rows)")) {
      const rows = (queryRows[queryIndex++] ?? []).map((identity) => [identity.pid, identity.appPath, identity.executablePath]);
      return makeNativeChild({ output: `${JSON.stringify(rows)}\n` });
    }
    if (code.includes("DUEGOOD_LAUNCH_APP_PATH")) {
      return makeNativeChild({ output: `${41}\t${appPath}\t${executablePath}\n` });
    }
    if (code.includes("urlForApplication(withBundleIdentifier")) {
      return makeNativeChild({ output: `${42}\t${appPath}\t${executablePath}\n` });
    }
    return makeNativeChild();
  };
  return { calls, dataRoot, spawnImpl };
}

function proofHarness({ initiallyRunning = [] as Identity[], pathIdentity = { pid: 41, appPath, executablePath }, bundleIdentity = { pid: 42, appPath, executablePath }, lockFails = false, stopFails = false } = {}): ProofOptions & { events: string[]; running: () => Identity[] } {
  const events: string[] = [];
  let running = [...initiallyRunning];
  const query = async () => { events.push("query"); return [...running]; };
  const harness = {
    bundleId,
    appPath,
    events,
    query,
    launchByPath: async () => { events.push("launch-path"); running = [pathIdentity]; return launchedLine(pathIdentity); },
    launchByBundleId: async () => { events.push("launch-bundle-id"); running = [bundleIdentity]; return launchedLine(bundleIdentity); },
    withSnapshotLock: async (callback: () => Promise<unknown>) => {
      events.push("lock-acquire");
      if (lockFails) throw new Error("snapshot lock busy");
      try { return await callback(); }
      finally { events.push("lock-release"); }
    },
    inspectProcess: async (pid: number) => {
      events.push(`inspect-${pid}`);
      const found = running.find((item) => item.pid === pid);
      if (!found) throw new Error("The requested process is not running.");
      return found;
    },
    stopProcess: async (identity: Identity) => {
      events.push(`stop-${identity.pid}`);
      if (stopFails) throw new Error("termination deadline exceeded");
      running = running.filter((item) => item.pid !== identity.pid);
    },
    running: () => running,
  };
  return harness;
}

describe("installed-app stop identity", () => {
  const dataRoot = "/Users/test/Library/Application Support/com.zerodelta.duegood";
  it("leaves no-process and unsafe-identity cases untouched", async () => {
    let stopped = false;
    const stopCandidate = async () => { stopped = true; };
    const query = async () => [];
    await expect(stopRunningInstalledCandidate({ bundleId, appPath, dataRoot, query, stopCandidate })).resolves.toBe(false);
    await expect(stopRunningInstalledCandidate({ bundleId, appPath, dataRoot, query: async () => [{ pid: 51, appPath: "/Applications/Other.app", executablePath }], stopCandidate })).rejects.toThrow(/did not match/u);
    await expect(stopRunningInstalledCandidate({ bundleId, appPath, dataRoot, query: async () => [{ pid: 51, appPath, executablePath }, { pid: 52, appPath, executablePath }], stopCandidate })).rejects.toThrow(/exactly one/u);
    expect(stopped).toBe(false);
  });

  it("passes only the exact installed PID into the bounded stop operation", async () => {
    const events: string[] = [];
    const identity = { pid: 53, appPath, executablePath };
    await expect(stopRunningInstalledCandidate({ bundleId, appPath, dataRoot, query: async () => [identity], stopCandidate: async (options) => { events.push(`${options.bundleId}:${options.appPath}:${options.pid}:${options.dataRoot}`); } })).resolves.toBe(true);
    expect(events).toStrictEqual([`${bundleId}:${appPath}:53:${dataRoot}`]);
  });
});

describe("read-only process identity query", () => {
  it("passes an allowlisted environment without inheritance and preserves default inheritance", async () => {
    const calls: Array<{ env: Record<string, string>; inheritEnvironment: boolean }> = [];
    const run = async (_code: string, options: { env: Record<string, string>; inheritEnvironment: boolean }) => {
      calls.push({ env: options.env, inheritEnvironment: options.inheritEnvironment });
      return "[]";
    };
    await queryRunningApplicationIdentities({ bundleId, environment: { HOME: "/Users/test", PATH: "/usr/bin" }, inheritEnvironment: false, run });
    await queryRunningApplicationIdentities({ bundleId, run });
    expect(calls).toStrictEqual([
      { env: { HOME: "/Users/test", PATH: "/usr/bin", DUEGOOD_QUERY_BUNDLE_ID: bundleId }, inheritEnvironment: false },
      { env: { DUEGOOD_QUERY_BUNDLE_ID: bundleId }, inheritEnvironment: true },
    ]);
  });
});

describe("native cold-launch adapter environment", () => {
  it("passes the bundle ID into each real identity query during both cold launch proofs", async () => {
    const exactPathIdentity = { pid: 41, appPath, executablePath };
    const bundleIdentity = { pid: 42, appPath, executablePath };
    const harness = nativeSpawnHarness([
      [],
      [exactPathIdentity],
      [exactPathIdentity],
      [exactPathIdentity],
      [],
      [],
      [bundleIdentity],
    ]);

    await expect(runColdLaunchProof({ bundleId, appPath, dataRoot: harness.dataRoot, spawnImpl: harness.spawnImpl })).resolves.toStrictEqual({
      exactPath: exactPathIdentity,
      bundleId: bundleIdentity,
    });

    const queryCalls = harness.calls.filter(({ code }) => code.includes("JSONSerialization.data(withJSONObject: rows)"));
    expect(queryCalls).toHaveLength(7);
    expect(queryCalls.map(({ env }) => env.DUEGOOD_QUERY_BUNDLE_ID)).toStrictEqual(Array(7).fill(bundleId));
    expect(harness.calls.find(({ code }) => code.includes("DUEGOOD_LAUNCH_APP_PATH"))?.env).toMatchObject({
      DUEGOOD_LAUNCH_APP_PATH: appPath,
    });
    expect(harness.calls.find(({ code }) => code.includes("urlForApplication(withBundleIdentifier"))?.env).toMatchObject({
      DUEGOOD_QUERY_BUNDLE_ID: bundleId,
      DUEGOOD_EXPECTED_APP_PATH: appPath,
    });
  });

  it("passes the bundle ID into rollback identity queries before stopping the recorded PID", async () => {
    const identity = { pid: 73, appPath, executablePath };
    const harness = nativeSpawnHarness([[identity], [identity], []]);

    await stopColdVerifiedCandidate({ bundleId, appPath, pid: identity.pid, dataRoot: harness.dataRoot, spawnImpl: harness.spawnImpl });

    const queryCalls = harness.calls.filter(({ code }) => code.includes("JSONSerialization.data(withJSONObject: rows)"));
    expect(queryCalls).toHaveLength(3);
    expect(queryCalls.map(({ env }) => env.DUEGOOD_QUERY_BUNDLE_ID)).toStrictEqual(Array(3).fill(bundleId));
    const stopCall = harness.calls.find(({ code }) => code.includes("DUEGOOD_EXPECTED_EXECUTABLE_PATH"));
    expect(stopCall?.env).toMatchObject({
      DUEGOOD_QUERY_BUNDLE_ID: bundleId,
      DUEGOOD_EXPECTED_APP_PATH: appPath,
      DUEGOOD_QUERY_PID: String(identity.pid),
    });
  });
});

describe("cold installed-app launch identity", () => {
  it("proves exact-path launch, quiesces and stops its PID, then cold-resolves the bundle ID", async () => {
    const harness = proofHarness();
    const observed: Array<{ pid: number; method: string }> = [];
    const proof = await proveColdApplicationLaunch({
      ...harness,
      onOwnedLaunch: (identity, method) => observed.push({ pid: identity.pid, method }),
    });

    expect(proof).toStrictEqual({
      exactPath: { pid: 41, appPath, executablePath },
      bundleId: { pid: 42, appPath, executablePath },
    });
    expect(observed).toStrictEqual([{ pid: 41, method: "exact-path" }, { pid: 42, method: "bundle-id" }]);
    expect(harness.events.indexOf("stop-41")).toBeGreaterThan(harness.events.indexOf("lock-acquire"));
    expect(harness.events.indexOf("lock-release")).toBeGreaterThan(harness.events.indexOf("stop-41"));
    expect(harness.events.indexOf("launch-bundle-id")).toBeGreaterThan(harness.events.indexOf("lock-release"));
    expect(harness.running()).toStrictEqual([{ pid: 42, appPath, executablePath }]);
  });

  it("refuses an already-running process before either cold launch", async () => {
    const harness = proofHarness({ initiallyRunning: [{ pid: 7, appPath, executablePath }] });
    await expect(proveColdApplicationLaunch(harness)).rejects.toThrow(/already running/u);
    expect(harness.events).toStrictEqual(["query"]);
  });

  it("refuses a path launch with a different executable before taking the snapshot lock", async () => {
    const harness = proofHarness({ pathIdentity: { pid: 41, appPath, executablePath: "/tmp/other" } });
    await expect(proveColdApplicationLaunch(harness)).rejects.toThrow(/did not match/u);
    expect(harness.events).not.toContain("lock-acquire");
    expect(harness.events).not.toContain("launch-bundle-id");
  });

  it("does not attempt bundle-ID resolution when snapshot activity fails to quiesce", async () => {
    const harness = proofHarness({ lockFails: true });
    await expect(proveColdApplicationLaunch(harness)).rejects.toThrow("snapshot lock busy");
    expect(harness.events).not.toContain("launch-bundle-id");
    expect(harness.events).not.toContain("stop-41");
  });

  it("releases snapshot quiescence and refuses the second launch when termination times out", async () => {
    const harness = proofHarness({ stopFails: true });
    await expect(proveColdApplicationLaunch(harness)).rejects.toThrow("termination deadline exceeded");
    expect(harness.events).toContain("lock-release");
    expect(harness.events).not.toContain("launch-bundle-id");
  });

  it("rejects a bundle-ID result whose URL or executable is not the installed candidate", async () => {
    const harness = proofHarness({ bundleIdentity: { pid: 42, appPath: "/Applications/Other.app", executablePath } });
    await expect(proveColdApplicationLaunch(harness)).rejects.toThrow(/did not match/u);
  });

  it("requires exactly one live process at the expected bundle path and executable", () => {
    const validIdentity = { pid: 45, appPath, executablePath };
    const valid = [validIdentity];
    expect(assertSingleOwnedRunningApplication(valid, { bundleId, appPath, expectedPid: 45 })).toStrictEqual(valid[0]);
    expect(() => assertSingleOwnedRunningApplication([...valid, { pid: 46, appPath, executablePath }], { bundleId, appPath })).toThrow(/exactly one/u);
    expect(() => assertSingleOwnedRunningApplication([{ ...validIdentity, executablePath: "/tmp/other" }], { bundleId, appPath })).toThrow(/did not match/u);
  });
});

describe("snapshot catalog lock identity", () => {
  it("accepts matching canonical root and lock descriptor identities", () => {
    expect(assertSnapshotCatalogIdentity(makeSnapshotEvidence(), {
      dataRoot: "/Users/test/Library/Application Support/com.zerodelta.duegood",
      uid: 501,
    })).toBe(true);
  });

  it.each([
    ["root pathname replacement", (evidence: AppEvidence) => { evidence.currentRoot.inode += 1; }],
    ["lock leaf replacement", (evidence: AppEvidence) => { evidence.currentLock.inode += 1; }],
    ["non-regular lock leaf", (evidence: AppEvidence) => { evidence.currentLock.kind = "fifo"; }],
    ["wrong lock mode", (evidence: AppEvidence) => { evidence.openedLock.mode = 0o666; }],
  ] as const)("rejects %s", (_label, mutate) => {
    const evidence = makeSnapshotEvidence();
    mutate(evidence);
    expect(() => assertSnapshotCatalogIdentity(evidence, {
      dataRoot: "/Users/test/Library/Application Support/com.zerodelta.duegood",
      uid: 501,
    })).toThrow();
  });

  it("rollback stops only the recorded exact process while holding snapshot quiescence", async () => {
    const events: string[] = [];
    const identity = { pid: 73, appPath, executablePath };
    let running = [identity];
    await stopVerifiedCandidate({
      bundleId,
      appPath,
      pid: identity.pid,
      dataRoot: "/Users/test/Library/Application Support/com.zerodelta.duegood",
      query: async () => { events.push("query"); return [...running]; },
      withSnapshotLock: async (callback) => { events.push("lock"); try { await callback(); } finally { events.push("unlock"); } },
      inspectProcess: async () => {
        events.push("verify");
        const current = running[0];
        if (!current) throw new Error("process absent");
        return current;
      },
      stopProcess: async (current) => { events.push(`stop-${current.pid}`); running = []; },
    });
    expect(events).toStrictEqual(["lock", "query", "verify", "stop-73", "query", "unlock"]);
  });

  it("fails closed if rollback finds a different running process", async () => {
    let stopped = false;
    await expect(stopVerifiedCandidate({
      bundleId,
      appPath,
      pid: 73,
      dataRoot: "/Users/test/Library/Application Support/com.zerodelta.duegood",
      query: async () => [{ pid: 74, appPath: "/Applications/Other.app", executablePath: "/Applications/Other.app/Contents/MacOS/duegood-desktop" }],
      withSnapshotLock: async (callback) => callback(),
      inspectProcess: async () => { throw new Error("must not inspect an unrelated PID"); },
      stopProcess: async () => { stopped = true; },
    })).rejects.toThrow(/Another Due Good process/u);
    expect(stopped).toBe(false);
  });
});
