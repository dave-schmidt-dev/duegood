import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

describe("owned desktop app stage handoff", () => {
  it("consumes an owned stage handoff and removes the stage after a successful install", async () => {
    const stageRoot = await harness.makeOwnedHandoffStage();

    const result = await harness.installFromStage(stageRoot);

    expect(result.appPath).toBe(path.join(harness.applications, "Due Good.app"));
    expect(await readFile(path.join(harness.applications, "Due Good.app", helperRelativePath), "utf8")).toBe("synthetic signed helper bytes");
    expect(await harness.exists(stageRoot)).toBe(false);
    expect(await harness.exists(harness.stageLockPath(stageRoot))).toBe(false);
    await harness.expectStagePurposeReusable(stageRoot);
  });

  it("defaults to the stage-local build/Due Good.app when the installer runs from the stage root", async () => {
    const stageRoot = await harness.makeOwnedHandoffStage();
    const previousCwd = process.cwd();
    process.chdir(stageRoot);
    try {
      const result = await harness.installDesktopApp({
        sourceCheckout: harness.sourceCheckout,
        applicationsDirectory: harness.applications,
        homeDirectory: harness.homeDirectory,
        rootMarkerPath: path.join(stageRoot, ".git", "phase4-root-marker.json"),
        signingIdentity: identityName,
        platform: "darwin",
        run: harness.fakeRun,
        log: () => undefined,
      });
      expect(result.appPath).toBe(path.join(harness.applications, "Due Good.app"));
    } finally {
      process.chdir(previousCwd);
    }
    expect(await harness.exists(stageRoot)).toBe(false);
    expect(await harness.exists(harness.stageLockPath(stageRoot))).toBe(false);
    expect(await harness.exists(path.join(harness.applications, "Due Good.app"))).toBe(true);
  });

  it("removes an owned stage after a failed install that restores the prior app", async () => {
    const installed = path.join(harness.applications, "Due Good.app");
    await harness.makeApp(installed);
    const existingHelper = path.join(installed, helperRelativePath);
    await writeFile(existingHelper, "owner-installed bytes");
    const stageRoot = await harness.makeOwnedHandoffStage();
    harness.failedAssetCheckCall = 3;

    await expect(harness.installFromStage(stageRoot)).rejects.toThrow(/previous app was restored/u);

    expect(await readFile(existingHelper, "utf8")).toBe("owner-installed bytes");
    expect(await readdir(harness.applications)).toEqual(["Due Good.app"]);
    expect(await harness.exists(stageRoot)).toBe(false);
    expect(await harness.exists(harness.stageLockPath(stageRoot))).toBe(false);
    await harness.expectStagePurposeReusable(stageRoot);
  });

  it("removes an owned stage when the candidate fails before copying", async () => {
    const stageRoot = await harness.makeOwnedHandoffStage();
    harness.failedAssetCheckCall = 1;

    await expect(harness.installFromStage(stageRoot)).rejects.toThrow(/asset check failed/u);

    expect(await harness.exists(stageRoot)).toBe(false);
    expect(await harness.exists(harness.stageLockPath(stageRoot))).toBe(false);
    expect(await readdir(harness.applications)).toEqual([]);
    await harness.expectStagePurposeReusable(stageRoot);
  });

  it("rejects a handoff with a mismatched lock owner before starting installation", async () => {
    const stageRoot = await harness.makeOwnedHandoffStage();
    await writeFile(path.join(harness.stageLockPath(stageRoot), "owner.json"), "{}\n");

    await expect(harness.installFromStage(stageRoot)).rejects.toThrow("stage handoff lock does not match its receipt");

    expect(harness.embeddedAssetChecks).toHaveLength(0);
    expect(await readdir(harness.applications)).toEqual([]);
    expect(await harness.exists(stageRoot)).toBe(true);
    expect(await harness.exists(harness.stageLockPath(stageRoot))).toBe(true);
  });

  it("reports stage cleanup failure without hiding the failed install", async () => {
    const stageRoot = await harness.makeOwnedHandoffStage();
    harness.failedAssetCheckCall = 1;
    harness.stageLockToCorrupt = harness.stageLockPath(stageRoot);

    let failure: unknown;
    try {
      await harness.installFromStage(stageRoot);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.message).toContain("asset check failed");
    expect(aggregate.message).toContain("stage handoff lock does not match its receipt");
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[0]).toMatchObject({ message: "asset check failed" });
    expect(await harness.exists(stageRoot)).toBe(true);
    expect(await harness.exists(harness.stageLockPath(stageRoot))).toBe(true);
  });

  it.each([
    { label: "an explicit keep flag", handoff: true, keep: true },
    { label: "a diagnostic non-handoff receipt", handoff: false, keep: false },
  ])("keeps the stage when the receipt requests retention ($label)", async ({ handoff, keep }) => {
    const stageRoot = await harness.makeOwnedHandoffStage({ handoff, keep });

    await harness.installFromStage(stageRoot);

    expect(await harness.exists(stageRoot)).toBe(true);
    expect(await harness.exists(path.join(stageRoot, "build", "Due Good.app"))).toBe(true);
    if (keep) expect(await harness.exists(harness.stageLockPath(stageRoot))).toBe(true);
  });

  it("does not remove a stage when the receipt names a different stage path", async () => {
    const fixture = path.join(harness.temporary, "caller-fixture");
    await mkdir(fixture, { recursive: true });
    await writeFile(path.join(fixture, "keep.txt"), "keep\n");
    const stageRoot = await harness.makeOwnedHandoffStage({ stageRootOverride: fixture });

    await harness.installFromStage(stageRoot);

    expect(await readFile(path.join(fixture, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await harness.exists(stageRoot)).toBe(true);
  });

  it("does not remove a stage whose canonical path is not a direct child of the source .stage directory", async () => {
    const stageRoot = await harness.makeOwnedHandoffStage({ relative: ["nested", "candidate"] });

    await harness.installFromStage(stageRoot);

    expect(await harness.exists(stageRoot)).toBe(true);
  });

  it("does not remove a stage when the receipt names a different source checkout", async () => {
    const otherSource = path.join(harness.temporary, "other-source");
    await mkdir(otherSource, { recursive: true });
    const stageRoot = await harness.makeOwnedHandoffStage({ sourceRootOverride: otherSource });

    await harness.installFromStage(stageRoot);

    expect(await harness.exists(stageRoot)).toBe(true);
  });
});
