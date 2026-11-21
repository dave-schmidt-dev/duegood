import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SsoCredentialError,
  assertHandoffDescriptor,
  buildHandoff,
  decodeBase32Seed,
  main,
  passcodeWindows,
  totpForCounter,
} from "../../scripts/canvas-sso-credentials.mjs";

const helper = fileURLToPath(new URL("../../scripts/canvas-sso-credentials.mjs", import.meta.url));
// RFC 6238 Appendix B shared secret "12345678901234567890" in base32.
const RFC_SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SYNTHETIC = {
  DUEGOOD_SSO_USERNAME: "synthetic.student@example.edu",
  DUEGOOD_SSO_PASSWORD: "synthetic-password-Zq9!",
  DUEGOOD_SSO_TOTP_SEED: RFC_SEED,
};
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runHelper(env: Record<string, string>, args: string[] = [], fd3: "pipe" | number = "pipe") {
  return new Promise<{ code: number | null; stdout: string; stderr: string; handoff: string }>((resolve) => {
    const child = spawn(process.execPath, [helper, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe", fd3],
    });
    let stdout = "";
    let stderr = "";
    let handoff = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    (child.stdio[3] as NodeJS.ReadableStream | null)?.on("data", (chunk) => { handoff += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr, handoff }));
  });
}

describe("SSO credential helper", () => {
  it("matches the RFC 6238 SHA-1 test vectors truncated to six digits", () => {
    const key = decodeBase32Seed(RFC_SEED);
    const vectors: Array<[number, string]> = [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"]];
    for (const [seconds, code] of vectors) expect(totpForCounter(key, Math.floor(seconds / 30))).toBe(code);
  });

  it("normalizes setup-key formatting and rejects malformed seeds", () => {
    expect(decodeBase32Seed("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq==").equals(decodeBase32Seed(RFC_SEED))).toBe(true);
    for (const bad of ["", "SHORT", "GEZDGNBVGY3TQOJ1", "A".repeat(129)]) {
      expect(() => decodeBase32Seed(bad)).toThrow(SsoCredentialError);
    }
  });

  it("returns three consecutive windows starting with the current one", () => {
    const windows = passcodeWindows(decodeBase32Seed(RFC_SEED), 59_000);
    expect(windows.map((entry) => entry.notBefore)).toEqual([30_000, 60_000, 90_000]);
    expect(windows[0]?.code).toBe("287082");
  });

  it("refuses missing or malformed secrets with a content-free code", () => {
    expect(() => buildHandoff({ ...SYNTHETIC, DUEGOOD_SSO_USERNAME: "" })).toThrow("USERNAME_UNAVAILABLE");
    expect(() => buildHandoff({ ...SYNTHETIC, DUEGOOD_SSO_USERNAME: "bad name" })).toThrow("USERNAME_UNAVAILABLE");
    expect(() => buildHandoff({ ...SYNTHETIC, DUEGOOD_SSO_PASSWORD: "line\nbreak" })).toThrow("PASSWORD_UNAVAILABLE");
    expect(() => buildHandoff({ ...SYNTHETIC, DUEGOOD_SSO_TOTP_SEED: undefined })).toThrow("TOTP_SEED_UNAVAILABLE");
  });

  it("never hands the seed over", () => {
    const handoff = buildHandoff(SYNTHETIC, 59_000);
    expect(JSON.stringify(handoff)).not.toContain(RFC_SEED);
    expect(Object.keys(handoff).sort()).toEqual(["format", "passcodes", "password", "username", "version"]);
  });

  it("accepts only a pipe or socket on the handoff descriptor", () => {
    const fake = (kind: "fifo" | "file") => () => ({ isFIFO: () => kind === "fifo", isSocket: () => false });
    expect(() => assertHandoffDescriptor(3, { fstat: fake("fifo") as never, tty: () => false })).not.toThrow();
    expect(() => assertHandoffDescriptor(3, { fstat: fake("file") as never, tty: () => false })).toThrow("HANDOFF_UNAVAILABLE");
    expect(() => assertHandoffDescriptor(3, { fstat: fake("fifo") as never, tty: () => true })).toThrow("HANDOFF_UNAVAILABLE");
    expect(() => assertHandoffDescriptor(3, { fstat: () => { throw new Error("EBADF"); }, tty: () => false })).toThrow("HANDOFF_UNAVAILABLE");
  });

  it("writes the handoff only to fd 3 and nothing to stdout or stderr", async () => {
    const result = await runHelper(SYNTHETIC);
    expect(result).toMatchObject({ code: 0, stdout: "", stderr: "" });
    const handoff = JSON.parse(result.handoff);
    expect(handoff).toMatchObject({ format: "duegood-sso-handoff", version: 1, username: SYNTHETIC.DUEGOOD_SSO_USERNAME });
    expect(handoff.passcodes).toHaveLength(3);
    expect(result.handoff).not.toContain(RFC_SEED);
  });

  it("fails closed without echoing values when a secret is missing, fd 3 is a file, or argv is given", async () => {
    const missing = await runHelper({ ...SYNTHETIC, DUEGOOD_SSO_TOTP_SEED: "" });
    expect(missing).toMatchObject({ code: 1, stdout: "", handoff: "", stderr: "DUEGOOD_SSO_HANDOFF=TOTP_SEED_UNAVAILABLE\n" });

    const directory = mkdtempSync(path.join(os.tmpdir(), "duegood-sso-"));
    directories.push(directory);
    const file = openSync(path.join(directory, "handoff"), "w", 0o600);
    try {
      const toFile = await runHelper(SYNTHETIC, [], file);
      expect(toFile).toMatchObject({ code: 1, stdout: "", stderr: "DUEGOOD_SSO_HANDOFF=HANDOFF_UNAVAILABLE\n" });
    } finally { closeSync(file); }

    const withArgs = await runHelper(SYNTHETIC, ["--print"]);
    expect(withArgs).toMatchObject({ code: 2, stdout: "", handoff: "", stderr: "DUEGOOD_SSO_HANDOFF=ARGUMENTS_REJECTED\n" });
    for (const output of [missing, withArgs]) {
      for (const value of Object.values(SYNTHETIC)) expect(`${output.stdout}${output.stderr}`).not.toContain(value);
    }
  });

  it("reports an unexpected failure as HANDOFF_FAILED", () => {
    const writes: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { writes.push(chunk); return true; }) as typeof process.stderr.write;
    try {
      const code = main({ environment: SYNTHETIC, fd: 3, now: () => 59_000, descriptorCheck: () => { throw new Error(SYNTHETIC.DUEGOOD_SSO_PASSWORD); } });
      expect(code).toBe(1);
    } finally { process.stderr.write = original; }
    expect(writes).toEqual(["DUEGOOD_SSO_HANDOFF=HANDOFF_FAILED\n"]);
  });
});
