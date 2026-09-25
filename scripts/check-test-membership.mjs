import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(root, "test", "test-membership.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

function list(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(root, ".playwright") },
  });
  if (result.status !== 0) {
    throw new Error(`Test discovery failed for ${command} ${args.join(" ")}.`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

for (const testPath of [...manifest.ui.tests, ...manifest.desktopUi.tests, ...manifest.container.tests, ...manifest.local.tests]) {
  if (!existsSync(path.join(root, testPath))) {
    throw new Error(`Membership names missing test ${testPath}.`);
  }
}

{
  const fixtures = manifest.fixtures ?? [];
  for (const fixturePath of fixtures) {
    if (!existsSync(path.join(root, fixturePath))) {
      throw new Error(`Membership names missing fixture ${fixturePath}.`);
    }
  }
  const fixturesRoot = path.join(root, "test", "fixtures");
  const actualFixtureFiles = [];
  if (existsSync(fixturesRoot)) {
    for (const entry of readdirSync(fixturesRoot, { recursive: true })) {
      if (statSync(path.join(fixturesRoot, entry)).isFile()) {
        actualFixtureFiles.push(`test/fixtures/${entry.split(path.sep).join("/")}`);
      }
    }
  }
  const listedFixtures = new Set(fixtures);
  const unlistedFixtures = actualFixtureFiles.filter((fixturePath) => !listedFixtures.has(fixturePath));
  if (unlistedFixtures.length > 0) {
    throw new Error(`test/fixtures files are not listed in test-membership.json's "fixtures": ${unlistedFixtures.join(", ")}.`);
  }
}

{
  const script = packageJson.scripts[manifest.local.runner];
  if (typeof script !== "string" || !script.includes("vitest.local.config.ts")) {
    throw new Error(`${manifest.local.runner} must invoke the local Vitest configuration.`);
  }
  const discovery = list(path.join(root, "node_modules", ".bin", "vitest"), ["list", "--config", "vitest.local.config.ts"]);
  for (const testPath of manifest.local.tests) {
    if (!discovery.includes(testPath)) throw new Error(`${manifest.local.runner} does not discover ${testPath}.`);
  }
  if (!(packageJson.scripts[manifest.local.inclusiveRunner] ?? "").includes(`npm run ${manifest.local.runner}`)) {
    throw new Error(`${manifest.local.inclusiveRunner} must include ${manifest.local.runner}.`);
  }
}

{
  const script = packageJson.scripts[manifest.container.runner];
  if (typeof script !== "string" || !script.includes("test/container/run.sh")) {
    throw new Error(`${manifest.container.runner} must invoke the container qualification runner.`);
  }
  if (manifest.container.includedInTestAll !== false) {
    throw new Error("Container qualification must remain an explicit host gate, not part of test:all.");
  }
  if ((packageJson.scripts["test:all"] ?? "").includes("test:container")) {
    throw new Error("test:all must not launch Docker qualification.");
  }
}

// Rust tests: `cargo test --list` is the discovery source. Every source file with a `#[test]` must be
// listed with its exact test count, and the compiled test binary must contain exactly those tests,
// so a test hidden behind a cfg the runner does not enable, or a new unlisted module, fails here.
let tauriTestCount = 0;
{
  const tauri = manifest.tauri;
  const script = packageJson.scripts[tauri.runner];
  const cargoCommand = `cargo test --manifest-path ${tauri.cargoManifest} --features ${tauri.features}`;
  const preparesUiAndSidecar = script?.includes("node scripts/build-tauri.mjs --prepare-only --test");
  if (typeof script !== "string" || !preparesUiAndSidecar || !script.includes(cargoCommand)) {
    throw new Error(`${tauri.runner} must prepare staged UI and the test sidecar before ${cargoCommand}.`);
  }
  if (!(packageJson.scripts[tauri.inclusiveRunner] ?? "").includes(`npm run ${tauri.runner}`)) {
    throw new Error(`${tauri.inclusiveRunner} must include ${tauri.runner}.`);
  }
  const listed = new Map(Object.entries(tauri.tests));
  for (const [file, count] of listed) {
    if (!existsSync(path.join(root, file))) throw new Error(`Membership names missing Rust test file ${file}.`);
    if (!Number.isInteger(count) || count < 1) throw new Error(`Membership count for ${file} must be a positive integer.`);
  }
  const sourceRoot = path.join(root, tauri.sourceRoot);
  for (const entry of readdirSync(sourceRoot, { recursive: true })) {
    const file = `${tauri.sourceRoot}/${String(entry).split(path.sep).join("/")}`;
    if (!file.endsWith(".rs") || !statSync(path.join(root, file)).isFile()) continue;
    const declared = (readFileSync(path.join(root, file), "utf8").match(/#\[test\]/g) ?? []).length;
    if (declared > 0 && !listed.has(file)) throw new Error(`${file} declares ${declared} Rust tests but is not listed in test-membership.json's "tauri".`);
    if (listed.has(file) && declared !== listed.get(file)) throw new Error(`${file} declares ${declared} Rust tests; membership lists ${listed.get(file)}.`);
  }
  // `generate_context!` embeds dist/public, so the test binary cannot compile without the UI build.
  if (!existsSync(path.join(root, "dist", "public", "index.html"))) list(process.execPath, [path.join(root, "scripts", "build-ui.mjs")]);
  const discovery = list("cargo", ["test", "--locked", "--manifest-path", tauri.cargoManifest, "--features", tauri.features, "--", "--list", "--format", "terse"]);
  const discovered = new Map();
  const pathModules = new Map([
    ["ical::bootstrap", "ical_bootstrap.rs"],
    ["ical_apply::bootstrap", "ical_apply_bootstrap.rs"],
  ]);
  for (const match of discovery.matchAll(/^([A-Za-z0-9_:]+): test$/gm)) {
    const modulePath = match[1];
    const parts = modulePath.split("::");
    const file = `${tauri.sourceRoot}/${pathModules.get(`${parts[0]}::${parts[1]}`) ?? `${parts[0]}.rs`}`;
    discovered.set(file, (discovered.get(file) ?? 0) + 1);
  }
  for (const [file, count] of discovered) {
    if (!listed.has(file)) throw new Error(`${tauri.runner} discovers Rust tests in ${file}, which is not listed.`);
    if (count !== listed.get(file)) throw new Error(`${tauri.runner} discovers ${count} Rust tests in ${file}; membership lists ${listed.get(file)}.`);
  }
  for (const [file, count] of listed) {
    if (!discovered.has(file)) throw new Error(`${tauri.runner} does not discover the ${count} listed Rust tests in ${file}.`);
    tauriTestCount += count;
  }
}

{
  const script = packageJson.scripts[manifest.ui.focusedRunner];
  if (typeof script !== "string" || script.includes("playwright")) {
    throw new Error(`${manifest.ui.focusedRunner} must be a non-browser runner.`);
  }
  const discovery = list(path.join(root, "node_modules", ".bin", "vitest"), ["list", "--config", "vitest.ui.config.ts"]);
  for (const testPath of manifest.ui.tests) {
    if (!discovery.includes(testPath)) {
      throw new Error(`${manifest.ui.focusedRunner} does not discover ${testPath}.`);
    }
  }
}

const desktopUi = manifest.desktopUi;
const desktopUiRunner = packageJson.scripts[desktopUi.runner];
if (typeof desktopUiRunner !== "string" || !desktopUiRunner.includes("playwright test --config playwright.config.ts")) {
  throw new Error(`${desktopUi.runner} must run the registered Tauri UI Playwright config.`);
}
const desktopUiDiscovery = list(path.join(root, "node_modules", ".bin", "playwright"), ["test", "--list", "--config", "playwright.config.ts"]);
for (const testPath of desktopUi.tests) {
  if (!desktopUiDiscovery.includes(path.basename(testPath))) {
    throw new Error(`${desktopUi.runner} does not discover ${testPath}.`);
  }
}

const allScript = packageJson.scripts[desktopUi.inclusiveRunner];
if (typeof allScript !== "string" || !allScript.includes(`npm run ${desktopUi.runner}`)) {
  throw new Error(`${desktopUi.inclusiveRunner} must contain the single Tauri UI Playwright batch.`);
}

// Native UI checks seize the host desktop, so they are explicit Phase 4 gates outside test:all.
// Keep their XCTest cases and launch scripts in the manifest even though this checker never runs
// Xcode or opens an app.
{
  const native = manifest.native;
  if (!native || typeof native !== "object") throw new Error("Native UI test membership is missing.");
  for (const [runner, scriptPath, testCase] of [
    [native.smokeRunner, native.smokeScript, native.smokeCase],
    [native.productionRunner, native.productionScript, native.productionCase],
  ]) {
    if (packageJson.scripts[runner] !== `node ${scriptPath}`) throw new Error(`${runner} must run its registered native host script.`);
    if (!existsSync(path.join(root, scriptPath))) throw new Error(`Native host script is missing: ${scriptPath}.`);
    const source = readFileSync(path.join(root, scriptPath), "utf8");
    if (!source.includes(`/${testCase}`) || !source.includes('"/usr/bin/xcodebuild"')) {
      throw new Error(`${runner} does not select its registered XCUITest case through xcodebuild.`);
    }
  }
  if (!existsSync(path.join(root, native.testFile))) throw new Error(`Native UI test file is missing: ${native.testFile}.`);
  const swift = readFileSync(path.join(root, native.testFile), "utf8");
  const discovered = [...swift.matchAll(/\bfunc\s+(test[A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]).sort();
  const expected = [native.smokeCase, native.productionCase].sort();
  if (JSON.stringify(discovered) !== JSON.stringify(expected)) {
    throw new Error("Native XCUITest cases differ from test membership.");
  }
  for (const file of native.supportFiles) {
    if (!existsSync(path.join(root, file))) throw new Error(`Native UI support file is missing: ${file}.`);
  }
  if ((packageJson.scripts["test:all"] ?? "").includes(native.smokeRunner)
      || (packageJson.scripts["test:all"] ?? "").includes(native.productionRunner)) {
    throw new Error("Native UI checks must remain explicit host gates outside test:all.");
  }
}

console.log(`Verified ${manifest.ui.tests.length} UI contract tests in ${manifest.ui.focusedRunner}.`);
console.log(`Verified ${desktopUi.tests.length} synthetic Tauri UI Playwright spec in ${desktopUi.runner} and test:all.`);
console.log(`Verified ${manifest.container.tests.length} container checks in the explicit host-only runner.`);
console.log(`Verified ${manifest.local.tests.length} local-source tests in ${manifest.local.runner} and test:all.`);
console.log(`Verified ${tauriTestCount} Rust tests in ${Object.keys(manifest.tauri.tests).length} files via cargo test --list in ${manifest.tauri.runner} and test:all.`);
console.log(`Verified ${(manifest.fixtures ?? []).length} listed test/fixtures files match what's on disk.`);
console.log("Verified both explicit native XCUITest cases and their host runners.");
