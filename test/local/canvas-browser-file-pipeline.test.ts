import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { downloadCanvasFile, runCaptureDownloadHelper } from "../../scripts/canvas-browser-file-pipeline.mjs";

const directories: string[] = [];
const receipt = { fileId: 41, stagedFile: "a".repeat(32) + ".blob", byteCount: 9,
  sha256: "b".repeat(64), contentType: "application/pdf", hashScope: "staged-bytes-only",
  sourceAuthenticity: "unverified" };

async function privateDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "duegood-file-pipeline-test-"));
  directories.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("private browser-to-native file handoff", () => {
  it("returns only an allow-listed native download error code", async () => {
    const directory = await privateDirectory();
    const helperPath = path.join(directory, "failed-helper");
    await writeFile(helperPath, "#!/usr/bin/env node\nprocess.stderr.write('request-failed\\n'); process.exitCode = 1;\n", { mode: 0o700 });
    await chmod(helperPath, 0o700);
    await expect(runCaptureDownloadHelper({ helperPath, fileId: 41,
      request: { fileId: 41, stagingDirectory: directory } }))
      .rejects.toMatchObject({ code: "HELPER_DOWNLOAD_REQUEST_FAILED" });
  });

  it("does not expose or accept free-form native stderr", async () => {
    const directory = await privateDirectory();
    const helperPath = path.join(directory, "malformed-failed-helper");
    const syntheticLocation = "https://files.instructureusercontent.com/synthetic-secret";
    await writeFile(helperPath, `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(`request-failed ${syntheticLocation}\n`)}); process.exitCode = 1;\n`, { mode: 0o700 });
    await chmod(helperPath, 0o700);
    let observedError: unknown;
    try {
      await runCaptureDownloadHelper({ helperPath, fileId: 41,
        request: { fileId: 41, stagingDirectory: directory } });
    } catch (error) {
      observedError = error;
    }
    expect(observedError).toMatchObject({ code: "HELPER_DOWNLOAD_FAILED" });
    expect(String(observedError)).not.toContain(syntheticLocation);
  });

  it("sends the transient URL through stdin, never argv, and accepts only an opaque receipt", async () => {
    const directory = await privateDirectory();
    const helperPath = path.join(directory, "synthetic-helper");
    const observationPath = path.join(directory, "observed.json");
    await writeFile(helperPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
let body = "";
for await (const chunk of process.stdin) body += chunk;
writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({ argv: process.argv.slice(2), request: JSON.parse(body) }));
process.stdout.write(JSON.stringify(${JSON.stringify(receipt)}) + "\\n");
`, { mode: 0o700 });
    await chmod(helperPath, 0o700);
    const source = "https://marymount.instructure.com/files/41/download?download_frd=1";
    const location = "https://files.instructureusercontent.com/synthetic-signed-location";
    const result = await runCaptureDownloadHelper({ helperPath, fileId: 41,
      request: { fileId: 41, browserSourceUrl: source, browserLocationUrl: location, stagingDirectory: directory } });
    expect(result).toEqual(receipt);
    const observed = JSON.parse(await readFile(observationPath, "utf8"));
    expect(observed.argv).toEqual([]);
    expect(observed.request.browserSourceUrl).toBe(source);
    expect(observed.request.browserLocationUrl).toBe(location);
  });

  it("rejects helper output containing a raw location", async () => {
    const directory = await privateDirectory();
    const helperPath = path.join(directory, "bad-helper");
    await writeFile(helperPath, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(${JSON.stringify({ ...receipt, browserLocationUrl: "https://example.invalid" })}));\n`, { mode: 0o700 });
    await chmod(helperPath, 0o700);
    await expect(runCaptureDownloadHelper({ helperPath, fileId: 41,
      request: { fileId: 41, stagingDirectory: directory } })).rejects.toMatchObject({ code: "HELPER_RESPONSE_REJECTED" });
  });

  it("joins the browser redirect to the native verifier without leaking it in the result", async () => {
    const directory = await privateDirectory();
    const sourceUrl = "https://marymount.instructure.com/files/41/download?download_frd=1";
    const location = "https://files.instructureusercontent.com/synthetic";
    const page = { syntheticPage: true };
    const browserFetch = vi.fn(async () => ({ kind: "redirect" as const, fileId: 41, location, sourceAuthenticity: "unverified" as const }));
    const result = await downloadCanvasFile({ context: {}, page, fileId: 41, sourceUrl, expectedSize: 9,
      stagingDirectory: directory, helperPath: path.join(directory, "unused"),
      browserFetch,
      nativeHelper: async ({ request }) => {
        expect(request).toEqual({ fileId: 41, browserSourceUrl: sourceUrl,
          browserLocationUrl: location, expectedSize: 9, stagingDirectory: directory });
        return receipt;
      },
    });
    expect(result).toEqual({ kind: "staged", fileId: 41, stagedFile: receipt.stagedFile,
      byteCount: 9, sha256: receipt.sha256, contentType: receipt.contentType,
      sourceAuthenticity: "unverified" });
    expect(browserFetch).toHaveBeenCalledWith(expect.objectContaining({ page }));
    expect(JSON.stringify(result)).not.toContain(location);
  });

  it("removes a browser direct-body part after a failed native adoption", async () => {
    const directory = await privateDirectory();
    const part = path.join(directory, ".duegood-browser-123e4567-e89b-42d3-a456-426614174000.part");
    await writeFile(part, "synthetic", { mode: 0o600 });
    const page = { syntheticPage: true };
    await expect(downloadCanvasFile({ context: {}, page, fileId: 41,
      sourceUrl: "https://marymount.instructure.com/files/41/download?download_frd=1",
      expectedSize: null, stagingDirectory: directory, helperPath: path.join(directory, "unused"),
      browserFetch: async () => ({ kind: "staged", fileId: 41, stagedPath: part, byteCount: 9,
        sourceAuthenticity: "unverified" }),
      nativeHelper: async () => { throw new Error("synthetic failure"); },
    })).rejects.toThrow();
    await expect(readFile(part)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
