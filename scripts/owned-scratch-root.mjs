#!/usr/bin/env node
/** Owns private, non-stage scratch roots created under the operating system temp directory. */
import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PURPOSE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const EVIDENCE_ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ownershipByHandle = new WeakMap();

function assertOwnedDirectory(directory, expectedPath) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(directory) !== expectedPath) {
    throw new Error("The owned scratch root changed identity and was preserved.");
  }
  if ((stat.mode & 0o777) !== 0o700 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("The owned scratch root is not a private directory owned by this user.");
  }
}

function requireOwnedHandle(handle) {
  const state = ownershipByHandle.get(handle);
  if (!state) throw new Error("The scratch root is not owned by this helper.");
  return state;
}

/** Creates a unique private scratch root under os.tmpdir() or a verified private parent. */
export function createOwnedScratchRoot(purpose, { baseDirectory } = {}) {
  if (typeof purpose !== "string" || !PURPOSE_PATTERN.test(purpose)) {
    throw new Error("Scratch purpose must be a short alphanumeric name.");
  }
  const tempParent = baseDirectory ? path.resolve(baseDirectory) : realpathSync(os.tmpdir());
  if (baseDirectory) assertOwnedDirectory(tempParent, tempParent);
  const root = mkdtempSync(path.join(tempParent, `duegood-${purpose}-`));
  chmodSync(root, 0o700);
  assertOwnedDirectory(root, root);

  const state = { root, tempParent, purpose, active: false, removed: false };
  const handle = Object.freeze({
    root,
    setActive(active) {
      if (state.removed) throw new Error("The owned scratch root has already been removed.");
      state.active = Boolean(active);
    },
    isActive() { return state.active; },
    cleanup() {
      if (state.removed) return;
      if (state.active) throw new Error("Refusing to remove an active scratch root.");
      let exists = true;
      try { lstatSync(root); }
      catch (error) { if (error?.code === "ENOENT") exists = false; else throw error; }
      if (exists) {
        if (path.dirname(root) !== tempParent || !path.basename(root).startsWith(`duegood-${purpose}-`)) {
          throw new Error("The owned scratch root is outside its expected temp directory and was preserved.");
        }
        assertOwnedDirectory(root, root);
        rmSync(root, { recursive: true, force: false });
      }
      state.removed = true;
    },
  });
  ownershipByHandle.set(handle, state);
  return handle;
}

function privateLogsDirectory(projectRoot) {
  const canonicalProject = realpathSync(path.resolve(projectRoot));
  const logsDirectory = path.join(canonicalProject, ".logs");
  try { mkdirSync(logsDirectory, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const stat = lstatSync(logsDirectory);
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Project .logs must be a real directory owned by the current user.");
  }
  chmodSync(logsDirectory, 0o700);
  if ((lstatSync(logsDirectory).mode & 0o777) !== 0o700) throw new Error("Project .logs could not be made private.");
  return logsDirectory;
}

/** Copies selected direct children from an owned scratch root into private project .logs. */
export function preserveScratchEvidence({ scratch, projectRoot, entries }) {
  const state = requireOwnedHandle(scratch);
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !EVIDENCE_ENTRY_PATTERN.test(entry))) {
    throw new Error("Scratch evidence must name direct files or directories only.");
  }
  assertOwnedDirectory(state.root, state.root);
  const present = entries.filter((entry) => {
    try { lstatSync(path.join(state.root, entry)); return true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  });
  if (present.length === 0) return undefined;

  const logsDirectory = privateLogsDirectory(projectRoot);
  const destination = path.join(logsDirectory, `${state.purpose}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomBytes(5).toString("hex")}`);
  mkdirSync(destination, { mode: 0o700 });
  for (const entry of present) {
    const source = path.join(state.root, entry);
    const stat = lstatSync(source);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`Refusing to preserve unexpected scratch evidence: ${entry}`);
    }
    cpSync(source, path.join(destination, entry), { recursive: stat.isDirectory(), errorOnExist: true, force: false });
  }
  return destination;
}
