import { spawnSync } from "node:child_process";

const probe = spawnSync("python3", ["-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"], {
  encoding: "utf8",
});
if (probe.status !== 0) {
  throw new Error("python3 is required for the existing synthetic fixture tools.");
}
const version = probe.stdout.trim();
const [major = 0, minor = 0] = version.split(".").map(Number);
if (major < 3 || (major === 3 && minor < 10)) {
  throw new Error(`Python 3.10 or newer is required; found ${version}.`);
}
console.log(`Python ${version} satisfies the 3.10+ fixture-tool preflight.`);
