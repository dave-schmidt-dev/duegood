#!/usr/bin/env node
/**
 * Builds a scanned, exact-byte candidate set from a Due Good checkout and commits it into a
 * disposable Git repository under a private temporary directory, so later staged builds/tests
 * (`npm ci`, `npm run build:*`, `npm run test:*`, including `check:public-tree` and
 * `check:staged-public-tree`) run against that copy instead of the live checkout that serves the
 * running browser app. Never mutates the source checkout; the only Git command run against it is
 * read-only enumeration (`git ls-files`).
 *
 * Usage:
 *   node scripts/stage-tauri-candidate.mjs [--source <checkout>] [--destination <new-dir>]
 *     [--include <path>]... [--exclude <path>]... [--build <script>]... [--test <script>]...
 *     [--playwright-browsers-path <dir>] [--skip-install] [--skip-preflight]
 *
 * `--destination` must not exist yet; it is created (mode 0700) outside the source, in a parent
 * that other users cannot write. Without it, the stage is a new `stage` folder inside a fresh
 * private temporary directory.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { homedir, cpus as osCpus, release as osRelease, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanContent, scanPath } from "./check-public-tree.mjs";

export const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_REQUIRED_FILES = Object.freeze(["package.json", "package-lock.json", "SHA256SUMS"]);
const FIXED_GIT_IDENTITY = Object.freeze({ name: "Due Good Stage", email: "stage@duegood.invalid" });
const FIXED_GIT_DATE = "2026-01-01T00:00:00Z";
const LAST_STABLE_MACOS_MAJOR_VERSION = 26;

function noop() {}

function gitEnv(extra = {}) {
  // Disable global/system Git config so a developer's ~/.gitconfig (commit.gpgsign, a custom
  // core.hooksPath, init.templateDir, etc.) can never change what this disposable repo does.
  return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extra };
}

function runGit(args, cwd, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv(options.env), input: options.input });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().slice(0, 500);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
  return result.stdout;
}

/** Read-only Git enumeration of `source`. This is the only Git access this module performs
 * against the source checkout; every mutating Git command below runs against `destination`. */
export function listTrackedPaths(source) {
  return runGit(["ls-files", "-z"], source).split("\0").filter(Boolean);
}

export function listUntrackedPaths(source) {
  return runGit(["ls-files", "--others", "--exclude-standard", "-z"], source).split("\0").filter(Boolean);
}

/**
 * The candidate set is every tracked file (working-tree bytes) plus every untracked, non-ignored
 * file the caller has explicitly accounted for. An untracked file that the caller neither listed
 * in `include` (to bring it in) nor `exclude` (to acknowledge and leave it out) fails the stage —
 * nothing untracked can slip into a build artifact unnoticed.
 */
export function buildCandidateSet(source, { include = [], exclude = [] } = {}) {
  const tracked = listTrackedPaths(source);
  const untracked = listUntrackedPaths(source);
  const untrackedSet = new Set(untracked);
  const missingInclude = include.filter((candidate) => !untrackedSet.has(candidate));
  if (missingInclude.length > 0) {
    throw new Error(`include names path(s) that are not untracked, non-ignored files in the source: ${missingInclude.join(", ")}`);
  }
  const includeSet = new Set(include);
  const excludeSet = new Set(exclude);
  const unlisted = untracked.filter((candidate) => !includeSet.has(candidate) && !excludeSet.has(candidate));
  if (unlisted.length > 0) {
    throw new Error(`unlisted untracked file(s) — pass each in "include" or "exclude": ${unlisted.join(", ")}`);
  }
  return [...new Set([...tracked, ...untracked.filter((candidate) => includeSet.has(candidate))])].sort();
}

const DESTINATION_INSIDE_SOURCE = "destination must be a private directory outside the source tree";
const CHECK_OWNERSHIP = process.platform !== "win32";

function isInsideOrEqual(root, candidate) {
  const relative = path.relative(root, candidate);
  return !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

async function lstatOrNull(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Refuses to create anything inside `directory` unless it is a real directory that no other
 * non-root user controls: owned by this user or root, and not writable by group or others unless
 * the sticky bit is set (as on `/tmp`, where other users cannot rename or remove our entries).
 */
async function assertPrivateParent(directory) {
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("destination parent must be a real directory");
  if (!CHECK_OWNERSHIP) return;
  if (stats.uid !== process.getuid() && stats.uid !== 0) throw new Error("destination parent must be owned by the current user or root");
  if ((stats.mode & 0o022) !== 0 && (stats.mode & 0o1000) === 0) {
    throw new Error("destination parent must not be writable by other users unless it is sticky");
  }
}

/**
 * Verifies a stage directory this process created (or is about to use): a real directory, not a
 * symlink, owned by the current user, whose `realpath` is exactly `expected` and lies outside the
 * source. Returns that real path.
 */
async function assertOwnedStageDirectory(realSource, expected) {
  const stats = await lstat(expected);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("destination must be a real directory, not a symlink");
  if (CHECK_OWNERSHIP && stats.uid !== process.getuid()) throw new Error("destination must be owned by the current user");
  const realDestination = await realpath(expected);
  if (realDestination !== expected) throw new Error("destination changed while it was being created");
  if (isInsideOrEqual(realSource, realDestination)) throw new Error(DESTINATION_INSIDE_SOURCE);
  return realDestination;
}

/**
 * Creates the stage directory safely and returns its real path.
 *
 * The destination must not exist yet. Its deepest existing ancestor is resolved with `realpath`
 * and must lie outside the source's real path (so a symlinked destination or ancestor cannot point
 * into the checkout); each missing parent is then created one level at a time with an exclusive,
 * non-recursive `mkdir` (mode 0700), and the stage itself with a final exclusive `mkdir`, which
 * fails if anything (directory, file, or symlink) appeared at that name. Every directory something
 * is created in must pass {@link assertPrivateParent}. After creation the stage is re-verified
 * with `lstat` (real directory, owned by this user) and must `realpath` to exactly
 * realParent/basename before it is `chmod`ed and used.
 *
 * Threat model: this closes accidental misuse and interference by other local users. It does not
 * defend against a process running as the same user, which can already write the source checkout.
 */
async function createStageDirectory(source, realSource, destination) {
  if (isInsideOrEqual(source, destination)) throw new Error(DESTINATION_INSIDE_SOURCE);
  const name = path.basename(destination);
  if (name.length === 0 || name === "." || name === "..") throw new Error("destination must name a new directory");
  if ((await lstatOrNull(destination)) !== null) throw new Error("destination must not exist yet");

  const missingParents = [];
  let existing = path.dirname(destination);
  while ((await lstatOrNull(existing)) === null) {
    const up = path.dirname(existing);
    if (up === existing) break;
    missingParents.unshift(path.basename(existing));
    existing = up;
  }
  let realParent;
  try {
    realParent = await realpath(existing);
  } catch {
    throw new Error("destination path contains a symlink that cannot be resolved");
  }
  if (isInsideOrEqual(realSource, path.join(realParent, ...missingParents, name))) throw new Error(DESTINATION_INSIDE_SOURCE);

  for (const part of missingParents) {
    await assertPrivateParent(realParent);
    realParent = path.join(realParent, part);
    await mkdir(realParent, { mode: 0o700 });
  }
  await assertPrivateParent(realParent);
  const stagePath = path.join(realParent, name);
  await mkdir(stagePath, { mode: 0o700 });
  const realDestination = await assertOwnedStageDirectory(realSource, stagePath);
  await chmod(realDestination, 0o700);
  return realDestination;
}

async function copyCandidateFile(source, destination, relativePath) {
  const sourcePath = path.join(source, relativePath);
  const destinationPath = path.join(destination, relativePath);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  const stats = await lstat(sourcePath);
  if (stats.isSymbolicLink()) {
    const target = await readlink(sourcePath);
    const resolvedTarget = path.resolve(path.dirname(sourcePath), target);
    const targetRelativeToSource = path.relative(source, resolvedTarget);
    const escapes = targetRelativeToSource === ".." || targetRelativeToSource.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelativeToSource);
    if (escapes) {
      throw new Error(`${relativePath}: symlink target escapes the source root`);
    }
    await symlink(target, destinationPath);
    return;
  }
  if (!stats.isFile()) {
    throw new Error(`${relativePath}: unsupported file type for staging (must be a regular file or symlink)`);
  }
  const contents = await readFile(sourcePath);
  const contentFinding = scanContent(contents);
  if (contentFinding) {
    throw new Error(`${relativePath}: ${contentFinding}`);
  }
  await writeFile(destinationPath, contents);
  await chmod(destinationPath, stats.mode & 0o777);
}

function initThrowawayRepo(repoRoot) {
  runGit(["init", "--quiet", "-b", "main"], repoRoot);
}

function commitCandidate(repoRoot, candidatePaths, identity, date) {
  runGit(["add", "--pathspec-from-file=-", "--pathspec-file-nul"], repoRoot, { input: `${candidatePaths.join("\0")}\0` });
  const commitEnv = {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: date,
  };
  runGit(["-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-m", "duegood staged candidate"], repoRoot, { env: commitEnv });
}

/**
 * Stages `source`'s candidate set into `destination` (a new directory outside `source` that must
 * not exist yet; missing parents are created privately): scans and copies every candidate file with its current
 * working-tree bytes, commits it into a throwaway Git repository at `destination` with a fixed
 * author/committer/date, verifies the committed tree matches the working candidate set exactly,
 * and writes a JSON digest receipt at `destination/receipt.json` — never added to the commit, and
 * excluded via `.git/info/exclude` so `git ls-files --others --exclude-standard` (what
 * `check-public-tree.mjs`'s `publicPaths()` uses) skips it automatically.
 *
 * Never touches `source` except through read-only `git ls-files` enumeration. The destination is
 * created by {@link createStageDirectory}: an existing destination, one that resolves into the
 * source, or one whose parent other users can write is refused. The returned `destination` is the
 * created directory's real path.
 *
 * @param {{
 *   source: string,
 *   destination: string,
 *   include?: string[],
 *   exclude?: string[],
 *   requiredFiles?: readonly string[],
 *   gitIdentity?: { name: string, email: string },
 *   gitDate?: string,
 *   log?: (message: string) => void,
 * }} options
 */
export async function stageCandidate({
  source,
  destination,
  include = [],
  exclude = [],
  requiredFiles = DEFAULT_REQUIRED_FILES,
  gitIdentity = FIXED_GIT_IDENTITY,
  gitDate = FIXED_GIT_DATE,
  log = noop,
} = {}) {
  if (!source || !destination) throw new Error("stageCandidate requires both source and destination directories");
  const resolvedSource = path.resolve(source);
  const realSource = await realpath(resolvedSource);
  // Every later write, Git command, and npm phase uses only this verified real path.
  const resolvedDestination = await createStageDirectory(resolvedSource, realSource, path.resolve(destination));

  log("stage: enumerating candidate set");
  const candidatePaths = buildCandidateSet(resolvedSource, { include, exclude });

  const missingRequired = requiredFiles.filter((required) => !candidatePaths.includes(required));
  if (missingRequired.length > 0) {
    throw new Error(`candidate set is missing required file(s): ${missingRequired.join(", ")}`);
  }

  log(`stage: scanning and copying ${String(candidatePaths.length)} candidate file(s)`);
  for (const relativePath of candidatePaths) {
    const pathFinding = scanPath(relativePath);
    if (pathFinding) throw new Error(`${relativePath}: ${pathFinding}`);
    await copyCandidateFile(resolvedSource, resolvedDestination, relativePath);
  }

  log("stage: committing the candidate into a throwaway Git repository");
  initThrowawayRepo(resolvedDestination);
  commitCandidate(resolvedDestination, candidatePaths, gitIdentity, gitDate);

  const stagedPaths = listTrackedPaths(resolvedDestination).sort();
  const candidateSorted = [...candidatePaths].sort();
  const stagedMatchesCandidate = JSON.stringify(stagedPaths) === JSON.stringify(candidateSorted);
  if (!stagedMatchesCandidate) {
    throw new Error("staged file set does not equal the working candidate set");
  }

  const treeDigest = runGit(["rev-parse", "HEAD^{tree}"], resolvedDestination).trim();
  const files = {};
  for (const relativePath of candidateSorted) {
    files[relativePath] = createHash("sha256").update(await readFile(path.join(resolvedDestination, relativePath))).digest("hex");
  }

  // Keep the receipt out of the committed tree and out of any later public-tree scan of this
  // stage: append to the repo-local exclude file (never part of the tracked/committed content).
  await mkdir(path.join(resolvedDestination, ".git", "info"), { recursive: true });
  await appendFile(path.join(resolvedDestination, ".git", "info", "exclude"), "receipt.json\n");

  const receipt = {
    schemaVersion: 1,
    treeDigest,
    fileCount: candidateSorted.length,
    stagedMatchesCandidate,
    files,
  };
  const receiptPath = path.join(resolvedDestination, "receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });

  log(`stage: committed ${String(candidateSorted.length)} file(s), tree ${treeDigest.slice(0, 12)}`);
  return { destination: resolvedDestination, receiptPath, receipt, candidatePaths: candidateSorted, treeDigest };
}

// --- Playwright browser-cache preflight -------------------------------------------------------
//
// Mirrors playwright-core's own hostPlatform/browser-directory-naming algorithm closely enough to
// check whether a shared cache directory already holds the builds a pinned @playwright/test
// version needs, without ever downloading, installing, or writing to that cache. Linux host
// detection is a documented approximation (no distro/version probing); set
// PLAYWRIGHT_HOST_PLATFORM_OVERRIDE (the same variable playwright-core itself honors) for an
// exact match when needed.

export function detectHostPlatform({ platform = process.platform, release = osRelease(), cpus = osCpus(), env = process.env } = {}) {
  if (env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE) return env.PLAYWRIGHT_HOST_PLATFORM_OVERRIDE;
  if (platform === "darwin") {
    const major = Number.parseInt(release.split(".")[0], 10);
    let macVersion;
    if (!Number.isFinite(major) || major < 18) macVersion = 10.13;
    else if (major === 18) macVersion = 10.14;
    else if (major === 19) macVersion = 10.15;
    else if (major < 25) macVersion = 11 + (major - 20);
    else macVersion = Math.min(major + 1, LAST_STABLE_MACOS_MAJOR_VERSION);
    const isAppleSilicon = macVersion >= 11 && cpus.some((cpu) => (cpu.model ?? "").includes("Apple"));
    return `mac${macVersion}${isAppleSilicon ? "-arm64" : ""}`;
  }
  if (platform === "win32") return "win64";
  if (platform === "linux") return `ubuntu24.04-${process.arch === "arm64" ? "arm64" : "x64"}`;
  return "<unknown>";
}

/** playwright-core's registry directory-naming rule: browsers.json name with dashes turned to
 * underscores, joined to its revision (or its platform-specific revisionOverride, with the
 * name/hostPlatform "_special" prefix that override implies). */
export function browserDirectoryName(descriptor, hostPlatform) {
  const override = descriptor.revisionOverrides?.[hostPlatform];
  const revision = override ?? descriptor.revision;
  const prefix = override ? `${descriptor.name}_${hostPlatform}_special` : descriptor.name;
  return `${prefix.replace(/-/g, "_")}-${revision}`;
}

export function readPlaywrightTestVersion(packageLock) {
  const version = packageLock?.packages?.["node_modules/@playwright/test"]?.version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package-lock.json has no pinned node_modules/@playwright/test version");
  }
  return version;
}

/** The browsers.json entries this project's Playwright projects launch. Every project in
 * playwright.config.ts uses the "Desktop Chrome" device, and headless Chromium runs from the
 * headless shell, so the cache only has to hold these two builds (a guard test keeps this list
 * and the config in step). */
export const PROJECT_PLAYWRIGHT_BROWSERS = Object.freeze(["chromium", "chromium-headless-shell"]);

export function requiredBrowserDirectories(browsersJson, hostPlatform, names = PROJECT_PLAYWRIGHT_BROWSERS) {
  if (!browsersJson || !Array.isArray(browsersJson.browsers)) {
    throw new Error("browsers.json is missing a browsers array");
  }
  return names.map((name) => {
    const entry = browsersJson.browsers.find((browser) => browser.name === name);
    if (!entry) throw new Error(`browsers.json has no entry for required browser ${name}`);
    return browserDirectoryName(entry, hostPlatform);
  });
}

/**
 * Fails naming each build directory this project's Playwright projects need that is absent from
 * `cacheDir`. Never downloads, installs, or writes to `cacheDir` — populating it is a separate,
 * explicit step outside this preflight.
 */
export function preflightPlaywrightBrowsers({ packageLock, browsersJson, cacheDir, hostPlatform = detectHostPlatform() }) {
  const version = readPlaywrightTestVersion(packageLock);
  const required = requiredBrowserDirectories(browsersJson, hostPlatform);
  const missing = required.filter((directoryName) => !existsSync(path.join(cacheDir, directoryName)));
  if (missing.length > 0) {
    throw new Error(`Playwright ${version} preflight is missing browser build(s) under ${cacheDir}: ${missing.join(", ")}`);
  }
  return { version, hostPlatform, required };
}

/** Playwright's own default cache directory, computed at runtime (never a literal home path). */
export function defaultPlaywrightCacheDirectory({ platform = process.platform, env = process.env } = {}) {
  if (platform === "linux") return path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "ms-playwright");
  if (platform === "darwin") return path.join(homedir(), "Library", "Caches", "ms-playwright");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "ms-playwright");
  throw new Error(`Unsupported platform for a Playwright cache directory: ${platform}`);
}

// --- CLI ----------------------------------------------------------------------------------------

function parseCliArgs(argv) {
  const options = { include: [], exclude: [], build: [], test: [], skipInstall: false, skipPreflight: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${argument} requires a value`);
      return argv[index];
    };
    if (argument === "--source") options.source = next();
    else if (argument === "--destination") options.destination = next();
    else if (argument === "--include") options.include.push(next());
    else if (argument === "--exclude") options.exclude.push(next());
    else if (argument === "--build") options.build.push(next());
    else if (argument === "--test") options.test.push(next());
    else if (argument === "--playwright-browsers-path") options.playwrightBrowsersPath = next();
    else if (argument === "--skip-install") options.skipInstall = true;
    else if (argument === "--skip-preflight") options.skipPreflight = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function runNpmPhase(label, args, cwd, env) {
  // Stream the public candidate's npm output to stderr so a failing gate shows its evidence.
  const result = spawnSync("npm", args, { cwd, stdio: ["ignore", process.stderr, process.stderr], env });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${String(result.status)}): npm ${args.join(" ")}`);
  }
}

export async function run(argv = process.argv.slice(2)) {
  const options = parseCliArgs(argv);
  const onLog = (message) => process.stderr.write(`stage-tauri-candidate: ${message}\n`);
  const source = options.source ? path.resolve(options.source) : scriptRoot;
  // The destination must not exist yet; by default it is a new "stage" folder inside a fresh
  // private (0700) temporary directory.
  const destination = options.destination
    ? path.resolve(options.destination)
    : path.join(await mkdtemp(path.join(tmpdir(), "duegood-tauri-stage-")), "stage");

  const result = await stageCandidate({ source, destination, include: options.include, exclude: options.exclude, log: onLog });
  onLog(`stage: complete at ${result.destination}`);

  const browsersPath = options.playwrightBrowsersPath ?? process.env.PLAYWRIGHT_BROWSERS_PATH ?? defaultPlaywrightCacheDirectory();
  const stageEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath };
  // The npm phases execute code in the stage, so recheck that it is still the directory we created.
  await assertOwnedStageDirectory(await realpath(source), result.destination);

  if (!options.skipInstall) {
    onLog("install: npm ci starting");
    runNpmPhase("install", ["ci"], result.destination, stageEnv);
    onLog("install: npm ci finished");

    if (!options.skipPreflight) {
      onLog("test: playwright browser-cache preflight starting");
      const packageLock = JSON.parse(await readFile(path.join(result.destination, "package-lock.json"), "utf8"));
      const browsersJsonPath = path.join(result.destination, "node_modules", "playwright-core", "browsers.json");
      const browsersJson = JSON.parse(await readFile(browsersJsonPath, "utf8"));
      const preflight = preflightPlaywrightBrowsers({ packageLock, browsersJson, cacheDir: browsersPath });
      onLog(`test: playwright browser-cache preflight passed for ${String(preflight.required.length)} build(s)`);
    }
  }

  for (const script of options.build) {
    onLog(`build: npm run ${script} starting`);
    runNpmPhase("build", ["run", script], result.destination, stageEnv);
    onLog(`build: npm run ${script} finished`);
  }

  for (const script of options.test) {
    onLog(`test: npm run ${script} starting`);
    runNpmPhase("test", ["run", script], result.destination, stageEnv);
    onLog(`test: npm run ${script} finished`);
  }

  return result;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await run();
}
