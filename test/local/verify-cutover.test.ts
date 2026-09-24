import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareLayoutTrees, verifyCutover } from "../../scripts/verify-cutover.mjs";

const roots: string[] = [];
const timestamp = "2026-09-23T00:00:00Z";

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "duegood-cutover-synthetic-"));
  roots.push(root);
  return root;
}

async function createInputs(root: string, state: "preview" | "authoritative" = "authoritative") {
  const sourceRoot = path.join(root, "synthetic-legacy-layout");
  const exportRoot = path.join(root, "synthetic-export-layout");
  const storeRoot = path.join(root, "synthetic-store");
  const appPath = path.join(root, "synthetic-Applications", "Due Good.app");
  const helperPath = path.join(appPath, "Contents", "MacOS", "duegood-refresh");
  const brokerPath = path.join(root, ".agent", "bin", "bws-secret-exec");
  const launchAgents = path.join(root, "Library", "LaunchAgents");
  await mkdir(path.join(sourceRoot, "classes", "synthetic-101"), { recursive: true });
  await mkdir(path.join(exportRoot, "classes", "synthetic-101"), { recursive: true });
  await mkdir(storeRoot);
  await mkdir(path.dirname(helperPath), { recursive: true });
  await mkdir(path.dirname(brokerPath), { recursive: true });
  await mkdir(launchAgents, { recursive: true });
  await writeFile(path.join(sourceRoot, "coursework.json"), '{"items":[]}\n');
  await writeFile(path.join(exportRoot, "coursework.json"), '{"items":[]}\n');
  await writeFile(path.join(sourceRoot, "classes", "synthetic-101", "coursework.md"), "Synthetic-only report\n");
  await writeFile(path.join(exportRoot, "classes", "synthetic-101", "coursework.md"), "Synthetic-only report\n");
  await writeFile(path.join(storeRoot, "duegood-store.json"), JSON.stringify({
    format: "duegood-store",
    version: 1,
    state,
    createdAt: timestamp,
    importedAt: timestamp,
    source: { kind: "legacy-import", files: 2, bytes: 39, treeDigest: "a".repeat(64) },
  }));
  if (state === "authoritative") {
    await writeFile(path.join(storeRoot, "coursework-refresh-history.json"), JSON.stringify({
      schema: 1,
      events: [{ status: "succeeded", sourceComplete: true, finishedAt: timestamp }],
    }));
  }
  await writeFile(path.join(root, "canvas-refresh-enabled.json"), '{"canvasRefreshEnabled":true}\n', { mode: 0o600 });
  await chmod(path.join(root, "canvas-refresh-enabled.json"), 0o600);
  await writeFile(path.join(appPath, "Contents", "Info.plist"), "synthetic plist\n");
  await writeFile(helperPath, "synthetic helper executable\n", { mode: 0o700 });
  await chmod(helperPath, 0o700);
  await writeFile(brokerPath, "synthetic broker executable\n", { mode: 0o700 });
  await chmod(brokerPath, 0o700);
  await writeFile(path.join(launchAgents, "com.synthetic.legacy.plist"), "synthetic launch agent\n");
  return { sourceRoot, exportRoot, storeRoot, home: root, appPath, helperPath, brokerPath };
}

function optionsFor(inputs: Awaited<ReturnType<typeof createInputs>>, mode: "rehearsal" | "final" = "rehearsal", checkpoint = "post-refresh") {
  return {
    mode,
    ...(mode === "rehearsal" ? { checkpoint } : {}),
    sourceRoot: inputs.sourceRoot,
    exportRoot: inputs.exportRoot,
    storeRoot: inputs.storeRoot,
    serviceLabel: "com.synthetic.legacy",
    consumerAttestation: mode === "final"
      ? "owner-confirmed-legacy-disabled"
      : checkpoint === "rollback" ? "owner-confirmed-legacy-enabled" : "owner-confirmed-desktop-enabled",
  };
}

function fakeSpawn(inputs: Awaited<ReturnType<typeof createInputs>>, { loaded = false, disabled = false, output = "" } = {}) {
  return (command: string, args: string[]) => {
    if (command === "launchctl" && args[0] === "print") {
      return loaded
        ? { status: 0, stdout: "", stderr: output }
        : { status: 113, stdout: "", stderr: output };
    }
    if (command === "launchctl" && args[0] === "print-disabled") {
      return {
        status: 0,
        stdout: disabled
          ? 'disabled services = {\n  "com.synthetic.legacy" => disabled\n}\n'
          : "disabled services = { }\n",
        stderr: "",
      };
    }
    if (command === "open") {
      expect(args).toEqual(["-b", "com.zerodelta.duegood"]);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "/usr/libexec/PlistBuddy" && args[0] === "-c" && args[1] === "Print :CFBundleIdentifier") {
      return { status: 0, stdout: "com.zerodelta.duegood\n", stderr: "" };
    }
    if (command === "/usr/libexec/PlistBuddy" && args[0] === "-c" && args[1] === "Print :Label") {
      return { status: 0, stdout: "com.synthetic.legacy\n", stderr: "" };
    }
    if (command === "/usr/bin/codesign") {
      if (args[0] === "--verify") return { status: 0, stdout: "", stderr: "" };
      return {
        status: 0,
        stdout: `Identifier=com.zerodelta.duegood\nAuthority=Developer ID Application: Synthetic LLC (ABCDE12345)\nAuthority=Developer ID Certification Authority\n`,
        stderr: "",
      };
    }
    if (command.endsWith("/lsregister") && args[0] === "-dump") {
      return { status: 0, stdout: `bundle id: com.zerodelta.duegood\n path: ${inputs.appPath}\n`, stderr: "" };
    }
    if (command === inputs.helperPath && args[0] === "--report-store-root") {
      return { status: 0, stdout: `${inputs.storeRoot}\n`, stderr: "" };
    }
    throw new Error("unexpected synthetic command");
  };
}

function dependenciesFor(inputs: Awaited<ReturnType<typeof createInputs>>, flags: { loaded?: boolean; disabled?: boolean; output?: string } = {}) {
  return {
    spawnSync: fakeSpawn(inputs, flags),
    getuid: () => 501,
    home: inputs.home,
    expectedStoreRoot: inputs.storeRoot,
    systemPaths: { appPath: inputs.appPath, helperPath: inputs.helperPath },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verifyCutover", () => {
  it("reports content-free equality and the post-refresh rehearsal state", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root, "authoritative");
    const progress: string[] = [];
    const report = await verifyCutover(optionsFor(inputs), {
      ...dependenciesFor(inputs, { loaded: false, disabled: false }),
      onStatus: ({ step }: { step: string }) => progress.push(step),
    });

    expect(report).toEqual({
      mode: "rehearsal",
      checkpoint: "post-refresh",
      equality: "equal",
      storeState: "authoritative",
      refreshAvailability: "enabled-local-prerequisites",
      appResolution: "open-b-resolved",
      service: { loaded: "unloaded", plist: "enabled" },
      consumer: { evidence: "owner-attested", status: "owner-confirmed-desktop-enabled" },
    });
    expect(progress).toContain("compare-source-layout");
    expect(progress).toContain("validate-store-manifest");
    expect(JSON.stringify(report)).not.toContain(root);
    expect(JSON.stringify(report)).not.toContain("synthetic-legacy-layout");
  });

  it("bounds the installed-app registry query above the observed 48 MB host output", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root);
    const syntheticSpawn = fakeSpawn(inputs);
    let registryBound = 0;
    await verifyCutover(optionsFor(inputs), {
      ...dependenciesFor(inputs),
      spawnSync: (command: string, args: string[], options: { maxBuffer?: number }) => {
        if (command.endsWith("/lsregister") && args[0] === "-dump") registryBound = options.maxBuffer ?? 0;
        return syntheticSpawn(command, args);
      },
    });
    expect(registryBound).toBeGreaterThanOrEqual(48 * 1024 * 1024);
    expect(registryBound).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it("accepts the rollback checkpoint only with a preview store and restored service", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root, "preview");
    const report = await verifyCutover(optionsFor(inputs, "rehearsal", "rollback"), {
      ...dependenciesFor(inputs, { loaded: true, disabled: false }),
    });
    expect(report.storeState).toBe("preview");
    expect(report.refreshAvailability).toBe("unavailable-preview");
    expect(report.service).toEqual({ loaded: "loaded", plist: "enabled" });
  });

  it("refuses an exact-tree mismatch without naming a file or path", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root);
    await writeFile(path.join(inputs.exportRoot, "private-synthetic-sentinel.txt"), "different synthetic bytes");
    await expect(compareLayoutTrees(inputs)).rejects.toMatchObject({ code: "tree-mismatch" });
    await expect(verifyCutover(optionsFor(inputs), dependenciesFor(inputs)))
      .rejects.toMatchObject({ code: "tree-mismatch" });
  });

  it("refuses symlinks anywhere in either layout tree", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root);
    await symlink("coursework.json", path.join(inputs.exportRoot, "linked-synthetic-file"));
    await expect(compareLayoutTrees(inputs)).rejects.toMatchObject({ code: "tree-symlink-or-type" });
  });

  it("refuses matching empty or unrelated roots without coursework layout anchors", async () => {
    const root = await fixtureRoot();
    const sourceRoot = path.join(root, "empty-source");
    const exportRoot = path.join(root, "empty-export");
    await Promise.all([mkdir(sourceRoot), mkdir(exportRoot)]);
    await expect(compareLayoutTrees({ sourceRoot, exportRoot }))
      .rejects.toMatchObject({ code: "layout-anchor-missing-or-invalid" });
    await Promise.all([
      writeFile(path.join(sourceRoot, "unrelated.txt"), "same"),
      writeFile(path.join(exportRoot, "unrelated.txt"), "same"),
    ]);
    await expect(compareLayoutTrees({ sourceRoot, exportRoot }))
      .rejects.toMatchObject({ code: "layout-anchor-missing-or-invalid" });
  });

  it("derives the broker from the account home and rejects caller-selected paths", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root);
    // The normal dependency set has no broker override; verification found the executable under
    // this account home, exercising the fixed .agent/bin path.
    await expect(verifyCutover(optionsFor(inputs), dependenciesFor(inputs))).resolves.toBeDefined();
    await expect(verifyCutover({ ...optionsFor(inputs), brokerPath: inputs.brokerPath }, dependenciesFor(inputs)))
      .rejects.toMatchObject({ code: "broker-path-not-configurable" });
    const injectedPath = dependenciesFor(inputs);
    const withInjectedPath = {
      ...injectedPath,
      systemPaths: { ...injectedPath.systemPaths, brokerPath: inputs.brokerPath },
    };
    await expect(verifyCutover(optionsFor(inputs), withInjectedPath))
      .rejects.toMatchObject({ code: "broker-path-not-configurable" });
  });

  it("fails closed when the required owner-attended consumer evidence is absent", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root);
    const options = { ...optionsFor(inputs), consumerAttestation: undefined };
    await expect(verifyCutover(options, dependenciesFor(inputs)))
      .rejects.toMatchObject({ code: "consumer-attestation-required" });
  });

  it("rejects preview state for final cutover even when all other evidence is supplied", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root, "preview");
    await expect(verifyCutover(optionsFor(inputs, "final"), dependenciesFor(inputs, { disabled: true })))
      .rejects.toMatchObject({ code: "store-state-mismatch" });
  });

  it("requires the latest authoritative refresh event to be complete and successful", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root, "authoritative");
    await writeFile(path.join(inputs.storeRoot, "coursework-refresh-history.json"), JSON.stringify({
      schema: 1,
      events: [{ status: "incomplete", sourceComplete: false, finishedAt: timestamp }],
    }));
    await expect(verifyCutover(optionsFor(inputs), dependenciesFor(inputs)))
      .rejects.toMatchObject({ code: "latest-refresh-not-complete" });
  });

  it("reports service mismatches without forwarding command output", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root);
    const secretSentinel = "synthetic-token-must-not-escape";
    await expect(verifyCutover(optionsFor(inputs), {
      ...dependenciesFor(inputs, { loaded: true, output: secretSentinel }),
    })).rejects.toMatchObject({ code: "service-state-mismatch" });
    try {
      await verifyCutover(optionsFor(inputs), {
        ...dependenciesFor(inputs, { loaded: true, output: secretSentinel }),
        onStatus: (status: unknown) => expect(JSON.stringify(status)).not.toContain(secretSentinel),
      });
    } catch (error) {
      expect(String(error)).not.toContain(secretSentinel);
      expect(String(error)).not.toContain(root);
    }
  });

  it("requires a checkpoint for rehearsal and fixed authoritative expectations for final", async () => {
    const root = await fixtureRoot();
    const inputs = await createInputs(root);
    await expect(verifyCutover({ ...optionsFor(inputs), checkpoint: undefined }, dependenciesFor(inputs)))
      .rejects.toMatchObject({ code: "checkpoint-required" });
    await expect(verifyCutover({ ...optionsFor(inputs, "rehearsal"), checkpoint: "post-refresh", consumerAttestation: "owner-confirmed-legacy-disabled" }, dependenciesFor(inputs)))
      .rejects.toMatchObject({ code: "consumer-attestation-required" });
  });
});
