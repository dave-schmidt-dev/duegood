#!/usr/bin/env node
/** Owns fixed, project-local stage roots and their per-purpose lifecycle lock. */
import { existsSync } from "node:fs";
import { mkdir, lstat, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const STAGE_DIRECTORY = ".stage";
const LOCK_DIRECTORY = ".locks";
const CARGO_TARGET_RELATIVE = path.join(".cache", "cargo-target");
const PURPOSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function insideOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

async function requireRealDirectory(candidate, expectedPath) {
  const stats = await lstat(candidate);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`stage path must be a real directory: ${candidate}`);
  if (stats.uid !== undefined && typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`stage path must be owned by the current user: ${candidate}`);
  }
  const canonical = await realpath(candidate);
  if (canonical !== expectedPath) throw new Error(`stage path changed while it was being prepared: ${candidate}`);
  return canonical;
}

async function ensureDirectory(candidate, mode = 0o700) {
  try { await mkdir(candidate, { mode }); } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return requireRealDirectory(candidate, candidate);
}

async function destinationPurpose(projectRoot, stageParent, destination) {
  if (!destination) return "tauri";
  const resolved = path.resolve(destination);
  let canonicalParent;
  try { canonicalParent = await realpath(path.dirname(resolved)); } catch { canonicalParent = null; }
  if (canonicalParent !== stageParent) {
    throw new Error(`--destination must be a direct child of ${path.join(projectRoot, STAGE_DIRECTORY)}`);
  }
  const name = path.basename(resolved);
  if (!PURPOSE_PATTERN.test(name) || name === LOCK_DIRECTORY) throw new Error("--destination must name a valid purpose directory under the project .stage directory");
  return name;
}

/**
 * Acquires, resets, and creates one fixed .stage child. A successful explicit destination keeps
 * its lock until the installer consumes the handoff; all other paths release it at close.
 */
export async function acquireOwnedStageRoot({ source, destination, keep = false } = {}) {
  if (!source) throw new Error("stage source is required");
  const projectRoot = await realpath(path.resolve(source));
  const stageParent = path.join(projectRoot, STAGE_DIRECTORY);
  await ensureDirectory(stageParent);
  const purpose = await destinationPurpose(projectRoot, stageParent, destination);
  const stageRoot = path.join(stageParent, purpose);
  const lockParent = path.join(stageParent, LOCK_DIRECTORY);
  await ensureDirectory(lockParent);
  const cacheParent = path.join(projectRoot, ".cache");
  await ensureDirectory(cacheParent);
  const scratchParent = path.join(cacheParent, "stage-tmp");
  await ensureDirectory(scratchParent);
  const lockPath = path.join(lockParent, `${purpose}.lock`);
  const temporaryDirectory = path.join(scratchParent, purpose);
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`stage purpose ${purpose} is already locked; finish or remove its owned handoff before retrying`, { cause: error });
    throw error;
  }

  try {
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      schemaVersion: 1,
      purpose,
      projectRoot,
      stageRoot,
      pid: process.pid,
      handoff: Boolean(destination),
      keep: Boolean(keep),
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });

    if (existsSync(temporaryDirectory)) {
      const current = await lstat(temporaryDirectory);
      if (current.isSymbolicLink() || !current.isDirectory()) throw new Error(`existing stage scratch root is not a real directory: ${temporaryDirectory}`);
      await requireRealDirectory(temporaryDirectory, temporaryDirectory);
      await rm(temporaryDirectory, { recursive: true, force: false });
    }
    await mkdir(temporaryDirectory, { mode: 0o700 });
    await requireRealDirectory(temporaryDirectory, temporaryDirectory);

    if (existsSync(stageRoot)) {
      const current = await lstat(stageRoot);
      if (current.isSymbolicLink() || !current.isDirectory()) throw new Error(`existing stage root is not a real directory: ${stageRoot}`);
      await requireRealDirectory(stageRoot, stageRoot);
      await rm(stageRoot, { recursive: true, force: false });
    }
    await mkdir(stageRoot, { mode: 0o700 });
    await requireRealDirectory(stageRoot, stageRoot);

    const cargoTargetDir = path.join(projectRoot, CARGO_TARGET_RELATIVE);
    const ownership = Object.freeze({
      schemaVersion: 1,
      owner: "duegood-stage",
      projectRoot,
      stageRoot,
      lockPath,
      purpose,
      handoff: Boolean(destination),
      keep: Boolean(keep),
    });

    return {
      projectRoot,
      stageRoot,
      temporaryDirectory,
      cargoTargetDir,
      ownership,
      async close({ success = false, keep = false, handoff = false } = {}) {
        const preserve = keep || (success && handoff);
        const failures = [];
        for (const target of [temporaryDirectory, ...(!preserve ? [stageRoot, lockPath] : [])]) {
          try { await rm(target, { recursive: true, force: true }); } catch (error) { failures.push(error); }
        }
        if (failures.length > 0) throw new AggregateError(failures, "owned stage cleanup failed");
      },
    };
  } catch (error) {
    const cleanupFailures = [];
    for (const target of [temporaryDirectory, stageRoot, lockPath]) {
      try { await rm(target, { recursive: true, force: true }); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
    }
    if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], "stage preparation and cleanup failed", { cause: error });
    throw error;
  }
}

/** Validates a retained candidate and its per-purpose lock against the receipt. */
export async function validateOwnedStageHandoff({ candidateRoot, projectRoot, ownership } = {}) {
  const source = await realpath(path.resolve(projectRoot));
  const candidate = path.resolve(candidateRoot);
  if (ownership?.schemaVersion !== 1 || ownership?.owner !== "duegood-stage" || ownership?.handoff !== true ||
      typeof ownership.keep !== "boolean" || ownership.projectRoot !== source || ownership.stageRoot !== candidate) {
    throw new Error("stage handoff ownership metadata is invalid");
  }
  const stageParent = path.join(source, STAGE_DIRECTORY);
  if (path.dirname(candidate) !== stageParent || !insideOrEqual(stageParent, candidate)) {
    throw new Error("stage handoff candidate is outside the project .stage directory");
  }
  const lockParent = path.join(stageParent, LOCK_DIRECTORY);
  const expectedLock = path.join(lockParent, `${ownership.purpose}.lock`);
  if (!PURPOSE_PATTERN.test(ownership.purpose) || ownership.lockPath !== expectedLock) {
    throw new Error("stage handoff lock metadata is invalid");
  }
  const actualCandidate = await requireRealDirectory(candidate, candidate);
  const actualLock = await requireRealDirectory(expectedLock, expectedLock);
  const lockOwnerPath = path.join(expectedLock, "owner.json");
  const lockOwnerStat = await lstat(lockOwnerPath);
  if (!lockOwnerStat.isFile() || lockOwnerStat.isSymbolicLink()) throw new Error("stage handoff lock owner is not a regular file");
  if (await realpath(lockOwnerPath) !== lockOwnerPath) throw new Error("stage handoff lock owner path changed during validation");
  const lockOwner = JSON.parse(await readFile(lockOwnerPath, "utf8"));
  if (lockOwner?.schemaVersion !== 1 || lockOwner?.projectRoot !== source || lockOwner?.stageRoot !== candidate ||
      lockOwner?.purpose !== ownership.purpose || lockOwner?.handoff !== true || lockOwner?.keep !== ownership.keep) {
    throw new Error("stage handoff lock does not match its receipt");
  }
  if (actualCandidate !== candidate || actualLock !== expectedLock) throw new Error("stage handoff paths changed during validation");
  return { candidateRoot: candidate, projectRoot: source, lockPath: expectedLock, keep: ownership.keep };
}

/** Removes a retained candidate and its lock only when the receipt and lock owner agree. */
export async function consumeOwnedStageHandoff(options = {}) {
  const validated = await validateOwnedStageHandoff(options);
  if (validated.keep === true) return;
  await rm(validated.candidateRoot, { recursive: true, force: false });
  await rm(validated.lockPath, { recursive: true, force: false });
}
